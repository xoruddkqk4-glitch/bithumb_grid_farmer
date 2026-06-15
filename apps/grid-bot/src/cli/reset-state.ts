import { loadConfig } from "../config";
import { createInitialState, LocalStateStore } from "../storage/local-state-store";

async function main(): Promise<void> {
  const config = loadConfig();
  const stateStore = new LocalStateStore(config.statePath);
  const state = createInitialState({
    botId: config.botId,
    market: config.market,
    totalCapitalKrw: config.totalCapitalKrw,
  });

  await stateStore.writeAtomic(state);
  console.log(`[grid-bot] reset state: ${config.statePath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
