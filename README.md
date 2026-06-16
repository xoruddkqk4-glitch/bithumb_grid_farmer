# Bithumb Grid Farmer

## Current Farmer/Turtle Implementation Notes (2026-06-15)

- Farmer buy uses the same selected order executor as Grid and Recovery Turtle. With `ENABLE_REAL_ORDERS=false`, confirmed farmer buys remain paper trades. With `ENABLE_REAL_ORDERS=true` and `ENABLE_FARMER_CONFIRMED_BUY=true`, confirmed farmer buys place real Bithumb orders.
- Partial take-profit is implemented in the live Recovery Turtle runtime as of 2026-06-15. When enabled from Dashboard > Strategy Adjustment, TP1/TP2 sell the configured ratio of the unified recovery position before the full Turtle exit path.
- Farmer buy filters now include a close-based two-consecutive-bullish-daily-candle condition. It is enabled by default and can be toggled from Dashboard > Strategy Adjustment or `FARMER_USE_TWO_BULLISH_DAILY_FILTER`.
- After all grid layers are open, the bot keeps `phase=GRID` until the first farmer buy is actually executed. During this wait, grid sells remain active and farmer stage 1 signals are monitored separately.
- Farmer entry price is calculated as `Last Buy Price * (1 - Farmer Entry Percent)`. Before farmer stage 1, `Last Buy Price` is the deepest currently held grid buy price. After farmer buys begin, it is the previous farmer buy price.
- Bithumb daily candles use the KST 00:00 day boundary. The current KST day is excluded when calculating confirmed daily indicators such as MA5, MA200, ATR/N, turnover averages, confirmed bullish candles, and N-day low thresholds.
- Daily strategy logic separates indicator bases from live triggers. Confirmed daily candles build the indicator levels, while the live current price is used for trigger comparisons such as farmer price-vs-MA checks, 3-day drawdown, MA5 exit, N-day low break, and 2N trailing exit.
- Farmer cooldown and freefall settings are user-adjustable from Dashboard > Strategy Adjustment:
  - `Farmer Stage 2 Cooldown Days`
  - `Farmer Stage 3 Cooldown Days`
  - `Farmer Max 3D Drawdown (%)`
- Recovery Turtle exit now has three trigger paths behind the same positive-profit gate:
  - `2N_TRAIL`: current price below `highest_price - N * multiplier`
  - `MA5_EXIT`: current price below the MA5 calculated from confirmed daily candles
  - `N_DAY_LOW_BREAK`: current price below the recent N-day low calculated from confirmed daily candles
- `Turtle Low Breakout Period` is user-adjustable from Dashboard > Strategy Adjustment and is stored in `bot_state.json`.
- Farmer Signal dashboard layout:
  - Row 1: `Last Farmer Signal`, `Farmer Defense`, `Farmer Stage`
  - Row 2: `Current Price`, `Last Buy Price`, `Next Farmer Entry`

## Backtest Dashboard

Backtests are separated from the live dashboard. The generated HTML report is Korean-first and includes a period-setting panel that builds the PowerShell command for a new date range. Run:

```powershell
npm run backtest:btc:daily
```

The script stores reusable Bithumb daily candles under `data/backtests/candles/` and writes each result to `data/backtests/reports/` as both JSON and a standalone HTML dashboard. These files are intentionally kept for repeated strategy checks.

To run a specific period directly:

```powershell
$env:BACKTEST_FROM='2021-01-01'; $env:BACKTEST_TO='2021-12-31'; npm run backtest:btc:daily
```

Bithumb `KRW-BTC` 기준의 Paper Grid-Farmer 자동매매 봇과 대시보드 프로젝트입니다.

기본값은 Paper Trading 중심이지만, 실거래 확인 플래그와 Bithumb API 키를 설정하면 그리드 매수/매도, 농부 매수, Recovery Turtle 매도를 실제 Bithumb 주문으로 실행할 수 있습니다.

## 현재 구현 상태

