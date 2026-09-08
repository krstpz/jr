/**
 * beer-model.js — 행태균형환율(BEER) + 오차수정모형(ECM) 순수 계산 모듈
 *
 * 브라우저(ESM)와 Node(>=18) 양쪽에서 그대로 동작한다. 네트워크·DOM 의존성 없음.
 *
 * 입력(runModel):
 *   {
 *     spot:    [{ date:'YYYY-MM-DD', value:Number }],        // 달러/원 일별(또는 월별) 시계열
 *     drivers: [{ id, name, unit, transform, points:[{date,value}], ffillMax?, minCoverage?, maxStaleMonths? }],
 *     specs:   [{ id, name, drivers:[driverId...], required?:[driverId...] }],
 *     sampleStart:'YYYY-MM', sampleEnd?:'YYYY-MM', ci?:0.90
 *   }
 * 출력: docs/INTEGRATION.md 의 "beer_output.json 스키마" 참고.
 */

export const Z_TABLE = { 0.8: 1.2816, 0.9: 1.6449, 0.95: 1.96, 0.99: 2.5758 };

// ---------- 날짜/시계열 유틸 ----------
export function monthKey(date) {
  return String(date).slice(0, 7);
}

export function monthRange(startYm, endYm) {
  const out = [];
  let [y, m] = startYm.split('-').map(Number);
  const [ey, em] = endYm.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

export function addMonths(ym, n) {
  let [y, m] = ym.split('-').map(Number);
  m += n;
  while (m > 12) { m -= 12; y += 1; }
  while (m < 1) { m += 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function currentMonth(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 일별 포인트 → 월평균 Map('YYYY-MM' → avg). 값이 유한하지 않은 포인트는 무시. */
export function monthlyAverage(points) {
  const acc = new Map();
  for (const p of points || []) {
    const v = Number(p.value);
    if (!Number.isFinite(v)) continue;
    const k = monthKey(p.date);
    const a = acc.get(k) || { sum: 0, n: 0 };
    a.sum += v; a.n += 1;
    acc.set(k, a);
  }
  const out = new Map();
  for (const [k, a] of acc) out.set(k, a.sum / a.n);
  return out;
}

/** 월별 시계열에 변환 적용. */
export function transformMonthly(monthlyMap, months, transform, scale = 1) {
  const out = new Map();
  if (transform === 'roll12') {
    // 12개월 누적합 (달의 값이 없으면 누적값도 없음)
    for (let i = 0; i < months.length; i++) {
      let sum = 0, ok = true;
      for (let j = i - 11; j <= i; j++) {
        if (j < 0) { ok = false; break; }
        const v = monthlyMap.get(months[j]);
        if (v === undefined) { ok = false; break; }
        sum += v * scale;
      }
      if (ok) out.set(months[i], sum);
    }
    return out;
  }
  for (const m of months) {
    const v = monthlyMap.get(m);
    if (v === undefined) continue;
    const s = v * scale;
    if (transform === 'log') { if (s > 0) out.set(m, Math.log(s)); }
    else out.set(m, s);
  }
  return out;
}

/** 표본 끝쪽의 결측을 최대 ffillMax 개월까지 직전 값으로 채움(나우캐스트). 채운 달은 filled Set 에 기록. */
export function forwardFillTail(map, months, ffillMax) {
  const filled = new Set();
  let last, gap = 0;
  for (const m of months) {
    if (map.has(m)) { last = map.get(m); gap = 0; continue; }
    if (last === undefined) continue;
    gap += 1;
    if (gap <= ffillMax) { map.set(m, last); filled.add(m); }
  }
  return filled;
}

// ---------- 선형대수 (소규모 OLS 전용) ----------
export function invert(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('singular matrix (drivers collinear?)');
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row) => row.slice(n));
}

/** OLS: X 는 [n][k] (상수항 포함 여부는 호출자 책임), y 는 [n]. */
export function ols(X, y) {
  const n = X.length, k = X[0].length;
  if (n <= k) throw new Error(`not enough observations (n=${n}, k=${k})`);
  const XtX = Array.from({ length: k }, () => Array(k).fill(0));
  const Xty = Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = a; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) XtX[a][b] = XtX[b][a];
  const inv = invert(XtX);
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));
  const fitted = X.map((row) => row.reduce((s, v, j) => s + v * beta[j], 0));
  const resid = y.map((v, i) => v - fitted[i]);
  const ssr = resid.reduce((s, e) => s + e * e, 0);
  const ybar = y.reduce((s, v) => s + v, 0) / n;
  const sst = y.reduce((s, v) => s + (v - ybar) ** 2, 0);
  const sigma2 = ssr / (n - k);
  const se = inv.map((row, i) => Math.sqrt(Math.max(sigma2 * row[i], 0)));
  const tstat = beta.map((b, i) => (se[i] > 0 ? b / se[i] : NaN));
  return { beta, se, tstat, fitted, resid, sigma: Math.sqrt(sigma2), r2: sst > 0 ? 1 - ssr / sst : NaN, n, k };
}

