import { loadConfig } from "../config";
import { BithumbPrivateClient } from "../bithumb/bithumb-client";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new BithumbPrivateClient({
    accessKey: config.bithumbAccessKey,
    secretKey: config.bithumbSecretKey,
    feeRate: config.feeRate,
  });

  const accounts = await client.getAccounts();
  const visibleAccounts = accounts
    .filter((account) => account.balance > 0 || account.locked > 0)
    .map((account) => ({
      currency: account.currency,
      balance: account.balance,
      locked: account.locked,
      avgBuyPrice: account.avgBuyPrice,
      unitCurrency: account.unitCurrency,
    }));

  console.log(`[bithumb-account] connected accounts=${accounts.length} nonZero=${visibleAccounts.length}`);
  for (const account of visibleAccounts) {
    console.log(
      `[bithumb-account] ${account.unitCurrency}-${account.currency} balance=${account.balance} locked=${account.locked} avgBuyPrice=${account.avgBuyPrice}`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
