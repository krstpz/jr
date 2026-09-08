# 연동 가이드 — 달러/원 BEER 적정환율 모델

다른 웹사이트·서비스·Claude 세션에서 이 모델을 그대로 가져다 쓰기 위한 정리입니다.
저장소: `krstpz/jr` · 페이지: `https://krstpz.github.io/jr/` (GitHub Pages)

## 1. 한 장 요약

| 항목 | 내용 |
|---|---|
| 목적 | 달러/원 환율의 **행태균형환율(BEER) 적정 수준**과 **90% 신뢰구간**, **ECM 단기 조정 여력**을 매일 자동 갱신해 차트·JSON 으로 제공 |
| 장기식 | `log(USD/KRW) = c + β₁·(US10y − KR10y) + β₂·log(DXY) + β₃·log(Brent) + β₄·무역수지 12M 누적 + β₅·log(USD/JPY) + β₆·log(USD/CNY)` — 월평균, OLS, 표본 2014-01~ (기본 스펙 `combined`) |
| 신뢰구간 | 적정환율 × exp(±1.645·σ), σ = 장기식 잔차 표준편차 |
| 단기식(ECM) | `Δlog(S_t) = α + γ·e_{t−1} + Σβ·Δx_t` → 이번 달 "적정 변동폭" vs 실제 변동폭 → 잔여 조정 여력 |
| 갱신 | GitHub Actions 가 평일 07:30 KST 에 수집·적합 후 `data/` 커밋. 페이지는 10분마다 라이브 스팟(ECB) 갱신 |
| 스펙 3종 | `combined`(통합, 기본) · `beer`(펀더멘털만) · `market`(환율만). 셋 다 적합해 JSON 에 담고, 표본외 검증 지표로 비교 |
| 표본외 검증 | 60개월 적합 → 12개월 예측을 창을 넓히며 반복. `oos.longRun.sigmaPct`(적정환율 예측오차), `oos.ecm.skill`(월간 변동 예측력, 1−RMSE/무변화기준), `oos.ecm.hitRate`(방향 적중률) |

## 2. 파일 구조

```
index.html              대시보드 (차트·KPI·시나리오·모형표·리포트 비교)
embed.html              iframe 삽입용 축약 페이지
assets/app.js           UI (ESM, 외부 라이브러리 없음 — 차트는 인라인 SVG)
assets/style.css        라이트/다크 자동
src/beer-model.js       ★ 모형 계산 순수 모듈 (브라우저·Node 공용, 의존성 0)
src/data-sources.js     ★ 데이터 어댑터 (Frankfurter, FRED CSV, 사용자 CSV, DXY 산출)
scripts/sync.mjs        수집 → 적합 → data/ 저장 (node scripts/sync.mjs)
config/sources.json     드라이버·스펙·리포트 기준값 설정 (코드 수정 없이 여기만 바꾸면 됨)
data/beer_output.json   ★ 전체 결과 (시계열·계수·신뢰구간·ECM·소스 상태)
data/latest.json        최신 값만 (경량)
data/status.json        소스 상태
data/series/<id>.json   수집 원시 시계열 [{date,value}]
data/manual/<id>.csv    수동 보정 데이터 (선택)
.github/workflows/sync.yml  일일 동기화 워크플로
```

## 3. 데이터 소스 (모두 무료·키 불필요)

| id | 내용 | 소스 | 주기 |
|---|---|---|---|
| spot | 달러/원 | Frankfurter `KRW` (ECB 고시환율, EUR 크로스) | 일 |
| spread10y | 한미 10년 금리차 (US−KR, %p) | FRED `DGS10` − 한국 10년: ① ECOS `817Y002` 국고채10년 **일별**(시크릿 `ECOS_API_KEY` 필요) ② OECD SDMX `DSD_STES@DF_FINMARK` KOR IRLT 월별 ③ FRED `IRLTLT01KRM156N` 월별 — 앞에서부터 최신 자료가 있는 소스 채택 | 일/월 |
| dxy | 달러인덱스 | Frankfurter EUR·JPY·GBP·CAD·SEK·CHF 로 ICE DXY 공식 재현 | 일 |
| brent | 브렌트유 | FRED `DCOILBRENTEU` | 일 |
| kr_trade | 한국 무역수지 12M 누적(십억달러) | 수출−수입: ① OECD SDMX `DSD_IMTS@DF_IMTS` (월별, 최신) ② IMF DOTS/IFS via DBnomics (2025년 초까지) — 앞에서부터 최신 자료가 있는 소스 채택 | 월 |
| usdjpy / usdcny | 달러/엔, 달러/위안 | Frankfurter | 일 |