// ---------- 드라이버 전처리 ----------
function prepareDriver(d, months, sampleEnd) {
  const monthly = monthlyAverage(d.points);
  const dates = (d.points || []).map((p) => String(p.date)).filter(Boolean).sort();
  const lastDate = dates.length ? dates[dates.length - 1] : null;
  const firstDate = dates.length ? dates[0] : null;
  const series = transformMonthly(monthly, months, d.transform || 'level', d.scale ?? 1);
  const maxStale = d.maxStaleMonths ?? 6;
  const staleMonths = lastDate ? monthRange(monthKey(lastDate), sampleEnd).length - 1 : Infinity;
  const filled = forwardFillTail(series, months, d.ffillMax ?? 3);
  const coverage = series.size / months.length;
  const minCoverage = d.minCoverage ?? 0.9;
  let excluded = null;
  if (!dates.length) excluded = 'no data';
  else if (staleMonths > maxStale) excluded = `stale: last observation ${lastDate} (${staleMonths} months old)`;
  else if (coverage < minCoverage) excluded = `coverage ${(coverage * 100).toFixed(0)}% < ${(minCoverage * 100).toFixed(0)}%`;
  return {
    id: d.id, name: d.name || d.id, unit: d.unit || '', transform: d.transform || 'level', tier: d.tier || '',
    series, filled, firstDate, lastDate, coverage, excluded,
  };
}

function sensitivity(driver, beta, fairLevel) {
  // 드라이버 1단위 변화 → 적정환율(원) 변화. 로그 드라이버는 1% 변화, 수준(금리차 %p)은 10bp 변화 기준.
  if (driver.transform === 'log') {
    return { per: '+1%', krw: fairLevel * (Math.exp(beta * Math.log(1.01)) - 1) };
  }
  if (driver.transform === 'roll12') {
    return { per: `+10 ${driver.unit || 'unit'}`, krw: fairLevel * (Math.exp(beta * 10) - 1) };
  }
  if (/%p|bp|pp/.test(driver.unit || '')) {
    return { per: '+10bp', krw: fairLevel * (Math.exp(beta * 0.1) - 1) };
  }
  return { per: `+1 ${driver.unit || 'unit'}`, krw: fairLevel * (Math.exp(beta) - 1) };
}

// ---------- 모델 적합 ----------
/** 장기식 OLS: 스팟 + 모든 드라이버가 있고 ffill 로 채우지 않은 달만 사용 */
function fitLongRun(usable, months, logSpot) {
  const fitMonths = months.filter((m) => logSpot.has(m) && usable.every((d) => d.series.has(m) && !d.filled.has(m)));
  if (fitMonths.length <= usable.length + 2) return null;
  const X = fitMonths.map((m) => [1, ...usable.map((d) => d.series.get(m))]);
  const y = fitMonths.map((m) => logSpot.get(m));
  const fit = ols(X, y);
  const yhat = (m) => fit.beta[0] + usable.reduce((s, d, i) => s + fit.beta[i + 1] * d.series.get(m), 0);
  const residMap = new Map();
  fitMonths.forEach((m, i) => residMap.set(m, fit.resid[i]));
  return { fit, fitMonths, yhat, residMap };
}

