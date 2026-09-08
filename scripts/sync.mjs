#!/usr/bin/env node
/**
 * scripts/sync.mjs — 데이터 수집 → 모델 적합 → data/ 갱신
 *   node scripts/sync.mjs            # 전체 실행
 *   node scripts/sync.mjs --dry-run  # 파일 쓰지 않고 요약만 출력
 * GitHub Actions(.github/workflows/sync.yml)가 매일 실행한다. 로컬에서도 동일하게 실행 가능.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSources, toModelInput, parseCsvSeries } from '../src/data-sources.js';
import { runModel } from '../src/beer-model.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const log = (m) => console.log(`[sync] ${m}`);

const config = JSON.parse(await readFile(path.join(root, 'config/sources.json'), 'utf8'));

// data/manual/<id>.csv (date,value) → 수동 보정. spot.csv 는 달러/원 자체를 덮어씀.
const manual = {};
const manualDir = path.join(root, 'data/manual');
if (existsSync(manualDir)) {
  for (const f of await readdir(manualDir)) {
    if (!f.endsWith('.csv')) continue;
    const id = f.replace(/\.csv$/, '');
    manual[id] = parseCsvSeries(await readFile(path.join(manualDir, f), 'utf8'));
    log(`manual override: ${id} (${manual[id].length} pts)`);
  }
}

const ecosKey = process.env.ECOS_API_KEY || '';
log(`ECOS key: ${ecosKey ? 'present' : 'absent (한국 10년 금리는 OECD 월별로 대체)'}`);
const collected = await collectSources(config, { manual, log, ecosKey });
const input = toModelInput(config, collected);
const output = runModel(input);
output.sources = collected.status;
output.reference = config.reference || null;

for (const [id, m] of Object.entries(output.models)) {
  if (!m.ok) { log(`model ${id}: SKIPPED (${m.reason})`); continue; }
  log(`model ${id}: n=${m.sample.n} ${m.sample.start}..${m.sample.end} R2=${m.stats.r2} sigma=${m.stats.sigmaPct}% | latest ${m.latest?.month} spot=${m.latest?.spot} fair=${m.latest?.fair} gap=${m.latest?.gap}`);
  if (m.ensemble) log(`   weights: ${m.ensemble.members.map((x) => `${x.id}=${x.weight}`).join(' ')}`);
  for (const d of m.drivers) log(`   ${d.id.padEnd(10)} coef=${d.coef.toFixed(4)} t=${d.tstat == null ? 'n/a' : d.tstat.toFixed(2)} sens ${d.sensitivity.per} → ${d.sensitivity.krw.toFixed(1)}원`);
  if (m.ecm?.latest) log(`   ECM ${m.ecm.latest.month}: pred ${m.ecm.latest.predictedChangeKrw}원 vs actual ${m.ecm.latest.actualChangeKrw}원 (gamma=${m.ecm.gamma.toFixed(3)})`);
  if (m.oos?.longRun) log(`   OOS: sigma ${m.oos.longRun.sigmaPct}% | ECM skill ${m.oos.ecm?.skill ?? 'n/a'} hit ${m.oos.ecm?.hitRate ?? 'n/a'}`);
}
if (!output.defaultModel) { console.error('[sync] no model could be fitted'); process.exitCode = 1; }

if (dryRun) { log('dry run — nothing written'); process.exit(); }

await mkdir(path.join(root, 'data/series'), { recursive: true });
await writeFile(path.join(root, 'data/beer_output.json'), JSON.stringify(output));
await writeFile(path.join(root, 'data/beer_output.pretty.json'), JSON.stringify(output, null, 1));
await writeFile(path.join(root, 'data/series/spot.json'), JSON.stringify(collected.spot));
for (const [id, pts] of Object.entries(collected.series)) await writeFile(path.join(root, `data/series/${id}.json`), JSON.stringify(pts));
await writeFile(path.join(root, 'data/status.json'), JSON.stringify({ generatedAt: output.generatedAt, defaultModel: output.defaultModel, sources: collected.status }, null, 1));

// 통합용 경량 파일: 최신 값만
const dm = output.defaultModel ? output.models[output.defaultModel] : null;
await writeFile(path.join(root, 'data/latest.json'), JSON.stringify({
  generatedAt: output.generatedAt, model: output.defaultModel, spotLast: output.spot.last, spotLastDate: output.spot.lastDate,
  latest: dm?.latest || null, ecm: dm?.ecm?.latest || null, stats: dm?.stats || null,
  sensitivity: dm ? Object.fromEntries(dm.drivers.map((d) => [d.id, d.sensitivity])) : null,
}, null, 1));
log('written data/beer_output.json, data/latest.json, data/status.json, data/series/*.json');
