# [PDCA-Design] 비트코인 하이브리드 알고리즘 매매 시스템

| 항목 | 내용 |
|:--|:--|
| Feature ID | `grid_farmer_bot` |
| 단계 | **Design** (Architect + Security 관점) |
| 선행 문서 | `docs/01-plan/features/grid_farmer_bot_plan.md` |
| 관련 명세 | `grid_farmer_bot2.md` (개정 확정본 v2) |
| 반영 문서 | `grid_farmer_bot_advantage_risk_report.md` |
| 상태 | Draft (Review Report 주요 결정사항 병합) |

---

## 1. 설계 목표

Plan 단계에서 확정된 매매 로직을 **구현 가능한 모듈 구조 / 데이터 스키마 / 예외 처리 / 보안 정책**으로 구체화한다. 본 문서는 Plan §8.2의 잔여 미결 4개(#3 dust 정리, #5 API 예외, #6 Supabase 스키마, #7 인증)를 확정한다.

또한 Review Report에서 추가 검토된 다음 사항을 본 설계 문서의 구현 기준으로 병합한다.

- **레이어 분리 청산 + 계좌 손익 게이트**: 그리드 물량은 그리드 방식으로 분할 매도하고, 농부 물량은 2N/MA5 방식으로 추세 보유한다.
- **그리드 재매수 정책 구분**: `GRID` 단계에서는 팔린 그리드 레이어를 재매수할 수 있다. `FARMING` / `HOLDING` 단계로 넘어간 뒤에는 팔린 그리드 레이어를 재매수하지 않는다.
- **농부 KRW 거래대금 필터**: BTC 수량 거래량보다 KRW 거래대금을 핵심 진입 필터로 사용한다.
- **부분 조기 진입 + 09:05 확정 진입**: 농부 1~2차는 4시간봉 회복 신호로 일부만 조기 진입하고, 잔여분은 09:05 확정 필터 통과 후 집행한다.
- **농부 3차 조기 진입 금지**: 최종 방어선은 09:05 확정 조건만 허용한다.

---

## 2. 시스템 컴포넌트 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                        VPS (Linux)                           │
│                                                              │
│  ┌────────────────────┐         ┌────────────────────┐      │
│  │ trailing_stop_bot  │         │  ma5_trend_bot     │      │
│  │ (PM2, 24h, 1s loop)│         │ (crontab 5 9 * * *)│      │
│  │ - 그리드/농부 매수 │         │ - N(ATR) 계산·저장 │      │
│  │ - 2N 트레일링 청산 │         │ - 농부 3대 필터    │      │
│  │ - 상태 read 위주   │         │ - MA5 하회 청산    │      │
│  └─────────┬──────────┘         └─────────┬──────────┘      │
│            │     ┌──────────────────┐     │                 │
│            └────▶│  bot_state.json  │◀────┘                 │
│                  │ (atomic write)   │                       │
│                  └──────────────────┘                       │
│            │                              │                 │
│            ▼ append                       ▼                 │
│  ┌──────────────────────────────────────────────┐          │
│  │  Data Layer (2단계 전환)                       │          │
│  │  1) btc_master_log.json (MVP)                  │          │
│  │  2) Supabase PostgreSQL (확장)                 │          │
│  └──────────────────────┬───────────────────────┘          │
└─────────────────────────┼──────────────────────────────────┘
                          │ (read / realtime subscribe)
                          ▼
              ┌────────────────────────┐
              │  Next.js Dashboard     │
              │  - 실시간 현황/히스토리│
              │  - 기간별 XLSX 다운로드│
              └────────────────────────┘
