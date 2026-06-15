# [개정 확정본 v3] 비트코인 하이브리드 알고리즘 매매 시스템 설계 명세서

## 0. 현재 코드 반영 현황 (2026-06-15)

### 0.1. 최신 반영 사항 (2026-06-15 추가)

현재 구현 기준의 농부 매수와 터틀 매도는 아래 기준을 따른다.

```text
Farmer buy:
  - 그리드 전체 레이어가 OPEN이어도 phase는 GRID로 유지
  - 농부 1차 전에는 GRID 상태에서 농부 1차 신호만 별도 감시
  - 농부 1차 매수가 실제 체결되는 순간 FARMING으로 전환
  - Last Buy Price = 농부 1차 전에는 현재 보유 중인 가장 깊은 Grid 매수가,
                   농부 2차/3차 전에는 직전 Farmer 매수가
  - Next Farmer Entry = Last Buy Price * (1 - Farmer Entry Percent)
  - Bithumb 일봉은 KST 00:00 기준으로 새 일봉이 시작되므로, MA5/MA200/ATR(N)/거래대금/양봉 판정/N일 저가 기준선은 현재 KST 일봉을 제외한 확정 일봉으로 계산
  - 단, 전략상 실시간 발동이 필요한 가격 비교는 현재가를 사용
    예: 가격 도달, 현재가 > 확정 일봉 MA5/MA200, 3일 하락률, MA5 이탈, N일 저가 이탈, 2N trailing
  - 종가 기준 2일 연속 양봉 필터 추가
  - Farmer Stage 2/3 cooldown days와 Farmer Max 3D Drawdown은 Dashboard Strategy Adjustment에서 수정 가능
  - ENABLE_FARMER_CONFIRMED_BUY=true일 때 confirmed farmer buy를 실행하되,
    farmer buy executor는 PaperOrderExecutor로 고정
  - 따라서 farmer buy는 paper 매수로만 기록되며 실제 Bithumb 주문을 내지 않음

Recovery Turtle exit:
  - 통합 Recovery Position 예상 순손익 > 0 게이트 유지
  - 청산 트리거는 2N trail, MA5 exit, N-day low break 중 하나
  - MA5 exit = 현재가가 확정 일봉 MA5 아래로 이탈
  - N-day low break = 현재가가 확정 일봉 기준 최근 N일 최저가 아래로 이탈
  - Turtle Low Breakout Period는 Dashboard Strategy Adjustment에서 수정 가능

Dashboard Farmer Signal:
  - 1행: Last Farmer Signal / Farmer Defense / Farmer Stage
  - 2행: Current Price / Last Buy Price / Next Farmer Entry
  - 2일 연속 양봉 조건 통과 여부 표시
```

현재 코드 기준으로는 기존 문서의 "그리드 물량과 농부 물량을 완전히 분리 청산"하는 설계에서 한 단계 수정되어, **농부 매수 이후에는 그리드 미청산 물량과 농부 물량을 합친 통합 회복 포지션(Recovery Position)을 터틀 매도 기준으로 관리**합니다.

구현 완료:

```text
1. Recovery Position
   - OPEN 그리드 레이어 + 농부 매수 포지션을 하나의 회복 포지션으로 합산
   - 통합 수량, 통합 원가, 평균단가, 평가금, 미실현 손익 계산
   - FARMING 이후 그리드 개별 매도는 중단하고 통합 터틀 청산 대상으로 편입

2. Farmer Buy
   - GRID 상태에서 그리드 전체 레이어가 OPEN이면 농부 1차 신호 감시
   - 농부 1차 매수 체결 후 FARMING 상태에서 차수별 농부 매수 실행
   - 기본값은 FARMER_SIGNAL 기록, ENABLE_FARMER_CONFIRMED_BUY=true일 때만 실제 매수
   - MA200 장기 추세, MA5 추세, 거래대금, 종가 위치, 1일/2일 연속 양봉, 과열 투매, 3일 하락률, 변동성 폭발, 차수 쿨다운, 현금 방어력 필터 반영
   - 농부 목표 매수금은 진입 시점 통합 회복 포지션 평가금 기준
   - 현금 부족 시 cappedOrderKrw로 축소하고, 최소 주문금액 미만이면 보류

3. Recovery Turtle Exit
   - 통합 회복 포지션 예상 순손익 > 0일 때만 청산 신호 허용
   - 2N 트레일링 또는 MA5 이탈 조건을 RECOVERY_EXIT_SIGNAL로 기록
   - ENABLE_RECOVERY_TURTLE_SELL=false 기본값에서는 신호만 기록
   - ENABLE_RECOVERY_TURTLE_SELL=true일 때 Slice Order KRW / Slice Interval Seconds 기준으로 분할 시장가 청산
   - 첫 농부 매수 시 highestPrice를 농부 진입가 기준으로 리셋하여 과거 그리드 고점으로 인한 과도한 조기 청산 방지

4. Dashboard
   - Recovery Position 섹션 추가
   - Last Farmer Signal, Turtle Exit, Profit Gate, 2N Stop, Expected Net PnL 표시
   - Strategy Setting 아래 투자금 미리보기(Grid Total, Farmer Stage 1~3, Total Investment, Grid / Farmer) 표시
   - Strategy Adjustment에서 Farmer Stage 2/3 Cooldown Days, Farmer Max 3D Drawdown, 2일 연속 양봉 필터, Recovery Turtle Sell, Turtle N Period, Turtle Low Breakout Period, Trailing N Multiplier, Turtle Min Order KRW, Slice Order KRW, Slice Interval Seconds, Partial Take Profit, TP1/TP2 설정 저장 가능
```

아직 다음 단계로 남은 항목:

```text
- 실시간 orderbook 기반 슬리피지 사전 계산 및 지정가 우선 청산
- 4시간봉 조기 진입 실행 로직
- 텔레그램에 농부/터틀 세부 신호 알림 확장
```

따라서 아래 기존 설계 중 "농부 레이어 단독 청산" 표현은 최신 코드 기준에서는 **통합 회복 포지션 청산**으로 해석합니다.
**- 부제: 동적 자산 배분 엔진과 Bithumb KST 00시 확정 일봉·현재가 트리거 기반의 통합 회복 포지션 청산 시스템 -**

> 📌 **개정 이력:** 자금 검증 결과 그리드 비율을 17.2% → **15.8%**로 하향(농부 3차까지 자금 닫힘 보장), 농부 3차 베팅 규칙을 "올인" → **"당시 평가금 2배(평가금만큼 추가 투입)"**로 통일, 매도 게이트를 **순손익/계좌 손익 기준**으로 보강, **무손절 추세추종 원칙** 명문화, 사이클 상태머신·5분 쿨다운·dust 처리·기간별 엑셀/대시보드 반영. v3에서는 **레이어 분리 청산**, **GRID 단계 그리드 재매수 허용 / FARMING 이후 재매수 금지**, **농부 KRW 거래대금 필터**, **농부 1~2차 4시간봉 부분 조기 진입**을 반영했습니다. v4 보완안에서는 농부 매수의 구조적 하락장 방어를 위해 **MA200 장기 추세 필터**, **하락 속도/변동성 폭발 필터**, **차수 간 쿨다운**, **잔여 현금 방어력 등급**, **거래대금 절대 하한**을 추가하고, 터틀 매도는 **농부 레이어 손익 게이트**, **실시간 호가 깊이 기반 분할 청산**, **대시보드 조정식 부분 익절 옵션**으로 보강합니다. (상세 설계: `docs/02-design/features/grid_farmer_bot_design.md`)

---

## 1. 개요 및 배경
본 시스템은 비트코인(BTC) 시장의 극심한 변동성과 유동성 리스크를 수학적으로 통제하기 위해 설계된 알고리즘 트레이딩 시스템입니다.

기존 고정형 자금 관리의 한계를 극복하고, **[현재 계좌 잔고 기반의 역산 동적 자산 배분]** 알고리즘을 채택하여 중간에 시드가 입출금되더라도 자금 배분을 자동 재조정합니다. 평시에는 20차수 그리드로 변동성을 수확하고, 대폭락 시에는 -15% 완화 버퍼를 가진 농부매매 레이어로 방어합니다. 농부 1차 매수 전에는 그리드 물량을 기존 그리드 방식으로 매도하고, 농부 매수 이후에는 OPEN 그리드 물량과 농부 물량을 합친 **통합 회복 포지션(Recovery Position)** 을 터틀 2N 이탈, MA5 하회, N일 저가 이탈, 부분 익절 기준으로 추세 청산합니다.

본 시스템은 의도적으로 **손절매를 두지 않는 무손절 추세추종 전략**입니다(§8 리스크 고지 참조).

---

## 2. 자본금 및 운용 차수별 동적 그리드 매입금 산정표

