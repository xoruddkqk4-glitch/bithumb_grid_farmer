import { loadConfig } from "./config";
import { FarmerEngine } from "./farmer/farmer-engine";
import { GridEngine } from "./grid/grid-engine";
import { PaperOrderExecutor } from "./orders/paper-executor";
import { RealOrderExecutor, selectOrderExecutor } from "./orders/order-executor";
import { reconcilePaperState } from "./orders/reconciliation";
import { readSafetySwitch } from "./control/safety-switch";
import { JsonlTradeLogger } from "./storage/logger";
import { LocalStateStore } from "./storage/local-state-store";
import { RecoveryExitEngine } from "./turtle/recovery-exit-engine";
import { BithumbPrivateClient, BithumbPublicClient } from "./bithumb/bithumb-client";
import { sleep } from "./bithumb/rate-limiter";
import type { BotState } from "../../../packages/shared/src/types";

async function main(): Promise<void> {
  const config = loadConfig();
  const stateStore = new LocalStateStore(config.statePath);
  const logger = new JsonlTradeLogger(config.logPath);
  const bithumb = new BithumbPublicClient({ mockPrice: config.mockPrice });
  const bithumbPrivate = new BithumbPrivateClient({
    accessKey: config.bithumbAccessKey,
    secretKey: config.bithumbSecretKey,
    feeRate: config.feeRate,
  });
  const paperExecutor = new PaperOrderExecutor(config.feeRate);
  const realExecutor = new RealOrderExecutor({
    enabled: config.enableRealOrders,
    client: bithumbPrivate,
    maxOrderKrw: config.maxRealOrderKrw,
  });
  const executor = selectOrderExecutor({
    enableRealOrders: config.enableRealOrders,
    paperExecutor,
    realExecutor,
  });
  const gridEngine = new GridEngine(config, executor, logger);
  const farmerEngine = new FarmerEngine(config, bithumb, paperExecutor, logger);
  const recoveryExitEngine = new RecoveryExitEngine(config, bithumb, executor, logger);

  let state = await stateStore.readOrCreate({
    botId: config.botId,
    market: config.market,
    totalCapitalKrw: config.totalCapitalKrw,
  });
  if (config.enableRealOrders) {
    const krwAvailable = await bithumbPrivate.getAvailableBalance("KRW");
    console.log(
      `[grid-bot] real order checks passed market=${config.market} krwAvailable=${Math.floor(krwAvailable)} maxOrderKrw=${config.maxRealOrderKrw}`,
    );
  }
  const restoredInitialState = await restoreGridPhaseIfGridWorkExists(state, logger);
  if (restoredInitialState !== state) {
    state = restoredInitialState;
    await stateStore.writeAtomic(state);
  }
  const reconciliation = reconcilePaperState(state);
  for (const warning of reconciliation.warnings) {
    console.warn(`[reconciliation] ${warning}`);
  }

  console.log(
    `[grid-bot] started botId=${config.botId} market=${config.market} realOrders=${config.enableRealOrders}`,
  );

  let loops = 0;
  while (true) {
    loops += 1;
    try {
      state = await stateStore.read();
      const restoredState = await restoreGridPhaseIfGridWorkExists(state, logger);
      if (restoredState !== state) {
        state = restoredState;
        await stateStore.writeAtomic(state);
      }
      const quote = await bithumb.getCurrentPrice(config.market);
      const safetySwitch = await readSafetySwitch();

      if (safetySwitch.paused) {
        state = {
          ...state,
          lastPrice: quote.tradePrice,
          lastLoopAt: new Date().toISOString(),
          lastError: safetySwitch.reason,
        };
        await stateStore.writeAtomic(state);
        console.log(
          `[grid-bot] loop=${loops} price=${quote.tradePrice} source=${quote.source} phase=${state.phase} paused=true reason="${safetySwitch.reason}"`,
        );
        if (config.maxLoops != null && loops >= config.maxLoops) {
          console.log(`[grid-bot] stopped after GRID_BOT_MAX_LOOPS=${config.maxLoops}`);
          break;
        }
        await sleepBeforeNextLoop(stateStore, state, config);
        continue;
      }

      if (state.gridResetRequestedAt != null && safetySwitch.sellPaused) {
        state = {
          ...state,
          lastPrice: quote.tradePrice,
          lastLoopAt: new Date().toISOString(),
          lastError: "Grid reset is pending, but sell is paused.",
        };
        await stateStore.writeAtomic(state);
        console.log(
          `[grid-bot] loop=${loops} price=${quote.tradePrice} source=${quote.source} phase=${state.phase} gridResetPending=true sellPaused=true`,
        );
        if (config.maxLoops != null && loops >= config.maxLoops) {
          console.log(`[grid-bot] stopped after GRID_BOT_MAX_LOOPS=${config.maxLoops}`);
          break;
        }
        await sleepBeforeNextLoop(stateStore, state, config);
        continue;
      }

      if (state.gridResetRequestedAt != null) {
        const resetResult = await gridEngine.resetOpenGridPositions(state, quote);
        state = resetResult.state;
        await stateStore.writeAtomic(state);
        console.log(
          `[grid-bot] loop=${loops} price=${quote.tradePrice} source=${quote.source} phase=${state.phase} gridResetSells=${resetResult.count}`,
        );
        if (config.maxLoops != null && loops >= config.maxLoops) {
          console.log(`[grid-bot] stopped after GRID_BOT_MAX_LOOPS=${config.maxLoops}`);
          break;
        }
        await sleepBeforeNextLoop(stateStore, state, config);
        continue;
      }

      const result = await gridEngine.tick(state, quote, {
        enableGridBuy: config.enableGridBuy && !safetySwitch.buyPaused,
        enableGridSell: config.enableGridSell && !safetySwitch.sellPaused,
      });
      state = result.state;
      const farmerResult = await farmerEngine.tick(state, quote);
      state = farmerResult.state;
      const recoveryExitResult = await recoveryExitEngine.tick(state, quote, {
        enableRecoverySell: (state.enableRecoveryTurtleSell ?? config.enableRecoveryTurtleSell) && !safetySwitch.sellPaused,
      });
      state = recoveryExitResult.state;
      await stateStore.writeAtomic(state);
      const nextLoopIntervalMs = selectLoopIntervalMs(state, config);

      console.log(
        `[grid-bot] loop=${loops} price=${quote.tradePrice} source=${quote.source} phase=${state.phase} buys=${result.summary.buys} sells=${result.summary.sells} farmerSignal=${farmerResult.signaled} farmerBuy=${farmerResult.bought} recoveryExitSignal=${recoveryExitResult.signaled} recoverySell=${recoveryExitResult.sold} nextLoopMs=${nextLoopIntervalMs}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[grid-bot] ${message}`);
      try {
        state = {
          ...(await stateStore.readOrCreate({
            botId: config.botId,
            market: config.market,
            totalCapitalKrw: config.totalCapitalKrw,
          })),
          lastError: message,
          lastLoopAt: new Date().toISOString(),
        };
        await stateStore.writeAtomic(state);
        await logger.append({
          timestamp: new Date().toISOString(),
          botId: state.botId,
          market: state.market,
          cycleId: state.cycleId,
          action: "BOT_ERROR",
          message,
        });
      } catch (loggingError) {
        console.error(`[grid-bot] failed to persist error: ${String(loggingError)}`);
      }
    }

    if (config.maxLoops != null && loops >= config.maxLoops) {
      console.log(`[grid-bot] stopped after GRID_BOT_MAX_LOOPS=${config.maxLoops}`);
      break;
    }
    await sleepBeforeNextLoop(stateStore, state, config);
  }
}