- 드라이버 자동 제외 규칙: 최종 관측이 표본 끝보다 `maxStaleMonths`(기본 6개월) 이상 오래됨 / 표본 커버리지 90% 미만.
- 최근 달 미발표 지표는 최대 `ffillMax`(기본 3개월) 직전값 유지 = **나우캐스트**(차트 점선, JSON `nowcast:true`).
- 한국은행 ECOS·관세청 등 키가 필요한 자료는 `data/manual/<id>.csv` 로 넣으면 자동값 위에 덮어씀 (`data/manual/README.md`).
- **ECOS 연동(권장, 5분)**: https://ecos.bok.or.kr → 로그인 → Open API → 인증키 신청 → GitHub 저장소 Settings → Secrets and variables → Actions → `ECOS_API_KEY` 등록. 다음 동기화부터 한국 국고채 10년 **일별** 금리가 자동 사용되어 금리차가 당월까지 채워짐(나우캐스트 해소).
- 소스 어댑터 종류(`config/sources.json` 의 ref 접두어): `frankfurter:` `fred:` `dbnomics:` `oecd:` `sdmxcsv:` `ecos:` `csv:`. ref 를 배열로 주면 순서대로 시도해 최신 관측(45일 이내)이 있는 첫 소스를 채택.
- 주의: ECB 고시환율은 서울외환시장 종가(마감가)와 소폭 다름. 서울 종가를 쓰려면 `data/manual/spot.csv` 로 덮어쓰기.

## 4. JSON 스키마 (`data/beer_output.json`, schemaVersion 1)

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-08T22:31:00.000Z",
  "sample": { "start": "2014-01", "end": "2026-09", "months": 153 },
  "ci": 0.9,
  "spot": { "firstDate": "2014-01-02", "lastDate": "2026-09-08", "last": 1385.2,
            "monthlyAverage": [ { "date": "2014-01", "value": 1064.5 }, … ] },
  "driverStatus": [ { "id": "spread10y", "lastDate": "2026-07-01", "coverage": 0.99, "excluded": null, "nowcastMonths": ["2026-08","2026-09"] }, … ],
  "defaultModel": "combined",                 // 성공한 첫 스펙 id ("combined" > "beer" > "market")
  "models": {
    "combined": {
      "id": "combined", "name": "통합 (BEER + 시장)", "description": "…", "ok": true,
      "sample": { "start": "2014-01", "end": "2026-07", "n": 151 },
      "ci": { "level": 0.9, "z": 1.6449 },
      "stats": { "r2": 0.87, "sigma": 0.0412, "sigmaPct": 4.12, "bandHalfWidthPct": 6.78 },
      "oos": { "minTrainMonths": 60, "blockMonths": 12,
               "longRun": { "n": 93, "sigmaPct": 4.9 },
               "ecm": { "n": 93, "rmseKrw": 21.3, "naiveRmseKrw": 27.0, "skill": 0.21, "hitRate": 0.68 } },
      "intercept": { "coef": 6.9, "se": …, "tstat": … },
      "drivers": [
        { "id": "spread10y", "name": "…", "unit": "%p", "transform": "level", "tier": "fundamental",
          "coef": 0.08, "se": …, "tstat": 9.1, "lastDate": "2026-07-01", "coverage": 1, "nowcastMonths": [],
          "sensitivity": { "per": "+10bp", "krw": 11.2 } }   // 드라이버 충격당 적정환율 변화(원)
      ],
      "dropped": [ { "id": "kr_trade", "reason": "stale: …" } ],
      "ecm": { "alpha": …, "gamma": -0.21, "gammaT": -3.9, "betas": […], "sigma": …, "r2": …, "n": 150,
               "halfLifeMonths": 2.9,
               "latest": { "month": "2026-09", "prevMonth": "2026-08",
                           "predictedChangeKrw": -26.0, "actualChangeKrw": -9.0, "remainingKrw": -17.0 } },
      "latest": { "month": "2026-09", "spot": 1484, "fair": 1288, "lo": 1205, "hi": 1377,
                  "gap": 196, "gapPct": 15.2, "z": 2.3, "nowcast": true, "bandPosition": 1.62 },
      "series": [ { "date": "2014-01", "spot": 1064.5, "fair": 1071.2, "lo": 1002.1, "hi": 1145.0,
                    "gap": -6.7, "z": -0.15, "nowcast": false, "inSample": true }, … ]
    },
    "beer": { … 동일 구조 … },
    "market": { … 동일 구조 … }
  },
  "sources": [ { "id": "spot", "name": "…", "ok": true, "points": 3200, "lastDate": "2026-09-08", "source": "frankfurter:KRW", "error": null } ],
  "reference": { "label": "KB국민은행 … (2026.04)", "asOf": "2026-04", "fair": 1288, "monthAvg": 1484, "overshoot": 196,
                 "ecmFairChange": -26, "ecmActualChange": -9, "rangeLow": 1440, "rangeHigh": 1490, "sensitivitySpread10bp": -11.2 }
}
```

`data/latest.json` 은 `{ generatedAt, model, spotLast, spotLastDate, latest, ecm, stats, sensitivity }` 만 담은 경량판.

필드 의미
- `fair` 적정환율(원), `lo/hi` 90% 신뢰구간, `gap = spot − fair`(원, +면 원화 저평가/오버슈팅), `z = 잔차/σ`, `bandPosition` 0=하단·1=상단.
- `nowcast` 일부 드라이버가 직전값 유지, `inSample` 장기식 적합에 사용된 달.
- `ecm.latest.remainingKrw` = 적정 변동폭 − 실제 변동폭 (음수면 추가 하락 여력).

## 5. 사용 예

```js
// (a) 다른 웹페이지: 최신 값 배지
const d = await (await fetch('https://krstpz.github.io/jr/data/latest.json')).json();
console.log(`적정 ${d.latest.fair}원, 괴리 ${d.latest.gap}원, ECM 잔여 ${d.ecm?.remainingKrw}원`);

