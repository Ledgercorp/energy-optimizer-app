// Apartment Energy Optimizer — UI. Three sections (Today / Insights / Settings), detail pages, guided setup and programming.
// Personal data stays in this browser's localStorage. Network: the read-only Cloudflare weather service (with this site's
// data/weather/ copy as fallback), api.weather.gov (forecast) and archive-api.open-meteo.com (old daily temperatures only).
import * as C from './core.js';
import * as Wx from './weather.js';
import * as A from './advisor.js';

const KEY = 'aeo.state.v1'; // unchanged so existing installs keep their data
const UI_KEY = 'aeo.ui.v1';
const LOC = { lat: 39.7447, lon: -75.5484, name: 'Wilmington, DE' }; // city centre, not your address
const MANUAL_URL = 'https://energywiserewards.delmarva.com/wp-content/uploads/2020/11/20_DDWMAN2026_IT900-400_USER_MANUAL-CFO-073120-crp.pdf';
const SUPPORT_URL = 'https://energywiserewards.delmarva.com/de/contact/';
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STANDALONE = navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
const HOUR = Wx.HOUR;
const API = 'https://aeo-public.colbyweiss15.workers.dev/data/weather/'; // read-only Cloudflare weather service
const SEASONS = [['heat_available', 'Heat'], ['cool_available', 'Cooling'], ['fan_only', 'Fan only'], ['unknown', 'Not sure']];
const DAYWORD = { weekday: 'Weekdays', weekend: 'Weekends' };
const AWAY_DEFAULT = { weekday: { leave: '08:00', back: '17:30' }, weekend: { leave: '10:00', back: '16:00' } };

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n, d = 0) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const money = (n) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
const dayLabel = (iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
const shortDate = (iso) => dayLabel(iso, { month: 'short', day: 'numeric' });
const fmtNY = (ms, opts = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) => new Date(ms).toLocaleString('en-US', { timeZone: C.TZ, ...opts });
const clock = (ms) => fmtNY(ms, { hour: 'numeric', minute: '2-digit' });
const hourLabel = (h) => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;
const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const todayIso = () => C.localParts(Date.now()).date;
const daysAgo = (iso) => Math.round((Date.parse(`${todayIso()}T12:00:00Z`) - Date.parse(`${iso}T12:00:00Z`)) / 864e5);
const signed = (v, d = 1) => `${v >= 0 ? '+' : '−'}${num(Math.abs(v), d)}`;
const modeName = (m) => (m === 'heat' ? 'Heating' : 'Cooling');
const timeText = (hhmm) => (C.toMin(hhmm) == null ? '—' : C.fmtMin(C.toMin(hhmm)));
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

let S = load();
let UI = loadUI();
let WD = { loaded: false, status: null, daily: null, skill: null, latest: null, insights: null, obs: {} };
let busy = '', lastRefresh = 0, archiveTried = false, lastImport = '';
let draft = null, setupStep = 0, setupError = '', progStep = 0, savedNote = null;

function load() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(KEY)); } catch { /* storage blocked or corrupt */ }
  const s = A.migrate(raw);
  if (raw && raw.version !== A.STATE_VERSION) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* keep in memory */ } }
  return s;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { toast('Couldn’t save on this device. Save a backup from Settings.', true); }
}
function loadUI() { try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch { return {}; } }
function saveUI() { try { localStorage.setItem(UI_KEY, JSON.stringify(UI)); } catch { /* optional */ } }
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => { t.className = 'toast'; }, 4200);
}
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
function setPath(o, p, v) {
  const ks = p.split('.');
  const last = ks.pop();
  ks.reduce((a, k) => a[k], o)[last] = v;
}

// ---------- derived data ----------

/** Daily mean temperatures: station history collected in the cloud wins over the Open-Meteo archive. */
const allTemps = () => ({ ...S.temps, ...Wx.dailyMeans(WD.daily) });
const forecastHours = () => (S.weatherCache?.hours?.length ? S.weatherCache.hours : (WD.latest?.hours || []).map((h) => ({ t: Date.parse(h.k), tempF: h.t, text: h.text, pop: h.pop })));
const forecastTime = () => (S.weatherCache?.hours?.length ? S.weatherCache.fetchedAt : WD.latest ? Date.parse(WD.latest.fetchedAt) : null);
const recNow = () => C.recommend(S, forecastHours(), Date.now());
const usageDays = () => C.dailyTotals(S.usage).filter((d) => d.complete);
/** Validated findings from the automatic weather review (public data only). */
const opsItems = () => (WD.insights?.items || []).filter((i) => Date.parse(i.valid_until) > Date.now());
const savings = () => A.savingsReport({ usage: S.usage, temps: allTemps(), tariff: S.profile.tariff, hvacMetered: S.profile.hvacMetered, history: S.programmedHistory, changeDate: S.profile.changeDate });
function usageTrend() {
  const d = usageDays();
  if (!d.length) return null;
  const last = d.slice(-30), prev = d.slice(-60, -30);
  const a = avg(last.map((x) => x.kwh)), b = prev.length >= 14 ? avg(prev.map((x) => x.kwh)) : null;
  return { avg: a, days: last.length, pct: b ? ((a - b) / b) * 100 : null, last: d[d.length - 1].date };
}

// ---------- charts ----------

const readout = (text) => `<div class="readout" aria-live="polite">${text}</div>`;

function barChart(vals, { label, ticks, tips, low }) {
  if (!vals.length) return '';
  const w = 600, h = 200, px = 6, top = 10, bot = 34;
  const max = Math.max(...vals, 1e-6);
  const bw = (w - 2 * px) / vals.length;
  const gap = Math.min(4, bw * 0.25);
  const bars = vals.map((v, i) => {
    const bh = Math.max(v > 0 ? 2 : 0, (v / max) * (h - top - bot));
    return `<rect x="${(px + i * bw + gap / 2).toFixed(1)}" y="${(h - bot - bh).toFixed(1)}" width="${(bw - gap).toFixed(1)}" height="${bh.toFixed(1)}" rx="${Math.min(4, (bw - gap) / 2).toFixed(1)}" class="${low?.(i) ? 'lo' : ''}" data-tip="${esc(tips[i])}"/>`;
  }).join('');
  const every = Math.ceil(vals.length / 5);
  const tk = ticks.map((t, i) => (i % every === 0 ? `<text x="${(px + i * bw + bw / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(t)}</text>` : '')).join('');
  return `<svg class="chart bars" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}"><line class="grid" x1="0" x2="${w}" y1="${h - bot}" y2="${h - bot}"/>${bars}${tk}</svg>${readout('Tap a bar for details.')}`;
}

/** Time-axis chart: one or two series (second dashed) plus an optional min–max band; long gaps break the line. */
function timeChart(series, { label, band = [], gap, tick, unit = '°' }) {
  const all = series.flatMap((s) => s.pts).concat(band.flatMap((b) => [{ x: b.x, y: b.lo }, { x: b.x, y: b.hi }]));
  if (all.length < 2) return '<p class="fine">Not enough data to chart yet.</p>';
  const w = 600, h = 220, pl = 48, pr = 12, top = 12, bot = 34;
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.floor(Math.min(...ys) - 2), y1 = Math.ceil(Math.max(...ys) + 2);
  const X = (x) => pl + ((x - x0) / Math.max(1, x1 - x0)) * (w - pl - pr);
  const Y = (y) => top + ((y1 - y) / Math.max(1, y1 - y0)) * (h - top - bot);
  const path = (pts) => pts.map((p, i) => `${i && p.x - pts[i - 1].x <= gap ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const grid = [0, 1, 2, 3].map((k) => { const v = y0 + ((y1 - y0) * k) / 3; return `<line class="grid" x1="${pl}" x2="${w - pr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="y" x="${pl - 8}" y="${(Y(v) + 7).toFixed(1)}" text-anchor="end">${Math.round(v)}${unit}</text>`; }).join('');
  const ticks = [0, 1, 2].map((k) => { const x = x0 + ((x1 - x0) * (k + 0.5)) / 3; return `<text x="${X(x).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(tick(x))}</text>`; }).join('');
  const bandPath = band.length > 1 ? `<path class="band" d="${band.map((b, i) => `${i ? 'L' : 'M'}${X(b.x).toFixed(1)},${Y(b.hi).toFixed(1)}`).join('')}${[...band].reverse().map((b) => `L${X(b.x).toFixed(1)},${Y(b.lo).toFixed(1)}`).join('')}Z"/>` : '';
  const lines = series.map((s, i) => (s.pts.length > 1 ? `<path class="stroke${i ? ' dash' : ''}" d="${path(s.pts)}"/>` : '')).join('');
  const hitPts = series.flatMap((s) => s.pts).sort((a, b) => a.x - b.x);
  const hits = hitPts.map((p, i) => {
    const l = i ? (X(hitPts[i - 1].x) + X(p.x)) / 2 : pl, r = i < hitPts.length - 1 ? (X(p.x) + X(hitPts[i + 1].x)) / 2 : w - pr;
    return `<rect x="${l.toFixed(1)}" y="0" width="${Math.max(0.5, r - l).toFixed(1)}" height="${h - bot}" opacity="0" data-tip="${esc(p.tip)}"/>`;
  }).join('');
  const legend = series.length > 1 ? `<div class="legend">${series.map((s, i) => `<span><i class="sw${i ? ' dash' : ''}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  return `${legend}<svg class="chart time" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${grid}${bandPath}${lines}${ticks}${hits}</svg>${readout('Tap the chart for details.')}`;
}

function scatterChart(pts, curve) {
  if (pts.length < 2) return '';
  const w = 600, h = 240, pl = 48, pr = 12, top = 12, bot = 36;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y).concat(curve.map((c) => c.y));
  const x0 = Math.floor(Math.min(...xs) - 2), x1 = Math.ceil(Math.max(...xs) + 2);
  const y1 = Math.ceil(Math.max(...ys) * 1.1);
  const X = (x) => pl + ((x - x0) / Math.max(1, x1 - x0)) * (w - pl - pr);
  const Y = (y) => top + ((y1 - y) / Math.max(1, y1)) * (h - top - bot);
  const grid = [0, 1, 2, 3].map((k) => { const v = (y1 * k) / 3; return `<line class="grid" x1="${pl}" x2="${w - pr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="y" x="${pl - 8}" y="${(Y(v) + 7).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`; }).join('');
  const ticks = [0, 1, 2, 3].map((k) => { const x = x0 + ((x1 - x0) * (k + 0.5)) / 4; return `<text x="${X(x).toFixed(1)}" y="${h - 8}" text-anchor="middle">${Math.round(x)}°F</text>`; }).join('');
  const dots = pts.map((p) => `<circle class="pt" cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="7" data-tip="${esc(p.tip)}"/>`).join('');
  const fit = curve.length > 1 ? `<path class="fit" d="${curve.map((c, i) => `${i ? 'L' : 'M'}${X(c.x).toFixed(1)},${Y(c.y).toFixed(1)}`).join('')}"/>` : '';
  return `<div class="legend"><span><i class="dotsw"></i>One day: kWh vs. average outdoor °F</span>${fit ? '<span><i class="sw fitsw"></i>Your typical pattern</span>' : ''}</div><svg class="chart scatter" viewBox="0 0 ${w} ${h}" role="img" aria-label="Daily electricity use versus average outdoor temperature">${grid}${fit}${dots}${ticks}</svg>${readout('Tap a dot for that day.')}`;
}

// ---------- shared bits ----------