- Bithumb WebSocket ticker 기반 현재가 실시간 반영
- 가격 이벤트 기반 조건 판단, REST는 주문/잔고/체결 확인 및 WebSocket fallback에만 사용
- 1분 간격 저빈도 안전 점검 루프
- Paper Trading 또는 실거래 그리드 매수/매도 실행
- `data/bot_state.json` 상태 저장
- `data/trading_logs/btc_master_log.jsonl` 매매 로그 저장
- Node 내장 `http` 기반 대시보드
- PM2 기반 봇, 대시보드, 가격 감시, 텔레그램 워커 실행
- 텔레그램 연결 설정 저장, ON/OFF, 테스트 메시지 발송
- 그리드 매매 텔레그램 알림 방식 조정: 매수 묶음, 매도 즉시, 묶음 기준 설정
- 일일 요약 알림 기준값 저장 구조
- Strategy Setting 표시 및 Strategy Adjustment 수정
- Grid Extension 기능
- Daily PNL 달력, Realized PNL Trend, 로그 Tail, Grid Layer 상태 표시
- Grid 리셋 시 레이어를 비워 `0 / 0` 상태에서 재시작
- OPEN Grid 미실현 손익/수익률을 실제 매수가 × 수량 기준으로 계산
- FARMING 이후 그리드 미청산 물량 + 농부 물량을 합친 Recovery Position 계산
- Farmer 매수 신호/실행 엔진
- Recovery Turtle 매도 신호/분할 시장가 청산 엔진
- 대시보드 Recovery Position, Farmer Signal, Turtle Exit 표시
- Strategy Adjustment에서 Farmer cooldown/drawdown, Recovery Turtle, N-day low breakout, 부분 익절 설정 저장

아직 별도 구현이 필요한 영역:

- 실계좌 잔고/체결 내역과 `bot_state.json` 자동 reconciliation 고도화
- 실시간 orderbook 기반 슬리피지 사전 계산 및 지정가 우선 청산
- 4시간봉 조기 진입 실행 로직
- WebSocket 기반 실시간 체결/호가 수집

## 안전 기본값

실거래 방지를 위해 기본 설정은 Paper Trading 중심입니다.

```text
ENABLE_REAL_ORDERS=false
ENABLE_GRID_BUY=true
ENABLE_GRID_SELL=true
```

실거래를 켤 때는 아래 값을 함께 설정해야 합니다.

```text
ENABLE_REAL_ORDERS=true
REAL_ORDERS_CONFIRM=I_UNDERSTAND_REAL_BITHUMB_ORDERS
ENABLE_GRID_BUY=true
ENABLE_GRID_SELL=true
ENABLE_FARMER_CONFIRMED_BUY=true
ENABLE_RECOVERY_TURTLE_SELL=true
GRID_BOT_USE_ACCOUNT_CAPITAL=true
GRID_BOT_MAX_REAL_ORDER_KRW=<1회 최대 주문 허용액>
GRID_BOT_MAX_REAL_TOTAL_CAPITAL_KRW=<실거래 총자본 허용액>
```

실거래 모드에서는 `GRID_BOT_USE_ACCOUNT_CAPITAL=true`가 기본값입니다. 이 경우 봇 시작 시와 새 사이클 시작 시 Bithumb 계좌의 KRW 잔고와 BTC 평가금액을 불러와 `totalCapitalKrw`를 자동 갱신합니다. `GRID_BOT_USE_ACCOUNT_CAPITAL=false`로 끄면 `GRID_BOT_TOTAL_CAPITAL_KRW` 환경변수 값을 전략 기준 자본금으로 사용합니다.

계좌 평가금액 또는 `GRID_BOT_TOTAL_CAPITAL_KRW`가 `GRID_BOT_MAX_REAL_TOTAL_CAPITAL_KRW`보다 크거나, 개별 주문 금액이 `GRID_BOT_MAX_REAL_ORDER_KRW`보다 크면 봇은 시작 또는 주문 단계에서 중단됩니다. 실거래 전에는 반드시 10,000원 테스트 주문, 로그 확인, 주문/잔고 정합성 검증을 먼저 진행해야 합니다.

