# Bithumb Grid Farmer

Bithumb BTC/KRW 자동매매를 위한 그리드, 농부, 회복 터틀 통합 봇입니다. 현재 프로젝트는 **웹소켓 가격 이벤트 기반**, **공격형 지정가 실거래**, **대시보드/텔레그램 운영**, **로컬 JSON 상태 저장**을 중심으로 구성되어 있습니다.

> 실거래 기능이 포함되어 있습니다. `ENABLE_REAL_ORDERS=true`와 확인 문구가 동시에 설정되면 실제 Bithumb 주문이 발생할 수 있습니다.

## 한눈에 보기

| 구분 | 현재 동작 |
| --- | --- |
| 거래소 | Bithumb |
| 기본 마켓 | `KRW-BTC` |
| 가격 입력 | Bithumb WebSocket ticker 기본 사용 |
| 주문 방식 | 페이퍼 주문 기본, 실거래 시 공격형 지정가 주문 |
| 상태 저장 | `data/bot_state.json` |
| 거래 로그 | `data/trading_logs/btc_master_log.jsonl` |
| 대시보드 | Node HTTP 서버, 기본 포트 `3000` |
| 텔레그램 | `/status`, 일일 리포트, 위험 알림, 제어 파일 연동 |
| PM2 앱 | 봇, 가격 감시, 대시보드, 텔레그램 |

## 목차

