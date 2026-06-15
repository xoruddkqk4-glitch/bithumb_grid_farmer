process.env.ENABLE_REAL_ORDERS = "false";
process.env.ENABLE_GRID_BUY = process.env.ENABLE_GRID_BUY || "true";
process.env.ENABLE_GRID_SELL = process.env.ENABLE_GRID_SELL || "true";
process.env.GRID_BOT_MOCK_PRICE = process.env.GRID_BOT_MOCK_PRICE || "100000000";

require("../apps/grid-bot/dist/apps/grid-bot/src/main.js");
