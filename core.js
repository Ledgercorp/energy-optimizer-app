// Apartment Energy Optimizer — domain logic.
// Pure functions only: no DOM, no network, no storage. Runs in the browser and under `node --test`.

export const TZ = 'America/New_York';
export const PERIODS = ['Morning', 'Day', 'Evening', 'Night'];
// Which thermostat modes the building can actually serve right now.
export const BUILDING_MODES = { heat_available: ['heat'], cool_available: ['cool'], fan_only: [], unknown: ['heat', 'cool'] };
export const BUILDING_LABEL = { heat_available: 'heating season', cool_available: 'cooling season', fan_only: 'fan only', unknown: 'unknown' };

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY_NAME = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
/** The routine that applies on a weekday ('Mon'…). Someone being home counts as "home", whoever it is. */
export function routineFor(routine, d) {
  if (routine?.mode === 'days' && routine.days?.[d]) return routine.days[d];
  return d === 'Sat' || d === 'Sun' ? routine.weekend : routine.weekday;
}

export function defaultState() {
  return {
    version: 1,
    profile: {
      setupDone: false,
      buildingMode: 'unknown', // what building management says is on
      hvacType: 'unknown', // heat_pump | electric_resistance | fan_coil | gas_or_boiler | other | unknown
      hvacMetered: 'unknown', // yes | partial | no | unknown — is HVAC power on our Delmarva meter?
      comfort: { min: 60, max: 85, heat: { home: 68, away: 66, sleep: 66 }, cool: { home: 76, away: 80, sleep: 76 } },
      routine: {
        weekday: { wake: '06:30', leave: '08:00', back: '17:30', sleep: '22:30' },
        weekend: { wake: '08:00', leave: '', back: '', sleep: '23:00' },
        // 'groups' = Weekdays/Weekends; 'days' = each day separately (the IT900's Individual Days programming).
        mode: 'groups',
        days: Object.fromEntries(DOW.map((d) => [d, d === 'Sat' || d === 'Sun' ? { wake: '08:00', leave: '', back: '', sleep: '23:00' } : { wake: '06:30', leave: '08:00', back: '17:30', sleep: '22:30' }])),
      },
      recoveryMin: 30,
      tariff: { centsPerKwh: null, confirmed: false },
      changeDate: '',
    },
    observations: [],
    usage: { hourly: {}, daily: {}, cost: {} },
    temps: {},
    weatherCache: null,
    capability: 'manual_only',
    controlVerified: false,
    controlApproved: false,
  };
}

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Overlay saved data on defaults so older backups gain new fields. Unknown top-level keys are dropped.
export function mergeState(saved) {
  const merge = (base, over) => {
    for (const k of Object.keys(over)) {
      if (BAD_KEYS.has(k) || !(k in base)) continue;
      if (isObj(base[k]) && Object.keys(base[k]).length && isObj(over[k])) merge(base[k], over[k]);
      else if (base[k] === null || typeof base[k] === typeof over[k] || (isObj(base[k]) && isObj(over[k]))) base[k] = over[k];
    }
    return base;
  };
  const d = defaultState();
  if (!isObj(saved)) return d;
  const s = merge(d, saved);
  for (const part of ['hourly', 'daily', 'cost']) {
    s.usage[part] = Object.fromEntries(Object.entries(s.usage[part] || {}).filter(([k, v]) => !BAD_KEYS.has(k) && Number.isFinite(v)));
  }
  s.observations = (Array.isArray(s.observations) ? s.observations : []).filter((o) => isObj(o) && Number.isFinite(o.ts));
  return s;
}

// ---------- time ----------

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
});

/** Wall-clock parts in America/New_York for an epoch-ms instant (DST-correct). */
export function localParts(ms) {
  const p = {};
  for (const x of partsFmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: p.weekday };
}

export function toMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

