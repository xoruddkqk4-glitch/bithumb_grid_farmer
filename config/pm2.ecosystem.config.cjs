module.exports = {
  apps: [
    {
      name: "bithumb-grid-bot-paper",
      script: "apps/grid-bot/dist/apps/grid-bot/src/main.js",
      cwd: process.cwd(),
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      time: true,
      env: {
        NODE_ENV: "production",
        GRID_BOT_ID: "btc-grid-bot",
        GRID_BOT_MARKET: "KRW-BTC",
        GRID_BOT_LOOP_INTERVAL_MS: "3000",
        GRID_BOT_TOTAL_CAPITAL_KRW: "10000000",
        ENABLE_REAL_ORDERS: "false",
        ENABLE_GRID_BUY: "true",
        ENABLE_GRID_SELL: "true"
      }
    },
    {
      name: "bithumb-price-watch",
      script: "apps/grid-bot/dist/apps/grid-bot/src/cli/watch-price.js",
      cwd: process.cwd(),
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "200M",
      time: true,
      env: {
        NODE_ENV: "production",
        PRICE_WATCH_MARKET: "KRW-BTC",
        PRICE_WATCH_INTERVAL_MS: "3000"
      }
    },
    {
      name: "bithumb-grid-dashboard",
      script: "apps/dashboard/dist/apps/dashboard/src/server.js",
      cwd: process.cwd(),
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "150M",
      time: true,
      env: {
        NODE_ENV: "production",
        DASHBOARD_HOST: "0.0.0.0",
        DASHBOARD_PORT: "3000",
        DASHBOARD_STATE_PATH: "data/bot_state.json",
        DASHBOARD_TRADE_LOG_PATH: "data/trading_logs/btc_master_log.jsonl",
        DASHBOARD_BOT_OUT_LOG_PATH: "/home/ec2-user/.pm2/logs/bithumb-grid-bot-paper-out-0.log",
        DASHBOARD_AUTH_USER: process.env.DASHBOARD_AUTH_USER || "admin",
        DASHBOARD_AUTH_PASSWORD: process.env.DASHBOARD_AUTH_PASSWORD || "",
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
        TELEGRAM_SETTINGS_PATH: "data/telegram_settings.json"
      }
    },
    {
      name: "bithumb-grid-telegram",
      script: "apps/grid-bot/dist/apps/grid-bot/src/telegram/telegram-bot.js",
      cwd: process.cwd(),
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "150M",
      time: true,
      env: {
        NODE_ENV: "production",
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
        TELEGRAM_GRID_BATCH_SIZE: "10",
        TELEGRAM_DAILY_REPORT_HOUR_KST: "7",
        TELEGRAM_DAILY_REPORT_MINUTE_KST: "0",
        TELEGRAM_RISK_HOLDING_RETURN_PCT: "-5",
        TELEGRAM_STALE_LOOP_MINUTES: "2",
        TELEGRAM_SETTINGS_PATH: "data/telegram_settings.json",
        GRID_BOT_STATE_PATH: "data/bot_state.json",
        GRID_BOT_LOG_PATH: "data/trading_logs/btc_master_log.jsonl",
        GRID_BOT_CONTROL_PATH: "data/control/grid_control.json"
      }
    }
  ]
};