```

### 2.1. 공통 모듈 (두 봇이 공유)

| 모듈 | 책임 |
|:--|:--|
| `upbit_client.py` | 업비트 API 래퍼 (잔고 조회, 주문, 캔들 조회) + 예외/재시도 |
| `state_store.py` | `bot_state.json` 원자적 read/write |
| `account.py` | 총자본/평가금/실시간 수익률 계산, 레이어별 평단·수량 추적 |
| `logger.py` | 매매 로그 append (JSON) + Supabase 적재 어댑터 |
| `config.py` | 그리드 비율(0.158), 차수(20), 간격(-1%), dust(10000), 쿨다운(5분) 등 상수 |

### 2.2. 확정 매매 정책

#### A. 레이어 분리 청산 + 계좌 손익 게이트

기존 통합 청산은 모든 그리드/농부 물량을 하나의 포지션으로 묶어 전량 청산하는 구조였다. 본 설계에서는 구현 기본값을 아래처럼 조정한다.

```text
그리드 물량: 반등 시 그리드 방식으로 분할 매도
농부 물량: 기존 2N 트레일링 또는 MA5 하회 방식으로 추세 청산
청산 게이트: 체결 예상 순손익 또는 계좌 손익이 양수일 때만 청산
```

운영 원칙은 다음과 같다.

- `GRID` 단계에서는 그리드 물량이 팔려도 해당 레이어 가격까지 다시 하락하면 재매수할 수 있다. 이는 순수 그리드 구간의 기본 수익 구조다.
- 그리드 20차가 모두 체결되어 `FARMING` 단계로 넘어간 뒤에는 팔린 그리드 물량을 현금 회수 완료로 본다.
- 농부 물량은 2N/MA5 방식으로 계속 보유한다.
- `FARMING` / `HOLDING` 상태에서 다시 하락하더라도 이미 팔린 그리드 물량은 재매수하지 않는다.
- 전체 사이클이 완전히 종료되고 5분 쿨다운이 끝난 뒤 새 그리드 사이클을 시작한다.
- `FARMING` 이후 그리드 재순환 옵션은 백테스트에서 필요성이 확인될 때만 별도 기능으로 추가한다.

#### B. 농부 09:05 확정 매수 필터

농부 확정 매수는 아래 조건을 모두 만족할 때만 통과한다.

```text
농부 확정 매수 필터 =
전날 종가 > MA5
AND MA5_today >= MA5_yesterday
AND 전날 KRW 거래대금 >= 20일 평균 거래대금 × 1.5
AND 전날 KRW 거래대금 >= 5일 평균 거래대금 × 1.2
AND 종가 위치 >= 0.6
AND 과열 투매 예외 조건 아님
```

```text
종가 위치 = (전날 종가 - 전날 저가) / (전날 고가 - 전날 저가)
```

과열 투매 예외 조건은 다음과 같다.

```text
전날 KRW 거래대금 >= 20일 평균 거래대금 × 3.5
AND 종가 위치 < 0.6
```

이 예외 조건에 걸리면 거래대금은 충분해도 농부 매수를 보류한다.

#### C. 농부 부분 조기 진입

09:05 확정 조건은 안전하지만 V자 반등에는 늦을 수 있다. 따라서 농부 1~2차에 한해 4시간봉 회복 신호를 이용한 부분 조기 진입을 허용한다.

```text
농부 1차: 조기 진입 30~40% + 09:05 확정 진입 60~70%
농부 2차: 조기 진입 20~30% + 09:05 확정 진입 70~80%
농부 3차: 조기 진입 금지, 09:05 확정 조건만 허용
```

조기 진입 조건은 다음과 같다.

```text
-15% 가격 조건 도달
AND 최근 확정 4시간봉 종가 > 4시간봉 단기 MA
AND 최근 확정 4시간봉 KRW 거래대금 >= 최근 N개 4시간봉 평균 거래대금 × 1.2
AND 4시간봉 종가 위치 >= 0.6
```

조기 진입 후 09:05 확정 조건을 통과하지 못하면 잔여 농부 자금은 집행하지 않는다.

---

## 3. 데이터 모델 설계

### 3.1. `bot_state.json` (런타임 상태)

```json
{
  "phase": "GRID",
  "cycle_id": "2026-06-03T09:05:00Z-001",
  "last_exit_time": null,
  "cooldown_until": null,
  "N_value": 1850000,
  "N_updated_at": "2026-06-03T09:05:00Z",
  "farmer_stage": 0,
  "grid_entry_price": 95000000,
  "highest_price": 0,
  "layers": [
    { "type": "GRID", "idx": 1, "price": 95000000, "qty": 0.00083, "amount_krw": 79000 }
  ],
  "farmer_anchor_price": null,
  "schema_version": 1
}
```

| 필드 | 쓰기 주체 | 설명 |
|:--|:--|:--|
| `phase` | 둘 다 | GRID / FARMING / HOLDING / COOLDOWN |
| `cycle_id` | trailing | 사이클 식별자 (재진입 시 갱신) |
| `cooldown_until` | 둘 다 | 청산 시각 + 5분 |
| `N_value` / `N_updated_at` | ma5_trend | 일 1회 갱신, trailing은 read-only |
| `farmer_stage` | ma5_trend | 0~3 |
| `farmer_anchor_price` | ma5_trend | 다음 농부 -15% 기준이 되는 직전 체결가 |
| `grid_entry_price` | trailing | 그리드 0차 기준가 |
| `highest_price` | trailing | 진입 후 최고가(2N 트레일링용) |
| `layers` | 둘 다 | 레이어별 평단/수량 (평가금·평단 계산용) |

> **동시성:** 쓰기는 항상 `state_store.write_atomic()`(임시파일 → `os.replace`). 두 봇이 동시 write하는 시간대는 09:05 1초 내외로 극히 짧고, 이 시간대에는 trailing이 read 위주가 되도록 설계(§5.3).

### 3.2. 매매 로그 레코드 (JSON / Supabase 공통 스키마)

```json
{
  "id": "uuid",
  "timestamp": "2026-06-03T09:05:01Z",
  "cycle_id": "2026-06-03T09:05:00Z-001",
  "action": "GRID_BUY | FARMER_BUY | LIQUIDATE",
  "layer_type": "GRID | FARMER",
  "stage": 1,
  "price": 95000000,
  "qty": 0.00083,
  "amount_krw": 79000,
  "fee_krw": 39,
  "avg_price_after": 95000000,
  "position_qty_after": 0.00083,
  "realized_pnl_krw": null,
  "realized_pnl_pct": null,
  "reason": null,
  "order_uuid": "upbit-order-uuid",
  "request_id": "idempotency-key"
}
```

### 3.3. Supabase 스키마 (미결 #6 확정)

```sql
-- 매매 체결 로그
create table trades (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id),
  ts            timestamptz not null default now(),
  cycle_id      text not null,
  action        text not null check (action in ('GRID_BUY','FARMER_BUY','LIQUIDATE')),
  layer_type    text check (layer_type in ('GRID','FARMER')),
  stage         int,
  price         numeric not null,
  qty           numeric not null,
  amount_krw    numeric not null,
  fee_krw       numeric default 0,
  avg_price_after numeric,
  position_qty_after numeric,
  realized_pnl_krw numeric,
  realized_pnl_pct numeric,
  reason        text,           -- '2N_TRAIL' | 'MA5_EXIT' | null
  order_uuid    text,           -- 업비트 주문 UUID
  request_id    text not null   -- 멱등성 키 (중복 적재 방지)
);