const ICON = {
  today: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M18.7 18.7l-1.4-1.4M6.7 6.7 5.3 5.3"/>',
  insights: '<path d="M5 20v-7M12 20V5M19 20v-11M3 20.5h18"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5"/>',
};
const ic = {
  check: '<svg class="ic-s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="m7.5 12.3 3 3 6-6.3"/></svg>',
  alert: '<svg class="ic-s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5.5M12 16.5v.2"/></svg>',
  unplug: '<svg class="ic-s" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v4M16 3v4M6 7h12v4a6 6 0 0 1-12 0zM12 17v4"/><path d="m3 3 18 18"/></svg>',
};
const TABS = [['today', 'Today'], ['insights', 'Insights'], ['settings', 'Settings']];
const pagehead = (h, eyebrow = '') => `<header class="pagehead"><div>${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ''}<h1>${h}</h1></div></header>`;
const back = (href, label) => `<a class="back" href="#${href}">‹ ${label}</a>`;
const disclosure = (id, summary, body, open = false) => `<details class="disclosure" data-id="${id}" ${open || UI.open?.[id] ? 'open' : ''}><summary>${summary}</summary><div class="disc-body">${body}</div></details>`;
const importButton = (label = 'Import Delmarva file') => `<label class="btn primary file">${label}<input type="file" id="usage-file" multiple accept=".csv,.xml,text/csv,text/xml,application/xml"></label>`;
const HOW_TO_DOWNLOAD = `<ol class="steps"><li>Sign in to <b>Delmarva My Account</b>.</li><li>Open <b>My Usage</b> → <b>Green Button: Download my data</b>.</li><li>Choose the longest date range and download <b>CSV</b> (or XML).</li><li>Come back and tap <b>Import Delmarva file</b>. The rest is automatic.</li></ol><p class="fine">Delmarva doesn’t let personal apps fetch usage without your password, and this app never asks for it. The file stays on this device.</p>`;
const keys = (t) => esc(t)
  .replace(/\b(MENU|RUN|DONE|HOME|NEXT)\b/g, '<kbd class="key">$1</kbd>')
  .replace(/▲\/▼/g, '<span class="keys"><kbd class="key">▲</kbd> <kbd class="key">▼</kbd></span>')
  .replace(/►/g, '<kbd class="key">►</kbd>')
  .replace(/the center button/g, 'the center button <kbd class="key">●</kbd>')
  .replace(/\b(HOLD AT|SET AT)\b/g, '<b>$1</b>');
const disconnected = `<p class="disconnected">${ic.unplug}Thermostat not connected. The app can’t see or change it; you set it by hand.</p>`;

function scheduleTables(rec) {
  const table = (day, t) => `<div><h3>${t}</h3><table><tbody>${day.map((pd) => `<tr><td>${pd.name}${pd.away ? ' <span class="tag">away</span>' : ''}</td><td>${C.fmtMin(pd.start)}</td><td class="t">${pd.temp}°</td></tr>`).join('')}</tbody></table></div>`;
  return rec.plans.map((pl) => `<section class="card"><h2>${modeName(pl.mode)}</h2><div class="sched-grid">${table(pl.weekday, 'Mon–Fri')}${table(pl.weekend, 'Sat–Sun')}</div></section>`).join('');
}

// ---------- Today ----------

const seasonSeg = (label) => `<div class="seg" role="group" aria-label="${esc(label)}">${SEASONS.map(([v, l]) => `<button data-act="season" data-v="${v}" aria-pressed="${S.profile.buildingMode === v}">${l}</button>`).join('')}</div>`;

function hero(st, rec) {
  if (st.kind === 'setup') {
    return `<section class="hero"><p class="eyebrow">Welcome</p><h2 class="hero-q">Let’s set up your thermostat plan</h2><p>Four quick questions about your apartment and routine, about a minute.</p>
      <ol class="checklist"><li><span class="mark">1</span><div><b>Tell the app your routine</b><small>When you’re up, out and asleep.</small></div></li><li><span class="mark">2</span><div><b>Program your thermostat once</b><small>Guided, step by step, about 5 minutes.</small></div></li><li><span class="mark">3</span><div><b>The app keeps watch</b><small>Weather, savings and schedule changes are tracked automatically.</small></div></li></ol>
      <a class="btn primary" href="#setup">Get started</a></section>`;
  }
  if (st.kind === 'error') return `<section class="hero"><span class="pill">Routine needs a fix</span><h2 class="hero-q">Your daily routine can’t be turned into a schedule</h2><p>${esc(st.message)}</p><a class="btn primary" href="#settings">Fix it in Settings</a>${disconnected}</section>`;
  if (st.kind === 'off') return `<section class="hero"><div class="hero-top"><span class="pill">Fan only</span></div><h2 class="hero-q">No heating or cooling to set right now</h2><p>The building isn’t heating or cooling. Keep the thermostat fan on AUTO. You’ll get a recommendation as soon as the building switches.</p><p class="hero-label">Has the building switched?</p>${seasonSeg('What the building provides')}${disconnected}</section>`;
  if (S.profile.buildingMode === 'unknown') {
    const t = (m) => rec.current.find((c) => c.mode === m)?.temp;
    return `<section class="hero"><div class="hero-top"><span class="pill">Season not set</span></div><h2 class="hero-q">Is your building heating or cooling right now?</h2><p>Building management switches the heat and AC by season. Pick what’s running to get one clear setting.</p>
      <div class="choices2"><button class="optcard heat" data-act="season" data-v="heat_available"><span>If it’s heating</span><b>${t('heat')}°</b><small>Tap if the heat is on</small></button><button class="optcard cool" data-act="season" data-v="cool_available"><span>If it’s cooling</span><b>${t('cool')}°</b><small>Tap if the AC is on</small></button></div>
      <p class="fine">Not sure? Check whether warm or cool air comes from the vents, or ask building management.</p>${disconnected}</section>`;
  }
  const cur = rec.current[0];
  const pl = rec.plans.find((p) => p.mode === cur.mode);
  const away = cur.temp === pl.setpoints.away && cur.period === 'Day' && pl.setpoints.away !== pl.setpoints.home;
  const n = cur.next;
  const status = st.kind === 'ok'
    ? `<div class="status ok">${ic.check}<div><b>No action needed</b><span>Your thermostat does this by itself if it’s running the schedule you programmed on ${esc(shortDate(st.programmedOn))}.</span></div></div>`
    : `<div class="status todo">${ic.alert}<div><b>${st.kind === 'update' ? 'Update your thermostat' : 'Program your thermostat'}</b><span>Until then, set it to ${cur.temp}° by hand.</span></div></div>`;
  return `<section class="hero ${cur.mode}"><div class="hero-top"><span class="pill ${cur.mode}">${modeName(cur.mode)}</span><span class="hero-period">${cur.period}${away ? ' · away' : ''}</span></div>
    <p class="hero-label">Recommended setting now</p><div class="hero-temp"><span class="big">${cur.temp}°</span></div>
    <p class="hero-next">Next change: <b>${C.fmtMin(n.start)} → ${n.temp}°</b> (${n.name}${n.away ? ', away' : ''})</p>${status}${disconnected}</section>`;
}