본 시스템은 고정된 금액으로 주문을 넣지 않고, 매 사이클 시작 시 **[현재 총 자본금 (보유 코인 가치 + 예수금)]**을 실시간 역산하여 그리드 매입금을 동적으로 결정합니다.

### 2.1. 그리드 비율 확정 (15.8%)

농부 3차(평가금 2배)까지 자금 부족 없이 닫히도록 그리드 총액 비율을 **시드의 15.8%**로 확정합니다. (안전마진 5% 포함)

```
농부 3차까지 총 투입 ≈ 그리드 비율 × 6.008 (복리 증폭 계수)
- 17.2% × 6.008 = 103.3%  → ❌ 자금 고갈 3.3% 초과 (기존 명세 오류)
- 16.64% × 6.008 = 100%   → ⚠️ 한계 (마진 0)
- 15.8%  × 6.008 = 94.9%  → ✅ 안전마진 5% 확보 (채택)
```

$$\text{동적 그리드 1회 매입금} = \frac{\text{현재 총 자본금} \times 0.158}{\text{그리드 운용 차수(20)}}$$

### 2.2. 자본 규모별 매입금 산정표 (15.8% 기준, 20차수 운용, 간격 -1%)

| 현재 총 자본금 | 그리드 총액 (15.8%) | **1회 매입금 (20차)** |
| :---: | :---: | :---: |
| **1,000만 원** | 158만 원 | 📌 **79,000원** |
| **2,000만 원** | 316만 원 | 📌 **158,000원** |
| **3,000만 원** | 474만 원 | 📌 **237,000원** |
| **4,000만 원** | 632만 원 | 📌 **316,000원** |
| **5,000만 원** | 790만 원 | 📌 **395,000원** |

> 💡 **동적 제어 메커니즘:** 사용자가 중간에 시드를 증액하거나 일부 출금하더라도, 봇이 매 사이클(0차) 진입 전 계좌 잔고를 API로 실시간 스캔하여 위 비율대로 1회당 주문 금액을 자동 리사이징(Resizing)합니다.
> - **그리드 중 입출금:** 이미 체결된 차수는 불변, 남은 차수만 새 자본 기준으로 재산정.
> - **농부 중 입출금:** 베팅이 평가금에 종속되므로 자동 반영되며, 현금 한도(고갈 여부)에만 영향. 사이클 진행 중 출금은 자제 권고(농부 방어력 하락 경고 표시).
>
> 본 시스템은 평시 수익률이 가장 우수한 **[20차수 운용]**을 표준 스펙으로 합니다.

---

## 3. 핵심 실전 전개 시나리오 (20차수 기준)

### 3.1. 그리드 단계 (Grid Phase)
* 최초 진입가 대비 **-1% 간격**으로 20분할 매수 진행.
* 최초가 대비 **-19% 지점**에 도달하여 20차가 모두 체결되면 그리드 엔진 가동 중단(Lock).
* 계좌 상태: 누적 원금 15.8% 소진. (그리드 매수분 평가손실은 약 -10% 수준이나, 현금이 대부분 남아있어 계좌 전체 수익률은 그보다 훨씬 작음 — 수익률은 항상 실시간 재계산.)
* **혁신 타점:** 그리드 종료 즉시 대기 시간 없이 **농부 1차 감시 엔진 활성화**.

### 3.2. 다회차 농부매매 단계 및 -15% 완화 버퍼 (Farmer Phase)
어설픈 장중 노이즈에 자금이 조기 소진되는 것을 방지하기 위해, Bithumb KST 00시에 새 일봉이 시작된 뒤 현재 KST 일봉을 제외한 **확정 일봉 데이터**를 기준선 계산에 사용합니다. 다만 가격 도달과 추세 이탈처럼 전략상 실시간 판단이 필요한 조건은 **현재가**를 사용합니다.

#### A. 농부 확정 매수 필터 (확정 일봉 기준선 + 현재가 트리거, AND 결합)
현재 KST 일봉을 제외한 확정 일봉 지표와 실시간 현재가 조건이 모두 만족(`AND`)될 때만 농부 확정 자금을 집행합니다.

```text
농부 확정 매수 필터 =
직전 기준가 대비 -15% 이하 가격 조건 도달
AND 직전 농부 차수 체결 후 최소 쿨다운 경과
AND 현재가 기준 최근 3일 기준가 대비 하락률 > -25%
AND 전날 TR <= N × 2
AND 장기 추세 필터 통과
AND 현재가 > 확정 일봉 MA5
AND MA5_today >= MA5_yesterday
AND 최근 2개 확정 일봉이 모두 양봉
AND 전날 KRW 거래대금 >= 20일 평균 거래대금 × 1.5
AND 전날 KRW 거래대금 >= 5일 평균 거래대금 × 1.2
AND 전날 KRW 거래대금 >= 농부 거래대금 절대 하한
AND 종가 위치 >= 0.6
AND 과열 투매 예외 조건 아님
AND 잔여 현금 방어력 검증 통과
```

```text
종가 위치 = (전날 종가 - 전날 저가) / (전날 고가 - 전날 저가)
```

과열 투매 예외 조건은 다음과 같습니다.

```text
전날 KRW 거래대금 >= 20일 평균 거래대금 × 3.5
AND 종가 위치 < 0.6
```

이 예외 조건에 걸리면 거래대금이 충분하더라도 농부 매수를 보류합니다. 이는 거래가 크게 터졌지만 종가가 캔들 상단에 안착하지 못한 투매성 변동성 폭발을 피하기 위한 장치입니다.

> **농부 매수 체결 구조:** 농부 매수 **가격 도달 감시는 24시간** 수행하되, 지표 기준선은 Bithumb KST 00시 기준 확정 일봉으로 계산하고, 가격 비교가 필요한 트리거는 현재가로 판단합니다. 단, v3 설계안의 농부 1~2차 4시간봉 기준 **부분 조기 진입**은 아직 별도 구현 대상입니다.

#### A-1. 농부 매수 안전 필터 보완 (v4)

기존 필터는 "확정 캔들의 품질"을 잘 평가하지만, 무손절 물타기 전략에서 가장 위험한 **구조적 하락장**과 **자유낙하 구간**을 충분히 차단하지 못합니다. 따라서 농부 매수는 확정 일봉 기준선과 현재가 트리거를 함께 쓰는 아래 안전 필터를 추가합니다.

```text
장기 추세 필터 =
현재가 > 확정 일봉 MA200
OR MA200 기울기 >= 0
```

운영 모드는 두 가지를 둡니다.

```text
strict  = 현재가 > 확정 일봉 MA200 필수
relaxed = MA200 기울기 >= 0 이면 허용
```

초기 구현은 실매수 없이 신호만 기록하면서 `strict_ma200_ok`, `relaxed_ma200_ok`를 모두 로그에 남깁니다. 2018/2022 폭락장 백테스트 후 실거래 기본 모드를 확정합니다.

```text
하락 속도 필터 =
최근 3일 누적 하락률 > -25%
AND 전날 TR <= N × 2
```

```text
종가 기준 2일 연속 양봉 필터 =
직전 확정 일봉 종가 > 직전 확정 일봉 시가
AND 그 전 확정 일봉 종가 > 그 전 확정 일봉 시가
```

이 필터는 V자 반등의 최소한의 종가 확인을 추가하기 위한 장치입니다. 현재 구현에서는 `FARMER_USE_TWO_BULLISH_DAILY_FILTER=true` / `BACKTEST_USE_TWO_BULLISH_DAILY_FILTER=true`가 기본값이며, 대시보드 Strategy Adjustment와 백테스트 리포트에서 켜고 끌 수 있습니다.

최근 3일 누적 하락률이 -25% 이하이거나, 전날 일봉 변동폭이 N의 2배를 초과하면 자유낙하 또는 변동성 폭발 구간으로 보고 농부 진입을 보류합니다.

```text
차수 쿨다운 =
농부 1차: 그리드 20차 완료 후 즉시 감시 가능
농부 2차: 1차 체결 후 최소 3일 경과
농부 3차: 2차 체결 후 최소 5일 경과
```

가격 버퍼(-15%)는 공간 버퍼이고, 차수 쿨다운은 시간 버퍼입니다. 하루 급락장에서 농부 1·2·3차가 연속 체결되어 현금이 조기 소진되는 것을 막기 위해 사용합니다.

```text
거래대금 절대 하한 =
전날 KRW 거래대금 >= FARMER_MIN_DAILY_TURNOVER_KRW
```

평균 대비 배수 조건만 쓰면 전체 시장 유동성이 말라붙은 구간에서도 조건이 충족될 수 있습니다. 따라서 절대 거래대금 하한을 설정값으로 둡니다.

