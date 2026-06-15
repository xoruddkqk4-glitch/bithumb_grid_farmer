process.env.ENABLE_REAL_ORDERS = "true";
process.env.GRID_BOT_MAX_LOOPS = process.env.GRID_BOT_MAX_LOOPS || "1";

require("../apps/grid-bot/dist/apps/grid-bot/src/main.js");
