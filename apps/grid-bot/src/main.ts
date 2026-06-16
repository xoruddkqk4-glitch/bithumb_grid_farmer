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
import { BithumbTickerWebSocketPriceSource } from "./bithumb/ws-ticker-price-source";
import { sleep } from "./bithumb/rate-limiter";
import {
  loadAccountCapitalSnapshot,
  type AccountCapitalSnapshot,
} from "./account/account-capital";
import type { BotState } from "../../../packages/shared/src/types";
import type { PriceQuote } from "./bithumb/bithumb-client";

async function main(): Promise<void> {
  const config = loadConfig();
  const stateStore = new LocalStateStore(config.statePath);
  const logger = new JsonlTradeLogger(config.logPath);
  const bithumb = new BithumbPublicClient({ mockPrice: config.mockPrice });
  const priceSource =
    config.useWebSocketTicker && config.mockPrice == null
      ? new BithumbTickerWebSocketPriceSource(bithumb, {
          market: config.market,
          staleAfterMs: config.webSocketTickerStaleMs,
          firstQuoteTimeoutMs: config.webSocketTickerFirstQuoteTimeoutMs,
        })
      : bithumb;
  if (priceSource instanceof BithumbTickerWebSocketPriceSource) {
    priceSource.start();
  }
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
    useAggressiveLimitOrders: config.useAggressiveLimitOrders,
    aggressiveLimitOffsetPct: config.aggressiveLimitOffsetPct,
    aggressiveLimitWaitMs: config.aggressiveLimitWaitMs,
  });
  const executor = selectOrderExecutor({
    enableRealOrders: config.enableRealOrders,
    paperExecutor,
    realExecutor,
  });
  const gridEngine = new GridEngine(config, bithumb, executor, logger);
  const farmerEngine = new FarmerEngine(config, bithumb, executor, logger);
  const recoveryExitEngine = new RecoveryExitEngine(config, bithumb, executor, logger);

  let startupAccountSnapshot: AccountCapitalSnapshot | null = null;
  let initialTotalCapitalKrw = config.totalCapitalKrw;
  if (config.enableRealOrders && config.useAccountCapital) {
    const startupQuote = await priceSource.getCurrentPrice(config.market);
    startupAccountSnapshot = await loadAccountCapitalSnapshot({
      client: bithumbPrivate,
      market: config.market,
      quote: startupQuote,
    });
    assertAccountCapitalWithinLimits(startupAccountSnapshot, config);
    initialTotalCapitalKrw = startupAccountSnapshot.totalCapitalKrw;
  }

  let state = await stateStore.readOrCreate({
    botId: config.botId,
    market: config.market,
    totalCapitalKrw: initialTotalCapitalKrw,
  });
  if (startupAccountSnapshot != null) {
    state = applyAccountCapitalSnapshot(state, startupAccountSnapshot, { resetGridBeforeFirstBuy: true });
    await stateStore.writeAtomic(state);
  }
  if (config.enableRealOrders) {
    const krwAvailable = await bithumbPrivate.getAvailableBalance("KRW");
    console.log(
      `[grid-bot] real order checks passed market=${config.market} krwAvailable=${Math.floor(krwAvailable)} totalCapitalKrw=${Math.floor(state.totalCapitalKrw)} accountCapital=${config.useAccountCapital} maxOrderKrw=${config.maxRealOrderKrw} maxTotalCapitalKrw=${config.maxRealTotalCapitalKrw}`,
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
    `[grid-bot] started botId=${config.botId} market=${config.market} realOrders=${config.enableRealOrders} ticker=${priceSource instanceof BithumbTickerWebSocketPriceSource ? "websocket" : "rest"} trigger=${priceSource instanceof BithumbTickerWebSocketPriceSource ? "price-event" : "loop"} safetyCheckMs=${config.safetyCheckIntervalMs} realOrderMode=${config.useAggressiveLimitOrders ? "aggressive-limit" : "market"}`,
  );

  let loops = 0;
  let nextQuote: PriceQuote | null = null;
  let lastQuoteTimestamp: string | null = null;
  let wakeReason: "initial" | "price" | "safety" | "loop" = "initial";
  while (true) {
    loops += 1;
    try {
      state = await stateStore.read();
      const restoredState = await restoreGridPhaseIfGridWorkExists(state, logger);
      if (restoredState !== state) {
        state = restoredState;
        await stateStore.writeAtomic(state);
      }
      const quote = nextQuote ?? await priceSource.getCurrentPrice(config.market);
      nextQuote = null;
      lastQuoteTimestamp = quote.timestamp;
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
          `[grid-bot] loop=${loops} wake=${wakeReason} price=${quote.tradePrice} source=${quote.source} phase=${state.phase} paused=true reason="${safetySwitch.reason}"`,
        );
        if (config.maxLoops != null && loops >= config.maxLoops) {
          console.log(`[grid-bot] stopped after GRID_BOT_MAX_LOOPS=${config.maxLoops}`);
          break;
        }
        const wake = await waitBeforeNextCycle(priceSource, stateStore, config, state, lastQuoteTimestamp);
        nextQuote = wake.quote;
        wakeReason = wake.reason;
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
          `[grid-bot] loop=${loops} wake=${wakeReason} price=${quote.tradePrice} source=${quote.source} phase=${state.phase} gridResetPending=true sellPaused=true`,
        );
        if (config.maxLoops != null && loops >= config.maxLoops) {
          console.log(`[grid-bot] stopped after GRID_BOT_MAX_LOOPS=${config.maxLoops}`);
          break;
        }
        const wake = await waitBeforeNextCycle(priceSource, stateStore, config, state, lastQuoteTimestamp);
        nextQuote = wake.quote;
        wakeReason = wake.reason;
        continue;
      }

      if (state.gridResetRequestedAt != null) {
        const resetResult = await gridEngine.resetOpenGridPositions(state, quote);
        state = resetResult.state;
        state = await refreshAccountCapitalIfNeeded(state, quote, config, bithumbPrivate, "grid-reset");
        await stateStore.writeAtomic(state);
        console.log(
          `[grid-bot] loop=${loops} wake=${wakeReason} price=${quote.tradePrice} source=${quote.source} phase=${state.phase} gridResetSells=${resetResult.count} totalCapitalKrw=${Math.floor(state.totalCapitalKrw)}`,
        );
        if (config.maxLoops != null && loops >= config.maxLoops) {
          console.log(`[grid-bot] stopped after GRID_BOT_MAX_LOOPS=${config.maxLoops}`);
          break;
        }
        const wake = await waitBeforeNextCycle(priceSource, stateStore, config, state, lastQuoteTimestamp);
        nextQuote = wake.quote;
        wakeReason = wake.reason;
        continue;
      }

      const result = await gridEngine.tick(state, quote, {
        enableGridBuy: config.enableGridBuy && !safetySwitch.buyPaused,
        enableGridSell: config.enableGridSell && !safetySwitch.sellPaused,
      });
      state = result.state;
      const farmerResult = await farmerEngine.tick(state, quote);
      state = farmerResult.state;
      const cycleIdBeforeRecoveryExit = state.cycleId;
      const recoveryExitResult = await recoveryExitEngine.tick(state, quote, {
        enableRecoverySell: (state.enableRecoveryTurtleSell ?? config.enableRecoveryTurtleSell) && !safetySwitch.sellPaused,
      });
      state = recoveryExitResult.state;
      if (recoveryExitResult.sold && state.cycleId !== cycleIdBeforeRecoveryExit) {
        state = await refreshAccountCapitalIfNeeded(state, quote, config, bithumbPrivate, "recovery-full-exit");
        state = clearGridForNextAccountCapitalCycle(state);
      }
      await stateStore.writeAtomic(state);
      const nextWaitMs = selectWaitIntervalMs(priceSource, state, config);

      console.log(
        `[grid-bot] loop=${loops} wake=${wakeReason} price=${quote.tradePrice} source=${quote.source} phase=${state.phase} buys=${result.summary.buys} sells=${result.summary.sells} farmerSignal=${farmerResult.signaled} farmerBuy=${farmerResult.bought} recoveryExitSignal=${recoveryExitResult.signaled} recoverySell=${recoveryExitResult.sold} nextWaitMs=${nextWaitMs}`,
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
    const wake = await waitBeforeNextCycle(priceSource, stateStore, config, state, lastQuoteTimestamp);
    nextQuote = wake.quote;
    wakeReason = wake.reason;
  }
}

