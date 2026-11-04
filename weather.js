// Weather history helpers shared by the app and the hourly collector (collector/collect.mjs).
// Storage uses UTC hour keys "YYYY-MM-DDTHH:00Z"; daily values are grouped by America/New_York date.
// Observations (what the airport station measured) are never mixed with forecasts.
import { localParts } from './core.js';

export const HOUR = 3600e3;
export const STATION = { id: 'KILG', iem: 'ILG', name: 'Wilmington airport (KILG)' };
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

/** Nearest whole UTC hour, e.g. an 18:51Z report belongs to 19:00Z. */
export const hourKey = (ms) => `${new Date(Math.round(ms / HOUR) * HOUR).toISOString().slice(0, 13)}:00Z`;

const qv = (q) => (q && Number.isFinite(q.value) && !/[XQ]/.test(q.qualityControl || '') ? q.value : null);

/** api.weather.gov /stations/{id}/observations → [{at, t °F, rh %, wind mph, precip in}] (QC-rejected values dropped). */
export function parseNwsObservations(json) {
  const fs = json?.features;
  if (!Array.isArray(fs)) throw new Error('unexpected NWS observations response');
  return fs.map(({ properties: p = {} }) => {
    const c = qv(p.temperature), ws = qv(p.windSpeed), pr = qv(p.precipitationLastHour);
    const mph = ws == null ? null : /m_s-1/.test(p.windSpeed?.unitCode || '') ? ws * 2.23694 : ws * 0.621371;
    return { at: Date.parse(p.timestamp), t: c == null ? null : r1((c * 9) / 5 + 32), rh: r1(qv(p.relativeHumidity)), wind: r1(mph), precip: pr == null ? null : r2(pr / 25.4) };
  }).filter((o) => Number.isFinite(o.at) && o.t != null);
}

/** Iowa Environmental Mesonet ASOS CSV (station,valid,tmpf,relh,sknt,p01i; UTC). */
export function parseIemCsv(text) {
  const lines = String(text).trim().split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const head = (lines.shift() || '').split(',');
  if (head[1] !== 'valid') throw new Error('unexpected IEM CSV header');
  const [iV, iT, iH, iW, iP] = ['valid', 'tmpf', 'relh', 'sknt', 'p01i'].map((n) => head.indexOf(n));
  const val = (c, i) => { const v = Number(c[i]); return i < 0 || c[i] === '' || !Number.isFinite(v) ? null : v; };
  return lines.map((l) => {
    const c = l.split(',');
    const p = val(c, iP), w = val(c, iW);
    return { at: Date.parse(`${(c[iV] || '').replace(' ', 'T')}:00Z`), t: r1(val(c, iT)), rh: r1(val(c, iH)), wind: w == null ? null : r1(w * 1.15078), precip: p == null ? null : r2(p < 0.001 ? 0 : p) };
  }).filter((o) => Number.isFinite(o.at) && o.t != null);
}

/** IEM request for [from, to) in UTC dates (YYYY-MM-DD); routine hourly reports only. */
export function iemUrl(from, to) {
  const [y1, m1, d1] = from.split('-').map(Number), [y2, m2, d2] = to.split('-').map(Number);
  return `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${STATION.iem}&data=tmpf&data=relh&data=sknt&data=p01i&year1=${y1}&month1=${m1}&day1=${d1}&year2=${y2}&month2=${m2}&day2=${d2}&tz=Etc/UTC&format=onlycomma&latlon=no&missing=null&trace=0.0001&report_type=3`;
}

/**
 * Merge observations into hourly records. One record per UTC hour: the report closest to the top of the hour wins,
 * so re-fetching the same data is a no-op (idempotent) and special reports don't replace routine ones.
 */