/** ECM 행 구성: Δy_t = α + γ·e_{t-1} + Σβ_i·Δx_{i,t}. residOf(m) 는 장기식 잔차(없으면 null) */
function ecmRows(usable, months, logSpot, residOf) {
  const rows = [];
  for (let i = 1; i < months.length; i++) {
    const m = months[i], p = months[i - 1];
    if (!logSpot.has(m) || !logSpot.has(p)) continue;
    const e = residOf(p);
    if (e == null) continue;
    if (!usable.every((d) => d.series.has(m) && d.series.has(p) && !d.filled.has(m))) continue;
    rows.push({ m, p, x: [1, e, ...usable.map((d) => d.series.get(m) - d.series.get(p))], y: logSpot.get(m) - logSpot.get(p) });
  }
  return rows;
}

/**
 * 유사 표본외(pseudo out-of-sample) 검증: 최소 minTrain 개월로 적합 → 다음 block 개월 예측, 창을 확장하며 반복.
 * 장기식 OOS 잔차 σ 와, ECM 의 월간 변동 예측 RMSE·방향 적중률을 돌려준다.
 */
function pseudoOutOfSample(usable, months, logSpot, { minTrain = 60, block = 12 } = {}) {
  const lrErr = [], ecmPred = [], ecmAct = [], ecmPrev = [];
  for (let start = minTrain; start < months.length; start += block) {
    const train = months.slice(0, start), test = months.slice(start, start + block);
    let lr;
    try { lr = fitLongRun(usable, train, logSpot); } catch { lr = null; }
    if (!lr) continue;
    const residAny = (m) => (logSpot.has(m) && usable.every((d) => d.series.has(m)) ? logSpot.get(m) - lr.yhat(m) : null);
    for (const m of test) { const e = residAny(m); if (e != null && !usable.some((d) => d.filled.has(m))) lrErr.push(e); }
    let ef = null;
    try {
      const tr = ecmRows(usable, train, logSpot, (m) => lr.residMap.get(m) ?? null);
      if (tr.length > usable.length + 5) ef = ols(tr.map((r) => r.x), tr.map((r) => r.y));
    } catch { ef = null; }
    if (!ef) continue;
    // 테스트 구간: 직전 달 잔차는 훈련 계수로 계산(직전 달이 훈련 마지막 달이어도 됨)
    const te = ecmRows(usable, months.slice(start - 1, start + block), logSpot, residAny);
    for (const r of te) {
      const pred = r.x.reduce((s, v, j) => s + v * ef.beta[j], 0);
      ecmPred.push(pred); ecmAct.push(r.y); ecmPrev.push(Math.exp(logSpot.get(r.p)));
    }
  }
  const rms = (a) => (a.length ? Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) : null);
  const krw = (d, p) => p * (Math.exp(d) - 1);
  const errKrw = ecmPred.map((v, i) => krw(v, ecmPrev[i]) - krw(ecmAct[i], ecmPrev[i]));
  const naiveKrw = ecmAct.map((v, i) => krw(v, ecmPrev[i]));
  const hits = ecmPred.filter((v, i) => Math.sign(v) === Math.sign(ecmAct[i])).length;
  return {
    minTrainMonths: minTrain, blockMonths: block,
    longRun: { n: lrErr.length, sigmaPct: lrErr.length ? round(rms(lrErr) * 100, 2) : null },
    ecm: ecmPred.length ? {
      n: ecmPred.length, rmseKrw: round(rms(errKrw), 1), naiveRmseKrw: round(rms(naiveKrw), 1),
      skill: round(1 - rms(errKrw) / rms(naiveKrw), 3), hitRate: round(hits / ecmPred.length, 3),
    } : null,
  };
}