## 주요 구조

```text
apps/grid-bot/src/
├── main.ts                         # 그리드 봇 루프 진입점
├── config.ts                       # 환경변수 및 기능 플래그 로드
├── grid/
│   ├── grid-engine.ts              # 그리드 매수/매도 판단
│   ├── grid-levels.ts              # 그리드 가격표 생성
│   └── grid-state-machine.ts       # GRID/FARMING 상태 전환
├── farmer/                         # 농부 매수 신호/필터/자금 계산
├── turtle/                         # Recovery Turtle 청산 신호/분할 청산
├── orders/
│   ├── paper-executor.ts           # Paper 주문 실행
│   └── order-executor.ts           # 실거래 주문 인터페이스
├── storage/
│   ├── local-state-store.ts        # bot_state.json atomic write
│   └── logger.ts                   # JSONL 로그 저장
├── bithumb/
│   ├── bithumb-client.ts           # Bithumb 현재가 조회
│   └── rate-limiter.ts             # 요청 간격 제한
└── telegram/
    └── telegram-bot.ts             # 텔레그램 알림/명령 워커

apps/dashboard/src/
└── server.ts                       # 대시보드 HTTP 서버

packages/shared/src/
├── constants.ts                    # 전략 기본값
├── grid-math.ts                    # 그리드 계산
├── money.ts                        # 금액/수량 보정
├── recovery-position.ts            # 그리드+농부 통합 회복 포지션 계산
└── types.ts                        # 공통 타입
```

## 설치

```powershell
npm.cmd install
```

PowerShell에서 `npm` 실행이 막히면 `npm.cmd`를 사용합니다.

## 타입 체크

```powershell
npm.cmd run typecheck
```

## 빌드

```powershell
npm.cmd run grid:build
npm.cmd run dashboard:build
```

## 로컬 Paper 실행

한 번만 실행:

```powershell
npm.cmd run grid:paper:once
```

Mock 가격으로 지속 실행:

```powershell
npm.cmd run grid:build
$env:GRID_BOT_MOCK_PRICE='100000000'
npm.cmd run grid:paper:mock
```

Bithumb 현재가로 Paper 실행:

```powershell
npm.cmd run grid:build
npm.cmd run grid:paper:live
```

## 상태 초기화

현재 `data/bot_state.json` 상태를 초기화합니다.

```powershell
npm.cmd run grid:build
npm.cmd run grid:reset
```

초기화 후 첫 실행에서 현재가 또는 Mock 가격을 기준으로 그리드가 생성됩니다.

## 대시보드

빌드 후 실행:

```powershell
npm.cmd run dashboard:build
npm.cmd run dashboard:start
```

기본 포트는 PM2 설정 기준 `3000`입니다.

대시보드 주요 기능:

- Metadata: 거래소, 마켓, Phase, Last Loop
- Grid: Last Price, Next Grid Entry, Layer Status, Buy/Sell Count
- Realized PNL: Total/Today 실현손익 및 수익률
- Holding: 평가손익 및 수익률
- Recovery Position: 통합 수량, 통합 원가, 평균단가, 평가금, 통합 손익
- Last Farmer Signal: 농부 매수 신호와 차단 사유
- Turtle Exit: 청산 신호, Profit Gate, 2N Stop, Expected Net PnL
- Daily PNL 달력
- Realized PNL Trend 그래프 및 hover 툴팁
- Recent Paper Logs
- Open Grid Levels
- Waiting Grid Levels
- Strategy Setting 표시
- Strategy Adjustment 수정
- 그리드 매매 조건 카드: 그리드 차수, 차수 간격, 차수별 매입 금액, 매도 익절 기준, 트레일링 폴링 기준
- 차수별 Grid 설정 접기/펼치기
- Grid 점검 간격 설정
- Grid 전체 리셋 시 레이어 초기화
- Grid Extension
- Telegram 설정, 테스트 메시지, 그리드 매수/매도 알림 방식 조정

