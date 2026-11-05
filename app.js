// Apartment Energy Optimizer — UI: Today / Insights / Settings, plus guided setup and guided programming.
// Personal data stays in this browser's localStorage. Network: api.weather.gov (forecast), this site's public
// weather files (data/weather/), and archive-api.open-meteo.com for daily temperatures only when needed.
import * as C from './core.js';
import * as Wx from './weather.js';
import * as A from './advisor.js';

const KEY = 'aeo.state.v1'; // unchanged so existing installs keep their data (contents migrate to v2)
const UI_KEY = 'aeo.ui.v1';
const LOC = { lat: 39.7447, lon: -75.5484, name: 'Wilmington, DE' }; // city centre, not your address
const MANUAL_URL = 'https://energywiserewards.delmarva.com/wp-content/uploads/2020/11/20_DDWMAN2026_IT900-400_USER_MANUAL-CFO-073120-crp.pdf';
const SUPPORT_URL = 'https://energywiserewards.delmarva.com/de/contact/';
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STANDALONE = navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
const HOUR = Wx.HOUR;
const SEASONS = [['heat_available', 'Heat'], ['cool_available', 'Cooling'], ['fan_only', 'Fan only'], ['unknown', 'Not sure']];

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n, d = 0) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const money = (n) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
const dayLabel = (iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
const fmtNY = (ms, opts = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) => new Date(ms).toLocaleString('en-US', { timeZone: C.TZ, ...opts });
const hourLabel = (h) => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;
const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const daysAgo = (iso) => Math.round((Date.parse(`${todayIso()}T12:00:00Z`) - Date.parse(`${iso}T12:00:00Z`)) / 864e5);
const todayIso = () => C.localParts(Date.now()).date;
const signed = (v, d = 1) => `${v >= 0 ? '+' : '−'}${num(Math.abs(v), d)}`;
const modeWord = (m) => (m === 'heat' ? 'Heat' : 'Cool');

let S = load();
let UI = loadUI();
let WD = { loaded: false, status: null, daily: null, skill: null, latest: null, insights: null, obs: {} };
let weatherErr = '', busy = '', lastRefresh = 0, archiveTried = false;
let draft = null, setupStep = 0, progStep = 0;

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
const recNow = () => C.recommend(S, forecastHours(), Date.now());
const usageDays = () => C.dailyTotals(S.usage).filter((d) => d.complete);
/** Validated weather insights from the background operator (public data only; advice, never the schedule itself). */
const opsItems = () => (WD.insights?.items || []).filter((i) => Date.parse(i.valid_until) > Date.now());

// ---------- charts ----------

const readout = (text) => `<div class="readout" aria-live="polite">${text}</div>`;

function barChart(vals, { label, ticks, tips, low }) {
  if (!vals.length) return '';
  const w = 600, h = 170, px = 6, top = 10, bot = 28;
  const max = Math.max(...vals, 1e-6);
  const bw = (w - 2 * px) / vals.length;
  const gap = Math.min(4, bw * 0.25);
  const bars = vals.map((v, i) => {
    const bh = Math.max(v > 0 ? 2 : 0, (v / max) * (h - top - bot));
    return `<rect x="${(px + i * bw + gap / 2).toFixed(1)}" y="${(h - bot - bh).toFixed(1)}" width="${(bw - gap).toFixed(1)}" height="${bh.toFixed(1)}" rx="${Math.min(4, (bw - gap) / 2).toFixed(1)}" class="${low?.(i) ? 'lo' : ''}" data-tip="${esc(tips[i])}"/>`;
  }).join('');
  const every = Math.ceil(vals.length / 6);
  const tk = ticks.map((t, i) => (i % every === 0 ? `<text x="${(px + i * bw + bw / 2).toFixed(1)}" y="${h - 4}" text-anchor="middle">${esc(t)}</text>` : '')).join('');
  return `<svg class="chart bars" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}"><line class="grid" x1="0" x2="${w}" y1="${h - bot}" y2="${h - bot}"/>${bars}${tk}</svg>${readout('Tap a bar for details.')}`;
}

/** Time-axis chart: one or two series (second dashed) plus an optional min–max band; long gaps break the line. */
function timeChart(series, { label, band = [], gap, tick, unit = '°' }) {
  const all = series.flatMap((s) => s.pts).concat(band.flatMap((b) => [{ x: b.x, y: b.lo }, { x: b.x, y: b.hi }]));
  if (all.length < 2) return '<p class="fine">Not enough data to chart yet.</p>';
  const w = 600, h = 190, pl = 40, pr = 12, top = 12, bot = 28;
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.floor(Math.min(...ys) - 2), y1 = Math.ceil(Math.max(...ys) + 2);
  const X = (x) => pl + ((x - x0) / Math.max(1, x1 - x0)) * (w - pl - pr);
  const Y = (y) => top + ((y1 - y) / Math.max(1, y1 - y0)) * (h - top - bot);
  const path = (pts) => pts.map((p, i) => `${i && p.x - pts[i - 1].x <= gap ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const grid = [0, 1, 2, 3].map((k) => { const v = y0 + ((y1 - y0) * k) / 3; return `<line class="grid" x1="${pl}" x2="${w - pr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="y" x="${pl - 6}" y="${(Y(v) + 5).toFixed(1)}" text-anchor="end">${Math.round(v)}${unit}</text>`; }).join('');
  const ticks = [0, 1, 2, 3].map((k) => { const x = x0 + ((x1 - x0) * (k + 0.5)) / 4; return `<text x="${X(x).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(tick(x))}</text>`; }).join('');
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
  const w = 600, h = 220, pl = 44, pr = 12, top = 12, bot = 30;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y).concat(curve.map((c) => c.y));
  const x0 = Math.floor(Math.min(...xs) - 2), x1 = Math.ceil(Math.max(...xs) + 2);
  const y1 = Math.ceil(Math.max(...ys) * 1.1);
  const X = (x) => pl + ((x - x0) / Math.max(1, x1 - x0)) * (w - pl - pr);
  const Y = (y) => top + ((y1 - y) / Math.max(1, y1)) * (h - top - bot);
  const grid = [0, 1, 2, 3].map((k) => { const v = (y1 * k) / 3; return `<line class="grid" x1="${pl}" x2="${w - pr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="y" x="${pl - 6}" y="${(Y(v) + 5).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`; }).join('');
  const ticks = [0, 1, 2, 3, 4].map((k) => { const x = x0 + ((x1 - x0) * k) / 4; return `<text x="${X(x).toFixed(1)}" y="${h - 8}" text-anchor="middle">${Math.round(x)}°F</text>`; }).join('');
  const dots = pts.map((p) => `<circle class="pt" cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="6" data-tip="${esc(p.tip)}"/>`).join('');
  const fit = curve.length > 1 ? `<path class="fit" d="${curve.map((c, i) => `${i ? 'L' : 'M'}${X(c.x).toFixed(1)},${Y(c.y).toFixed(1)}`).join('')}"/>` : '';
  return `<div class="legend"><span><i class="dotsw"></i>One day: kWh vs. average outdoor °F</span>${fit ? '<span><i class="sw fitsw"></i>Your pattern</span>' : ''}</div><svg class="chart scatter" viewBox="0 0 ${w} ${h}" role="img" aria-label="Daily electricity use versus average outdoor temperature">${grid}${fit}${dots}${ticks}</svg>${readout('Tap a dot for that day.')}`;
}

// ---------- shared bits ----------

const ICON = {
  today: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M18.7 18.7l-1.4-1.4M6.7 6.7 5.3 5.3"/>',
  insights: '<path d="M5 20v-7M12 20V5M19 20v-11M3 20.5h18"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5"/>',
};
const TABS = [['today', 'Today'], ['insights', 'Insights'], ['settings', 'Settings']];
const title = (h, eyebrow = '') => `<header class="title">${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ''}<h1>${h}</h1></header>`;
const disclosure = (id, summary, body, open = false) => `<details class="disclosure" data-id="${id}" ${open || UI.open?.[id] ? 'open' : ''}><summary>${summary}</summary><div class="disc-body">${body}</div></details>`;
const importButton = (label = 'Import Delmarva file') => `<label class="btn primary file">${label}<input type="file" id="usage-file" accept=".csv,.xml,text/csv,text/xml,application/xml"></label>`;
const HOW_TO_DOWNLOAD = `<ol class="steps"><li>Sign in to <b>Delmarva My Account</b> in Safari.</li><li>Open <b>My Usage</b> and choose <b>Green Button – Download my data</b>.</li><li>Pick the longest date range offered and download <b>CSV</b> (or XML). Save it to Files.</li><li>Come back here and tap <b>Import Delmarva file</b>. Everything else is automatic.</li></ol><p class="fine">Delmarva doesn’t offer a way for personal apps to fetch usage automatically without your password, and this app never asks for it. The file stays on this phone.</p>`;

function scheduleTables(rec) {
  const table = (day, t) => `<div><h4>${t}</h4><table><tbody>${day.map((pd) => `<tr><td>${pd.name}${pd.away ? ' <span class="tag">away</span>' : ''}</td><td>${C.fmtMin(pd.start)}</td><td class="t">${pd.temp}°</td></tr>`).join('')}</tbody></table></div>`;
  return rec.plans.map((pl) => `<div class="sched"><h3>${pl.mode === 'heat' ? 'Heating' : 'Cooling'}</h3>${table(pl.weekday, 'Mon–Fri')}${table(pl.weekend, 'Sat–Sun')}</div>`).join('') + '<button class="btn secondary no-print" data-act="print">Print schedule</button>';
}

// ---------- Today ----------

function hero(st, rec) {
  if (st.kind === 'setup') return `<section class="hero neutral"><h2>Set up in about a minute</h2><p>Four quick questions about your apartment. Then this screen tells you exactly what to set on your thermostat.</p><a class="btn primary" href="#setup">Get started</a></section>`;
  if (st.kind === 'error') return `<section class="hero neutral"><h2>Check your routine</h2><p>${esc(st.message)}</p><a class="btn primary" href="#settings">Open Settings</a></section>`;
  if (st.kind === 'off') return `<section class="hero neutral"><h2>Nothing to set right now</h2><p>The building is in fan-only mode, so there’s no heating or cooling to schedule. Keep the thermostat fan on AUTO unless ventilation requires ON.</p>${seasonPicker('Has the building switched?')}</section>`;
  const cur = rec.current;
  const cls = cur.length > 1 ? 'both' : cur[0].mode;
  const ok = st.kind === 'ok';
  const temps = cur.map((c) => { const pd = rec.plans.find((p) => p.mode === c.mode); const away = c.temp === pd.setpoints.away && c.period === 'Day' && pd.setpoints.away !== pd.setpoints.home; return `<div class="reading"><span class="big">${c.temp}°</span><span class="sub">${modeWord(c.mode)} · ${c.period}${away ? ' · away' : ''}</span></div>`; }).join('');
  const first = cur[0].temp;
  const action = ok
    ? `<p class="verdict"><b>Nothing to change.</b> Your weekly schedule handles it automatically.</p><p class="fine light">The app can’t see your thermostat. If its screen says HOLD AT, press RUN to go back to the schedule.</p>`
    : `<div class="action"><h2>${st.kind === 'update' ? 'Update your thermostat schedule' : 'One-time step: program your weekly schedule'}</h2><p>${st.kind === 'update' ? `Your settings or the season changed since you programmed it on ${esc(dayLabel(st.programmedOn))}.` : 'Set it once and the thermostat adjusts itself every day — no daily changes needed.'} About 5 minutes at the thermostat, step by step.</p><a class="btn light" href="#program">${st.kind === 'update' ? 'Update schedule' : 'Start guided programming'}</a><p class="fine light">Not right now? Just set it to ${first}° with ▲/▼ — that holds until the next period.</p></div>`;
  return `<section class="hero ${cls}"><p class="hero-label">${ok ? 'Your thermostat should be at' : 'Recommended right now'}</p><div class="readings">${temps}</div>${action}</section>`;
}

const seasonPicker = (q) => `<p class="fine">${q}</p><div class="seg" role="group" aria-label="What the building provides">${SEASONS.map(([v, l]) => `<button data-act="season" data-v="${v}" aria-pressed="${S.profile.buildingMode === v}">${l}</button>`).join('')}</div>`;

function weatherLine(rec) {
  const lo = WD.status?.lastObservation;
  const fresh = lo && Date.now() - Date.parse(lo.at) < 3 * HOUR;
  const today = rec.outlook[0];
  const now = fresh ? `<b>${num(lo.t)}° outside</b><span>Observed ${esc(fmtNY(Date.parse(lo.at), { hour: 'numeric', minute: '2-digit' }))} at the airport</span>`
    : forecastHours()[0] ? `<b>${Math.round(forecastHours()[0].tempF)}° outside</b><span>Forecast · latest observation unavailable</span>` : '<b>Weather unavailable</b><span>Recommendations still work without it</span>';
  const day = today ? `<span>Today: high ${Math.round(today.high)}°, low ${Math.round(today.low)}°${today.text ? ` · ${esc(today.text)}` : ''}</span>` : '';
  return `<a class="rowcard" href="#insights" data-open="weather"><div class="rc-main">${now}${day}</div></a>`;
}

function energyLine() {
  const days = usageDays();
  if (!days.length) return `<a class="rowcard" href="#insights"><div class="rc-main"><b>Add your electricity data</b><span>One file from Delmarva shows what’s working</span></div></a>`;
  const last = days[days.length - 1].date;
  const f = A.buildInsights({ state: S, temps: allTemps() })[0];
  return `<a class="rowcard" href="#insights"><div class="rc-main"><b>${f ? esc(f.title) : 'Electricity insights'}</b><span>Electricity data through ${esc(dayLabel(last))}${daysAgo(last) > 14 ? ' · time to import a newer file' : ''}</span></div></a>`;
}

function viewToday() {
  const rec = recNow();
  const st = A.todayStatus(S, rec);
  const out = [title('Today', esc(fmtNY(Date.now(), { weekday: 'long', month: 'long', day: 'numeric' }))), hero(st, rec)];
  const live = ['program', 'update', 'ok'].includes(st.kind);
  if (live) {
    const n = rec.current[0].next;
    out.push(`<div class="rowcard static"><div class="rc-main"><b>Next: ${C.fmtMin(n.start)} → ${n.temp}°</b><span>${n.name}${st.kind === 'ok' ? ' · happens automatically' : ''}${rec.current.length > 1 ? ` · ${modeWord(rec.current[0].mode).toLowerCase()} schedule` : ''}</span></div></div>`);
  }
  const hint = A.seasonHint(S.profile, rec.outlook);
  if (hint && st.kind !== 'setup' && !(UI.seasonDismissed && Date.now() - UI.seasonDismissed < 3 * 864e5)) {
    out.push(`<section class="banner"><p>${hint === 'cool_available' ? 'Warm days ahead. Has your building switched to cooling?' : 'Cold days ahead. Has your building switched to heating?'}</p><div class="row2"><button class="btn primary" data-act="season" data-v="${hint}">Yes, switch</button><button class="btn secondary" data-act="dismiss-season">Not yet</button></div></section>`);
  }
  const ops = opsItems()[0];
  if (ops && st.kind !== 'setup') out.push(`<a class="rowcard" href="#insights" data-open="ops"><div class="rc-main"><b>${esc(ops.title)}</b><span>${esc(ops.detail)}</span></div></a>`);
  out.push(weatherLine(rec));
  const tip = rec.outlook[0]?.tips?.[0];
  if (tip && st.kind !== 'setup') out.push(`<p class="tip"><b>Tip</b> ${esc(tip)}</p>`);
  out.push(energyLine());
  if (live) {
    out.push(disclosure('why', 'Why this setting?', `<ul class="bullets">${A.whyNow(S, rec).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`));
    out.push(disclosure('week', 'Full weekly schedule', scheduleTables(rec)));
  }
  if (IOS && !STANDALONE) out.push(`<p class="fine center">Tip: tap Share → Add to Home Screen to install this app.</p>`);
  return out.join('');
}

// ---------- Insights ----------

function opsBody() {
  const ins = WD.insights;
  if (!ins?.generatedAt) return `<p class="fine">${WD.loaded ? 'The automated weather review hasn’t published anything yet.' : 'Loading…'}</p>`;
  const items = opsItems();
  return `${items.length ? `<ul class="findings">${items.map((x) => `<li class="${esc(x.tone)}"><b>${esc(x.title)}</b><span>${esc(x.detail)}${x.action ? ` ${esc(x.action)}` : ''}</span></li>`).join('')}</ul>` : '<p class="fine">Nothing in the forecast needs your attention right now.</p>'}
    <p class="fine">Checked ${esc(ago(Date.parse(ins.generatedAt)))} by an automated review of public weather and utility information. It never sees your electricity data or controls the thermostat; your schedule always comes from your own settings.</p>${ins.maintenance ? `<p class="note">${esc(ins.maintenance)}</p>` : ''}`;
}

function weatherBody() {
  const st = WD.status;
  if (!st) return `<p class="fine">${WD.loaded ? 'Weather history couldn’t be loaded right now (offline, or not published yet). It will appear automatically.' : 'Loading weather history…'}</p>`;
  const now = Date.now();
  const lo = st.lastObservation;
  const notes = [];
  if (lo && now - Date.parse(lo.at) > 3 * HOUR) notes.push(`Latest station observation is ${ago(Date.parse(lo.at))}.`);
  if (now - Date.parse(st.updatedAt) > 3 * HOUR) notes.push(`The hourly collector last ran ${ago(Date.parse(st.updatedAt))}; missed hours are filled in automatically when it runs again.`);
  const obsPts = Object.entries(WD.obs).filter(([k, r]) => r.t != null && Date.parse(k) >= now - 72 * HOUR).map(([k, r]) => ({ x: Date.parse(k), y: r.t, tip: `${fmtNY(Date.parse(k))}: ${num(r.t)}°F observed${r.rh != null ? `, ${num(r.rh)}% humidity` : ''}` })).sort((a, b) => a.x - b.x);
  const fcPts = forecastHours().filter((h) => h.t >= now - HOUR && h.t <= now + 48 * HOUR).map((h) => ({ x: h.t, y: h.tempF, tip: `${fmtNY(h.t)}: ${Math.round(h.tempF)}°F forecast` }));
  const daily = Object.entries(WD.daily || {}).filter(([, v]) => v.complete).slice(-90);
  const mid = (d) => Date.parse(`${d}T12:00:00Z`);
  const months = Wx.monthlySummary(WD.daily).slice(-13).reverse();
  const skill = Object.entries(WD.skill || {});
  return `${lo ? `<p class="stat-line"><b>${num(lo.t)}°F</b> observed at ${esc(Wx.STATION.name)}, ${esc(fmtNY(Date.parse(lo.at)))}${lo.rh != null ? ` · ${num(lo.rh)}% humidity` : ''}${lo.wind != null ? ` · wind ${num(lo.wind)} mph` : ''}</p>` : ''}
    ${notes.map((n) => `<p class="note">${esc(n)}</p>`).join('')}
    <h4>Last 3 days and next 2</h4>${timeChart([{ name: 'Observed (airport station)', pts: obsPts }, { name: 'Forecast (NWS)', pts: fcPts }], { label: 'Observed temperature for the last 3 days and forecast for the next 2 days', gap: 3 * HOUR, tick: (x) => fmtNY(x, { weekday: 'short', hour: 'numeric' }) })}
    <h4>Daily temperatures, last 90 days</h4>${timeChart([{ name: 'Daily average', pts: daily.map(([d, v]) => ({ x: mid(d), y: v.mean, tip: `${dayLabel(d)}: average ${v.mean}°F (low ${v.min}°, high ${v.max}°)${v.precip ? `, ${v.precip} in rain` : ''}` })) }], { band: daily.map(([d, v]) => ({ x: mid(d), lo: v.min, hi: v.max })), label: 'Daily average temperature with the daily low-to-high range, last 90 days', gap: 2 * 864e5, tick: (x) => new Date(x).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) })}
    <h4>By month</h4><p class="fine">Heating and cooling °F-days measure demand: how far each day’s average was below or above 65°F, added up.</p>
    <div class="table-wrap"><table><thead><tr><th>Month</th><th class="t">Avg</th><th class="t">Heating</th><th class="t">Cooling</th><th class="t">Rain in</th></tr></thead><tbody>${months.map((m) => `<tr><td>${esc(dayLabel(`${m.month}-15`, { month: 'short', year: 'numeric' }))}</td><td class="t">${num(m.mean, 1)}°</td><td class="t">${num(m.hdd)}</td><td class="t">${num(m.cdd)}</td><td class="t">${num(m.precip, 2)}</td></tr>`).join('')}</tbody></table></div>
    <h4>How accurate the forecast has been</h4><p class="fine">Saved forecasts compared with what the station measured later. Shown after 24 comparisons; positive bias means the forecast ran warm.</p>
    <div class="table-wrap"><table><thead><tr><th>Ahead</th><th class="t">Typical error</th><th class="t">Bias</th><th class="t">Hours</th></tr></thead><tbody>${skill.map(([lead, s]) => `<tr><td>${esc(lead)}</td><td class="t">${s.n >= 24 ? `${num(s.mae, 1)}°F` : '—'}</td><td class="t">${s.n >= 24 ? `${signed(s.bias)}°F` : '—'}</td><td class="t">${s.n}</td></tr>`).join('')}</tbody></table></div>
    <p class="fine">${num(st.hours)} hourly observations and ${num(st.days)} complete days since ${esc(st.coverageFrom ? dayLabel(st.coverageFrom.slice(0, 10), { month: 'short', day: 'numeric', year: 'numeric' }) : '—')}, collected every hour in the cloud even when your phone is off. Observations and forecasts are stored separately. Updated ${esc(ago(Date.parse(st.updatedAt)))}.</p>`;
}

function electricityBody() {
  const s = C.usageSummary(S.usage, S.profile.tariff, 60);
  const r = s.recent, temps = allTemps();
  const daily = barChart(r.map((d) => d.kwh), { label: 'Daily electricity use, kWh', ticks: r.map((d) => dayLabel(d.date, { month: 'numeric', day: 'numeric' })), tips: r.map((d) => `${dayLabel(d.date)}: ${num(d.kwh, 1)} kWh${d.cost != null ? ` · ${money(d.cost)}` : ''}${Number.isFinite(temps[d.date]) ? ` · ${num(temps[d.date])}°F outside` : ''}`), low: (i) => C.isWeekendDate(r[i].date) });
  const prof = s.hourProfile ? `<h4>A typical day</h4>${barChart(s.hourProfile, { label: 'Average use by hour of day', ticks: s.hourProfile.map((_, h) => hourLabel(h)), tips: s.hourProfile.map((v, h) => `${hourLabel(h)}: ${num(v, 2)} kWh average`) })}` : '<p class="fine">Hour-by-hour patterns appear when your file has hourly data.</p>';
  return `<div class="stats"><div><b>${num(s.avg, 1)}</b><span>kWh a day</span></div><div><b>${num(s.weekdayAvg, 1)} / ${num(s.weekendAvg, 1)}</b><span>weekday / weekend</span></div><div><b>${s.cost != null ? money(s.cost) : '—'}</b><span>${s.costSource ? esc(s.costSource) : 'cost needs a confirmed rate'}</span></div><div><b>${s.peakHour != null ? hourLabel(s.peakHour) : '—'}</b><span>busiest hour</span></div></div>
    <h4>Daily use, ${esc(dayLabel(s.from))} – ${esc(dayLabel(s.to))}</h4><p class="fine">Lighter bars are weekends.</p>${daily}${prof}`;
}

function temperatureBody() {
  const m = C.energyWeatherModel(S.usage, allTemps());
  if (!m.n) return '<p class="fine">No days yet with both your electricity data and observed weather. They’re matched automatically as soon as both exist.</p>';
  const pts = m.days.map((d) => ({ x: d.temp, y: d.kwh, tip: `${dayLabel(d.date)}: ${num(d.kwh, 1)} kWh at ${num(d.temp)}°F average` }));
  const curve = [];
  if (m.status === 'ready') {
    const lo = Math.floor(Math.min(...pts.map((p) => p.x))), hi = Math.ceil(Math.max(...pts.map((p) => p.x)));
    for (let t = lo; t <= hi; t++) curve.push({ x: t, y: Math.max(0, m.predict(C.degreeDays(t))) });
  }
  const term = (t, what) => (t ? `<div><b>${signed(t.per, 2)}</b><span>kWh per °F-day ${what} (±${num(t.ci, 2)})</span></div>` : '');
  const summary = m.status === 'ready'
    ? `<div class="stats"><div><b>${num(m.base.per, 1)}</b><span>kWh a day at 65°F (±${num(m.base.ci, 1)})</span></div>${term(m.heat, 'below 65°F')}${term(m.cool, 'above 65°F')}<div><b>${num(Math.max(0, m.r2) * 100)}%</b><span>of daily variation explained by weather</span></div></div><p class="fine">From ${m.n} days. ± values are 95% ranges; a range that includes zero means no reliable effect yet.</p>`
    : `<p class="note">Still learning: ${m.n} of ${m.need} days. The pattern line appears after that.</p>`;
  return `${summary}${scatterChart(pts, curve)}<div class="table-wrap"><table><thead><tr><th>Outdoor average</th><th class="t">Days</th><th class="t">kWh a day</th></tr></thead><tbody>${m.bins.map((b) => `<tr><td>${b.lo}–${b.lo + 9}°F</td><td class="t">${b.n}</td><td class="t">${num(b.avg, 1)}</td></tr>`).join('')}</tbody></table></div>`;
}

function savingsBody() {
  const p = S.profile;
  const r = C.evaluateSavings({ usage: S.usage, temps: allTemps(), changeDate: p.changeDate, tariff: p.tariff });
  const res = ['likely_savings', 'likely_increase', 'inconclusive'].includes(r.status)
    ? `<div class="stats"><div><b>${signed(-r.diff, 0)} kWh</b><span>vs. what the weather predicts (±${num(r.unc, 0)})</span></div><div><b>${signed(-r.pct, 1)}%</b><span>change</span></div><div><b>${num(r.actual, 0)}</b><span>actual kWh, ${r.after} days</span></div><div><b>${num(r.predicted, 0)}</b><span>expected kWh</span></div></div>
      ${r.dollars != null ? `<p class="stat-line">≈ ${money(r.dollars)} ± ${money(r.dollarsUnc)} in energy charges at your confirmed rate.</p>` : '<p class="fine">Dollar figures appear only with a rate you confirmed from your bill (Settings → Advanced).</p>'}
      <ul class="bullets">${r.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul><p class="fine">Model: daily kWh = base + heating + cooling °F-days, fitted on ${r.before} days before the change (R² ${num(r.model.r2, 2)}).</p>`
    : `<p class="note">${esc(r.message)}</p>`;
  return `<label class="field">Schedule change date<input type="date" data-k="profile.changeDate" data-rerender value="${esc(p.changeDate)}"></label><p class="fine">Set automatically when you finish guided programming.</p>${res}`;
}

function viewInsights() {
  const days = usageDays();
  const last = days.length ? days[days.length - 1].date : null;
  const out = [title('Insights', last ? `Electricity data through ${esc(dayLabel(last))}` : 'Electricity, weather and savings')];
  if (!days.length) {
    out.push(`<section class="empty"><h2>See what’s actually working</h2><p>Import your Delmarva usage file. It’s analyzed on this phone and matched with Wilmington weather automatically — nothing else to do.</p>${importButton()}${busy === 'import' ? '<p class="fine">Reading…</p>' : ''}</section>`);
    out.push(disclosure('howto', 'How to download your file from Delmarva', HOW_TO_DOWNLOAD, true));
  } else {
    const f = A.buildInsights({ state: S, temps: allTemps() });
    out.push(`<ul class="findings">${f.map((x) => `<li class="${x.tone}"><b>${esc(x.title)}</b><span>${esc(x.detail)}</span></li>`).join('')}</ul>`);
    if (S.profile.hvacMetered === 'unknown') out.push('<p class="fine">Heating and cooling may not be on your apartment’s meter. If they aren’t, thermostat changes can save building energy without changing your bill.</p>');
    out.push(disclosure('use', 'Electricity use', electricityBody()));
    out.push(disclosure('temp', 'Electricity and outdoor temperature', temperatureBody()));
  }
  out.push(disclosure('ops', 'Weather intelligence', opsBody()));
  out.push(disclosure('weather', 'Weather history and forecast', weatherBody()));
  if (days.length) {
    out.push(disclosure('savings', 'Savings details', savingsBody()));
    out.push(`<div class="import-row"><p class="fine">Newer data? Import the latest file anytime; duplicates are merged.</p>${importButton('Import newer file')}</div>`);
  }
  return out.join('');
}

// ---------- Settings ----------

const stepper = (k, label) => `<div class="item"><span>${label}</span><div class="stepper"><button data-act="step" data-k="${k}" data-d="-1" aria-label="Lower ${esc(label)}">−</button><b>${getPath(S, k)}°</b><button data-act="step" data-k="${k}" data-d="1" aria-label="Raise ${esc(label)}">+</button></div></div>`;
const timeItem = (k, label) => `<label class="item"><span>${label}</span><input type="time" data-k="${k}" data-rerender value="${esc(getPath(S, k))}" step="900"></label>`;
const selItem = (k, label, opts) => `<label class="item"><span>${label}</span><select data-k="${k}" data-rerender>${opts.map(([v, l]) => `<option value="${v}" ${getPath(S, k) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
const numItem = (k, label, attrs) => `<label class="item"><span>${label}</span><input type="number" data-k="${k}" data-rerender value="${esc(getPath(S, k) ?? '')}" inputmode="decimal" ${attrs}></label>`;
const group = (head, body, foot = '') => `<h2 class="group-title">${head}</h2><div class="group">${body}</div>${foot ? `<p class="group-foot">${foot}</p>` : ''}`;

function viewSettings() {
  const p = S.profile;
  const modes = C.BUILDING_MODES[p.buildingMode] ?? [];
  const days = usageDays();
  const obs = [...S.observations].sort((a, b) => b.ts - a.ts).slice(0, 8);
  const advanced = `
    ${group('Equipment', `${selItem('profile.hvacType', 'Heating/cooling type', [['unknown', 'Not sure'], ['heat_pump', 'Heat pump'], ['electric_resistance', 'Electric resistance'], ['fan_coil', 'Fan coil (building water)'], ['gas_or_boiler', 'Gas furnace / boiler'], ['other', 'Other']])}${selItem('profile.hvacMetered', 'On our electric meter?', [['unknown', 'Not sure'], ['yes', 'Yes'], ['partial', 'Partly (fan only)'], ['no', 'No — building pays']])}`, 'Unknown equipment keeps heating setbacks to 2°F, as Delmarva’s manual advises for heat pumps.')}
    ${group('Away and sleep temperatures', `${stepper('profile.comfort.heat.away', 'Heat when away')}${stepper('profile.comfort.heat.sleep', 'Heat while asleep')}${stepper('profile.comfort.cool.away', 'Cooling when away')}${stepper('profile.comfort.cool.sleep', 'Cooling while asleep')}${numItem('profile.recoveryMin', 'Warm-up lead (min)', 'min="0" max="120" step="15"')}${numItem('profile.comfort.min', 'Never below °F', 'min="50" max="75"')}${numItem('profile.comfort.max', 'Never above °F', 'min="70" max="90"')}`, 'If you turn on the thermostat’s own Energy Mgmt Recovery, set the warm-up lead to 0.')}
    ${group('Electric rate', `${numItem('profile.tariff.centsPerKwh', 'Energy charge ¢/kWh', 'min="0" max="100" step="0.01"')}<label class="item"><span>Confirmed on my bill</span><input type="checkbox" data-k="profile.tariff.confirmed" data-rerender ${p.tariff.confirmed ? 'checked' : ''}></label>`, 'Dollar figures stay hidden until a rate is confirmed. No rate is ever assumed.')}
    ${group('Thermostat notes', `<div class="item col"><p class="fine">Optional: jot down what the display shows. These are notes, never treated as the live state of the thermostat.</p><div class="fields"><label>Room °F<input type="number" id="o-room" inputmode="numeric" min="40" max="100"></label><label>Setpoint °F<input type="number" id="o-set" inputmode="numeric" min="40" max="100"></label><label>Display<select id="o-hold"><option value="none">SET AT</option><option value="hold">HOLD AT</option></select></label><label>Note<input type="text" id="o-note" maxlength="120"></label></div><button class="btn secondary" data-act="add-obs">Save note</button></div>${obs.map((o) => `<div class="item"><span>${num(o.roomF)}° room · ${o.hold !== 'none' ? 'HOLD AT' : 'SET AT'} ${num(o.setF)}°<small>${esc(new Date(o.ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}${o.note ? ` · ${esc(o.note)}` : ''}</small></span><button class="btn plain" data-act="del-obs" data-ts="${o.ts}" aria-label="Delete note">Delete</button></div>`).join('')}`)}
    ${group('Thermostat control', `<div class="item col"><p>Not available. This app only recommends; it never sends anything to the thermostat. A verified, authorized connection would be a separate future project needing your approval.</p><details class="inline"><summary>Ask Delmarva about remote programming</summary><p class="fine">Use the <a href="${SUPPORT_URL}" target="_blank" rel="noopener noreferrer">contact form</a> or call 866-353-5799:</p><pre class="msg">${esc(SUPPORT_MSG)}</pre><button class="btn secondary" data-act="copy-support">Copy message</button></details><p class="fine">Programming steps follow Delmarva’s <a href="${MANUAL_URL}" target="_blank" rel="noopener noreferrer">thermostat manual</a>.</p></div>`)}
    ${group('Privacy', '<div class="item col"><p class="fine">Your settings, notes and electricity data stay in this app on this device. The public website only serves the app and city-level weather. Forecasts come from the National Weather Service; older daily temperatures may come from Open-Meteo, which receives only the city location and dates.</p></div>')}
    <button class="btn danger" data-act="erase">Erase everything on this device</button>`;
  return `${title('Settings')}
    ${group('Apartment', `<div class="item col"><span>What the building provides right now</span>${seasonPicker('')}</div><a class="item link" href="#setup">Redo quick setup</a>`)}
    ${group('Comfort at home', `${modes.includes('heat') || p.buildingMode === 'unknown' ? stepper('profile.comfort.heat.home', 'Heat to') : ''}${modes.includes('cool') || p.buildingMode === 'unknown' ? stepper('profile.comfort.cool.home', 'Cool to') : ''}${p.buildingMode === 'fan_only' ? '<div class="item"><span>No heating or cooling to set</span></div>' : ''}`, 'Away and sleep temperatures move with these automatically.')}
    ${group('Weekdays', `${timeItem('profile.routine.weekday.wake', 'Wake up')}${timeItem('profile.routine.weekday.leave', 'Leave home')}${timeItem('profile.routine.weekday.back', 'Back home')}${timeItem('profile.routine.weekday.sleep', 'Bedtime')}`, 'Clear Leave/Back if someone is home all day.')}
    ${group('Weekends', `${timeItem('profile.routine.weekend.wake', 'Wake up')}${timeItem('profile.routine.weekend.leave', 'Leave home')}${timeItem('profile.routine.weekend.back', 'Back home')}${timeItem('profile.routine.weekend.sleep', 'Bedtime')}`)}
    ${group('Electricity data', `<div class="item"><span>Latest data</span><span class="value">${days.length ? `${esc(dayLabel(days[days.length - 1].date))} · ${days.length} days` : 'None yet'}</span></div><div class="item col">${importButton()}${busy === 'import' ? '<p class="fine">Reading…</p>' : ''}<details class="inline"><summary>How to download it from Delmarva</summary>${HOW_TO_DOWNLOAD}</details></div>${days.length ? '<button class="item link danger" data-act="clear-usage">Delete electricity data</button>' : ''}`)}
    ${group('Backup', `<div class="item col"><p class="fine">Everything lives only in this app on this phone. A backup file lets you restore it later or move it to a new phone. Save one to Files now and then.</p><div class="row2"><button class="btn primary" data-act="export">Save backup</button><label class="btn secondary file">Restore backup<input type="file" id="backup-file" accept=".json,application/json"></label></div></div>`)}
    ${disclosure('advanced', 'Advanced', advanced)}
    ${IOS && !STANDALONE ? '<p class="fine center">Install: tap Share → Add to Home Screen. The installed app keeps its own data, separate from Safari.</p>' : ''}`;
}

const SUPPORT_MSG = 'I have a Delmarva Power Energy Wise Rewards web-programmable Emerson thermostat, likely an IntelliTEMP IT900. In My Account, Program Your Thermostat -> View Thermostat fails with: "The remote name could not be resolved: apigateway-east.exeloncorp.com". Is remote programming for legacy thermostats currently supported, planned to be restored, or discontinued? Is there an official replacement portal or authorized integration/API? Can you identify the hardware revision and the purpose of the small modular-style jack on the side? I want to keep the existing thermostat working safely and avoid modifying the utility equipment. Please respond by email if possible.';

// ---------- guided setup ----------

const SETUP_STEPS = 5;
function startSetup() {
  const p = S.profile;
  draft = { buildingMode: p.buildingMode, wd: { ...p.routine.weekday }, we: { ...p.routine.weekend }, wdAway: !!(p.routine.weekday.leave && p.routine.weekday.back), weHome: !(p.routine.weekend.leave && p.routine.weekend.back), heat: p.comfort.heat.home, cool: p.comfort.cool.home };
  if (!draft.wd.leave) Object.assign(draft.wd, { leave: '08:00', back: '17:30' });
  if (!draft.we.leave) Object.assign(draft.we, { leave: '10:00', back: '16:00' });
  setupStep = 0;
}
const choice = (act, v, label, on, sub = '') => `<button class="choice" data-act="${act}" data-v="${v}" aria-pressed="${on}"><b>${label}</b>${sub ? `<span>${sub}</span>` : ''}</button>`;
const tinput = (id, label, v) => `<label class="field">${label}<input type="time" id="${id}" value="${esc(v)}" step="900"></label>`;

function viewSetup() {
  if (!draft) startSetup();
  const d = draft;
  const steps = [
    () => `<h1>What does your building provide right now?</h1><p class="lead">Central systems switch between heating and cooling by season. Not sure? The app shows both.</p>${choice('setup-season', 'heat_available', 'Heat', d.buildingMode === 'heat_available', 'Heating season')}${choice('setup-season', 'cool_available', 'Cooling', d.buildingMode === 'cool_available', 'Air conditioning season')}${choice('setup-season', 'fan_only', 'Fan only', d.buildingMode === 'fan_only', 'Between seasons')}${choice('setup-season', 'unknown', 'Not sure', d.buildingMode === 'unknown')}`,
    () => `<h1>Your weekdays</h1><p class="lead">So the apartment is comfortable when you’re up and home, and eases off otherwise.</p><div class="fields">${tinput('s-wd-wake', 'Wake up', d.wd.wake)}${tinput('s-wd-sleep', 'Bedtime', d.wd.sleep)}</div><p class="q">Is the apartment usually empty during the day?</p><div class="row2">${choice('setup-wdaway', '1', 'Yes', d.wdAway)}${choice('setup-wdaway', '0', 'No, someone’s home', !d.wdAway)}</div>${d.wdAway ? `<div class="fields">${tinput('s-wd-leave', 'Leave', d.wd.leave)}${tinput('s-wd-back', 'Back', d.wd.back)}</div>` : ''}`,
    () => `<h1>Your weekends</h1><div class="fields">${tinput('s-we-wake', 'Wake up', d.we.wake)}${tinput('s-we-sleep', 'Bedtime', d.we.sleep)}</div><p class="q">Is someone usually home all day?</p><div class="row2">${choice('setup-wehome', '1', 'Yes', d.weHome)}${choice('setup-wehome', '0', 'No, we go out', !d.weHome)}</div>${d.weHome ? '' : `<div class="fields">${tinput('s-we-leave', 'Leave', d.we.leave)}${tinput('s-we-back', 'Back', d.we.back)}</div>`}`,
    () => {
      const heat = d.buildingMode === 'heat_available' || d.buildingMode === 'unknown', cool = d.buildingMode === 'cool_available' || d.buildingMode === 'unknown';
      const st = (k, label) => `<div class="big-stepper"><span>${label}</span><div class="stepper"><button data-act="setup-temp" data-k="${k}" data-d="-1" aria-label="Lower">−</button><b>${d[k]}°</b><button data-act="setup-temp" data-k="${k}" data-d="1" aria-label="Raise">+</button></div></div>`;
      return `<h1>Comfortable temperature at home</h1><p class="lead">The app eases off a little while you’re away or asleep — small changes you won’t notice that save energy.</p>${heat ? st('heat', 'Heating') : ''}${cool ? st('cool', 'Cooling') : ''}${!heat && !cool ? '<p class="note">No heating or cooling right now, so nothing to set. You can change the season anytime in Settings.</p>' : ''}`;
    },
    () => `<h1>All set</h1><p class="lead">Today will show what to set right now, and walk you through programming the thermostat’s weekly schedule once.</p><ul class="bullets"><li>Weather is collected and matched automatically.</li><li>Import your Delmarva file anytime to see what’s working.</li><li>Everything stays on this phone.</li></ul>`,
  ];
  const last = setupStep === SETUP_STEPS - 1;
  return `<div class="flow"><div class="flow-top"><a class="btn plain" href="#today" data-act="setup-cancel">Cancel</a><progress max="${SETUP_STEPS}" value="${setupStep + 1}" aria-label="Step ${setupStep + 1} of ${SETUP_STEPS}"></progress></div>
    <div class="flow-body">${steps[setupStep]()}</div>
    <div class="flow-bar">${setupStep ? '<button class="btn secondary" data-act="setup-back">Back</button>' : '<span></span>'}<button class="btn primary" data-act="${last ? 'setup-done' : 'setup-next'}">${last ? 'Show my recommendation' : 'Next'}</button></div></div>`;
}

function readSetupInputs() {
  const v = (id) => $(`#${id}`)?.value;
  const d = draft;
  if (setupStep === 1) { d.wd.wake = v('s-wd-wake') || d.wd.wake; d.wd.sleep = v('s-wd-sleep') || d.wd.sleep; if (d.wdAway) { d.wd.leave = v('s-wd-leave') || d.wd.leave; d.wd.back = v('s-wd-back') || d.wd.back; } }
  if (setupStep === 2) { d.we.wake = v('s-we-wake') || d.we.wake; d.we.sleep = v('s-we-sleep') || d.we.sleep; if (!d.weHome) { d.we.leave = v('s-we-leave') || d.we.leave; d.we.back = v('s-we-back') || d.we.back; } }
}

function finishSetup() {
  const d = draft, p = S.profile, c = p.comfort;
  p.buildingMode = d.buildingMode;
  p.routine.weekday = { wake: d.wd.wake, sleep: d.wd.sleep, leave: d.wdAway ? d.wd.leave : '', back: d.wdAway ? d.wd.back : '' };
  p.routine.weekend = { wake: d.we.wake, sleep: d.we.sleep, leave: d.weHome ? '' : d.we.leave, back: d.weHome ? '' : d.we.back };
  // Away/sleep keep their offsets from home (conservative defaults; heat-pump guard still applies).
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
  if (s.kind === 'intro') body = `<h1>Program your weekly schedule</h1><p class="lead">Stand at the thermostat. You’ll enter a start time and a temperature for four periods — once for weekdays, once for weekends${rec.plans.length > 1 ? ', for heating and then cooling' : ''}.</p><ul class="bullets"><li>▲/▼ change the highlighted value.</li><li>► moves to the next value.</li><li>If you get lost, press HOME and start again — nothing is saved until DONE.</li><li>The menu closes by itself after 2 minutes without a press.</li></ul>`;
  else if (s.kind === 'period') body = `<p class="eyebrow">${esc(s.group)} · ${s.mode === 'heat' ? 'Heating' : 'Cooling'}</p><h1>${esc(s.name)}</h1><div class="pair"><div><span>Starts at</span><b>${esc(s.time)}</b></div><div><span>${words[s.mode]}</span><b>${s.temp}°</b></div></div><ol class="steps"><li>Set <b>${esc(s.name)} Starts At</b> to <b>${esc(s.time)}</b> with ▲/▼, then press ►.</li><li>Set <b>${words[s.mode]}</b> to <b>${s.temp}°</b> with ▲/▼, then press ►.</li></ol>${s.away ? '<p class="fine">This is the “away” period — the main saving.</p>' : ''}`;
  else if (s.kind === 'check') body = `<h1>Check the screen</h1><p class="lead">The home screen should say <b>SET AT</b> (not HOLD AT) and show today’s temperature.</p><p class="fine">From now on the thermostat follows this schedule by itself. Today will tell you if anything ever needs changing.</p>`;
  else body = `<h1>${esc(s.title)}</h1><ol class="steps">${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>`;
  const last = progStep === steps.length - 1;
  return `<div class="flow"><div class="flow-top"><a class="btn plain" href="#today">Close</a><progress max="${steps.length}" value="${progStep + 1}" aria-label="Step ${progStep + 1} of ${steps.length}"></progress></div>
    <div class="flow-body">${body}</div>
    <div class="flow-bar">${progStep ? '<button class="btn secondary" data-act="prog-back">Back</button>' : '<span></span>'}<button class="btn primary" data-act="${last ? 'programmed' : 'prog-next'}">${last ? 'Done — it’s programmed' : progStep ? 'Next' : 'I’m at the thermostat'}</button></div></div>`;
}

// ---------- rendering ----------

const ROUTES = { today: viewToday, insights: viewInsights, settings: viewSettings, setup: viewSetup, program: viewProgram };
const route = () => { const h = location.hash.slice(1); return ROUTES[h] ? h : 'today'; };

function render() {
  const r = route();
  const flow = r === 'setup' || r === 'program';
  document.body.classList.toggle('in-flow', flow);
  document.querySelectorAll('[data-tab]').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === r ? 'page' : 'false'));
  $('#view').innerHTML = ROUTES[r]();
  document.title = `${flow ? (r === 'setup' ? 'Setup' : 'Program schedule') : TABS.find(([k]) => k === r)[1]} · Energy`;
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

/** Public weather history published next to the app by the hourly cloud collector (works offline once cached). */
async function loadWeather() {
  const get = async (f) => { try { const r = await fetch(`data/weather/${f}`, { cache: 'no-cache' }); return r.ok ? await r.json() : null; } catch { return null; } };
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
    weatherErr = '';
  } catch (e) {
    weatherErr = e.message;
    if (S.weatherCache) S.weatherCache.hourlyUrl = null; // re-resolve next time
    const fetched = WD.latest ? Date.parse(WD.latest.fetchedAt) : 0;
    if (fetched && (!S.weatherCache || fetched > S.weatherCache.fetchedAt)) S.weatherCache = { fetchedAt: fetched, hourlyUrl: null, hours: WD.latest.hours.map((h) => ({ t: Date.parse(h.k), tempF: h.t, text: h.text, pop: h.pop })) };
  }
  save();
}