create unique index uq_trades_request on trades(user_id, request_id);
create index idx_trades_user_ts on trades(user_id, ts desc);
create index idx_trades_cycle on trades(user_id, cycle_id);

-- 사이클 요약 (대시보드 히스토리 가속용, 청산 시 1행 기록)
create table cycles (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id),
  cycle_id      text not null,
  started_at    timestamptz not null,
  ended_at      timestamptz,
  entry_price   numeric,
  exit_price    numeric,
  exit_reason   text,
  max_farmer_stage int,
  realized_pnl_krw numeric,
  realized_pnl_pct numeric
);

create unique index uq_cycles on cycles(user_id, cycle_id);

-- 봇 상태 스냅샷 (실시간 현황 표시용, 주기적 upsert)
create table bot_snapshots (
  user_id       uuid primary key references auth.users(id),
  phase         text,
  position_qty  numeric,
  avg_price     numeric,
  realtime_pnl_pct numeric,
  n_value       numeric,
  total_capital numeric,
  updated_at    timestamptz default now()
);
```

#### RLS (Row Level Security) 정책 — 미결 #7과 연결

```sql
alter table trades enable row level security;
alter table cycles enable row level security;
alter table bot_snapshots enable row level security;

-- 사용자는 자신의 데이터만 read
create policy "own_read_trades" on trades
  for select using (auth.uid() = user_id);
create policy "own_read_cycles" on cycles
  for select using (auth.uid() = user_id);
create policy "own_read_snap" on bot_snapshots
  for select using (auth.uid() = user_id);