## Strategy Setting

대시보드에는 저장된 전략값이 읽기 전용으로 표시됩니다.

표시 순서:

```text
Grid Levels
Gap per level (%)
Buy Amount per level
Take Profit per level
Trailing Pullback per level
Farmer Stages
Farmer Entry Percent (%)
Grid Safety Check Interval
Farming Loop Interval
Grid Total
Farmer Stage 1
Farmer Stage 2
Farmer Stage 3
Total Investment
Grid / Farmer
```

수정은 `Strategy Adjustment`를 펼친 뒤 진행합니다.

수정 가능 항목:

```text
Grid Levels
Gap per level (%)
Buy amount per level (KRW)
Take Profit per level (%)
Trailing Pullback per level (%)
Farmer Stages
Farmer Entry Percent (%)
Grid Safety Check Interval Seconds
Farming Loop Interval Seconds
Recovery Turtle Sell
Turtle N Period
Trailing N Multiplier
Turtle Min Order KRW
Slice Order KRW
Slice Interval Seconds
Partial Take Profit
TP1 Return / TP1 Sell Ratio
TP2 Return / TP2 Sell Ratio
```

참고:

- `Buy amount per level`은 보유 중인 OPEN layer의 원가는 바꾸지 않고, 아직 보유하지 않은 WAITING/SOLD layer와 신규 layer에만 적용됩니다.
- `Farmer Entry Percent` 기본값은 `15%`이며, 농부 2차 이후 가격 조건 판단에 사용됩니다.
- `Recovery Turtle Sell`은 기본 꺼짐입니다. 켜야 실제 통합 회복 포지션 청산 주문이 실행됩니다.
- `Partial Take Profit`이 꺼져 있으면 TP1/TP2 입력은 비활성화되며, 저장값은 유지되지만 전략에는 아직 적용되지 않습니다.

## Farmer 매수 구현 현황

농부 매수는 처음부터 실주문으로 켜지 않고, `FARMER_SIGNAL` 로그를 먼저 남긴 뒤 `ENABLE_FARMER_CONFIRMED_BUY=true`일 때만 실제 매수를 실행합니다.

확정 매수 기본 조건:

```text
직전 기준가 대비 -15% 이하 가격 조건 도달
AND 직전 농부 차수 체결 후 최소 쿨다운 경과
AND 현재가 기준 최근 3일 기준가 대비 하락률 > -25%
AND 전날 TR <= N × 2
AND MA200 장기 추세 필터 통과
AND 현재가 > 확정 일봉 MA5
AND MA5_today >= MA5_yesterday
AND KRW 거래대금 조건 통과
AND 종가 위치 >= 0.6
AND 과열 투매 예외 아님
AND 잔여 현금 방어력 검증 통과
```

방어력 등급:

```text
3차까지 방어 가능: 정상 진행
2차까지만 가능: 3차는 남은 현금 cap 매수 가능, 강한 경고
현금 부족: 최소 주문금액 또는 최소 방어금 부족 시 실매수 보류
```

농부 3차는 최종 방어선이므로 기본 정책은 남은 현금 cap 매수입니다. 단, 실제 주문금액이 최소 주문금액 미만이면 실행하지 않습니다.

## Recovery Turtle 매도 구현 현황

농부 매수 이후 터틀 매도는 농부 물량만 따로 보지 않고, OPEN 그리드 레이어와 농부 포지션을 합친 `Recovery Position`을 기준으로 청산합니다. 계좌 전체 손익은 대시보드 참고/경고 정보로만 사용하고, 청산 게이트에는 섞지 않습니다.

청산 기준:

```text
Recovery Turtle 청산 =
  통합 회복 포지션 예상 순손익 > 0
  AND (
    현재가 < highest_price - trailing_width
    OR 현재가 < 확정 일봉 MA5
    OR 현재가 < 확정 일봉 기준 최근 N일 저가
  )
```

