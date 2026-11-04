// UI layer. All data lives in this browser's localStorage; the only network calls are to
// api.weather.gov (forecast) and archive-api.open-meteo.com (past temperatures) for a city-level point.
import * as C from './core.js';
import { CAPABILITIES, controlStatus } from './thermostat.js';

const KEY = 'aeo.state.v1';
const LOC = { lat: 39.7447, lon: -75.5484, name: 'Wilmington, DE' }; // city centre, not your address
const MANUAL_URL = 'https://energywiserewards.delmarva.com/wp-content/uploads/2020/11/20_DDWMAN2026_IT900-400_USER_MANUAL-CFO-073120-crp.pdf';
const SUPPORT_URL = 'https://energywiserewards.delmarva.com/de/contact/';
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STANDALONE = navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n, d = 0) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const money = (n) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
const dayLabel = (iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', opts);
const hourLabel = (h) => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;
const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const todayIso = () => C.localParts(Date.now()).date;

let S = load();
let view = location.hash.slice(1) || 'home';
let weatherErr = '', histErr = '', busy = '';

function load() {
  try { return C.mergeState(JSON.parse(localStorage.getItem(KEY))); } catch { return C.defaultState(); }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { toast('Could not save in this browser. Export a backup from Settings.', true); }
}
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => { t.className = 'toast'; }, 3800);
}
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
function setPath(o, p, v) {
  const ks = p.split('.');
  const last = ks.pop();
  ks.reduce((a, k) => a[k], o)[last] = v;
}

// ---------- icons & charts ----------

const ICON = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/><path d="M10 20v-5h4v5"/>',
  schedule: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  energy: '<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/>',
  savings: '<path d="m3.5 16.5 5.5-5.5 4 4 7.5-7.5"/><path d="M15 7.5h5.5V13"/>',
  device: '<rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M8 12h4M16 10v4M14 12h4"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true" class="ic">${ICON[k]}</svg>`;
const TABS = [['home', 'Home'], ['schedule', 'Schedule'], ['energy', 'Energy'], ['savings', 'Savings'], ['device', 'Thermostat'], ['settings', 'Settings']];

function lineChart(pts, label) {
  if (pts.length < 2) return '';
  const w = 600, h = 160, px = 16, top = 34, bot = 28;
  const ys = pts.map((p) => p.y);
  const lo = Math.min(...ys) - 1, hi = Math.max(...ys) + 1;
  const X = (i) => px + (i * (w - 2 * px)) / (pts.length - 1);
  const Y = (v) => top + ((hi - v) / (hi - lo)) * (h - top - bot);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const area = `${d}L${X(pts.length - 1).toFixed(1)},${h - bot}L${X(0)},${h - bot}Z`;
  const iMax = ys.indexOf(Math.max(...ys)), iMin = ys.indexOf(Math.min(...ys));
  const mark = (i, below) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(ys[i]).toFixed(1)}" r="5"/><text class="v" x="${Math.min(w - 20, Math.max(20, X(i))).toFixed(1)}" y="${(Y(ys[i]) + (below ? 26 : -12)).toFixed(1)}" text-anchor="middle">${Math.round(ys[i])}°</text>`;
  const ticks = pts.map((p, i) => (p.tick ? `<text x="${X(i).toFixed(1)}" y="${h - 4}" text-anchor="middle">${esc(p.tick)}</text>` : '')).join('');
  const slot = (w - 2 * px) / (pts.length - 1);
  const hits = pts.map((p, i) => `<rect x="${(X(i) - slot / 2).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${h}" opacity="0" data-tip="${esc(p.tip)}"/>`).join('');
  return `<svg class="chart line" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}"><path class="area" d="${area}"/><path class="stroke" d="${d}"/>${mark(iMax, false)}${iMin !== iMax ? mark(iMin, Y(ys[iMin]) < h - bot - 30) : ''}${ticks}${hits}</svg><div class="readout" aria-live="polite">Tap the chart for hourly details.</div>`;
}

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
  return `<svg class="chart bars" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}"><line class="grid" x1="0" x2="${w}" y1="${h - bot}" y2="${h - bot}"/>${bars}${tk}</svg><div class="readout" aria-live="polite">Tap a bar for details.</div>`;
}

// ---------- views ----------

const hdr = (title, sub, extra = '') => `<header class="head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${extra}</header>`;
const alerts = (list, cls = '') => list.map((w) => `<div class="alert ${cls}">${esc(w)}</div>`).join('');
const modePill = (m) => `<span class="pill ${m}"><span class="dot"></span>${m === 'heat' ? 'Heat' : 'Cool'}</span>`;
const levelPill = (lv, kind) => `<span class="pill ${lv === 'high' ? 'bad' : lv === 'moderate' ? 'warn' : 'good'}">${kind}: ${lv}</span>`;

