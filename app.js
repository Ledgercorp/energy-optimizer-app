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
const DAYWORD = { weekday: 'Weekdays', weekend: 'Weekends', ...Object.fromEntries(C.DOW.map((d) => [`days.${d}`, C.DAY_NAME[d]])) };
const DAYSUB = { weekday: 'Monday to Friday', weekend: 'Saturday and Sunday' };
const dayId = (day) => day.replace('.', '-');
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
  bills: '<path d="M6 2.8h12v18.4l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  savings: '<circle cx="12" cy="12" r="9"/><path d="M14.8 9.2c-.5-.9-1.6-1.4-2.8-1.4-1.6 0-2.8.8-2.8 2.1 0 2.8 5.8 1.5 5.8 4.3 0 1.3-1.3 2.2-3 2.2-1.3 0-2.5-.6-3-1.6M12 6v1.8M12 16.4V18"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5"/>',
};
const ic = {
  check: '<svg class="ic-s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="m7.5 12.3 3 3 6-6.3"/></svg>',
  alert: '<svg class="ic-s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5.5M12 16.5v.2"/></svg>',
  unplug: '<svg class="ic-s" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v4M16 3v4M6 7h12v4a6 6 0 0 1-12 0zM12 17v4"/><path d="m3 3 18 18"/></svg>',
};
const TABS = [['today', 'Today'], ['bills', 'Bills'], ['savings', 'Savings'], ['insights', 'Insights'], ['settings', 'Settings']];
const pagehead = (h, eyebrow = '') => `<header class="pagehead"><div>${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ''}<h1>${h}</h1></div></header>`;
const back = (href, label) => `<a class="back" href="#${href}">‹ ${label}</a>`;
const disclosure = (id, summary, body, open = false) => `<details class="disclosure" data-id="${id}" ${open || UI.open?.[id] ? 'open' : ''}><summary>${summary}</summary><div class="disc-body">${body}</div></details>`;
const importButton = (label = 'Import Delmarva file (usage or billing .zip)') => `<label class="btn primary file">${label}<input type="file" id="usage-file" multiple accept=".zip,.csv,.xml,application/zip,text/csv,text/xml,application/xml"></label>`;
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
  const groups = (pl) => {
    if (!pl.daysMode) return [[pl.weekday, 'Mon–Fri'], [pl.weekend, 'Sat–Sun']];
    const sig = (d) => JSON.stringify(pl.days[d].map((x) => [x.start, x.temp])), out = [];
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) { const g = out.find((x) => x.sig === sig(d)); if (g) g.days.push(d); else out.push({ sig: sig(d), days: [d] }); }
    return out.map((g) => [pl.days[g.days[0]], g.days.join(', ')]);
  };
  return rec.plans.map((pl) => `<section class="card"><h2>${modeName(pl.mode)}</h2><div class="sched-grid">${groups(pl).map(([d, t]) => table(d, t)).join('')}</div></section>`).join('');
}

// ---------- Today ----------

const seasonSeg = (label) => `<div class="seg" role="group" aria-label="${esc(label)}">${SEASONS.map(([v, l]) => `<button data-act="season" data-v="${v}" aria-pressed="${S.profile.buildingMode === v}">${l}</button>`).join('')}</div>`;

