/**
 * assets/app.js — 대시보드 UI (index.html / embed.html 공용)
 *
 * 동작 순서
 *  1. data/beer_output.json (GitHub Actions 가 매일 생성) 로드 → 차트/지표 렌더
 *  2. Frankfurter(ECB) 에서 최근 45일 달러/원을 직접 받아 "현재 스팟"·당월 평균을 갱신 (10분마다 반복)
 *  3. 1 이 실패하면(아직 Action 미실행 등) 브라우저에서 직접 수집·적합 (시장 프록시 스펙 위주)
 */
import { runModel, scenarioFair, monthKey, currentMonth } from '../src/beer-model.js';
import { fetchFrankfurterRecent, collectSources, toModelInput } from '../src/data-sources.js';

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmt0 = (v) => fmt(v, 0);
const signed = (v, d = 1) => (v == null ? '–' : (v > 0 ? '+' : '') + fmt(v, d));
const cls = (v) => (v == null ? 'neutral' : v > 0 ? 'up' : v < 0 ? 'down' : 'neutral');
const embed = document.body.dataset.embed === '1';
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

const state = {
  output: null, config: null, mode: 'static', modelId: null,
  range: store.get('beer.range', '10y'),
  live: null,               // { last:{date,value}, mtdAvg, mtdMonth, n, at }
  shocks: {}, error: null,
};

const LIVE_INTERVAL_MS = 10 * 60 * 1000;
const OUTPUT_RECHECK_MS = 60 * 60 * 1000;