function heroCard(rec) {
  if (!rec.plans.length) {
    const why = rec.errors.length ? rec.errors[0] : S.profile.buildingMode === 'fan_only' ? 'The building is in fan-only mode, so there is no heating or cooling setpoint to optimize.' : 'No schedule available.';
    return `<section class="card hero idle span"><div class="label">Recommended now</div><div class="big">—</div><p>${esc(why)}</p></section>`;
  }
  const cur = rec.current;
  const cls = cur.length === 1 ? cur[0].mode : '';
  const blocks = cur.map((c) => `<div><div class="label">${c.mode === 'heat' ? 'Heat to' : 'Cool to'} · ${c.period}</div><div class="big">${c.temp}<sup>°F</sup></div><p class="small">Next: ${c.next.name} at ${C.fmtMin(c.next.start)} → ${c.next.temp}°F</p></div>`).join('');
  return `<section class="card hero ${cls} span"><span class="pill">Recommended setting · not a live reading</span><div class="dual">${blocks}</div><div class="row no-print"><a class="btn" href="#schedule">See full schedule</a></div></section>`;
}

function readingCard() {
  const o = C.latestObservation(S.observations);
  if (!o) return `<section class="card"><h2>Thermostat</h2><p class="muted">No reading logged. The app can't read your thermostat — jot down what the display shows.</p><a class="btn primary" href="#device">Log a reading</a></section>`;
  return `<section class="card"><div class="row between"><h2>Last reading</h2><span class="pill">Manual · ${esc(ago(o.ts))}</span></div>
  <div class="stats"><div class="stat"><b>${num(o.roomF)}°</b><span>Room (you typed)</span></div><div class="stat"><b>${num(o.setF)}°</b><span>Setpoint${o.hold !== 'none' ? ' · HOLD' : ''}</span></div></div>
  <p class="small muted">Mode ${esc((o.mode || 'unknown').toUpperCase())} · Fan ${esc((o.fan || 'unknown').toUpperCase())}</p><a class="btn" href="#device">Log new reading</a></section>`;
}

function weatherCard(rec) {
  const wc = S.weatherCache;
  const hours = (wc?.hours || []).filter((h) => h.t >= Date.now() - 3600e3).slice(0, 24);
  const stale = wc && Date.now() - wc.fetchedAt > 3 * 3600e3;
  const status = busy === 'weather' ? '<span class="pill">Updating…</span>' : weatherErr ? `<span class="pill ${wc ? 'warn' : 'bad'}">${wc ? 'Offline · cached' : 'Unavailable'}</span>` : wc ? `<span class="pill ${stale ? 'warn' : 'good'}">NWS · ${esc(ago(wc.fetchedAt))}</span>` : '';
  const now = hours[0];
  const chart = hours.length > 1 ? lineChart(hours.map((h, i) => {
    const lp = C.localParts(h.t);
    return { y: h.tempF, tick: i % 4 === 0 ? hourLabel(lp.hour) : '', tip: `${hourLabel(lp.hour)}: ${Math.round(h.tempF)}°F, ${h.text}${h.pop != null ? `, ${h.pop}% chance of precipitation` : ''}` };
  }), 'Outdoor temperature, next 24 hours') : '';
  const days = rec.outlook.slice(0, 7).map((d) => `<div class="day"><div class="muted">${esc(dayLabel(d.date, { weekday: 'short', day: 'numeric' }))}</div><div><b>${Math.round(d.high)}°</b> <span class="muted">${Math.round(d.low)}°</span></div><div class="small muted">${esc(d.text || '')}</div>${rec.modes.includes('cool') ? levelPill(d.cooling, 'Cooling') : ''}${rec.modes.includes('heat') ? levelPill(d.heating, 'Heating') : ''}</div>`).join('');
  return `<section class="card span"><div class="row between"><h2>${esc(LOC.name)} weather</h2><div class="row">${status}<button class="btn no-print" data-act="weather">Refresh</button></div></div>
  ${now ? `<div class="now"><b>${Math.round(now.tempF)}°F</b><span class="muted">${esc(now.text)}</span></div>` : ''}
  ${weatherErr ? `<div class="alert ${wc ? 'info' : 'bad'}">${esc(weatherErr)}${wc ? ' Showing the last forecast you downloaded.' : ' Recommendations still work without weather.'}</div>` : ''}
  ${chart}${days ? `<div class="days">${days}</div>` : ''}
  <p class="small muted">Demand = heating/cooling degree-days (base 65°F) from the National Weather Service hourly forecast.</p></section>`;
}