function programCard(st, rec) {
  if ((st.kind !== 'program' && st.kind !== 'update') || S.profile.buildingMode === 'unknown') return ''; // pick the season first
  const update = st.kind === 'update';
  const changes = update ? A.scheduleDiff(S.programmed.fingerprint, rec.plans) : [];
  return `<section class="action-card"><h2>${update ? 'Your recommended schedule has changed' : 'Program your thermostat once'}</h2>
    <p>${update ? `Update the thermostat so it matches. What changed since ${esc(shortDate(st.programmedOn))}:` : 'About 5 minutes at the thermostat, step by step. After that it adjusts itself every day.'}</p>
    ${changes.length ? `<ul>${changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    <div class="action-row"><a class="btn primary" href="#program">Program thermostat</a><button class="btn plain" data-act="mark-programmed">Already done</button></div></section>`;
}

function weatherCard(rec) {
  const lo = WD.status?.lastObservation;
  const fresh = lo && Date.now() - Date.parse(lo.at) < 3 * HOUR;
  const fh = forecastHours().find((h) => h.t >= Date.now() - HOUR);
  const today = rec.outlook[0];
  const head = fresh ? `<span class="wx-temp">${num(lo.t)}°</span><div class="wx-text"><b>Outside now</b><span>Measured ${esc(clock(Date.parse(lo.at)))} at Wilmington airport</span></div>`
    : fh ? `<span class="wx-temp">${Math.round(fh.tempF)}°</span><div class="wx-text"><b>Outside now (forecast)</b><span>Latest measurement unavailable</span></div>`
      : '<div class="wx-text"><b>Weather unavailable</b><span>Recommendations still work without it.</span></div>';
  const day = today ? `<div class="kv"><span>${today.hours < 20 ? 'Rest of today' : 'Today'}: high ${Math.round(today.high)}°, low ${Math.round(today.low)}°</span>${today.text ? `<span>${esc(today.text)}</span>` : ''}</div>` : '';
  return `<a class="card" href="#weather"><p class="card-label">Weather · ${LOC.name}</p><div class="wx">${head}</div>${day}</a>`;
}

function progressCard() {
  const days = usageDays();
  if (!days.length) return `<a class="card" href="#insights"><p class="card-label">Savings</p><h2>See what’s working</h2><p>Add your Delmarva usage file. One import, then the comparison runs automatically.</p></a>`;
  const sv = savings();
  const last = days[days.length - 1].date;
  const stale = daysAgo(last) > 14 ? `<p class="fine">Your data ends ${esc(shortDate(last))}. Import a newer file to keep this current.</p>` : '';
  const c = {
    no_change_date: ['', 'Savings tracking starts when you program your thermostat', 'The app then compares your use with what the weather predicts.'],
    insufficient: ['', 'Measuring savings…', `Collecting days: ${num(Math.min(sv.before ?? 0, 14))} of 14 before and ${num(Math.min(sv.after ?? 0, 7))} of 7 after your schedule change.`],
    likely_savings: ['good', `Using about ${num(sv.weather?.pct, 0)}% less than expected`, 'Since your schedule change, adjusted for the weather.'],
    likely_increase: ['warn', 'Use is up since your schedule change', `About ${num(-sv.weather?.pct, 0)}% more than the weather explains. Other changes at home can cause this.`],
    inconclusive: ['', 'No clear change yet', 'The difference is within normal day-to-day variation. More days will tell.'],
  }[sv.status] || ['', 'Savings', sv.message || ''];
  return `<a class="card ${c[0]}" href="#savings"><p class="card-label"><i class="dot"></i>Savings</p><h2>${esc(c[1])}</h2><p>${esc(c[2])}</p>${stale}</a>`;
}

function viewToday() {
  const rec = recNow();
  const st = A.todayStatus(S, rec);
  const main = [hero(st, rec), st.kind === 'setup' ? '' : learnedToday(), programCard(st, rec)];
  const hint = A.seasonHint(S.profile, rec.outlook);
  if (hint && st.kind !== 'setup' && !(UI.seasonDismissed && Date.now() - UI.seasonDismissed < 3 * 864e5)) {
    main.push(`<section class="card warn"><p class="card-label"><i class="dot"></i>Season check</p><h2>${hint === 'cool_available' ? 'Warm days ahead. Has your building switched to cooling?' : 'Cold days ahead. Has your building switched to heating?'}</h2><div class="row2"><button class="btn primary" data-act="season" data-v="${hint}">Yes, switch</button><button class="btn secondary" data-act="dismiss-season">Not yet</button></div></section>`);
  }
  const side = [];
  const ops = opsItems()[0];
  if (ops && st.kind !== 'setup') side.push(`<a class="card ${ops.tone === 'warn' ? 'warn' : ''}" href="#insights"><p class="card-label"><i class="dot"></i>Heads-up</p><h2>${esc(ops.title)}</h2><p>${esc(ops.detail)}</p></a>`);
  side.push(weatherCard(rec));
  if (st.kind !== 'setup') side.push(progressCard());
  if (st.kind === 'ok') side.push(`<a class="card" href="#schedule"><p class="card-label">Thermostat schedule</p><h2>Programmed ${esc(shortDate(st.programmedOn))}</h2><p>See or print the weekly schedule.</p></a>`);
  if (IOS && !STANDALONE) side.push('<p class="fine center">Install: tap Share → Add to Home Screen.</p>');
  return `${pagehead('Today', esc(fmtNY(Date.now(), { weekday: 'long', month: 'long', day: 'numeric' })))}<div class="today"><div class="stack">${main.join('')}</div><div class="stack">${side.join('')}</div></div>`;
}

function viewSchedule() {
  const rec = recNow();
  if (!rec.plans.length) return `${back('today', 'Today')}${pagehead('Weekly schedule')}<section class="card"><p>No heating or cooling schedule right now.</p></section>`;
  const st = A.todayStatus(S, rec);
  return `${back('today', 'Today')}${pagehead('Weekly schedule', st.kind === 'ok' ? `Programmed ${esc(shortDate(st.programmedOn))}` : 'Not programmed yet')}
    <div class="grid">${scheduleTables(rec)}</div>
    <section class="card"><h2>Thermostat model</h2><p>The guided steps are for the Emerson IntelliTEMP IT900 that Delmarva installed for Energy Wise Rewards. Another thermostat? Enter these same times and temperatures using its own instructions.</p><p class="fine">Reference: Delmarva’s <a href="${MANUAL_URL}" target="_blank" rel="noopener noreferrer">IT900 manual</a>.</p></section>
    <div class="row2 no-print"><a class="btn primary" href="#program">Program thermostat</a><button class="btn secondary" data-act="print">Print</button></div>`;
}

// ---------- Insights ----------

/** Public weather findings from the cloud operator (it never sees household data); "for your home" lines are computed here. */
function findingsList() {
  const fc = A.forecastUse(C.energyWeatherModel(S.usage, allTemps()), recNow().outlook, S.profile.tariff);
  const typical = usageTrend()?.avg;
  const ops = opsItems().map((x) => {
    const mine = A.personalizeFinding(x, fc, typical);
    return { tone: x.tone, title: x.title, detail: `${x.detail}${x.action ? ` ${x.action}` : ''}${mine ? ` ${mine}` : ''}`, src: mine ? 'Automatic weather review + your data, on this device' : 'Automatic weather review' };
  });
  return ops.length ? findingUl(ops) : '<p class="fine">No weather alerts right now.</p>';
}
const findingUl = (list) => `<ul class="findings">${list.map((x) => `<li class="${esc(x.tone)}"><b>${esc(x.title)}</b><span>${esc(x.detail)}</span>${x.src ? `<span class="src">${esc(x.src)}</span>` : x.prelim ? '<span class="src">Preliminary</span>' : ''}</li>`).join('')}</ul>`;
const CONF = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence', info: 'Worth checking' };
const report = () => A.usageReport({ state: S, temps: allTemps() });
const actionsFor = (r) => A.opportunities({ state: S, rec: recNow(), model: C.energyWeatherModel(S.usage, allTemps()), summary: C.usageSummary(S.usage, S.profile.tariff), report: r });
const applyBtn = (o) => `<button class="btn secondary" data-act="apply" data-k="${esc(o.apply.k)}" data-v="${o.apply.v}" data-label="${esc(o.apply.label)}">Use ${o.apply.v}°</button>`;
const thermo = (o) => o.thermostat || (o.reprogram ? 'Needs a thermostat schedule update.' : 'No thermostat change needed.');
const actionItem = (o) => `<li><b>${esc(o.what)}</b><span>${esc(o.why)}</span><span><i>Evidence:</i> ${esc(o.evidence)}</span>${o.impact ? `<span><i>Difference it could make:</i> ${esc(o.impact)}</span>` : ''}${o.investigate ? `<span><i>How to check:</i> ${esc(o.investigate)}</span>` : ''}<span><i>${CONF[o.confidence]}.</i> ${esc(o.confidenceWhy)} ${esc(thermo(o))}</span>${o.apply ? applyBtn(o) : ''}</li>`;
/** Deterministic suggestions from this home's data; each says what, why, evidence, difference, confidence and the thermostat step. */
function actionsCard(r = null) {
  const items = actionsFor(r), nc = A.noChangeSummary(r, items);
  if (!items.length && !nc) return '';
  return `<h2 class="section-title">Recommended actions <span class="kind-chip">Recommended</span></h2><section class="card">${nc ? `<p class="nochange">${esc(nc)}</p>` : ''}${items.length ? `<ul class="findings actions">${items.slice(0, 5).map(actionItem).join('')}</ul>` : ''}</section>`;
}
const LEVEL = {
  day: (r) => `Based on ${r.n} full day${r.n === 1 ? '' : 's'} — enough for the daily pattern, not yet for trends.`,
  days: (r) => `Based on ${r.n} days — early observations, marked preliminary.`,
  weeks: (r) => `Based on ${r.n} days.`,
  months: (r) => `Based on ${r.n} days, about ${Math.round(r.n / 30)} months.`,
  partial: () => 'Less than one full day so far.',
};
/** The report: key numbers, what stands out, and the typical day, with the rest one tap away. */
function learnedSection(r) {
  const list = A.buildInsights({ state: S, temps: allTemps() });
  const top = list.slice(0, 4), more = list.slice(4);
  const pk = r.peak, nt = r.night;
  const day = r.prof ? disclosure('typical-day', 'Your typical day, hour by hour', `<p class="fine">${esc(`Average use for each hour across ${r.hd.length} day${r.hd.length === 1 ? '' : 's'}.${pk ? ` The tallest bars, ${hourLabel(pk.start)}–${hourLabel(pk.end % 24)}, are your busiest hours.` : ''}${nt ? ` The lowest, around ${num(nt.base)} W, is what never switches off.` : ''}`)}</p>${barChart(r.prof, { label: 'Average electricity use by hour of day', ticks: r.prof.map((_, h) => hourLabel(h)), tips: r.prof.map((v, h) => `${hourLabel(h)}: ${num(v * 1000)} W average`) })}`) : '';
  return `<h2 class="section-title">What we learned <span class="kind-chip">Measured · Calculated</span></h2><section class="card learned"><p class="fine">${esc(LEVEL[r.level](r))} Calculated on this device.</p><div class="stats">${r.facts.map((f) => `<div class="stat"><b>${esc(f.v)}</b><span>${esc(f.l)}</span></div>`).join('')}</div>${findingUl(top)}${more.length ? disclosure('more-findings', `${more.length} more finding${more.length === 1 ? '' : 's'}`, findingUl(more)) : ''}${day}</section>`;
}
function cantTell(r) {
  const item = (c) => `<li class="${c.ok ? 'done' : ''}"><span class="mark">${c.ok ? '✓' : '·'}</span><div><b>${esc(c.label)}</b><small>${esc(c.detail)}</small></div></li>`;
  return disclosure('cant-tell', 'What’s possible now, and what isn’t yet', `<ol class="checklist">${r.comparisons.map(item).join('')}</ol><p class="card-label">Can’t be determined yet</p><ul class="bullets">${r.cannot.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`);
}
/** Compact Today card once there is electricity data: the best discovery and the best next step. */
function learnedToday() {
  if (!usageDays().length) return '';
  const r = report(), top = r.findings.find((f) => f.key !== 'stale') || r.findings[0];
  const ops = actionsFor(r), best = ops.find((o) => o.confidence !== 'info'), nc = A.noChangeSummary(r, ops);
  const next = best ? `<div class="next"><p class="card-label">Best next step · ${esc(CONF[best.confidence])}</p><b>${esc(best.what)}</b><p class="fine">${esc(best.impact || best.why)}</p>${best.apply ? applyBtn(best) : ''}</div>` : nc ? `<p class="fine">${esc(nc)}</p>` : '';
  return `<section class="card learned"><p class="card-label">What we learned from your electricity data</p>${top ? `<h2>${esc(top.title)}</h2><p>${esc(top.detail)}</p>` : `<h2>${esc(r.facts.map((f) => `${f.v} ${f.l}`).slice(0, 2).join(' · '))}</h2>`}${next}<a class="btn plain" href="#insights">See your full report ›</a></section>`;
}
// ---------- AI analysis (runs only in the Mac companion; reports can be moved to the phone as a file) ----------

const AI_KEY = 'aeo.ai.v1';
const LOCAL = ['127.0.0.1', 'localhost'].includes(location.hostname) && !!document.querySelector('meta[name="aeo-companion"]'); // served by the Mac companion
let companion = null; // {model, ollama, installed, busy} when served by the Mac companion
const loadAI = () => { try { const v = JSON.parse(localStorage.getItem(AI_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const saveAI = (list) => { try { localStorage.setItem(AI_KEY, JSON.stringify(list.slice(-10))); } catch { toast('Couldn’t save the analysis on this device (storage full?).', true); } };
const validReport = (r) => r && r.kind === 'aeo-ai-analysis' && r.version === 1 && r.analysis && Array.isArray(r.analysis.discoveries) && Array.isArray(r.analysis.recommendations) && Array.isArray(r.evidence);
const evIds = (ids) => `<span class="src">Evidence ${ids.map(esc).join(', ')}</span>`;
function aiReportHtml(rp) {
  const a = rp.analysis, s = rp.stats || {};
  const disc = a.discoveries.map((d) => `<li class="${d.type === 'hypothesis' ? 'hyp' : ''}"><b>${esc(d.title)}</b><span class="kind-tag">${d.type === 'hypothesis' ? 'Hypothesis — not confirmed' : 'Observation'}</span><span>${esc(d.detail)}</span>${evIds(d.evidence)}</li>`).join('');
  const recs = a.recommendations.map((r, i) => `<li><b>${i === 0 ? 'Most likely to matter: ' : ''}${esc(r.action)}</b><span>${esc(r.why)}</span>${r.verify ? `<span><i>How to confirm:</i> ${esc(r.verify)}</span>` : ''}<span><i>${CONF[r.confidence] || 'Confidence not stated'}.</i> ${r.thermostat ? 'Involves your thermostat settings.' : 'No thermostat change needed.'}</span>${evIds(r.evidence)}</li>`).join('');
  const ev = rp.evidence.map((e) => `<li><b>${esc(e.id)} · ${esc(e.tool.replace(/_/g, ' '))}${e.args && Object.keys(e.args).length ? ` (${esc(Object.values(e.args).join(', '))})` : ''}</b><code>${esc(JSON.stringify(e.result).slice(0, 600))}</code></li>`).join('');
  const rej = (rp.rejected || []).map((x) => `<li>${esc(x.title || x.kind)} — ${esc(x.why.join('; '))}</li>`).join('');
  return `${a.summary ? `<p>${esc(a.summary)}</p>` : ''}
    ${disc ? `<p class="card-label">Discoveries</p><ul class="findings">${disc}</ul>` : '<p class="fine">No discoveries passed the evidence check.</p>'}
    ${recs ? `<p class="card-label">Recommended</p><ul class="findings actions">${recs}</ul>` : '<p class="fine">No recommendation passed the evidence check — nothing clearly worth changing.</p>'}
    ${a.next_checks.length ? `<p class="card-label">What to check next</p><ul class="bullets">${a.next_checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    <p class="fine">Analyzed by <b>${esc(rp.model)}</b>, ${esc(rp.runtime || 'on your Mac')}, ${esc(fmtNY(Date.parse(rp.created)))} · ${num(rp.data?.full_days)} days of data (${esc(rp.data?.from || '—')} – ${esc(rp.data?.to || '—')}) · ${num((s.ms || 0) / 1000)} s${rp.imported ? ' · imported from a file' : ''}. Every number above was checked against the evidence; ${rej ? `${(rp.rejected || []).length} claim${rp.rejected.length === 1 ? ' was' : 's were'} removed because the evidence didn’t support ${rp.rejected.length === 1 ? 'it' : 'them'}.` : 'nothing had to be removed.'}</p>
    ${disclosure('ai-evidence', `Evidence the AI used (${rp.evidence.length})`, `<p class="fine">Calculated on your device by the app’s tested functions; the AI only reads these results.</p><ul class="evidence">${ev}</ul>`)}
    ${rej ? disclosure('ai-rejected', 'Claims removed by the evidence check', `<ul class="bullets">${rej}</ul>`) : ''}`;
}
function aiSection() {
  const list = loadAI(), idx = Math.min(UI.aiShown ?? list.length - 1, list.length - 1), rp = list[idx];
  const has = usageDays().length > 0;
  let head;
  if (LOCAL && companion?.installed) head = busy === 'ai'
    ? `<p><b>Investigating…</b> ${esc(companion.model)} is working through your data on this Mac. This usually takes 1–3 minutes; you can keep using the app.</p>`
    : `<p>An AI model (${esc(companion.model)}) running on this Mac investigates your electricity data with the app’s tested measurements, then every claim is checked against that evidence. Nothing leaves this computer.</p>${has ? '<button class="btn primary" data-act="ai-run">Run AI investigation</button>' : '<p class="fine">Import your Delmarva file first.</p>'}`;
  else if (LOCAL && companion) head = `<p class="fine">${companion.ollama ? `The model ${esc(companion.model)} isn’t installed. In Terminal run: ollama pull ${esc(companion.model)}` : 'Ollama isn’t running. Open the Ollama app, then reload.'}</p>`;
  else head = '<p class="fine">AI investigations run on your Mac with the Energy companion (it keeps your data on that computer). Bring a finished analysis here with “Import AI analysis”.</p>';
  const hist = list.length > 1 ? disclosure('ai-history', `Previous analyses (${list.length})`, `<ul class="bullets">${list.map((r, i) => `<li><button class="link" data-act="ai-show" data-i="${i}">${esc(fmtNY(Date.parse(r.created)))} · ${esc(r.model)}${r.imported ? ' · imported' : ''}</button>${i === idx ? ' (showing)' : ''}</li>`).join('')}</ul>`) : '';
  const io = `<div class="row2">${rp ? '<button class="btn secondary" data-act="ai-export">Save analysis file</button>' : ''}<label class="btn secondary file">Import AI analysis<input type="file" id="ai-file" accept=".json,application/json"></label></div>`;
  return `<h2 class="section-title">AI analysis <span class="kind-chip">AI</span></h2><section class="card ai">${head}${rp ? `<hr>${aiReportHtml(rp)}` : ''}${hist}${io}</section>`;
}
async function runAI() {
  busy = 'ai';
  render();
  try {
    const r = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: { ...S, weatherCache: null }, temps: allTemps(), outlook: recNow().outlook }) });
    const j = await r.json();
    if (!r.ok || !validReport(j)) throw new Error(j.error || 'unexpected response');
    const list = loadAI();
    list.push(j);
    saveAI(list);
    UI.aiShown = undefined;
    toast(`AI investigation done: ${j.analysis.discoveries.length} discoveries, ${j.analysis.recommendations.length} recommendations.`);
  } catch (e) {
    toast(`AI investigation failed: ${e.message}`, true);
  }
  busy = '';
  render();
}
if (LOCAL) fetch('/api/companion').then((r) => (r.ok ? r.json() : null)).then((j) => { companion = j; render(); }).catch(() => {});