청산 실행:

```text
1. OPEN 그리드 레이어 + 농부 포지션을 Recovery Position으로 합산
2. 현재 구현은 수수료를 반영한 예상 순손익 > 0 확인
3. 2N 트레일링, MA5 이탈, N일 저가 이탈 조건 확인
4. ENABLE_RECOVERY_TURTLE_SELL=false이면 RECOVERY_EXIT_SIGNAL만 기록
5. ENABLE_RECOVERY_TURTLE_SELL=true이면 Slice Order KRW / Slice Interval Seconds 기준으로 분할 시장가 청산
```

부분 익절 설정은 대시보드 `Strategy Adjustment`에서 켜고 끌 수 있으며, 기본값은 꺼짐입니다. 켜면 TP1/TP2 조건 도달 시 설정 비율만큼 통합 회복 포지션을 부분 매도하고, 남은 수량과 원가는 비례 축소해 추적합니다.

```text
부분 익절: 꺼짐
익절 단계: 사용 안 함
추세 추종 잔여 비율: 전체 물량
트레일링 N 배수: 2.0
최대 허용 슬리피지: 0.15%
분할 주문 금액: 1,000,000원
분할 주문 간격: 10초
```

부분 익절이 꺼져 있으면 1차/2차 익절 수익률과 매도 비율은 저장된 기본값일 뿐 적용되지 않으며, 화면에서도 비활성화합니다.

```text
부분 익절: 켜짐
1차 익절 수익률: 10%
1차 익절 매도 비율: 33%
2차 익절 수익률: 20%
2차 익절 매도 비율: 33%
추세 추종 잔여 비율: 남은 물량
```

## Grid Extension

`Strategy Adjustment` 안에서 `Grid Extension Levels`를 입력해 그리드를 확장할 수 있습니다.

확장 규칙:

- 진행된 마지막 차수 이후 N개 차수를 추가합니다.
- 기준 가격은 현재 Next Grid Entry입니다.
- FARMING 전환은 그리드 전체 체결만으로 발생하지 않고, 농부 1차 매수가 실제 체결될 때 발생합니다.

## 텔레그램

대시보드에서 Bot Token과 Chat ID를 입력하고 저장할 수 있습니다.

대시보드 기능:

- Telegram ON/OFF
- Bot Token 저장
- Chat ID 저장
- 그리드 매수 알림 방식: 끄기 / 즉시 / 묶음
- 그리드 매도 알림 방식: 끄기 / 즉시 / 묶음
- 묶음 기준 설정
- 테스트 메시지 발송

테스트 메시지:

```text
You're now connected.
```

설정 파일:

```text
data/telegram_settings.json
```

알림 정책:

- Grid 매수 알림은 기본 `묶음`
- Grid 매도 알림은 기본 `즉시`
- 서로 다른 layer/stage 10개 거래 묶음 요약 ON
- 하루 상태 요약 ON
- 리스크/에러/phase 변화 즉시 알림 ON
- Farmer/Turtle 개별 매매 알림 ON

추천 설정:

```text
gridBuyNotificationMode=batch
gridSellNotificationMode=immediate
gridBatchSize=10
```

텔레그램 워커 실행:

```powershell
npm.cmd run grid:build
npm.cmd run telegram:start
```

## 가격 감시

Grid bot 본체는 Bithumb WebSocket ticker를 기본으로 사용합니다.

- 현재가: WebSocket 실시간 반영
- 조건 판단: WebSocket 가격 이벤트 기반
- REST 호출: 주문, 잔고, 체결 확인, WebSocket stale fallback 등 필요한 순간만 사용
- 안전 점검: 가격 이벤트가 없을 때 1분 간격으로 상태 확인

로그에서 아래 형태가 보이면 이벤트 기반 동작 중입니다.

