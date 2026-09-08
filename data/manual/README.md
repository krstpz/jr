# data/manual — 수동 보정 데이터

`<driverId>.csv` 또는 `spot.csv` 파일을 두면 `scripts/sync.mjs` 가 자동 수집값 위에 덮어씁니다(같은 날짜는 수동 값 우선).

형식(헤더 1행 + `date,value`, 월 데이터는 `YYYY-MM-01`):

```csv
date,value
2026-04-01,-0.55
2026-05-01,-0.48
```

driverId 는 `config/sources.json` 의 `drivers[].id` (예: `spread10y`, `kr_trade`, `brent`).
한국은행 ECOS·관세청 수출입통계 등 키가 필요한 자료를 붙일 때 사용하세요.