-- 쓰기는 봇(service_role)만 → 대시보드 클라이언트는 write 불가
-- service_role 키는 RLS를 우회하므로 별도 insert 정책 불필요
```

### 3.4. 업비트 수집 정보값

본 전략은 일봉 확정 진입, 4시간봉 부분 조기 진입, 실시간 가격 감시, 계좌/주문 정합성 복구를 함께 사용한다. 업비트에서 받아와야 하는 정보는 다음과 같다.

| 필요한 정보 | 업비트 소스 | 주요 필드 | 용도 |
|:--|:--|:--|:--|
| 실시간 현재가 | WebSocket `ticker` 또는 REST 현재가 | `trade_price`, `timestamp` | 그리드 매수 가격 도달 감시, 농부 -15% 가격 도달 감시, 2N 트레일링 청산, 실시간 수익률 계산 |
| 일봉 시가/고가/저가/종가 | REST `/v1/candles/days` | `opening_price`, `high_price`, `low_price`, `trade_price`, `candle_date_time_kst` | 09:05 확정 필터, MA5 계산, N/ATR 계산, 종가 위치 계산 |
| 일봉 KRW 거래대금 | REST `/v1/candles/days` | `candle_acc_trade_price` | 농부 확정 매수의 거래대금 조건 계산 |
| 일봉 BTC 거래량 | REST `/v1/candles/days` | `candle_acc_trade_volume` | 보조 거래량 분석, 기존 거래량 조건 검증 |
| 4시간봉 시가/고가/저가/종가 | REST `/v1/candles/minutes/240` 또는 WebSocket `candle.240m` | `opening_price`, `high_price`, `low_price`, `trade_price`, `candle_date_time_kst`, `unit` | 농부 1~2차 부분 조기 진입 판단, 4시간봉 종가 위치 계산 |
| 4시간봉 KRW 거래대금 | REST `/v1/candles/minutes/240` 또는 WebSocket `candle.240m` | `candle_acc_trade_price` | 조기 진입 시 4시간봉 매수세 확인 |
| 4시간봉 BTC 거래량 | REST `/v1/candles/minutes/240` 또는 WebSocket `candle.240m` | `candle_acc_trade_volume` | 조기 진입 보조 거래량 분석 |
| 계정 KRW 잔고 | REST `/v1/accounts` | `currency`, `balance`, `locked` | 그리드 1회 매입금 계산, 농부 추가 투입 가능 금액 확인 |
| 계정 BTC 보유 수량 | REST `/v1/accounts` | `currency`, `balance`, `locked` | 포지션 평가금, 실시간 수익률, 청산 수량 계산 |
| 업비트 평균 매수가 | REST `/v1/accounts` | `avg_buy_price`, `avg_buy_price_modified`, `unit_currency` | 참고용 계좌 상태 확인. 단, 전략 평단은 봇 자체 레이어 로그 기준으로 별도 계산 |
| 주문 가능 정보 | REST `/v1/orders/chance` | `bid_fee`, `ask_fee`, `maker_bid_fee`, `maker_ask_fee`, `market.bid_types`, `market.ask_types`, `market.bid`, `market.ask`, `market.max_total` | 수수료율, 주문 가능 타입, 최소/최대 주문 가능 금액 확인 |
| 호가 정보 | WebSocket `orderbook` 또는 REST 호가 | `orderbook_units.ask_price`, `orderbook_units.ask_size`, `orderbook_units.bid_price`, `orderbook_units.bid_size`, `total_ask_size`, `total_bid_size` | 시장가 청산 전 예상 체결가와 슬리피지 계산 |
| 주문 생성 결과 | REST `/v1/orders` | `uuid`, `side`, `ord_type`, `price`, `volume`, `executed_volume`, `remaining_volume`, `paid_fee`, `state`, `created_at`, `identifier` | 주문 추적, 매매 로그 기록, 멱등성 관리 |
| 주문 조회/미체결 주문 | REST 주문 조회 API | `uuid`, `state`, `remaining_volume`, `executed_volume`, `trades_count` | 봇 재시작 후 주문 정합성 복구, 중복 주문 방지 |

#### 전략 계산에 필요한 파생값

| 파생값 | 계산식 | 원천 데이터 |
|:--|:--|:--|
| 일봉 MA5 | 최근 5개 확정 일봉 `trade_price` 평균 | 일봉 캔들 |
| 4시간봉 단기 MA | 최근 N개 확정 4시간봉 `trade_price` 평균 | 4시간봉 캔들 |
| 일봉 종가 위치 | `(trade_price - low_price) / (high_price - low_price)` | 일봉 캔들 |
| 4시간봉 종가 위치 | `(trade_price - low_price) / (high_price - low_price)` | 4시간봉 캔들 |
| 일봉 20일 평균 거래대금 | 최근 20개 확정 일봉 `candle_acc_trade_price` 평균 | 일봉 캔들 |
| 일봉 5일 평균 거래대금 | 최근 5개 확정 일봉 `candle_acc_trade_price` 평균 | 일봉 캔들 |
| 4시간봉 평균 거래대금 | 최근 N개 확정 4시간봉 `candle_acc_trade_price` 평균 | 4시간봉 캔들 |
| N/ATR | `TR = max(high-low, abs(high-prev_close), abs(low-prev_close))`, `N = (19 * previous_N + TR) / 20` | 일봉 캔들 |
| 총자본 | `KRW 잔고 + BTC 보유 수량 * 현재가` | 계정 잔고 + 실시간 현재가 |
| 포지션 평가금 | `BTC 보유 수량 * 현재가` | 계정 잔고 + 실시간 현재가 |
| 실시간 수익률 | 봇 자체 레이어 평단/수량 기준 평가손익률 | 봇 로그 + 실시간 현재가 |

> 운영상 실시간 가격 감시는 WebSocket `ticker`를 기본으로 사용하고, 일봉/4시간봉 확정값은 REST 캔들 조회로 검증한다. 4시간봉 WebSocket은 선택 사항이며, 조기 진입도 진행 중 캔들이 아니라 **확정된 4시간봉**을 기준으로 판단한다.

---

## 4. 인증 및 사용자 정책 (미결 #7 확정)

### 4.1. 결정: 단일 사용자(본인 전용) 우선, 다중 사용자 확장 가능 구조

| 항목 | MVP (단일 사용자) | 확장 (다중 사용자) |
|:--|:--|:--|
| 대시보드 인증 | Supabase Auth (이메일 매직링크 1계정) | 동일 (계정별 격리) |
| 데이터 격리 | `user_id` 컬럼 + RLS (이미 적용) | 그대로 사용 |
| 봇 ↔ DB 적재 | Supabase **service_role 키** (서버 전용, RLS 우회) | 봇 인스턴스별 `user_id` 매핑 |
| 업비트 API 키 | VPS 환경변수(`.env`)에만 보관, 절대 DB/프론트 노출 금지 | 사용자별 키 vault 필요 |

> **보안 핵심:** 스키마에 `user_id`와 RLS를 처음부터 넣어두면, 단일 사용자로 시작해도 다중 사용자 전환 시 스키마 변경이 없다. (확장 비용 최소화)

### 4.2. 시크릿 관리

```
- 업비트 ACCESS/SECRET 키: VPS .env (chmod 600), 코드/Git/DB 절대 미포함
- Supabase service_role 키: 봇 VPS .env 전용 (프론트엔드 번들 금지)
- Supabase anon 키: 대시보드 프론트엔드용 (RLS로 보호되므로 노출 허용)
- .gitignore에 .env, *.key 포함 확인
```

---

## 5. 예외 처리 및 안정성 (미결 #5 확정)

### 5.1. API 호출 정책

| 위험 | 대응 |
|:--|:--|
| Rate Limit (429) | 지수 백오프 재시도(0.5s→1s→2s→4s, 최대 5회), 초당 호출 수 자체 제한(throttle) |
| 네트워크 단절/타임아웃 | 타임아웃 10s, 재시도 후 실패 시 해당 루프 skip(다음 1초 루프에서 복구) |
| 5xx 서버 오류 | 백오프 재시도, 지속 실패 시 알림 발송 |
| 주문 거부(잔고부족/최소금액) | `try/except`로 흡수, 청산 시 dust면 조용히 종료(§5.4) |

### 5.2. 주문 멱등성 (중복 주문 방지)

```
- 매 주문에 request_id(UUID) 생성 → 로그/DB에 unique 제약(uq_trades_request)
- 봇 재시작(PM2 restart) 직후: bot_state.json + 업비트 미체결 주문 조회로
  "마지막 의도한 주문이 실제 체결됐는지" reconciliation(정합성 복구) 수행
