# 달러/원 BEER 적정환율 모니터

행태균형환율(BEER) 모형으로 달러/원 **적정환율·90% 신뢰구간·ECM 단기 조정 여력**을 추정하고, 매일 자동 동기화해 GitHub Pages 로 보여줍니다.

- 페이지: https://krstpz.github.io/jr/ · 삽입용: https://krstpz.github.io/jr/embed.html
- 데이터(JSON): `data/beer_output.json` (전체) · `data/latest.json` (최신 값)
- 연동 가이드·스키마·모형 정의: [docs/INTEGRATION.md](docs/INTEGRATION.md)

## 처음 켤 때

1. GitHub → Settings → Pages → Source: `main` 브랜치 루트로 배포.
2. GitHub → Actions → **Sync BEER model data** → *Run workflow* 를 한 번 실행하면 `data/` 가 채워지고, 이후 평일 07:30 KST 마다 자동 갱신됩니다.
   (실행 전에는 페이지가 브라우저에서 직접 환율만 수집해 "시장 프록시" 스펙으로 동작합니다.)

## 데이터 소스 (모두 무료)

Frankfurter(ECB 환율) · FRED(미 국채 10년, 브렌트유) · OECD SDMX(한국 장기금리, 수출입) · IMF via DBnomics(수출입 백업) · 한국은행 ECOS(선택: 시크릿 `ECOS_API_KEY` 등록 시 국고채 10년 **일별**).

모형 스펙: `ensemble`(통합, 기본: BEER×시장 표본외 가중결합) · `beer`(펀더멘털) · `market`(시장 프록시) · `joint`(결합 회귀, 참고). 페이지의 "모형 비교" 표에서 표본외 검증 지표로 신뢰도를 비교할 수 있습니다.

## 로컬 실행

```bash
node scripts/sync.mjs --dry-run   # 수집·적합 결과만 출력
node scripts/sync.mjs             # data/ 갱신
python3 -m http.server 8000       # http://localhost:8000
```

## 구성

`src/beer-model.js`(모형) · `src/data-sources.js`(수집) · `scripts/sync.mjs`(일일 동기화) · `config/sources.json`(설정) · `assets/app.js`(UI, 의존성 없음)
