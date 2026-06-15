process.env.GRID_BOT_MOCK_PRICE = process.env.GRID_BOT_MOCK_PRICE || "100000000";
process.env.GRID_BOT_MAX_LOOPS = process.env.GRID_BOT_MAX_LOOPS || "1";

require("../apps/grid-bot/dist/apps/grid-bot/src/main.js");