- 같은 차수를 두 번 사지 않도록 layers에 idx 기록 후 중복 체크
```

### 5.3. 두 봇 동시성 (09:05 충돌 최소화)

```
- 매수 동작은 GRID/FARMING 상태에서만 (Plan §5.5 확정)
- 청산은 HOLDING에서만 → 청산 중 매수 끼어들기 구조적 불가
- bot_state.json은 atomic write(os.replace)로 부분 읽기 방지
- trailing_stop_bot은 09:05~09:06 구간 동안 state read 후 변경 감지 시
  최신값 재로딩 (N_value, phase 갱신 반영)
```

### 5.4. dust 자투리 정리 정책 (미결 #3 확정)

```
- 청산(전량 시장가) 후 10,000원 미만 자투리는 "포지션 없음"으로 간주 → 사이클 진행
- 정리 방법(선택): 다음 사이클 첫 그리드 매수 직전, 보유 BTC가 dust로 존재하면
  매도 가능 최소수량 조건 충족 시 합산 매도 시도(실패 시 무시)
- 누적 dust는 손실이 아니므로 주기적 수동 정리도 허용 (운영 가이드에 명시)
```

---

## 6. 핵심 로직 의사코드 (구현 가이드)

### 6.1. trailing_stop_bot (24h 루프)

```python
while True:
    state = state_store.read()                      # atomic read
    price = upbit.get_price("KRW-BTC")               # with retry
    acc = Account.from_state(state, price)

    if state.phase in ("HOLDING", "COOLDOWN"):
        if state.phase == "COOLDOWN" and now() >= state.cooldown_until:
            reenter_grid(acc, price)                 # 자본 재스캔 → 0차=현재가
        else:
            check_exit_2N(acc, price, state)         # 매도만 감시
    elif state.phase in ("GRID", "FARMING"):
        try_grid_buy_price_watch(acc, price, state)  # GRID 단계에서만 매수/재매수 허용
        try_farmer_early_entry_4h(acc, price, state) # 농부 1~2차 부분 조기 진입만
        try_grid_layer_sell(acc, price, state)       # GRID/FARMING 모두 매도 가능
        check_exit_2N(acc, price, state)             # 진입 후에도 최고가 갱신/감시

    time.sleep(1)


def check_exit_2N(acc, price, state):
    update_highest(state, price)
    if acc.expected_net_pnl(price) <= 0:             # 수수료/슬리피지 반영 순손익 게이트
        return
    if price < state.highest_price - 2 * state.N_value:
        if acc.position_value(price) < 10000:        # dust → 조용히 종료
            return
        try:
            upbit.market_sell_farmer_position(request_id=uuid4())
            finalize_exit(state, reason="2N_TRAIL")
        except OrderRejected:
            return                                   # 동시청산 충돌 흡수
```

### 6.2. ma5_trend_bot (09:05 1회)

```python
def main():
    candles = upbit.get_daily_candles("KRW-BTC", count=21)   # 직전 20일+α
    N = compute_atr_wilder(candles)                          # 터틀 N
    ma5_today, ma5_yesterday = compute_ma5(candles)
    last_close = candles[-1].close
    close_position = (candles[-1].close - candles[-1].low) / (candles[-1].high - candles[-1].low)
    amount_20_ok = candles[-1].acc_trade_price >= avg20_amount(candles) * 1.5
    amount_5_ok = candles[-1].acc_trade_price >= avg5_amount(candles) * 1.2
    capitulation = (candles[-1].acc_trade_price >= avg20_amount(candles) * 3.5) and close_position < 0.6

    state = state_store.read()
    state.N_value, state.N_updated_at = N, now()

    price = upbit.get_price("KRW-BTC")
    acc = Account.from_state(state, price)

    # ── 청산(조건②): HOLDING + 실시간 수익률>0 + 전날종가<MA5 ──
    if state.phase == "HOLDING" and acc.expected_net_pnl(price) > 0 and last_close < ma5_today:
        if acc.position_value(price) >= 10000:
            try:
                upbit.market_sell_farmer_position(request_id=uuid4())
                finalize_exit(state, reason="MA5_EXIT")
            except OrderRejected:
                pass
        state_store.write_atomic(state); return

    # ── 농부 확정 매수: FARMING + 09:05 필터 AND + 가격 -15% 도달 ──
    filters_ok = (
        (last_close > ma5_today)
        and (ma5_today >= ma5_yesterday)
        and amount_20_ok
        and amount_5_ok
        and (close_position >= 0.6)
        and (not capitulation)
    )
    if state.phase == "FARMING" and filters_ok and farmer_price_reached(state, price):
        invest = remaining_farmer_confirm_amount(acc, state, price)
        invest = min(invest, acc.cash)               # 현금 캡
        upbit.market_buy(invest, request_id=uuid4())
        advance_farmer_stage(state, price)

    state_store.write_atomic(state)
