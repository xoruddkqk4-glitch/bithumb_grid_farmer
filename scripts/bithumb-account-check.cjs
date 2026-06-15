if (!process.env.BITHUMB_ACCESS_KEY || !process.env.BITHUMB_SECRET_KEY) {
  console.error("Set BITHUMB_ACCESS_KEY and BITHUMB_SECRET_KEY before checking the account.");
  process.exit(1);
}

require("../apps/grid-bot/dist/apps/grid-bot/src/cli/check-account.js");