RSI(14)는 필수 조건이 아니라 보조 점수로만 기록합니다.

```text
RSI 보조 점수 =
RSI14 <= 35 이후 상승 전환이면 signal_quality_score + 1
```

#### B. 다회차 농부 레이어 가동 타점 (베팅 규칙 통일)
"평가금 2배"란 **진입 시점 보유 평가금만큼 추가 투입하여 포지션을 2배로 불리는 것**을 의미합니다(A안). 현금이 부족하면 **잔여 현금 전액으로 자동 캡(cap)**합니다.

* **농부 1차:** 20차 그리드 종료 즉시 감시 가동 ➔ 가격 조건과 확정 일봉 필터 충족 시 **당시 평가금만큼 추가 투입(포지션 2배)**.
* **농부 2차:** 1차 체결가 대비 **-15% 이하 구역** 진입 후 가격 조건과 확정 일봉 필터 충족 시 **당시 평가금만큼 추가 투입(포지션 2배)**.
* **농부 3차 (최종 방어선):** 2차 체결가 대비 **또다시 -15% 이하 구역** 진입(최초가 대비 약 -41.5% 폭락 지점) 후 가격 조건과 확정 일봉 필터 충족 시 **당시 평가금만큼 추가 투입(포지션 2배)**. (현금 부족 시 잔여 현금 전액으로 캡.)

> 🔢 위 규칙으로 농부 3차까지의 누적 투입은 **그리드 비율 × 약 6.008배**가 되며, 15.8% 기준 약 94.9%로 안전마진 5%를 남기고 닫힙니다.

#### B-1. 잔여 현금 방어력 등급

농부 매수 전에는 사용 가능 KRW와 남은 농부 차수의 목표 투입액을 비교하여 방어력 등급을 계산합니다. 이 등급은 기본적으로 **경고/축소 판단**이며, 농부 3차를 무조건 금지하는 조건은 아닙니다.

```text
농부 N차 목표 매수금 = 진입 시점 보유 BTC 평가금
실제 농부 N차 매수금 = min(목표 매수금, 사용 가능 KRW)
```

등급은 다음과 같이 표시합니다.

```text
3차까지 방어 가능:
  1~3차 목표 금액을 거의 모두 채울 현금이 있음
  → 정상 진행

2차까지만 가능:
  1~2차는 목표 금액 가능하지만 3차 목표 금액은 부족
  → 1~2차는 정상 진행
  → 3차는 남은 현금 cap 매수 가능
  → 대시보드/텔레그램 강한 경고

현금 부족:
  다음 농부 차수의 최소 주문금액 또는 설정된 최소 방어금도 부족
  → 실매수 보류 또는 수동 확인 필요
```

농부 3차는 최종 방어선이므로 기본값은 **남은 현금 cap 매수 허용**입니다. 단, 실제 주문금액이 최소 주문금액 미만이면 실행하지 않습니다.

```text
FARMER_ALLOW_FINAL_CAP_BUY=true
FARMER_MIN_ORDER_KRW=5000
FARMER_MIN_DEFENSE_CASH_AFTER_BUY_KRW=0
```

#### C. 부분 조기 진입 + 확정 일봉 진입
확정 일봉 필터는 안전하지만 V자 반등에는 늦을 수 있습니다. 따라서 설계안에서는 농부 1~2차에 한해 4시간봉 회복 신호를 이용한 부분 조기 진입을 허용합니다. 현재 코드에서는 4시간봉 조기 진입은 아직 별도 구현 대상입니다.

```text
농부 1차: 조기 진입 30~40% + 확정 일봉 진입 60~70%
농부 2차: 조기 진입 20~30% + 확정 일봉 진입 70~80%
농부 3차: 조기 진입 금지, 확정 일봉 조건만 허용
```

조기 진입 조건은 다음과 같습니다.

```text
-15% 가격 조건 도달
AND 직전 농부 차수 체결 후 최소 쿨다운 경과
AND 최근 3일 누적 하락률 > -25%
AND 전날 TR <= N × 2
AND 최근 확정 4시간봉 종가 > 4시간봉 단기 MA
AND 최근 확정 4시간봉 KRW 거래대금 >= 최근 N개 4시간봉 평균 거래대금 × 1.2
AND 4시간봉 종가 위치 >= 0.6
```

조기 진입 후 다음 확정 일봉 필터를 통과하지 못하면 잔여 농부 자금은 집행하지 않습니다. 농부 3차는 최종 방어선이므로 조기 진입을 금지하고 확정 조건만 허용합니다.

조기 진입분은 손절하지 않습니다. 다만 조기 진입 후 확정 일봉 필터가 실패하거나 하락 속도 필터가 악화되면 **잔여 조기/확정 매수분만 미집행**하고, 이미 체결된 조기 진입분은 농부 물량으로 추적합니다.

---

## 4. 레이어 분리 청산 + 농부 레이어 손익 게이트

> **현재 코드 반영:** 농부 1차 매수 전에는 phase를 `GRID`로 유지하고 기존 그리드 매도가 계속 동작합니다. 농부 매수 이후에는 그리드 미청산 물량과 농부 매수 물량을 분리해서 팔지 않고, 둘을 합친 **통합 회복 포지션(Recovery Position)** 을 터틀 매도 기준으로 청산합니다. `FARMING` 이후에는 그리드 개별 매도를 중단하고 OPEN 그리드 레이어가 Recovery Position에 포함됩니다. 따라서 이 장의 "농부 레이어 손익 게이트"는 최신 코드 기준에서 **통합 회복 포지션 예상 순손익 게이트**로 해석합니다.

v3 설계에서는 그리드 물량과 농부 물량의 역할을 분리하는 방식을 검토했지만, 현재 구현 기준에서는 농부 매수 이후 OPEN 그리드 물량과 농부 물량을 합친 **통합 회복 포지션**을 기준으로 청산합니다. v4부터 청산 게이트는 계좌 전체 손익이 아니라 **통합 회복 포지션 예상 순손익**을 기준으로 통일합니다.

```text
농부 1차 매수 전 그리드 물량: 반등 시 그리드 방식으로 분할 매도
농부 1차 매수 이후 OPEN 그리드 + 농부 물량: 통합 회복 포지션으로 묶어 2N/MA5/N일 저가/부분 익절 기준 청산
청산 게이트: 통합 회복 포지션의 체결 예상 순손익이 양수일 때만 청산
```

### 4.1. 그리드 물량 매도 원칙

* 그리드 물량은 각 레이어의 목표 반등 구간에서 그리드 방식으로 분할 매도합니다.
* `GRID` 단계에서는 팔린 그리드 레이어가 해당 매수가까지 다시 하락하면 **재매수할 수 있습니다**. 이는 순수 그리드 구간의 기본 수익 구조입니다.
* 그리드 20차가 모두 체결되어도 농부 1차 매수가 실제 체결되기 전까지는 `GRID` 단계를 유지합니다. 이 구간에서는 그리드 매도와 재매수가 계속 허용됩니다.
* 농부 1차 매수가 체결되어 `FARMING` 단계로 넘어간 뒤에는 팔린 그리드 물량을 **현금 회수 완료**로 봅니다.
* `FARMING` / `HOLDING` 상태에서 다시 하락하더라도 이미 팔린 그리드 물량은 **재매수하지 않습니다**.
* `FARMING` 이후 그리드 재순환 옵션은 백테스트에서 필요성이 확인될 때만 별도 기능으로 추가합니다.

### 4.2. 통합 회복 포지션 추세 청산 원칙

농부 1차 매수 이후에는 OPEN 그리드 물량과 농부 물량을 합친 통합 회복 포지션을 저점 방어와 추세 추종을 위한 포지션으로 보고, 아래 조건 중 하나가 발생할 때 청산합니다.

$$\text{통합 회복 포지션 청산 조건} = (\text{청산 대상 통합 회복 포지션 예상 순손익} > 0) \ \mathbf{AND} \ (\text{현재가} < \text{진입 후 최고가} - \text{trailing width} \ \mathbf{OR} \ \text{현재가} < \text{확정 일봉 MA5} \ \mathbf{OR} \ \text{현재가} < \text{확정 일봉 기준 최근 N일 저가})$$

* **청산 조건의 관계는 `OR`** — 먼저 감지한 쪽이 통합 회복 포지션 청산 신호를 만듭니다.
* **손익 게이트는 계좌 전체 손익이 아니라 청산 대상 통합 회복 포지션 자체 순손익 기준**으로 판단합니다.
* 농부 레이어 예상 순손익은 체결 직전 현재가 단순 계산이 아니라 **호가 깊이, 수수료, 예상 슬리피지**를 반영합니다.
* 그리드 물량의 평가손익과 계좌 전체 손익은 대시보드 참고/경고 정보로만 사용하며, 농부 청산 허용 여부에는 기본적으로 섞지 않습니다.
* 계좌 전체 손익까지 양수일 때만 청산하는 보수 모드는 선택 설정으로 둘 수 있지만, 기본값은 농부 레이어 독립 손익 기준입니다.