```

---

## 7. Design 단계에서 확정된 사항 요약

| 미결# | 항목 | 확정 |
|:--:|:--|:--|
| 3 | dust 정리 | 다음 사이클 첫 매수 전 합산 매도 시도(실패 무시) + 수동 정리 허용 (§5.4) |
| 5 | API 예외 | 지수 백오프 재시도 + 멱등성(request_id) + 재시작 reconciliation (§5.1~5.2) |
| 6 | Supabase 스키마 | trades / cycles / bot_snapshots 3테이블 + 인덱스 + RLS (§3.3) |
| 7 | 인증/사용자 | 단일 사용자 우선 + `user_id`/RLS로 다중 확장 대비, service_role 분리 (§4) |
| R1 | 레이어 분리 청산 | 그리드 물량은 그리드 방식으로 매도, 농부 물량은 2N/MA5 방식으로 매도 (§2.2) |
| R2 | 그리드 재매수 | GRID 단계에서는 허용, FARMING/HOLDING 단계에서는 금지 (§2.2) |
| R3 | 농부 매수 필터 | KRW 거래대금 + 종가 위치 + 과열 투매 예외 조건 적용 (§2.2) |
| R4 | 부분 조기 진입 | 농부 1~2차만 4시간봉 기준 일부 조기 진입, 농부 3차는 금지 (§2.2) |

---

## 8. 구현 로드맵 (단계별 보완 방식)

본 시스템은 한 번에 전체 자동매매로 구현하지 않는다. **그리드 MVP → 대시보드 → 농부매수 → 터틀매도 → 4시간봉 조기 진입** 순서로 기능을 단계적으로 활성화한다.

| 단계 | 구현 대상 | 실거래 상태 | 목표 |
|:--:|:--|:--|:--|
| 1 | 프로젝트 골격/설정/모델 | 주문 없음 | `config`, `models`, `bot_state`, 기능 플래그 구조 확정 |
| 2 | 업비트 데이터 수집 모듈 | 주문 없음 | WebSocket `ticker`, `orderbook`, 일봉, 4시간봉, 잔고, 주문 가능 정보 수집 |
| 3 | Node.js + Supabase 대시보드 MVP | 주문 없음 | 봇 상태, 현재가, 그리드 차수, 잔고, 로그, `snapshot` 표시 |
| 4 | 그리드 Paper Trading | 주문 없음 | 20차 그리드 매수/매도/재매수 신호와 상태 전이를 검증 |
| 5 | 그리드 소액 실거래 | 그리드만 ON | AWS Linux에서 24시간 그리드 매수/매도, GRID 단계 재매수, 로그 정합성 검증 |
| 6 | 농부매수 신호봇 | 주문 없음 | -15% 가격 도달, 09:05 확정 필터, KRW 거래대금/종가 위치 조건을 신호로만 기록 |
| 7 | 터틀매도 신호봇 | 주문 없음 | 농부 물량 기준 2N/MA5 청산 조건과 순손익 게이트를 신호로만 기록 |
| 8 | 농부매수 + 터틀매도 소액 실거래 | 농부/터틀 소액 ON | 농부 물량을 매수하는 순간 터틀 청산도 함께 준비된 상태로 검증 |
| 9 | 4시간봉 부분 조기 진입 | 제한 ON | 농부 1~2차 조기 진입 비율과 09:05 확정 진입 잔여 집행 검증 |
| 10 | 운영 자동화/알림/백업 | 단계별 확대 | PM2/systemd, 로그 로테이션, 장애 알림, Supabase 백업, 대시보드 제어 안정화 |

### 8.1. 기능 플래그 기본값

실거래 주문은 마지막에 켠다. 초기 기본값은 모두 `false`다.

```text
ENABLE_REAL_ORDERS=false
ENABLE_GRID_BUY=false
ENABLE_GRID_SELL=false
ENABLE_FARMER_CONFIRMED_BUY=false
ENABLE_FARMER_EARLY_ENTRY=false
ENABLE_TURTLE_EXIT=false
ENABLE_DASHBOARD_COMMANDS=false
```

### 8.2. 전략별 역할 구분

| 전략 | 구현 역할 |
|:--|:--|
| 그리드 매매 | 24시간 매수/매도/GRID 단계 재매수. AWS 서버와 대시보드 MVP의 첫 검증 대상 |
| 농부매매 | 그리드 20차 이후 깊은 하락 구간에서 추가 매수. 실거래 전 반드시 신호 검증 |
| 터틀매매 | 농부 물량의 청산 엔진. 농부 실매수를 켜기 전에 최소 신호봇으로 준비 |

### 8.3. 코드 폴더 구조 계획

그리드 MVP는 Node.js/TypeScript + Supabase + AWS Linux 운영을 기준으로 한다. 실제 매매전략은 봇 앱 내부의 전략별 폴더에 둔다.

본 대시보드는 여러 독립 전략을 한 계좌에서 동시에 운영하는 공통 멀티전략 대시보드가 아니다. **BTC Grid-Farmer-Turtle Hybrid 전략 전용 대시보드**로 구현한다. 향후 이평선 골든크로스 등 다른 전략을 구현할 경우에는 이 구조를 참고하되, 별도 프로젝트/별도 대시보드로 분리한다.

```text
새 전략 프로젝트
├─ 해당 전략 전용 봇
├─ 해당 전략 전용 대시보드
└─ 필요하면 공통 컴포넌트만 복사/재사용
```

```text
upbit_grid_farmer/
├─ apps/
│  ├─ grid-bot/
│  │  ├─ src/
│  │  │  ├─ main.ts
│  │  │  ├─ config.ts
│  │  │  ├─ upbit/
│  │  │  │  ├─ upbit-client.ts
│  │  │  │  ├─ ticker-ws.ts
│  │  │  │  ├─ orderbook-ws.ts
│  │  │  │  └─ rate-limiter.ts
│  │  │  ├─ grid/
│  │  │  │  ├─ grid-engine.ts
│  │  │  │  ├─ grid-levels.ts
│  │  │  │  └─ grid-state-machine.ts
│  │  │  ├─ orders/
│  │  │  │  ├─ order-executor.ts
│  │  │  │  ├─ paper-executor.ts
│  │  │  │  └─ reconciliation.ts
│  │  │  ├─ storage/
│  │  │  │  ├─ supabase-store.ts
│  │  │  │  ├─ local-state-store.ts
│  │  │  │  └─ logger.ts
│  │  │  └─ control/
│  │  │     ├─ command-poller.ts
│  │  │     └─ safety-switch.ts
│  │  ├─ package.json
│  │  └─ tsconfig.json
│  │
│  └─ dashboard/
│     ├─ app/
│     │  ├─ page.tsx
│     │  ├─ grid/page.tsx
│     │  ├─ trades/page.tsx
│     │  └─ settings/page.tsx
│     ├─ components/
│     │  ├─ BotStatusPanel.tsx
│     │  ├─ GridTable.tsx
│     │  ├─ BalancePanel.tsx
│     │  ├─ TradeLogTable.tsx
│     │  └─ ControlPanel.tsx
│     ├─ lib/
│     │  ├─ supabase.ts
│     │  └─ format.ts
│     ├─ package.json
│     └─ tsconfig.json
│
├─ packages/
│  └─ shared/
│     ├─ src/
│     │  ├─ types.ts
│     │  ├─ constants.ts
│     │  ├─ money.ts
│     │  └─ grid-math.ts
│     ├─ package.json
│     └─ tsconfig.json
│
├─ supabase/
│  ├─ migrations/
│  │  ├─ 001_create_grid_tables.sql
│  │  └─ 002_create_control_tables.sql
│  └─ seed/
│     └─ local_seed.sql
│
├─ scripts/
│  ├─ deploy-grid-bot.sh
│  ├─ start-grid-bot.sh
│  └─ backup-state.sh
│
├─ config/
│  ├─ grid.example.json
│  └─ pm2.ecosystem.config.js
│
├─ docs/
├─ archive/
├─ .env.example
├─ package.json
├─ tsconfig.base.json
└─ README.md
```

#### 전략 코드 위치

| 전략 | 폴더 | 핵심 파일 | 역할 |
|:--|:--|:--|:--|
| 그리드 매매 | `apps/grid-bot/src/grid/` | `grid-engine.ts` | 현재가 기준 그리드 매수/매도/GRID 단계 재매수 판단 |
| 그리드 가격 생성 | `apps/grid-bot/src/grid/` | `grid-levels.ts` | 기준가 기준 -1% 간격 20차 가격 생성 |
| 상태 전이 | `apps/grid-bot/src/grid/` | `grid-state-machine.ts` | `GRID`, `FARMING`, `HOLDING`, `COOLDOWN` 전환 규칙 |
| 주문 실행 | `apps/grid-bot/src/orders/` | `order-executor.ts` | 실거래 주문 생성, 주문 UUID 저장 |
| 페이퍼 주문 | `apps/grid-bot/src/orders/` | `paper-executor.ts` | 주문 없는 가상 체결 기록 |
| 재시작 복구 | `apps/grid-bot/src/orders/` | `reconciliation.ts` | 미체결 주문/잔고/상태 파일 정합성 복구 |
| 업비트 수집 | `apps/grid-bot/src/upbit/` | `upbit-client.ts`, `ticker-ws.ts` | 현재가, 호가, 캔들, 잔고, 주문 가능 정보 수집 |
| 상태/로그 저장 | `apps/grid-bot/src/storage/` | `supabase-store.ts`, `logger.ts` | Supabase snapshot, grid layer, trade log 기록 |
| 대시보드 제어 | `apps/grid-bot/src/control/` | `command-poller.ts`, `safety-switch.ts` | pause/resume/emergency_stop 명령 처리 |

#### 향후 전략 확장 위치

그리드 MVP가 안정화된 뒤에는 아래 폴더를 추가한다.

```text
apps/grid-bot/src/
├─ farmer/
│  ├─ farmer-engine.ts
│  ├─ farmer-filters.ts
│  └─ farmer-sizing.ts
│
└─ turtle/
   ├─ turtle-exit-engine.ts
   ├─ atr.ts
   └─ trailing-stop.ts
