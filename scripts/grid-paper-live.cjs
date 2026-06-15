process.env.ENABLE_REAL_ORDERS = "false";
process.env.ENABLE_GRID_BUY = process.env.ENABLE_GRID_BUY || "true";
process.env.ENABLE_GRID_SELL = process.env.ENABLE_GRID_SELL || "true";

require("../apps/grid-bot/dist/apps/grid-bot/src/main.js");
