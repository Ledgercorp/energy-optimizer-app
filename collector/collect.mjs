// Hourly weather collector for Wilmington, DE. Runs in GitHub Actions (public repo, free minutes).
// Publishes ONLY public city-level weather: station observations, forecast snapshots and aggregates.
// Usage: node collector/collect.mjs [YYYY-MM-DD]   (optional date = backfill station history from that day)
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { parseNwsHourly } from '../core.js';
import * as W from '../weather.js';
import { checkInsights } from './insights.mjs';

const DIR = new URL('../data/weather/', import.meta.url);
const UA = '(energy-optimizer-app weather collector, github.com/Ledgercorp/energy-optimizer-app)';
const POINT = '39.7447,-75.5484'; // Wilmington city centre
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const day = (ms) => iso(ms).slice(0, 10);
const errors = [];

async function get(url, kind = 'json', tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: kind === 'json' ? 'application/geo+json' : 'text/csv' }, signal: AbortSignal.timeout(45000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return kind === 'json' ? await r.json() : await r.text();
    } catch (e) {
      if (i >= tries) throw new Error(`${new URL(url).host}: ${e.message}`);
      await new Promise((res) => setTimeout(res, 3000 * i * i)); // back off: 3 s, 12 s
    }
  }
}
const readJson = async (f, dflt) => { try { return JSON.parse(await readFile(new URL(f, DIR), 'utf8')); } catch { return dflt; } };
// One key per line keeps git diffs readable and small.
const lines = (o) => `{\n${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(o[k])}`).join(',\n')}\n}\n`;
async function writeIfChanged(f, text) {
  let old = null;
  try { old = await readFile(new URL(f, DIR), 'utf8'); } catch { /* new file */ }
  if (old !== text) await writeFile(new URL(f, DIR), text);
}
const monthFiles = async (sub) => (await readdir(new URL(`${sub}/`, DIR))).filter((f) => /^\d{4}-\d{2}\.json$/.test(f));

await mkdir(new URL('obs/', DIR), { recursive: true });
await mkdir(new URL('forecast/', DIR), { recursive: true });
const prev = await readJson('status.json', {});

// ---- observations ----
const hourly = {};
for (const f of await monthFiles('obs')) Object.assign(hourly, await readJson(`obs/${f}`, {}));
const counts = { nws: null, iem: null };
try {
  counts.nws = W.mergeObservations(hourly, W.parseNwsObservations(await get(`https://api.weather.gov/stations/${W.STATION.id}/observations?limit=250`)), 'nws');
} catch (e) { errors.push(`NWS observations: ${e.message}`); }

// Repair gaps (missed/delayed runs, NWS outages) and optional backfill from IEM's archive of the same station.
const backfill = /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2] || '') ? process.argv[2] : null;
const gaps = W.missingHours(hourly, now - 10 * 864e5, now - 3 * W.HOUR);
const from = backfill || (gaps.length ? gaps[0].slice(0, 10) : null);
if (from) {
  counts.iem = { added: 0, updated: 0 };
  const end = Date.parse(`${day(now + 864e5)}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t < end; t += 120 * 864e5) { // 120-day chunks keep requests modest
    try {
      const r = W.mergeObservations(hourly, W.parseIemCsv(await get(W.iemUrl(day(t), day(Math.min(end, t + 120 * 864e5))), 'text')), 'iem');
      counts.iem.added += r.added; counts.iem.updated += r.updated;
    } catch (e) { errors.push(`IEM ${day(t)}: ${e.message}`); }
  }
}
const byMonth = {};
for (const [k, v] of Object.entries(hourly)) (byMonth[k.slice(0, 7)] ||= {})[k] = v;
for (const [m, o] of Object.entries(byMonth)) await writeIfChanged(`obs/${m}.json`, lines(o));

// ---- forecast: latest full forecast + a 48 h snapshot about every 6 h for accuracy tracking ----
let lastSnapshotAt = prev.lastSnapshotAt || null;
try {
  const pts = await get(`https://api.weather.gov/points/${POINT}`);
  const url = pts?.properties?.forecastHourly;
  if (!url?.startsWith('https://api.weather.gov/')) throw new Error('no forecastHourly link');
  const fj = await get(url);
  const hours = parseNwsHourly(fj);
  await writeFile(new URL('forecast/latest.json', DIR), `${JSON.stringify({ fetchedAt: iso(now), generatedAt: fj.properties?.generatedAt ?? null, hours: hours.slice(0, 168).map((h) => ({ k: W.hourKey(h.t), t: Math.round(h.tempF * 10) / 10, pop: h.pop, text: h.text })) })}\n`);
  if (!lastSnapshotAt || now - Date.parse(lastSnapshotAt) >= 5.5 * W.HOUR) {
    const f = `forecast/${iso(now).slice(0, 7)}.json`;
    const snaps = await readJson(f, {});
    snaps[W.hourKey(now)] = W.forecastSnapshot(hours, now);
    await writeFile(new URL(f, DIR), lines(snaps));
    lastSnapshotAt = iso(now);
  }
} catch (e) { errors.push(`NWS forecast: ${e.message}`); }

// ---- operator insights (delivered by the aeo-operator Worker as a workflow input; validated again here) ----
if (process.env.INSIGHTS) {
  const r = checkInsights(process.env.INSIGHTS);
  if (r.ok) await writeIfChanged('insights.json', `${JSON.stringify(r.value, null, 1)}\n`);
  else errors.push(`insights rejected: ${r.error}`);
}

// ---- aggregates ----
const snapshots = {};
for (const f of await monthFiles('forecast')) Object.assign(snapshots, await readJson(`forecast/${f}`, {}));
const daily = W.dailyFromHourly(hourly);
await writeIfChanged('daily.json', lines(daily));
await writeIfChanged('skill.json', `${JSON.stringify(W.forecastSkill(snapshots, hourly))}\n`);
const keys = Object.keys(hourly).sort();
const lastKey = keys[keys.length - 1];
const status = {
  station: W.STATION, updatedAt: iso(now), lastSnapshotAt,
  lastObservation: lastKey ? { key: lastKey, ...hourly[lastKey] } : null,
  hours: keys.length, days: Object.values(daily).filter((d) => d.complete).length, coverageFrom: keys[0] || null,
  missingLast10Days: W.missingHours(hourly, now - 10 * 864e5, now - 3 * W.HOUR).length,
  added: counts, errors,
  sources: { observations: 'NWS api.weather.gov (KILG) with Iowa Environmental Mesonet ASOS archive for backfill/gaps', forecast: 'NWS hourly forecast' },
};
await writeFile(new URL('status.json', DIR), `${JSON.stringify(status, null, 1)}\n`);
console.log(JSON.stringify({ hours: status.hours, days: status.days, added: counts, errors }, null, 1));
for (const e of errors) console.log(`::warning::${e}`);
