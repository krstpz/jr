/**
 * data-sources.js — 외부 데이터 어댑터 (브라우저/Node 공용, fetch 기반)
 *
 * 모든 fetcher 는 [{ date:'YYYY-MM-DD', value:Number }] 형태의 배열을 반환한다.
 *  - Frankfurter (ECB 고시환율, 키 불필요, CORS 허용): 달러/원 및 주요 통화
 *  - FRED 그래프 CSV (키 불필요): 미 국채 10년, 한국 국채 10년(OECD), 브렌트유, 무역수지 등
 *    ※ 브라우저에서는 CORS 로 실패할 수 있음 → GitHub Actions(scripts/sync.mjs)에서 수집해 data/ 에 저장
 *  - CSV(date,value) URL: 사용자가 직접 올린 파일(ECOS 등) 연동용
 */

export const FRANKFURTER_HOSTS = ['https://api.frankfurter.dev/v1', 'https://api.frankfurter.app'];
export const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=';

// ICE 달러인덱스(DXY) 공식 가중치. USD 기준 환율로 계산: 50.14348112 × Π (USD/ccy)^w  (EUR·GBP 는 역수이므로 USD 기준 환율의 양의 지수로 환산됨)
export const DXY_WEIGHTS = { EUR: 0.576, JPY: 0.136, GBP: 0.119, CAD: 0.091, SEK: 0.042, CHF: 0.036 };
export const DXY_CONST = 50.14348112;

function isoDate(d) { return d.toISOString().slice(0, 10); }

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/**
 * Frankfurter 시계열. 연 단위로 나눠 병렬 요청 후 병합.
 * 반환: { KRW:[{date,value}], JPY:[...], ... }  (USD 1단위당 상대통화)
 */
export async function fetchFrankfurter({ base = 'USD', symbols = ['KRW'], start = '2014-01-01', end, fetchImpl = globalThis.fetch, hosts = FRANKFURTER_HOSTS, chunkYears = 1 } = {}) {
  const endDate = end || isoDate(new Date());
  const chunks = [];
  let s = new Date(start + 'T00:00:00Z');
  const e = new Date(endDate + 'T00:00:00Z');
  while (s <= e) {
    const ce = new Date(Date.UTC(s.getUTCFullYear() + chunkYears, 0, 0)); // 해당 연도(들) 12/31
    const chunkEnd = ce < e ? ce : e;
    chunks.push([isoDate(s), isoDate(chunkEnd)]);
    s = new Date(Date.UTC(chunkEnd.getUTCFullYear(), chunkEnd.getUTCMonth(), chunkEnd.getUTCDate() + 1));
  }
  const sym = symbols.join(',');
  let lastErr;
  for (const host of hosts) {
    try {
      const parts = await Promise.all(chunks.map(([a, b]) => getJson(`${host}/${a}..${b}?base=${base}&symbols=${sym}`, fetchImpl)));
      const out = {};
      for (const c of symbols) out[c] = [];
      for (const part of parts) {
        for (const [date, rates] of Object.entries(part.rates || {})) {
          for (const c of symbols) if (rates[c] != null) out[c].push({ date, value: Number(rates[c]) });
        }
      }
      for (const c of symbols) out[c].sort((x, y) => x.date.localeCompare(y.date));
      return out;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('frankfurter: all hosts failed');
}

/** Frankfurter 최근 N일 (라이브 스팟용) */
export async function fetchFrankfurterRecent({ days = 45, symbols = ['KRW'], fetchImpl = globalThis.fetch } = {}) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  return fetchFrankfurter({ symbols, start: isoDate(start), end: isoDate(end), fetchImpl });
}

/** USD 기준 환율 묶음 → DXY 프록시 시계열 (모든 구성통화가 있는 날짜만) */
export function dxyProxy(ratesByCcy) {
  const byDate = new Map();
  for (const [ccy, w] of Object.entries(DXY_WEIGHTS)) {
    for (const p of ratesByCcy[ccy] || []) {
      const acc = byDate.get(p.date) || { logSum: 0, n: 0 };
      acc.logSum += w * Math.log(p.value); acc.n += 1;
      byDate.set(p.date, acc);
    }
  }
  const k = Object.keys(DXY_WEIGHTS).length;
  return [...byDate.entries()].filter(([, a]) => a.n === k)
    .map(([date, a]) => ({ date, value: DXY_CONST * Math.exp(a.logSum) }))
    .sort((x, y) => x.date.localeCompare(y.date));
}

/** 'date,value' 형식 CSV 파싱 (FRED: DATE|observation_date 헤더, 결측 '.') */
export function parseCsvSeries(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const [d, v] = lines[i].split(',').map((s) => s && s.trim());
    if (!d || !/^\d{4}-\d{2}(-\d{2})?$/.test(d)) continue; // 헤더/잡행 스킵
    const num = Number(v);
    if (v === '.' || v === '' || !Number.isFinite(num)) continue;
    out.push({ date: d.length === 7 ? d + '-01' : d, value: num });
  }
  return out;
}