- [프로젝트 구조](#프로젝트-구조)
- [전략 흐름](#전략-흐름)
- [실거래 안전장치](#실거래-안전장치)
- [설치와 빌드](#설치와-빌드)
- [AWS 운영 명령](#aws-운영-명령)
- [환경 변수](#환경-변수)
- [대시보드와 텔레그램](#대시보드와-텔레그램)
- [데이터 파일](#데이터-파일)
- [자주 보는 확인 명령](#자주-보는-확인-명령)
- [운영 주의사항](#운영-주의사항)

## 프로젝트 구조

```text
apps/grid-bot      그리드, 농부, 회복 터틀, Bithumb 주문, 텔레그램 봇
apps/dashboard     운영 대시보드 HTTP 서버
packages/shared    공통 타입, 금액 계산, 그리드 수학, 포지션 집계
config             PM2 설정과 예시 설정
scripts            단발 실행, 백테스트, 계좌 확인, 가격 감시 도구
data               운영 상태와 로그 저장 위치
docs               계획/설계 문서
archive            과거 문서 보관
```

주요 실행 스크립트:

| 명령 | 설명 |
| --- | --- |
| `npm run typecheck` | grid-bot과 dashboard 타입 검사 |
| `npm run grid:build` | grid-bot TypeScript 빌드 |
| `npm run dashboard:build` | dashboard TypeScript 빌드 |
| `npm run grid:start` | 빌드된 grid-bot 실행 |
| `npm run dashboard:start` | 빌드된 dashboard 실행 |
| `npm run telegram:start` | 빌드된 텔레그램 봇 실행 |
| `npm run bithumb:account` | Bithumb 계좌 확인 |
| `npm run backtest:btc:daily` | BTC 일봉 백테스트 |
| `npm run grid:reset` | 그리드 상태 리셋 도구 |
| `npm run price:watch` | 가격 감시 프로세스 실행 |

## 전략 흐름

### 1. 그리드

- 봇은 `GRID` 단계에서 여러 차수의 매수/매도 레이어를 관리합니다.
- 현재 사이클의 레이어 가격은 한 번 만들어지면 고정됩니다.
- 매도 완료된 `SOLD` 레이어는 가격이 다시 내려오면 같은 차수의 기존 매수가에서 재매수될 수 있습니다.
- 그리드 오픈 포지션이 0개일 때 1차 매수 기준은 설정으로 선택합니다.
  - `CURRENT_PRICE`: 현재가 기준 즉시 1차 진입
  - `N_MULTIPLE`: 현재가에서 `N * 배수`만큼 하락한 가격 기준 진입
- `N` 값은 확정된 일봉 기준으로 계산되며, KST 기준 현재 날짜의 미확정 일봉은 제외됩니다. 따라서 일반적으로 하루에 한 번 바뀝니다.

### 2. 농부

- 그리드 레이어가 모두 열리면 농부 신호 감시를 시작합니다.
- 실제 농부 매수는 `ENABLE_FARMER_CONFIRMED_BUY=true`일 때만 실행됩니다.
- 농부 매수 전 대시보드의 **농부 기준 매수가**는 마지막 그리드 차수의 매수가입니다.
- 농부 매수 후에는 **직전 농부 매수가**를 기준으로 다음 농부 진입가를 계산합니다.
- 주요 필터는 장기 추세, MA5 추세, 거래대금, 3일 하락률, 변동성 폭발, 양봉 조건, 현금 방어입니다.

### 3. 회복 터틀

- 농부 매수 이후에는 그리드와 농부 포지션을 합친 통합 회복 포지션을 기준으로 청산 신호를 봅니다.
- 예상 순손익이 양수일 때만 매도 신호가 실제 청산 후보가 됩니다.
- 청산 신호는 2N 트레일링, MA5 이탈, N일 저가 이탈을 지원합니다.
- `ENABLE_RECOVERY_TURTLE_SELL=false`가 기본값이며, 이 경우 신호만 기록하고 실제 매도는 하지 않습니다.
- 분할 매도는 `RECOVERY_USE_SLICE_ORDER`, `RECOVERY_TURTLE_SLICE_ORDER_KRW`, `RECOVERY_TURTLE_SLICE_INTERVAL_SECONDS`로 조정합니다.

## 실거래 안전장치

기본값은 페이퍼 주문입니다. 실거래를 켜려면 아래 조건이 모두 필요합니다.

```bash
export ENABLE_REAL_ORDERS=true
export REAL_ORDERS_CONFIRM=I_UNDERSTAND_REAL_BITHUMB_ORDERS
export GRID_BOT_MAX_REAL_ORDER_KRW=5000000
export GRID_BOT_MAX_REAL_TOTAL_CAPITAL_KRW=11000000
```

실거래 보호 로직:

| 항목 | 설명 |
| --- | --- |
| 확인 문구 | `REAL_ORDERS_CONFIRM` 값이 정확히 일치해야 함 |
| 주문 한도 | 1회 주문 한도와 총 운용 한도 검사 |
| 계좌 자본 반영 | 실거래 시 `GRID_BOT_USE_ACCOUNT_CAPITAL=true`가 기본 |
| 모의 가격 차단 | `GRID_BOT_MOCK_PRICE`가 있으면 실거래 시작 실패 |
| API 키 검사 | Bithumb access/secret key 필요 |

실거래 주문은 시장가가 아니라 **시장가에 가깝게 체결을 유도하는 지정가 주문**입니다.

```bash
export GRID_BOT_USE_AGGRESSIVE_LIMIT_ORDERS=true
export GRID_BOT_AGGRESSIVE_LIMIT_OFFSET_PCT=0.0005
export GRID_BOT_AGGRESSIVE_LIMIT_WAIT_MS=5000
```

주문 후 즉시 체결되지 않으면 지정 시간 동안 체결 조회를 반복합니다. 취소 응답 이후에도 지연 체결 가능성을 한 번 더 확인하도록 되어 있습니다.

## 설치와 빌드

```bash
npm install
npm run grid:build
npm run dashboard:build
npm run typecheck
```

로컬 페이퍼 단발 실행:

```bash
npm run grid:paper:once
```

Bithumb 계좌 확인:

```bash
npm run bithumb:account
```

## AWS 운영 명령

서버 경로:

```bash
cd /var/autobot/bithumb_grid_farmer
```

최신 코드 반영:

```bash
git pull origin main
npm install
npm run grid:build
npm run dashboard:build
```

PM2 재시작:

```bash
pm2 restart bithumb-grid-bot-paper --update-env
pm2 restart bithumb-grid-dashboard
pm2 restart bithumb-grid-telegram
pm2 restart bithumb-price-watch
pm2 save
```

프로세스 확인:

```bash
pm2 list
pm2 logs bithumb-grid-bot-paper --lines 120
pm2 logs bithumb-grid-telegram --lines 80
```

실거래 환경 변수 반영 후 봇 재시작:

```bash
export ENABLE_REAL_ORDERS=true
export REAL_ORDERS_CONFIRM=I_UNDERSTAND_REAL_BITHUMB_ORDERS
export GRID_BOT_MAX_REAL_ORDER_KRW=5000000
export GRID_BOT_MAX_REAL_TOTAL_CAPITAL_KRW=11000000
export GRID_BOT_AGGRESSIVE_LIMIT_WAIT_MS=5000
pm2 restart bithumb-grid-bot-paper --update-env
```

## 환경 변수

### 기본 실행

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `GRID_BOT_ID` | `btc-grid-bot` | 봇 식별자 |
| `GRID_BOT_MARKET` | `KRW-BTC` | 거래 마켓 |
| `GRID_BOT_TOTAL_CAPITAL_KRW` | `10000000` | 기준 운용 자본 |
| `GRID_BOT_GRID_RATIO` | shared 기본값 | 그리드 투자 비율 |
| `GRID_BOT_GRID_LEVELS` | shared 기본값 | 그리드 레이어 수 |
| `GRID_BOT_GRID_GAP_PCT` | shared 기본값 | 레이어 간 가격 간격 |
| `GRID_BOT_USE_WEBSOCKET_TICKER` | `true` | 웹소켓 가격 사용 |
| `GRID_BOT_SAFETY_CHECK_INTERVAL_MS` | `60000` | 안전 점검 주기 |

### 실거래

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `ENABLE_REAL_ORDERS` | `false` | 실제 주문 사용 여부 |
| `REAL_ORDERS_CONFIRM` | 빈 값 | 실거래 확인 문구 |
| `GRID_BOT_USE_ACCOUNT_CAPITAL` | 실거래 시 `true` | 계좌 자본 자동 반영 |
| `GRID_BOT_MAX_REAL_ORDER_KRW` | `10000` | 1회 실주문 최대 금액 |
| `GRID_BOT_MAX_REAL_TOTAL_CAPITAL_KRW` | `1000000` | 총 실거래 운용 한도 |
| `BITHUMB_ACCESS_KEY` | 빈 값 | Bithumb API access key |
| `BITHUMB_SECRET_KEY` | 빈 값 | Bithumb API secret key |
| `BITHUMB_SETTINGS_PATH` | `data/bithumb_settings.json` | 저장된 Bithumb 키 파일 |

### 주문 체결

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `GRID_BOT_USE_AGGRESSIVE_LIMIT_ORDERS` | `true` | 공격형 지정가 주문 사용 |
| `GRID_BOT_AGGRESSIVE_LIMIT_OFFSET_PCT` | `0.0005` | 현재가 대비 지정가 보정률 |
| `GRID_BOT_AGGRESSIVE_LIMIT_WAIT_MS` | `5000` | 지정가 체결 대기 시간 |

### 농부와 회복 터틀

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `ENABLE_FARMER_CONFIRMED_BUY` | `false` | 농부 확정 매수 실행 |
| `FARMER_LONG_TREND_MODE` | `relaxed` | 장기 추세 필터 모드 |
| `FARMER_MIN_ORDER_KRW` | `5000` | 농부 최소 주문 금액 |
| `FARMER_MIN_DEFENSE_CASH_AFTER_BUY_KRW` | `0` | 매수 후 남길 최소 현금 |
| `ENABLE_RECOVERY_TURTLE_SELL` | `false` | 회복 터틀 실제 매도 |
| `RECOVERY_TURTLE_N_PERIOD` | `20` | N 계산 기간 |
| `RECOVERY_TURTLE_N_MULTIPLIER` | `2` | 터틀 트레일링 배수 |
| `RECOVERY_USE_SLICE_ORDER` | `true` | 분할 매도 사용 |

## 대시보드와 텔레그램

대시보드는 다음 정보를 보여줍니다.

- 현재 가격, 사이클, 단계, 자본, 계좌 반영 상태
- 보유 중인 그리드, 대기 중인 그리드, 매도 완료 레이어
- 최근 실거래 로그와 매도 이유
- 농부 기준 매수가와 다음 농부 진입가
- 일별 손익 달력과 추세
- PM2 로그 tail
- 전략 설정과 텔레그램/Bithumb 설정

최근 `GRID_SELL` 로그에는 가능한 경우 아래 매도 메타데이터가 기록됩니다.

| 필드 | 의미 |
| --- | --- |
| `sellReason` | `TAKE_PROFIT` 또는 `TRAILING_PULLBACK` |
| `peakPrice` | 매도 전 추적된 최고가 |
| `peakReturnPct` | 최고가 기준 수익률 |
| `exitReturnPct` | 실제 매도 시점 수익률 |
| `returnPullbackPct` | 최고 수익률에서 되돌린 폭 |
| `trailingStopPrice` | 트레일링 스탑 가격 |
| `targetSellPrice` | 기본 목표 매도가 |

텔레그램 일일 리포트는 기간 전체 로그 기준과 현재 사이클 기준을 구분합니다. `/status`의 `Last Loop`는 KST로 표시됩니다.

## 데이터 파일

| 경로 | 설명 | 삭제 주의 |
| --- | --- | --- |
| `data/bot_state.json` | 현재 봇 상태와 레이어 상태 | 운영 중 임의 삭제 금지 |
| `data/trading_logs/btc_master_log.jsonl` | 모든 거래/신호/오류 로그 | 거래 기록이므로 보존 권장 |
| `data/telegram_settings.json` | 텔레그램 설정 | 필요 시 백업 |
| `data/control/grid_control.json` | 대시보드/텔레그램 제어 파일 | 운영 중 내용 확인 필요 |
| `data/backtests` | 백테스트 산출물 | 디스크 부족 시 삭제 가능 |

## 자주 보는 확인 명령

현재 상태와 레이어:

```bash
node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync("data/bot_state.json","utf8")); console.log({cycleId:s.cycleId, phase:s.phase, lastPrice:s.lastPrice, gridEntryPrice:s.gridEntryPrice}); console.table(s.layers.map(l=>({idx:l.idx,status:l.status,buyPrice:l.buyPrice,sellPrice:l.sellPrice,qty:l.qty,buyCount:l.buyCount,sellCount:l.sellCount,buyOrderId:l.buyOrderId,sellOrderId:l.sellOrderId,boughtAt:l.boughtAt,soldAt:l.soldAt})));'
```

최근 그리드 매수:

```bash
grep '"GRID_BUY"' data/trading_logs/btc_master_log.jsonl | tail -20
```

최근 그리드 매도와 매도 이유:

```bash
grep '"GRID_SELL"' data/trading_logs/btc_master_log.jsonl | tail -20
```

실거래 활성화 여부:

```bash
pm2 env bithumb-grid-bot-paper | grep -E "ENABLE_REAL_ORDERS|REAL_ORDERS_CONFIRM|GRID_BOT_MAX_REAL_ORDER_KRW|GRID_BOT_MAX_REAL_TOTAL_CAPITAL_KRW"
```

## 운영 주의사항

- `BOT_ERROR`의 "limit order was not filled"는 해당 주문 ID가 지정 시간 안에 확정 체결되지 않았다는 뜻입니다. 이후 별도 주문 ID로 재시도되어 체결될 수 있습니다.
- 로그의 `reason: "BITHUMB_WS"`는 주문 이유가 아니라 가격 신호 출처가 웹소켓이었다는 의미입니다. 실제 체결 확인 출처는 `BITHUMB_REST`로 남을 수 있습니다.
- Daily Report의 `Buy fills`는 기간 내 로그 기준이고, Status의 `OPEN`은 현재 `bot_state.json` 기준입니다. 사이클 리셋이 있으면 두 값은 다를 수 있습니다.
- AWS 루트 디스크가 작으면 PM2 로그와 백테스트 산출물이 빠르게 공간을 차지합니다. `pm2-logrotate`, 백테스트 파일 정리, EBS 확장을 권장합니다.
- `data/trading_logs`는 거래 기록입니다. 디스크 정리 시 `data/backtests`와 PM2 로그를 먼저 정리하세요.