#### 4.2.1. 실시간 호가 깊이 기반 분할 청산

통합 회복 포지션은 농부 차수가 누적될수록 커질 수 있으므로, 터틀 청산은 전량 시장가 매도를 기본값으로 두지 않습니다. 청산 직전 WebSocket `orderbook`을 우선 사용하고, 필요 시 REST 호가 조회를 백업으로 사용하여 실시간 bid 호가 깊이를 확인합니다.

```text
예상 매도 체결가 =
매수 호가(bid)를 높은 가격부터 누적
농부 매도 수량이 모두 소화될 때까지
가격 × 수량을 합산해 평균 체결가 계산
```

```text
농부 레이어 예상 순손익 =
예상 매도금액
- 매도 수수료
- 예상 슬리피지 비용
- 청산 대상 통합 회복 포지션 원가
```

청산 실행은 아래 순서로 진행합니다.

```text
1. 청산 대상 농부 수량과 농부 원가만 계산
2. 최신 orderbook 확인
3. 예상 평균 체결가와 슬리피지 계산
4. 농부 레이어 예상 순손익 > 0 확인
5. 최대 허용 슬리피지 이하인지 확인
6. 분할 주문 금액 단위로 청산
7. 지정가/상단 지정가 우선, 미체결 잔량은 다음 분할 또는 시장가 처리
```

호가 데이터가 오래됐거나 WebSocket이 끊긴 경우에는 청산을 보류하고 `ORDERBOOK_STALE` 신호를 남깁니다. 사용자가 명시적으로 비상 청산을 실행한 경우에만 이 게이트를 우회할 수 있습니다.

#### 4.2.2. 부분 익절 옵션

부분 익절은 기본값을 끄고, 대시보드의 `Strategy Adjustment`에서 사용자가 켜고 조정할 수 있게 합니다. 부분 익절이 꺼져 있으면 1차/2차 익절 수익률과 매도 비율은 **저장된 기본값일 뿐 적용되지 않으며**, 화면에서도 비활성화합니다.

```text
부분 익절: 꺼짐
익절 단계: 사용 안 함
추세 추종 잔여 비율: 전체 물량
트레일링 N 배수: 2.0
최대 허용 슬리피지: 0.15%
분할 주문 금액: 1,000,000원
분할 주문 간격: 10초
```

부분 익절을 켰을 때만 아래 항목을 활성화합니다.

```text
부분 익절: 켜짐
1차 익절 수익률: 10%
1차 익절 매도 비율: 33%
2차 익절 수익률: 20%
2차 익절 매도 비율: 33%
추세 추종 잔여 비율: 남은 물량
```

부분 익절과 터틀 추세추종은 병행합니다.

```text
1차 익절 수익률 도달:
  통합 회복 포지션 중 설정 비율 매도
  단, 농부 레이어 예상 순손익 > 0이고 슬리피지 한도 통과 필요

2차 익절 수익률 도달:
  추가 설정 비율 매도

잔여 물량:
  highest_price를 갱신하며 trailing width 또는 MA5 이탈로 추적
```

부분 익절 후에는 남은 그리드/농부 수량과 원가를 비례 축소해 추적합니다.

```text
remainingFarmerCost =
기존 farmerCost × 남은 farmerQty / 기존 farmerQty
```

#### 4.2.3. 트레일링 폭과 MA5 감지 보완

기본 트레일링 폭은 `2N`입니다. 단, 변동성 급등으로 N이 커지면 수익 반납 폭이 과도해질 수 있으므로 대시보드 설정값으로 트레일링 N 배수를 조정할 수 있게 합니다.

```text
trailing width = N × TURTLE_TRAILING_N_MULTIPLIER
기본값 = 2.0
```

향후 백테스트 후 아래 옵션을 추가할 수 있습니다.

```text
수익률이 일정 이상이면:
  +10% 이상 → 1.75N
  +20% 이상 → 1.5N
```

MA5 청산은 확정 일봉으로 계산한 MA5 기준선을 사용하되, 실제 이탈 판단은 현재가로 수행합니다. Bithumb 일봉은 KST 00:00 기준으로 새 일봉이 시작되므로 현재 KST 일봉은 기준선 계산에서 제외합니다. 4시간봉 보조 이탈 신호는 아직 별도 구현 대상입니다.

```text
정식 청산:
  현재가 < 확정 일봉 MA5

보조 신호:
  최근 확정 4시간봉 종가 < 4시간봉 단기 MA
```

초기 구현에서는 4시간봉 보조 이탈을 즉시 청산이 아니라 `TURTLE_SIGNAL` 또는 트레일링 폭 타이트닝 후보로 기록합니다.

### 4.3. 중복 청산 방지

청산 직전 **보유 평가금이 10,000원 미만(dust)**이면 "이미 청산 완료"로 간주하고 조용히 종료합니다. 두 봇이 OR 조건으로 동시에 청산을 시도하더라도, 먼저 체결된 주문 이후 다른 봇은 잔고와 상태 파일을 보고 자동 종료합니다. 두 번째 매도 주문이 거부되면 `try/except`로 흡수합니다.

> ⚠️ **무손절 원칙 유지:** 조건①·② 중 하나가 떠도 농부 레이어 손익 게이트가 음수이면 청산하지 않고 홀딩합니다. v4에서는 수익률 판단을 단순 현재가 기준이 아니라 호가 깊이, 수수료, 슬리피지까지 반영한 농부 레이어 예상 순손익 기준으로 강화합니다.

---

## 5. 사이클 상태머신 · 재진입 · N값 운영

### 5.1. 사이클 상태머신

> **현재 코드 기준 보정:** 그리드 20차가 모두 OPEN이어도 농부 1차 매수가 실제 체결되기 전까지 phase는 `GRID`로 유지합니다. 이 구간에서는 기존 그리드 매도/재매수가 계속 동작하고, 농부 1차 신호만 별도로 감시합니다. `FARMING` 전환은 `FARMER_BUY`가 실제 기록되는 순간 발생합니다.

```
GRID → FARMING → HOLDING → (청산) → COOLDOWN(5분) → GRID(재진입) → ...
```
* **매수 동작은 `GRID` / `FARMING` 상태에서만 허용**됩니다. `HOLDING` / `COOLDOWN` 상태에서는 매수를 시도하지 않습니다.
* `GRID` 상태에서는 그리드 매수/매도/재매수를 허용합니다.
* `FARMING` 상태에서는 농부 가격 도달 감시와 농부 1~2차 부분 조기 진입만 허용합니다. 이미 매도된 그리드 레이어를 다시 채우는 재매수는 기본적으로 금지합니다.
* 이 상태머신 덕분에 "청산 도중 매수 끼어들기"가 구조적으로 발생하지 않으므로, 별도의 매수 일시정지 장치는 불필요합니다.

### 5.2. 청산 후 재진입 (5분 쿨다운 + 현재가 기준)
* 청산(2N 또는 MA5, 사유 무관) 후 **5분 쿨다운** 진입 → 5분 경과 시 **그 시점의 현재가를 새 그리드 0차(최초 진입가)**로 설정하여 그리드 1차 매수 시작.
* 재진입 시 **API로 총자본을 재스캔**하여 1회 매입금을 재계산합니다(실현 수익 반영 = 복리 엔진).
* 리셋 항목: `farmer_stage=0`, `highest_price=0`, 레이어별 평단/수량 clear, `sold_grid_layers` clear, `phase=GRID`. (N값은 변동성과 무관하므로 유지.)

### 5.2.1. 그리드 매도 후 재매수 정책

그리드 재매수 정책은 상태에 따라 다르게 적용합니다. `GRID` 단계에서는 가격 왕복 수익을 수확하기 위해 팔린 그리드 레이어를 재매수할 수 있습니다. 그리드 20차가 모두 체결된 뒤에도 농부 1차 매수 전이면 아직 `GRID` 단계이므로 그리드 매도/재매수를 유지합니다. 단, 농부 1차 매수가 체결되어 `FARMING` 단계로 넘어간 뒤에는 팔린 그리드 레이어를 같은 사이클에서 재매수하지 않습니다.

```text
GRID 단계 → 그리드 매수/매도/재매수 허용
그리드 20차 체결 → phase는 GRID 유지, 농부 1차 신호 별도 감시
농부 1차 매수 체결 → FARMING 전환
FARMING 이후 그리드 물량 매도 완료 → 현금 회수 완료
FARMING 이후 재하락 발생 → 팔린 그리드 레이어 재매수 금지
전체 사이클 종료 + 5분 쿨다운 → 새 그리드 사이클 시작
```

