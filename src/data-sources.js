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
export async function collectSources(config, { fetchImpl = globalThis.fetch, manual = {}, log = () => {} } = {}) {
  const start = (config.sampleStart || '2014-01') + '-01';
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
  const resolveRef = async (ref) => {
    const [kind, id] = ref.split(':');
    if (kind === 'fred') return getFred(id);
    if (kind === 'frankfurter') return fx[id] || [];
    if (kind === 'csv') return fetchCsvSeries(id, { fetchImpl });
    throw new Error(`unknown ref ${ref}`);
  };

  for (const d of config.drivers) {
    let pts = [], err = null, src = d.type;
    try {
      if (d.type === 'frankfurter') { pts = fx[d.symbol] || []; src = `frankfurter:${d.symbol}`; }
      else if (d.type === 'frankfurter-dxy') { pts = dxyProxy(fx); src = 'frankfurter:DXY-proxy'; }
      else if (d.type === 'fred') { pts = await getFred(d.series); src = `fred:${d.series}`; }
      else if (d.type === 'csv') { pts = await fetchCsvSeries(d.url, { fetchImpl }); src = d.url; }
      else if (d.type === 'derived' && d.op === 'diff') { const [a, b] = await Promise.all([resolveRef(d.a), resolveRef(d.b)]); pts = monthlyDiff(a, b); src = `${d.a} - ${d.b}`; }
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