// (b) 전체 시계열로 자체 차트 그리기
const o = await (await fetch('https://krstpz.github.io/jr/data/beer_output.json')).json();
const s = o.models[o.defaultModel].series;   // [{date, spot, fair, lo, hi, gap, z, nowcast}]

// (c) iframe 삽입
<iframe src="https://krstpz.github.io/jr/embed.html" width="100%" height="640" style="border:0" loading="lazy"></iframe>

// (d) 모형만 재사용 (Node ≥18 / 브라우저 ESM, 의존성 없음)
import { runModel, scenarioFair } from './src/beer-model.js';
const out = runModel({ sampleStart:'2014-01', ci:0.9, spot:[{date,value}], drivers:[{id, transform:'log'|'level'|'roll12', points:[{date,value}]}], specs:[{id:'beer', drivers:[…], required:[…]}] });
scenarioFair(out.models.beer, { spread10y: -0.5, dxy: -3 });   // 금리차 −50bp, DXY −3% 시 적정환율

// (e) Python 에서
import requests; o = requests.get('https://krstpz.github.io/jr/data/beer_output.json').json()
```

수동 실행: `node scripts/sync.mjs` (`--dry-run` 이면 파일 미저장). GitHub → Actions → "Sync BEER model data" → Run workflow 로 즉시 갱신.

## 6. 설정 바꾸기 (`config/sources.json`)

- `drivers[]` 에 항목 추가: `type` = `frankfurter`(symbol) | `frankfurter-dxy` | `fred`(series) | `csv`(url) | `derived`(op:diff, a, b) | `manual`.
  `transform` = `log` | `level` | `roll12`(12개월 누적, `scale` 로 단위 조정).
- `specs[]` 로 어떤 드라이버 조합을 적합할지 정의. 첫 번째로 성공한 스펙이 기본값.
- `reference` 는 페이지의 "리포트 기준값과 비교" 카드에 표시 (KB 리포트 인용값). 새 리포트가 나오면 여기만 갱신.
- `ci` 신뢰수준(0.8/0.9/0.95/0.99), `sampleStart` 표본 시작월.

## 7. 한계·주의

- 통계 모형이며 투자 조언이 아님. 신뢰구간은 잔차 σ 기준(계수 불확실성 미포함).
- ECOS 키가 없으면 한국 10년 금리는 OECD 월별 자료(약 1개월 지연) → 최근 달은 나우캐스트. 키를 넣거나 `data/manual/spread10y.csv` 로 보정 가능.
- 통합 스펙은 엔·위안이 설명변수로 들어가 "아시아 통화 동반 약세" 국면에서는 적정환율도 함께 올라감(상대가치 관점). 펀더멘털만의 균형은 `beer` 스펙을 함께 볼 것.
- 리포트(KB, 2026.04)의 1,288원은 KB 자체 BEER 모형(변수·표본 다름)이며, 본 모형 수치와 일치하지 않을 수 있음. 비교 카드는 참고용.