function selectLoopIntervalMs(state: BotState, config: ReturnType<typeof loadConfig>): number {
  if (state.phase === "FARMING") {
    return state.farmingLoopIntervalMs ?? config.farmingLoopIntervalMs;
  }
  return state.gridLoopIntervalMs ?? config.loopIntervalMs;
}

async function restoreGridPhaseIfGridWorkExists(
  state: BotState,
  logger: JsonlTradeLogger,
): Promise<BotState> {
  if (state.phase === "GRID") {
    return state;
  }
  const hasFarmerPosition = state.farmerStage > 0 || (state.farmerPositions ?? []).some((position) => position.qty > 0);
  if (hasFarmerPosition) {
    return state;
  }
  const waitingLayerIndexes = state.layers
    .filter((layer) => layer.status === "WAITING" && layer.qty <= 0)
    .map((layer) => layer.idx);
  const openLayerIndexes = state.layers
    .filter((layer) => layer.status === "OPEN" && layer.qty > 0)
    .map((layer) => layer.idx);

  const restoredAt = new Date().toISOString();
  const nextState: BotState = {
    ...state,
    phase: "GRID",
    updatedAt: restoredAt,
    lastError: null,
  };
  console.warn(
    `[grid-bot] restored phase ${state.phase} -> GRID because no farmer position exists: waiting=${waitingLayerIndexes.join(",") || "-"} open=${openLayerIndexes.join(",") || "-"}`,
  );
  await logger.append({
    timestamp: restoredAt,
    botId: state.botId,
    market: state.market,
    cycleId: state.cycleId,
    action: "PHASE_CHANGE",
    message: `${state.phase} -> GRID`,
    reason: "NO_FARMER_POSITION_GRID_PHASE",
    metadata: {
      waitingLayerIndexes,
      openLayerIndexes,
      hasFarmerPosition,
    },
  });
  return nextState;
}

async function sleepBeforeNextLoop(
  stateStore: LocalStateStore,
  state: BotState,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const intervalMs = selectLoopIntervalMs(state, config);
  if (state.phase !== "FARMING" || intervalMs <= config.loopIntervalMs) {
    await sleep(intervalMs);
    return;
  }

  let remainingMs = intervalMs;
  while (remainingMs > 0) {
    const chunkMs = Math.min(remainingMs, config.loopIntervalMs);
    await sleep(chunkMs);
    remainingMs -= chunkMs;

    try {
      const latestState = await stateStore.read();
      if (latestState.phase !== "FARMING" || hasGridWorkPriority(latestState)) {
        return;
      }
    } catch (error) {
      console.error(`[grid-bot] failed to check state during farming sleep: ${String(error)}`);
    }
  }
}

function hasGridWorkPriority(state: BotState): boolean {
  const hasFarmerPosition = state.farmerStage > 0 || (state.farmerPositions ?? []).some((position) => position.qty > 0);
  return !hasFarmerPosition;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