```

| 전략 | 폴더 | 핵심 파일 | 역할 |
|:--|:--|:--|:--|
| 농부매수 | `apps/grid-bot/src/farmer/` | `farmer-engine.ts` | -15% 가격 도달, 09:05 확정 매수, 4시간봉 부분 조기 진입 판단 |
| 농부 필터 | `apps/grid-bot/src/farmer/` | `farmer-filters.ts` | KRW 거래대금, 종가 위치, 과열 투매 예외 계산 |
| 농부 자금 | `apps/grid-bot/src/farmer/` | `farmer-sizing.ts` | 평가금만큼 추가 투입, 현금 cap 계산 |
| 터틀매도 | `apps/grid-bot/src/turtle/` | `turtle-exit-engine.ts` | 농부 물량 2N/MA5 청산 판단 |
| ATR/N 계산 | `apps/grid-bot/src/turtle/` | `atr.ts` | 일봉 기반 N 계산 |
| 트레일링 | `apps/grid-bot/src/turtle/` | `trailing-stop.ts` | 최고가 갱신과 2N 이탈 판단 |

#### Supabase MVP 테이블

| 테이블 | 목적 |
|:--|:--|
| `bot_snapshots` | 대시보드 현재 상태 요약. 같은 `bot_id` 행을 upsert |
| `grid_layers` | 1~20차 그리드 가격, 상태, 수량, 주문 UUID |
| `trades` | 실제 체결 로그 |
| `signals` | paper trading 또는 조건 발생 신호 |
| `control_commands` | 대시보드 pause/resume/emergency_stop 명령 |
| `strategy_settings` | 그리드 비율, 차수, 기능 플래그 등 전략 설정 |

### 8.4. 단계 통과 기준

| 단계 | 통과 기준 |
|:--|:--|
| 그리드 MVP | 7일 이상 WebSocket/상태 저장/대시보드가 안정 동작 |
| 그리드 소액 실거래 | 매수·매도·재매수·수수료·레이어 상태가 로그와 잔고 기준으로 일치 |
| 농부 신호봇 | 09:05 필터와 -15% 조건이 기대대로 기록되고 오탐 빈도가 확인됨 |
| 터틀 신호봇 | 2N/MA5 청산 조건과 예상 순손익 게이트가 로그상 일관되게 계산됨 |
| 농부/터틀 소액 실거래 | 농부 매수와 터틀 청산이 같은 레이어 기준으로 추적되고 중복 주문이 없음 |

---

## 9. 미해결 / Do 단계 이관

| # | 항목 | 비고 |
|:--|:--|:--|
| D1 | 백테스트 엔진 구현 (2018/2022 폭락장 검증) | Plan §9 검증계획 |
| D2 | 자금 시뮬레이션 코드 (15.8% 닫힘 수치 검증) | Plan §9 |
| D3 | XLSX 생성 라이브러리 선정 (openpyxl 등) 및 포맷 | Do 단계 |
| D4 | PM2 ecosystem 설정 / crontab 등록 스크립트 | Do 단계 |
| D5 | 알림 채널(텔레그램/이메일) 선정 | Do 단계 |
| D6 | 통합 청산 vs 레이어 분리 청산 백테스트 | Review Report 병합 결정 검증 |
| D7 | 농부 부분 조기 진입 백테스트 | 1차 30~40%, 2차 20~30% 비율 검증 |
| D8 | 업비트 WebSocket/REST 수집 모듈 구현 | ticker, orderbook, days, minutes/240, accounts, orders |

---

## 10. 다음 단계

→ **Do 단계 1순위**: 24시간 BTC 그리드매매 봇 MVP + Node.js/Supabase 대시보드 구현
→ **Do 단계 2순위**: 농부매수 신호봇과 터틀매도 신호봇 추가
→ **Do 단계 3순위**: 농부매수 + 터틀매도 소액 실거래, 이후 4시간봉 부분 조기 진입 검증