// ------------------------------------------------------------------ 데이터 로드
async function loadJson(url) {
  const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function loadOutput() {
  try {
    state.output = await loadJson('data/beer_output.json');
    state.mode = 'static';
  } catch (e) {
    state.mode = 'browser';
    await browserFit();
  }
  const ids = Object.keys(state.output.models).filter((id) => state.output.models[id].ok);
  const stored = store.get('beer.model', '');
  state.modelId = ids.includes(stored) ? stored : state.output.defaultModel;
}

async function browserFit() {
  const config = state.config || (await loadJson('config/sources.json'));
  state.config = config;
  const collected = await collectSources(config, { log: (m) => console.log('[collect]', m) });
  const out = runModel(toModelInput(config, collected));
  out.sources = collected.status;
  out.reference = config.reference || null;
  if (!out.defaultModel) throw new Error('브라우저에서 모형을 적합할 수 없습니다 (데이터 수집 실패).');
  state.output = out;
}

async function refreshLive() {
  try {
    const fx = await fetchFrankfurterRecent({ days: 45, symbols: ['KRW'] });
    const pts = fx.KRW;
    if (!pts.length) throw new Error('no KRW points');
    const last = pts[pts.length - 1];
    const cm = monthKey(last.date);
    const inMonth = pts.filter((p) => monthKey(p.date) === cm);
    state.live = { last, mtdMonth: cm, mtdAvg: inMonth.reduce((s, p) => s + p.value, 0) / inMonth.length, n: inMonth.length, at: new Date(), error: null };
  } catch (e) {
    state.live = { ...(state.live || {}), error: e.message, at: new Date() };
  }
  render();
}

// ------------------------------------------------------------------ 파생 값
function model() { return state.output?.models?.[state.modelId] || null; }

/** 모형 시리즈에 라이브 스팟(당월 MTD 평균)을 반영한 표시용 시리즈 */
function displaySeries(m) {
  const rows = m.series.map((r) => ({ ...r }));
  const live = state.live;
  if (live && live.last && live.mtdAvg) {
    let row = rows.find((r) => r.date === live.mtdMonth);
    if (!row) {
      // 동기화 이후 달이 바뀐 경우: 마지막 적정치를 나우캐스트로 이월
      const prev = [...rows].reverse().find((r) => r.fair != null);
      row = { date: live.mtdMonth, spot: null, fair: prev?.fair ?? null, lo: prev?.lo ?? null, hi: prev?.hi ?? null, gap: null, z: null, nowcast: true, inSample: false, carried: true };
      rows.push(row);
    }
    row.spot = Math.round(live.mtdAvg * 100) / 100;
    row.liveMtd = true;
    if (row.fair != null) {
      row.gap = Math.round((row.spot - row.fair) * 100) / 100;
      row.z = Math.round((Math.log(row.spot / row.fair) / m.stats.sigma) * 1000) / 1000;
    }
  }
  return rows;
}

function latestOf(rows) {
  const r = [...rows].reverse().find((x) => x.spot != null);
  if (!r) return null;
  const gapPct = r.fair ? (r.spot / r.fair - 1) * 100 : null;
  const bandPos = r.fair && r.lo && r.hi ? (r.spot - r.lo) / (r.hi - r.lo) : null;
  return { ...r, gapPct, bandPos };
}

// ------------------------------------------------------------------ 렌더
function render() {
  if (!state.output) return;
  const m = model();
  renderChips(m);
  if (!m) { $('notice').innerHTML = `<div class="notice bad">적합된 모형이 없습니다. 데이터 소스 상태를 확인하세요.</div>`; return; }
  const rows = displaySeries(m);
  const latest = latestOf(rows);
  renderNotice(m);
  renderKpis(m, rows, latest);
  renderSwitches();
  renderChart(m, rows, latest);
  if (!embed) {
    renderScenario(m, latest);
    renderModelTable(m);
    renderCompare();
    renderReference(m, latest);
    renderDataTable(rows);
    renderSources();
    renderIntegration();
    renderFooter();
  }
}

function renderChips(m) {
  const o = state.output;
  const chips = [];
  const gen = new Date(o.generatedAt);
  const ageH = (Date.now() - gen.getTime()) / 3600000;
  chips.push(`<span class="chip ${ageH < 36 ? 'ok' : ageH < 96 ? 'warn' : 'bad'}" title="${o.generatedAt}"><span class="dot"></span>모형 갱신 ${gen.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${state.mode === 'browser' ? ' · 브라우저 간이 모드' : ' · 자동 동기화'}</span>`);
  if (state.live?.last) {
    chips.push(`<span class="chip ok live" title="ECB 고시환율(Frankfurter), 10분마다 갱신"><span class="dot"></span>스팟 ${state.live.last.date} · ${fmt(state.live.last.value, 2)}원</span>`);
  } else if (state.live?.error) {
    chips.push(`<span class="chip warn" title="${state.live.error}"><span class="dot"></span>라이브 스팟 연결 실패</span>`);
  } else {
    chips.push(`<span class="chip"><span class="dot"></span>라이브 스팟 확인 중…</span>`);
  }
  if (m) chips.push(`<span class="chip"><span class="dot" style="background:var(--fair)"></span>${m.name} · 표본 ${m.sample.start}~${m.sample.end} (n=${m.sample.n})</span>`);
  chips.push(`<button class="btn" id="refreshBtn" title="데이터 다시 불러오기">↻ 새로고침</button>`);
  $('chips').innerHTML = chips.join('');
  $('refreshBtn').onclick = async () => { $('refreshBtn').disabled = true; await loadOutput(); await refreshLive(); $('refreshBtn') && ($('refreshBtn').disabled = false); };
}

function renderNotice(m) {
  const notes = [];
  if (state.mode === 'browser') notes.push('<div class="notice">서버 동기화 파일(<code>data/beer_output.json</code>)이 없어 브라우저에서 직접 수집·적합했습니다. 펀더멘털 지표(FRED)는 브라우저 CORS 제한으로 대부분 제외되므로, GitHub Actions 워크플로(<code>Sync BEER model data</code>)를 한 번 실행하면 BEER 스펙이 활성화됩니다.</div>');
  const nowcastDrivers = m.drivers.filter((d) => d.nowcastMonths.length);
  if (nowcastDrivers.length) notes.push(`<div class="notice">나우캐스트: ${nowcastDrivers.map((d) => `${d.name}(최종 ${d.lastDate})`).join(', ')} 는 최근 달 값이 아직 없어 직전 값을 유지했습니다. 지표 발표 후 자동 갱신됩니다.</div>`);
  if (m.dropped.length && !embed) notes.push(`<div class="notice">제외된 드라이버: ${m.dropped.map((d) => `${d.id} (${d.reason})`).join(' · ')}</div>`);
  $('notice').innerHTML = embed ? '' : notes.join('');
}

function renderKpis(m, rows, latest) {
  const live = state.live?.last;
  const liveGap = live && latest?.fair ? live.value - latest.fair : null;
  const ecm = m.ecm?.latest;
  const tiles = [
    { c: 'spot', label: '달러/원 스팟', extra: live ? live.date : '', value: live ? fmt(live.value, 2) : fmt(latest?.spot, 2), unit: '원',
      sub: live && latest?.fair ? `적정 대비 <b class="${cls(liveGap)}">${signed(liveGap, 1)}원</b> (${signed(live.value / latest.fair * 100 - 100, 2)}%)` : 'ECB 고시환율 기준' },
    { c: 'fair', label: 'BEER 적정환율', extra: latest?.date || '', value: fmt(latest?.fair, 0), unit: '원',
      sub: latest?.lo ? `90% 구간 ${fmt0(latest.lo)} ~ ${fmt0(latest.hi)}원${latest.nowcast ? ' · 나우캐스트' : ''}` : '' },
    { c: '', label: '월평균 괴리 (오버슈팅)', extra: latest?.date ? `${latest.date} 평균 ${fmt0(latest.spot)}` : '', value: `<span class="${cls(latest?.gap)}">${signed(latest?.gap, 0)}</span>`, unit: '원',
      sub: latest ? `${signed(latest.gapPct, 1)}% · z = ${fmt(latest.z, 2)} · 밴드 내 위치 ${latest.bandPos == null ? '–' : fmt0(latest.bandPos * 100) + '%'}` : '' },
    { c: '', label: 'ECM 단기 조정', extra: ecm ? ecm.month : '', value: ecm ? `<span class="${cls(ecm.predictedChangeKrw)}">${signed(ecm.predictedChangeKrw, 0)}</span>` : '–', unit: ecm ? '원 적정' : '',
      sub: ecm ? `실제 ${signed(ecm.actualChangeKrw, 0)}원 → 잔여 <b class="${cls(ecm.remainingKrw)}">${signed(ecm.remainingKrw, 0)}원</b>${m.ecm.halfLifeMonths ? ` · 반감기 ${fmt(m.ecm.halfLifeMonths, 1)}개월` : ''}` : 'ECM 미산출' },
  ];
  if (embed) tiles.splice(3, 1);
  $('kpis').innerHTML = tiles.map((t) => `<div class="kpi ${t.c}"><div class="label"><span>${t.label}</span><span>${t.extra}</span></div><div class="value">${t.value}<small>${t.unit}</small></div><div class="sub">${t.sub}</div></div>`).join('');
}

function renderSwitches() {
  const o = state.output;
  const ids = Object.keys(o.models).filter((id) => o.models[id].ok);
  $('modelSwitch').innerHTML = ids.length > 1 ? ids.map((id) => `<button class="btn ${id === state.modelId ? 'active' : ''}" data-model="${id}">${o.models[id].name}</button>`).join('') : '';
  $('modelSwitch').querySelectorAll('button').forEach((b) => (b.onclick = () => { state.modelId = b.dataset.model; store.set('beer.model', state.modelId); state.shocks = {}; render(); }));
  const ranges = [['all', '전체'], ['10y', '10년'], ['5y', '5년'], ['3y', '3년'], ['1y', '1년']];
  $('rangeSwitch').innerHTML = ranges.map(([k, l]) => `<button class="btn ${k === state.range ? 'active' : ''}" data-range="${k}">${l}</button>`).join('');
  $('rangeSwitch').querySelectorAll('button').forEach((b) => (b.onclick = () => { state.range = b.dataset.range; store.set('beer.range', state.range); render(); }));
}

// ------------------------------------------------------------------ SVG 차트
function renderChart(m, allRows, latest) {
  const box = $('chart');
  const W = Math.max(320, box.clientWidth || 900);
  const H = embed ? Math.max(240, Math.round(W * 0.42)) : Math.max(300, Math.round(W * 0.46));
  const pad = { l: 52, r: 96, t: 16, b: 34 };
  const yearsBack = { all: Infinity, '10y': 10, '5y': 5, '3y': 3, '1y': 1 }[state.range] ?? 10;
  const lastIdx = allRows.length - 1;
  const startIdx = Number.isFinite(yearsBack) ? Math.max(0, lastIdx - yearsBack * 12) : 0;
  const rows = allRows.slice(startIdx).filter((r) => r.spot != null || r.fair != null);
  if (!rows.length) { box.innerHTML = '<p class="muted">표시할 데이터가 없습니다.</p>'; return; }

  const vals = [];
  for (const r of rows) for (const k of ['spot', 'lo', 'hi']) if (r[k] != null) vals.push(r[k]);
  if (state.live?.last) vals.push(state.live.last.value);
  const yMinRaw = Math.min(...vals), yMaxRaw = Math.max(...vals);
  const step = niceStep((yMaxRaw - yMinRaw) / 5);
  const yMin = Math.floor((yMinRaw - step * 0.3) / step) * step;
  const yMax = Math.ceil((yMaxRaw + step * 0.3) / step) * step;
  const n = rows.length;
  const x = (i) => pad.l + (i / Math.max(1, n - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);

  // 밴드 폴리곤
  const bandIdx = rows.map((r, i) => (r.lo != null ? i : -1)).filter((i) => i >= 0);
  const bandPath = bandIdx.length ? `M${bandIdx.map((i) => `${x(i).toFixed(1)},${y(rows[i].hi).toFixed(1)}`).join('L')}L${[...bandIdx].reverse().map((i) => `${x(i).toFixed(1)},${y(rows[i].lo).toFixed(1)}`).join('L')}Z` : '';
  const linePath = (key, pred) => {
    let d = '', pen = false;
    rows.forEach((r, i) => {
      if (r[key] == null || (pred && !pred(r, i))) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[key]).toFixed(1)}`; pen = true;
    });
    return d;
  };
  const isNow = (r) => r.nowcast;
  // 나우캐스트 구간은 직전 정상 점부터 이어 점선으로
  const fairSolid = linePath('fair', (r) => !isNow(r));
  const fairDash = linePath('fair', (r, i) => isNow(r) || (rows[i + 1] && isNow(rows[i + 1])));

  // 눈금
  const yTicks = [];
  for (let v = yMin; v <= yMax + 1e-9; v += step) yTicks.push(v);
  const yearTicks = rows.map((r, i) => ({ i, yr: r.date.slice(0, 4), mo: r.date.slice(5) })).filter((t) => t.mo === '01' || (n <= 14));
  const tickEvery = Math.max(1, Math.ceil(yearTicks.length / Math.max(2, Math.floor((W - pad.l - pad.r) / 56))));

  const lastSpotIdx = rows.map((r, i) => (r.spot != null ? i : -1)).filter((i) => i >= 0).pop();
  const lastFairIdx = rows.map((r, i) => (r.fair != null ? i : -1)).filter((i) => i >= 0).pop();
  const liveDot = state.live?.last && lastSpotIdx != null ? { cx: x(lastSpotIdx), cy: y(state.live.last.value) } : null;

  const svg = `
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="달러/원 환율과 BEER 적정환율, 90% 신뢰구간">
  <g class="grid">${yTicks.map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--grid)" />`).join('')}</g>
  <g font-size="11" fill="var(--ink-3)">
    ${yTicks.map((v) => `<text x="${pad.l - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v.toLocaleString()}</text>`).join('')}
    ${yearTicks.filter((_, k) => k % tickEvery === 0).map((t) => `<text x="${x(t.i).toFixed(1)}" y="${H - pad.b + 18}" text-anchor="middle">${n <= 14 ? t.yr.slice(2) + '.' + t.mo : t.yr}</text>`).join('')}
  </g>
  <line x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}" stroke="var(--axis)" />
  ${bandPath ? `<path d="${bandPath}" fill="var(--band)" stroke="none" />` : ''}
  <path d="${fairSolid}" fill="none" stroke="var(--fair)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" />
  ${fairDash ? `<path d="${fairDash}" fill="none" stroke="var(--fair)" stroke-width="2.4" stroke-dasharray="5 4" stroke-linecap="round" />` : ''}
  <path d="${linePath('spot')}" fill="none" stroke="var(--spot)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
  ${liveDot ? `<circle cx="${liveDot.cx.toFixed(1)}" cy="${liveDot.cy.toFixed(1)}" r="4.5" fill="var(--spot)" stroke="var(--surface)" stroke-width="2"><title>라이브 스팟 ${state.live.last.date}: ${fmt(state.live.last.value, 2)}</title></circle>` : ''}
  <g font-size="11.5" font-weight="600">
    ${lastSpotIdx != null ? `<text x="${(x(lastSpotIdx) + 8).toFixed(1)}" y="${(y(rows[lastSpotIdx].spot) + 4).toFixed(1)}" fill="var(--spot)">달러/원 ${fmt0(rows[lastSpotIdx].spot)}</text>` : ''}
    ${lastFairIdx != null ? `<text x="${(x(lastFairIdx) + 8).toFixed(1)}" y="${labelY(y(rows[lastFairIdx].fair), lastSpotIdx != null ? y(rows[lastSpotIdx].spot) : null).toFixed(1)}" fill="var(--fair)">적정 ${fmt0(rows[lastFairIdx].fair)}</text>` : ''}
  </g>
  <g id="crosshair" style="display:none"><line id="chX" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--ink-3)" stroke-dasharray="3 3" /><circle id="chSpot" r="4" fill="var(--spot)" stroke="var(--surface)" stroke-width="1.5" /><circle id="chFair" r="4" fill="var(--fair)" stroke="var(--surface)" stroke-width="1.5" /></g>
  <rect id="hit" x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}" fill="transparent" />
</svg><div class="tip" id="tip"></div>`;
  box.innerHTML = svg;

  // 호버
  const svgEl = box.querySelector('svg'), hit = box.querySelector('#hit'), tip = box.querySelector('#tip');
  const ch = box.querySelector('#crosshair'), chX = box.querySelector('#chX'), chS = box.querySelector('#chSpot'), chF = box.querySelector('#chFair');
  const move = (ev) => {
    const rect = svgEl.getBoundingClientRect();
    const px = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left) * (W / rect.width);
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
    const r = rows[i];
    ch.style.display = '';
    chX.setAttribute('x1', x(i)); chX.setAttribute('x2', x(i));
    if (r.spot != null) { chS.style.display = ''; chS.setAttribute('cx', x(i)); chS.setAttribute('cy', y(r.spot)); } else chS.style.display = 'none';
    if (r.fair != null) { chF.style.display = ''; chF.setAttribute('cx', x(i)); chF.setAttribute('cy', y(r.fair)); } else chF.style.display = 'none';
    tip.style.display = 'block';
    tip.innerHTML = `<b>${r.date}</b>${r.liveMtd ? ' <span class="muted">(당월 평균, 라이브)</span>' : r.nowcast ? ' <span class="muted">(나우캐스트)</span>' : ''}
      <div class="row"><span><i style="background:var(--spot)"></i>달러/원</span><b>${fmt(r.spot, 1)}</b></div>
      <div class="row"><span><i style="background:var(--fair)"></i>BEER 적정</span><b>${fmt(r.fair, 1)}</b></div>
      <div class="row"><span><i style="background:var(--band);border:1px solid var(--band-line)"></i>90% 구간</span><span>${fmt0(r.lo)} ~ ${fmt0(r.hi)}</span></div>
      <div class="row"><span>괴리</span><span class="${cls(r.gap)}">${signed(r.gap, 1)}원${r.z != null ? ` (z ${fmt(r.z, 2)})` : ''}</span></div>`;
    const tipW = tip.offsetWidth || 180;
    const leftPx = (x(i) / W) * rect.width;
    tip.style.left = `${leftPx + 14 + tipW > rect.width ? leftPx - tipW - 14 : leftPx + 14}px`;
    tip.style.top = `${Math.max(0, ((ev.touches ? ev.touches[0].clientY : ev.clientY) - rect.top) - 40)}px`;
  };
  const leave = () => { ch.style.display = 'none'; tip.style.display = 'none'; };
  hit.addEventListener('mousemove', move); hit.addEventListener('touchmove', move, { passive: true });
  hit.addEventListener('mouseleave', leave); hit.addEventListener('touchend', leave);

  $('chartNote').textContent = `${rows[0].date} ~ ${rows[n - 1].date} 월평균. 점선은 일부 지표 미발표로 직전 값을 유지한 나우캐스트 구간. 마지막 점은 ${state.live?.mtdAvg ? `당월 ${state.live.n}영업일 평균(라이브)` : '동기화 시점 월평균'}. 밴드 = 적정환율 ± ${m.stats.bandHalfWidthPct}% (잔차 표준편차 ${m.stats.sigmaPct}% × 1.645).`;
}
function labelY(yFair, ySpot) { if (ySpot == null) return yFair + 4; return Math.abs(yFair - ySpot) < 14 ? (yFair > ySpot ? ySpot + 18 : ySpot - 10) : yFair + 4; }
function niceStep(raw) { const p = 10 ** Math.floor(Math.log10(raw)); const f = raw / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; }

// ------------------------------------------------------------------ 시나리오
function renderScenario(m, latest) {
  const el = $('scenario');
  const specs = m.drivers.map((d) => {
    if (d.transform === 'log') return { d, min: -20, max: 20, step: 0.5, unit: '%', label: `${d.name} 변화` };
    if (d.transform === 'roll12') return { d, min: -100, max: 100, step: 5, unit: d.unit, label: `${d.name} 변화` };
    return { d, min: -1.5, max: 1.5, step: 0.05, unit: d.unit, label: `${d.name} 변화` };
  });
  el.innerHTML = specs.map((s) => `<div class="row"><label for="sh-${s.d.id}">${s.label}</label><input type="range" id="sh-${s.d.id}" min="${s.min}" max="${s.max}" step="${s.step}" value="${state.shocks[s.d.id] ?? 0}"><span class="val" id="shv-${s.d.id}"></span></div>`).join('') +
    `<div class="row"><span></span><span></span><button class="btn" id="shReset">초기화</button></div>`;
  const update = () => {
    for (const s of specs) {
      const v = Number($(`sh-${s.d.id}`).value);
      state.shocks[s.d.id] = v;
      $(`shv-${s.d.id}`).textContent = `${v > 0 ? '+' : ''}${v}${s.unit === '%' ? '%' : ' ' + s.unit}`;
    }
    const fair = scenarioFair(m, state.shocks);
    const base = m.latest?.fair;
    const spot = state.live?.last?.value ?? latest?.spot;
    $('scenarioResult').innerHTML = fair ? `<div><div class="small muted">시나리오 적정환율</div><div class="big">${fmt0(fair)}원</div></div>
      <div><div class="small muted">기준 적정 대비</div><div class="${cls(fair - base)}" style="font-weight:700">${signed(fair - base, 0)}원</div></div>
      <div><div class="small muted">현재 스팟(${fmt0(spot)}) 대비 괴리</div><div class="${cls(spot - fair)}" style="font-weight:700">${signed(spot - fair, 0)}원</div></div>
      <div class="small muted" style="flex-basis:100%">${m.drivers.map((d) => `${d.name} ${d.sensitivity.per} → ${signed(d.sensitivity.krw, 1)}원`).join(' · ')}</div>` : '';
  };
  specs.forEach((s) => ($(`sh-${s.d.id}`).oninput = update));
  $('shReset').onclick = () => { specs.forEach((s) => ($(`sh-${s.d.id}`).value = 0)); update(); };
  update();
}

// ------------------------------------------------------------------ 표
function renderCompare() {
  const o = state.output;
  const ms = Object.values(o.models).filter((x) => x.ok);
  if (ms.length < 2) { $('compareCard').style.display = 'none'; return; }
  $('compareCard').style.display = '';
  const best = (key, dir) => { const vals = ms.map((x) => key(x)).filter((v) => v != null); return vals.length ? (dir > 0 ? Math.max(...vals) : Math.min(...vals)) : null; };
  const cell = (v, fmtF, isBest) => `<td class="${isBest ? 'down' : ''}" style="${isBest ? 'font-weight:700' : ''}">${fmtF(v)}</td>`;
  const rows = ms.map((x) => {
    const oosS = x.oos?.longRun?.sigmaPct ?? null, skill = x.oos?.ecm?.skill ?? null, hit = x.oos?.ecm?.hitRate ?? null;
    return `<tr><td>${x.id === state.modelId ? '<b>' + x.name + '</b>' : x.name}<div class="muted small">${x.description || ''}</div></td>
      ${cell(x.stats.r2, (v) => fmt(v, 3), x.stats.r2 === best((y) => y.stats.r2, 1))}
      ${cell(x.stats.sigmaPct, (v) => fmt(v, 2) + '%', x.stats.sigmaPct === best((y) => y.stats.sigmaPct, -1))}
      ${cell(oosS, (v) => (v == null ? '–' : fmt(v, 2) + '%'), oosS != null && oosS === best((y) => y.oos?.longRun?.sigmaPct ?? null, -1))}
      ${cell(skill, (v) => (v == null ? '–' : signed(v * 100, 0) + '%'), skill != null && skill === best((y) => y.oos?.ecm?.skill ?? null, 1))}
      ${cell(hit, (v) => (v == null ? '–' : fmt0(v * 100) + '%'), hit != null && hit === best((y) => y.oos?.ecm?.hitRate ?? null, 1))}
      <td>${x.ecm && !x.ecm.error ? `${x.ecm.gamma.toFixed(3)} <span class="muted">(t ${x.ecm.gammaT.toFixed(1)})</span>` : '–'}</td>
      <td>${fmt0(x.latest?.fair)}</td><td class="${cls(x.latest?.gap)}">${signed(x.latest?.gap, 0)}</td></tr>`;
  }).join('');
  $('compareTable').innerHTML = `<thead><tr><th>모형</th><th>R²</th><th>표본내 σ</th><th>표본외 σ</th><th>ECM 예측력</th><th>방향 적중</th><th>수렴 γ</th><th>적정</th><th>괴리</th></tr></thead><tbody>${rows}</tbody>`;
  const ref = ms[0].oos;
  $('compareNote').textContent = ref ? `표본외(pseudo out-of-sample): 처음 ${ref.minTrainMonths}개월로 적합한 뒤 다음 ${ref.blockMonths}개월을 예측하고 창을 넓혀 반복. 표본외 σ = 적정환율 예측오차, ECM 예측력 = 월간 변동 예측 RMSE 가 "변동 없음" 기준선보다 얼마나 작은지(1 − RMSE/기준), 방향 적중 = 월간 등락 방향 일치 비율. 굵은 값이 각 항목 최우수.` : '';
}

function renderModelTable(m) {
  $('modelMeta').textContent = `${m.name} · ${m.ensemble ? '가중결합' : 'log(달러/원) 회귀'} · R² ${m.stats.r2} · σ ${m.stats.sigmaPct}%${m.oos?.longRun?.sigmaPct != null ? ` · 표본외 σ ${m.oos.longRun.sigmaPct}%` : ''}`;
  const rowsHtml = m.drivers.map((d) => `<tr><td>${d.name}<div class="muted small">${d.transform === 'log' ? 'log' : d.transform === 'roll12' ? '12M 누적' : '수준'} · ${d.tier}${d.nowcastMonths.length ? ' · 나우캐스트' : ''}</div></td><td>${d.coef.toFixed(4)}</td><td>${d.tstat == null ? '<span class="muted">혼합</span>' : d.tstat.toFixed(2)}</td><td>${d.sensitivity.per}</td><td class="${cls(d.sensitivity.krw)}">${signed(d.sensitivity.krw, 1)}원</td><td class="muted">${d.lastDate || ''}</td></tr>`).join('');
  $('modelTable').innerHTML = `<thead><tr><th>드라이버</th><th>계수</th><th>t</th><th>충격</th><th>적정환율 반응</th><th>최종 관측</th></tr></thead><tbody>${rowsHtml}<tr><td>상수항</td><td>${m.intercept.coef.toFixed(4)}</td><td>${m.intercept.tstat == null ? '<span class="muted">혼합</span>' : m.intercept.tstat.toFixed(2)}</td><td colspan="3"></td></tr></tbody>`;
  const ecm = m.ecm && !m.ecm.error ? `ECM: Δlog(S) = α + γ·e(t−1) + Σβ·Δx, γ = ${m.ecm.gamma.toFixed(3)} (t ${m.ecm.gammaT.toFixed(2)}), R² ${m.ecm.r2.toFixed(3)}, n=${m.ecm.n}${m.ecm.halfLifeMonths ? `, 괴리 반감기 ${m.ecm.halfLifeMonths.toFixed(1)}개월` : ''}.` : 'ECM 미산출.';
  const ens = m.ensemble ? `가중결합: ${m.ensemble.members.map((x) => `${x.name} ${fmt0(x.weight * 100)}% (표본외 σ ${x.oosSigmaPct}%)`).join(' + ')} — 표본외 예측오차의 역분산 가중. 계수는 멤버 계수의 가중평균(t값 없음). ` : '';
  $('modelNote').textContent = `${ens}장기식: log(달러/원) = 상수 + Σ 계수 × 드라이버 (월평균${m.ensemble ? '' : ', OLS'}, 표본 ${m.sample.start}~${m.sample.end}). 신뢰구간은 잔차 표준편차 기준 ±1.645σ. ${ecm}`;
}

function renderReference(m, latest) {
  const ref = state.output.reference;
  if (!ref) { $('refCard').style.display = 'none'; return; }
  $('refLabel').textContent = ref.label;
  const refRow = m.series.find((r) => r.date === ref.asOf);
  const sp = m.drivers.find((d) => d.id === 'spread10y');
  const items = [
    { l: `적정환율 (${ref.asOf})`, v: `${fmt0(ref.fair)}원`, m: refRow?.fair ? `본 모형 ${fmt0(refRow.fair)}원` : '본 모형: 해당 월 없음' },
    { l: `${ref.asOf} 월평균`, v: `${fmt0(ref.monthAvg)}원`, m: refRow?.spot ? `본 데이터 ${fmt0(refRow.spot)}원 (ECB 기준)` : '' },
    { l: '오버슈팅', v: `${signed(ref.overshoot, 0)}원`, m: refRow?.gap != null ? `본 모형 ${signed(refRow.gap, 0)}원` : '' },
    { l: 'ECM 적정 월간 변동 / 실제', v: `${signed(ref.ecmFairChange, 0)} / ${signed(ref.ecmActualChange, 0)}원`, m: m.ecm?.latest ? `본 모형(${m.ecm.latest.month}) ${signed(m.ecm.latest.predictedChangeKrw, 0)} / ${signed(m.ecm.latest.actualChangeKrw, 0)}원` : '' },
    { l: '금리차 10bp 축소 시', v: `${signed(ref.sensitivitySpread10bp, 1)}원`, m: sp ? `본 모형 ${signed(-sp.sensitivity.krw, 1)}원` : '본 모형: 금리차 미포함' },
    { l: '5월 예상 레인지', v: `${fmt0(ref.rangeLow)} ~ ${fmt0(ref.rangeHigh)}원`, m: latest ? `현재 ${fmt0(state.live?.last?.value ?? latest.spot)}원` : '' },
  ];
  $('refGrid').innerHTML = items.map((i) => `<div><div class="l">${i.l}</div><div class="v">${i.v}</div><div class="m">${i.m}</div></div>`).join('');
}

function renderDataTable(rows) {
  const body = [...rows].reverse().map((r) => `<tr><td>${r.date}${r.liveMtd ? ' <span class="muted">(라이브)</span>' : r.nowcast ? ' <span class="muted">(나우캐스트)</span>' : ''}</td><td>${fmt(r.spot, 1)}</td><td>${fmt(r.fair, 1)}</td><td>${fmt0(r.lo)}</td><td>${fmt0(r.hi)}</td><td class="${cls(r.gap)}">${signed(r.gap, 1)}</td><td>${fmt(r.z, 2)}</td></tr>`).join('');
  $('dataTable').innerHTML = `<thead><tr><th>월</th><th>달러/원</th><th>적정</th><th>하단</th><th>상단</th><th>괴리(원)</th><th>z</th></tr></thead><tbody>${body}</tbody>`;
}

function renderSources() {
  const s = state.output.sources || [];
  $('sourceTable').innerHTML = `<thead><tr><th>시계열</th><th>상태</th><th>포인트</th><th>최종일</th><th>소스</th></tr></thead><tbody>` +
    s.map((r) => `<tr><td>${r.name}</td><td>${r.ok ? '<span class="down">정상</span>' : `<span class="up">실패</span>`}${r.manual ? ' · 수동보정' : ''}${r.error ? `<div class="muted small">${r.error}</div>` : ''}</td><td>${r.points ?? ''}</td><td>${r.lastDate ?? ''}</td><td class="muted">${r.source ?? ''}</td></tr>`).join('') + '</tbody>';
}

function renderIntegration() {
  const base = location.href.replace(/[^/]*$/, '');
  $('integration').innerHTML = `
<p class="small">정적 JSON 을 그대로 가져다 쓰면 됩니다. 매일 GitHub Actions 가 갱신하며 CORS 제한이 없습니다.</p>
<pre>// 최신 값만 (경량)
fetch('${base}data/latest.json').then(r =&gt; r.json()).then(d =&gt; console.log(d.latest.fair, d.latest.gap));

// 전체 시계열·계수·신뢰구간
fetch('${base}data/beer_output.json').then(r =&gt; r.json())
  .then(o =&gt; o.models[o.defaultModel].series);   // [{date, spot, fair, lo, hi, gap, z, nowcast}]

// 차트만 iframe 으로 삽입
&lt;iframe src="${base}embed.html" width="100%" height="640" style="border:0" loading="lazy"&gt;&lt;/iframe&gt;

// 모형을 직접 돌리기 (브라우저/Node 공용 ESM)
import { runModel } from '${base}src/beer-model.js';</pre>
<p class="small">스키마와 모형 정의는 <a href="docs/INTEGRATION.md">docs/INTEGRATION.md</a> 참고.</p>`;
}

function renderFooter() {
  $('footer').innerHTML = `자료: Frankfurter(ECB 고시환율 · 달러/원, 달러인덱스 산출), FRED(미 국채 10년 DGS10, 브렌트유 DCOILBRENTEU), OECD SDMX(한국 장기금리 월별), IMF(한국 수출입 월별), 한국은행 ECOS(설정 시 국고채 10년 일별). 모형·수치는 정보 제공 목적이며 투자 판단의 근거가 아닙니다. 리포트 기준값은 KB국민은행 자본시장사업그룹 「5월 달러/원 전망」(2026.04) 인용.<br>
ECB 고시환율은 서울외환시장 종가와 소폭 차이가 있을 수 있습니다. 소스: <a href="https://github.com/krstpz/jr">github.com/krstpz/jr</a>`;
}

// ------------------------------------------------------------------ 시작
async function main() {
  try {
    await loadOutput();
    render();
  } catch (e) {
    $('notice').innerHTML = `<div class="notice bad">데이터를 불러오지 못했습니다: ${e.message}</div>`;
    console.error(e);
  }
  refreshLive();
  setInterval(refreshLive, LIVE_INTERVAL_MS);
  setInterval(async () => { try { await loadOutput(); render(); } catch (e) { console.warn(e); } }, OUTPUT_RECHECK_MS);
  let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(render, 120); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.live?.at && Date.now() - state.live.at > LIVE_INTERVAL_MS) refreshLive(); });
}
main();