```text
trigger=price-event safetyCheckMs=60000
loop=66 wake=price price=99214000 source=BITHUMB_WS ... nextWaitMs=60000
```

별도 가격 감시 CLI는 Bithumb 공개 API에서 현재가를 주기적으로 수집하는 보조 도구입니다.

```powershell
npm.cmd run grid:build
npm.cmd run price:watch
```

수집 파일:

```text
data/price_ticks/KRW-BTC.jsonl
data/price_ticks/KRW-BTC.latest.json
```

## 생성되는 데이터 파일

```text
data/bot_state.json
data/trading_logs/btc_master_log.jsonl
data/telegram_settings.json
data/control/grid_control.json
data/price_ticks/KRW-BTC.jsonl
data/price_ticks/KRW-BTC.latest.json
```

`data/` 아래의 실제 실행 데이터는 일반적으로 Git에 포함하지 않습니다.

## PM2 실행

PM2 설정 파일:

```text
config/pm2.ecosystem.config.cjs
```

AWS/VPS 반영 기본 명령:

```bash
cd /var/autobot/bithumb_grid_farmer
npm run grid:build
npm run dashboard:build
pm2 restart bithumb-grid-bot-paper
pm2 restart bithumb-grid-dashboard
pm2 restart bithumb-grid-telegram
```

처음 시작:

```bash
npm run grid:build
npm run dashboard:build
npm run pm2:paper:start
npm run pm2:dashboard:start
npm run pm2:telegram:start
```

로그 확인:

```bash
pm2 logs bithumb-grid-bot-paper
pm2 logs bithumb-grid-dashboard
pm2 logs bithumb-grid-telegram
```

중지:

```bash
npm run pm2:paper:stop
npm run pm2:dashboard:stop
npm run pm2:telegram:stop
```

서버 재부팅 후 자동 실행:

```bash
pm2 save
pm2 startup
```

`pm2 startup`이 출력하는 명령을 복사해 한 번 더 실행합니다.

## 주요 환경변수

Grid bot:

```text
GRID_BOT_ID=btc-grid-bot
GRID_BOT_MARKET=KRW-BTC
GRID_BOT_USE_WEBSOCKET_TICKER=true
GRID_BOT_LOOP_INTERVAL_MS=3000
GRID_BOT_SAFETY_CHECK_INTERVAL_MS=60000
GRID_BOT_FARMING_LOOP_INTERVAL_MS=300000
GRID_BOT_TOTAL_CAPITAL_KRW=10000000
GRID_BOT_USE_ACCOUNT_CAPITAL=true
GRID_BOT_MAX_REAL_TOTAL_CAPITAL_KRW=11000000
GRID_BOT_MAX_REAL_ORDER_KRW=5000000
GRID_BOT_GRID_LEVELS=20
GRID_BOT_GRID_GAP_PCT=0.01
ENABLE_REAL_ORDERS=false
ENABLE_GRID_BUY=true
ENABLE_GRID_SELL=true
BITHUMB_ACCESS_KEY=
BITHUMB_SECRET_KEY=
```

Dashboard:

```text
DASHBOARD_HOST=0.0.0.0
DASHBOARD_PORT=3000
DASHBOARD_STATE_PATH=data/bot_state.json
DASHBOARD_TRADE_LOG_PATH=data/trading_logs/btc_master_log.jsonl
DASHBOARD_BOT_OUT_LOG_PATH=/home/ec2-user/.pm2/logs/bithumb-grid-bot-paper-out-0.log
DASHBOARD_AUTH_USER=admin
DASHBOARD_AUTH_PASSWORD=
TELEGRAM_SETTINGS_PATH=data/telegram_settings.json
```

Telegram:

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_GRID_BATCH_SIZE=10
TELEGRAM_DAILY_REPORT_HOUR_KST=7
TELEGRAM_DAILY_REPORT_MINUTE_KST=0
```

대시보드에서 저장하는 텔레그램 설정 파일(`data/telegram_settings.json`)에는 아래 그리드 알림 옵션도 저장됩니다.

```text
gridBuyNotificationMode=batch
gridSellNotificationMode=immediate
gridBatchSize=10
```

Farmer/Recovery Turtle 설정:

```text
ENABLE_FARMER_CONFIRMED_BUY=false
ENABLE_RECOVERY_TURTLE_SELL=false