이 정책은 농부 방어 현금을 보존하고, 그리드 재순환과 농부 추세 보유가 섞이면서 전략 분석이 복잡해지는 것을 막기 위한 기본값입니다.

### 5.3. N(ATR) 운영 — 터틀 원전 방식, 일봉 기준 하루 1회
```
True Range (TR) = max(
  당일 고가 - 당일 저가,
  |당일 고가 - 전일 종가|,
  |당일 저가 - 전일 종가|
)
N = (19 × 전일 N + 당일 TR) / 20   (Wilder 20일 평활)
```
* **계산 주체/주기:** 현재 구현은 Bithumb 일봉 조회 시 현재 KST 일봉을 제외한 확정 일봉으로 N을 계산합니다. Bithumb 일봉 경계는 KST 00:00입니다.
* **첫 구동 처리:** 별도 시드 로직 불필요 — 첫 구동 시에도 동일하게 직전 20일 일봉을 조회해 즉시 계산.
* **사용 주체:** `trailing_stop_bot`은 저장된 N값을 24시간 **읽기 전용**으로 사용(2N 트레일링).

### 5.4. 포지션 판정 (dust 임계값)
* 보유 **평가금 ≥ 10,000원**일 때만 "포지션 보유 중"으로 간주합니다(최소 주문금액 5,000원의 2배 여유). 10,000원 미만 자투리는 "포지션 없음"으로 보아 사이클 종료/재시작 판정을 막지 않습니다.

---

## 6. 데이터 로깅 · 정산 다운로드 · 대시보드 아키텍처

자산 흐름의 안정적 보관과 사용자의 직관적 정산 관리를 위해 **'기록 저장'**과 **'파일 변환/조회'**의 역할을 이원화합니다.

### 6.1. 데이터 저장 계층 (2단계 전환)
1. **1단계 (MVP) — 마스터 로그 JSON:** 봇이 모든 매매 데이터를 `./data/trading_logs/btc_master_log.json`에 시간순 누적(`append`).
2. **2단계 (확장) — Supabase(PostgreSQL):** Next.js 빌드업 시 JSON을 DB로 일대일 대체 적재.

### 6.2. 기간별 엑셀(XLSX) 다운로드
* 사용자가 대시보드에서 **원하는 기간(단일 날짜 또는 시작~종료일 범위)**을 지정.
* 시스템이 마스터 로그/DB에서 해당 기간 데이터만 필터링하여 독립된 정산 보고서 파일을 즉석 생성·제공.
  * 예: `btc_report_2026-06-01_2026-06-03.xlsx`
* 포함 항목: 매매 내역, 일별 손익, 누적 수익률, 사이클별 요약.

### 6.3. 대시보드 (Next.js + Supabase)
| 영역 | 기능 |
| :--- | :--- |
| 실시간 현황 | 현재 phase, 보유 포지션, 평단가, 실시간 수익률, N값 |
| 사이클 히스토리 | 과거 사이클별 진입/청산/수익률 타임라인 |
| 자금 모니터 | 총자본, 예수금, 농부 차수별 투입 현황, 방어력 게이지 |
| 정산/다운로드 | 기간 선택 → XLSX 다운로드 |
| 알림 | 출금 시 방어력 하락 경고, 청산 발생 알림 |

* **기술 스택:** 프론트엔드 Next.js(App Router), 백엔드/DB Supabase(PostgreSQL + Auth + Realtime).
* 봇이 Supabase에 매매 로그를 적재하고, 대시보드가 이를 조회/구독.

### 6.4. Bithumb 수집 정보값

본 전략은 일봉 확정 진입, 4시간봉 부분 조기 진입, 실시간 가격 감시, 계좌/주문 정합성 복구를 함께 사용합니다. Bithumb에서 받아와야 하는 정보는 다음과 같습니다.

| 필요한 정보 | Bithumb 소스 | 주요 필드 | 용도 |
|:--|:--|:--|:--|
| 실시간 현재가 | WebSocket `ticker` 또는 REST 현재가 | `trade_price`, `timestamp` | 그리드 매수 가격 도달 감시, 농부 -15% 가격 도달 감시, 2N 트레일링 청산, 실시간 수익률 계산 |
| 일봉 시가/고가/저가/종가 | Bithumb REST day candles | `opening_price`, `high_price`, `low_price`, `trade_price`, `candle_date_time_kst` | KST 00:00 확정 일봉 필터, MA5 계산, N/ATR 계산, 종가 위치 계산 |
| 일봉 KRW 거래대금 | Bithumb REST day candles | `candle_acc_trade_price` | 농부 확정 매수의 거래대금 조건 계산 |
| 일봉 BTC 거래량 | Bithumb REST day candles | `candle_acc_trade_volume` | 보조 거래량 분석, 기존 거래량 조건 검증 |
| 장기 일봉 데이터 | Bithumb REST day candles | 최근 200~230개 `trade_price` | MA200, MA200 기울기, 구조적 하락장 차단 |
| 4시간봉 시가/고가/저가/종가 | Bithumb REST/WebSocket 4시간봉 | `opening_price`, `high_price`, `low_price`, `trade_price`, `candle_date_time_kst`, `unit` | 농부 1~2차 부분 조기 진입 판단, 4시간봉 종가 위치 계산 |
| 4시간봉 KRW 거래대금 | Bithumb REST/WebSocket 4시간봉 | `candle_acc_trade_price` | 조기 진입 시 4시간봉 매수세 확인 |
| 계정 KRW 잔고 | Bithumb private API | `currency`, `balance`, `locked` | 그리드 1회 매입금 계산, 농부 추가 투입 가능 금액 확인 |
| 계정 BTC 보유 수량 | REST `/v1/accounts` | `currency`, `balance`, `locked` | 포지션 평가금, 실시간 수익률, 청산 수량 계산 |
| 주문 가능 정보 | REST `/v1/orders/chance` | `bid_fee`, `ask_fee`, `market.bid_types`, `market.ask_types`, `market.max_total` | 수수료율, 주문 가능 타입, 최소/최대 주문 가능 금액 확인 |
| 호가 정보 | WebSocket `orderbook` 또는 REST 호가 | `orderbook_units.bid_price`, `orderbook_units.bid_size`, `total_bid_size` | 시장가 청산 전 예상 체결가와 슬리피지 계산 |
| 주문 생성/조회 정보 | REST `/v1/orders` 및 주문 조회 API | `uuid`, `state`, `executed_volume`, `remaining_volume`, `paid_fee`, `identifier` | 주문 추적, 매매 로그 기록, 멱등성 관리, 재시작 후 정합성 복구 |

전략 계산에 필요한 주요 파생값은 다음과 같습니다.

| 파생값 | 계산식 | 원천 데이터 |
|:--|:--|:--|
| 일봉 MA5 | 최근 5개 확정 일봉 `trade_price` 평균 | 일봉 캔들 |
| 일봉 MA200 | 최근 200개 확정 일봉 `trade_price` 평균 | 일봉 캔들 |
| MA200 기울기 | 최근 20~30일 MA200 변화량 | 일봉 캔들 |
| 최근 3일 누적 하락률 | `(직전일 종가 / 3일 전 종가) - 1` | 일봉 캔들 |
| 4시간봉 단기 MA | 최근 N개 확정 4시간봉 `trade_price` 평균 | 4시간봉 캔들 |
| 일봉 종가 위치 | `(trade_price - low_price) / (high_price - low_price)` | 일봉 캔들 |
| 4시간봉 종가 위치 | `(trade_price - low_price) / (high_price - low_price)` | 4시간봉 캔들 |
| 일봉 20일 평균 거래대금 | 최근 20개 확정 일봉 `candle_acc_trade_price` 평균 | 일봉 캔들 |
| 일봉 5일 평균 거래대금 | 최근 5개 확정 일봉 `candle_acc_trade_price` 평균 | 일봉 캔들 |
| 4시간봉 평균 거래대금 | 최근 N개 확정 4시간봉 `candle_acc_trade_price` 평균 | 4시간봉 캔들 |
| N/ATR | `TR = max(high-low, abs(high-prev_close), abs(low-prev_close))`, `N = (19 * previous_N + TR) / 20` | 일봉 캔들 |
| 총자본 | `KRW 잔고 + BTC 보유 수량 * 현재가` | 계정 잔고 + 실시간 현재가 |
| 농부 방어력 등급 | 사용 가능 KRW와 남은 농부 차수 목표 투입액 비교 | 계정 잔고 + 봇 상태 |
| 실시간 순손익 | 봇 자체 레이어 평단/수량 기준 평가손익 - 수수료 - 예상 슬리피지 | 봇 로그 + 실시간 현재가 + 호가 |