function fitSpec(spec, prepared, months, logSpot, z) {
  const drivers = spec.drivers.map((id) => prepared.get(id)).filter(Boolean);
  const missing = spec.drivers.filter((id) => !prepared.get(id));
  const usable = drivers.filter((d) => !d.excluded);
  const dropped = drivers.filter((d) => d.excluded).map((d) => ({ id: d.id, reason: d.excluded }));
  const required = spec.required || [];
  const reqMissing = required.filter((id) => !usable.find((d) => d.id === id));
  if (missing.length && required.some((id) => missing.includes(id))) {
    return { id: spec.id, name: spec.name, ok: false, reason: `missing required driver(s): ${missing.join(', ')}`, dropped };
  }
  if (reqMissing.length) {
    return { id: spec.id, name: spec.name, ok: false, reason: `required driver(s) unusable: ${reqMissing.join(', ')}`, dropped };
  }
  if (!usable.length) return { id: spec.id, name: spec.name, ok: false, reason: 'no usable driver', dropped };

  let lr;
  try { lr = fitLongRun(usable, months, logSpot); } catch (e) { return { id: spec.id, name: spec.name, ok: false, reason: e.message, dropped }; }
  if (!lr) return { id: spec.id, name: spec.name, ok: false, reason: 'not enough observations', dropped };
  const { fit, fitMonths } = lr;

  // 전 구간(나우캐스트 포함) 적정환율
  const series = [];
  let lastFair = null;
  for (const m of months) {
    const hasAll = usable.every((d) => d.series.has(m));
    const spot = logSpot.has(m) ? Math.exp(logSpot.get(m)) : null;
    let fair = null, lo = null, hi = null, resid = null, nowcast = false;
    if (hasAll) {
      const yhat = lr.yhat(m);
      fair = Math.exp(yhat);
      lo = Math.exp(yhat - z * fit.sigma);
      hi = Math.exp(yhat + z * fit.sigma);
      nowcast = usable.some((d) => d.filled.has(m));
      if (spot !== null) resid = Math.log(spot) - yhat;
      lastFair = fair;
    }
    series.push({
      date: m,
      spot: spot === null ? null : round(spot, 2),
      fair: fair === null ? null : round(fair, 2),
      lo: lo === null ? null : round(lo, 2),
      hi: hi === null ? null : round(hi, 2),
      gap: spot !== null && fair !== null ? round(spot - fair, 2) : null,
      z: resid === null ? null : round(resid / fit.sigma, 3),
      nowcast,
      inSample: fitMonths.includes(m),
    });
  }

  // ---------- ECM ----------
  const rows = ecmRows(usable, months, logSpot, (m) => lr.residMap.get(m) ?? null);
  let ecm = null;
  if (rows.length > usable.length + 3) {
    try {
      const ef = ols(rows.map((r) => r.x), rows.map((r) => r.y));
      ecm = {
        alpha: ef.beta[0], gamma: ef.beta[1], gammaT: ef.tstat[1],
        betas: usable.map((d, i) => ({ id: d.id, coef: ef.beta[i + 2], tstat: ef.tstat[i + 2] })),
        sigma: ef.sigma, r2: ef.r2, n: ef.n,
        halfLifeMonths: ef.beta[1] < 0 && ef.beta[1] > -1 ? Math.log(0.5) / Math.log(1 + ef.beta[1]) : null,
      };
      const lastIdx = [...months].reverse().findIndex((m) => logSpot.has(m));
      if (lastIdx >= 0) {
        const m = months[months.length - 1 - lastIdx];
        const p = addMonths(m, -1);
        const row = series.find((s) => s.date === p);
        if (row && row.spot && row.z !== null && logSpot.has(p)) {
          const ePrev = row.z * fit.sigma;
          const dx = usable.map((d) => (d.series.has(m) && d.series.has(p) ? d.series.get(m) - d.series.get(p) : 0));
          const pred = ef.beta[0] + ef.beta[1] * ePrev + dx.reduce((s, v, i) => s + ef.beta[i + 2] * v, 0);
          const prevSpot = Math.exp(logSpot.get(p));
          const curSpot = Math.exp(logSpot.get(m));
          ecm.latest = {
            month: m, prevMonth: p,
            predictedChangeKrw: round(prevSpot * (Math.exp(pred) - 1), 1),
            actualChangeKrw: round(curSpot - prevSpot, 1),
            remainingKrw: round(prevSpot * (Math.exp(pred) - 1) - (curSpot - prevSpot), 1),
          };
        }
      }
    } catch (e) { ecm = { error: e.message }; }
  }

  let oos = null;
  try { oos = pseudoOutOfSample(usable, months, logSpot); } catch (e) { oos = { error: e.message }; }

  const latestRow = [...series].reverse().find((s) => s.spot !== null);
  const latestFairRow = [...series].reverse().find((s) => s.fair !== null);
  const fairForSens = latestFairRow ? latestFairRow.fair : lastFair || 1;
  const latest = latestRow ? {
    month: latestRow.date, spot: latestRow.spot, fair: latestRow.fair, lo: latestRow.lo, hi: latestRow.hi,
    gap: latestRow.gap, gapPct: latestRow.fair ? round((latestRow.spot / latestRow.fair - 1) * 100, 2) : null,
    z: latestRow.z, nowcast: latestRow.nowcast,
    bandPosition: latestRow.fair && latestRow.lo && latestRow.hi ? round((latestRow.spot - latestRow.lo) / (latestRow.hi - latestRow.lo), 3) : null,
  } : null;

  return {
    id: spec.id, name: spec.name, description: spec.description || '', ok: true,
    sample: { start: fitMonths[0], end: fitMonths[fitMonths.length - 1], n: fit.n },
    ci: { level: null, z },
    stats: { r2: round(fit.r2, 4), sigma: round(fit.sigma, 5), sigmaPct: round(fit.sigma * 100, 2), bandHalfWidthPct: round(z * fit.sigma * 100, 2) },
    oos,
    intercept: { coef: fit.beta[0], se: fit.se[0], tstat: fit.tstat[0] },
    drivers: usable.map((d, i) => ({
      id: d.id, name: d.name, unit: d.unit, transform: d.transform, tier: d.tier,
      coef: fit.beta[i + 1], se: fit.se[i + 1], tstat: fit.tstat[i + 1],
      lastDate: d.lastDate, coverage: round(d.coverage, 3), nowcastMonths: [...d.filled],
      sensitivity: sensitivity(d, fit.beta[i + 1], fairForSens),
    })),
    dropped, ecm, latest, series,
  };
}