export async function fetchCsvSeries(url, { fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return parseCsvSeries(await res.text());
}

export function fetchFred(seriesId, opts) { return fetchCsvSeries(FRED_CSV + encodeURIComponent(seriesId), opts); }


/**
 * DBnomics 시계열 (키 불필요, CORS 허용). ref 예: 'IMF/IFS/M.KR.TXG_FOB_USD'
 * 월별 period 'YYYY-MM' → 'YYYY-MM-01', 일별은 그대로.
 */
export const DBNOMICS = 'https://api.db.nomics.world/v22/series/';
export async function fetchDbnomics(ref, { fetchImpl = globalThis.fetch } = {}) {
  const data = await getJson(`${DBNOMICS}${ref}?observations=1&format=json`, fetchImpl);
  const doc = data?.series?.docs?.[0];
  if (!doc) throw new Error(`dbnomics: series ${ref} not found`);
  const periods = doc.period_start_day || doc.period || [];
  const out = [];
  periods.forEach((per, i) => {
    const v = Number(doc.value[i]);
    if (!Number.isFinite(v)) return;
    const d = String(per);
    out.push({ date: d.length === 7 ? d + '-01' : d.length === 4 ? d + '-01-01' : d, value: v });
  });
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

/**
 * 한국은행 ECOS OpenAPI (인증키 필요: https://ecos.bok.or.kr 인증키 신청 → 저장소 시크릿 ECOS_API_KEY)
 * ref 예: '817Y002/D/010210000' (통계코드/주기/항목코드1). 주기 D=일, M=월.
 */
export const ECOS = 'https://ecos.bok.or.kr/api/StatisticSearch/';
export async function fetchEcos(ref, { apiKey, fetchImpl = globalThis.fetch, start = '20140101', end } = {}) {
  if (!apiKey) throw new Error('ECOS_API_KEY not set');
  const [stat, cycle, ...items] = ref.split('/');
  const fmt = (d) => (cycle === 'D' ? d.replace(/-/g, '').slice(0, 8) : cycle === 'M' ? d.replace(/-/g, '').slice(0, 6) : d.slice(0, 4));
  const s = fmt(start), e = fmt(end || new Date().toISOString().slice(0, 10));
  const url = `${ECOS}${apiKey}/json/kr/1/100000/${stat}/${cycle}/${s}/${e}/${items.join('/')}`;
  const data = await getJson(url, fetchImpl);
  if (data.RESULT) throw new Error(`ECOS ${data.RESULT.CODE}: ${data.RESULT.MESSAGE}`);
  const rows = data?.StatisticSearch?.row || [];
  return rows.map((r) => {
    const t = String(r.TIME);
    const date = t.length === 8 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : t.length === 6 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-01` : `${t}-01-01`;
    return { date, value: Number(r.DATA_VALUE) };
  }).filter((p) => Number.isFinite(p.value)).sort((x, y) => x.date.localeCompare(y.date));
}

/** 후보 시계열 중 "최신 관측이 maxStaleDays 이내" 인 첫 번째를 채택 (없으면 가장 최신 것) */
export function pickFreshest(candidates, { maxStaleDays = 45, now = new Date() } = {}) {
  const fresh = candidates.filter((c) => c.points.length);
  if (!fresh.length) return null;
  const age = (c) => (now - new Date(c.points.at(-1).date + 'T00:00:00Z')) / 86400000;
  return fresh.find((c) => age(c) <= maxStaleDays) || fresh.sort((a, b) => age(a) - age(b))[0];
}

/** 두 시계열의 월평균 차이 a-b (금리차 등). 월 단위 date('YYYY-MM-01') 로 반환 */
export function monthlyDiff(a, b) {
  const avg = (pts) => {
    const m = new Map();
    for (const p of pts) { const k = p.date.slice(0, 7); const x = m.get(k) || { s: 0, n: 0 }; x.s += p.value; x.n += 1; m.set(k, x); }
    return new Map([...m].map(([k, x]) => [k, x.s / x.n]));
  };
  const A = avg(a), B = avg(b);
  return [...A.keys()].filter((k) => B.has(k)).sort().map((k) => ({ date: k + '-01', value: A.get(k) - B.get(k) }));
}


/** 따옴표를 처리하는 최소 CSV 행 파서 */
export function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** SDMX CSV(OECD·IMF 등: TIME_PERIOD, OBS_VALUE 열) → [{date,value}] */
export function parseSdmxCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  const ti = header.indexOf('TIME_PERIOD'), vi = header.indexOf('OBS_VALUE');
  if (ti < 0 || vi < 0) throw new Error('SDMX CSV: TIME_PERIOD/OBS_VALUE column not found');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    const t = (c[ti] || '').trim(), v = Number(c[vi]);
    if (!/^\d{4}(-\d{2}){0,2}$/.test(t) || !Number.isFinite(v)) continue;
    out.push({ date: t.length === 4 ? t + '-01-01' : t.length === 7 ? t + '-01' : t, value: v });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

/**
 * OECD SDMX API (키 불필요). ref 예: 'OECD.SDD.STES,DSD_STES@DF_FINMARK/KOR.M.IRLT......'
 * 전체 URL 이 필요하면 'sdmxcsv:<url>' 로 지정 (IMF 신규 API 등).
 */
export const OECD_SDMX = 'https://sdmx.oecd.org/public/rest/data/';
export async function fetchSdmxCsv(url, { fetchImpl = globalThis.fetch } = {}) {
  // 주의: OECD SDMX 는 SDMX 미디어타입 Accept 나 압축 인코딩 요청에 500 을 반환하는 경우가 있어
  // 브라우저형 헤더(Accept */*, 압축 없음)로 요청하고, Node 에서 그래도 실패하면 curl 로 한 번 더 시도한다.
  const headers = { Accept: '*/*', 'Accept-Encoding': 'identity', 'User-Agent': 'Mozilla/5.0 (compatible; beer-model-sync; +https://github.com/krstpz/jr)' };
  let text = null, err = null;
  try {
    const res = await fetchImpl(url, { headers });
    if (res.ok) text = await res.text(); else err = new Error(`${res.status} ${res.statusText} for ${url}`);
  } catch (e) { err = e; }
  if (text == null && typeof process !== 'undefined' && process.versions?.node) {
    try {
      const { execFile } = await import('node:child_process');
      text = await new Promise((resolve, reject) => execFile('curl', ['-sS', '-L', '--http1.1', '-m', '90', '-A', headers['User-Agent'], url], { maxBuffer: 64 * 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(out))));
    } catch (e) { err = new Error(`${err?.message || 'fetch failed'}; curl fallback: ${e.message}`); }
  }
  if (text == null) throw err || new Error(`no response for ${url}`);
  return parseSdmxCsv(text);
}
export function fetchOecd(ref, { fetchImpl, start = '2014-01' } = {}) {
  const sep = ref.includes('?') ? '&' : '?';
  return fetchSdmxCsv(`${OECD_SDMX}${ref}${sep}startPeriod=${start}&format=csvfilewithlabels`, { fetchImpl });
}

/** 같은 날짜끼리 차이 a-b (일별-일별) */
export function dailyDiff(a, b) {
  const B = new Map(b.map((p) => [p.date, p.value]));
  return a.filter((p) => B.has(p.date)).map((p) => ({ date: p.date, value: p.value - B.get(p.date) }));
}

/** 수동 CSV(data/manual/<id>.csv) 병합: 같은 날짜는 수동 값 우선 */
export function mergeSeries(auto, manual) {
  const m = new Map((auto || []).map((p) => [p.date, p.value]));
  for (const p of manual || []) m.set(p.date, p.value);
  return [...m].map(([date, value]) => ({ date, value })).sort((x, y) => x.date.localeCompare(y.date));
}

/**
 * config/sources.json 을 해석해 모든 시계열을 수집한다.
 * 반환: { spot:[...], series:{id:[...]}, status:[{id,name,ok,points,lastDate,error}] }
 * options.manual: { id: [{date,value}] }  — 수동 보정 데이터
 */
export async function collectSources(config, { fetchImpl = globalThis.fetch, manual = {}, log = () => {}, ecosKey = '' } = {}) {
  // 12개월 누적(roll12) 드라이버를 위해 표본 시작 1년 전부터 수집
  const start = `${Number((config.sampleStart || '2014-01').slice(0, 4)) - 1}-${(config.sampleStart || '2014-01').slice(5, 7)}-01`;
  const fxSymbols = new Set(['KRW', ...Object.keys(DXY_WEIGHTS)]);
  for (const d of config.drivers) if (d.type === 'frankfurter') fxSymbols.add(d.symbol);
  const status = [];
  const series = {};

  let fx = {};
  try {
    fx = await fetchFrankfurter({ symbols: [...fxSymbols], start, fetchImpl });
    log(`frankfurter ok: ${[...fxSymbols].map((c) => `${c}=${fx[c].length}`).join(' ')}`);
  } catch (e) { log(`frankfurter FAILED: ${e.message}`); status.push({ id: 'frankfurter', name: 'Frankfurter(ECB)', ok: false, error: e.message }); }

  const spot = mergeSeries(fx.KRW || [], manual.spot);
  status.push({ id: 'spot', name: '달러/원 (ECB 고시 기준)', ok: spot.length > 0, points: spot.length, lastDate: spot.at(-1)?.date || null, source: 'frankfurter:KRW' });

  const fredCache = new Map();
  const getFred = async (id) => {
    if (!fredCache.has(id)) fredCache.set(id, fetchFred(id, { fetchImpl }).catch((e) => { throw new Error(`FRED ${id}: ${e.message}`); }));
    return fredCache.get(id);
  };
  const resolveOne = async (ref) => {
    const i = ref.indexOf(':');
    const kind = ref.slice(0, i), id = ref.slice(i + 1);
    if (kind === 'fred') return getFred(id);
    if (kind === 'frankfurter') return fx[id] || [];
    if (kind === 'csv') return fetchCsvSeries(id, { fetchImpl });
    if (kind === 'dbnomics') return fetchDbnomics(id, { fetchImpl });
    if (kind === 'ecos') return fetchEcos(id, { apiKey: ecosKey, fetchImpl, start: start });
    if (kind === 'oecd') return fetchOecd(id, { fetchImpl, start: start.slice(0, 7) });
    if (kind === 'sdmxcsv') return fetchSdmxCsv(id, { fetchImpl });
    throw new Error(`unknown ref ${ref}`);
  };
  // ref 가 배열이면 순서대로 시도해 가장 최신 관측을 가진 소스를 채택(앞쪽 우선). 실패한 후보는 로그만 남김.
  const resolveRef = async (ref, label = '') => {
    const refs = Array.isArray(ref) ? ref : [ref];
    const cands = [];
    for (const r of refs) {
      try { const pts = await resolveOne(r); if (pts.length) cands.push({ ref: r, points: pts }); else log(`${label} ${r}: empty`); }
      catch (e) { log(`${label} ${r}: ${e.message}`); }
    }
    const pick = pickFreshest(cands);
    if (!pick) throw new Error(`no data from ${refs.join(' | ')}`);
    pick.used = pick.ref; return pick;
  };

  for (const d of config.drivers) {
    let pts = [], err = null, src = d.type;
    try {
      if (d.type === 'frankfurter') { pts = fx[d.symbol] || []; src = `frankfurter:${d.symbol}`; }
      else if (d.type === 'frankfurter-dxy') { pts = dxyProxy(fx); src = 'frankfurter:DXY-proxy'; }
      else if (d.type === 'fred') { pts = await getFred(d.series); src = `fred:${d.series}`; }
      else if (d.type === 'csv') { pts = await fetchCsvSeries(d.url, { fetchImpl }); src = d.url; }
      else if (d.type === 'ref') { const r = await resolveRef(d.ref, d.id); pts = r.points; src = r.used; }
      else if (d.type === 'derived' && d.op === 'diff') {
        const [a, b] = await Promise.all([resolveRef(d.a, d.id), resolveRef(d.b, d.id)]);
        pts = d.monthly === false ? dailyDiff(a.points, b.points) : monthlyDiff(a.points, b.points); src = `${a.used} - ${b.used}`;
      }
      else if (d.type === 'manual') { pts = []; src = `manual:${d.id}`; }
      else throw new Error(`unknown driver type ${d.type}`);
    } catch (e) { err = e.message; }
    pts = mergeSeries(pts, manual[d.id]);
    series[d.id] = pts;
    const ok = pts.length > 0;
    status.push({ id: d.id, name: d.name, ok, points: pts.length, lastDate: pts.at(-1)?.date || null, source: src, error: err, manual: !!(manual[d.id] && manual[d.id].length) });
    log(`${d.id}: ${ok ? `${pts.length} pts, last ${pts.at(-1).date}` : 'NO DATA'}${err ? ` (${err})` : ''}`);
  }
  return { spot, series, status };
}

/** collectSources 결과 + config → runModel 입력 */
export function toModelInput(config, collected) {
  return {
    sampleStart: config.sampleStart || '2014-01',
    ci: config.ci ?? 0.9,
    spot: collected.spot,
    drivers: config.drivers.map((d) => ({
      id: d.id, name: d.name, unit: d.unit, transform: d.transform, scale: d.scale, tier: d.tier,
      ffillMax: d.ffillMax, minCoverage: d.minCoverage, maxStaleMonths: d.maxStaleMonths,
      points: collected.series[d.id] || [],
    })),
    specs: config.specs,
  };
}