> 실시간 가격 감시는 WebSocket `ticker`를 기본으로 사용하고, 일봉/4시간봉 확정값은 REST 캔들 조회로 검증합니다. 조기 진입도 진행 중 캔들이 아니라 **확정된 4시간봉**을 기준으로 판단합니다.

---

## 7. 시스템 프로그램 구동 아키텍처 (Deployment)

실시간 체결 지연(슬리피지)을 차단하기 위해 봇 프로세스를 성격에 맞게 분리하여 클라우드 서버(VPS)에서 구동합니다.

* **`trailing_stop_bot.py` (24시간 상시 구동 / PM2 관리):**
  * 구동 방식: `While True` + `time.sleep(1)`.
  * 핵심 임무: 실시간 가격/WebSocket 감시 → 그리드 매수, 그리드 레이어 매도, 그리드 전체 OPEN 이후 GRID 상태에서 농부 1차 가격 도달 감시, 농부 1~2차 4시간봉 부분 조기 진입, 장중 2N 이탈 통합 회복 포지션 청산 추적. 저장된 N값 읽기 전용 사용. PM2 Auto Restart.
* **`ma5_trend_bot.py` (설계안: 일 1회 / Bithumb KST 00시 이후 크론탭 `5 0 * * *`):**
  * 핵심 임무: Bithumb KST 00:00 일봉 경계를 기준으로 현재 KST 일봉을 제외한 확정 일봉을 사용해 ① 직전 20일 일봉으로 N(ATR) 계산·저장, ② 최근 200일 이상 일봉으로 MA200/장기 추세 기준선을 계산, ③ 농부 확정 매수 필터(KRW 거래대금·종가 위치·1일/2일 연속 양봉·과열 투매 예외·장기 추세·하락 속도·방어력 포함)를 연산하여 잔여 농부 자금 집행 또는 신호 기록, ④ 현재가의 MA5/N일 저가 하회 여부로 통합 회복 포지션 청산 판단. 상태는 `bot_state.json`에 **원자적 쓰기**(임시파일 → rename).

> **상태 공유 파일 `bot_state.json` 스키마(안):**
> ```json
> {
>   "phase": "GRID | FARMING | HOLDING | COOLDOWN",
>   "last_exit_time": "ISO8601",
>   "cooldown_until": "ISO8601",
>   "N_value": 0,
>   "farmer_stage": 0,
>   "highest_price": 0,
>   "grid_entry_price": null,
>   "sold_grid_layers": [],
>   "farmer_early_entry": {
>     "stage": null,
>     "ratio": 0
>   },
>   "farmer_last_buy_at": null,
>   "farmer_last_buy_price": null,
>   "farmer_defense_status": "FULL_DEFENSE | PARTIAL_DEFENSE | CASH_SHORTAGE",
>   "farmer_signal": {
>     "confirmed_filters_ok": false,
>     "strict_ma200_ok": false,
>     "relaxed_ma200_ok": false,
>     "two_bullish_daily_ok": false,
>     "blocked_reason": null,
>     "signal_quality_score": 0
>   }
> }
> ```

---

## 8. 구현 로드맵 (단계별 봇 보완 순서)

본 시스템은 한 번에 전체 자동매매로 구현하지 않고, 검증 가능한 작은 단위부터 단계적으로 보완합니다. 구현 순서는 **24시간 BTC 그리드매매 봇 + Node.js/Supabase 대시보드 → 농부매수봇 → 터틀매도봇 → 4시간봉 부분 조기 진입** 순서를 기본으로 합니다.

| 단계 | 구현 대상 | 실거래 상태 | 목표 |
|:--:|:--|:--|:--|
| 1 | 프로젝트 골격/설정/모델 | 주문 없음 | 설정값, 상태 파일, 레이어 모델, 기능 플래그 구조 확정 |
| 2 | Bithumb 데이터 수집 모듈 | 주문 없음 | WebSocket 현재가/호가, 일봉, 4시간봉, 잔고, 주문 가능 정보 수집 |
| 3 | Node.js + Supabase 대시보드 MVP | 주문 없음 | 현재가, 그리드 차수, 잔고, 손익, 봇 상태, `snapshot` 표시 |
| 4 | 그리드 Paper Trading | 주문 없음 | 20차 그리드 매수/매도/GRID 단계 재매수 신호 검증 |
| 5 | 그리드 소액 실거래 | 그리드만 ON | AWS Linux에서 24시간 그리드 매수/매도/재매수와 로그 정합성 검증 |
| 6 | 농부매수 신호봇 | 주문 없음 | -15% 가격 조건과 Bithumb KST 00:00 확정 일봉 필터를 신호로 기록 |
| 7 | 터틀매도 신호봇 | 주문 없음 | 통합 회복 포지션 기준 2N/MA5/N일 저가/부분 익절 청산 조건과 예상 순손익 게이트 검증 |
| 8 | 농부매수 + 터틀매도 소액 실거래 | 농부/터틀 소액 ON | 농부 실매수와 터틀 청산을 같은 레이어 기준으로 검증 |
| 9 | 농부 1~2차 4시간봉 부분 조기 진입 | 제한 ON | 조기 진입 비율과 확정 일봉 잔여 진입 검증 |
| 10 | 운영 자동화/알림/백업 | 단계별 확대 | PM2/systemd, 로그 로테이션, 장애 알림, Supabase 백업, 대시보드 제어 안정화 |

### 8.1. 전략별 구현 역할

| 전략 | 역할 |
|:--|:--|
| 그리드 매매 | 24시간 매수/매도/GRID 단계 재매수. AWS 서버와 대시보드 MVP의 첫 검증 대상 |
| 농부매매 | 그리드 20차 이후 깊은 하락 구간에서 추가 매수. 실거래 전 신호 검증 필수 |
| 터틀매매 | 농부 매수 이후 통합 회복 포지션의 청산 엔진. 농부 실매수를 켜기 전에 최소 신호봇으로 준비 |

### 8.2. 기능 플래그 기본값

현재 TypeScript 구현에서 사용하는 주요 플래그와 설정명은 아래를 기준으로 합니다. 기존 문서의 `ENABLE_TURTLE_EXIT` 또는 `TURTLE_*` 명칭은 최신 코드에서는 `ENABLE_RECOVERY_TURTLE_SELL` 및 `RECOVERY_TURTLE_*` 계열로 대체합니다.