const weatherLink = () => `<a class="card" href="#weather"><p class="card-label">Weather</p><h2>Forecast and history</h2><p>Measured and forecast temperatures for ${LOC.name}.</p></a>`;

function viewInsights() {
  const days = usageDays();
  const last = days.length ? days[days.length - 1].date : null;
  const out = [pagehead('Insights', last ? `Electricity data through ${esc(dayLabel(last))}` : 'Electricity, weather and savings')];
  if (!days.length) {
    out.push(`<section class="card"><h2>See what’s actually working</h2><p>Import your Delmarva usage file. It’s analyzed on this device and matched with Wilmington weather automatically.</p>${importButton()}${busy === 'import' ? '<p class="fine">Reading…</p>' : ''}</section>`);
    out.push(disclosure('howto', 'How to get the file from Delmarva', HOW_TO_DOWNLOAD, true));
    out.push(aiSection());
    out.push(`<h2 class="section-title">Automatic weather review</h2><section class="card">${findingsList()}</section>`);
    out.push(`<div class="grid">${weatherLink()}</div>`);
    return out.join('');
  }
  const r = report(), dq = A.dataQuality(S.usage, allTemps(), todayIso());
  if (lastImport) out.push(`<section class="card good imported"><p class="card-label"><i class="dot"></i>Import complete</p><p>${esc(lastImport)}</p></section>`);
  out.push(learnedSection(r));
  out.push(actionsCard(r));
  out.push(aiSection());
  out.push(cantTell(r));
  out.push(`<h2 class="section-title">Automatic weather review</h2><section class="card">${findingsList()}<p class="fine">Public weather data reviewed by the cloud AI operator. It never sees your electricity data; any “for your home” line is calculated on this device.</p></section>`);
  out.push(dq.status === 'attention' ? `<section class="card warn"><p class="card-label"><i class="dot"></i>Data coverage</p><ul class="bullets">${dq.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>` : disclosure('coverage', 'Data coverage', `<ul class="bullets">${dq.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`));
  const sv = savings();
  const svLine = { likely_savings: `About ${num(sv.weather?.pct, 0)}% less than expected`, likely_increase: 'Use is up since the change', inconclusive: 'No clear change yet', insufficient: 'Collecting enough days', no_change_date: 'Starts when you program the thermostat' }[sv.status] || 'Savings';
  out.push(`<h2 class="section-title">Details</h2><div class="grid three">
    <a class="card" href="#usage"><p class="card-label">Electricity use</p><h2>Daily use and patterns</h2><p>Day by day, a typical day, and how weather affects it.</p></a>
    <a class="card" href="#savings"><p class="card-label">Savings</p><h2>${esc(svLine)}</h2><p>How it’s measured and what’s still uncertain.</p></a>
    ${weatherLink()}</div>`);
  out.push(`<section class="card"><h2>Newer data?</h2><p>Import the latest file anytime. Days you already have are merged, not duplicated.</p>${importButton('Import newer file')}${busy === 'import' ? '<p class="fine">Reading…</p>' : ''}</section>`);
  return out.join('');
}

function viewUsage() {
  const s = C.usageSummary(S.usage, S.profile.tariff, 60);
  if (!s) return `${back('insights', 'Insights')}${pagehead('Electricity use')}<section class="card"><p>No electricity data yet.</p>${importButton()}</section>`;
  const r = s.recent, temps = allTemps();
  const daily = barChart(r.map((d) => d.kwh), { label: 'Daily electricity use, kWh', ticks: r.map((d) => dayLabel(d.date, { month: 'numeric', day: 'numeric' })), tips: r.map((d) => `${dayLabel(d.date)}: ${num(d.kwh, 1)} kWh${d.cost != null ? ` · ${money(d.cost)}` : ''}${Number.isFinite(temps[d.date]) ? ` · ${num(temps[d.date])}°F outside` : ''}`), low: (i) => C.isWeekendDate(r[i].date) });
  const pk = A.peakWindow(s.hourProfile);
  const prof = s.hourProfile ? `<section class="card"><h2>A typical day</h2><p class="fine">Average use by hour.${pk ? ` Most use is ${hourLabel(pk.start)}–${hourLabel(pk.end % 24)} (${num(pk.share * 100)}% of a typical day).` : ''}</p>${barChart(s.hourProfile, { label: 'Average use by hour of day', ticks: s.hourProfile.map((_, h) => hourLabel(h)), tips: s.hourProfile.map((v, h) => `${hourLabel(h)}: ${num(v, 2)} kWh average`) })}</section>` : '';
  const m = C.energyWeatherModel(S.usage, temps);
  let weather = '<p class="fine">Days with both your electricity data and measured weather are matched automatically.</p>';
  if (m.n) {
    const pts = m.days.map((d) => ({ x: d.temp, y: d.kwh, tip: `${dayLabel(d.date)}: ${num(d.kwh, 1)} kWh at ${num(d.temp)}°F average` }));
    const curve = [];
    if (m.status === 'ready') {
      const lo = Math.floor(Math.min(...pts.map((p) => p.x))), hi = Math.ceil(Math.max(...pts.map((p) => p.x)));
      for (let t = lo; t <= hi; t++) curve.push({ x: t, y: Math.max(0, m.predict(C.degreeDays(t))) });
    }
    const line = m.status !== 'ready' ? `Still learning: ${m.n} of ${m.need} days matched. The pattern line appears after that.`
      : m.heat && m.heat.per > m.heat.ci ? `On colder days you use about ${num(m.heat.per * 10, 1)} kWh more per day for every 10°F below 65°F.`
        : m.cool && m.cool.per > m.cool.ci ? `On hotter days you use about ${num(m.cool.per * 10, 1)} kWh more per day for every 10°F above 65°F.`
          : `Outdoor temperature explains only ${num(Math.max(0, m.r2) * 100)}% of your day-to-day differences.`;
    weather = `<p>${esc(line)}</p>${scatterChart(pts, curve)}${disclosure('bins', 'Table by outdoor temperature', `<div class="table-wrap"><table><thead><tr><th>Outdoor average</th><th class="t">Days</th><th class="t">kWh a day</th></tr></thead><tbody>${m.bins.map((b) => `<tr><td>${b.lo}–${b.lo + 9}°F</td><td class="t">${b.n}</td><td class="t">${num(b.avg, 1)}</td></tr>`).join('')}</tbody></table></div>`)}`;
  }
  return `${back('insights', 'Insights')}${pagehead('Electricity use', `${esc(dayLabel(s.from))} – ${esc(dayLabel(s.to))}`)}
    <section class="card"><div class="stats"><div class="stat"><b>${num(s.avg, 1)}</b><span>kWh a day</span></div><div class="stat"><b>${num(s.weekdayAvg, 1)} / ${num(s.weekendAvg, 1)}</b><span>weekday / weekend</span></div><div class="stat"><b>${s.cost != null ? money(s.cost) : '—'}</b><span>${s.costSource ? esc(s.costSource) : 'cost needs a rate from your bill'}</span></div><div class="stat"><b>${s.baseLoad != null ? `${num(s.baseLoad * 1000)} W` : '—'}</b><span>always on</span></div></div></section>
    <section class="card"><h2>Day by day</h2><p class="fine">Lighter bars are weekends.</p>${daily}</section>${prof}
    <section class="card"><h2>Weather and your use</h2>${weather}</section>`;
}