export function fmtMin(min) {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export const isWeekendDate = (iso) => {
  const [y, mo, d] = iso.split('-').map(Number);
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return wd === 0 || wd === 6;
};

// ---------- schedule engine ----------

/** Apply comfort bounds and equipment guardrails to the user's preferred setpoints. */
export function guardSetpoints(mode, profile) {
  const { comfort, hvacType } = profile;
  const c = comfort[mode];
  const notes = [];
  const clamp = (t) => Math.min(comfort.max, Math.max(comfort.min, Math.round(Number(t))));
  let home = clamp(c.home), away = clamp(c.away), sleep = clamp(c.sleep);
  if (mode === 'heat') {
    if (away > home) { away = home; notes.push('Away heating setpoint was above Home; using Home instead (heating more while away only costs money).'); }
    if (hvacType === 'heat_pump' || hvacType === 'unknown') {
      const lim = home - 2;
      if (away < lim || sleep < lim) {
        notes.push(`Heating setback limited to 2°F because the equipment is ${hvacType === 'heat_pump' ? 'a heat pump' : 'not yet identified'}: Delmarva's thermostat manual warns larger heat-pump setbacks can trigger costlier auxiliary heat.`);
      }
      away = Math.max(away, lim);
      sleep = Math.max(sleep, lim);
    }
  } else if (away < home) {
    away = home;
    notes.push('Away cooling setpoint was below Home; using Home instead (cooling more while away only costs money).');
  }
  return { home, away, sleep, notes };
}

export function validateDay(periods) {
  if (periods.length !== 4) throw new Error('A day needs exactly four periods.');
  for (let i = 1; i < 4; i++) {
    if (!(periods[i].start > periods[i - 1].start)) {
      throw new Error(`${periods[i].name} (${fmtMin(periods[i].start)}) must start after ${periods[i - 1].name} (${fmtMin(periods[i - 1].start)}). Check your routine times — bedtimes after midnight are not supported; use 11:45 PM.`);
    }
  }
  if (periods[3].start >= 1440) throw new Error('Night must start before midnight.');
  return periods;
}

const round15 = (m) => Math.round(m / 15) * 15;

/** Build the thermostat's four chronological periods for one day type. */
export function buildDay(r, sp, recoveryMin = 30) {
  const wake = toMin(r.wake), sleep = toMin(r.sleep), leave = toMin(r.leave), back = toMin(r.back);
  if (wake == null || sleep == null) throw new Error('Wake and bedtime are required (HH:MM).');
  const rec = Math.max(0, Math.min(120, Number(recoveryMin) || 0));
  if ((leave == null) !== (back == null)) throw new Error('Set both “Leave home” and “Back home”, or clear both if someone is home all day.');
  if (leave != null && back <= leave) throw new Error('“Back home” must be later than “Leave home” (24-hour times, e.g. 17:30).');
  const away = leave != null && back != null;
  // Start Morning/Evening a little early so the room is comfortable when you need it.
  const starts = away
    ? [wake - rec, leave, back - rec, sleep]
    : [wake - rec, Math.max(wake, 12 * 60), Math.max(wake + 60, 17 * 60), sleep];
  const temps = away ? [sp.home, sp.away, sp.home, sp.sleep] : [sp.home, sp.home, sp.home, sp.sleep];
  return validateDay(PERIODS.map((name, i) => ({ name, start: Math.max(0, round15(starts[i])), temp: temps[i], away: away && i === 1 })));
}

/** Which period is active right now for each plan. */
export function currentTargets(plans, now) {
  const { hour, minute, weekday } = localParts(now);
  const m = hour * 60 + minute;
  const weekend = weekday === 'Sat' || weekday === 'Sun';
  return plans.map((pl) => {
    const day = pl.days?.[weekday] || (weekend ? pl.weekend : pl.weekday);
    let i = -1;
    day.forEach((p, k) => { if (p.start <= m) i = k; });
    // ponytail: before Morning we report today's Night entry; the previous day type's Night may differ by a degree.
    const cur = i < 0 ? day[3] : day[i];
    const next = i < 0 ? day[0] : day[(i + 1) % 4];
    return { mode: pl.mode, period: cur.name, temp: cur.temp, next };
  });
}

// ---------- weather ----------

export function parseNwsHourly(json) {
  const ps = json?.properties?.periods;
  if (!Array.isArray(ps) || !ps.length) throw new Error('Forecast response had no hourly periods.');
  return ps.map((p) => {
    let t = p.temperature, unit = p.temperatureUnit;
    if (isObj(t)) { unit = /degC/.test(t.unitCode) ? 'C' : 'F'; t = t.value; }
    const tempF = unit === 'C' ? (t * 9) / 5 + 32 : t;
    return { t: Date.parse(p.startTime), tempF, text: p.shortForecast || '', pop: p.probabilityOfPrecipitation?.value ?? null };
  }).filter((h) => Number.isFinite(h.t) && Number.isFinite(h.tempF));
}

export function parseOpenMeteoDaily(json) {
  const t = json?.daily?.time, v = json?.daily?.temperature_2m_mean;
  if (!Array.isArray(t) || !Array.isArray(v)) throw new Error('Historical weather response was not in the expected format.');
  const out = {};
  t.forEach((d, i) => { if (Number.isFinite(v[i])) out[d] = v[i]; });
  return out;
}

const level = (dd) => (dd < 2 ? 'low' : dd < 10 ? 'moderate' : 'high');

/** Per-day high/low and heating/cooling demand (degree-days, base 65°F) from hourly forecast. */
export function dailyOutlook(hours) {
  const byDay = new Map();
  for (const h of hours) {
    const lp = localParts(h.t);
    const d = byDay.get(lp.date) || { date: lp.date, high: -Infinity, low: Infinity, n: 0, cdh: 0, hdh: 0, text: '' };
    d.high = Math.max(d.high, h.tempF);
    d.low = Math.min(d.low, h.tempF);
    d.n++;
    d.cdh += Math.max(0, h.tempF - 65);
    d.hdh += Math.max(0, 65 - h.tempF);
    if (!d.text && lp.hour >= 12) d.text = h.text;
    byDay.set(lp.date, d);
  }
  return [...byDay.values()].map((d) => {
    const cdd = d.cdh / d.n, hdd = d.hdh / d.n;
    return { date: d.date, high: d.high, low: d.low, hours: d.n, text: d.text, cdd, hdd, cooling: level(cdd), heating: level(hdd) };
  });
}

function dayTips(d, p, modes) {
  const tips = [];
  const cool = modes.includes('cool'), heat = modes.includes('heat');
  const c = p.comfort;
  if (cool && d.high <= c.cool.home - 2) tips.push('Outdoors stays below your cooling setpoint, so the AC should barely run. Opening windows (if comfortable) costs nothing.');
  if (cool && d.high >= 90) tips.push(`Hot day (${Math.round(d.high)}°F): close blinds on sun-facing windows by late morning and resist setting below ${c.cool.home}°F — a lower setpoint makes the AC run longer.`);
  if (heat && d.low <= 25 && (p.hvacType === 'heat_pump' || p.hvacType === 'unknown')) tips.push(`Very cold night (${Math.round(d.low)}°F): keep heating setbacks small (≤2°F) so auxiliary heat is less likely to kick in.`);
  if (heat && d.low >= 58) tips.push('Mild temperatures: heating should barely run. Open blinds on sunny windows for free warmth.');
  if (heat && !cool && d.high >= 78) tips.push('Warm afternoon, but the building is in heating season so cooling is unavailable. Use blinds and a fan, and lower the heat setpoint rather than opening windows while heat runs.');
  if (!heat && !cool) tips.push('Building is in fan-only mode: keep the thermostat fan on AUTO unless building ventilation requires ON.');
  return tips;
}

// ---------- observations (manual readings only) ----------

export const latestObservation = (obs) => (obs || []).reduce((a, o) => (!a || o.ts > a.ts ? o : a), null);

export function observationWarnings(state, now) {
  const o = latestObservation(state.observations);
  const p = state.profile;
  if (!o) return ['No thermostat reading logged yet. This app cannot read the thermostat — log what the display shows on the Thermostat tab.'];
  const w = [];
  const days = (now - o.ts) / 864e5;
  if (days > 7) w.push(`Your last thermostat reading is ${Math.floor(days)} days old and may no longer match the display.`);
  if (o.hold && o.hold !== 'none') w.push(`Last reading showed HOLD AT ${o.setF ?? '?'}°. A hold overrides the programmed schedule, so a new schedule won't take effect until you press RUN on the thermostat.`);
  const modes = BUILDING_MODES[p.buildingMode] || [];
  if ((o.mode === 'cool' || o.mode === 'heat') && p.buildingMode !== 'unknown' && !modes.includes(o.mode)) {
    w.push(`Thermostat was in ${o.mode.toUpperCase()} mode, but the building is marked ${BUILDING_LABEL[p.buildingMode]}. That mode can't deliver anything right now — check with management or update Settings.`);
  }
  if (o.fan === 'on' && p.hvacMetered !== 'no') w.push('Fan was set to ON (runs continuously). AUTO usually uses less electricity — unless building ventilation rules require ON.');
  return w;
}

/** Everything the dashboard needs, derived from state + forecast. */
export function recommend(state, hours = [], now = Date.now()) {
  const p = state.profile;
  const modes = BUILDING_MODES[p.buildingMode] ?? [];
  const plans = [], errors = [];
  for (const mode of modes) {
    const sp = guardSetpoints(mode, p);
    try {
      if (p.routine.mode === 'days') {
        const days = Object.fromEntries(DOW.map((d) => { try { return [d, buildDay(routineFor(p.routine, d), sp, p.recoveryMin)]; } catch (e) { throw new Error(`${DAY_NAME[d]}: ${e.message}`); } }));
        plans.push({ mode, setpoints: sp, notes: sp.notes, daysMode: true, days, weekday: days.Mon, weekend: days.Sat });
      } else plans.push({ mode, setpoints: sp, notes: sp.notes, weekday: buildDay(p.routine.weekday, sp, p.recoveryMin), weekend: buildDay(p.routine.weekend, sp, p.recoveryMin) });
    } catch (e) {
      errors.push(e.message);
    }
  }
  const future = hours.filter((h) => h.t >= now - 3600e3);
  const outlook = dailyOutlook(future).map((d) => ({ ...d, tips: dayTips(d, p, modes) }));
  const warnings = observationWarnings(state, now);
  if (p.buildingMode === 'unknown') warnings.push('Building HVAC season is unknown, so both heating and cooling schedules are shown. Ask management which service is on and set it in Settings.');
  if (p.hvacMetered === 'no') warnings.push('You noted HVAC power is not on your electric meter: thermostat changes may not lower your Delmarva bill.');
  return { modes, plans, outlook, warnings, errors, current: currentTargets(plans, now) };
}

// ---------- usage import ----------

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

export function parseDate(s) {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  let y, mo, d;
  if (m) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s))) [mo, d, y] = [+m[1], +m[2], +m[3] < 100 ? 2000 + +m[3] : +m[3]];
  else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 2000 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Hour 0-23 from "00:00", "1:00 AM", "2026-10-01 13:00"; null when the cell has no time. */