```text
ENABLE_REAL_ORDERS=false
ENABLE_GRID_BUY=false
ENABLE_GRID_SELL=false
ENABLE_FARMER_CONFIRMED_BUY=false
ENABLE_RECOVERY_TURTLE_SELL=false

FARMER_LONG_TREND_MODE=relaxed
FARMER_MIN_DAILY_TURNOVER_KRW=0
FARMER_MAX_3D_DRAWDOWN_PCT=-0.25
FARMER_VOLATILITY_N_MULTIPLIER=2
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

대시보드 `Strategy Adjustment`에서 저장한 값은 `bot_state.json`에 저장되며, 터틀 엔진은 `bot_state.json`의 사용자 설정을 우선 사용하고 값이 없을 때만 환경변수 기본값을 사용합니다.

실거래 주문은 마지막에 켜며, 초기 기본값은 모두 `false`로 둡니다.

```text
ENABLE_REAL_ORDERS=false
ENABLE_GRID_BUY=false
ENABLE_GRID_SELL=false
ENABLE_FARMER_CONFIRMED_BUY=false
ENABLE_FARMER_EARLY_ENTRY=false
ENABLE_TURTLE_EXIT=false
ENABLE_DASHBOARD_COMMANDS=false
FARMER_LONG_TREND_MODE=relaxed
FARMER_MIN_DAILY_TURNOVER_KRW=0
FARMER_MAX_3D_DRAWDOWN_PCT=-0.25
FARMER_VOLATILITY_N_MULTIPLIER=2
FARMER_STAGE2_COOLDOWN_DAYS=3
FARMER_STAGE3_COOLDOWN_DAYS=5
FARMER_ALLOW_FINAL_CAP_BUY=true
FARMER_MIN_ORDER_KRW=5000
FARMER_MIN_DEFENSE_CASH_AFTER_BUY_KRW=0
TURTLE_PARTIAL_TAKE_PROFIT_ENABLED=false
TURTLE_TP1_RETURN_PCT=10
TURTLE_TP1_SELL_RATIO_PCT=33
TURTLE_TP2_RETURN_PCT=20
TURTLE_TP2_SELL_RATIO_PCT=33
TURTLE_TRAILING_N_MULTIPLIER=2.0
TURTLE_MAX_SLIPPAGE_PCT=0.15
TURTLE_SLICE_ORDER_KRW=1000000
TURTLE_SLICE_INTERVAL_SECONDS=10
TURTLE_ORDERBOOK_STALE_MS=3000
TURTLE_REQUIRE_ACCOUNT_PNL_POSITIVE=false
```

### 8.3. 코드 폴더 구조 요약

그리드 MVP는 Node.js/TypeScript + Supabase + AWS Linux 운영을 기준으로 아래 구조로 시작합니다.

본 대시보드는 여러 독립 전략을 한 계좌에서 동시에 운영하는 공통 멀티전략 대시보드가 아닙니다. **BTC Grid-Farmer-Turtle Hybrid 전략 전용 대시보드**로 구현합니다. 향후 다른 전략은 이 구조를 참고하되 별도 프로젝트/별도 대시보드로 분리합니다.

```text
새 전략 프로젝트
├─ 해당 전략 전용 봇
├─ 해당 전략 전용 대시보드
└─ 필요하면 공통 컴포넌트만 복사/재사용
```

```text
bithumb_grid_farmer/
├─ apps/
│  ├─ grid-bot/       # AWS에서 24시간 실행되는 그리드봇
│  └─ dashboard/      # Node.js/Next.js + Supabase 대시보드
├─ packages/
│  └─ shared/         # 봇/대시보드 공통 타입, 상수, 계산식
├─ supabase/          # 테이블 migration, seed
├─ scripts/           # 배포, 실행, 백업 스크립트
├─ config/            # 그리드 설정 예시, PM2 설정
├─ docs/
└─ archive/
```

실제 매매전략 코드는 `apps/grid-bot/src/` 아래의 전략별 폴더에 둡니다.

| 전략 | 폴더 | 핵심 파일 |
|:--|:--|:--|
| 그리드 매매 | `apps/grid-bot/src/grid/` | `grid-engine.ts`, `grid-levels.ts`, `grid-state-machine.ts` |
| 농부매수 | `apps/grid-bot/src/farmer/` | `farmer-engine.ts`, `farmer-filters.ts`, `farmer-sizing.ts` |
| 터틀매도 | `apps/grid-bot/src/turtle/` | `turtle-exit-engine.ts`, `atr.ts`, `trailing-stop.ts` |

MVP에서는 `grid/`만 먼저 구현하고, 농부/터틀 폴더는 그리드봇 안정화 이후 추가합니다. 상세 폴더 구조는 `docs/02-design/features/grid_farmer_bot_design.md`를 따릅니다.

### 8.4. 농부 매수 코드 수정안 (Do 단계)

농부 매수는 처음부터 실주문으로 켜지 않고, **신호 기록 → Paper/소액 검증 → 제한적 실거래** 순서로 확장합니다.

#### 8.4.1. 추가 모듈

```text
apps/grid-bot/src/farmer/
├─ farmer-engine.ts       # 농부 차수 상태, 가격 도달, 확정/조기 진입 orchestration
├─ farmer-filters.ts      # MA5, MA200, 하락 속도, 거래대금, 종가 위치, 1일/2일 연속 양봉, 과열 예외, RSI 보조 점수
├─ farmer-sizing.ts       # 평가금만큼 추가 투입, 현금 cap, 방어력 등급 계산
├─ farmer-signal.ts       # passed/blocked_reason/quality_score 로그 레코드 생성
└─ farmer-types.ts        # FarmerFilterResult, FarmerDefenseStatus 등 전략 타입
```

기존 모듈 수정 범위:

```text
apps/grid-bot/src/config.ts
  - FARMER_* 환경변수 로드

packages/shared/src/types.ts
  - FARMER_BUY, FARMER_SIGNAL 액션 추가
  - farmerLastBuyAt, farmerLastBuyPrice, farmerDefenseStatus, farmerSignal 상태 필드 추가

apps/grid-bot/src/main.ts
  - GRID 상태에서 그리드 전체 레이어가 OPEN이면 농부 1차 신호 감시
  - 농부 1차 매수 체결 이후 FARMING 상태에서 farmer-engine tick 연결
  - ENABLE_FARMER_CONFIRMED_BUY=false이면 주문 없이 FARMER_SIGNAL만 기록

apps/dashboard/src/server.ts
  - 농부 방어력 등급, blocked_reason, MA200 strict/relaxed, 2일 연속 양봉 상태 표시

apps/grid-bot/src/telegram/telegram-bot.ts
  - 현금 부족, 2차까지만 가능, 구조적 하락장 차단, 자유낙하 보류 알림
```

#### 8.4.2. 신호 로그 필드

농부 신호봇 단계에서는 매수하지 않고 아래 값을 JSONL/Supabase에 기록합니다.

```json
{
  "action": "FARMER_SIGNAL",
  "stage": 1,
  "price_triggered": true,
  "confirmed_filters_ok": false,
  "early_entry_filters_ok": false,
  "strict_ma200_ok": false,
  "relaxed_ma200_ok": true,
  "two_bullish_daily_ok": true,
  "drawdown_3d_pct": -0.12,
  "volatility_n_multiple": 1.4,
  "cooldown_ok": true,
  "defense_status": "FULL_DEFENSE",
  "target_order_krw": 1580000,
  "capped_order_krw": 1580000,
  "blocked_reason": null,
  "signal_quality_score": 1
}
```

`blocked_reason`은 하나만 남기지 않고, 구현상 배열로 확장할 수 있습니다.

```text
PRICE_NOT_REACHED
STAGE_COOLDOWN
FREEFALL_3D_DRAWDOWN
VOLATILITY_EXPLOSION
LONG_TREND_BLOCKED
MA5_TREND_BLOCKED
TURNOVER_RATIO_BLOCKED
TURNOVER_ABSOLUTE_BLOCKED
CLOSE_POSITION_BLOCKED
BULLISH_DAILY_BLOCKED
TWO_BULLISH_DAILY_BLOCKED
CAPITULATION_BLOCKED
CASH_SHORTAGE
MIN_ORDER_NOT_MET
```

#### 8.4.3. 농부 매수 실행 정책

```text
if ENABLE_FARMER_CONFIRMED_BUY=false:
  FARMER_SIGNAL만 기록

if ENABLE_FARMER_CONFIRMED_BUY=true:
  Bithumb KST 00:00 기준 확정 일봉 필터와 현재가 트리거 통과 시 FARMER_BUY 실행

if ENABLE_FARMER_EARLY_ENTRY=true:
  농부 1~2차에 한해 4시간봉 조기 진입분만 실행

if farmerStage == 3 and targetOrderKrw > availableKrw:
  FARMER_ALLOW_FINAL_CAP_BUY=true이면 cappedOrderKrw로 실행
  단 cappedOrderKrw < FARMER_MIN_ORDER_KRW이면 실행하지 않음
```

#### 8.4.4. 대시보드 표시

대시보드에는 아래 항목을 추가합니다.

```text
Farmer Defense:
  3차까지 방어 가능 / 2차까지만 가능 / 현금 부족

Farmer Filters:
  Price -15%
  Stage Cooldown
  MA200 strict / relaxed
  3D Drawdown
  Volatility vs N
  MA5 Trend
  KRW Turnover
  Close Position
  Bullish Daily
  Two Bullish Daily
  Capitulation

Farmer Next Action:
  Signal only / Confirmed buy ready / Early entry ready / Blocked(reason)
```

### 8.5. 터틀 매도 코드 수정안 (Do 단계)

현재 구현은 아래 모듈명으로 반영되어 있습니다.

```text
apps/grid-bot/src/turtle/
├─ recovery-exit-engine.ts   # Recovery Position 기준 2N/MA5 청산 신호 및 분할 시장가 청산
└─ turtle-indicators.ts      # 일봉 MA5, Wilder ATR(N) 계산

packages/shared/src/recovery-position.ts
  - OPEN 그리드 레이어와 농부 포지션을 통합 회복 포지션으로 합산

packages/shared/src/types.ts
  - RECOVERY_EXIT_SIGNAL, RECOVERY_SELL 액션 추가
  - recoveryExitSignal 및 Recovery Turtle/Partial TP 설정 필드 추가