function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }

/**
 * 메인 진입점. 여러 스펙을 적합하고, 성공한 첫 스펙을 default 로 지정.
 */
export function runModel(input, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const sampleStart = input.sampleStart || '2014-01';
  const sampleEnd = input.sampleEnd || currentMonth(now);
  const months = monthRange(sampleStart, sampleEnd);
  const ciLevel = input.ci ?? 0.9;
  const z = Z_TABLE[ciLevel] || 1.6449;

  const spotMonthly = transformMonthly(monthlyAverage(input.spot), months, 'log');
  const prepared = new Map();
  for (const d of input.drivers || []) prepared.set(d.id, prepareDriver(d, months, sampleEnd));

  const specs = input.specs && input.specs.length ? input.specs : [{
    id: 'auto', name: 'All drivers', drivers: [...prepared.keys()],
  }];
  const models = {};
  for (const spec of specs) {
    const r = fitSpec(spec, prepared, months, spotMonthly, z);
    if (r.ok) r.ci.level = ciLevel;
    models[spec.id] = r;
  }
  const defaultModel = specs.map((s) => s.id).find((id) => models[id].ok) || null;

  const spotDates = (input.spot || []).map((p) => String(p.date)).sort();
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    sample: { start: sampleStart, end: sampleEnd, months: months.length },
    ci: ciLevel,
    spot: {
      firstDate: spotDates[0] || null, lastDate: spotDates[spotDates.length - 1] || null,
      last: spotDates.length ? Number((input.spot.find((p) => String(p.date) === spotDates[spotDates.length - 1]) || {}).value) : null,
      monthlyAverage: months.filter((m) => spotMonthly.has(m)).map((m) => ({ date: m, value: round(Math.exp(spotMonthly.get(m)), 2) })),
    },
    driverStatus: [...prepared.values()].map((d) => ({
      id: d.id, name: d.name, tier: d.tier, firstDate: d.firstDate, lastDate: d.lastDate,
      coverage: round(d.coverage, 3), excluded: d.excluded, nowcastMonths: [...d.filled],
    })),
    defaultModel,
    models,
  };
}

/** 시나리오: 드라이버 변화량(변환 전 단위) → 적정환율. shocks = { driverId: delta } */
export function scenarioFair(model, shocks) {
  if (!model || !model.ok || !model.latest || !model.latest.fair) return null;
  let logFair = Math.log(model.latest.fair);
  for (const d of model.drivers) {
    const s = shocks[d.id];
    if (!s) continue;
    if (d.transform === 'log') logFair += d.coef * Math.log(1 + s / 100); // s 는 % 변화
    else logFair += d.coef * s; // s 는 수준 변화(예: 금리차 %p, 무역수지 십억달러)
  }
  return Math.exp(logFair);
}