type PriceSource = BithumbPublicClient | BithumbTickerWebSocketPriceSource;

async function refreshAccountCapitalIfNeeded(
  state: BotState,
  quote: PriceQuote,
  config: ReturnType<typeof loadConfig>,
  bithumbPrivate: BithumbPrivateClient,
  reason: "grid-reset" | "recovery-full-exit",
): Promise<BotState> {
  if (!config.enableRealOrders || !config.useAccountCapital) {
    return state;
  }
  const snapshot = await loadAccountCapitalSnapshot({
    client: bithumbPrivate,
    market: state.market,
    quote,
  });
  assertAccountCapitalWithinLimits(snapshot, config);
  const nextState = applyAccountCapitalSnapshot(state, snapshot, { resetGridBeforeFirstBuy: true });
  console.log(
    `[grid-bot] account capital refreshed reason=${reason} totalCapitalKrw=${Math.floor(snapshot.totalCapitalKrw)} krw=${Math.floor(snapshot.krwBalance)} lockedKrw=${Math.floor(snapshot.krwLocked)} ${snapshot.assetCurrency}=${snapshot.assetBalance + snapshot.assetLocked} assetValueKrw=${Math.floor(snapshot.assetValueKrw)}`,
  );
  return nextState;
}

function applyAccountCapitalSnapshot(
  state: BotState,
  snapshot: AccountCapitalSnapshot,
  options: { resetGridBeforeFirstBuy: boolean },
): BotState {
  const nextState: BotState = {
    ...state,
    totalCapitalKrw: snapshot.totalCapitalKrw,
    accountCapitalKrw: snapshot.totalCapitalKrw,
    accountCapitalUpdatedAt: snapshot.evaluatedAt,
    accountKrwBalance: snapshot.krwBalance,
    accountKrwLocked: snapshot.krwLocked,
    accountAssetBalance: snapshot.assetBalance,
    accountAssetLocked: snapshot.assetLocked,
    accountAssetValueKrw: snapshot.assetValueKrw,
  };
  return options.resetGridBeforeFirstBuy && shouldClearGridForAccountCapitalRefresh(nextState)
    ? clearGridForNextAccountCapitalCycle(nextState)
    : nextState;
}

