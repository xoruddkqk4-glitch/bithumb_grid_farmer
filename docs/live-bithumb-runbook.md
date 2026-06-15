# Bithumb 실거래 연결 Runbook

이 봇은 기본값으로 실제 주문을 만들지 않습니다. 실거래는 아래 조건이 모두 맞을 때만 켜집니다.

- `ENABLE_REAL_ORDERS=true`
- `REAL_ORDERS_CONFIRM=I_UNDERSTAND_REAL_BITHUMB_ORDERS`
- `BITHUMB_ACCESS_KEY`, `BITHUMB_SECRET_KEY` 설정
- `GRID_BOT_MOCK_PRICE` 미설정
- `GRID_BOT_TOTAL_CAPITAL_KRW <= GRID_BOT_MAX_REAL_TOTAL_CAPITAL_KRW`
- 개별 주문 금액이 `GRID_BOT_MAX_REAL_ORDER_KRW` 이하

## 1. API 키 준비

Bithumb에서 API 키를 만들 때 출금 권한은 켜지 않는 것을 권장합니다. 이 봇에는 자산 조회와 주문 권한만 필요합니다.

실거래 전에 Bithumb의 최신 API 키/IP 제한 공지와 주문 API 문서를 확인하세요.

## 2. 빌드

```powershell
npm.cmd run grid:build
```

## 3. 주문 없는 계좌 연결 확인

```powershell
$env:BITHUMB_ACCESS_KEY='your-access-key'
$env:BITHUMB_SECRET_KEY='your-secret-key'
npm.cmd run bithumb:account
```

이 명령은 주문을 만들지 않고 계좌 조회만 수행합니다.

## 4. 첫 실거래 1회 루프 예시

첫 테스트는 작은 총자본과 주문당 상한으로 실행하세요. 아래 예시는 총자본 1,000,000원, 그리드 20개, 비중 15.8% 기준으로 1회 매수 주문 금액이 약 7,900원입니다.

```powershell
$env:BITHUMB_ACCESS_KEY='your-access-key'
$env:BITHUMB_SECRET_KEY='your-secret-key'
$env:REAL_ORDERS_CONFIRM='I_UNDERSTAND_REAL_BITHUMB_ORDERS'
$env:GRID_BOT_TOTAL_CAPITAL_KRW='1000000'
$env:GRID_BOT_MAX_REAL_TOTAL_CAPITAL_KRW='1000000'
$env:GRID_BOT_MAX_REAL_ORDER_KRW='10000'
$env:ENABLE_GRID_BUY='true'
$env:ENABLE_GRID_SELL='false'
$env:GRID_BOT_MAX_LOOPS='1'
npm.cmd run grid:real:once
```

`ENABLE_GRID_SELL=false`로 시작하면 보유 포지션 매도는 막고, 조건이 맞을 때 첫 그리드 매수만 테스트할 수 있습니다. 현재 가격이 첫 매수 그리드보다 높으면 주문이 발생하지 않을 수 있습니다.

## 5. 즉시 중지 스위치

```powershell
$env:GRID_BOT_PAUSED='true'
$env:GRID_BOT_PAUSE_REASON='manual live pause'
```

이미 실행 중인 프로세스의 환경 변수는 실행 후 바뀌지 않습니다. PM2나 새 프로세스로 운영할 때는 해당 프로세스를 재시작해야 반영됩니다.

## 6. 운영 전 체크

- `data/bot_state.json`의 기존 paper 상태를 그대로 실거래에 쓰지 말고 필요하면 `npm.cmd run grid:reset`으로 초기화하세요.
- 첫 실거래 전에는 `npm.cmd run grid:paper:live`로 현재가 기반 paper 루프를 충분히 확인하세요.
- 실거래 중 `GRID_BOT_MOCK_PRICE`를 설정하지 마세요.
- API 키는 코드, 문서, Git 저장소에 저장하지 마세요.