FARMER_LONG_TREND_MODE=relaxed
FARMER_MIN_DAILY_TURNOVER_KRW=0
FARMER_MAX_3D_DRAWDOWN_PCT=-0.25
FARMER_VOLATILITY_N_MULTIPLIER=2
FARMER_USE_TWO_BULLISH_DAILY_FILTER=true
FARMER_STAGE2_COOLDOWN_DAYS=3
FARMER_STAGE3_COOLDOWN_DAYS=5
FARMER_ALLOW_FINAL_CAP_BUY=true
FARMER_MIN_ORDER_KRW=5000
FARMER_MIN_DEFENSE_CASH_AFTER_BUY_KRW=0

RECOVERY_TURTLE_N_PERIOD=20
RECOVERY_TURTLE_LOW_BREAKOUT_PERIOD=20
RECOVERY_TURTLE_N_MULTIPLIER=2
RECOVERY_TURTLE_MIN_ORDER_KRW=5000
RECOVERY_TURTLE_SLICE_ORDER_KRW=1000000
RECOVERY_TURTLE_SLICE_INTERVAL_SECONDS=10
```

## 기본 전략 파라미터

```text
Market: KRW-BTC
Grid ratio: total capital의 15.8%
Grid levels: 20
Gap per level: 1%
Default total capital: 10,000,000 KRW
Price trigger: WebSocket ticker event
Safety check interval: 60 seconds
REST ticker fallback: WebSocket stale/first quote timeout
Farmer entry percent: 15%
Farmer long trend mode: relaxed
Farmer 3-day drawdown block: -25%
Farmer volatility block: N × 2
Farmer stage cooldown: stage2 3 days, stage3 5 days
Recovery turtle sell: off
Recovery turtle N period: 20
Recovery turtle trailing N multiplier: 2.0
Recovery turtle min order: 5,000 KRW
Recovery turtle slice order: 1,000,000 KRW
Recovery turtle slice interval: 10 seconds
Partial take profit: off
TP1 return / sell ratio: 10% / 33%
TP2 return / sell ratio: 20% / 33%
```

예를 들어 총자본이 1,000만 원이면 그리드 총액은 약 158만 원이고, 20단계 기준 1단계 매수금액은 약 79,000원입니다.

## 개발 체크리스트

변경 후 기본 검증:

```powershell
npm.cmd run typecheck
npm.cmd run grid:build
npm.cmd run dashboard:build
```

AWS 반영 후 확인:

```bash
pm2 status
pm2 logs bithumb-grid-bot-paper
pm2 logs bithumb-grid-dashboard
pm2 logs bithumb-grid-telegram
```

## 주의

이 프로젝트는 자동매매 테스트 프로젝트입니다. 실거래를 켜기 전에 Paper Trading, 주문 로그, 잔고 정합성, 에러 복구, 네트워크 장애 대응을 충분히 검증해야 합니다.

Farmer/Recovery Turtle 실거래는 신호 로그 검증 후 단계적으로 켭니다. 농부 매수는 구조적 하락장과 자유낙하 구간을 피하기 위한 MA200/하락 속도/쿨다운 필터를 통과해야 하며, 터틀 매도는 OPEN 그리드 레이어와 농부 포지션을 합친 통합 회복 포지션의 예상 순손익이 양수일 때만 분할 청산하는 것을 기본으로 합니다. 실시간 orderbook 기반 슬리피지 사전 계산과 지정가 우선 청산은 다음 단계 구현 대상입니다.

투입 자금은 반드시 잃어도 되는 범위 안에서만 사용해야 하며, 실거래 기능을 켜는 경우 모든 책임은 실행자에게 있습니다.