function usageSnapshot() {
  const s = C.usageSummary(S.usage, S.profile.tariff);
  if (!s) return `<section class="card"><h2>Electricity</h2><p class="muted">No usage imported yet. Download “Green Button” data from Delmarva My Account and import it — it stays on this device.</p><a class="btn primary" href="#energy">Import usage</a></section>`;
  return `<section class="card"><div class="row between"><h2>Electricity</h2><span class="pill">Last ${s.days} days</span></div><div class="stats"><div class="stat"><b>${num(s.avg, 1)}</b><span>kWh / day</span></div><div class="stat"><b>${s.cost != null ? money(s.cost) : num(s.total)}</b><span>${s.cost != null ? 'cost' : 'kWh total'}</span></div></div><a class="btn" href="#energy">Usage details</a></section>`;
}

const installCard = () => (IOS && !STANDALONE
  ? `<section class="card span install"><h2>Install on your iPhone</h2><ol class="steps"><li>In Safari, tap the <b>Share</b> button (square with an arrow).</li><li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open <b>Energy</b> from your Home Screen and use it from there — the installed app keeps its own data, separate from this Safari tab, and works offline.</li></ol></section>`
  : '');

const VIEWS = {
  home(rec) {
    const p = S.profile;
    const today = rec.outlook[0];
    const onboarding = p.setupDone ? '' : `<section class="card span"><h2>Welcome</h2><p>Tell the app about your building and routine so recommendations fit your apartment. Everything stays on this device.</p><a class="btn primary" href="#settings">Set up my apartment</a></section>`;
    return `${hdr('Home', `${esc(dayLabel(todayIso(), { weekday: 'long', month: 'long', day: 'numeric' }))} · Building: ${esc(C.BUILDING_LABEL[p.buildingMode])}`)}
    <div class="grid two">${installCard()}${onboarding}${heroCard(rec)}
    ${rec.warnings.length || rec.errors.length ? `<section class="card span stack">${alerts(rec.errors, 'bad')}${alerts(rec.warnings)}</section>` : ''}
    ${today?.tips.length ? `<section class="card span"><h2>Today’s tips</h2><ul class="tips">${today.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></section>` : ''}
    ${weatherCard(rec)}${readingCard()}${usageSnapshot()}</div>`;
  },

  schedule(rec) {
    if (!rec.plans.length) return `${hdr('Schedule', 'Four periods per day, ready to enter on the wall unit')}<div class="grid"><section class="card">${alerts(rec.errors.length ? rec.errors : ['No heating or cooling is available (fan-only mode), so there is nothing to schedule. Keep the fan on AUTO unless ventilation requires ON.'], rec.errors.length ? 'bad' : 'info')}<a class="btn" href="#settings">Review settings</a></section></div>`;
    const table = (day, title) => `<div><h3>${title}</h3><table><thead><tr><th>Period</th><th>Starts</th><th class="t">Set to</th></tr></thead><tbody>${day.map((pd) => `<tr><td>${pd.name}${pd.away ? '<span class="away-tag">away</span>' : ''}</td><td>${C.fmtMin(pd.start)}</td><td class="t">${pd.temp}°</td></tr>`).join('')}</tbody></table></div>`;
    const plans = rec.plans.map((pl) => `<section class="card span"><div class="row between"><h2>${pl.mode === 'heat' ? 'Heating' : 'Cooling'} schedule</h2>${modePill(pl.mode)}</div>
      <div class="sched">${table(pl.weekday, 'Weekdays (Mon–Fri)')}${table(pl.weekend, 'Weekend (Sat–Sun)')}</div>
      ${pl.notes.length ? `<div class="stack">${alerts(pl.notes, 'info')}</div>` : ''}</section>`).join('');
    return `${hdr('Schedule', 'Four periods per day, ready to enter on the wall unit', '<button class="btn no-print" data-act="print">Print</button>')}
    <div class="grid">${plans}
    <section class="card span"><h2>How to enter it on the thermostat</h2>
      <ol class="steps"><li>If the display shows <b>HOLD AT</b>, press <b>RUN</b> first — a hold overrides any schedule.</li>
      <li>Press <b>MENU</b>, highlight <b>Programming</b> with ▲/▼ and press the center (Action) button. Make sure <b>Time-based Programming</b> is <b>On</b>.</li>
      <li>Highlight <b>${rec.plans.map((pl) => (pl.mode === 'heat' ? 'Heating Schedule' : 'Cooling Schedule')).join('</b> (then <b>')}${rec.plans.length > 1 ? '</b>)' : '</b>'}, press Action, choose <b>Weekdays/Weekends</b> and press Action.</li>
      <li>For Mon–Fri: set <b>Morning Starts At</b> with ▲/▼, press ► to move to <b>Heat To / Cool To</b>, set it, press ► again. Repeat for Day, Evening and Night using the weekday table.</li>
      <li>Press <b>NEXT</b> for Sat–Sun and enter the weekend table the same way. Press <b>DONE</b> to save, then <b>HOME</b>. (HOME before DONE discards changes; the menu also gives up after 2 minutes without a key press.)</li>
      <li>Confirm the home screen shows <b>SET AT</b>, not HOLD AT. Then log a reading on the Thermostat tab and tap “I programmed it today” below.</li></ol>
      <p class="small muted">Steps follow Delmarva’s <a href="${MANUAL_URL}" target="_blank" rel="noopener noreferrer">Web-Programmable Thermostat Homeowner’s Manual</a> (DDWMAN2026, July 2020). Trust your screen if it differs.</p>
      <h3>Two free built-in settings worth checking (MENU → Thermostat Settings)</h3>
      <ul class="tips"><li><b>Energy Mgmt Recovery (EMR)</b>: when ON, the thermostat starts early on its own to reach each setpoint on time. If you turn it ON, set the lead time in Settings to 0 so the two don’t double up.</li>
      <li><b>Comfort / Economy</b> (shown only on multi-stage or heat-pump systems): <b>Economy</b> lets the thermostat hold off on higher stages and backup heat, which usually saves energy.</li></ul>
      <p class="small muted">Only use the normal homeowner buttons. Don’t open installer menus, remove the thermostat or plug anything into it. If a Delmarva conservation event is running, let it finish.</p>
      <div class="row no-print"><button class="btn primary" data-act="programmed">I programmed it today</button>${S.profile.changeDate ? `<span class="pill good">Change date ${esc(S.profile.changeDate)}</span>` : ''}</div></section>
    <section class="card span"><h2>Why these numbers</h2><ul class="tips">
      <li>Periods follow your routine; Morning and Evening start ${num(S.profile.recoveryMin)} min early so the room is comfortable when you need it.</li>
      <li>Away and Sleep use your comfort settings, kept within ${S.profile.comfort.min}–${S.profile.comfort.max}°F. Away never heats or cools more than Home.</li>
      <li>Only seasons the building actually provides are scheduled.</li>
      <li>Times are rounded to 15 minutes, Eastern time. The thermostat has its own Daylight Saving On/Off setting under MENU → Clock (the utility may also set the clock remotely); check the time after each change.</li></ul></section></div>`;
  },

  energy() {
    const s = C.usageSummary(S.usage, S.profile.tariff, 60);
    const imp = `<section class="card span"><h2>Import Delmarva usage</h2>
      <p class="small muted">In Delmarva My Account, look for <b>Green Button – Download my data</b> (CSV or XML), or use any CSV with Date and kWh columns. Files are read inside this browser and never uploaded. On iPhone, save the download to Files first, then choose it here.</p>
      <div class="row"><label class="btn primary file">Choose file<input type="file" id="usage-file" accept=".csv,.xml,text/csv,text/xml,application/xml"></label>${busy === 'import' ? '<span class="pill">Reading…</span>' : ''}</div>
      <details><summary>Add a day by hand</summary><div class="fields"><label>Date<input type="date" id="man-date" max="${todayIso()}"></label><label>kWh<input type="number" id="man-kwh" min="0" step="0.1" inputmode="decimal"></label></div><button class="btn" data-act="manual-usage">Add day</button></details></section>`;
    if (!s) return `${hdr('Energy', 'Your electricity, analyzed on this device')}<div class="grid">${imp}</div>`;
    const r = s.recent;
    const daily = barChart(r.map((d) => d.kwh), { label: 'Daily electricity use, kWh', ticks: r.map((d) => dayLabel(d.date, { month: 'numeric', day: 'numeric' })), tips: r.map((d) => `${dayLabel(d.date)}: ${num(d.kwh, 1)} kWh${d.cost != null ? ` · ${money(d.cost)}` : ''}`), low: (i) => C.isWeekendDate(r[i].date) });
    const prof = s.hourProfile ? barChart(s.hourProfile, { label: 'Average use by hour of day', ticks: s.hourProfile.map((_, h) => hourLabel(h)), tips: s.hourProfile.map((v, h) => `${hourLabel(h)}: ${num(v, 2)} kWh average`) }) : '<p class="muted small">Hour-of-day patterns appear when you import hourly (interval) data.</p>';
    const insights = [];
    if (s.baseLoad != null) insights.push(`Always-on load is about ${num(s.baseLoad * 1000)} W (${num(s.baseLoad * 24 * 30)} kWh/month): fridge, router, standby electronics. Unplugging idle devices is a saving no thermostat can make.`);
    if (s.peakHour != null) insights.push(`Your highest-use hour is around ${hourLabel(s.peakHour)}.`);
    if (s.weekdayAvg != null && s.weekendAvg != null) insights.push(`Weekdays average ${num(s.weekdayAvg, 1)} kWh, weekends ${num(s.weekendAvg, 1)} kWh.`);
    if (S.profile.hvacMetered === 'unknown') insights.push('It isn’t confirmed yet whether heating/cooling power is on your meter — ask building management.');
    return `${hdr('Energy', `${esc(dayLabel(s.from))} – ${esc(dayLabel(s.to))} · ${s.days} complete days`)}
    <div class="grid"><section class="card span"><div class="stats"><div class="stat"><b>${num(s.avg, 1)}</b><span>kWh / day</span></div><div class="stat"><b>${num(s.total)}</b><span>kWh total</span></div>
      <div class="stat"><b>${money(s.cost)}</b><span>${s.costSource ? esc(s.costSource) : 'cost: add a confirmed rate in Settings'}</span></div><div class="stat"><b>${s.peakHour != null ? hourLabel(s.peakHour) : '—'}</b><span>peak hour</span></div></div></section>
    <section class="card span"><h2>Daily use</h2><p class="small muted">Lighter bars are weekends.</p>${daily}</section>
    <section class="card span"><h2>Typical day</h2>${prof}</section>
    <section class="card span"><h2>What stands out</h2><ul class="tips">${insights.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>
    ${imp}<section class="card span"><button class="btn danger" data-act="clear-usage">Delete all usage data</button></section></div>`;
  },

  savings() {
    const p = S.profile;
    const r = C.evaluateSavings({ usage: S.usage, temps: S.temps, changeDate: p.changeDate, tariff: p.tariff });
    const nTemps = Object.keys(S.temps).length;
    const verdict = { likely_savings: ['good', 'Likely saving energy'], likely_increase: ['bad', 'Usage went up'], inconclusive: ['warn', 'No clear change yet'] }[r.status];
    const result = verdict ? `<section class="card span"><div class="row between"><h2>Result</h2><span class="pill ${verdict[0]}">${verdict[1]}</span></div>
      <div class="stats"><div class="stat"><b>${num(r.diff, 0)} kWh</b><span>weather-adjusted difference (±${num(r.unc, 0)})</span></div><div class="stat"><b>${num(r.pct, 1)}%</b><span>vs. expected</span></div>
      <div class="stat"><b>${num(r.actual, 0)}</b><span>actual kWh (${r.after} days)</span></div><div class="stat"><b>${num(r.predicted, 0)}</b><span>expected kWh without change</span></div></div>
      ${r.dollars != null ? `<p>≈ <b>${money(r.dollars)}</b> ± ${money(r.dollarsUnc)} in energy charges at your confirmed rate.</p>` : '<p class="small muted">Add a confirmed rate in Settings to see dollars. No rate is assumed.</p>'}
      <div class="stack">${alerts(r.caveats, 'info')}</div>
      <p class="small muted">Model: kWh/day = base + heating + cooling degree-days, fitted on ${r.before} baseline days (R² ${num(r.model.r2, 2)}). Positive difference = less energy than the weather predicts.</p></section>`
      : `<section class="card span">${alerts([r.message], 'info')}</section>`;
    return `${hdr('Savings', 'Did the new schedule actually help? Weather-adjusted, with honest uncertainty')}
    <div class="grid"><section class="card span"><div class="fields"><label>Date you started the new schedule<input type="date" data-k="profile.changeDate" data-rerender value="${esc(p.changeDate)}"></label>
      <div><label>Outdoor temperatures</label><p class="small muted">${nTemps ? `${nTemps} days loaded` : 'None loaded yet'}${histErr ? ` · <span class="pill bad">${esc(histErr)}</span>` : ''}</p>
      <button class="btn" data-act="history" ${busy === 'history' ? 'disabled' : ''}>${busy === 'history' ? 'Loading…' : 'Load temperatures'}</button></div></div>
      <p class="small muted">Daily mean temperatures for Wilmington come from Open-Meteo’s free historical archive. Only the city location and date range are sent, never your usage.</p></section>
    ${result}
    <section class="card span"><h2>How to get a trustworthy answer</h2><ul class="tips"><li>Import at least two weeks of usage from before the change and one week after (more is better).</li><li>Keep other habits steady; note travel or guests.</li><li>If heating/cooling power isn’t on your meter, the bill won’t show thermostat savings even when they are real.</li></ul></section></div>`;
  },

  device() {
    const st = controlStatus(S);
    const obs = [...S.observations].sort((a, b) => b.ts - a.ts).slice(0, 12);
    const caps = Object.entries(CAPABILITIES).map(([id, c]) => `<li><div><b>${esc(c.label)}</b><div class="small muted">${esc(c.detail)}</div></div><span class="pill ${id === S.capability ? 'good' : c.status === 'unavailable' ? 'bad' : ''}">${id === S.capability ? 'in use' : esc(c.status)}</span></li>`).join('');
    return `${hdr('Thermostat', 'Emerson / Delmarva web-programmable thermostat (likely IntelliTEMP IT900 family)')}
    <div class="grid two"><section class="card"><h2>Log what the display shows</h2><p class="small muted">Readings are typed by you and labelled “manual” everywhere. Nothing is read from the device.</p>
      <div class="fields"><label>Room temp °F<input type="number" id="o-room" inputmode="numeric" min="40" max="100"></label><label>Setpoint °F<input type="number" id="o-set" inputmode="numeric" min="40" max="100"></label>
      <label>Hold<select id="o-hold"><option value="none">No hold (RUN)</option><option value="hold">HOLD AT shown</option></select></label>
      <label>Mode<select id="o-mode"><option value="cool">COOL</option><option value="heat">HEAT</option><option value="off">OFF</option><option value="unknown">Not sure</option></select></label>
      <label>Fan<select id="o-fan"><option value="auto">AUTO</option><option value="on">ON</option><option value="unknown">Not sure</option></select></label>
      <label>Note<input type="text" id="o-note" maxlength="120" placeholder="e.g. COOL1 shown"></label></div>
      <button class="btn primary" data-act="add-obs">Save reading</button></section>
    <section class="card"><h2>Recent readings</h2>${obs.length ? `<ul class="list">${obs.map((o) => `<li><div><b>${num(o.roomF)}°</b> room · set ${num(o.setF)}° ${o.hold !== 'none' ? '<span class="pill warn">HOLD</span>' : ''}<div class="small muted">${esc(new Date(o.ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))} · ${esc(o.mode)} · fan ${esc(o.fan)}${o.note ? ` · ${esc(o.note)}` : ''}</div></div><button class="btn" data-act="del-obs" data-ts="${o.ts}" aria-label="Delete reading">✕</button></li>`).join('')}</ul>` : '<p class="muted">None yet.</p>'}</section>
    <section class="card span"><div class="row between"><h2>Automatic control</h2><span class="pill ${st.enabled ? 'good' : ''}">${st.enabled ? 'Enabled' : 'Off'}</span></div>
      <p>${esc(st.reason)}</p><button class="btn" disabled title="${esc(st.reason)}">Send schedule to thermostat</button>
      <ul class="list caps">${caps}</ul>
      <p class="small muted">The software has a disabled slot for an authorized interface. It can only turn on if Delmarva or the manufacturer documents a supported method, building/program rules allow it, and you explicitly approve. The side jack, utility radio and private utility APIs will never be used.</p></section>
    <section class="card span"><h2>Ask Delmarva</h2><p class="small muted">Use the <a href="${SUPPORT_URL}" target="_blank" rel="noopener noreferrer">Energy Wise Rewards contact form</a> or call 866-353-5799. Copy this message:</p><pre class="msg">${esc(SUPPORT_MSG)}</pre><button class="btn" data-act="copy-support">Copy message</button></section></div>`;
  },

  settings() {
    const p = S.profile;
    const sel = (k, opts) => `<select data-k="${k}">${opts.map(([v, l]) => `<option value="${v}" ${getPath(S, k) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const n = (k, attrs = '') => `<input type="number" data-k="${k}" value="${esc(getPath(S, k) ?? '')}" inputmode="decimal" ${attrs}>`;
    const t = (k) => `<input type="time" data-k="${k}" value="${esc(getPath(S, k))}" step="900">`;
    const temps = (m) => `<div class="fields three"><label>Home${n(`profile.comfort.${m}.home`, 'min="50" max="90"')}</label><label>Away${n(`profile.comfort.${m}.away`, 'min="50" max="90"')}</label><label>Sleep${n(`profile.comfort.${m}.sleep`, 'min="50" max="90"')}</label></div>`;
    const routine = (d) => `<div class="fields"><label>Wake${t(`profile.routine.${d}.wake`)}</label><label>Leave home${t(`profile.routine.${d}.leave`)}</label><label>Back home${t(`profile.routine.${d}.back`)}</label><label>Bedtime${t(`profile.routine.${d}.sleep`)}</label></div>`;
    return `${hdr('Settings', 'Saved automatically, only on this device')}
    <div class="grid two"><section class="card"><h2>Building</h2>
      <label>What the building provides right now${sel('profile.buildingMode', [['unknown', 'Not sure'], ['heat_available', 'Heating season'], ['cool_available', 'Cooling season'], ['fan_only', 'Fan only / changeover']])}</label>
      <label>Equipment type${sel('profile.hvacType', [['unknown', 'Not sure'], ['heat_pump', 'Heat pump'], ['electric_resistance', 'Electric resistance / strip heat'], ['fan_coil', 'Fan coil (building hot/chilled water)'], ['gas_or_boiler', 'Gas furnace / boiler'], ['other', 'Other']])}</label>
      <label>Is HVAC power on our Delmarva meter?${sel('profile.hvacMetered', [['unknown', 'Not sure'], ['yes', 'Yes'], ['partial', 'Partly (e.g. blower only)'], ['no', 'No — building pays']])}</label></section>
    <section class="card"><h2>Comfort (°F)</h2><h3>Heating</h3>${temps('heat')}<h3>Cooling</h3>${temps('cool')}
      <h3>Limits</h3><div class="fields"><label>Never below${n('profile.comfort.min', 'min="50" max="75"')}</label><label>Never above${n('profile.comfort.max', 'min="70" max="90"')}</label></div></section>
    <section class="card"><h2>Weekday routine</h2>${routine('weekday')}<p class="small muted">Clear Leave/Back if someone is home all day.</p></section>
    <section class="card"><h2>Weekend routine</h2>${routine('weekend')}<label>Warm-up / cool-down lead time (minutes)${n('profile.recoveryMin', 'min="0" max="120" step="15"')}</label></section>
    <section class="card"><h2>Electric rate</h2><p class="small muted">Leave blank unless you copied it from your Delmarva bill. Dollar figures stay hidden until it’s confirmed.</p>
      <label>Energy charge (¢ per kWh)${n('profile.tariff.centsPerKwh', 'min="0" max="100" step="0.01"')}</label><label class="check"><input type="checkbox" data-k="profile.tariff.confirmed" ${p.tariff.confirmed ? 'checked' : ''}> I confirmed this on my bill</label></section>
    <section class="card"><h2>Your data</h2><p class="small muted">Stored on this device only. On iPhone the Home Screen app keeps its own copy, separate from Safari. Export a backup now and then (it opens the share sheet, so you can save it to Files).</p>
      <div class="row"><button class="btn" data-act="export">Export backup</button><label class="btn file">Restore backup<input type="file" id="backup-file" accept=".json,application/json"></label><button class="btn danger" data-act="erase">Erase everything</button></div></section>
    <section class="card span"><button class="btn primary" data-act="setup-done">Done — show my recommendations</button></section></div>`;
  },
};

const SUPPORT_MSG = 'I have a Delmarva Power Energy Wise Rewards web-programmable Emerson thermostat, likely an IntelliTEMP IT900. In My Account, Program Your Thermostat -> View Thermostat fails with: "The remote name could not be resolved: apigateway-east.exeloncorp.com". Is remote programming for legacy thermostats currently supported, planned to be restored, or discontinued? Is there an official replacement portal or authorized integration/API? Can you identify the hardware revision and the purpose of the small modular-style jack on the side? I want to keep the existing thermostat working safely and avoid modifying the utility equipment. Please respond by email if possible.';

// ---------- rendering & events ----------

function render() {
  const rec = C.recommend(S, S.weatherCache?.hours || [], Date.now());
  document.querySelectorAll('[data-tab]').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === view ? 'page' : 'false'));
  $('#view').innerHTML = (VIEWS[view] || VIEWS.home)(rec);
  document.title = `${(TABS.find(([k]) => k === view) || TABS[0])[1]} · Apartment Energy Optimizer`;
}