function viewSavings() {
  const p = S.profile, sv = savings(), w = sv.weather;
  const headline = {
    no_change_date: ['Not started yet', sv.message],
    insufficient: ['Collecting enough days', sv.message],
    likely_savings: [`About ${num(w?.pct, 0)}% less than expected`, `${num(w?.diff)} kWh less than the weather predicts over ${w?.days} days (likely range ±${num(w?.unc)} kWh). Consistent with the schedule helping — not proof of it.`],
    likely_increase: ['Use is up since the change', `${num(-w?.diff)} kWh more than the weather predicts over ${w?.days} days (±${num(w?.unc)}).`],
    inconclusive: ['No clear change yet', `The difference (${num(w?.diff)} kWh over ${w?.days} days) is within normal variation (±${num(w?.unc)}).`],
  }[sv.status] || ['Savings', sv.message || ''];
  const item = (done, title, sub) => `<li class="${done ? 'done' : ''}"><span class="mark">${done ? '✓' : '·'}</span><div><b>${title}</b><small>${sub}</small></div></li>`;
  const checklist = `<ol class="checklist">${sv.inputs.map((i) => item(i.ok, esc(i.label), esc(i.detail))).join('')}</ol>`;
  const metered = { yes: 'Yes', partial: 'Partly (fan only)', no: 'No, the building pays', unknown: 'Not sure' };
  const row = (label, value, note) => `<tr><td>${label}<small>${note}</small></td><td class="t">${value}</td></tr>`;
  const a = sv.actual, since = sv.timeline.baselineEnd;
  const bill = !sv.savings ? '' : !sv.savings.billRelevant ? ' · not expected on your bill' : sv.savings.dollars != null ? ` · ≈ ${money(sv.savings.dollars)} ± ${money(sv.savings.dollarsUnc)}` : '';
  const breakdown = sv.status === 'no_change_date' ? '' : `<h2 class="section-title">The numbers, kept separate</h2><section class="card"><div class="table-wrap"><table class="breakdown"><tbody>
    ${row('Measured use', a.days ? `${num(a.kwh)} kWh` : '—', a.days ? `${a.days} full days since ${esc(shortDate(since))}, from your Delmarva data` : 'No full days since the change yet')}
    ${row('Billed charges', sv.billed != null ? money(sv.billed) : '—', sv.billed != null ? 'From the cost column in your Delmarva file' : 'Your file had no cost for these days')}
    ${row('Estimated energy cost', sv.estimatedCost != null ? money(sv.estimatedCost) : '—', sv.estimatedCost != null ? `Measured kWh × your ${num(sv.rate * 100, 1)}¢ rate; excludes fixed charges and taxes` : 'Needs your rate from a bill (Settings → Advanced)')}
    ${row('Weather-adjusted change', w ? `${signed(-w.pct, 1)}%` : '—', w ? `${num(w.actual)} kWh used vs. ${num(w.predicted)} kWh the baseline predicts for the actual weather` : 'Needs 14 days before and 7 after, with weather')}
    ${row('Estimated savings vs. baseline', w ? `${num(w.diff)} kWh${bill}` : '—', w ? 'Positive means less than predicted' : '—')}
    ${row('Uncertainty', w ? `±${num(w.unc)} kWh` : '—', w ? `95% range; baseline fit R² ${num(w.r2, 2)}` : '—')}
  </tbody></table></div>${sv.limitations.length ? `<p class="card-label">Limitations</p><ul class="bullets">${sv.limitations.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}</section>`;
  const versions = sv.segments?.length ? `<div class="table-wrap"><table><thead><tr><th>Schedule from</th><th class="t">Days</th><th class="t">vs. baseline</th></tr></thead><tbody>${sv.segments.map((g) => `<tr><td>${esc(shortDate(g.from))}${g.to ? ` – ${esc(shortDate(g.to))}` : ' – now'}</td><td class="t">${num(g.ev.after ?? 0)}</td><td class="t">${g.ev.diff != null ? `${num(g.ev.diff)} ± ${num(g.ev.unc)} kWh` : 'not enough days'}</td></tr>`).join('')}</tbody></table></div>` : '';
  const hist = (S.programmedHistory || []).slice().reverse();
  const history = hist.length ? `<ul class="bullets">${hist.map((h) => `<li><b>${esc(dayLabel(h.date))}</b> — ${esc(h.changes.length ? h.changes.join('; ') : 'Schedule confirmed')}</li>`).join('')}</ul>${versions}<p class="fine">Recorded when you tap “Done — it’s programmed”. The app can’t see the thermostat, so these are your confirmations, not readings from the device.</p>` : '<p class="fine">No schedule has been confirmed as programmed yet.</p>';
  return `${back('insights', 'Insights')}${pagehead('Savings')}
    <section class="card ${sv.status === 'likely_savings' ? 'good' : sv.status === 'likely_increase' ? 'warn' : ''}"><h2>${esc(headline[0])}</h2><p>${esc(headline[1])}</p></section>
    <h2 class="section-title">What’s needed</h2><section class="card">${checklist}</section>
    ${breakdown}
    <section class="card"><h2>Is heating and cooling on your electric meter?</h2><p>In many apartment buildings the building pays for heating and cooling. If so, a better schedule saves building energy but won’t change your bill.</p><label class="item"><span>On our meter?</span><select data-k="profile.hvacMetered" data-label="Heating/cooling on our meter" data-rerender>${Object.entries(metered).map(([v, l]) => `<option value="${v}" ${p.hvacMetered === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></section>
    <h2 class="section-title">How it’s measured</h2><section class="card"><p>${esc(sv.method || 'Before the change, the app learns how your daily use follows outdoor temperature (and weekdays vs. weekends). After it, the app predicts what you would have used in the actual weather; savings are the difference, with a likely range.')}</p><p class="fine">A before-and-after comparison can’t prove the thermostat caused a change: guests, travel, new appliances or building changes also move usage. Missing or partial days are left out, never filled in.</p></section>
    ${disclosure('sv-history', 'Schedule history', history)}
    ${disclosure('sv-date', 'Change the start date', `<label class="field">Schedule change date<input type="date" data-k="profile.changeDate" data-label="Schedule change date" data-rerender value="${esc(p.changeDate)}"></label><p class="fine">Set automatically the first time you finish programming. Change it only if you started the schedule on a different day.</p>`)}`;
}

function viewWeather() {
  const st = WD.status, rec = recNow(), now = Date.now();
  const lo = st?.lastObservation;
  const ft = forecastTime();
  const nowCard = lo ? `<section class="card"><p class="card-label">Measured at Wilmington airport (KILG)</p><div class="wx"><span class="wx-temp">${num(lo.t)}°</span><div class="wx-text"><b>${esc(fmtNY(Date.parse(lo.at)))}</b><span>${lo.rh != null ? `${num(lo.rh)}% humidity` : ''}${lo.wind != null ? ` · wind ${num(lo.wind)} mph` : ''}</span></div></div>${now - Date.parse(lo.at) > 3 * HOUR ? `<p class="fine">This is the latest measurement (${esc(ago(Date.parse(lo.at)))}). New ones are added automatically.</p>` : ''}</section>`
    : `<section class="card"><h2>${WD.loaded ? 'Weather history couldn’t be loaded right now' : 'Loading weather…'}</h2><p>${WD.loaded ? 'You may be offline. It appears automatically when the connection is back.' : ''}</p></section>`;
  const obsPts = Object.entries(WD.obs).filter(([k, r]) => r.t != null && Date.parse(k) >= now - 72 * HOUR).map(([k, r]) => ({ x: Date.parse(k), y: r.t, tip: `${fmtNY(Date.parse(k))}: ${num(r.t)}°F measured` })).sort((a, b) => a.x - b.x);
  const fcPts = forecastHours().filter((h) => h.t >= now - HOUR && h.t <= now + 48 * HOUR).map((h) => ({ x: h.t, y: h.tempF, tip: `${fmtNY(h.t)}: ${Math.round(h.tempF)}°F forecast` }));
  const days = rec.outlook.slice(0, 7);
  const dayName = (d, i) => (i === 0 ? (d.hours < 20 ? 'Today (rest of day)' : 'Today') : dayLabel(d.date, { weekday: 'long' }));
  const list = days.length ? `<ul class="days">${days.map((d, i) => `<li><div>${esc(dayName(d, i))}${d.text ? `<div class="sky">${esc(d.text)}</div>` : ''}</div><span class="hl">${Math.round(d.high)}° <span class="lo">/ ${Math.round(d.low)}°</span></span></li>`).join('')}</ul>` : '<p class="fine">Forecast unavailable right now.</p>';
  const daily = Object.entries(WD.daily || {}).filter(([, v]) => v.complete).slice(-90);
  const mid = (d) => Date.parse(`${d}T12:00:00Z`);
  const months = Wx.monthlySummary(WD.daily).slice(-13).reverse();
  const skill = Object.entries(WD.skill || {});
  const ops = opsItems();
  return `${back('insights', 'Insights')}${pagehead('Weather', esc(LOC.name))}
    ${ops.length ? `<section class="card warn"><p class="card-label"><i class="dot"></i>Heads-up</p>${ops.map((x) => `<h2>${esc(x.title)}</h2><p>${esc(x.detail)}</p>`).join('')}</section>` : ''}
    ${nowCard}
    <section class="card"><h2>7-day forecast</h2><p class="fine">National Weather Service forecast for ${LOC.name}${ft ? `, updated ${esc(clock(ft))}` : ''}. High / low.</p>${list}</section>
    <section class="card"><h2>Hour by hour</h2><p class="fine">Solid: measured at the airport, last 3 days. Dashed: hourly forecast, next 2 days.</p>${timeChart([{ name: 'Measured', pts: obsPts }, { name: 'Forecast', pts: fcPts }], { label: 'Measured temperature for the last 3 days and forecast for the next 2 days', gap: 3 * HOUR, tick: (x) => fmtNY(x, { weekday: 'short', hour: 'numeric' }) })}</section>
    <section class="card"><h2>Last 90 days</h2><p class="fine">Daily average, with the shaded low-to-high range.</p>${timeChart([{ name: 'Daily average', pts: daily.map(([d, v]) => ({ x: mid(d), y: v.mean, tip: `${dayLabel(d)}: average ${v.mean}°F (low ${v.min}°, high ${v.max}°)${v.precip ? `, ${v.precip} in rain` : ''}` })) }], { band: daily.map(([d, v]) => ({ x: mid(d), lo: v.min, hi: v.max })), label: 'Daily average temperature with the daily low-to-high range, last 90 days', gap: 2 * 864e5, tick: (x) => new Date(x).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) })}</section>
    ${disclosure('wx-months', 'Monthly summary', `<p class="fine">Heating and cooling degree-days add up how far each day’s average was below or above 65°F, a measure of demand.</p><div class="table-wrap"><table><thead><tr><th>Month</th><th class="t">Avg</th><th class="t">Heating</th><th class="t">Cooling</th><th class="t">Rain in</th></tr></thead><tbody>${months.map((m) => `<tr><td>${esc(dayLabel(`${m.month}-15`, { month: 'short', year: 'numeric' }))}</td><td class="t">${num(m.mean, 1)}°</td><td class="t">${num(m.hdd)}</td><td class="t">${num(m.cdd)}</td><td class="t">${num(m.precip, 2)}</td></tr>`).join('')}</tbody></table></div>`)}
    ${disclosure('wx-skill', 'How accurate the forecast has been', `<p class="fine">Saved forecasts compared with what the airport measured later. Positive bias means the forecast ran warm.</p><div class="table-wrap"><table><thead><tr><th>Ahead</th><th class="t">Typical error</th><th class="t">Bias</th></tr></thead><tbody>${skill.map(([lead, s]) => `<tr><td>${esc(lead)}</td><td class="t">${s.n >= 24 ? `${num(s.mae, 1)}°F` : '—'}</td><td class="t">${s.n >= 24 ? `${signed(s.bias)}°F` : '—'}</td></tr>`).join('')}</tbody></table></div>`)}
    ${st ? `<p class="fine">${num(st.hours)} hourly measurements since ${esc(st.coverageFrom ? dayLabel(st.coverageFrom.slice(0, 10), { month: 'short', year: 'numeric' }) : '—')}, collected automatically every hour, even when this device is off. Updated ${esc(ago(Date.parse(st.updatedAt)))}.</p>` : ''}`;
}

// ---------- Settings ----------

const stepper = (k, label) => `<div class="item"><span>${label}</span><div class="stepper"><button data-act="step" data-k="${k}" data-label="${esc(label)}" data-d="-1" aria-label="Lower ${esc(label)}">−</button><b>${getPath(S, k)}°</b><button data-act="step" data-k="${k}" data-label="${esc(label)}" data-d="1" aria-label="Raise ${esc(label)}">+</button></div></div>`;
const timeItem = (k, label) => `<label class="item"><span>${label}</span><input type="time" data-k="${k}" data-label="${esc(label)}" value="${esc(getPath(S, k))}" step="900"></label>`;
const selItem = (k, label, opts) => `<label class="item"><span>${label}</span><select data-k="${k}" data-label="${esc(label)}" data-rerender>${opts.map(([v, l]) => `<option value="${v}" ${getPath(S, k) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
const numItem = (k, label, attrs) => `<label class="item"><span>${label}</span><input type="number" data-k="${k}" data-label="${esc(label)}" value="${esc(getPath(S, k) ?? '')}" inputmode="decimal" ${attrs}></label>`;
const group = (head, sub, body) => `<section class="group">${head ? `<div class="group-head"><h2>${head}</h2>${sub ? `<p>${sub}</p>` : ''}</div>` : ''}${body}</section>`;

function routineGroup(day) {
  const r = S.profile.routine[day], home = !r.leave && !r.back;
  const k = (f) => `profile.routine.${day}.${f}`;
  const w = day === 'weekday' ? 'Weekday' : 'Weekend';
  return group(DAYWORD[day], day === 'weekday' ? 'Monday to Friday' : 'Saturday and Sunday', `${timeItem(k('wake'), 'Wake up')}
    <label class="item"><span>Someone is home all day</span><span class="switch"><input type="checkbox" data-home="${day}" ${home ? 'checked' : ''}><i></i></span></label>
    ${home ? '' : `${timeItem(k('leave'), 'Leave home')}${timeItem(k('back'), 'Back home')}`}${timeItem(k('sleep'), 'Bedtime')}
    <p class="field-error" id="err-${day}" role="alert" hidden></p>`).replace(/data-label="(Wake up|Leave home|Back home|Bedtime)"/g, (_, l) => `data-label="${w} ${l.toLowerCase()}"`);
}

function savedBanner() {
  if (!savedNote || Date.now() - savedNote.at > 120e3) return '<div id="saved" aria-live="polite"></div>';
  const st = A.todayStatus(S, recNow());
  const todo = st.kind === 'update' || st.kind === 'program';
  const tail = st.kind === 'update' ? 'Your thermostat schedule changed. <a href="#today">Update it from Today</a>.'
    : st.kind === 'program' ? 'Program your thermostat from <a href="#today">Today</a> when you’re ready.'
      : st.kind === 'ok' ? 'Your programmed thermostat schedule still matches.' : '';
  return `<div id="saved" aria-live="polite"><div class="saved ${todo ? 'todo' : ''}">${todo ? ic.alert : ic.check}<div><b>Saved: ${esc(savedNote.what)}</b>${tail}</div></div></div>`;
}
function noteSaved(what) {
  savedNote = { what, at: Date.now() };
  const box = $('#saved');
  if (box) box.outerHTML = savedBanner();
  else toast(`Saved: ${what}.`);
}

function viewSettings() {
  const p = S.profile;
  const modes = C.BUILDING_MODES[p.buildingMode] ?? [];
  const days = usageDays();
  const obs = [...S.observations].sort((a, b) => b.ts - a.ts).slice(0, 8);
  const advanced = `
    ${group('Equipment', 'Unknown equipment keeps heating setbacks to 2°F, as Delmarva’s manual advises for heat pumps.', `${selItem('profile.hvacType', 'Heating/cooling type', [['unknown', 'Not sure'], ['heat_pump', 'Heat pump'], ['electric_resistance', 'Electric resistance'], ['fan_coil', 'Fan coil (building water)'], ['gas_or_boiler', 'Gas furnace / boiler'], ['other', 'Other']])}${selItem('profile.hvacMetered', 'On our electric meter?', [['unknown', 'Not sure'], ['yes', 'Yes'], ['partial', 'Partly (fan only)'], ['no', 'No, the building pays']])}`)}
    ${group('Away and sleep temperatures', 'These follow your comfort temperature automatically.', `${stepper('profile.comfort.heat.away', 'Heat when away')}${stepper('profile.comfort.heat.sleep', 'Heat while asleep')}${stepper('profile.comfort.cool.away', 'Cooling when away')}${stepper('profile.comfort.cool.sleep', 'Cooling while asleep')}${numItem('profile.recoveryMin', 'Warm-up lead (min)', 'min="0" max="120" step="15"')}${numItem('profile.comfort.min', 'Never below °F', 'min="50" max="75"')}${numItem('profile.comfort.max', 'Never above °F', 'min="70" max="90"')}`)}
    ${group('Electric rate', 'Dollar figures stay hidden until a rate is confirmed. No rate is ever assumed.', `${numItem('profile.tariff.centsPerKwh', 'Energy charge ¢/kWh', 'min="0" max="100" step="0.01"')}<label class="item"><span>Confirmed on my bill</span><span class="switch"><input type="checkbox" data-k="profile.tariff.confirmed" data-label="Rate confirmed" data-rerender ${p.tariff.confirmed ? 'checked' : ''}><i></i></span></label>`)}
    ${group('Thermostat notes', 'Optional notes about what the display showed. Never treated as the live state of the thermostat.', `<div class="item col"><div class="fields"><label class="field">Room °F<input type="number" id="o-room" inputmode="numeric" min="40" max="100"></label><label class="field">Setpoint °F<input type="number" id="o-set" inputmode="numeric" min="40" max="100"></label><label class="field">Display<select id="o-hold"><option value="none">SET AT</option><option value="hold">HOLD AT</option></select></label><label class="field">Note<input type="text" id="o-note" maxlength="120"></label></div><button class="btn secondary" data-act="add-obs">Save note</button></div>${obs.map((o) => `<div class="item"><span>${num(o.roomF)}° room · ${o.hold !== 'none' ? 'HOLD AT' : 'SET AT'} ${num(o.setF)}°<small>${esc(new Date(o.ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}${o.note ? ` · ${esc(o.note)}` : ''}</small></span><button class="btn plain" data-act="del-obs" data-ts="${o.ts}" aria-label="Delete note">Delete</button></div>`).join('')}`)}
    ${group('Thermostat', '', `<div class="item col"><p>Supported model: Emerson IntelliTEMP IT900 (installed by Delmarva for Energy Wise Rewards). The guided steps follow Delmarva’s <a href="${MANUAL_URL}" target="_blank" rel="noopener noreferrer">IT900 manual</a>. Another thermostat? Use the weekly schedule table with its own instructions.</p><p class="fine">This app only recommends. It never sends anything to the thermostat.</p><details class="inline"><summary>Ask Delmarva about remote programming</summary><p class="fine">Use the <a href="${SUPPORT_URL}" target="_blank" rel="noopener noreferrer">contact form</a> or call 866-353-5799:</p><pre class="msg">${esc(SUPPORT_MSG)}</pre><button class="btn secondary" data-act="copy-support">Copy message</button></details></div>`)}
    ${group('', '', '<a class="item link" href="#setup">Redo quick setup</a><button class="item danger" data-act="erase">Erase everything on this device</button>')}`;
  const left = `
    ${group('Apartment', 'What is the building providing right now?', `<div class="item col">${seasonSeg('What the building provides')}</div>`)}
    ${group('Comfort at home', 'Away and sleep temperatures move with these automatically.', `${modes.includes('heat') || p.buildingMode === 'unknown' ? stepper('profile.comfort.heat.home', 'Heat to') : ''}${modes.includes('cool') || p.buildingMode === 'unknown' ? stepper('profile.comfort.cool.home', 'Cool to') : ''}${p.buildingMode === 'fan_only' ? '<div class="item"><span class="muted">No heating or cooling to set right now</span></div>' : ''}`)}
    ${routineGroup('weekday')}${routineGroup('weekend')}`;
  const right = `
    ${group('Electricity data', 'Used only on this device to measure what’s working.', `<div class="item"><span>Latest data</span><span class="value">${days.length ? `${esc(dayLabel(days[days.length - 1].date))} · ${days.length} days` : 'None yet'}</span></div><div class="item col">${importButton()}${busy === 'import' ? '<p class="fine">Reading…</p>' : ''}<details class="inline"><summary>How to get the file from Delmarva</summary>${HOW_TO_DOWNLOAD}</details></div>${days.length ? '<button class="item danger" data-act="clear-usage">Delete electricity data</button>' : ''}`)}
    ${group('Privacy and backup', 'Your settings and electricity data stay on this device. The app only downloads public weather for Wilmington; nothing personal is sent anywhere.', `<div class="item col"><div class="row2"><button class="btn primary" data-act="export">Save backup</button><label class="btn secondary file">Restore backup<input type="file" id="backup-file" accept=".json,application/json"></label></div><p class="fine">A backup file lets you restore everything later or move to a new phone.</p></div>`)}
    ${disclosure('advanced', 'Advanced', advanced)}
    ${IOS && !STANDALONE ? '<p class="fine center">Install: tap Share → Add to Home Screen. The installed app keeps its own data, separate from Safari.</p>' : ''}`;
  return `${pagehead('Settings')}${savedBanner()}<div class="settings-cols"><div class="stack">${left}</div><div class="stack">${right}</div></div>`;
}

const SUPPORT_MSG = 'I have a Delmarva Power Energy Wise Rewards web-programmable Emerson thermostat, likely an IntelliTEMP IT900. In My Account, Program Your Thermostat -> View Thermostat fails with: "The remote name could not be resolved: apigateway-east.exeloncorp.com". Is remote programming for legacy thermostats currently supported, planned to be restored, or discontinued? Is there an official replacement portal or authorized integration/API? Can you identify the hardware revision and the purpose of the small modular-style jack on the side? I want to keep the existing thermostat working safely and avoid modifying the utility equipment. Please respond by email if possible.';

// ---------- guided setup (4 steps) ----------

const SETUP_STEPS = 4;
function startSetup() {
  const p = S.profile;
  draft = { buildingMode: p.buildingMode, wd: { ...p.routine.weekday }, we: { ...p.routine.weekend }, wdAway: !!(p.routine.weekday.leave && p.routine.weekday.back), weHome: !(p.routine.weekend.leave && p.routine.weekend.back), heat: p.comfort.heat.home, cool: p.comfort.cool.home };
  if (!draft.wd.leave) Object.assign(draft.wd, AWAY_DEFAULT.weekday);
  if (!draft.we.leave) Object.assign(draft.we, AWAY_DEFAULT.weekend);
  setupStep = 0;
  setupError = '';
}
const choice = (act, v, label, on, sub = '') => `<button class="choice" data-act="${act}" data-v="${v}" aria-pressed="${on}"><b>${label}</b>${sub ? `<span>${sub}</span>` : ''}</button>`;
const tinput = (id, label, v) => `<label class="field">${label}<input type="time" id="${id}" value="${esc(v)}" step="900"></label>`;
const flowTop = (cancelHref, cancelAct, n, total) => `<div class="flow-top"><a class="btn plain" href="#${cancelHref}"${cancelAct ? ` data-act="${cancelAct}"` : ''}>Cancel</a><span class="steptext">Step ${n} of ${total}</span></div><progress class="flow-progress" max="${total}" value="${n}" aria-label="Step ${n} of ${total}"></progress>`;

function viewSetup() {
  if (!draft) startSetup();
  const d = draft;
  const steps = [
    () => `<h1>What is your building providing right now?</h1><p class="lead">Apartment buildings switch between heating and cooling by season.</p>${choice('setup-season', 'heat_available', 'Heat', d.buildingMode === 'heat_available', 'Heating season')}${choice('setup-season', 'cool_available', 'Cooling', d.buildingMode === 'cool_available', 'Air conditioning season')}${choice('setup-season', 'fan_only', 'Fan only', d.buildingMode === 'fan_only', 'Between seasons')}${choice('setup-season', 'unknown', 'Not sure', d.buildingMode === 'unknown', 'You can choose later')}`,
    () => `<h1>Your weekdays</h1><p class="lead">So it’s comfortable when you’re up and home, and eases off otherwise.</p><div class="fields">${tinput('s-wd-wake', 'Wake up', d.wd.wake)}${tinput('s-wd-sleep', 'Bedtime', d.wd.sleep)}</div><p class="q">Is the apartment usually empty during the day?</p><div class="row2">${choice('setup-wdaway', '1', 'Yes', d.wdAway)}${choice('setup-wdaway', '0', 'No, someone’s home', !d.wdAway)}</div>${d.wdAway ? `<div class="fields">${tinput('s-wd-leave', 'Leave', d.wd.leave)}${tinput('s-wd-back', 'Back', d.wd.back)}</div>` : ''}`,
    () => `<h1>Your weekends</h1><div class="fields">${tinput('s-we-wake', 'Wake up', d.we.wake)}${tinput('s-we-sleep', 'Bedtime', d.we.sleep)}</div><p class="q">Is someone usually home all day?</p><div class="row2">${choice('setup-wehome', '1', 'Yes', d.weHome)}${choice('setup-wehome', '0', 'No, we go out', !d.weHome)}</div>${d.weHome ? '' : `<div class="fields">${tinput('s-we-leave', 'Leave', d.we.leave)}${tinput('s-we-back', 'Back', d.we.back)}</div>`}`,
    () => {
      const heat = d.buildingMode === 'heat_available' || d.buildingMode === 'unknown', cool = d.buildingMode === 'cool_available' || d.buildingMode === 'unknown';
      const st = (k, label) => `<div class="big-stepper"><span>${label}</span><div class="stepper"><button data-act="setup-temp" data-k="${k}" data-d="-1" aria-label="Lower ${label}">−</button><b>${d[k]}°</b><button data-act="setup-temp" data-k="${k}" data-d="1" aria-label="Raise ${label}">+</button></div></div>`;
      return `<h1>Comfortable temperature at home</h1><p class="lead">The app eases off a little while you’re away or asleep: small changes you won’t notice.</p>${heat ? st('heat', 'Heating') : ''}${cool ? st('cool', 'Cooling') : ''}${!heat && !cool ? '<p class="lead">No heating or cooling right now, so nothing to set. You can change the season anytime in Settings.</p>' : ''}`;
    },
  ];
  const last = setupStep === SETUP_STEPS - 1;
  return `<div class="flow">${flowTop('today', 'setup-cancel', setupStep + 1, SETUP_STEPS)}
    <div class="flow-body">${setupError ? `<p class="form-error" role="alert">${esc(setupError)}</p>` : ''}${steps[setupStep]()}</div>
    <div class="flow-bar">${setupStep ? '<button class="btn secondary" data-act="setup-back">Back</button>' : '<span></span>'}<button class="btn primary" data-act="${last ? 'setup-done' : 'setup-next'}">${last ? 'Finish' : 'Next'}</button></div></div>`;
}

function readSetupInputs() {
  const v = (id) => $(`#${id}`)?.value;
  const d = draft;
  if (setupStep === 1) { d.wd.wake = v('s-wd-wake') || d.wd.wake; d.wd.sleep = v('s-wd-sleep') || d.wd.sleep; if (d.wdAway) { d.wd.leave = v('s-wd-leave') || d.wd.leave; d.wd.back = v('s-wd-back') || d.wd.back; } }
  if (setupStep === 2) { d.we.wake = v('s-we-wake') || d.we.wake; d.we.sleep = v('s-we-sleep') || d.we.sleep; if (!d.weHome) { d.we.leave = v('s-we-leave') || d.we.leave; d.we.back = v('s-we-back') || d.we.back; } }
}
const draftRoutine = (d) => ({
  weekday: { wake: d.wd.wake, sleep: d.wd.sleep, leave: d.wdAway ? d.wd.leave : '', back: d.wdAway ? d.wd.back : '' },
  weekend: { wake: d.we.wake, sleep: d.we.sleep, leave: d.weHome ? '' : d.we.leave, back: d.weHome ? '' : d.we.back },
});
/** The error a routine would produce, or '' when it can be turned into a valid schedule. */
function routineError(r) {
  try { C.buildDay(r, C.guardSetpoints('heat', S.profile), S.profile.recoveryMin); return ''; } catch (e) { return e.message; }
}

function finishSetup() {
  const d = draft, p = S.profile, c = p.comfort;
  p.buildingMode = d.buildingMode;
  p.routine = draftRoutine(d);
  const shift = (m, home) => { const dlt = home - c[m].home; c[m].home += dlt; c[m].away += dlt; c[m].sleep += dlt; };
  shift('heat', d.heat);
  shift('cool', d.cool);
  p.setupDone = true;
  save();
  draft = null;
  location.hash = 'today';
}

// ---------- guided programming ----------

function viewProgram() {
  const rec = recNow();
  if (!rec.plans.length) { location.hash = 'today'; return ''; }
  const steps = A.programSteps(rec.plans);
  progStep = Math.min(progStep, steps.length - 1);
  const s = steps[progStep];
  const words = { heat: 'Heat to', cool: 'Cool to' };
  let body;
  if (s.kind === 'intro') {
    body = `<h1>Program your thermostat</h1><p class="lead">Stand at the thermostat. You’ll enter a start time and a temperature for four periods, once for weekdays and once for weekends${rec.plans.length > 1 ? ', for heating and then cooling' : ''}. About 5 minutes.</p>
      <section class="card"><h2>Buttons you’ll use</h2><ul class="keylist"><li><kbd class="key">▲</kbd><kbd class="key">▼</kbd><span>change the highlighted value</span></li><li><kbd class="key">►</kbd><span>moves to the next value</span></li><li><kbd class="key">HOME</kbd><span>start over if you get lost. Nothing is saved until you press <kbd class="key">DONE</kbd>.</span></li></ul></section>
      <p class="fine">For the Emerson IntelliTEMP IT900 (Delmarva Energy Wise Rewards). Different thermostat? <a href="#schedule">Use the schedule table</a> with its own instructions.</p>`;
  } else if (s.kind === 'period') {
    body = `<p class="eyebrow">${esc(s.group)} · ${modeName(s.mode)}</p><h1>${esc(s.name)}</h1>
      <div class="lcd" aria-label="What the thermostat should show"><div class="lcd-row"><small>${esc(s.group.toUpperCase())} · ${esc(s.name.toUpperCase())}</small><small>${s.mode === 'heat' ? 'HEAT' : 'COOL'}</small></div><div class="lcd-row lcd-big"><span>${esc(s.time)}</span><span>${s.temp}°</span></div></div>
      <ol class="steps"><li>${keys(`Set ${s.name} start time to ${s.time} with ▲/▼, then press ►.`)}</li><li>${keys(`Set ${words[s.mode]} to ${s.temp}° with ▲/▼, then press ►.`)}</li></ol>
      ${s.away ? '<p class="fine">This is the “away” period, where most of the saving happens.</p>' : ''}<p class="fine">The screen layout can differ slightly; match the values.</p>`;
  } else if (s.kind === 'check') {
    body = `<h1>Check the screen</h1><p class="lead">The home screen should say <b>SET AT</b> (not HOLD AT) and show today’s temperature.</p><p class="fine">From now on the thermostat follows this schedule by itself. Today tells you if it ever needs updating.</p>`;
  } else body = `<h1>${esc(s.title)}</h1><ol class="steps">${s.lines.map((l) => `<li>${keys(l)}</li>`).join('')}</ol>`;
  const last = progStep === steps.length - 1;
  return `<div class="flow"><div class="flow-top"><a class="btn plain" href="#today">Close</a><span class="steptext">Step ${progStep + 1} of ${steps.length}</span></div><progress class="flow-progress" max="${steps.length}" value="${progStep + 1}" aria-label="Step ${progStep + 1} of ${steps.length}"></progress>
    <div class="flow-body">${body}</div>
    <div class="flow-bar">${progStep ? '<button class="btn secondary" data-act="prog-back">Back</button>' : '<span></span>'}<button class="btn primary" data-act="${last ? 'programmed' : 'prog-next'}">${last ? 'Done — it’s programmed' : progStep ? 'Next' : 'I’m at the thermostat'}</button></div></div>`;
}

// ---------- rendering ----------

const ROUTES = { today: viewToday, insights: viewInsights, settings: viewSettings, setup: viewSetup, program: viewProgram, weather: viewWeather, usage: viewUsage, savings: viewSavings, schedule: viewSchedule };
const PARENT = { weather: 'insights', usage: 'insights', savings: 'insights', schedule: 'today' };
const TITLES = { setup: 'Setup', program: 'Program thermostat', weather: 'Weather', usage: 'Electricity use', savings: 'Savings', schedule: 'Weekly schedule' };
const route = () => { const h = location.hash.slice(1); return ROUTES[h] ? h : 'today'; };

function render() {
  const r = route();
  const flow = r === 'setup' || r === 'program';
  document.body.classList.toggle('in-flow', flow);
  const tab = PARENT[r] || r;
  document.querySelectorAll('[data-tab]').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false'));
  $('#view').innerHTML = ROUTES[r]();
  document.title = `${TITLES[r] || TABS.find(([k]) => k === r)[1]} · Energy`;
}

// ---------- data loading (automatic) ----------

async function fetchJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctl.signal, referrerPolicy: 'no-referrer' });
    if (!r.ok) throw new Error(`${new URL(url).host} returned HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('timed out');
    if (e instanceof TypeError) throw new Error('offline or unreachable');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Public weather history collected every hour in the cloud (read-only service, with this site's copy as fallback). */
async function loadWeather() {
  const one = async (u) => { try { const r = await fetch(u, { cache: 'no-cache', signal: AbortSignal.timeout(10e3) }); return r.ok ? await r.json() : null; } catch { return null; } };
  const get = async (f) => (LOCAL ? null : await one(API + f)) ?? one(`data/weather/${f}`); // on the Mac companion the same public files come through the companion
  const months = [...new Set([0, 4].map((d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 7)))];
  const [status, daily, skill, latest, insights, ...obs] = await Promise.all([get('status.json'), get('daily.json'), get('skill.json'), get('forecast/latest.json'), get('insights.json'), ...months.map((m) => get(`obs/${m}.json`))]);
  WD = { loaded: true, status, daily, skill, latest, insights, obs: Object.assign({}, ...obs.filter(Boolean)) };
}

async function refreshForecast() {
  const wc = S.weatherCache;
  if (wc && Date.now() - wc.fetchedAt < 3600e3) return;
  try {
    let url = wc?.hourlyUrl;
    if (!url) {
      const pts = await fetchJson(`https://api.weather.gov/points/${LOC.lat},${LOC.lon}`);
      url = pts?.properties?.forecastHourly;
      if (!url || !url.startsWith('https://api.weather.gov/')) throw new Error('no forecast link');
    }
    S.weatherCache = { fetchedAt: Date.now(), hourlyUrl: url, hours: C.parseNwsHourly(await fetchJson(url)).slice(0, 168) };
  } catch {
    if (S.weatherCache) S.weatherCache.hourlyUrl = null; // re-resolve next time
    const fetched = WD.latest ? Date.parse(WD.latest.fetchedAt) : 0;
    if (fetched && (!S.weatherCache || fetched > S.weatherCache.fetchedAt)) S.weatherCache = { fetchedAt: fetched, hourlyUrl: null, hours: WD.latest.hours.map((h) => ({ t: Date.parse(h.k), tempF: h.t, text: h.text, pop: h.pop })) };
  }
  save();
}