function hero(st, rec) {
  if (st.kind === 'setup' && usageDays().length && st.missing?.length) {
    return `<section class="hero"><p class="eyebrow">${st.missing.length === 1 ? 'One thing' : `${st.missing.length} things`} the thermostat schedule still needs</p><h2 class="hero-q">${esc(st.missing.map((m) => m.label).join(' and '))}</h2><p>${esc(st.missing.map((m) => m.why).join(' '))} Everything about your electricity and bills works without it.</p>
      <a class="btn primary" href="#setup">Add it (about a minute)</a></section>`;
  }
  if (st.kind === 'setup') {
    return `<section class="hero"><p class="eyebrow">Welcome</p><h2 class="hero-q">Let’s set up your thermostat plan</h2><p>Four quick questions about your apartment and routine, about a minute.</p>
      <ol class="checklist"><li><span class="mark">1</span><div><b>Tell the app your routine</b><small>When you’re up, out and asleep.</small></div></li><li><span class="mark">2</span><div><b>Program your thermostat once</b><small>Guided, step by step, about 5 minutes.</small></div></li><li><span class="mark">3</span><div><b>The app keeps watch</b><small>Weather, savings and schedule changes are tracked automatically.</small></div></li></ol>
      <a class="btn primary" href="#setup">Get started</a></section>`;
  }
  if (st.kind === 'hold') {
    const t = st.thermostat;
    return `<section class="hero ${t.mode}"><div class="hero-top"><span class="pill ${t.mode}">${modeName(t.mode)}</span><span class="hero-period">Confirmed by you${t.confirmed ? ` ${esc(shortDate(t.confirmed))}` : ''}</span></div>
      <p class="hero-label">Actual thermostat</p><div class="hero-temp"><span class="big">${t.setpoint}°</span></div>
      <p class="hero-next"><b>HOLD</b>, time-based programming <b>${t.programming === 'off' ? 'OFF' : 'ON'}</b>${t.recovery ? ` · Energy Management Recovery ${t.recovery.toUpperCase()}` : ''}${t.coolingPrice ? ` · Cooling price setting ${esc(t.coolingPrice)}` : ''}</p>
      <div class="status ok">${ic.check}<div><b>Nothing to change</b><span>This is how you run it. The app never changes the thermostat; any test is optional and yours to set.</span></div></div>
      <p class="fine">The weekly schedule in the app is an inactive proposal, not what’s on the thermostat. <a href="#schedule">See it</a> · <a href="#settings">Update your setting</a></p>${disconnected}</section>`;
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
  const hh = householdUpdate && !householdUpdate.dismissed && !(S.appliedUpdates || []).includes(householdUpdate.id) ? householdPreviewHtml(householdUpdate, 'from your Mac companion') : '';
  const main = [hh, usageDays().length ? billFirstCard() : '', hero(st, rec), usageDays().length ? '' : learnedToday(), zonesCard(), programCard(st, rec)];
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
  return `${back('today', 'Today')}${pagehead('Weekly schedule', st.kind === 'hold' ? 'Proposal only — your thermostat is on HOLD' : st.kind === 'ok' ? `Programmed ${esc(shortDate(st.programmedOn))}` : 'Not programmed yet')}${st.kind === 'hold' ? `<section class="card"><p>Inactive proposal. Your thermostat is held at ${S.profile.thermostat.setpoint}°F with programming off, by your choice. Nothing here is on the thermostat, and the app won’t change it.</p></section>` : ''}
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
  const r = report(), top = r.findings.find((f) => f.key !== 'stale' && f.key !== 'baseline') || r.findings.find((f) => f.key !== 'baseline');
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
const validReport = (r) => r && r.version === 1 && ((r.kind === 'aeo-ai-analysis' && r.analysis && Array.isArray(r.analysis.discoveries) && Array.isArray(r.analysis.recommendations) && Array.isArray(r.evidence)) || (r.kind === 'aeo-decision' && r.decision && typeof r.decision.title === 'string'));
/** The decision stage: top finding, next action, why, supporting measurements, secondary findings. */
function decisionHtml(d, deep) {
  const sec = (d.secondary || []).map((x) => `<li>${esc(x.title)} — about ${num(x.impact_kwh_month)} kWh a month</li>`).join('');
  const assist = d.model ? (d.model.used ? `Prioritization assisted by ${esc(d.model.name)} (experimental decision model).` : `The experimental decision model (${esc(d.model.name)}) was consulted, but the tested rules decided${d.model.agreed_with_rules ? ' (it agreed)' : ' (it was not confident or not supported by the evidence)'}.`) : 'Prioritized by the app’s tested rules.';
  return `<div class="decision"><p class="card-label">Highest priority</p><h3>${esc(d.title)}</h3><p>${esc(d.why)}${d.impact_kwh_month ? ` ${d.priority === 'change' ? 'If it continues' : 'Size, from your readings'}: about ${num(d.impact_kwh_month)} kWh a month.` : ''}</p>
    ${(d.measurements || []).length ? `<ul class="bullets">${d.measurements.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
    ${(d.explanations || []).length ? `<p class="card-label">Possible explanations, tested against your readings</p><ul class="findings explain">${d.explanations.map((e) => `<li class="${e.verdict === 'supported' ? 'good' : e.verdict === 'ruled out' ? 'out' : ''}"><b>${esc(e.title)}</b><span class="kind-tag">${esc(e.verdict === 'supported' ? 'Supported by the data' : e.verdict === 'ruled out' ? 'Ruled out by the data' : 'Not yet clear')}</span><span>${esc(e.why)}</span>${e.verdict !== 'ruled out' ? `<span><i>What to do:</i> ${esc(e.action)}</span><span><i>How to check:</i> ${esc(e.check)}</span>` : ''}</li>`).join('')}</ul>` : `<p><i>Next:</i> ${esc(d.next)}</p>`}
    <p class="fine">${assist} ${deep ? 'Qwen then investigated this in depth (below).' : 'No deeper AI investigation was run.'}</p>
    ${sec ? disclosure('ai-secondary', 'Other findings worth a look', `<ul class="bullets">${sec}</ul>`) : ''}</div>`;
}
const evIds = (ids) => `<span class="src">Evidence ${ids.map(esc).join(', ')}</span>`;
function aiReportHtml(rp) {
  if (rp.kind === 'aeo-decision') return `${decisionHtml(rp.decision, false)}<p class="fine">${esc(fmtNY(Date.parse(rp.created)))}${rp.imported ? ' · imported from a file' : ''}</p>`;
  const a = rp.analysis, s = rp.stats || {};
  const disc = a.discoveries.map((d) => `<li class="${d.type === 'hypothesis' ? 'hyp' : ''}"><b>${esc(d.title)}</b><span class="kind-tag">${d.type === 'hypothesis' ? 'Hypothesis — not confirmed' : 'Observation'}</span><span>${esc(d.detail)}</span>${evIds(d.evidence)}</li>`).join('');
  const recs = a.recommendations.map((r, i) => `<li><b>${i === 0 ? 'Most likely to matter: ' : ''}${esc(r.action)}</b><span>${esc(r.why)}</span>${r.verify ? `<span><i>How to confirm:</i> ${esc(r.verify)}</span>` : ''}<span><i>${CONF[r.confidence] || 'Confidence not stated'}.</i> ${r.thermostat ? 'Involves your thermostat settings.' : 'No thermostat change needed.'}</span>${evIds(r.evidence)}</li>`).join('');
  const ev = rp.evidence.map((e) => `<li><b>${esc(e.id)} · ${esc(e.tool.replace(/_/g, ' '))}${e.args && Object.keys(e.args).length ? ` (${esc(Object.values(e.args).join(', '))})` : ''}</b><code>${esc(JSON.stringify(e.result).slice(0, 600))}</code></li>`).join('');
  const rej = (rp.rejected || []).map((x) => `<li><b>${esc(x.title || x.kind)}</b> — removed because ${esc(x.why.join('; '))}${x.text ? `<br><small>It said: “${esc(x.text)}”</small>` : ''}</li>`).join('');
  return `${rp.decision ? decisionHtml(rp.decision, true) + '<hr>' : ''}${a.summary ? `<p>${esc(a.summary)}</p>` : ''}
    ${(a.explanations || []).length ? `<p class="card-label">Which explanation fits best (AI)</p><ul class="findings">${[...a.explanations, ...((rp.decision?.explanations || []).filter((x) => !a.explanations.some((e) => e.id === x.id)).map((x) => ({ title: x.title, verdict: x.verdict, assessment: 'not assessed by the AI', reasoning: x.why, evidence: [] })))].map((e) => `<li class="${e.assessment === 'most likely' ? 'good' : ''}"><b>${esc(e.title)}</b><span class="kind-tag">${esc(e.assessment)} · tests: ${esc(e.verdict)}</span><span>${esc(e.reasoning)}</span>${evIds(e.evidence)}</li>`).join('')}</ul>` : ''}
    ${disc ? `<p class="card-label">Discoveries</p><ul class="findings">${disc}</ul>` : '<p class="fine">No discoveries passed the evidence check.</p>'}
    ${recs ? `<p class="card-label">Recommended</p><ul class="findings actions">${recs}</ul>` : '<p class="fine">No recommendation passed the evidence check — nothing clearly worth changing.</p>'}
    ${a.next_question && A.QUESTIONS[a.next_question] ? `<p class="fine">The AI suggests answering: “${esc(A.QUESTIONS[a.next_question].text({ since: rp.decision?.tests?.from || '', day: rp.decision?.tests?.day, part: rp.decision?.tests?.part, bigDay: rp.decision?.tests?.biggest_day?.date }))}” — <a href="#investigate">answer it on the Investigation page</a>.</p>` : ''}
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
    ? `<p><b>Investigating…</b> ${esc(companion.model)} is working through your data on this Mac. This usually takes 1–3 minutes; you can keep using the app.</p><button class="btn secondary" data-act="ai-cancel">Stop</button>`
    : `<p>An AI model (${esc(companion.model)}) running on this Mac investigates your electricity data with the app’s tested measurements, then every claim is checked against that evidence. Nothing leaves this computer.</p>${has ? `<div class="row2"><button class="btn secondary" data-act="ai-prioritize">What matters most? (seconds)</button><button class="btn primary" data-act="ai-run">Run AI investigation (about a minute)</button></div>` : '<p class="fine">Import your Delmarva file first.</p>'}`;
  else if (LOCAL && companion) head = `<p class="fine">${companion.ollama ? `The model ${esc(companion.model)} isn’t installed. In Terminal run: ollama pull ${esc(companion.model)}` : 'Ollama isn’t running. Open the Ollama app, then reload.'}</p>`;
  else head = '<p class="fine">AI investigations run on your Mac with the Energy companion (it keeps your data on that computer). Bring a finished analysis here with “Import AI analysis”.</p>';
  const hist = list.length > 1 ? disclosure('ai-history', `Previous analyses (${list.length})`, `<ul class="bullets">${list.map((r, i) => `<li><button class="link" data-act="ai-show" data-i="${i}">${esc(fmtNY(Date.parse(r.created)))} · ${r.kind === 'aeo-decision' ? 'priority check' : esc(r.model)}${r.imported ? ' · imported' : ''}</button>${i === idx ? ' (showing)' : ''}</li>`).join('')}</ul>`) : '';
  const io = `<div class="row2">${rp ? '<button class="btn secondary" data-act="ai-export">Save analysis file</button>' : ''}<label class="btn secondary file">Import AI analysis<input type="file" id="ai-file" accept=".json,application/json"></label></div>`;
  return `<h2 class="section-title">AI analysis <span class="kind-chip">AI</span></h2><section class="card ai">${head}${rp ? `<hr>${aiReportHtml(rp)}` : ''}${hist}${io}</section>`;
}
let aiCtl = null;
async function runAI(deep = true) {
  busy = 'ai';
  render();
  try {
    aiCtl = new AbortController();
    const timer = setTimeout(() => aiCtl.abort(), 7 * 60e3); // a little longer than the companion's own deadline
    const r = await fetch('/api/analyze', { signal: aiCtl.signal, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deep, state: { ...S, weatherCache: null }, temps: allTemps(), outlook: recNow().outlook }) });
    clearTimeout(timer);
    const j = await r.json();
    if (!r.ok || !validReport(j)) throw new Error(j.error || 'unexpected response');
    const list = loadAI();
    list.push(j);
    saveAI(list);
    UI.aiShown = undefined;
    toast(j.kind === 'aeo-decision' ? `Top priority: ${j.decision.title}.` : `AI investigation done: ${j.analysis.discoveries.length} discoveries, ${j.analysis.recommendations.length} recommendations.`);
  } catch (e) {
    toast(e.name === 'AbortError' ? 'AI investigation stopped. Nothing was saved; everything else in the app is unaffected.' : `AI investigation didn’t finish: ${e.message} Everything else in the app is unaffected.`, true);
  }
  aiCtl = null;
  busy = '';
  render();
}
if (LOCAL) fetch('/api/companion').then((r) => (r.ok ? r.json() : null)).then((j) => { companion = j; render(); }).catch(() => {});

// ---------- Investigation (runs on this device; answers and actions stay here) ----------

const invNow = () => A.investigation({ state: S, temps: allTemps() });
const STATUS_CLASS = { likely: 'good', fits: 'good', possible: '', open: '', conflict: 'warn', less: 'out', notsup: 'out', unlikely: 'out', out: 'out', outByYou: 'out' };
function questionHtml(inv, q, current = null, label = 'One question that could help') {
  return `<div class="ask"><p class="card-label">${esc(label)}</p><p><b>${esc(q.text)}</b></p><p class="fine">${esc(q.why)}</p>
    <div class="answers">${q.options.map(([v, l]) => `<button class="btn ${current === v ? 'primary' : 'secondary'}" data-act="answer" data-q="${q.id}" data-v="${v}" data-key="${esc(inv.key)}">${esc(l)}</button>`).join('')}</div></div>`;
}
/** Compact card for Today; the full page is #investigate. */
function investigationCard(inv) {
  if (!inv?.hypotheses?.length) return '';
  const rec = inv.recommendation;
  const live = inv.hypotheses.filter((h) => !['out', 'outByYou', 'notsup', 'less'].includes(h.status));
  const gone = inv.hypotheses.filter((h) => ['out', 'outByYou', 'notsup'].includes(h.status));
  const lead = live.find((h) => h.id === rec?.hypothesis) || live[0];
  return `<section class="card investigation"><p class="card-label"><i class="dot"></i>What changed in your electricity use</p><h2>${esc(inv.headline)}</h2>
    <p class="fine">${esc(inv.known[0] || '')}</p>
    <p class="card-label">What we’re investigating</p><ul class="hyps">${live.map((h) => `<li class="${STATUS_CLASS[h.status]}"><span>${esc(h.title)}</span><em>${esc(h.label)}</em></li>`).join('')}</ul>
    ${gone.length ? `<p class="fine">Set aside: ${gone.map((h) => `${esc(h.title.toLowerCase())} (${esc(h.label.toLowerCase())})`).join('; ')}.</p>` : ''}
    <p class="fine">${esc(inv.conclusion)}</p>
    ${rec || lead ? `<div class="next"><p class="card-label">What you can check</p>${rec ? `<b>${esc(rec.title)}</b><p class="fine">${esc(rec.expected)}</p>` : ''}${lead?.verify ? `<p class="fine">${esc(lead.verify)}</p>` : ''}</div>` : ''}
    ${inv.question ? questionHtml(inv, inv.question, null, 'One question') : '<p class="fine">No open questions right now.</p>'}
    <a class="btn plain" href="#investigate">Open the investigation ›</a></section>`;
}
/** After the move-in date: one line per thermostat zone. Before it, nothing (never applied to earlier history). */
function zonesCard() {
  const plans = A.zonePlans(S);
  if (!plans) return '';
  return `<section class="card"><p class="card-label">Your thermostats</p><ul class="bullets">${plans.map(({ zone, rec }) => {
    const c = rec.current[0];
    return `<li><b>${esc(zone.label)}</b>${zone.use ? ` (${esc(zone.use)})` : ''}: ${c ? `${c.temp}° ${c.mode} now, next ${C.fmtMin(c.next.start)} → ${c.next.temp}°` : zone.availability === 'unknown' ? 'set its heating/cooling season in Settings' : 'no heating or cooling right now'}${zone.metered === 'no' ? ' · not on your meter' : ''}</li>`;
  }).join('')}</ul><p class="fine">Recommendations only — the app can’t see or change either thermostat.</p></section>`;
}
const ZHV = [['unknown', 'Not sure'], ['heat_pump', 'Heat pump'], ['electric_resistance', 'Electric resistance'], ['fan_coil', 'Fan coil (building water)'], ['gas_or_boiler', 'Gas furnace / boiler'], ['other', 'Other']];
const ZSEASON = [['unknown', 'Not sure'], ['heat_available', 'Heating'], ['cool_available', 'Cooling'], ['fan_only', 'Fan only']];
const ZMET = [['unknown', 'Not sure'], ['yes', 'Yes'], ['partial', 'Partly (fan only)'], ['no', 'No — building pays']];
const zsel = (z, f, opts) => `<select data-zone="${esc(z.id)}" data-f="${f}">${opts.map(([v, l]) => `<option value="${v}" ${z[f] === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
const znum = (z, f) => `<input type="number" inputmode="numeric" min="40" max="95" data-zone="${esc(z.id)}" data-f="${f}" value="${getPath(z, f)}">`;
function thermostatGroup() {
  const t = S.profile.thermostat;
  return group('Your thermostat, as you set it', 'What you see on the thermostat itself. The app records it and never changes the thermostat; the weekly schedule in the app stays a proposal unless you program it.',
    `<label class="item"><span>Holding at (°F)</span><input type="number" inputmode="numeric" min="50" max="90" id="th-set" value="${t ? t.setpoint : ''}" placeholder="e.g. 74"></label>
    <label class="item"><span>HOLD on</span><input type="checkbox" id="th-hold" ${t?.hold ? 'checked' : ''}></label>
    <label class="item"><span>Time-based programming</span><select id="th-prog"><option value="off" ${t?.programming === 'off' ? 'selected' : ''}>Off</option><option value="on" ${t?.programming === 'on' ? 'selected' : ''}>On</option></select></label>
    <div class="item"><button class="btn secondary" data-act="th-save">Save what the thermostat shows</button>${t ? ` <small>Last confirmed ${esc(shortDate(t.confirmed || todayIso()))}</small>` : ''}</div>`);
}
function zonesGroup() {
  const zs = S.zones || [];
  const ed = (z) => `<div class="zone"><label class="item"><span>Name</span><input data-zone="${esc(z.id)}" data-f="label" value="${esc(z.label)}" maxlength="40"></label>
    <label class="item"><span>Rooms it serves</span><input data-zone="${esc(z.id)}" data-f="use" value="${esc(z.use)}" maxlength="60" placeholder="e.g. bedrooms"></label>
    <label class="item"><span>Equipment</span>${zsel(z, 'hvacType', ZHV)}</label><label class="item"><span>Available now</span>${zsel(z, 'availability', ZSEASON)}</label>
    <label class="item"><span>On your meter?</span>${zsel(z, 'metered', ZMET)}</label>
    <div class="item"><span>Heat: home / away / sleep</span><div class="trio">${znum(z, 'heat.home')}${znum(z, 'heat.away')}${znum(z, 'heat.sleep')}</div></div>
    <div class="item"><span>Cool: home / away / sleep</span><div class="trio">${znum(z, 'cool.home')}${znum(z, 'cool.away')}${znum(z, 'cool.sleep')}</div></div>
    <div class="item"><button class="btn plain" data-act="zone-remove" data-id="${esc(z.id)}">Remove</button></div></div>`;
  return group('Next apartment (two thermostats)', 'Used only from your move-in date and never applied to your current apartment’s history. Two systems don’t necessarily mean twice the energy; the app won’t suggest switching either off without knowing what it serves.',
    `<label class="item"><span>Move-in date</span><input type="date" data-zone="moveIn" value="${esc(S.moveIn || '')}"></label>${zs.map(ed).join('')}${zs.length < 4 ? '<div class="item"><button class="btn secondary" data-act="zone-add">Add a thermostat</button></div>' : ''}`);
}
function viewInvestigate() {
  const inv = invNow();
  const head = `${back('insights', 'Insights')}${pagehead('Investigation', inv?.title ? esc(inv.title) : '')}`;
  if (!inv) return `${head}<section class="card"><p>Import your Delmarva file to start.</p>${importButton()}</section>`;
  if (!inv.hypotheses?.length) return `${head}<section class="card"><h2>${esc(inv.title)}</h2><p>${esc(inv.headline)}</p></section>`;
  const reask = UI.reask && A.QUESTIONS[UI.reask] ? { id: UI.reask, text: A.QUESTIONS[UI.reask].text({ since: inv.since, day: inv.tests?.day, part: inv.tests?.part, bigDay: inv.tests?.biggest_day?.date }), why: A.QUESTIONS[UI.reask].why, options: A.QUESTIONS[UI.reask].options } : null;
  const att = inv.attribution ? `<div class="table-wrap"><table><thead><tr><th>When</th><th class="t">Extra kWh a day</th><th class="t">Share</th></tr></thead><tbody>${inv.attribution.map((a) => `<tr><td>${esc(a.window)}</td><td class="t">${num(a.kwh, 1)}</td><td class="t">${a.share}%</td></tr>`).join('')}</tbody></table></div>` : '';
  const hyps = inv.hypotheses.map((h) => `<li class="${STATUS_CLASS[h.status]}"><b>${esc(h.title)}</b><span class="kind-tag">${esc(h.label)}</span>
    ${h.for.length ? `<span><i>Fits:</i> ${h.for.map(esc).join(' · ')}</span>` : ''}${h.against.length ? `<span><i>Against:</i> ${h.against.map(esc).join(' · ')}</span>` : ''}
    ${h.missing?.length && !['out', 'outByYou'].includes(h.status) ? `<span><i>Still unknown:</i> ${h.missing.map(esc).join(' · ')}</span>` : ''}
    ${!['out', 'outByYou'].includes(h.status) ? `<span><i>How to check:</i> ${esc(h.check)}</span>` : ''}</li>`).join('');
  const answers = inv.answered.length ? `<ul class="bullets">${inv.answered.map((a) => `<li>${esc(a.text)} — <b>${esc(a.label)}</b>${a.source === 'settings' ? ' (from Settings)' : a.at ? ` (${esc(shortDate(a.at))}${a.corrected ? ', corrected' : ''})` : ''} <button class="link" data-act="reask" data-q="${a.q}">Change</button></li>`).join('')}</ul>` : '<p class="fine">No answers yet.</p>';
  const rec = inv.recommendation;
  const tracked = (S.actions || []).find((x) => rec && x.id === `${inv.key}:${rec.hypothesis}`);
  const recHtml = rec ? `<section class="card"><p class="card-label">Recommended</p><h2>${esc(rec.title)}</h2>
    <p><i>The problem:</i> ${esc(rec.problem)}</p><p><i>Why it could help:</i> it addresses the explanation that best fits so far — ${esc(inv.hypotheses.find((h) => h.id === rec.hypothesis)?.title.toLowerCase() || '')}.</p>
    ${rec.detail ? `<p>${esc(rec.detail)}</p>` : ''}<p><i>What to expect:</i> ${esc(rec.expected)}${esc(rec.note || '')}</p><p class="fine"><i>How we’ll know:</i> ${esc(rec.verify)}</p>
    ${tracked ? '<p class="fine">You’re tracking this below.</p>' : `<button class="btn primary" data-act="track" data-id="${esc(`${inv.key}:${rec.hypothesis}`)}" data-key="${esc(inv.key)}" data-title="${esc(rec.title)}" data-hours="${rec.hours ? rec.hours.join('-') : ''}">I’ll try this</button>`}</section>` : '';
  const acts = actsList();
  const sup = inv.supersedes ? `<section class="card"><p class="card-label">Revised conclusion</p><p>${esc(inv.supersedes.text)}</p><p class="fine">${inv.answered.length ? `Your ${inv.answered.length} earlier answer${inv.answered.length === 1 ? '' : 's'} (below) are kept and still count.` : 'Nothing you entered was removed.'}</p></section>` : '';
  return `${head}${sup}
    <section class="card investigation"><h2>${esc(inv.headline)}</h2><p class="card-label">What we know (measured)</p><ul class="bullets">${inv.known.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>${att}</section>
    <h2 class="section-title">What might explain it</h2><section class="card"><ul class="findings explain">${hyps}</ul><p class="fine">${esc(inv.conclusion)} Whole-home readings can rule explanations in or out; they can’t name a specific appliance.</p></section>
    ${reask || inv.question ? `<section class="card">${questionHtml(inv, reask || inv.question, reask ? inv.answered.find((a) => a.q === reask.id)?.value : null)}</section>` : ''}
    ${recHtml}
    <h2 class="section-title">Your answers</h2><section class="card">${answers}</section>
    ${acts ? `<h2 class="section-title">Things you’re trying</h2><section class="card"><ul class="findings actions">${acts}</ul><p class="fine">Results compare the days after you started with the 4 weeks before. “Consistent with an improvement” is not proof — other changes at home also count.</p></section>` : ''}
    ${LOCAL ? '<p class="fine center"><a href="#insights">Ask the AI on this Mac to weigh these explanations ›</a></p>' : ''}`;
}


// ---------- Restore & merge (never silently replaces data) ----------

let pendingRestore = null; // { name, kind, state?, meta?, aiReports?, plan?, update?, choices }
let lastCommit = null;     // { what, verified, at }
const hasSnapshot = () => { try { return !!localStorage.getItem('aeo.snapshot'); } catch { return false; } };
/** Write `next` as one verified transaction (safety copy first), then reload it from storage. */
function commitAndReload(next, reason) {
  A.commitState(localStorage, KEY, next, { reason });
  S = A.migrate(JSON.parse(localStorage.getItem(KEY)));
  lastCommit = { what: reason, verified: true, at: Date.now() };
}
async function openRestoreFile(f) {
  try {
    const parsed = A.parseBackup(await readFile(f));
    pendingRestore = parsed.kind === 'household' ? { name: f.name, kind: 'household', update: parsed.update } : { name: f.name, ...parsed, plan: A.planMerge(S, parsed.state), choices: {} };
    location.hash = 'restore';
    render();
  } catch (err) { toast(`Couldn’t open that file: ${err.message}`, true); }
}
function householdPreviewHtml(update, source) {
  const pv = A.previewHousehold(S, update);
  return `<section class="card household"><p class="card-label"><i class="dot"></i>Confirmed household routine${source ? ` · ${esc(source)}` : ''}</p>
    <h2>${pv.applied ? 'Already applied on this device' : 'Apply your confirmed household routine?'}</h2>
    ${update.note ? `<p>${esc(update.note)}</p>` : ''}
    <div class="table-wrap"><table><thead><tr><th>Day</th><th>Now in the app</th><th>After</th></tr></thead><tbody>${pv.lines.map((l) => `<tr class="${l.changed ? 'changed' : ''}"><td>${esc(l.day)}</td><td>${esc(l.now)}</td><td>${esc(l.next)}</td></tr>`).join('')}</tbody></table></div>
    ${pv.season ? `<p>Building season: ${esc(seasonName(pv.season.now) || pv.season.now)} → <b>${esc(seasonName(pv.season.next) || pv.season.next)}</b></p>` : ''}
    ${pv.answers.length ? `<p class="fine">Also records your answers: ${pv.answers.map(esc).join('; ')}.</p>` : ''}
    <p class="fine">Comfort temperatures stay as they are. This updates the app only — the thermostat on the wall isn’t connected; if the schedule changes, Today shows the steps to program it by hand. A copy of your current data is saved first, and you can undo.</p>
    ${pv.applied ? '' : `<div class="row2"><button class="btn primary" data-act="apply-household">Apply confirmed routine</button><button class="btn secondary" data-act="restore-cancel">Not now</button></div>`}</section>`;
}
function applyHouseholdNow(update) {
  const inv = invNow();
  const next = A.applyHousehold(S, update, { investigationKey: inv?.key || '', today: todayIso() });
  try {
    commitAndReload(next, 'household routine');
    const v = A.verifyHousehold(S, update);
    if (!v.ok) throw new Error(`these didn’t save as intended: ${v.bad.join(', ')}`);
    lastCommit.what = 'household routine';
    if (LOCAL) fetch('/api/household-update/applied', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: update.id, verified: true, days: C.DOW.map((d) => [d, S.profile.routine.days[d]]) }) }).catch(() => {});
    toast(`Saved and verified on this device. The thermostat itself is unchanged${A.holdsSteady(S) ? '.' : ' — see Today for programming steps.'}`);
  } catch (err) { toast(`Not applied: ${err.message} Your data is unchanged.`, true); }
  pendingRestore = null; householdUpdate = null;
  location.hash = 'today';
  render();
}
let householdUpdate = null; // offered by the Mac companion when a confirmed update is waiting
if (LOCAL) fetch('/api/household-update').then((r) => (r.ok ? r.json() : null)).then((j) => { if (j?.kind === 'aeo-household-update') { try { householdUpdate = A.parseBackup(JSON.stringify(j)).update; render(); } catch { /* invalid: ignore */ } } }).catch(() => {});
function viewRestore() {
  const head = `${back('settings', 'Settings')}${pagehead('Restore or merge', pendingRestore ? esc(pendingRestore.name) : '')}`;
  if (!pendingRestore) return `${head}<section class="card"><p>Choose a backup in Settings → Privacy and backup.</p></section>`;
  if (pendingRestore.kind === 'household') return `${head}${householdPreviewHtml(pendingRestore.update, 'from a file')}`;
  const { plan, meta } = pendingRestore;
  const adds = Object.entries(plan.add).map(([k, n]) => `<li>${n} ${esc(k)}</li>`).join('');
  const sames = Object.entries(plan.same).map(([k, n]) => `<li>${n} ${esc(k)} already here</li>`).join('');
  const conf = plan.conflicts.map((c) => {
    const cur = pendingRestore.choices[c.id] || c.default || 'local';
    return `<li><b>${esc(c.label)}</b><span class="fine">${esc(c.detail)}</span><div class="seg" role="group" aria-label="${esc(c.label)}"><button data-act="restore-choice" data-id="${esc(c.id)}" data-v="local" aria-pressed="${cur === 'local'}">${esc(c.local)}</button><button data-act="restore-choice" data-id="${esc(c.id)}" data-v="incoming" aria-pressed="${cur === 'incoming'}">${esc(c.incoming)}</button></div></li>`;
  }).join('');
  return `${head}<section class="card"><p class="fine">Backup${meta?.exportedAt ? ` saved ${esc(fmtNY(Date.parse(meta.exportedAt)))}` : ''}${meta?.device ? ` on device ${esc(meta.device)}` : ''}. Checked and readable.</p>
    ${plan.empty ? '<h2>Nothing new — everything in this backup is already here.</h2>' : `<p class="card-label">Will be added</p><ul class="bullets">${adds || '<li>Nothing new</li>'}</ul>`}
    ${sames ? `<p class="card-label">Already on this device (kept once)</p><ul class="bullets">${sames}</ul>` : ''}</section>
    ${conf ? `<h2 class="section-title">Needs your choice</h2><section class="card"><ul class="findings conflicts">${conf}</ul><p class="fine">Nothing is decided for you: unless you pick otherwise, this device’s value is kept.</p></section>` : ''}
    <section class="card"><div class="row2"><button class="btn primary" data-act="restore-merge">${plan.empty ? 'Done' : 'Merge — keep everything'}</button><button class="btn secondary" data-act="restore-cancel">Cancel</button></div>
    <p class="fine">A copy of this device’s data is saved first; you can undo from Settings. <button class="link" data-act="restore-replace">Replace everything with this backup instead…</button></p></section>`;
}


// ---------- Is this normal for you? · empty-apartment hours · bills ----------

const BL_CLASS = { typical: 'good', return_to_typical: 'good', unusually_low: '', unusually_high: 'warn', insufficient: '' };
const SURE = { high: 'High', medium: 'Moderate', low: 'Low' };
/** The one message to understand first: is the latest use typical, unusually high or low, for THIS household. */
function normalityCard(full = false) {
  if (!usageDays().length) return '';
  const r0 = report(), b = r0.baseline;
  if (!b || (b.status === 'insufficient' && r0.n < 14)) return '';
  const bv = A.billView({ state: S });
  const t = bv.thirty;
  const billLine = t ? `Latest 30 days: ${num(t.latest.kwh)} kWh (any 30 days in your data: ${num(t.low_kwh)}–${num(t.high_kwh)}). ${bv.statements.length ? 'Statements you entered are on the bill page.' : 'About ' + money(t.latest.cost) + ' by the file’s per-hour costs — an estimate, not a bill.'}` : '';
  const lines = full ? b.lines : b.lines.slice(0, 1);
  const wins = full && b.windows?.length ? `<div class="table-wrap"><table><thead><tr><th>Part of the day</th><th class="t">Now</th><th class="t">Usual</th><th></th></tr></thead><tbody>${b.windows.map((w) => `<tr><td>${esc(w.name.replace(/ \(.*/, ''))}</td><td class="t">${num(w.recent_w)} W</td><td class="t">${num(w.low_w)}–${num(w.high_w)} W</td><td>${w.flag === 'high' ? 'Highest yet' : w.flag === 'low' ? 'Lower' : 'Usual'}</td></tr>`).join('')}</tbody></table></div>` : '';
  return `<section class="card normality ${BL_CLASS[b.status]}"><p class="card-label"><i class="dot"></i>Is your electricity use normal?</p>
    <h2>${esc(b.headline)} <span class="kind-chip">${esc(b.label)}</span></h2>${lines.map((l) => `<p class="fine">${esc(l)}</p>`).join('')}${wins}
    ${b.status === 'insufficient' ? '' : `<p class="fine"><b>How sure:</b> ${SURE[b.confidence]}. ${esc((b.caveats[0] || 'Based on this device’s readings only.'))}</p>`}
    ${full ? b.caveats.slice(1).map((c) => `<p class="fine">${esc(c)}</p>`).join('') : ''}
    ${billLine ? `<p class="fine">${esc(billLine)}</p>` : ''}
    <a class="btn plain" href="#bills">Why is my bill what it is? ›</a></section>`;
}
/** Hours the routine says nobody is home but the meter shows heavy use. Never assumes what ran. */
function awayCards(all = false) {
  return A.unoccupiedUse({ state: S }).filter((a) => all || !a.explained).map((a) => `<section class="card ${a.explained ? '' : 'warn'}"><p class="card-label"><i class="dot"></i>Worth a look · hours nobody’s home</p>
    <h2>${esc(a.headline)}</h2><p>${esc(a.detail)}</p><p class="fine">${esc(a.uncertainty)}</p>
    ${a.answer === 'home' || a.answer === 'timer' ? `<p class="fine"><b>You said:</b> ${esc(A.QUESTIONS.away_home.options.find(([k]) => k === a.answer)[1])}. That explains it, so it isn’t treated as a problem.</p>`
      : `<p class="fine"><b>What you can check:</b> ${esc(a.check)}</p>${a.answer === 'no' ? '<p class="fine">You said nobody was home and nothing runs then, so this is still unexplained.</p>' : ''}`}
    ${a.question ? questionHtml({ key: a.question.key }, a.question, null, 'One question') : ''}</section>`).join('');
}

const KIND_TAG = { measured: 'Measured', estimate: 'Estimate', statement: 'Statement', reconciled: 'Matched to readings', projection: 'Utility projection' };

// ---------- v20: this billing period — Delmarva's projection and our own forecast, kept apart ----------
const fresh = (fc) => (fc.readingsAgeDays <= 0 ? 'today' : `${fc.readingsAgeDays} day${fc.readingsAgeDays === 1 ? '' : 's'} before today`);
function periodCard(bv) {
  const proj = bv.projection, fc = bv.forecast, gap = bv.gap;
  if (!proj && !(fc?.available)) return `<section class="card"><p class="card-label">This billing period</p><p>No projection or forecast yet. Enter what your Delmarva account shows below${bv.statements.length ? '' : ', or add a statement'}; the app never presents its own estimate as Delmarva’s.</p>${bv.usual ? `<p class="fine">You told us your bill is usually ${money(bv.usual.low)}–${money(bv.usual.high)}.</p>` : ''}</section>`;
  const period = proj ? `${esc(shortDate(proj.periodStart || fc?.period?.start || ''))}${proj.periodStart || fc?.period ? '–' : 'ending '}${esc(shortDate(proj.periodEnd))}` : fc ? `${esc(shortDate(fc.period.start))}–${esc(shortDate(fc.period.end))}${fc.periodAssumed ? ' (assumed from your usual bill length)' : ''}` : '';
  const left = proj && proj.soFar != null ? proj.amount - proj.soFar : null;
  const projHtml = proj ? `<div class="q"><p class="card-label">Delmarva’s projection <span class="kind-chip">Projected · not a final bill</span></p>
      <h2>${money(proj.amount)}</h2><p class="fine">For ${period}${fc?.available ? ` (${fc.days} days)` : ''}. Entered by you from your Delmarva account${proj.shownOn ? `, as seen ${esc(shortDate(proj.shownOn))}` : proj.enteredAt ? ` on ${esc(shortDate(proj.enteredAt))}` : ''}. Delmarva’s own update time isn’t known, and nothing syncs automatically.</p>
      ${proj.soFar != null ? `<p><b>${money(proj.soFar)}</b> estimated charges so far <small>(Delmarva’s estimate of what has built up — not a posted charge or a payment)</small></p><p class="fine">Projected remaining: about ${money(left)} (${money(proj.amount)} − ${money(proj.soFar)}). That is part of this projection, not a separate bill and not money owed now.</p>` : ''}
      ${bv.normal?.known ? `<p>${bv.normal.within ? `<b>Normal for you:</b> within the ${money(bv.normal.range[0])}–${money(bv.normal.range[1])} range of ${bv.normal.n} of your ${bv.normal.of} bills.` : `<b>Outside your usual range</b> of ${money(bv.normal.range[0])}–${money(bv.normal.range[1])}.`}${bv.normal.exceptions.length ? ` The exception${bv.normal.exceptions.length > 1 ? 's' : ''}: ${bv.normal.exceptions.map((e) => `${money(e.amount)} (bill ending ${esc(shortDate(e.end))})`).join(', ')}.` : ''}</p>` : ''}</div>` : '';
  const fcHtml = fc?.available ? `<div class="q"><p class="card-label">Our independent estimate <span class="kind-chip">Estimate · ${esc(fc.methodName)}</span></p>
      <h2>${fc.pointOk ? `about ${money(fc.mid)}` : `${money(fc.low)}–${money(fc.high)}`}</h2>
      <p class="fine">${fc.pointOk ? `Range ${money(fc.low)}–${money(fc.high)}. ` : 'Too uncertain for a single number. '}Readings run to ${esc(shortDate(fc.readingsEnd))} (${fresh(fc)}): ${fc.measured} of ${fc.days} days are measured, the other ${fc.remaining} are forecast — not observed.</p>
      <details class="inline"><summary>How this was worked out</summary><p class="fine">${esc(fc.method_text)} Uncertainty: ${esc(fc.uncertainty)}. Other methods: ${Object.entries(fc.otherMethods).map(([m, v]) => `${esc(A.FORECAST_METHODS[m])} ${money(v)}`).join(', ')}.</p></details></div>` : '';
  const gapHtml = gap ? `<div class="q"><p class="card-label">Difference: ${money(Math.abs(gap.diff))} ${gap.diff >= 0 ? 'above' : 'below'} Delmarva</p><ul class="bullets">${gap.lines.map((l) => `<li>${esc(l.text)} ${l.kind === 'possible' ? '<small>(possibility)</small>' : l.kind === 'unknown' ? '<small>(unknown)</small>' : ''}</li>`).join('')}</ul><p class="fine">The two are kept separate on purpose; the app doesn’t adjust its estimate to match Delmarva.</p></div>` : '';
  return `<section class="card"><p class="card-label">This billing period</p>${projHtml}${fcHtml}${gapHtml}</section>`;
}
function accuracyCard(bv) {
  const bt = bv.forecast?.backtest, acc = bv.accuracy;
  if (!bt && !acc.rows.length) return '';
  const names = A.FORECAST_METHODS;
  const rows = bt ? Object.entries(bt.summary).map(([m, v]) => `<tr><td>${esc(names[m])}${bt.selected === m ? ' ✓' : ''}</td><td class="t">$${num(v.mae, 2)}</td><td class="t">${v.bias >= 0 ? '+' : '−'}$${num(Math.abs(v.bias), 2)}</td><td class="t">$${num(v.worst, 2)}</td></tr>`).join('') : '';
  return `<h2 class="section-title">How accurate are the forecasts?</h2><section class="card">
    ${acc.rows.length ? `<div class="table-wrap"><table><thead><tr><th>Bill ending</th><th class="t">Final</th><th class="t">Delmarva</th><th class="t">App</th></tr></thead><tbody>${acc.rows.map((r) => `<tr><td>${esc(shortDate(r.end))}</td><td class="t">${money(r.bill)}</td><td class="t">${money(r.utility)} (${r.utilityErr >= 0 ? '+' : '−'}${money(Math.abs(r.utilityErr))})</td><td class="t">${r.app != null ? `${money(r.app)} (${r.appErr >= 0 ? '+' : '−'}${money(Math.abs(r.appErr))})` : '—'}</td></tr>`).join('')}</tbody></table></div>` : `<p>${esc(acc.text)}</p>`}
    ${bt ? `<p class="card-label">Practice runs on your ${bt.n} earlier bills (${bt.k} days of readings each, nothing from later)</p><div class="table-wrap"><table><thead><tr><th>Method</th><th class="t">Typical error</th><th class="t">Bias</th><th class="t">Worst</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="fine">✓ = the method the app uses now: lowest typical error at this stage, preferring the simpler method when within $1.50. A weather-adjusted method needs a clear weather effect in your use; yours is too weak, so it isn’t used. ${esc(bt.caution)} The worst misses were on the longest bill (34 days) — period length matters.</p>` : ''}</section>`;
}

let stmtDraft = null; // { fields, found, notFound, name, editingId? } from a PDF or an existing statement, shown for review before saving
const STMT_FIELDS = [['supply', 'Supply charges ($)'], ['delivery', 'Delivery charges ($)'], ['fixed', 'Customer / fixed charge ($)'], ['taxes', 'Taxes and fees ($)'], ['credits', 'Credits ($, as a positive number)'], ['adjustments', 'Adjustments ($, minus for a reduction)'], ['priorBalance', 'Previous balance ($)'], ['payments', 'Payments ($)'], ['totalDue', 'Total amount due ($)']];
function viewBills() {
  const head = pagehead('Bills', 'Statements, projections and estimates — kept apart');
  if (!usageDays().length) return `${head}<section class="card"><p>Import your Delmarva file to see your electricity month by month.</p>${importButton()}</section>`;
  const bv = A.billView({ state: S, temps: allTemps() });
  const d = stmtDraft?.fields || {}, v = (k) => (d[k] == null || d[k] === '' ? '' : esc(String(d[k]))), flag = (k) => (stmtDraft && !stmtDraft.editingId ? (stmtDraft.found.includes(k) ? ' <small class="found">read from the PDF — check it</small>' : ' <small>not found in the PDF</small>') : '');
  const monthRows = bv.months.map((m) => `<tr><td>${esc(new Date(`${m.month}-15T12:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }))}${m.partial ? ` <small>(${m.days} of ${m.daysInMonth} days)</small>` : ''}</td><td class="t">${num(m.kwh)}</td><td class="t">${num(m.kwh_per_day, 1)}</td><td class="t">${m.interval_cost != null ? money(m.interval_cost) : '—'}</td></tr>`).join('');
  const st = bv.statements.slice().reverse().map((x) => `<tr><td>${x.start ? esc(shortDate(x.start)) : '?'}–${esc(shortDate(x.end))}${x.source === 'pdf' ? ' <small>(statement PDF)</small>' : x.source === 'greenbutton' ? ' <small>(Delmarva billing data)</small>' : ' <small>(entered)</small>'}${x.statementDate ? ` <small>billed ${esc(shortDate(x.statementDate))}</small>` : ''}</td><td class="t">${money(x.amount)}</td><td class="t">${x.billed_days ?? '—'}</td><td class="t">${x.kwh ? num(x.kwh) : '—'}</td><td class="t">${x.kwh_per_day != null ? num(x.kwh_per_day, 1) : '—'}</td></tr>
    <tr class="sub"><td colspan="5">${x.cost_per_day != null ? `<small>${money(x.cost_per_day)} a day${x.cents_per_kwh != null ? ` · ${num(x.cents_per_kwh, 1)}¢ per kWh on average` : ''}.</small> ` : ''}${x.readings_kwh != null ? `<small>Your readings for the same days: ${num(x.readings_kwh, 2)} kWh${x.kwh_within_rounding ? ' — matches (billed kWh are whole numbers)' : x.kwh_matches === false ? ' — more than rounding apart' : x.kwh_matches ? ' — matches' : ''}; the file’s hourly costs ${money(x.interval_cost)}, ${money(Math.abs(x.beyond_readings))} ${x.beyond_readings >= 0 ? 'less' : 'more'} than the billed amount — not itemised, so not explained.</small> ` : ''}${x.fixed != null ? `<small>Fixed ${money(x.fixed)}.</small> ` : ''}${x.credits ? `<small>Credits ${money(x.credits)}.</small> ` : ''}${x.priorBalance != null || x.payments != null ? `<small>Previous balance/payments are kept out of comparisons.</small> ` : ''}${x.notes.map((n) => `<small>${esc(n)}</small>`).join(' ')} <button class="link" data-act="bill-edit" data-id="${esc(x.id)}">Correct</button> · <button class="link" data-act="bill-remove" data-id="${esc(x.id)}">Remove</button></td></tr>`).join('');
  const drivers = bv.compare ? `<section class="card"><p class="card-label">Why the last bill changed</p><p>${money(bv.compare.prev.amount)} → ${money(bv.compare.cur.amount)} (${bv.compare.total >= 0 ? '+' : '−'}${money(Math.abs(bv.compare.total))})</p><ul class="bullets">${bv.compare.drivers.map((x) => `<li>${esc(x.label)}${x.amount != null ? `: ${x.amount >= 0 ? '+' : '−'}${money(Math.abs(x.amount))}` : ''} <small>(${x.status === 'confirmed' ? 'from your statements' : x.status === 'possible' ? 'possible, not measured' : x.status === 'unknown' ? 'can’t compare' : 'not explained by the figures entered'})</small></li>`).join('')}</ul>${bv.compare.typical_cost_per_day != null ? `<p class="fine">Your earlier statements cost about ${money(bv.compare.typical_cost_per_day)} a day (median).</p>` : ''}</section>` : '';
  const proj = bv.projection;
  const review = pendingBilling.length ? `<section class="card warn"><p class="card-label"><i class="dot"></i>Needs your review</p>${pendingBilling.map((r, i) => `<p><b>${esc(shortDate(r.incoming.start))}–${esc(shortDate(r.incoming.end))}</b>: the new export says ${money(r.incoming.amount)}, ${num(r.incoming.kwh)} kWh; saved: ${esc(shortDate(r.existing.start || r.existing.end))}–${esc(shortDate(r.existing.end))} ${money(r.existing.amount)}${r.existing.kwh ? `, ${num(r.existing.kwh)} kWh` : ''} (${r.existing.source === 'greenbutton' ? 'earlier billing export' : r.existing.source === 'pdf' ? 'statement PDF' : 'entered by you'}). ${r.kind === 'changed' ? 'Possibly a corrected bill.' : 'The dates overlap.'}</p><div class="row2"><button class="btn primary" data-act="billing-take" data-i="${i}">Use the new figures</button><button class="btn secondary" data-act="billing-keep" data-i="${i}">Keep the saved one</button></div>`).join('')}</section>` : '';
  return `${head}${review}
    ${periodCard(bv)}
    ${drivers}
    <h2 class="section-title">Your statements</h2><section class="card">
      ${bv.statements.length ? `<div class="table-wrap"><table><thead><tr><th>Service period</th><th class="t">Charges</th><th class="t">Days</th><th class="t">kWh</th><th class="t">kWh/day</th></tr></thead><tbody>${st}</tbody></table></div>` : '<p>No statements yet. Add one below — from the PDF on your Mac, or by typing a few numbers.</p>'}
      ${LOCAL ? `<label class="btn secondary file">Read a statement PDF<input type="file" id="statement-pdf" accept="application/pdf"></label><p class="fine">Read on this Mac only (macOS PDFKit); nothing is uploaded. Scanned PDFs have no text to read — type those figures in.</p>` : '<p class="fine">PDF reading works in the Mac companion; on the phone, type the figures.</p>'}
      ${stmtDraft?.editingId ? `<p class="fine"><b>Correcting the statement ending ${esc(shortDate(stmtDraft.fields.end))}.</b> Saving replaces it; you can undo from Settings.</p>` : stmtDraft ? `<p class="fine"><b>From ${esc(stmtDraft.name)}:</b> found ${stmtDraft.found.length} item${stmtDraft.found.length === 1 ? '' : 's'}. Check every field against the statement before saving.</p>` : ''}
      <div class="bill-form"><label class="item"><span>Service start date${flag('start')}</span><input type="date" id="bill-start" value="${v('start')}"></label><label class="item"><span>Service end date${flag('end')}</span><input type="date" id="bill-end" value="${v('end')}"></label>
      <label class="item"><span>Current charges ($)${flag('amount')}<br><small>This period only — not the amount due</small></span><input type="number" inputmode="decimal" id="bill-amount" min="0" step="0.01" value="${v('amount')}"></label>
      <label class="item"><span>Billed kWh${flag('kwh')}</span><input type="number" inputmode="decimal" id="bill-kwh" min="0" value="${v('kwh')}"></label>
      <label class="item"><span>Statement date <small>(optional)</small>${flag('statementDate')}</span><input type="date" id="bill-statementDate" value="${v('statementDate')}"></label>
      <label class="item"><span>Billed days <small>(optional)</small>${flag('days')}</span><input type="number" inputmode="numeric" id="bill-days" min="1" max="99" value="${v('days')}"></label>
      <details ${stmtDraft ? 'open' : ''}><summary>More from the statement (optional)</summary>${STMT_FIELDS.map(([k, l]) => `<label class="item"><span>${l}${flag(k)}</span><input type="number" inputmode="decimal" step="0.01" id="bill-${k}" value="${v(k)}"></label>`).join('')}
        <label class="item"><span>Estimated meter reading${flag('estimatedRead')}</span><input type="checkbox" id="bill-estimated" ${d.estimatedRead ? 'checked' : ''}></label></details>
      <div class="row2"><button class="btn primary" data-act="bill-add">Save statement</button>${stmtDraft ? '<button class="btn secondary" data-act="bill-draft-clear">Discard</button>' : ''}</div></div>
      <p class="fine">Stored on this device only, included in your backups. Previous balance and payments are kept separate from this period’s charges.</p></section>
    ${accuracyCard(bv)}
    <h2 class="section-title">Delmarva projection and your usual bill</h2><section class="card">
      <p class="fine">Type what your Delmarva account shows. Each entry is kept as a snapshot, so projections can be compared with the final bill later. Nothing here is a statement.</p>
      <div class="bill-form"><label class="item"><span>Projected total ($)</span><input type="number" inputmode="decimal" id="proj-amount" min="0" step="0.01"></label><label class="item"><span>Estimated charges so far ($) <small>(optional)</small></span><input type="number" inputmode="decimal" id="proj-sofar" min="0" step="0.01"></label>
      <label class="item"><span>Period starts</span><input type="date" id="proj-start"></label><label class="item"><span>Period ends</span><input type="date" id="proj-end"></label><label class="item"><span>Date you saw it <small>(optional)</small></span><input type="date" id="proj-asof"></label><button class="btn secondary" data-act="proj-save">Save projection</button></div>
      ${bv.projections.length ? `<p class="card-label">Saved projections</p><ul class="bullets">${bv.projections.slice().reverse().map((p) => `<li>${money(p.amount)} for ${esc(shortDate(p.periodStart || p.periodEnd))}–${esc(shortDate(p.periodEnd))}${p.soFar != null ? `, ${money(p.soFar)} so far` : ''} <small>(${p.shownOn ? `seen ${esc(shortDate(p.shownOn))}` : `entered ${esc(shortDate(p.enteredAt))}`}${A.finalBillFor(p, bv.statements) ? ' — final bill is in' : ''})</small> <button class="link" data-act="proj-remove" data-id="${esc(p.id)}">Remove</button></li>`).join('')}</ul>` : ''}
      <div class="bill-form"><label class="item"><span>Usual bill, low ($)</span><input type="number" inputmode="decimal" id="usual-low" value="${bv.usual ? bv.usual.low : ''}"></label><label class="item"><span>Usual bill, high ($)</span><input type="number" inputmode="decimal" id="usual-high" value="${bv.usual ? bv.usual.high : ''}"></label><button class="btn secondary" data-act="usual-save">Save</button></div></section>
    ${bv.lines.length ? `<h2 class="section-title">What the numbers say</h2><section class="card"><ul class="findings">${bv.lines.map((l) => `<li><span class="kind-tag">${esc(KIND_TAG[l.kind])}</span> ${esc(l.text)}</li>`).join('')}</ul></section>` : ''}
    <h2 class="section-title">Month by month (calendar months)</h2><section class="card"><div class="table-wrap"><table><thead><tr><th>Month</th><th class="t">kWh</th><th class="t">Per day</th><th class="t">File’s per-hour costs</th></tr></thead><tbody>${monthRows}</tbody></table></div>
      <p class="fine">Only months with readings are listed; days without readings are left out, not counted as zero. Calendar months aren’t billing periods, and the per-hour costs are not a bill.</p></section>
    <h2 class="section-title">What’s missing</h2><section class="card"><ul class="bullets">${bv.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></section>`;
}


function actsList() {
  return (S.actions || []).slice().reverse().map((a) => {
    const ev = A.evaluateAction({ state: S, temps: allTemps(), action: a });
    return `<li><b>${esc(a.title)}</b><div class="row2"><select data-action-status="${esc(a.id)}">${Object.entries(A.ACTION_STATUS).map(([k, l]) => `<option value="${k}" ${a.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select><label class="field">Started on<input type="date" data-action-start="${esc(a.id)}" value="${esc(a.start)}"></label></div>
      <span class="fine">${esc(ev.label)}${ev.diff != null ? ` (${ev.diff < 0 ? '' : '+'}${num(ev.diff, 1)} kWh a day ± ${num(ev.unc, 1)}; ${esc(ev.method)})` : ''}</span></li>`;
  }).join('');
}

// ---------- Today: the bill first ----------
const planNow = () => A.savingsPlan({ state: S, temps: allTemps() });
const usd = (x) => (x == null ? '—' : money(x));
const range$ = (d) => (d ? (Math.abs(d[0] - d[1]) < 0.5 ? usd(d[1]) : `${usd(d[0])}–${usd(d[1])}`) : '');
function savingLine(o) {
  const sv = o.savings;
  if (sv.dollars) return `${range$(sv.dollars)} a ${sv.per === 'summer month' ? 'summer month' : 'month'} · ${sv.label.toLowerCase()}`;
  return `Can’t be estimated yet${sv.upTo != null ? ` (measured ceiling: ${usd(sv.upTo)} a month, if all of it were avoidable)` : ''}`;
}
const EFFORT = { none: 'No effort', low: 'Low effort', medium: 'Some effort', high: 'High effort' }, COMFORT = { none: 'No comfort change', slight: 'Slightly warmer/cooler', noticeable: 'Noticeable comfort change' };
/** How much am I using · what will the bill be · why higher or lower · what could I save. Every number says where it comes from. */
function billFirstCard() {
  const r = report(), b = r.baseline, bv = A.billView({ state: S, temps: allTemps() }), sp = planNow();
  const last = usageDays().at(-1)?.date;
  const q = (title, body) => `<div class="q"><p class="card-label">${title}</p>${body}</div>`;
  const use = b && b.status !== 'insufficient'
    ? `<h2>${num(b.recent.kwh, 1)} kWh a day <span class="kind-chip">${esc(b.label)}</span></h2><p class="fine">Last 14 days to ${esc(shortDate(last))}. Your usual: ${num(b.range.low, 1)}–${num(b.range.high, 1)} kWh a day.${bv.thirty ? ` Latest 30 days: ${num(bv.thirty.latest.kwh)} kWh.` : ''} Measured.</p>`
    : `<h2>${num(r.perDay, 1)} kWh a day</h2><p class="fine">${r.n} day${r.n === 1 ? '' : 's'} of readings — about 10 weeks are needed to know what’s normal for you.</p>`;
  const lines = [];
  const fc = bv.forecast, proj = bv.projection, last1 = bv.statements[bv.statements.length - 1];
  if (proj) {
    lines.push(`<h2>${usd(proj.amount)} <span class="kind-chip">Delmarva projection</span></h2><p class="fine">For ${esc(shortDate(proj.periodStart || fc?.period?.start || proj.periodEnd))}–${esc(shortDate(proj.periodEnd))}. Projected, not final; entered by you from your Delmarva account${proj.shownOn ? ` (seen ${esc(shortDate(proj.shownOn))})` : ''}.${proj.soFar != null ? ` Estimated charges so far: ${usd(proj.soFar)}.` : ''}</p>`);
    if (fc?.available) lines.push(`<p>Our own estimate: <b>${fc.pointOk ? `about ${usd(fc.mid)}` : `${usd(fc.low)}–${usd(fc.high)}`}</b> <span class="kind-chip">Estimate</span> <small>${fc.measured} of ${fc.days} days measured, to ${esc(shortDate(fc.readingsEnd))}; ${usd(Math.abs(bv.gap?.diff ?? fc.mid - proj.amount))} ${fc.mid >= proj.amount ? 'above' : 'below'} Delmarva — ${bv.gap && Math.abs(bv.gap.diff) <= (fc.backtest.summary[fc.method]?.mae ?? 0) ? 'within our usual error' : 'see Bills'}.</small></p>`);
    if (bv.normal?.known) lines.push(`<p><b>${bv.normal.within ? 'Normal for you.' : 'Outside your usual range.'}</b> ${bv.normal.within ? `Within ${usd(bv.normal.range[0])}–${usd(bv.normal.range[1])}, where ${bv.normal.n} of your ${bv.normal.of} bills fell.` : ''}${bv.normal.exceptions.length ? ` Only ${bv.normal.exceptions.map((e) => `the ${usd(e.amount)} bill ending ${esc(shortDate(e.end))}`).join(' and ')} ${bv.normal.exceptions.length > 1 ? 'were' : 'was'} unusual.` : ''}</p>`);
    if (fc?.available && last1?.kwh_per_day != null && fc.measured >= 3) {
      const measKd = fc.measuredKwh / fc.measured, du = (measKd / last1.kwh_per_day - 1) * 100, dd = proj.amount - last1.amount;
      lines.push(`<p class="fine"><b>Use:</b> ${num(measKd, 1)} kWh a day so far this period vs ${num(last1.kwh_per_day, 1)} in the last bill (${du >= 0 ? '+' : '−'}${num(Math.abs(du))}%, measured).<br><b>Dollars:</b> ${usd(proj.amount)} projected vs ${usd(last1.amount)} billed (${dd >= 0 ? '+' : '−'}${usd(Math.abs(dd))}, ${dd >= 0 ? '+' : '−'}${num(Math.abs(dd / last1.amount) * 100)}%). Billed days: ${fc.days} vs ${last1.billed_days ?? '?'}.</p>`);
    }
  } else {
  if (bv.projection) lines.push(`<p><b>${usd(bv.projection.amount)}</b> <span class="kind-chip">Delmarva projection · entered by you</span></p>`);
  if (bv.estimate) lines.push(`<p><b>${usd(bv.estimate.low)}–${usd(bv.estimate.high)}</b> <span class="kind-chip">App estimate</span></p><p class="fine">${esc(bv.estimate.method)}</p>`);
  if (!bv.projection && !bv.estimate) lines.push(`<p>${bv.usual ? `You told us it’s usually <b>${usd(bv.usual.low)}–${usd(bv.usual.high)}</b>. ` : ''}The app can’t estimate this bill yet: it needs one Delmarva statement (dates, kWh and charges).</p>${bv.thirty?.latest.cost != null ? `<p class="fine">The file’s per-hour costs for the latest 30 days add up to ${usd(bv.thirty.latest.cost)} — not a bill: no fixed charges, taxes or credits.</p>` : ''}`);
  }
  let why;
  if (bv.compare) {
    const conf = bv.compare.drivers.filter((x) => x.status === 'confirmed' && x.amount != null).sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount)).slice(0, 2);
    const poss = bv.compare.drivers.filter((x) => x.status === 'possible');
    why = `<p>Last statement ${bv.compare.total >= 0 ? 'up' : 'down'} ${usd(Math.abs(bv.compare.total))} from the one before.</p><ul class="bullets">${conf.map((x) => `<li>${esc(x.label)}: ${x.amount >= 0 ? '+' : '−'}${usd(Math.abs(x.amount))} <small>(from your statements)</small></li>`).join('')}${poss.map((x) => `<li>${esc(x.label)} <small>(possible, not measured)</small></li>`).join('')}</ul>`;
  } else if (b?.status === 'return_to_typical' && b.low_stretch) {
    why = `<p>Your use dipped to ${num(b.low_stretch.kwh, 1)} kWh a day from ${esc(shortDate(b.low_stretch.from))} to ${esc(shortDate(b.low_stretch.to))}, then came back to normal. A bill covering mostly that stretch would be lower and the next one back to usual — <i>likely, but unconfirmed</i> until you add statements with their dates.</p><p class="fine">Your price per kWh in the file was flat (same every hour), so this isn’t a rate effect.</p>`;
  } else why = `<p>${b && b.status !== 'insufficient' ? esc(b.headline) : 'More readings and a statement are needed to explain bill changes.'}</p>`;
  const top = sp.items.slice(0, 2);
  const save = top.length ? `${sp.normal ? '<p class="fine">Your use is normal for your home — normal isn’t the same as efficient.</p>' : ''}<ul class="opps">${top.slice(0, 1).map((o) => `<li><b>${esc(o.action)}</b><small>${esc(savingLine(o))} · ${esc(EFFORT[o.effort])}${o.experiment ? ' · can be tested' : ''}</small></li>`).join('')}</ul><a class="btn plain" href="#savings">Test a change ›</a>`
    : `<p>No change is clearly worth it from your readings right now.</p><a class="btn plain" href="#savings">What was considered ›</a>`;
  const running = (S.experiments || []).filter((e) => !e.end);
  const th = S.profile.thermostat, sp0 = sp.items.find((o) => o.id === 'setpoint');
  const thermoLine = th ? q('Thermostat', `<p><b>Actual: ${th.setpoint}°F HOLD, programming ${th.programming === 'off' ? 'OFF' : 'ON'}</b> <small>(confirmed by you)</small></p>${sp0 && !running.some((e) => /°F instead of/.test(e.title)) ? `<p class="fine">Optional test: try ${th.setpoint + 1}°F for two warm weeks — only if you want to; the app won’t change it. <a href="#savings">Details</a></p>` : ''}`) : '';
  const testing = running.length ? q('Your test', running.map((e) => { const r = expEval(e); return `<p><b>${esc(e.title)}</b> — ${esc(r.label)}. <small>${esc(r.detail || '')}</small></p>`; }).join('') + '<a class="btn plain" href="#savings">See the test ›</a>') : '';
  const hasProj = !!bv.projection;
  return `<section class="card billfirst">${hasProj ? `${q('What’s my projected bill?', lines.join(''))}<a class="btn plain" href="#bills">Bills, estimate and how accurate it is ›</a>${q('How much am I using?', use)}` : `${q('How much are you using?', use)}${q('What will the bill be?', lines.join(''))}<a class="btn plain" href="#bills">Bills and statements ›</a>`}
    ${q(hasProj ? 'Why was the last bill cheaper?' : 'Why higher or lower?', why)}${q(hasProj ? 'What could I do next?' : 'What could you save?', save)}${testing}${thermoLine}</section>`;
}

// ---------- Savings tab ----------
let expDraft = null; // prefilled "try a change" form
const HOURS = Array.from({ length: 25 }, (_, h) => [h, h === 24 ? 'midnight' : C.fmtMin(h * 60)]);
const DAYS = [['', 'Every day'], ...C.DOW.map((d, i) => [String(i), `${C.DAY_NAME[d]}s only`])];
const CONTROL = { yes: 'Yes — you control it', partly: 'Partly', unknown: 'Unknown until you find what it is', no: 'No' };
const expEval = (e) => A.evaluateExperiment({ state: S, temps: allTemps(), exp: e });
function expCard(e) {
  const r = expEval(e), running = !e.end;
  const money2 = r.monthly?.dollars ? ` ≈ ${money(r.monthly.dollars[0])}–${money(r.monthly.dollars[1])} a month` : '';
  return `<li><b>${esc(e.title)}</b> <span class="kind-chip">${running ? 'Running' : 'Ended'} · ${esc(r.label)}</span>
    <small>${esc(r.window ? `${r.window}${e.days ? `, ${C.DAY_NAME[C.DOW[e.days[0]]]}s` : ''}` : '')} · started ${esc(shortDate(e.start))}${e.end ? `, ended ${esc(shortDate(e.end))}` : ''}</small>
    <p>${esc(r.detail || '')}</p>
    ${r.monthly ? `<p class="fine">If it continues: ${num(r.monthly.kwh[0], 1)}–${num(r.monthly.kwh[1], 1)} kWh a month${money2}. ${esc(r.monthly.method)}</p>` : ''}
    ${r.engineering ? `<p class="fine">Engineering estimate: ${num(r.engineering.kwh_month, 1)} kWh a month${r.engineering.dollars != null ? ` ≈ ${money(r.engineering.dollars)}` : ''}. ${esc(r.engineering.method)}</p>` : ''}
    ${r.method ? `<p class="fine">How it was compared: ${esc(r.method)}.${(r.caveats || []).map((c) => ` ${esc(c)}`).join('')}</p>` : ''}
    <div class="row2">${running ? `<button class="btn secondary" data-act="exp-end" data-id="${esc(e.id)}">End the test</button><label class="item"><span>Mark an unusual day (away, guests)</span><input type="date" data-exp-exclude="${esc(e.id)}"></label>`
      : e.decision ? `<p class="fine">You decided to ${e.decision === 'keep' ? 'keep this change' : 'go back'}. <button class="link" data-act="exp-decide" data-id="${esc(e.id)}" data-v="">Change</button></p>`
        : `<button class="btn primary" data-act="exp-decide" data-id="${esc(e.id)}" data-v="keep">Keep the change</button><button class="btn secondary" data-act="exp-decide" data-id="${esc(e.id)}" data-v="revert">Go back</button>`}</div></li>`;
}
function expForm() {
  const d = expDraft || {};
  const sel = (id, opts, cur) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return `<section class="card" id="exp-form"><p class="card-label">Try a change and measure it</p>
    <p class="fine">Pick one change, start it today, and keep everything else as usual. The app compares the same hours with the weeks before, allowing for the weather. Import a newer Delmarva file after a week or two to see the result.</p>
    <div class="bill-form"><label class="item"><span>What will you change?</span><input id="exp-title" maxlength="160" value="${esc(d.title || '')}" placeholder="e.g. switch off the old TV box overnight"></label>
    <label class="item"><span>From</span>${sel('exp-h0', HOURS.slice(0, 24), d.hours ? d.hours[0] : '')}</label><label class="item"><span>Until</span>${sel('exp-h1', HOURS.slice(1), d.hours ? d.hours[1] : 24)}</label>
    <label class="item"><span>Days</span>${sel('exp-days', DAYS, d.days ? d.days[0] : '')}</label>
    <details><summary>The device’s wattage, if you know it (optional)</summary><label class="item"><span>Watts (from its label)</span><input type="number" inputmode="numeric" id="exp-watts" min="1" value="${d.watts || ''}"></label><label class="item"><span>Hours a day it ran</span><input type="number" inputmode="decimal" id="exp-hpd" min="0.5" max="24" step="0.5" value="${d.hoursPerDay || ''}"></label><p class="fine">Lets the app tell you when a change is too small for the meter to show, and estimate it instead.</p></details>
    <label class="item"><span>Involves heating or cooling</span><input type="checkbox" id="exp-cool" ${d.cooling ? 'checked' : ''}></label>
    <label class="item"><span>Start date</span><input type="date" id="exp-start" value="${esc(d.start || todayIso())}"></label>
    <button class="btn primary" data-act="exp-start">Start the test</button></div></section>`;
}
function viewSavingsTab() {
  const out = [pagehead('Savings', 'Test a change — the meter shows whether it worked')];
  if (!usageDays().length) return `${out.join('')}<section class="card"><p>Import your Delmarva file first; savings are worked out from your own readings.</p>${importButton()}</section>`;
  const sp = planNow(), exps = (S.experiments || []).slice().reverse();
  if (sp.note) out.push(`<section class="card good"><p>${esc(sp.note)}</p></section>`);
  const active = exps.filter((e) => !e.end), done = exps.filter((e) => e.end);
  if (active.length) out.push(`<h2 class="section-title">Running now</h2><section class="card"><ul class="findings exps">${active.map(expCard).join('')}</ul></section>`);
  out.push(`<h2 class="section-title">Worth looking into</h2>`);
  if (!sp.items.length) out.push('<section class="card"><p>Nothing in your readings clearly points to a saving right now.</p></section>');
  for (const o of sp.items) out.push(`<section class="card opp"><h2>${esc(o.action)}</h2><p>${esc(o.why)}</p>
    <dl class="facts"><dt>Evidence</dt><dd>${esc(o.evidence || '')}</dd><dt>Can you control it?</dt><dd>${esc(CONTROL[o.control] || o.control)}</dd><dt>Possible saving</dt><dd>${esc(savingLine(o))}</dd><dt>How it’s worked out</dt><dd>${esc(o.savings.method)}</dd><dt>Confidence in the evidence</dt><dd>${esc(CONF[o.confidence])}</dd><dt>Cost and effort</dt><dd>${esc(o.cost)} · ${esc(EFFORT[o.effort])}</dd><dt>Comfort</dt><dd>${esc(COMFORT[o.comfort])}</dd><dt>How we’ll know</dt><dd>${esc(o.verify)}</dd></dl>
    ${o.thermostat ? '<p class="fine">Involves the thermostat — the app never changes it; you do.</p>' : ''}
    ${o.experiment ? `<button class="btn secondary" data-act="exp-prefill" data-src="${esc(o.id)}">Test this</button>` : ''}</section>`);
  out.push(expForm());
  if (done.length) out.push(`<h2 class="section-title">Finished tests</h2><section class="card"><ul class="findings exps">${done.map(expCard).join('')}</ul></section>`);
  out.push(`<h2 class="section-title">Looked at, not worth it now</h2><section class="card"><ul class="bullets">${sp.considered.map((c) => `<li><b>${esc(c.what)}</b> — ${esc(c.why)}${c.experiment ? ` <button class="link" data-act="exp-prefill" data-src="${esc(c.id)}">Test it anyway</button>` : ''}</li>`).join('')}</ul></section>`);
  const acts = actsList();
  if (acts) out.push(`<h2 class="section-title">Earlier tracked actions</h2><section class="card"><ul class="findings actions">${acts}</ul></section>`);
  out.push(viewSavings().replace(/^.*?<\/header>/s, '<h2 class="section-title">Thermostat schedule results</h2>'));
  return out.join('');
}

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
  const inv = invNow();
  out.push(normalityCard(true), inv?.hypotheses?.length ? investigationCard(inv) : '', awayCards(true));
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
    <a class="card" href="#bills"><p class="card-label">Your bill</p><h2>Month by month</h2><p>Measured kWh, estimates, statements and projections, kept apart.</p></a>
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
  const r = getPath(S.profile.routine, day), home = !r.leave && !r.back;
  const k = (f) => `profile.routine.${day}.${f}`;
  const w = DAYWORD[day].replace(/s$/, '');
  return group(DAYWORD[day], DAYSUB[day] || '', `${timeItem(k('wake'), 'Wake up')}
    <label class="item"><span>Someone is home all day</span><span class="switch"><input type="checkbox" data-home="${day}" ${home ? 'checked' : ''}><i></i></span></label>
    ${home ? '' : `${timeItem(k('leave'), 'Everyone leaves')}${timeItem(k('back'), 'Someone is back')}`}${timeItem(k('sleep'), 'Bedtime')}
    <p class="field-error" id="err-${dayId(day)}" role="alert" hidden></p>`).replace(/data-label="(Wake up|Everyone leaves|Someone is back|Bedtime)"/g, (_, l) => `data-label="${w} ${l.toLowerCase()}"`);
}
/** Weekdays/Weekends, or each day separately (the IT900's Individual Days mode). "Home" means anyone is home. */
function routineSection() {
  const daysMode = S.profile.routine.mode === 'days';
  const seg = `<div class="seg" role="group" aria-label="Schedule type"><button data-act="routine-mode" data-v="groups" aria-pressed="${!daysMode}">Weekdays + weekends</button><button data-act="routine-mode" data-v="days" aria-pressed="${daysMode}">Each day separately</button></div>`;
  return `${group('Routine', 'When is anyone home? The schedule heats or cools the apartment while someone is there and eases off only when it’s empty.', `<div class="item col">${seg}</div>`)}
    ${daysMode ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => routineGroup(`days.${d}`)).join('') : `${routineGroup('weekday')}${routineGroup('weekend')}`}`;
}

function savedBanner() {
  if (!savedNote || Date.now() - savedNote.at > 120e3) return '<div id="saved" aria-live="polite"></div>';
  const st = A.todayStatus(S, recNow());
  const todo = st.kind === 'update' || st.kind === 'program';
  const tail = st.kind === 'hold' ? `Thermostat on HOLD at ${S.profile.thermostat.setpoint}°F, programming off (confirmed by you).`
    : st.kind === 'update' ? 'Your thermostat schedule changed. <a href="#today">Update it from Today</a>.'
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
    ${routineSection()}`;
  const right = `
    ${group('Electricity data', 'Used only on this device to measure what’s working.', `<div class="item"><span>Latest data</span><span class="value">${days.length ? `${esc(dayLabel(days[days.length - 1].date))} · ${days.length} days` : 'None yet'}</span></div><div class="item col">${importButton()}${busy === 'import' ? '<p class="fine">Reading…</p>' : ''}<details class="inline"><summary>How to get the file from Delmarva</summary>${HOW_TO_DOWNLOAD}</details></div>${days.length ? '<button class="item danger" data-act="clear-usage">Delete electricity data</button>' : ''}`)}
    ${thermostatGroup()}
    ${zonesGroup()}
    ${group('Privacy and backup', 'Your settings and electricity data stay on this device. The app only downloads public weather for Wilmington; nothing personal is sent anywhere.', `<div class="item col"><div class="row2"><button class="btn primary" data-act="export">Save backup</button><label class="btn secondary file">Restore or merge<input type="file" id="backup-file" accept=".json,application/json"></label></div><p class="fine">Moving between your Mac and iPhone: save a backup on one, then “Restore or merge” on the other. You’ll see what will be added and choose anything that conflicts; nothing is replaced unless you ask.</p>${hasSnapshot() ? '<button class="btn plain" data-act="undo-last">Undo the last merge, restore or routine update</button>' : ''}</div>`)}
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
  p.routine = { ...p.routine, ...draftRoutine(d), mode: 'groups' }; // quick setup uses weekdays + weekends; per-day times stay saved
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
    body = `<h1>Program your thermostat</h1><p class="lead">Stand at the thermostat. You’ll enter a start time and a temperature for four periods, ${rec.plans.some((p) => p.daysMode) ? 'for each day of the week (days identical to the one before are a single step)' : 'once for weekdays and once for weekends'}${rec.plans.length > 1 ? ', for heating and then cooling' : ''}. About 5 minutes.</p>
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

const ROUTES = { today: viewToday, insights: viewInsights, settings: viewSettings, setup: viewSetup, program: viewProgram, weather: viewWeather, usage: viewUsage, savings: viewSavingsTab, schedule: viewSchedule, investigate: viewInvestigate, restore: viewRestore, bills: viewBills };
const PARENT = { restore: 'settings', investigate: 'insights', weather: 'insights', usage: 'insights', schedule: 'today' };
const TITLES = { bills: 'Your bill', restore: 'Restore or merge', investigate: 'Investigation', setup: 'Setup', program: 'Program thermostat', weather: 'Weather', usage: 'Electricity use', savings: 'Savings', schedule: 'Weekly schedule' };
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

const isoDaysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
/** Daily temperatures for usage dates the station history doesn't cover — automatic, once per session. */
async function fillArchive() {
  if (archiveTried || !WD.loaded) return;
  const temps = allTemps();
  const missing = usageDays().map((d) => d.date).filter((d) => !Number.isFinite(temps[d]) && d < todayIso());
  if (!missing.length) return;
  archiveTried = true;
  try {
    // Ask for the whole calendar year up to yesterday, not exactly the dates of your readings: the request then reveals only the year.
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${LOC.lat}&longitude=${LOC.lon}&start_date=${missing[0].slice(0, 4)}-01-01&end_date=${isoDaysAgo(1)}&daily=temperature_2m_mean&temperature_unit=fahrenheit&timezone=America%2FNew_York`;
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
  'ai-run'() { if (busy !== 'ai') runAI(true); },
  'ai-prioritize'() { if (busy !== 'ai') runAI(false); },
  'ai-show'(el) { UI.aiShown = Number(el.dataset.i); render(); },
  async 'ai-export'() {
    const list = loadAI(), rp = list[Math.min(UI.aiShown ?? list.length - 1, list.length - 1)];
    if (!rp) return;
    const name = `energy-${rp.kind === 'aeo-decision' ? 'priority' : 'ai-analysis'}-${rp.created.slice(0, 10)}.json`;
    const file = new File([JSON.stringify(rp, null, 1)], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  answer(el) {
    const q = el.dataset.q, v = el.dataset.v, def = A.QUESTIONS[q];
    if (!def || !def.options.some(([k]) => k === v)) return;
    const inv = invNow();
    S.answers = [...(S.answers || []), { q, key: def.scope === 'home' ? '' : el.dataset.key, value: v, at: todayIso(), since: inv?.since || '' }].slice(-200);
    if (q === 'hvac_meter' && v !== 'unknown') S.profile.hvacMetered = v;
    if (q === 'heat_on' && v === 'yes') S.profile.buildingMode = 'heat_available';
    UI.reask = undefined;
    save();
    toast(q === 'heat_on' && v === 'yes' ? 'Thanks — season set to heating, and the investigation is updated.' : 'Thanks — the investigation is updated.');
    render();
  },
  reask(el) { UI.reask = el.dataset.q; render(); window.scrollTo(0, 0); },
  track(el) {
    const id = el.dataset.id;
    if ((S.actions || []).some((a) => a.id === id)) return;
    const h = el.dataset.hours ? el.dataset.hours.split('-').map(Number) : null;
    S.actions = [...(S.actions || []), { id, key: el.dataset.key, title: el.dataset.title, status: 'planning', at: todayIso(), start: '', hours: h }];
    save();
    toast('Added to “Things you’re trying”. Mark it started when you begin.');
    render();
  },
  'routine-mode'(el) {
    const v = el.dataset.v, rt = S.profile.routine;
    if (v === rt.mode || !['groups', 'days'].includes(v)) return;
    // Switching to individual days starts from the current weekday/weekend times so nothing changes until you edit a day.
    if (v === 'days') rt.days = Object.fromEntries(C.DOW.map((d) => [d, { ...(d === 'Sat' || d === 'Sun' ? rt.weekend : rt.weekday) }]));
    rt.mode = v;
    save();
    noteSaved(v === 'days' ? 'routine: each day separately' : 'routine: weekdays + weekends');
    render();
  },
  'bill-add'() {
    const v = (id) => document.getElementById(id)?.value.trim() || '', num0 = (id) => (v(id) === '' ? null : +v(id));
    const end = v('bill-end'), start = v('bill-start'), amount = num0('bill-amount');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || amount == null || !(amount >= 0)) return toast('Enter at least the service end date and this period’s charges.', true);
    if (start && start >= end) return toast('The start date must be before the end date.', true);
    const editingId = stmtDraft?.editingId || null;
    const rec = { id: editingId || `${end}|${amount}|${Date.now().toString(36)}`, start, end, amount, kwh: num0('bill-kwh'), days: num0('bill-days'), statementDate: v('bill-statementDate'), estimatedRead: !!document.getElementById('bill-estimated')?.checked, source: stmtDraft && !editingId ? 'pdf' : (stmtDraft?.fields?.source || 'manual'), at: todayIso() };
    for (const [k] of STMT_FIELDS) rec[k] = num0(`bill-${k}`);
    const c = A.statementConflicts(S.bills || [], rec, { editingId });
    if (c.invalid) return toast('That statement couldn’t be saved — check the numbers.', true);
    if (c.duplicate) return toast('That statement is already saved.', true);
    let list = (S.bills || []).filter((x) => x.id !== editingId);
    if (c.revision) {
      if (!confirm(`A statement for the same service period (ending ${shortDate(c.revision.end)}, ${money(c.revision.amount)}) is already saved. Replace it with this one (${money(amount)})? A copy is kept so you can undo.`)) return;
      list = list.filter((x) => x.id !== c.revision.id);
    }
    try { commitAndReload({ ...S, bills: A.cleanBills([...list, rec]) }, editingId ? 'statement correction' : 'statement'); } catch (err) { return toast(`Not saved: ${err.message} Your data is unchanged.`, true); }
    stmtDraft = null; render();
    toast(`${editingId || c.revision ? 'Statement replaced' : 'Statement saved'} on this device.${c.overlaps.length ? ' It overlaps another statement’s dates — both are kept and flagged.' : ''} You can undo from Settings.`);
  },
  'bill-edit'(el) {
    const b = (S.bills || []).find((x) => x.id === el.dataset.id);
    if (!b) return;
    stmtDraft = { fields: { ...b }, found: [], notFound: [], name: 'your saved statement', editingId: b.id };
    render(); document.getElementById('bill-end')?.scrollIntoView({ block: 'center' });
  },
  'bill-draft-clear'() { stmtDraft = null; render(); },
  'billing-take'(el) {
    const r = pendingBilling[+el.dataset.i]; if (!r) return;
    try { commitAndReload({ ...S, bills: A.cleanBills([...(S.bills || []).filter((b) => b.id !== r.existing.id), r.incoming]) }, 'billing correction'); } catch (err) { return toast(`Not saved: ${err.message}`, true); }
    pendingBilling.splice(+el.dataset.i, 1); render(); toast('Replaced with the new figures. You can undo from Settings.');
  },
  'billing-keep'(el) { pendingBilling.splice(+el.dataset.i, 1); render(); toast('Kept the saved billing period.'); },
  'th-save'() {
    const prev = S.profile.thermostat || {}, v = (id) => document.getElementById(id);
    const t = A.cleanThermostat({ ...prev, mode: S.profile.buildingMode === 'heat_available' ? 'heat' : 'cool', setpoint: +v('th-set')?.value, hold: !!v('th-hold')?.checked, programming: v('th-prog')?.value, confirmed: todayIso() });
    if (!t) return toast('Enter the temperature shown on the thermostat (50–90°F).', true);
    try { commitAndReload({ ...S, profile: { ...S.profile, thermostat: t } }, 'thermostat'); } catch (err) { return toast(`Not saved: ${err.message}`, true); }
    render(); toast(`Saved: ${t.setpoint}°F${t.hold ? ' HOLD' : ''}, programming ${t.programming}. The thermostat itself is unchanged.`);
  },

  'exp-prefill'(el) {
    const sp = planNow(), o = [...sp.items, ...sp.considered].find((x) => x.id === el.dataset.src);
    if (!o?.experiment) return;
    expDraft = { ...o.experiment, start: todayIso() };
    render(); document.getElementById('exp-form')?.scrollIntoView({ block: 'start' });
  },
  'exp-start'() {
    const v = (id) => document.getElementById(id)?.value ?? '';
    const title = v('exp-title').trim(), h0 = +v('exp-h0'), h1 = +v('exp-h1'), dd = v('exp-days'), start = v('exp-start');
    if (!title) return toast('Describe the change in a few words.', true);
    if (!(h1 > h0)) return toast('“Until” must be after “From”.', true);
    const e = { id: `x${Date.now().toString(36)}`, title, start: start || todayIso(), hours: h0 === 0 && h1 === 24 ? null : [h0, h1], days: dd === '' ? null : [+dd],
      watts: +v('exp-watts') || null, hoursPerDay: +v('exp-hpd') || null, cooling: !!document.getElementById('exp-cool')?.checked, at: todayIso() };
    const overlap = (S.experiments || []).find((o) => !o.end);
    if (overlap && !confirm(`“${overlap.title}” is still running. Two changes at once can’t be told apart — start anyway?`)) return;
    try { commitAndReload({ ...S, experiments: A.cleanExperiments([...(S.experiments || []), e]) }, 'experiment'); } catch (err) { return toast(`Not saved: ${err.message}`, true); }
    expDraft = null; render(); toast('Test started. Keep everything else as usual; import a newer Delmarva file in a week or two.');
  },
  'exp-end'(el) {
    S.experiments = A.cleanExperiments((S.experiments || []).map((e) => (e.id === el.dataset.id ? { ...e, end: todayIso() < e.start ? e.start : todayIso() } : e)));
    save(); render(); toast('Test ended. The result uses the days up to today.');
  },
  'exp-decide'(el) {
    S.experiments = A.cleanExperiments((S.experiments || []).map((e) => (e.id === el.dataset.id ? { ...e, decision: el.dataset.v || null } : e)));
    save(); render();
  },

  'usual-save'() {
    const lo = +document.getElementById('usual-low')?.value, hi = +document.getElementById('usual-high')?.value;
    if (!(lo > 0) || !(hi >= lo)) return toast('Enter a low and a high amount.', true);
    S.profile.usualBill = { low: lo, high: hi, source: 'you' }; save(); render(); toast('Saved as your usual bill.');
  },
  'bill-remove'(el) { S.bills = (S.bills || []).filter((b) => b.id !== el.dataset.id); save(); render(); },
  'proj-save'() {
    const v = (id) => document.getElementById(id)?.value || '', amount = v('proj-amount') === '' ? null : +v('proj-amount'), soFar = v('proj-sofar') === '' ? null : +v('proj-sofar');
    const start = v('proj-start'), end = v('proj-end');
    if (amount == null || !(amount >= 0)) return toast('Enter the projected total.', true);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return toast('Enter the date the period ends.', true);
    if (start && start > end) return toast('The period must start before it ends.', true);
    if (soFar != null && soFar > amount) return toast('“So far” can’t be more than the projected total.', true);
    const f = A.forecastBill({ state: { ...S, projections: [] }, temps: allTemps(), period: start ? { start, end } : null });
    const snap = A.cleanProjections([{ amount, soFar, periodStart: start, periodEnd: end, shownOn: v('proj-asof'), enteredAt: todayIso(), source: 'entered by you', app: f.available ? { mid: f.mid, low: f.low, high: f.high, method: f.method, through: f.readingsEnd } : null }])[0];
    if ((S.projections || []).some((p) => p.id === snap.id)) return toast('That projection is already saved.', true);
    try { commitAndReload({ ...S, projections: A.cleanProjections([...(S.projections || []), snap]) }, 'projection'); } catch (err) { return toast(`Not saved: ${err.message}`, true); }
    render(); toast('Projection saved as Delmarva’s number. The app’s own estimate is unchanged.');
  },
  'proj-remove'(el) { S.projections = (S.projections || []).filter((p) => p.id !== el.dataset.id); save(); render(); },
  'ai-cancel'() { fetch('/api/analyze/cancel', { method: 'POST' }).catch(() => {}); aiCtl?.abort(); },
  'restore-choice'(el) { if (pendingRestore) { pendingRestore.choices[el.dataset.id] = el.dataset.v; render(); } },
  'restore-cancel'() { pendingRestore = null; if (householdUpdate && route() === 'today') householdUpdate = { ...householdUpdate, dismissed: true }; location.hash = route() === 'restore' ? 'settings' : route(); render(); },
  'restore-merge'() {
    const p = pendingRestore;
    if (!p) return;
    try {
      const merged = A.applyMerge(S, p.state, p.choices, p.plan);
      commitAndReload(merged, 'merge');
      const ai = loadAI(), seen = new Set(ai.map((r) => `${r.created}|${r.model}`));
      saveAI([...ai, ...(p.aiReports || []).filter((r) => validReport(r) && !seen.has(`${r.created}|${r.model}`))]);
      toast(p.plan.empty ? 'Nothing new to add.' : 'Merged and verified — saved on this device. You can undo from Settings.');
    } catch (err) { toast(`Merge not saved: ${err.message} Your data is unchanged.`, true); }
    pendingRestore = null; location.hash = 'settings'; render();
  },
  'restore-replace'() {
    const p = pendingRestore;
    if (!p || !confirm('Replace ALL data on this device with this backup? Readings, answers and settings that exist only here will be removed. A copy is saved first so you can undo.')) return;
    try { commitAndReload(p.state, 'replace'); toast('Replaced and verified. You can undo from Settings.'); } catch (err) { toast(`Not replaced: ${err.message} Your data is unchanged.`, true); }
    pendingRestore = null; location.hash = 'settings'; render();
  },
  'undo-last'() {
    if (!confirm('Undo the last merge, restore or routine update? This device goes back to the copy saved just before it.')) return;
    try { const snap = A.undoLast(localStorage, KEY); S = A.migrate(JSON.parse(localStorage.getItem(KEY))); toast(`Undone — back to your data from ${fmtNY(Date.parse(snap.at))}, verified.`); } catch (err) { toast(err.message, true); }
    render();
  },
  'apply-household'() { const u = pendingRestore?.update || householdUpdate; if (u) applyHouseholdNow(u); },
  'zone-add'() {
    const n = (S.zones || []).length;
    if (n >= 4) return;
    const dc = C.defaultState().profile.comfort;
    S.zones = [...(S.zones || []), { id: `z${Date.now().toString(36)}`, label: `Thermostat ${n + 1}`, hvacType: 'unknown', availability: 'unknown', use: '', metered: 'unknown', heat: { ...dc.heat }, cool: { ...dc.cool } }];
    save(); render();
  },
  'zone-remove'(el) { if (!confirm('Remove this thermostat zone?')) return; S.zones = S.zones.filter((z) => z.id !== el.dataset.id); save(); render(); },
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
    UI.device = UI.device || Math.random().toString(36).slice(2, 8); saveUI();
    const file = new File([JSON.stringify({ ...S, weatherCache: null, meta: { app: 'energy-optimizer', schema: A.STATE_VERSION, exportedAt: new Date().toISOString(), device: UI.device }, aiReports: loadAI() }, null, 2)], name, { type: 'application/json' });
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

let pendingBilling = [], billingImported = false; // billing periods from an export that need a decision
async function importUsage(files) {
  busy = 'import';
  render();
  const msgs = [];
  let bad = false;
  const expanded = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name) || f.type === 'application/zip') {
      try { if (f.size > 25e6) throw new Error('File is larger than 25 MB.'); for (const e of await C.unzipUsage(await f.arrayBuffer())) expanded.push({ name: e.name, text: e.text }); } catch (err) { bad = true; msgs.push(`Couldn’t open ${f.name}: ${err.message}`); }
    } else expanded.push({ name: f.name, file: f });
  }
  files = expanded;
  for (const f of files) {
    try {
      const res = C.importUsageFile(f.name, f.text ?? await readFile(f.file));
      if (res.kind === 'billing') { // Delmarva's billing-data export: billing periods, kept with your statements — never mixed into readings
        const plan = A.planBillingImport(S.bills || [], res.periods, { today: todayIso() });
        if (plan.add.length) commitAndReload({ ...S, bills: A.cleanBills([...(S.bills || []), ...plan.add]) }, 'billing data');
        pendingBilling = [...pendingBilling.filter((r) => !plan.review.some((x) => x.incoming.id === r.incoming.id)), ...plan.review];
        msgs.push(`Billing data: ${plan.add.length} billing period${plan.add.length === 1 ? '' : 's'} added${plan.same ? `, ${plan.same} already saved` : ''}${plan.review.length ? `, ${plan.review.length} need your review on Bills (different figures or overlapping dates)` : ''}`);
        billingImported = true;
        continue;
      }
      // Readings: new ones are added, identical ones are skipped, and a reading that would change a saved value is held back (never overwritten silently).
      const key = (r) => (r.hour != null ? `${r.date}T${String(r.hour).padStart(2, '0')}` : r.date);
      const merged = C.mergeUsage({ hourly: {}, daily: {}, cost: {} }, res.records);
      const changed = [...Object.entries(merged.hourly).filter(([k, v]) => S.usage.hourly[k] != null && Math.abs(S.usage.hourly[k] - v) > 1e-9), ...Object.entries(merged.daily).filter(([k, v]) => S.usage.daily[k] != null && Math.abs(S.usage.daily[k] - v) > 1e-9)].map(([k]) => k);
      const keep = changed.length ? res.records.filter((r) => !changed.includes(key(r))) : res.records;
      const before = S.usage;
      S.usage = C.mergeUsage(S.usage, keep); // merges by hour/day: never deletes history, never double-counts a re-import
      msgs.push(`${files.length > 1 ? `${f.name}: ` : 'Imported '}${A.importSummary(before, S.usage, res).message}${changed.length ? ` ${changed.length} reading${changed.length === 1 ? '' : 's'} differed from what’s saved and ${changed.length === 1 ? 'was' : 'were'} not changed` : ''}`);
    } catch (err) {
      bad = true;
      msgs.push(`Couldn’t import ${files.length > 1 ? f.name : 'that file'}: ${err.message}`);
    }
  }
  save();
  const days = usageDays(), temps = allTemps();
  const matched = days.filter((d) => Number.isFinite(temps[d.date])).length;
  const onlyBilling = msgs.every((m) => /Billing data:/.test(m));
  const msg = `${msgs.map((m) => m.replace(/\.$/, '')).join('. ')}.${!bad && days.length && !onlyBilling ? ` ${matched} day${matched === 1 ? '' : 's'} matched with weather.` : ''}`;
  toast(bad || onlyBilling ? msg : `${msg} Your report is ready.`, bad && msgs.length === 1);
  if (billingImported && !files.some((f) => !/billing/i.test(f.name))) { location.hash = 'bills'; billingImported = false; }
  else if (msgs.length > (bad ? 1 : 0) && days.length) {
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
  const parts = k.split('.'), day = parts.slice(2, -1).join('.'), field = parts[parts.length - 1];
  const trial = { ...getPath(S.profile.routine, day), [field]: v };
  const err = routineError(trial);
  const box = $(`#err-${dayId(day)}`);
  if (err) {
    el.setAttribute('aria-invalid', 'true');
    if (box) { box.textContent = `${err} Your last valid ${DAYWORD[day].toLowerCase()} schedule is still in use.`; box.hidden = false; }
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
  const day = el.dataset.home, r = getPath(S.profile.routine, day), awayDefault = AWAY_DEFAULT[day] || AWAY_DEFAULT.weekday;
  UI.away = UI.away || {};
  let next;
  if (el.checked) { UI.away[day] = { leave: r.leave, back: r.back }; next = { ...r, leave: '', back: '' }; } else { const p = UI.away[day] || awayDefault; next = { ...r, leave: p.leave || awayDefault.leave, back: p.back || awayDefault.back }; }
  const err = routineError(next);
  if (err) { el.checked = !el.checked; const box = $(`#err-${dayId(day)}`); if (box) { box.textContent = `${err} Adjust the times first.`; box.hidden = false; } return; }
  setPath(S.profile.routine, day, next);
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
  if (el.id === 'backup-file' && el.files[0]) return openRestoreFile(el.files[0]);
  if (el.dataset.expExclude && el.value) {
    S.experiments = A.cleanExperiments((S.experiments || []).map((e) => (e.id === el.dataset.expExclude ? { ...e, exclude: [...new Set([...(e.exclude || []), el.value])] } : e)));
    save(); render(); toast('That day is left out of the comparison.');
    return;
  }
  if (el.id === 'statement-pdf' && el.files[0]) {
    const f = el.files[0];
    toast('Reading the statement on this Mac…');
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000);
      const res = await fetch('/api/statement-text', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: await f.arrayBuffer(), signal: ctl.signal }).finally(() => clearTimeout(timer));
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'it couldn’t be read');
      if (j.scanned) throw new Error('it is a scanned image without text. Type the figures in below.');
      stmtDraft = { ...A.parseStatementText(j.text), name: f.name.slice(0, 60) };
      render();
      toast(stmtDraft.found.length ? `Found ${stmtDraft.found.length} items — check them before saving.` : 'No labelled figures found — type them in below.', !stmtDraft.found.length);
    } catch (err) { toast(`Statement not read: ${err.name === 'AbortError' ? 'it took too long' : err.message}. Nothing was saved.`, true); }
    el.value = '';
    return;
  }
  if (el.dataset.actionStatus || el.dataset.actionStart) {
    const a = (S.actions || []).find((x) => x.id === (el.dataset.actionStatus || el.dataset.actionStart));
    if (!a) return;
    if (el.dataset.actionStatus && A.ACTION_STATUS[el.value]) { a.status = el.value; if (el.value === 'started' && !a.start) a.start = todayIso(); }
    if (el.dataset.actionStart) a.start = /^\d{4}-\d{2}-\d{2}$/.test(el.value) ? el.value : '';
    save(); render(); return;
  }
  if (el.dataset.zone) {
    if (el.dataset.zone === 'moveIn') S.moveIn = /^\d{4}-\d{2}-\d{2}$/.test(el.value) ? el.value : '';
    else {
      const z = (S.zones || []).find((x) => x.id === el.dataset.zone);
      if (!z) return;
      const path = el.dataset.f.split('.'), val = el.type === 'number' ? Number(el.value) : el.value.slice(0, 60);
      if (el.type === 'number' && !(val >= 40 && val <= 95)) return toast('Use a temperature between 40 and 95°F.', true);
      if (path.length === 2) z[path[0]][path[1]] = val; else z[path[0]] = val;
    }
    save(); noteSaved('next-apartment settings'); return;
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