export function mergeObservations(hourly, list, src) {
  let added = 0, updated = 0;
  for (const o of list) {
    const k = hourKey(o.at);
    const dist = Math.abs(o.at - Date.parse(k));
    const rec = { t: o.t, rh: o.rh, wind: o.wind, precip: o.precip, at: new Date(o.at).toISOString(), src };
    const cur = hourly[k];
    if (!cur) { hourly[k] = rec; added++; continue; }
    const curDist = Math.abs(Date.parse(cur.at) - Date.parse(k));
    if (dist < curDist || (dist === curDist && cur.precip == null && rec.precip != null)) { hourly[k] = rec; updated++; }
  }
  return { added, updated };
}

export function missingHours(hourly, fromMs, toMs) {
  const out = [];
  for (let t = Math.ceil(fromMs / HOUR) * HOUR; t <= toMs; t += HOUR) { const k = hourKey(t); if (!hourly[k]) out.push(k); }
  return out;
}

/** Daily stats by New York calendar date (23- and 25-hour DST days handled). complete = ≥ 20 observed hours. */
export function dailyFromHourly(hourly) {
  const days = {};
  for (const [k, r] of Object.entries(hourly)) {
    if (r.t == null) continue;
    const { date } = localParts(Date.parse(k));
    const d = (days[date] ||= { n: 0, sum: 0, min: Infinity, max: -Infinity, precip: 0, pn: 0 });
    d.n++; d.sum += r.t; d.min = Math.min(d.min, r.t); d.max = Math.max(d.max, r.t);
    if (r.precip != null) { d.precip += r.precip; d.pn++; }
  }
  return Object.fromEntries(Object.keys(days).sort().map((date) => {
    const d = days[date];
    return [date, { mean: r1(d.sum / d.n), min: d.min, max: d.max, hours: d.n, precip: d.pn ? r2(d.precip) : null, complete: d.n >= 20 }];
  }));
}

export const dailyMeans = (daily) => Object.fromEntries(Object.entries(daily || {}).filter(([, d]) => d.complete).map(([k, d]) => [k, d.mean]));

export function monthlySummary(daily) {
  const m = {};
  for (const [date, d] of Object.entries(daily || {})) {
    if (!d.complete) continue;
    const s = (m[date.slice(0, 7)] ||= { month: date.slice(0, 7), days: 0, sum: 0, hdd: 0, cdd: 0, precip: 0 });
    s.days++; s.sum += d.mean; s.hdd += Math.max(0, 65 - d.mean); s.cdd += Math.max(0, d.mean - 65);
    if (d.precip != null) s.precip += d.precip;
  }
  return Object.values(m).sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((s) => ({ month: s.month, days: s.days, mean: r1(s.sum / s.days), hdd: Math.round(s.hdd), cdd: Math.round(s.cdd), precip: r2(s.precip) }));
}

/** Keep the next `horizon` hours of an hourly forecast (parsed by core.parseNwsHourly) as a snapshot. */
export function forecastSnapshot(hours, issuedMs, horizon = 48) {
  const out = {};
  for (const h of hours) if (h.t >= issuedMs - HOUR && h.t <= issuedMs + horizon * HOUR) out[hourKey(h.t)] = { t: r1(h.tempF), pop: h.pop ?? null };
  return out;
}

/** Forecast error vs. what the station later observed, by lead time. bias > 0 = forecast too warm. */
export function forecastSkill(snapshots, hourly) {
  const B = [['0-6h', 0, 6], ['6-24h', 6, 24], ['24-48h', 24, 49]];
  const acc = Object.fromEntries(B.map(([n]) => [n, { n: 0, abs: 0, err: 0 }]));
  for (const [issued, hrs] of Object.entries(snapshots)) {
    for (const [k, f] of Object.entries(hrs)) {
      const o = hourly[k];
      if (!o || o.t == null || f.t == null) continue;
      const lead = (Date.parse(k) - Date.parse(issued)) / HOUR;
      const b = B.find(([, lo, hi]) => lead >= lo && lead < hi);
      if (!b) continue;
      const a = acc[b[0]];
      a.n++; a.abs += Math.abs(f.t - o.t); a.err += f.t - o.t;
    }
  }
  return Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, { n: a.n, mae: a.n ? r1(a.abs / a.n) : null, bias: a.n ? r1(a.err / a.n) : null }]));
}