/** Daily temperatures for usage dates the station history doesn't cover — automatic, once per session. */
async function fillArchive() {
  if (archiveTried || !WD.loaded) return;
  const temps = allTemps();
  const missing = usageDays().map((d) => d.date).filter((d) => !Number.isFinite(temps[d]) && d < todayIso());
  if (!missing.length) return;
  archiveTried = true;
  try {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${LOC.lat}&longitude=${LOC.lon}&start_date=${missing[0]}&end_date=${missing[missing.length - 1]}&daily=temperature_2m_mean&temperature_unit=fahrenheit&timezone=America%2FNew_York`;
    S.temps = { ...S.temps, ...C.parseOpenMeteoDaily(await fetchJson(url)) };
    save();
    render();
  } catch { /* try again next session; station data covers recent dates anyway */ }
}

async function refreshAll() {
  lastRefresh = Date.now();
  await loadWeather();
  await refreshForecast();
  if (!['setup', 'program'].includes(route()) && !document.activeElement?.matches?.('input, select')) render();
  fillArchive();
}

// ---------- actions ----------

const readFile = (f) => (f.size > 25e6 ? Promise.reject(new Error('File is larger than 25 MB.')) : f.text());
const seasonName = (v) => SEASONS.find(([k]) => k === v)?.[1];

function markProgrammed() {
  const rec = recNow();
  const fp = A.planFingerprint(rec.plans), date = todayIso(), prev = S.programmed?.fingerprint;
  const changes = !prev ? ['First schedule'] : prev === fp ? ['Same schedule confirmed again'] : A.scheduleDiff(prev, rec.plans);
  S.programmedHistory = [...(S.programmedHistory || []), { date, fingerprint: fp, changes }].slice(-100);
  S.programmed = { fingerprint: fp, date };
  const first = !S.profile.changeDate;
  if (first) S.profile.changeDate = todayIso();
  save();
  return first;
}

const ACTIONS = {
  print: () => window.print(),
  season(el) {
    const was = S.profile.buildingMode;
    S.profile.buildingMode = el.dataset.v;
    save();
    if (route() === 'settings') noteSaved(`season set to ${seasonName(el.dataset.v)} (was ${seasonName(was)})`);
    else toast(`Season set: ${seasonName(el.dataset.v)}.`);
    render();
  },
  'dismiss-season'() { UI.seasonDismissed = Date.now(); saveUI(); render(); },
  step(el) {
    const k = el.dataset.k, d = Number(el.dataset.d), was = getPath(S, k);
    const m = /comfort\.(heat|cool)\.home$/.exec(k);
    if (m) { const c = S.profile.comfort[m[1]]; c.home += d; c.away += d; c.sleep += d; } // keep away/sleep offsets
    else setPath(S, k, was + d);
    save();
    noteSaved(`${el.dataset.label} ${getPath(S, k)}° (was ${was}°)`);
    render();
  },
  'setup-season'(el) { draft.buildingMode = el.dataset.v; setupStep++; setupError = ''; render(); },
  'setup-wdaway'(el) { readSetupInputs(); draft.wdAway = el.dataset.v === '1'; render(); },
  'setup-wehome'(el) { readSetupInputs(); draft.weHome = el.dataset.v === '1'; render(); },
  'setup-temp'(el) { draft[el.dataset.k] += Number(el.dataset.d); render(); },
  'setup-next'() {
    readSetupInputs();
    if (setupStep === 1 || setupStep === 2) {
      const r = draftRoutine(draft)[setupStep === 1 ? 'weekday' : 'weekend'];
      setupError = routineError(r);
      if (setupError) { render(); return; }
    }
    setupStep = Math.min(SETUP_STEPS - 1, setupStep + 1);
    render();
    window.scrollTo(0, 0);
  },
  'setup-back'() { readSetupInputs(); setupError = ''; setupStep = Math.max(0, setupStep - 1); render(); },
  'setup-cancel'() { draft = null; },
  'setup-done'() { finishSetup(); },
  'prog-next'() { progStep++; render(); window.scrollTo(0, 0); },
  'prog-back'() { progStep = Math.max(0, progStep - 1); render(); },
  programmed() {
    const first = markProgrammed();
    location.hash = 'today';
    toast(first ? 'Saved. Savings tracking starts today.' : 'Saved. Your schedule is up to date.');
  },
  apply(el) {
    const k = el.dataset.k, v = Number(el.dataset.v);
    if (!/^profile\.comfort\.(heat|cool)\.(away|sleep)$/.test(k) || !Number.isFinite(v)) return;
    const was = getPath(S, k);
    setPath(S, k, v);
    save();
    toast(`${el.dataset.label} set to ${v}° (was ${was}°). Update the thermostat from Today to use it.`);
    render();
  },
  'ai-run'() { if (busy !== 'ai') runAI(); },
  'ai-show'(el) { UI.aiShown = Number(el.dataset.i); render(); },
  async 'ai-export'() {
    const list = loadAI(), rp = list[Math.min(UI.aiShown ?? list.length - 1, list.length - 1)];
    if (!rp) return;
    const name = `energy-ai-analysis-${rp.created.slice(0, 10)}.json`;
    const file = new File([JSON.stringify(rp, null, 1)], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  'mark-programmed'() {
    if (!confirm('Mark the current recommended schedule as programmed on your thermostat?')) return;
    markProgrammed();
    render();
    toast('Saved. Today won’t ask again until the schedule changes.');
  },
  'add-obs'() {
    const v = (id) => $(id).value;
    const room = Number(v('#o-room')), set = Number(v('#o-set'));
    if (!v('#o-room') || !(room >= 40 && room <= 100)) return toast('Enter the room temperature shown (40–100°F).', true);
    S.observations.push({ ts: Date.now(), roomF: room, setF: v('#o-set') && set >= 40 && set <= 100 ? set : null, hold: v('#o-hold'), mode: 'unknown', fan: 'unknown', note: v('#o-note').slice(0, 120), source: 'manual' });
    S.observations = S.observations.slice(-500);
    save(); render(); toast('Note saved.');
  },
  'del-obs'(el) { S.observations = S.observations.filter((o) => String(o.ts) !== el.dataset.ts); save(); render(); },
  'clear-usage'() {
    if (!confirm('Delete all imported electricity data from this device?')) return;
    S.usage = { hourly: {}, daily: {}, cost: {} };
    save(); render(); toast('Electricity data deleted.');
  },
  'copy-support'() { navigator.clipboard?.writeText(SUPPORT_MSG).then(() => toast('Message copied.'), () => toast('Select the text and copy it.', true)); },
  async export() {
    const name = `energy-backup-${todayIso()}.json`;
    const file = new File([JSON.stringify({ ...S, weatherCache: null }, null, 2)], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) { // iPhone: share sheet → Save to Files
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  erase() {
    if (!confirm('Erase all settings, notes and electricity data on this device? Save a backup first if you want to keep them.')) return;
    try { localStorage.removeItem(KEY); } catch { /* blocked */ }
    S = A.migrate(null);
    location.hash = 'today';
    render(); toast('Everything on this device was erased.');
  },
};

function showTip(el, select) {
  const svg = el.closest('svg');
  if (select) {
    svg.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
    if (el.getAttribute('opacity') !== '0') el.classList.add('sel');
  }
  svg.nextElementSibling.textContent = el.dataset.tip;
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && ACTIONS[el.dataset.act]) {
    if (el.tagName !== 'A') e.preventDefault();
    ACTIONS[el.dataset.act](el);
    return;
  }
  const tip = e.target.closest('[data-tip]');
  if (tip) showTip(tip, true);
});
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.matches?.('details.disclosure')) { UI.open = { ...UI.open, [d.dataset.id]: d.open }; saveUI(); }
}, true);

async function importUsage(files) {
  busy = 'import';
  render();
  const msgs = [];
  let bad = false;
  for (const f of files) {
    try {
      const res = C.importUsageFile(f.name, await readFile(f));
      const before = S.usage;
      S.usage = C.mergeUsage(S.usage, res.records); // merges by hour/day: never deletes history, never double-counts a re-import
      msgs.push(`${files.length > 1 ? `${f.name}: ` : 'Imported '}${A.importSummary(before, S.usage, res).message}`);
    } catch (err) {
      bad = true;
      msgs.push(`Couldn’t import ${files.length > 1 ? f.name : 'that file'}: ${err.message}`);
    }
  }
  save();
  const days = usageDays(), temps = allTemps();
  const matched = days.filter((d) => Number.isFinite(temps[d.date])).length;
  const msg = `${msgs.map((m) => m.replace(/\.$/, '')).join('. ')}.${!bad && days.length ? ` ${matched} day${matched === 1 ? '' : 's'} matched with weather.` : ''}`;
  toast(bad ? msg : `${msg} Your report is ready.`, bad && msgs.length === 1);
  if (msgs.length > (bad ? 1 : 0) && days.length) {
    lastImport = msg;
    if (route() !== 'insights') location.hash = 'insights';
    window.scrollTo(0, 0);
  }
  archiveTried = false;
  fillArchive();
  busy = '';
  render();
}

/** Routine edits are checked before saving: an impossible routine is explained and the last valid one stays in use. */
function routineChange(el, k, v) {
  const day = k.split('.')[2];
  const trial = { ...S.profile.routine[day], [k.split('.')[3]]: v };
  const err = routineError(trial);
  const box = $(`#err-${day}`);
  if (err) {
    el.setAttribute('aria-invalid', 'true');
    if (box) { box.textContent = `${err} Your last valid ${day} schedule is still in use.`; box.hidden = false; }
    return;
  }
  el.removeAttribute('aria-invalid');
  if (box) box.hidden = true;
  const was = getPath(S, k);
  setPath(S, k, v);
  save();
  noteSaved(`${el.dataset.label} ${timeText(v)} (was ${timeText(was)})`);
}

function homeAllDay(el) {
  const day = el.dataset.home, r = S.profile.routine[day];
  UI.away = UI.away || {};
  let next;
  if (el.checked) { UI.away[day] = { leave: r.leave, back: r.back }; next = { ...r, leave: '', back: '' }; } else { const p = UI.away[day] || AWAY_DEFAULT[day]; next = { ...r, leave: p.leave || AWAY_DEFAULT[day].leave, back: p.back || AWAY_DEFAULT[day].back }; }
  const err = routineError(next);
  if (err) { el.checked = !el.checked; const box = $(`#err-${day}`); if (box) { box.textContent = `${err} Adjust the times first.`; box.hidden = false; } return; }
  S.profile.routine[day] = next;
  saveUI(); save();
  noteSaved(el.checked ? `${DAYWORD[day]}: someone is home all day` : `${DAYWORD[day]}: away ${timeText(next.leave)}–${timeText(next.back)}`);
  render();
}

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.id === 'usage-file' && el.files.length) return importUsage([...el.files].slice(0, 24));
  if (el.id === 'ai-file' && el.files[0]) {
    try {
      const rp = JSON.parse(await readFile(el.files[0]));
      if (!validReport(rp)) throw new Error('not an Energy AI analysis file');
      const list = loadAI();
      if (!list.some((x) => x.created === rp.created && x.model === rp.model)) list.push({ ...rp, imported: true });
      saveAI(list);
      UI.aiShown = undefined;
      render();
      toast('AI analysis imported. It stays on this device.');
    } catch (err) { toast(`Couldn’t import: ${err.message}`, true); }
    return;
  }
  if (el.id === 'backup-file' && el.files[0]) {
    try {
      const data = JSON.parse(await readFile(el.files[0]));
      if (!data || !data.profile || ![1, 2].includes(data.version)) throw new Error('not an Energy app backup');
      S = A.migrate(data);
      save();
      render();
      toast('Backup restored.');
    } catch (err) {
      toast(`Couldn’t restore: ${err.message}`, true);
    }
    return;
  }
  if (el.dataset.home) return homeAllDay(el);
  const k = el.dataset.k;
  if (!k) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (/^profile\.routine\.(weekday|weekend)\./.test(k)) return routineChange(el, k, v);
  if (el.type === 'number') {
    v = el.value === '' ? null : Number(el.value);
    if (v != null && !Number.isFinite(v)) return;
    if (v == null && !k.endsWith('centsPerKwh')) return toast('This value is required.', true);
  }
  setPath(S, k, v);
  save();
  if (el.dataset.label) noteSaved(`${el.dataset.label}${el.tagName === 'SELECT' ? `: ${el.selectedOptions[0]?.textContent}` : el.type === 'checkbox' ? (v ? ': yes' : ': no') : `: ${v ?? '—'}`}`);
  if ('rerender' in el.dataset) render();
});

$('#nav').innerHTML = `<span class="brand">Energy</span>${TABS.map(([k, l]) => `<a href="#${k}" data-tab="${k}"><svg viewBox="0 0 24 24" aria-hidden="true" class="ic">${ICON[k]}</svg><span>${l}</span></a>`).join('')}`;
window.addEventListener('hashchange', () => {
  const r = route();
  if (r === 'setup' && !draft) startSetup();
  if (r === 'program') progStep = 0; // guided programming always starts from the first screen
  if (r !== 'settings') savedNote = null;
  render();
  window.scrollTo(0, 0);
  $('#view').focus({ preventScroll: true });
});
const visible = () => document.visibilityState === 'visible';
document.addEventListener('visibilitychange', () => { if (visible() && Date.now() - lastRefresh > 10 * 60e3) refreshAll(); });
setInterval(() => { if (visible()) refreshAll(); }, 30 * 60e3); // pick up new forecasts and observations while open; nothing while hidden
render();
refreshAll();
try { navigator.storage?.persist?.(); } catch { /* optional */ }
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