async function fetchJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctl.signal, referrerPolicy: 'no-referrer' });
    if (!r.ok) throw new Error(`${new URL(url).host} returned HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The weather service timed out.');
    if (e instanceof TypeError) throw new Error('Could not reach the weather service (offline?).');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshWeather(force) {
  const wc = S.weatherCache;
  if (!force && wc && Date.now() - wc.fetchedAt < 3600e3) return;
  busy = 'weather';
  render();
  try {
    let url = wc?.hourlyUrl;
    if (!url) {
      const pts = await fetchJson(`https://api.weather.gov/points/${LOC.lat},${LOC.lon}`);
      url = pts?.properties?.forecastHourly;
      if (!url || !url.startsWith('https://api.weather.gov/')) throw new Error('The weather service did not return an hourly forecast link.');
    }
    const hours = C.parseNwsHourly(await fetchJson(url)).slice(0, 168);
    S.weatherCache = { fetchedAt: Date.now(), hourlyUrl: url, hours };
    weatherErr = '';
    save();
  } catch (e) {
    weatherErr = `Forecast unavailable: ${e.message}`;
    if (S.weatherCache) S.weatherCache.hourlyUrl = null; // re-resolve the forecast grid next time
  }
  busy = '';
  render();
}

async function loadHistory() {
  const days = C.dailyTotals(S.usage).map((d) => d.date);
  if (!days.length) { histErr = 'Import usage first.'; render(); return; }
  const end = days[days.length - 1] < todayIso() ? days[days.length - 1] : todayIso();
  const startCap = new Date(Date.parse(`${end}T12:00:00Z`) - 730 * 864e5).toISOString().slice(0, 10);
  const start = days[0] > startCap ? days[0] : startCap;
  busy = 'history';
  histErr = '';
  render();
  try {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${LOC.lat}&longitude=${LOC.lon}&start_date=${start}&end_date=${end}&daily=temperature_2m_mean&temperature_unit=fahrenheit&timezone=America%2FNew_York`;
    S.temps = { ...S.temps, ...C.parseOpenMeteoDaily(await fetchJson(url)) };
    save();
    toast(`Loaded ${Object.keys(S.temps).length} days of temperatures.`);
  } catch (e) {
    histErr = e.message;
  }
  busy = '';
  render();
}

const readFile = (f) => (f.size > 25e6 ? Promise.reject(new Error('File is larger than 25 MB.')) : f.text());

const ACTIONS = {
  weather: () => refreshWeather(true),
  history: loadHistory,
  print: () => window.print(),
  programmed() {
    S.profile.changeDate = todayIso();
    save();
    render();
    toast('Change date set to today. Savings will be measured from here.');
  },
  'setup-done'() {
    S.profile.setupDone = true;
    save();
    location.hash = 'home';
  },
  'add-obs'() {
    const v = (id) => $(id).value;
    const room = Number(v('#o-room')), set = Number(v('#o-set'));
    if (!v('#o-room') || !(room >= 40 && room <= 100)) return toast('Enter the room temperature shown (40–100°F).', true);
    S.observations.push({ ts: Date.now(), roomF: room, setF: v('#o-set') && set >= 40 && set <= 100 ? set : null, hold: v('#o-hold'), mode: v('#o-mode'), fan: v('#o-fan'), note: v('#o-note').slice(0, 120), source: 'manual' });
    S.observations = S.observations.slice(-500);
    save();
    render();
    toast('Reading saved (manual).');
  },
  'del-obs'(el) {
    S.observations = S.observations.filter((o) => String(o.ts) !== el.dataset.ts);
    save();
    render();
  },
  'manual-usage'() {
    const date = C.parseDate($('#man-date').value || '');
    const kwh = Number($('#man-kwh').value);
    if (!date || !$('#man-kwh').value || !(kwh >= 0 && kwh <= 500)) return toast('Enter a date and a kWh value between 0 and 500.', true);
    S.usage = C.mergeUsage(S.usage, [{ date, hour: null, kwh, cost: null }]);
    save();
    render();
    toast(`Saved ${kwh} kWh for ${date}.`);
  },
  'clear-usage'() {
    if (!confirm('Delete all imported electricity usage from this device?')) return;
    S.usage = { hourly: {}, daily: {}, cost: {} };
    save();
    render();
  },
  'copy-support'() {
    navigator.clipboard?.writeText(SUPPORT_MSG).then(() => toast('Message copied.'), () => toast('Select the text and copy it manually.', true));
  },
  async export() {
    const name = `energy-optimizer-backup-${todayIso()}.json`;
    const file = new File([JSON.stringify({ ...S, weatherCache: null }, null, 2)], name, { type: 'application/json' });
    // iPhone Home Screen apps: the share sheet (“Save to Files”) is the reliable way to save a file.
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  erase() {
    if (!confirm('Erase all settings, readings and usage from this device? Export a backup first if you want to keep them.')) return;
    try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
    S = C.defaultState();
    render();
    toast('All data erased from this device.');
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
  if (el && ACTIONS[el.dataset.act]) { e.preventDefault(); ACTIONS[el.dataset.act](el); return; }
  const tip = e.target.closest('[data-tip]');
  if (tip) showTip(tip, true);
});
document.addEventListener('mouseover', (e) => {
  const tip = e.target.closest('[data-tip]');
  if (tip) showTip(tip, false);
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.id === 'usage-file' && el.files[0]) {
    const f = el.files[0];
    busy = 'import';
    render();
    try {
      const res = C.importUsageFile(f.name, await readFile(f));
      S.usage = C.mergeUsage(S.usage, res.records);
      save();
      toast(`Imported ${res.records.length} ${res.interval} readings${res.skipped ? `, skipped ${res.skipped} unreadable rows` : ''}.`);
    } catch (err) {
      toast(`Import failed: ${err.message}`, true);
    }
    busy = '';
    render();
    return;
  }
  if (el.id === 'backup-file' && el.files[0]) {
    try {
      const data = JSON.parse(await readFile(el.files[0]));
      if (!data || data.version !== 1 || !data.profile) throw new Error('Not an Apartment Energy Optimizer backup.');
      S = C.mergeState(data);
      save();
      render();
      toast('Backup restored.');
    } catch (err) {
      toast(`Restore failed: ${err.message}`, true);
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
  // Re-rendering settings would steal focus while typing, so only fields that need it re-render.
  if ('rerender' in el.dataset) render();
});

$('#nav').innerHTML = `<div class="brand"><img src="icon.svg" alt=""><span>Energy Optimizer</span></div>${TABS.map(([k, l]) => `<a href="#${k}" data-tab="${k}">${icon(k)}<span>${l}</span></a>`).join('')}`;
window.addEventListener('hashchange', () => {
  view = location.hash.slice(1) || 'home';
  render();
  window.scrollTo(0, 0);
});
render();
refreshWeather(false);
try { navigator.storage?.persist?.(); } catch { /* optional */ }
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