/** Daily temperatures for usage dates the station history doesn't cover (e.g. older than its start) — automatic, once per session. */
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
  render();
  fillArchive();
}

// ---------- actions ----------

const readFile = (f) => (f.size > 25e6 ? Promise.reject(new Error('File is larger than 25 MB.')) : f.text());

const ACTIONS = {
  print: () => window.print(),
  season(el) { S.profile.buildingMode = el.dataset.v; save(); render(); toast(`Season set: ${SEASONS.find(([v]) => v === el.dataset.v)[1]}.`); },
  'dismiss-season'() { UI.seasonDismissed = Date.now(); saveUI(); render(); },
  step(el) {
    const k = el.dataset.k, d = Number(el.dataset.d);
    const m = /comfort\.(heat|cool)\.home$/.exec(k);
    if (m) { const c = S.profile.comfort[m[1]]; c.home += d; c.away += d; c.sleep += d; } // keep away/sleep offsets
    else setPath(S, k, getPath(S, k) + d);
    save(); render();
  },
  'setup-season'(el) { draft.buildingMode = el.dataset.v; setupStep++; render(); },
  'setup-wdaway'(el) { readSetupInputs(); draft.wdAway = el.dataset.v === '1'; render(); },
  'setup-wehome'(el) { readSetupInputs(); draft.weHome = el.dataset.v === '1'; render(); },
  'setup-temp'(el) { draft[el.dataset.k] += Number(el.dataset.d); render(); },
  'setup-next'() { readSetupInputs(); setupStep = Math.min(SETUP_STEPS - 1, setupStep + 1); render(); window.scrollTo(0, 0); },
  'setup-back'() { readSetupInputs(); setupStep = Math.max(0, setupStep - 1); render(); },
  'setup-cancel'() { draft = null; },
  'setup-done'() { finishSetup(); },
  'prog-next'() { progStep++; render(); window.scrollTo(0, 0); },
  'prog-back'() { progStep = Math.max(0, progStep - 1); render(); },
  programmed() {
    const rec = recNow();
    S.programmed = { fingerprint: A.planFingerprint(rec.plans), date: todayIso() };
    const first = !S.profile.changeDate;
    if (first) S.profile.changeDate = todayIso();
    save();
    location.hash = 'today';
    toast(first ? 'Saved. Savings tracking starts today.' : 'Saved. Your schedule is up to date.');
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
    save(); render();
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
  const open = e.target.closest('[data-open]');
  if (open) { UI.open = { ...UI.open, [open.dataset.open]: true }; saveUI(); }
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

async function importUsage(f) {
  busy = 'import';
  render();
  try {
    const res = C.importUsageFile(f.name, await readFile(f));
    const before = new Set(usageDays().map((d) => d.date));
    S.usage = C.mergeUsage(S.usage, res.records);
    save();
    const days = usageDays();
    const temps = allTemps();
    const matched = days.filter((d) => Number.isFinite(temps[d.date])).length;
    const added = days.filter((d) => !before.has(d.date)).length;
    toast(`Imported through ${dayLabel(days[days.length - 1].date)}: ${added} new day${added === 1 ? '' : 's'}${res.skipped ? `, ${res.skipped} unreadable rows skipped` : ''}. ${matched} days matched with weather. Insights updated.`);
    archiveTried = false;
    fillArchive();
  } catch (err) {
    toast(`Couldn’t import that file: ${err.message}`, true);
  }
  busy = '';
  render();
}

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.id === 'usage-file' && el.files[0]) return importUsage(el.files[0]);
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
  const k = el.dataset.k;
  if (!k) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.type === 'number') {
    v = el.value === '' ? null : Number(el.value);
    if (v != null && !Number.isFinite(v)) return;
    if (v == null && !k.endsWith('centsPerKwh')) return toast('This value is required.', true);
  }
  setPath(S, k, v);
  save();
  if ('rerender' in el.dataset && el.type !== 'time' && el.type !== 'number') render();
});

$('#nav').innerHTML = TABS.map(([k, l]) => `<a href="#${k}" data-tab="${k}"><svg viewBox="0 0 24 24" aria-hidden="true" class="ic">${ICON[k]}</svg><span>${l}</span></a>`).join('');
window.addEventListener('hashchange', () => {
  const r = route();
  if (r === 'setup' && !draft) startSetup();
  if (r === 'program') progStep = 0; // guided programming always starts from the first screen
  render();
  window.scrollTo(0, 0);
});
const visible = () => document.visibilityState === 'visible';
document.addEventListener('visibilitychange', () => { if (visible() && Date.now() - lastRefresh > 10 * 60e3) refreshAll(); });
setInterval(() => { if (visible()) refreshAll(); }, 30 * 60e3); // pick up new forecasts and observations while open; nothing while hidden
render();
refreshAll();
try { navigator.storage?.persist?.(); } catch { /* optional */ }
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