export function parseHour(s) {
  const m = /(?:^|[\sT])(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/.exec(String(s || ''));
  if (!m) return null;
  let h = +m[1];
  if (m[3]) { const pm = /p/i.test(m[3]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  return h >= 0 && h < 24 ? h : null;
}

const parseNum = (s) => {
  const v = Number(String(s ?? '').replace(/[$,\s]/g, ''));
  return String(s ?? '').trim() === '' ? NaN : v;
};

/** Delmarva "Green Button Download my data" CSV (hourly or daily) or any simple date,kWh CSV. */
export function importUsageCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The file is empty.');
  const rows = parseCsv(text.replace(/^﻿/, ''));
  const hi = rows.findIndex((r) => r.some((c) => /date/i.test(c)) && r.some((c) => /usage|kwh|consumption/i.test(c)));
  if (hi < 0) throw new Error('No header row with a date column and a usage/kWh column was found. Expected a Delmarva "Download my data" CSV or a simple date,kWh file.');
  const h = rows[hi].map((c) => c.toLowerCase());
  const col = (re, not) => h.findIndex((c) => re.test(c) && !(not && not.test(c)));
  const iDate = col(/date/, /end/);
  const iStart = col(/start/);
  const iUse = col(/usage|kwh|consumption|import/, /cost|export|^units?$/);
  const iCost = col(/cost|charge|\$/);
  const iUnits = col(/^units?$/);
  const records = [];
  let skipped = 0;
  for (const r of rows.slice(hi + 1)) {
    if (r.every((c) => c === '')) continue;
    const date = parseDate(r[iDate] || '');
    const kwh = parseNum(r[iUse]);
    if (iUnits >= 0 && r[iUnits] && !/kwh/i.test(r[iUnits])) { skipped++; continue; }
    if (!date || !Number.isFinite(kwh) || kwh < 0 || kwh > 500) { skipped++; continue; }
    const tcell = iStart >= 0 ? r[iStart] : r[iDate];
    const hour = parseHour(tcell);
    const cost = iCost >= 0 ? parseNum(r[iCost]) : NaN;
    const min = hour == null ? '' : /:(\d{2})/.exec(tcell)[1];
    records.push({ date, hour, kwh, cost: Number.isFinite(cost) ? cost : null, slot: hour == null ? date : `${date}T${hour}:${min}` });
  }
  if (!records.length) throw new Error(`No valid usage rows found (${skipped} rows could not be read).`);
  return { records, skipped, interval: records.some((x) => x.hour != null) ? 'hourly' : 'daily' };
}

const xmlTag = (s, name) => {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>\\s*([^<]*?)\\s*</(?:[\\w-]+:)?${name}>`).exec(s);
  return m ? m[1] : null;
};

/**
 * Green Button (ESPI) XML, including Delmarva/Opower "Download my data" feeds.
 * - Each IntervalBlock belongs to the most recent ReadingType. Only energy series (uom 72, Wh) are imported;
 *   demand series (e.g. uom 38) and exact duplicate series are ignored.
 * - Scale: the declared powerOfTenMultiplier is used when it gives plausible household values (and, when costs are
 *   present, a plausible price per kWh); otherwise plain watt-hours are assumed and noted.
 * - Time: when LocalTimeParameters say tzOffset 0, Opower writes local wall-clock time as if it were UTC.
 */
export function importGreenButton(xml) {
  if (typeof xml !== 'string' || !/IntervalReading/.test(xml)) throw new Error('Not a Green Button file: no IntervalReading elements found.');
  const notes = [];
  const tz = /<(?:[\w-]+:)?tzOffset>\s*(-?\d+)\s*</.exec(xml);
  const wallClock = tz && +tz[1] === 0;
  const series = [];
  let rt = { uom: null, mult: 0, flow: null };
  let skipped = 0;
  for (const part of xml.split(/<(?:[\w-]+:)?entry\b[^>]*>/)) {
    if (/<(?:[\w-]+:)?ReadingType\b/.test(part) || xmlTag(part, 'uom') != null) rt = { uom: xmlTag(part, 'uom'), mult: Number(xmlTag(part, 'powerOfTenMultiplier') ?? 0) || 0, flow: xmlTag(part, 'flowDirection') };
    if (!/IntervalReading/.test(part)) continue;
    const rows = [];
    for (const m of part.matchAll(/<(?:[\w-]+:)?IntervalReading\b[\s\S]*?<\/(?:[\w-]+:)?IntervalReading>/g)) {
      const b = m[0], start = Number(xmlTag(b, 'start')), dur = Number(xmlTag(b, 'duration')), val = Number(xmlTag(b, 'value')), cost = xmlTag(b, 'cost');
      if (!Number.isFinite(start) || !Number.isFinite(val) || val < 0) { skipped++; continue; }
      rows.push({ start, dur, val, cost: cost != null && Number.isFinite(+cost) ? +cost / 100000 : null });
    }
    const last = series[series.length - 1];
    if (last && last.rt === rt) last.rows.push(...rows); else series.push({ rt, rows });
  }
  const energy = series.filter((x) => (x.rt.uom == null || x.rt.uom === '72') && x.rt.flow !== '19'); // 19 = energy sent back to the grid
  if (!energy.length) throw new Error(`No energy (watt-hour) readings found; this file has only uom ${[...new Set(series.map((x) => x.rt.uom))].join(', ')}.`);
  if (energy.length < series.length) notes.push('a demand series in the file was ignored (energy readings used)');
  const sig = (x) => x.rows.map((r) => `${r.start}:${r.val}`).join(',');
  const kept = energy.filter((x, i) => energy.findIndex((y) => sig(y) === sig(x)) === i);
  if (kept.length < energy.length) notes.push('a duplicate copy of the readings was ignored');
  const BILL = 20 * 86400;
  const longRows = kept.flatMap((x) => x.rows).filter((r) => r.dur >= BILL);
  if (longRows.length && longRows.length === kept.flatMap((x) => x.rows).length) {
    // A billing-data export: one reading per billing period (start, length, kWh, the billed amount). Same unit check as usage, on price only.
    const periods = [];
    for (const { rt: t, rows } of kept) {
      const priced = rows.filter((r) => r.cost > 0 && r.val > 0), price = (scale) => (priced.length ? priced.reduce((a, r) => a + r.cost, 0) / priced.reduce((a, r) => a + r.val * scale, 0) : null);
      const okB = (scale) => rows.every((r) => (r.val * scale) / (r.dur / 86400) <= 1200) && (price(scale) == null || (price(scale) >= 0.03 && price(scale) <= 1));
      const declared = 10 ** t.mult / 1000, scale = [declared, 1 / 1000, 10 ** -t.mult / 1000].find(okB) ?? declared;
      if (scale !== declared) notes.push(`values read as watt-hours (the file’s ×10^${t.mult} scale tag doesn’t match its usage and costs)`);
      for (const r of rows) {
        const ms = r.start * 1000, start = wallClock ? new Date(ms).toISOString().slice(0, 10) : localParts(ms).date, days = Math.round(r.dur / 86400);
        const last = new Date(Date.parse(`${start}T12:00:00Z`) + (days - 1) * 864e5).toISOString().slice(0, 10);
        periods.push({ start, end: last, days, kwh: Math.round(r.val * scale * 1000) / 1000, amount: r.cost != null ? Math.round(r.cost * 100) / 100 : null });
      }
    }
    if (!periods.length) throw new Error('The billing file had no readable billing periods.');
    return { kind: 'billing', records: [], periods: periods.sort((a, b) => (a.start < b.start ? -1 : 1)), skipped, notes };
  }
  if (longRows.length) { notes.push(`${longRows.length} reading(s) spanning a whole billing period were left out of usage`); for (const x of kept) x.rows = x.rows.filter((r) => r.dur < BILL); }
  const records = [];
  for (const { rt: t, rows } of kept) {
    const hourly = rows.filter((r) => r.dur <= 3600 && r.val > 0).map((r) => r.val).sort((x, y) => x - y);
    const typical = hourly.length ? hourly[hourly.length >> 1] : null, peakVal = hourly.length ? hourly[hourly.length - 1] : null;
    const priced = rows.filter((r) => r.cost > 0 && r.val > 0);
    const price = (scale) => (priced.length ? priced.reduce((s, r) => s + r.cost, 0) / priced.reduce((s, r) => s + r.val * scale, 0) : null);
    // Physical check first: one hour can't exceed ~50 kWh on an apartment service (200 A × 240 V ≈ 48 kW). Price is a second check.
    const ok = (scale) => (typical == null || (typical * scale >= 0.005 && typical * scale <= 25 && peakVal * scale <= 50)) && (price(scale) == null || (price(scale) >= 0.03 && price(scale) <= 1));
    const declared = 10 ** t.mult / 1000;
    const scale = [declared, 1 / 1000, 10 ** -t.mult / 1000].find(ok) ?? declared;
    if (scale !== declared) notes.push(`values read as watt-hours (the file’s ×10^${t.mult} scale tag doesn’t match its usage and costs)`);
    for (const r of rows) {
      const ms = r.start * 1000;
      const { date, hour } = wallClock ? { date: new Date(ms).toISOString().slice(0, 10), hour: new Date(ms).getUTCHours() } : localParts(ms);
      records.push({ date, hour: r.dur > 3600 ? null : hour, kwh: r.val * scale, cost: r.cost, slot: `@${r.start}` });
    }
  }
  if (!records.length) throw new Error('The Green Button file had no readable interval readings.');
  if (wallClock) {
    // Wall-clock exports list 24 hours on every day, including the fall-back day, so the repeated 1 AM hour is not shown separately.
    for (const d of [...new Set(records.filter((r) => isFallBackDate(r.date) && r.hour === 1).map((r) => r.date))]) {
      if (records.filter((r) => r.date === d && r.hour === 1).length === 1) notes.push(`on ${d} (clocks fell back) the file lists one 1 AM hour, not two, so that day may be about an hour short`);
    }
  }
  return { kind: 'usage', records, skipped, interval: records.some((x) => x.hour != null) ? 'hourly' : 'daily', assumedWh: kept.some((x) => x.rt.uom == null), notes };
}

/**
 * The .xml/.csv files inside a .zip (Delmarva's download is zipped). Uses the browser's DecompressionStream.
 * Entries over 50 MB uncompressed, folders and macOS resource files are skipped.
 */
export async function unzipUsage(buf) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This zip file could not be read.');
  const count = dv.getUint16(eocd + 10, true), out = [];
  let p = dv.getUint32(eocd + 16, true);
  for (let k = 0; k < count && dv.getUint32(p, true) === 0x02014b50; k++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nlen));
    p += 46 + nlen + xlen + clen;
    if (!/\.(xml|csv)$/i.test(name) || /(^|\/)(__MACOSX|\.)/.test(name) || usize > 50e6) continue;
    const data = new Uint8Array(buf, off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true), csize);
    if (method !== 0 && method !== 8) throw new Error('This zip uses an unsupported compression method.');
    const bytes = method === 0 ? data : new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    out.push({ name: name.split('/').pop(), text: new TextDecoder().decode(bytes) });
  }
  if (!out.length) throw new Error('The zip file has no .xml or .csv usage file inside.');
  return out;
}

export function importUsageFile(name, text) {
  const res = /\.xml$/i.test(name) || /^\s*<\?xml|<feed/i.test(text) ? importGreenButton(text) : importUsageCsv(text);
  return { ...res, ...cleanRecords(res.records) };
}

/** First Sunday of November: the 1 AM hour happens twice (US daylight-saving fall-back). */
export const isFallBackDate = (iso) => iso.slice(5, 7) === '11' && +iso.slice(8, 10) <= 7 && new Date(`${iso}T12:00:00Z`).getUTCDay() === 0;

/**
 * Drop readings a file repeats (e.g. two exports pasted together). Each reading has a slot — its exact start
 * (date + clock time, or the Green Button epoch second). A slot appears once, except the CSV 1 AM slot on the
 * DST fall-back day, which legitimately appears twice. Extra copies are removed and reported:
 * identical values as duplicates, different values as conflicts (the first reading is kept).
 */
export function cleanRecords(records) {
  const seen = new Map(), out = [], conflicts = new Set();
  let duplicates = 0;
  for (const r of records) {
    const k = r.slot ?? `${r.date}T${r.hour ?? ''}`;
    const prev = seen.get(k) || [];
    const allowed = r.hour === 1 && isFallBackDate(r.date) && !k.startsWith('@') ? 2 : 1;
    if (prev.length < allowed) { prev.push(r.kwh); seen.set(k, prev); out.push(r); }
    else if (prev.includes(r.kwh)) duplicates++;
    else conflicts.add(r.date);
  }
  return { records: out, duplicates, conflicts: [...conflicts].sort() };
}

/** Merge imported records into stored usage. Re-importing the same file replaces values instead of doubling them. */
export function mergeUsage(usage, records) {
  const hourly = {}, daily = {}, cost = {};
  for (const r of records) {
    if (r.hour != null) {
      const k = `${r.date}T${String(r.hour).padStart(2, '0')}`;
      hourly[k] = (hourly[k] || 0) + r.kwh; // sub-hourly readings and the repeated DST fall-back hour sum here
    } else daily[r.date] = (daily[r.date] || 0) + r.kwh;
    if (r.cost != null) cost[r.date] = (cost[r.date] || 0) + r.cost;
  }
  return { hourly: { ...usage.hourly, ...hourly }, daily: { ...usage.daily, ...daily }, cost: { ...usage.cost, ...cost } };
}

export function dailyTotals(usage) {
  const days = {};
  for (const [d, kwh] of Object.entries(usage.daily || {})) days[d] = { date: d, kwh, hours: 24 };
  const fromHourly = {};
  for (const [k, kwh] of Object.entries(usage.hourly || {})) {
    const d = k.slice(0, 10);
    fromHourly[d] ||= { date: d, kwh: 0, hours: 0 };
    fromHourly[d].kwh += kwh;
    fromHourly[d].hours++;
  }
  Object.assign(days, fromHourly); // hourly detail wins over a daily figure for the same date
  return Object.values(days)
    .map((d) => ({ ...d, cost: usage.cost?.[d.date] ?? null, complete: d.hours >= 23 }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

const sum = (a) => a.reduce((s, v) => s + v, 0);
const avg = (a) => (a.length ? sum(a) / a.length : null);

export function energyCost(kwh, tariff) {
  return tariff?.confirmed && Number(tariff.centsPerKwh) > 0 ? (kwh * Number(tariff.centsPerKwh)) / 100 : null;
}

export function usageSummary(usage, tariff, span = 30) {
  const all = dailyTotals(usage).filter((d) => d.complete);
  if (!all.length) return null;
  const recent = all.slice(-span);
  const total = sum(recent.map((d) => d.kwh));
  const recentSet = new Set(recent.map((d) => d.date));
  const prof = Array(24).fill(0), cnt = Array(24).fill(0);
  for (const [k, v] of Object.entries(usage.hourly || {})) {
    if (!recentSet.has(k.slice(0, 10))) continue;
    const h = +k.slice(11, 13);
    prof[h] += v;
    cnt[h]++;
  }
  const hourProfile = cnt.some(Boolean) ? prof.map((v, i) => (cnt[i] ? v / cnt[i] : 0)) : null;
  const fileCost = recent.every((d) => d.cost != null) ? sum(recent.map((d) => d.cost)) : null;
  const rateCost = energyCost(total, tariff);
  return {
    days: recent.length, from: recent[0].date, to: recent[recent.length - 1].date, total, avg: total / recent.length,
    weekdayAvg: avg(recent.filter((d) => !isWeekendDate(d.date)).map((d) => d.kwh)),
    weekendAvg: avg(recent.filter((d) => isWeekendDate(d.date)).map((d) => d.kwh)),
    hourProfile,
    peakHour: hourProfile ? hourProfile.indexOf(Math.max(...hourProfile)) : null,
    baseLoad: hourProfile ? Math.min(...hourProfile) : null,
    cost: fileCost ?? rateCost,
    costSource: fileCost != null ? 'from your utility file' : rateCost != null ? 'your confirmed energy rate only (excludes fixed charges and taxes)' : null,
    recent,
  };
}

// ---------- weather-adjusted measurement ----------

export const degreeDays = (meanF) => ({ hdd: Math.max(0, 65 - meanF), cdd: Math.max(0, meanF - 65) });

function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-9) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

const variance = (a) => { const m = avg(a); return avg(a.map((v) => (v - m) ** 2)); };

/** Ordinary least squares: kWh/day = a + b·HDD + c·CDD (terms without variation are dropped). */
export function fitBaseline(points, cand = ['hdd', 'cdd']) {
  if (points.length < 3) return null;
  // Degree-day terms need real spread; the weekend indicator (0/1) only needs both kinds of day present.
  const feats = cand.filter((f) => variance(points.map((p) => p[f] ?? 0)) > (f === 'wkend' ? 0.05 : 0.25));
  const X = points.map((p) => [1, ...feats.map((f) => p[f] ?? 0)]);
  const y = points.map((p) => p.kwh);
  const k = X[0].length;
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => sum(X.map((r) => r[i] * r[j]))));
  const b = Array.from({ length: k }, (_, i) => sum(X.map((r, n) => r[i] * y[n])));
  const coef = solve(A, b);
  if (!coef) return null;
  const predict = (p) => coef[0] + feats.reduce((s, f, i) => s + coef[i + 1] * (p[f] ?? 0), 0);
  const sse = sum(points.map((p) => (p.kwh - predict(p)) ** 2));
  const my = avg(y), sst = sum(y.map((v) => (v - my) ** 2));
  const ranges = Object.fromEntries(['hdd', 'cdd'].map((f) => [f, [Math.min(...points.map((p) => p[f])), Math.max(...points.map((p) => p[f]))]]));
  const se = Math.sqrt(sse / Math.max(1, points.length - k));
  // Standard errors from the diagonal of (XᵀX)⁻¹ · s².
  const inv = Array.from({ length: k }, (_, j) => solve(A, Array.from({ length: k }, (_, i) => (i === j ? 1 : 0))));
  const coefSE = inv.every(Boolean) ? inv.map((col, j) => Math.sqrt(Math.max(0, col[j])) * se) : null;
  // Variance of a summed prediction over many days: x̄ᵀ(XᵀX)⁻¹x̄·s², where x̄ is the summed feature row.
  const predVar = (rows) => {
    if (!inv.every(Boolean)) return 0;
    const xs = Array.from({ length: k }, (_, i) => sum(rows.map((p) => (i === 0 ? 1 : p[feats[i - 1]] ?? 0))));
    return Math.max(0, sum(xs.map((a, i) => a * sum(xs.map((b, j) => inv[j][i] * b))))) * se * se;
  };
  return { feats, coef, coefSE, se, n: points.length, r2: sst > 0 ? 1 - sse / sst : 0, predict, predVar, ranges };
}

/**
 * Weather-adjusted comparison. Baseline: up to a year of complete days before `baselineEnd` (default: the change date),
 * modelled as kWh/day = a + b·HDD + c·CDD + d·weekend. Comparison window: `changeDate` up to (not including) `endDate`.
 */
export function evaluateSavings({ usage, temps, changeDate, tariff, endDate = '', baselineEnd = '' }) {
  if (!changeDate) return { status: 'no_change_date', message: 'Set the date you started following the new schedule.' };
  const bEnd = baselineEnd || changeDate;
  const yearBefore = new Date(Date.parse(`${bEnd}T12:00:00Z`) - 365 * 864e5).toISOString().slice(0, 10);
  const days = dailyTotals(usage)
    .filter((d) => d.complete && Number.isFinite(temps?.[d.date]))
    .map((d) => ({ ...d, ...degreeDays(temps[d.date]), wkend: isWeekendDate(d.date) ? 1 : 0 }));
  const before = days.filter((d) => d.date < bEnd && d.date >= yearBefore), after = days.filter((d) => d.date >= changeDate && (!endDate || d.date < endDate));
  if (before.length < 14 || after.length < 7) {
    return { status: 'insufficient', before: before.length, after: after.length, message: `Need at least 14 days before and 7 days after the change with both usage and outdoor temperature (have ${before.length} and ${after.length}).` };
  }
  const model = fitBaseline(before, ['hdd', 'cdd', 'wkend']);
  if (!model) return { status: 'insufficient', before: before.length, after: after.length, message: 'The baseline period could not be modelled.' };
  const predicted = sum(after.map(model.predict)), actual = sum(after.map((d) => d.kwh)), diff = predicted - actual;
  // 95% band: day-to-day noise plus baseline-coefficient uncertainty.
  // ponytail: ignores autocorrelation between neighbouring days, so it is still somewhat optimistic. Upgrade: block bootstrap.
  const unc = 1.96 * Math.sqrt(model.se ** 2 * after.length + model.predVar(after));
  const status = diff > unc ? 'likely_savings' : diff < -unc ? 'likely_increase' : 'inconclusive';
  const rate = energyCost(1, tariff);
  const caveats = ['Weather-adjusted comparison, not proof of cause: guests, new appliances, travel or building changes also move usage.'];
  const outside = after.filter((d) => model.feats.filter((f) => f !== 'wkend').some((f) => d[f] < model.ranges[f][0] - 2 || d[f] > model.ranges[f][1] + 2)).length;
  if (outside) caveats.push(`${outside} day(s) after the change were colder or hotter than anything in the baseline, so the model is extrapolating.`);
  if (model.r2 < 0.3) caveats.push('Outdoor temperature explains little of your baseline usage, so HVAC may be a small share of this meter.');
  return {
    status, before: before.length, after: after.length, predicted, actual, diff, unc, pct: (diff / predicted) * 100,
    dollars: rate != null ? diff * rate : null, dollarsUnc: rate != null ? unc * rate : null,
    model: { feats: model.feats, r2: model.r2, se: model.se }, caveats,
  };
}

/**
 * How this home's daily electricity responds to outdoor temperature, from matched real days.
 * Returns status 'learning' until `minDays` complete days with both usage and observed weather exist —
 * nothing is estimated before then.
 */
export function energyWeatherModel(usage, temps, minDays = 30) {
  const days = dailyTotals(usage)
    .filter((d) => d.complete && Number.isFinite(temps?.[d.date]))
    .map((d) => ({ date: d.date, kwh: d.kwh, temp: temps[d.date], ...degreeDays(temps[d.date]) }));
  const bins = {};
  for (const d of days) {
    const lo = Math.floor(d.temp / 10) * 10;
    (bins[lo] ||= { lo, n: 0, sum: 0 });
    bins[lo].n++;
    bins[lo].sum += d.kwh;
  }
  const out = { n: days.length, need: minDays, days, bins: Object.values(bins).sort((a, b) => a.lo - b.lo).map((b) => ({ lo: b.lo, n: b.n, avg: b.sum / b.n })) };
  const m = days.length >= minDays ? fitBaseline(days) : null;
  if (!m || !m.coefSE) return { ...out, status: 'learning' };
  const term = (f) => { const i = m.feats.indexOf(f) + 1; return i ? { per: m.coef[i], ci: 1.96 * m.coefSE[i] } : null; };
  return { ...out, status: 'ready', r2: m.r2, se: m.se, base: { per: m.coef[0], ci: 1.96 * m.coefSE[0] }, heat: term('hdd'), cool: term('cdd'), predict: m.predict };
}