function assertAccountCapitalWithinLimits(
  snapshot: AccountCapitalSnapshot,
  config: ReturnType<typeof loadConfig>,
): void {
  if (!Number.isFinite(snapshot.totalCapitalKrw) || snapshot.totalCapitalKrw <= 0) {
    throw new Error(`Account total capital must be positive. Received: ${snapshot.totalCapitalKrw}.`);
  }
  if (snapshot.totalCapitalKrw > config.maxRealTotalCapitalKrw) {
    throw new Error(
      `Account total capital ${snapshot.totalCapitalKrw} exceeds GRID_BOT_MAX_REAL_TOTAL_CAPITAL_KRW=${config.maxRealTotalCapitalKrw}.`,
    );
  }
}

function shouldClearGridForAccountCapitalRefresh(state: BotState): boolean {
  const hasOpenGridPosition = state.layers.some((layer) => layer.status === "OPEN" && layer.qty > 0);
  const hasFarmerPosition = state.farmerStage > 0 || (state.farmerPositions ?? []).some((position) => position.qty > 0);
  return state.phase === "GRID" && !hasOpenGridPosition && !hasFarmerPosition;
}

function clearGridForNextAccountCapitalCycle(state: BotState): BotState {
  return {
    ...state,
    phase: "GRID",
    gridEntryPrice: null,
    gridEntryReferencePrice: null,
    gridEntryNValue: null,
    gridEntryNCalculatedForKstDate: null,
    gridInvestmentKrw: 0,
    gridOrderAmountKrw: 0,
    layers: [],
    highestPrice: 0,
  };
}

async function waitBeforeNextCycle(
  priceSource: PriceSource,
  stateStore: LocalStateStore,
  config: ReturnType<typeof loadConfig>,
  state: BotState,
  lastQuoteTimestamp: string | null,
): Promise<{ quote: PriceQuote | null; reason: "price" | "safety" | "loop" }> {
  if (priceSource instanceof BithumbTickerWebSocketPriceSource) {
    const quote = await priceSource.waitForNextQuote(
      config.market,
      selectWaitIntervalMs(priceSource, state, config),
      lastQuoteTimestamp,
    );
    return quote == null
      ? { quote: null, reason: "safety" }
      : { quote, reason: "price" };
  }

  await sleepBeforeNextLoop(stateStore, state, config);
  return { quote: null, reason: "loop" };
}

function selectWaitIntervalMs(
  priceSource: PriceSource,
  state: BotState,
  config: ReturnType<typeof loadConfig>,
): number {
  if (priceSource instanceof BithumbTickerWebSocketPriceSource) {
    return Math.max(state.gridLoopIntervalMs ?? config.safetyCheckIntervalMs, config.safetyCheckIntervalMs);
  }
  return selectLoopIntervalMs(state, config);
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