```

현재 로그 액션명:

```text
FARMER_SIGNAL
FARMER_BUY
RECOVERY_EXIT_SIGNAL
RECOVERY_SELL
```

현재 터틀 매도는 `ENABLE_RECOVERY_TURTLE_SELL=false` 기본값에서 신호만 기록하고, true일 때만 통합 회복 포지션을 `RECOVERY_TURTLE_SLICE_ORDER_KRW` 단위로 분할 시장가 매도합니다. 부분 익절을 켜면 TP1/TP2 조건 도달 시 설정 비율만큼 통합 회복 포지션을 부분 매도하고, 남은 그리드/농부 수량과 원가는 비례 축소해 추적합니다.

터틀 매도는 농부 매수 이후의 통합 회복 포지션을 청산하는 엔진입니다. 농부 1차 매수 전에는 phase를 `GRID`로 유지하므로 터틀 매도가 작동하지 않고, 기존 그리드 매도 방식으로 반등을 처리합니다. 농부 매수 이후에는 OPEN 그리드 레이어와 농부 포지션을 합친 원가·수량·예상 체결가를 기준으로 판단합니다.

#### 8.5.1. 추가 모듈

```text
apps/grid-bot/src/turtle/
├─ turtle-exit-engine.ts       # 2N/MA5/부분 익절 청산 신호 orchestration
├─ turtle-pnl.ts               # 농부 레이어 자체 원가, 예상 순손익 계산
├─ turtle-orderbook.ts         # WebSocket/REST orderbook 스냅샷, bid depth 계산
├─ turtle-executor.ts          # 분할 청산, 지정가 우선, 미체결 잔량 처리
├─ turtle-settings.ts          # Strategy Adjustment 설정값 검증/정규화
├─ atr.ts                      # N 계산
└─ trailing-stop.ts            # highest_price, trailing width, N 배수 계산
```

기존 모듈 수정 범위:

```text
apps/grid-bot/src/config.ts
  - TURTLE_* 환경변수 로드

packages/shared/src/types.ts
  - TURTLE_SIGNAL, TURTLE_EXIT, TURTLE_TAKE_PROFIT 액션 추가
  - farmerCostKrw, farmerQty, turtleSettings, partialTakeProfitState 필드 추가

apps/grid-bot/src/main.ts
  - FARMING/HOLDING 상태에서 turtle-exit-engine 연결
  - ENABLE_TURTLE_EXIT=false이면 주문 없이 TURTLE_SIGNAL만 기록

apps/dashboard/src/server.ts
  - Strategy Adjustment에 터틀 부분 익절/슬리피지/분할 주문 설정 추가
  - 부분 익절이 꺼짐이면 1차/2차 익절 수익률·매도 비율 입력 비활성화

apps/grid-bot/src/telegram/telegram-bot.ts
  - 터틀 청산 신호, 슬리피지 보류, 부분 익절 체결, orderbook stale 알림
```

#### 8.5.2. 터틀 신호 로그 필드

초기 터틀 신호봇 단계에서는 매도하지 않고 아래 값을 기록합니다.

```json
{
  "action": "TURTLE_SIGNAL",
  "trigger": "TRAILING_STOP | MA5_EXIT | TAKE_PROFIT_1 | TAKE_PROFIT_2 | FOUR_HOUR_MA_WARNING",
  "farmer_qty": 0.01,
  "farmer_cost_krw": 1000000,
  "expected_sell_krw": 1120000,
  "expected_fee_krw": 560,
  "expected_slippage_pct": 0.08,
  "expected_farmer_net_pnl_krw": 119440,
  "farmer_net_pnl_gate_ok": true,
  "account_net_pnl_pct": -1.2,
  "orderbook_stale": false,
  "partial_take_profit_enabled": false,
  "blocked_reason": null
}
```

`account_net_pnl_pct`는 참고 정보로만 기록합니다. 기본 청산 게이트는 `farmer_net_pnl_gate_ok`입니다.

#### 8.5.3. Strategy Adjustment 표시 규칙

대시보드 설정은 우리말로 표시합니다.

```text
부분 익절: 꺼짐
익절 단계: 사용 안 함
추세 추종 잔여 비율: 전체 물량
트레일링 N 배수: 2.0
최대 허용 슬리피지: 0.15%
분할 주문 금액: 1,000,000원
분할 주문 간격: 10초
```

부분 익절이 꺼짐이면 아래 입력은 비활성화하고, 저장값은 유지하되 전략에는 적용하지 않습니다.

```text
1차 익절 수익률
1차 익절 매도 비율
2차 익절 수익률
2차 익절 매도 비율
```

부분 익절을 켰을 때만 위 입력을 활성화합니다.

```text
부분 익절: 켜짐
1차 익절 수익률: 10%
1차 익절 매도 비율: 33%
2차 익절 수익률: 20%
2차 익절 매도 비율: 33%
추세 추종 잔여 비율: 남은 물량
```

#### 8.5.4. 터틀 매도 실행 정책

```text
if ENABLE_TURTLE_EXIT=false:
  TURTLE_SIGNAL만 기록

if ENABLE_TURTLE_EXIT=true:
  농부 레이어 예상 순손익 > 0일 때만 청산 실행

if orderbook stale:
  청산 보류 + ORDERBOOK_STALE 기록

if expected slippage > TURTLE_MAX_SLIPPAGE_PCT:
  분할 주문 크기 축소 또는 다음 분할로 지연

if TURTLE_PARTIAL_TAKE_PROFIT_ENABLED=false:
  TP1/TP2 조건 무시
  전체 농부 잔여 물량을 trailing width/MA5로 추적

if TURTLE_PARTIAL_TAKE_PROFIT_ENABLED=true:
  TP1/TP2 조건 도달 시 설정 비율만 청산
  잔여 물량은 trailing width/MA5로 계속 추적
```

---

## 9. 리스크 고지 (필수)

본 시스템은 **무손절 추세추종 전략**입니다. 투입 자금은 다음 리스크를 감수합니다.

* 통합 회복 포지션 매도는 오직 **"청산 대상 통합 회복 포지션 예상 순손익 > 0"** 상태에서만 발동합니다(손절매 없음). 계좌 전체 손익은 기본 청산 게이트에 섞지 않고 참고/경고 정보로만 사용합니다.
* 최대 자금 투입 지점: 농부 3차(최초 진입가 대비 약 **-41.5%**).
* 농부 3차 이후 추가 하락 시: 현금 소진 상태로 무기한 홀딩 가능 (BTC 역사적 하락 사례: -77%(2018), -75%(2022)).
* → 투입 자금은 반드시 **"장기 미사용 가능 여유자금"**이어야 합니다.
* → 농부 청산은 전량 시장가 매도를 기본값으로 사용하지 않습니다. 실시간 호가 깊이를 확인하고, 수수료·슬리피지를 반영한 농부 레이어 예상 순손익이 양수인 범위에서 분할 청산합니다.
* 호가 정보가 오래됐거나 예상 슬리피지가 설정 한도를 초과하면 청산을 보류할 수 있습니다. 이 경우 미실현 수익을 일부 반납할 수 있지만, "예상 양수였으나 실제 음수 청산"이 되는 위험을 줄이기 위한 정책입니다.
* 부분 익절이 꺼져 있으면 1차/2차 익절 조건은 적용되지 않으며, 통합 회복 포지션 전체를 터틀 트레일링/MA5/N일 저가 기준으로 추적합니다.
* 농부 1~2차 부분 조기 진입은 V자 반등 대응력을 높이지만, 확정 일봉 필터만 사용하는 방식보다 가짜 반등에 노출될 수 있습니다. 농부 3차는 이 위험 때문에 조기 진입을 금지합니다.
* v4의 MA200 장기 추세 필터와 하락 속도 필터는 구조적 하락장과 자유낙하 구간의 반복 물타기를 줄이기 위한 장치입니다. 반대로 강한 V자 반등의 일부 초입을 놓칠 수 있으므로, 초기에는 `strict`/`relaxed` 결과를 모두 신호 로그로 남기고 백테스트 후 실거래 기본값을 확정합니다.
* "2차까지만 가능" 방어력 등급은 농부 3차를 자동 금지한다는 뜻이 아닙니다. 기본 정책은 농부 3차에서 목표 매수금을 채우지 못하면 남은 현금으로 cap 매수하되, 최소 주문금액 미만이면 실행하지 않는 방식입니다.
* 그리드 전체 체결 후에도 농부 1차 매수 전에는 `GRID` 상태를 유지하므로 그리드 매도/재매수 기회를 유지합니다. 단, 농부 1차 매수 체결로 `FARMING`에 들어간 뒤에는 팔린 그리드 물량을 같은 사이클에서 재매수하지 않습니다.

---

## 10. 결론
본 시스템은 "살 때는 철저히 리스크를 쪼개어 정교하게 사고, 팔 때는 대세 추세를 통째로 먹는다"는 트레이딩의 본질에 부합하는 알고리즘입니다.

Bithumb KST 00시 확정 일봉 기준선과 현재가 트리거의 분리, 4시간봉 기반 부분 조기 진입 설계, [현재 자산 대비 역산 동적 자본 제어], 농부 3차까지 닫히는 15.8% 자금 설계, 통합 회복 포지션 청산, 무손절 추세추종 원칙을 통해 하락장 방어와 상승장 수확을 모두 도모합니다. 세부 설계·미결 사항·검증 계획은 Design 문서(`docs/02-design/features/grid_farmer_bot_design.md`)를 따릅니다.
