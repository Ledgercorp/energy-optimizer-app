// Turns state + data into decisions and plain-English findings. Pure functions; no DOM, no network.
import * as C from './core.js';

export const STATE_VERSION = 2;

/** Load any saved/backup state (v1 or v2) without losing settings, usage, readings or temperatures. */
export function migrate(raw) {
  const s = C.mergeState(raw);
  const p = raw && typeof raw === 'object' ? raw.programmed : null;
  s.programmed = p && typeof p.fingerprint === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? { fingerprint: p.fingerprint.slice(0, 4000), date: p.date } : null;
  // Every "I programmed it" confirmation, oldest first. Older saves only kept the latest, so seed from that.
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const h = raw && Array.isArray(raw.programmedHistory) ? raw.programmedHistory : null;
  if (h) {
    s.programmedHistory = h.filter((e) => e && isDate(e.date)).slice(-100).map((e) => ({
      date: e.date, fingerprint: typeof e.fingerprint === 'string' ? e.fingerprint.slice(0, 4000) : null,
      changes: Array.isArray(e.changes) ? e.changes.filter((c) => typeof c === 'string').slice(0, 6).map((c) => c.slice(0, 200)) : [],
    }));
  } else {
    s.programmedHistory = [];
    const cd = s.profile.changeDate;
    if (isDate(cd) && (!s.programmed || cd < s.programmed.date)) s.programmedHistory.push({ date: cd, fingerprint: null, changes: [s.programmed ? 'Earlier schedule (details weren’t recorded)' : 'Schedule start date you entered'] });
    if (s.programmed) s.programmedHistory.push({ date: s.programmed.date, fingerprint: s.programmed.fingerprint, changes: [] });
  }
  // Investigation answers, actions you tried, and next-apartment zones (local only; carried in backups).
  const arr = (v) => (Array.isArray(v) ? v : []), str = (v, n) => String(v ?? '').slice(0, n);
  s.answers = arr(raw?.answers).filter((a) => a && QUESTIONS[a.q] && typeof a.value === 'string' && QUESTIONS[a.q].options.some(([k]) => k === a.value) && isDate(a.at))
    .slice(-200).map((a) => ({ q: a.q, key: str(a.key, 80), value: a.value, at: a.at, since: isDate(a.since) ? a.since : '' }));
  s.actions = arr(raw?.actions).filter((a) => a && typeof a.id === 'string' && ACTION_STATUS[a.status]).slice(-50).map((a) => ({
    id: str(a.id, 80), key: str(a.key, 80), title: str(a.title, 200), status: a.status, at: isDate(a.at) ? a.at : '', start: isDate(a.start) ? a.start : '',
    hours: Array.isArray(a.hours) && a.hours.length === 2 && a.hours.every((h) => Number.isInteger(h) && h >= 0 && h <= 24) ? a.hours : null }));
  const HV = ['unknown', 'heat_pump', 'electric_resistance', 'fan_coil', 'gas_or_boiler', 'other'], MET = ['unknown', 'yes', 'partial', 'no'];
  const temp = (t, d) => ({ home: Number.isFinite(t?.home) ? t.home : d.home, away: Number.isFinite(t?.away) ? t.away : d.away, sleep: Number.isFinite(t?.sleep) ? t.sleep : d.sleep });
  const dc = C.defaultState().profile.comfort;
  s.zones = arr(raw?.zones).slice(0, 4).filter((z) => z && typeof z.id === 'string').map((z) => ({
    id: str(z.id, 20), label: str(z.label, 40) || 'Zone', hvacType: HV.includes(z.hvacType) ? z.hvacType : 'unknown', availability: z.availability in C.BUILDING_MODES ? z.availability : 'unknown',
    use: str(z.use, 60), metered: MET.includes(z.metered) ? z.metered : 'unknown', heat: temp(z.heat, dc.heat), cool: temp(z.cool, dc.cool) }));
  s.moveIn = isDate(raw?.moveIn) ? raw.moveIn : '';
  s.bills = cleanBills(raw?.bills);
  const legacy = raw?.projection && isMoney(+raw.projection.amount) && isIso(raw.projection.periodEnd) ? [{ amount: +raw.projection.amount, periodEnd: raw.projection.periodEnd, shownOn: raw.projection.asOf, source: 'entered by you' }] : [];
  s.projections = cleanProjections([...arr(raw?.projections), ...legacy.filter((l) => !arr(raw?.projections).some((p) => p.amount === l.amount && p.periodEnd === l.periodEnd))]);
  s.projection = null; // superseded by `projections`; kept so older code and backups still load
  if (isMoney(+raw?.projection?.amount) && !isIso(raw?.projection?.periodEnd)) s.projection = cleanProjection(raw.projection);
  s.experiments = cleanExperiments(raw?.experiments);
  const th = cleanThermostat(raw?.profile?.thermostat);
  if (th) s.profile.thermostat = th; else delete s.profile.thermostat;
  s.notes = arr(raw?.notes).filter((n) => n && typeof n.text === 'string' && isIso(n.at)).slice(-40).map((n) => ({ text: str(n.text, 300), at: n.at }));
  const ub = raw?.profile?.usualBill;
  if (ub && Number.isFinite(+ub.low) && Number.isFinite(+ub.high) && +ub.low > 0 && +ub.high >= +ub.low && +ub.high < 10000) s.profile.usualBill = { low: +ub.low, high: +ub.high, source: 'you' }; else delete s.profile.usualBill; // Number.isFinite(+ub.low) && Number.isFinite(+ub.high) && +ub.low > 0 && +ub.high >= +ub.low && +ub.high < 10000 ? { low: +ub.low, high: +ub.high, source: 'you' } : null;
  s.appliedUpdates = arr(raw?.appliedUpdates).filter((x) => typeof x === 'string').slice(-20).map((x) => x.slice(0, 60));
  s.version = STATE_VERSION;
  return s;
}

/** Identifies a recommended weekly schedule, so the app knows whether the thermostat was programmed with it. */
export const planFingerprint = (plans) => JSON.stringify(plans.map((p) => [p.mode, ...['weekday', 'weekend'].map((k) => p[k].map((d) => [d.start, d.temp])), ...(p.daysMode ? [C.DOW.map((d) => p.days[d].map((x) => [x.start, x.temp]))] : [])]));

/**
 * What the Today screen should lead with.
 * kind: setup | off | error | program (never programmed) | update (programmed an older plan) | ok
 * The app cannot see the thermostat, so "ok" means "you programmed the current recommendation", nothing more.
 */
export function todayStatus(state, rec) {
  const su = setupInfo(state);
  if (!su.complete) return { kind: 'setup', missing: su.missing };
  if (holdsSteady(state)) return { kind: 'hold', thermostat: state.profile.thermostat };
  if (rec.errors.length) return { kind: 'error', message: rec.errors[0] };
  if (!rec.plans.length) return { kind: 'off' };
  const same = state.programmed?.fingerprint === planFingerprint(rec.plans);
  return { kind: same ? 'ok' : state.programmed ? 'update' : 'program', programmedOn: state.programmed?.date ?? null };
}

/** Short reasons for the current recommendation. */
export function whyNow(state, rec) {
  const p = state.profile, out = [];
  for (const c of rec.current) {
    const pl = rec.plans.find((x) => x.mode === c.mode);
    const sp = pl.setpoints;
    const word = c.mode === 'heat' ? 'heating' : 'cooling';
    if (c.temp === sp.away && sp.away !== sp.home && c.period === 'Day') out.push(`Nobody is home during the day on ${C.localParts(Date.now()).weekday === 'Sat' || C.localParts(Date.now()).weekday === 'Sun' ? 'this weekend day' : 'weekdays'}, so ${word} eases off to ${c.temp}° instead of ${sp.home}°.`);
    else if (c.period === 'Night' && sp.sleep !== sp.home) out.push(`Overnight ${word} is set to ${sp.sleep}° while you sleep.`);
    else out.push(`${c.temp}° is your comfortable ${c.mode === 'heat' ? 'heating' : 'cooling'} temperature while you’re home.`);
    out.push(...pl.notes);
  }
  if ((p.recoveryMin || 0) > 0) out.push(`Morning and evening start ${p.recoveryMin} minutes early so the apartment is comfortable when you need it.`);
  out.push('A stable weekly schedule does the work every day — no daily reprogramming needed.');
  return [...new Set(out)];
}

/** One-screen-at-a-time instructions for entering the whole weekly schedule on the IT900 (Delmarva manual DDWMAN2026). */
export function programSteps(plans) {
  const steps = [{ kind: 'intro' }, { kind: 'run', title: 'Clear any hold', lines: ['Look at the thermostat screen.', 'If it says HOLD AT, press RUN.', 'If it says SET AT, you’re ready.'] }];
  for (const pl of plans) {
    const sched = pl.mode === 'heat' ? 'Heating Schedule' : 'Cooling Schedule';
    steps.push({ kind: 'menu', mode: pl.mode, title: `Open the ${sched.toLowerCase()}`, lines: ['Press MENU.', 'Highlight Programming with ▲/▼, then press the center button.', 'Make sure Time-based Programming is On.', `Highlight ${sched} and press the center button.`, `Choose ${pl.daysMode ? 'Individual Days' : 'Weekdays/Weekends'} and press the center button.`] });
    if (pl.daysMode) {
      // Monday first, through Sunday. A day identical to the one before is one "same as" step instead of four.
      const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      order.forEach((dk, i) => {
        const day = pl.days[dk], prev = i ? pl.days[order[i - 1]] : null;
        if (i) steps.push({ kind: 'next', mode: pl.mode, title: `Switch to ${C.DAY_NAME[dk]}`, lines: ['Press NEXT.', `The screen should now show ${dk}.`] });
        if (prev && JSON.stringify(prev.map((x) => [x.start, x.temp])) === JSON.stringify(day.map((x) => [x.start, x.temp]))) {
          steps.push({ kind: 'same', mode: pl.mode, title: `${C.DAY_NAME[dk]}: same as ${C.DAY_NAME[order[i - 1]]}`, lines: day.map((d) => `${d.name}: ${C.fmtMin(d.start)}, ${d.temp}°`) });
        } else for (const d of day) steps.push({ kind: 'period', mode: pl.mode, group: C.DAY_NAME[dk], name: d.name, time: C.fmtMin(d.start), temp: d.temp, away: d.away });
      });
    } else for (const [group, day] of [['Mon–Fri', pl.weekday], ['Sat–Sun', pl.weekend]]) {
      if (group === 'Sat–Sun') steps.push({ kind: 'next', mode: pl.mode, title: 'Switch to the weekend', lines: ['Press NEXT.', 'The screen should now show Sat–Sun.'] });
      for (const d of day) steps.push({ kind: 'period', mode: pl.mode, group, name: d.name, time: C.fmtMin(d.start), temp: d.temp, away: d.away });
    }
    steps.push({ kind: 'save', mode: pl.mode, title: 'Save it', lines: ['Press DONE to save.', 'Then press HOME.'] });
  }
  steps.push({ kind: 'check' });
  return steps;
}

/** What changed between the programmed schedule (its fingerprint) and the current recommendation, in plain words. */
export function scheduleDiff(fingerprint, plans) {
  let old;
  try { old = JSON.parse(fingerprint); } catch { return []; }
  if (!Array.isArray(old)) return [];
  const word = (m) => (m === 'heat' ? 'Heating' : 'Cooling');
  const out = [];
  for (const pl of plans) {
    const o = old.find((x) => x[0] === pl.mode);
    if (!o) { out.push(`${word(pl.mode)} schedule is new (the building season changed)`); continue; }
    [['weekday', 'Weekdays', 1], ['weekend', 'Weekends', 2]].forEach(([k, label, idx]) => {
      pl[k].forEach((d, i) => {
        const [os, ot] = o[idx]?.[i] || [];
        if (os !== d.start) out.push(`${label} ${d.name.toLowerCase()} now starts ${C.fmtMin(d.start)} (was ${os == null ? '—' : C.fmtMin(os)})`);
        if (ot !== d.temp) out.push(`${label} ${d.name.toLowerCase()}: ${d.temp}° (was ${ot ?? '—'}°)`);
      });
    });
  }
  for (const o of old) if (!plans.some((p) => p.mode === o[0])) out.push(`${word(o[0])} schedule is no longer needed`);
  for (const pl of plans) {
    const o = old.find((x) => x[0] === pl.mode);
    if (!o) continue;
    if (pl.daysMode && !o[3]) out.push(`${word(pl.mode)}: now set day by day (Individual Days)`);
    else if (pl.daysMode && JSON.stringify(o[3]) !== JSON.stringify(C.DOW.map((d) => pl.days[d].map((x) => [x.start, x.temp])))) out.push(`${word(pl.mode)}: some individual days changed`);
    else if (!pl.daysMode && o[3]) out.push(`${word(pl.mode)}: back to Weekdays/Weekends`);
  }
  return out.length > 4 ? [...out.slice(0, 3), `and ${out.length - 3} more changes`] : out;
}

/** If the forecast suggests the building may have switched seasons, return the season to ask about. */
export function seasonHint(profile, outlook) {
  const d = outlook.filter((x) => x.hours >= 20).slice(0, 3);
  if (d.length < 2) return null;
  const hi = d.reduce((s, x) => s + x.high, 0) / d.length, lo = d.reduce((s, x) => s + x.low, 0) / d.length;
  if (profile.buildingMode === 'heat_available' && hi >= 78) return 'cool_available';
  if (profile.buildingMode === 'cool_available' && lo <= 45) return 'heat_available';
  return null;
}

/** Days that used much more than the weather model expects (only once the model is trustworthy). */
export function unusualDays(model, recentDays = 45) {
  if (model.status !== 'ready') return [];
  const last = model.days.slice(-recentDays);
  return last.map((d) => ({ ...d, expected: model.predict(d) }))
    .filter((d) => d.expected > 0 && d.kwh - d.expected > Math.max(2.5 * model.se, 0.25 * d.expected))
    .sort((a, b) => (b.kwh - b.expected) - (a.kwh - a.expected)).slice(0, 2);
}

const wRange = (lo, hi) => (fmt(Math.max(lo, hi)) === fmt(lo) ? fmt(lo) : `${fmt(lo)}–${fmt(Math.max(lo, hi))}`);
const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const dayName = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * Plain-English findings, each only when the data supports it.
 * @returns {{tone:'good'|'warn'|'info', title:string, detail:string}[]}
 */
export function buildInsights({ state, temps, now = Date.now() }) {
  const p = state.profile;
  const r = usageReport({ state, temps, now });
  if (r.level === 'none') return [];
  const out = r.findings.map(({ tone, title, detail, prelim }) => ({ tone, title, detail, prelim }));
  const sv = savingsReport({ usage: state.usage, temps, tariff: p.tariff, hvacMetered: p.hvacMetered, history: state.programmedHistory, changeDate: p.changeDate });
  const w = sv.weather, from = sv.timeline.baselineEnd;
  if (sv.status === 'no_change_date') out.push({ tone: 'info', title: 'Savings tracking starts when you program the schedule', detail: 'Use the guided programming on Today; the app then compares your use with what the weather would predict.' });
  else if (sv.status === 'insufficient') out.push({ tone: 'info', title: 'Not enough data yet to tell whether the new schedule saves energy', detail: `Needs 14 days before and 7 after ${dayName(from)} with usage and weather (have ${sv.before ?? 0} and ${sv.after ?? 0}).` });
  else if (sv.status === 'likely_savings') out.push({ tone: 'good', title: 'Use is lower than the weather predicts since the schedule change', detail: `About ${fmt(w.diff)} kWh (${fmt(w.pct, 1)}%) less over ${w.days} days (95% range ±${fmt(w.unc)} kWh). Consistent with the new schedule helping, but not proof — other changes at home also count.` });
  else if (sv.status === 'likely_increase') out.push({ tone: 'warn', title: 'Use went up after the schedule change', detail: `About ${fmt(-w.diff)} kWh more than the weather predicts over ${w.days} days (±${fmt(w.unc)}). Other changes at home can cause this.` });
  else if (sv.status === 'inconclusive') out.push({ tone: 'info', title: 'No clear change since the new schedule', detail: `The difference (${fmt(w.diff)} kWh over ${w.days} days) is within normal variation (±${fmt(w.unc)}). More days will sharpen this.` });

  return out;
}

// ================= Household electricity analysis =================
// Runs only on this device. Nothing here estimates a missing reading: incomplete or absent days are reported and left out, never filled in.

const sum = (a) => a.reduce((s, v) => s + v, 0);
const avg = (a) => (a.length ? sum(a) / a.length : null);
const DAY = 864e5;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const between = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
const md = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const range = (r) => (r.n === 1 ? md(r.from) : `${md(r.from)}–${md(r.to)}`);

/** Group sorted ISO dates into consecutive runs. */
function runs(dates) {
  const out = [];
  for (const d of dates) {
    const last = out[out.length - 1];
    if (last && addDays(last.to, 1) === d) { last.to = d; last.n++; } else out.push({ from: d, to: d, n: 1 });
  }
  return out;
}

/** Days with usage and outdoor temperature, ready for weather comparisons. */
export function matchedDays(usage, temps) {
  return C.dailyTotals(usage)
    .filter((d) => d.complete && Number.isFinite(temps?.[d.date]))
    .map((d) => ({ ...d, temp: temps[d.date], ...C.degreeDays(temps[d.date]), wkend: C.isWeekendDate(d.date) ? 1 : 0 }));
}

// ---------- data quality ----------

/** What electricity data exists, what is missing or partial, and what that means for the results. `today` is YYYY-MM-DD. */
export function dataQuality(usage, temps, today) {
  const all = C.dailyTotals(usage);
  if (!all.length) return { status: 'none', notes: ['No electricity data yet. Nothing is estimated until you import a Delmarva file.'] };
  const from = all[0].date, to = all[all.length - 1].date;
  const have = new Set(all.map((d) => d.date));
  const missingDates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!have.has(d)) missingDates.push(d);
  const missing = runs(missingDates);
  const complete = all.filter((d) => d.complete);
  const incomplete = all.filter((d) => !d.complete).map((d) => ({ date: d.date, hours: d.hours }));
  const hourlyDays = new Set(Object.keys(usage.hourly || {}).map((k) => k.slice(0, 10))).size;
  const noWeather = complete.filter((d) => !Number.isFinite(temps?.[d.date]) && d.date < today).length;
  const costDays = all.filter((d) => d.cost != null).length;
  const ageDays = between(to, today);
  const notes = [];
  notes.push(`${fmt(complete.length)} full day${complete.length === 1 ? '' : 's'} from ${md(from)} to ${md(to)}${hourlyDays ? `, ${hourlyDays === all.length ? 'all' : fmt(hourlyDays)} with hourly detail` : ', daily totals only'}.`);
  if (missingDates.length) notes.push(`No readings for ${fmt(missingDates.length)} day${missingDates.length === 1 ? '' : 's'} (${missing.slice(0, 3).map(range).join(', ')}${missing.length > 3 ? `, and ${missing.length - 3} more gaps` : ''}). Those days are left out — nothing is filled in.`);
  if (incomplete.length) notes.push(`${fmt(incomplete.length)} day${incomplete.length === 1 ? ' has' : 's have'} only part of the day (${incomplete.slice(-2).map((d) => `${md(d.date)}: ${d.hours} of 24 hours`).join('; ')}). Partial days are left out of daily comparisons.`);
  if (noWeather) notes.push(`${fmt(noWeather)} day${noWeather === 1 ? ' has' : 's have'} no outdoor temperature yet, so ${noWeather === 1 ? 'it is' : 'they are'} left out of weather-adjusted results.`);
  if (ageDays > 14) notes.push(`Newest reading is ${fmt(ageDays)} days old. Import a newer file to keep results current.`);
  const attention = missingDates.length || incomplete.length > 1 || noWeather || ageDays > 14;
  return { status: attention ? 'attention' : 'ok', from, to, days: all.length, complete: complete.length, hourlyDays, missing, missingDays: missingDates.length, incomplete, noWeather, costDays, ageDays, notes };
}

/** What an import changed, for the confirmation message. `before`/`after` are stored usage; `res` is the importer result. */
export function importSummary(before, after, res) {
  const dates = [...new Set(res.records.map((r) => r.date))].sort();
  const b = new Map(C.dailyTotals(before).map((d) => [d.date, d])), a = new Map(C.dailyTotals(after).map((d) => [d.date, d]));
  let added = 0, updated = 0, same = 0;
  for (const d of dates) {
    const o = b.get(d), n = a.get(d);
    if (!o) added++;
    else if (Math.abs(o.kwh - n.kwh) > 1e-6 || o.hours !== n.hours) updated++;
    else same++;
  }
  const parts = [`${dates.length ? `${md(dates[0])}–${md(dates[dates.length - 1])}` : 'no dates'}: ${added} new day${added === 1 ? '' : 's'}`];
  if (updated) parts.push(`${updated} updated`);
  if (same) parts.push(`${same} already imported`);
  if (res.duplicates) parts.push(`${res.duplicates} repeated reading${res.duplicates === 1 ? '' : 's'} ignored`);
  if (res.conflicts?.length) parts.push(`${res.conflicts.length} day${res.conflicts.length === 1 ? '' : 's'} had conflicting readings (first kept)`);
  if (res.skipped) parts.push(`${res.skipped} unreadable row${res.skipped === 1 ? '' : 's'} skipped`);
  for (const n of res.notes || []) parts.push(n);
  return { from: dates[0], to: dates[dates.length - 1], added, updated, same, message: parts.join(', ') };
}

// ---------- comparisons ----------

/**
 * Recent days vs. earlier days of the same kind (weekday/weekend) with similar outdoor temperature (±tol °F).
 * Model-free: each recent day is compared with the average of its matches. Only days with ≥ minMatches matches count.
 */
export function similarWeather(usage, temps, { window = 14, tol = 3, minMatches = 3 } = {}) {
  const days = matchedDays(usage, temps);
  const recent = days.slice(-window);
  if (recent.length < 7) return { status: 'insufficient', reason: `Needs at least 7 recent days with usage and weather (have ${recent.length}).` };
  const earlier = days.filter((d) => d.date < recent[0].date);
  const used = new Set(), pairs = [];
  for (const d of recent) {
    const m = earlier.filter((e) => e.wkend === d.wkend && Math.abs(e.temp - d.temp) <= tol);
    if (m.length < minMatches) continue;
    m.forEach((e) => used.add(e.date));
    pairs.push({ date: d.date, kwh: d.kwh, temp: d.temp, expected: avg(m.map((e) => e.kwh)) });
  }
  if (pairs.length < 7) return { status: 'insufficient', reason: `Only ${pairs.length} of the last ${recent.length} days have at least ${minMatches} earlier days with similar weather. More history will fill this in.` };
  const diffs = pairs.map((p) => p.kwh - p.expected), md0 = avg(diffs);
  const sd = Math.sqrt(sum(diffs.map((x) => (x - md0) ** 2)) / Math.max(1, diffs.length - 1));
  const actual = sum(pairs.map((p) => p.kwh)), expected = sum(pairs.map((p) => p.expected));
  const pct = expected > 0 ? ((actual - expected) / expected) * 100 : 0;
  const meaningful = Math.abs(md0) > 2 * (sd / Math.sqrt(diffs.length)) && Math.abs(pct) >= 5;
  return {
    status: 'ok', n: pairs.length, from: pairs[0].date, to: pairs[pairs.length - 1].date, matched: used.size, tol,
    actualAvg: actual / pairs.length, expectedAvg: expected / pairs.length, tempAvg: avg(pairs.map((p) => p.temp)), pct, meaningful,
    direction: !meaningful ? 'same' : pct < 0 ? 'lower' : 'higher', pairs,
  };
}

/** The 3-hour stretch with the most use in an average day. */
export function peakWindow(hourProfile) {
  if (!hourProfile) return null;
  const total = sum(hourProfile);
  if (!(total > 0)) return null;
  let best = 0;
  for (let h = 1; h <= 21; h++) if (sum(hourProfile.slice(h, h + 3)) > sum(hourProfile.slice(best, best + 3))) best = h;
  const w = sum(hourProfile.slice(best, best + 3));
  return { start: best, end: best + 3, kwh: w, share: w / total };
}

/** Measured kWh, charges from the utility file, and an energy-only estimate from a confirmed rate — kept separate. */
export function costBreakdown(days, tariff) {
  const kwh = sum(days.map((d) => d.kwh));
  const billed = days.length && days.every((d) => d.cost != null) ? sum(days.map((d) => d.cost)) : null;
  const rate = C.energyCost(1, tariff);
  return { days: days.length, kwh, billed, estimated: rate != null ? kwh * rate : null, rate };
}

// ---------- schedule history ----------

/**
 * Turn "I programmed it" confirmations into periods. Re-confirming the same schedule is not a change.
 * The app can't see the thermostat, so each period starts on the day the user said they programmed it.
 */
export function scheduleTimeline(history, changeDate = '') {
  const list = (history || []).filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h?.date || '')).map((h, i) => ({ ...h, i }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.i - b.i));
  const conflicts = [];
  const byDate = [];
  for (const h of list) {
    const last = byDate[byDate.length - 1];
    if (last && last.date === h.date) {
      if (last.fingerprint !== h.fingerprint) conflicts.push(`On ${md(h.date)} two different schedules were marked as programmed; the later one is used.`);
      byDate[byDate.length - 1] = h;
    } else byDate.push(h);
  }
  const segs = [];
  for (const h of byDate) {
    const last = segs[segs.length - 1];
    if (last && h.fingerprint && last.fingerprint === h.fingerprint) continue; // re-confirmation
    segs.push({ from: h.date, fingerprint: h.fingerprint ?? null, changes: h.changes || [] });
  }
  if (!segs.length && changeDate) segs.push({ from: changeDate, fingerprint: null, changes: [] });
  if (!segs.length) return { segments: [], conflicts, baselineEnd: '' };
  const baselineEnd = changeDate || segs[0].from;
  if (changeDate && changeDate !== segs[0].from) conflicts.push(`Your start date (${md(changeDate)}) differs from the first time you marked the schedule as programmed (${md(segs[0].from)}); days before ${md(changeDate)} count as before the change.`);
  const kept = segs.map((s, i) => ({ ...s, to: segs[i + 1]?.from || '' })).filter((s) => !s.to || s.to > baselineEnd)
    .map((s) => ({ ...s, from: s.from < baselineEnd ? baselineEnd : s.from }));
  return { segments: kept, conflicts, baselineEnd };
}

// ---------- savings ----------

const METER = {
  yes: null,
  partial: 'You said only the fan is on your meter, so most heating or cooling energy (and any savings) is billed to the building.',
  no: 'You said heating and cooling are not on your meter. Thermostat changes can save building energy but are not expected to change your bill; differences here come from other uses.',
  unknown: 'It isn’t confirmed whether heating and cooling are on your meter. If they aren’t, thermostat changes won’t show on this bill.',
};

/**
 * Savings, with each kind of number kept apart:
 * actual (measured kWh), billed (from the utility file), estimated cost (confirmed rate × kWh),
 * weather-adjusted change, estimated savings vs. the defined baseline, and the uncertainty and limitations.
 */
export function savingsReport({ usage, temps, tariff, hvacMetered = 'unknown', history = [], changeDate = '' }) {
  const tl = scheduleTimeline(history, changeDate);
  const inputs = [];
  const days = matchedDays(usage, temps);
  const allDays = C.dailyTotals(usage).filter((d) => d.complete);
  inputs.push({ ok: allDays.length >= 21, label: 'Electricity data', detail: allDays.length ? `${allDays.length} full days, through ${md(allDays[allDays.length - 1].date)}` : 'Import your Delmarva file on Insights' });
  inputs.push({ ok: !!tl.segments.length, label: 'A confirmed schedule change', detail: tl.segments.length ? `You marked the schedule as programmed on ${md(tl.segments[0].from)}` : 'Recorded when you finish guided programming and tap “Done — it’s programmed”' });
  if (!tl.segments.length) return { status: 'no_change_date', inputs, timeline: tl, limitations: [], message: 'Savings are measured from the day you confirm the thermostat schedule was programmed.' };
  const start = tl.baselineEnd;
  const ev = C.evaluateSavings({ usage, temps, changeDate: start, tariff });
  const before = days.filter((d) => d.date < start).length, after = days.filter((d) => d.date >= start).length;
  inputs.push({ ok: (ev.before ?? before) >= 14 && (ev.after ?? after) >= 7, label: 'Enough days on both sides', detail: `${ev.before ?? before} days before (14 needed) and ${ev.after ?? after} after (7 needed), each with outdoor temperature` });
  inputs.push({ ok: tariff?.confirmed && tariff.centsPerKwh > 0, label: 'Your energy rate (optional)', detail: tariff?.confirmed ? `${tariff.centsPerKwh}¢ per kWh, from your bill` : 'Needed only for dollar estimates — Settings → Advanced' });
  inputs.push({ ok: hvacMetered === 'yes', label: 'Heating/cooling on your meter', detail: { yes: 'Yes', partial: 'Partly (fan only)', no: 'No — the building pays', unknown: 'Not confirmed' }[hvacMetered] || 'Not confirmed' });

  const afterDays = allDays.filter((d) => d.date >= start);
  const actual = { kwh: sum(afterDays.map((d) => d.kwh)), days: afterDays.length, from: afterDays[0]?.date, to: afterDays[afterDays.length - 1]?.date };
  const cost = costBreakdown(afterDays, tariff);
  const limitations = [...tl.conflicts];
  if (METER[hvacMetered]) limitations.push(METER[hvacMetered]);
  const base = { inputs, timeline: tl, actual, billed: cost.billed, estimatedCost: cost.estimated, rate: cost.rate, limitations };
  if (!['likely_savings', 'likely_increase', 'inconclusive'].includes(ev.status)) {
    return { ...base, status: 'insufficient', before: ev.before ?? before, after: ev.after ?? after, message: ev.message };
  }
  limitations.push(...ev.caveats);
  if (ev.model.r2 < 0.3) limitations.push('The baseline explains little of the day-to-day variation, so the range is wide.');
  const segments = tl.segments.length > 1 ? tl.segments.map((s) => ({ ...s, ev: C.evaluateSavings({ usage, temps, changeDate: s.from, endDate: s.to, baselineEnd: start, tariff }) })) : [];
  return {
    ...base,
    status: ev.status,
    method: `Baseline: ${ev.before} days before ${md(start)} (up to a year), modelled as daily kWh from heating and cooling degree-days${ev.model.feats.includes('wkend') ? ' plus a weekday/weekend difference' : ''}. That model predicts what the ${ev.after} days since would have used in their actual weather.`,
    weather: { predicted: ev.predicted, actual: ev.actual, diff: ev.diff, pct: ev.pct, unc: ev.unc, days: ev.after, r2: ev.model.r2 },
    savings: { kwh: ev.diff, unc: ev.unc, dollars: ev.dollars, dollarsUnc: ev.dollarsUnc, billRelevant: hvacMetered !== 'no' },
    segments,
  };
}

// ---------- what we learned: progressive, on-device electricity report ----------

const hr = (h) => `${h % 12 || 12} ${h % 24 < 12 ? 'AM' : 'PM'}`;
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const sd = (a) => { const m = avg(a); return a.length > 1 ? Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1)) : 0; };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pctTxt = (x) => `${fmt(Math.abs(x))}% ${x >= 0 ? 'more' : 'less'}`;

/** Days (from `dates`) with at least 23 hourly readings, as 24-slot arrays (a missing DST hour counts as 0). */
function hourlyByDay(usage, dates) {
  const by = {};
  for (const [k, v] of Object.entries(usage.hourly || {})) (by[k.slice(0, 10)] ||= Array(24).fill(null))[+k.slice(11, 13)] = v;
  return dates.filter((d) => by[d] && by[d].filter((x) => x != null).length >= 23).map((d) => ({ date: d, h: by[d].map((x) => x ?? 0) }));
}
const profileOf = (hd) => (hd.length ? Array.from({ length: 24 }, (_, h) => avg(hd.map((d) => d.h[h]))) : null);
/** The 3-hour window where `a` exceeds `b` the most. */
function excessWindow(a, b) {
  let best = 0, bv = -Infinity;
  for (let h = 0; h <= 21; h++) { const v = sum([0, 1, 2].map((i) => a[h + i] - b[h + i])); if (v > bv) { bv = v; best = h; } }
  return { start: best, end: best + 3, kwh: bv };
}

/**
 * Everything the app can honestly say about the imported electricity data, from one day to many months.
 * Findings appear as soon as the data supports them; early ones are labeled preliminary. Nothing is estimated for missing days.
 */
export function usageReport({ state, temps = {}, now = Date.now() }) {
  const p = state.profile, usage = state.usage;
  const all = C.dailyTotals(usage);
  const empty = { level: 'none', findings: [], facts: [], comparisons: [], cannot: [], spikes: [], hd: [] };
  if (!all.length) return empty;
  const days = all.filter((d) => d.complete), n = days.length;
  const today = C.localParts(now).date;
  const level = n < 1 ? 'partial' : n < 3 ? 'day' : n < 14 ? 'days' : n < 60 ? 'weeks' : 'months';
  const findings = [], facts = [], cannot = [], comparisons = [];
  const add = (f) => findings.push({ tone: 'info', prelim: false, ...f });
  const last = all[all.length - 1].date, age = between(last, today);
  const readings = Object.keys(usage.hourly || {}).length + Object.keys(usage.daily || {}).length;
  const base = { level, n, from: all[0].date, to: last, readings, age };
  if (!n) {
    return { ...empty, ...base, level: 'partial', facts: [{ v: `${fmt(sum(all.map((d) => d.kwh)), 1)} kWh`, l: 'in a partial day' }], cannot: ['Daily totals and patterns — the file covers less than one full day. Download a longer date range from Delmarva.'] };
  }
  const total = sum(days.map((d) => d.kwh)), perDay = total / n;
  const rate = C.energyCost(1, p.tariff);
  const kwhMoney = (k) => (rate != null ? ` (≈ ${'$'}${fmt(k * rate, 2)})` : '');
  if (age > 14) add({ key: 'stale', tone: 'warn', title: `Your electricity data is ${age} days old`, detail: `It ends ${dayName(last)}. Import a newer Delmarva file to keep these findings current.` });

  // Time of day (needs hourly readings).
  const hd = hourlyByDay(usage, days.slice(-60).map((d) => d.date));
  const prof = profileOf(hd);
  let night = null, peak = null;
  if (prof) {
    const w = (a) => avg(a) * 1000;
    night = { w: w(prof.slice(1, 5)), base: Math.min(...prof) * 1000, eve: w(prof.slice(17, 22)), nights: hd.length };
    night.steady = night.w <= night.base * 1.25;
    peak = peakWindow(prof);
    // Always-on load: the quietest hour on mild nights (55–68°F), when heating and cooling are least likely to run.
    const mild = hourlyByDay(usage, days.map((d) => d.date)).filter((d) => temps[d.date] >= 55 && temps[d.date] <= 68).map((d) => Math.min(...d.h) * 1000);
    night.alwaysOn = mild.length >= 7 ? median(mild) : night.base;
    night.mildNights = mild.length;
  }
  facts.push({ v: `${fmt(total, total < 100 ? 1 : 0)} kWh`, l: `used in ${n} full day${n === 1 ? '' : 's'}` });
  facts.push({ v: `${fmt(perDay, 1)} kWh`, l: 'a day on average' });
  if (peak) facts.push({ v: `${hr(peak.start)}–${hr(peak.end)}`, l: 'busiest hours' });
  if (night) facts.push({ v: `${fmt(night.w)} W`, l: 'overnight draw (1–5 AM)' });
  const early = (k) => (k < 14 ? ` Early observation from ${k} day${k === 1 ? '' : 's'}.` : '');
  if (peak) {
    const homeEve = C.DOW.filter((d) => { const rr = C.routineFor(p.routine, d); return !(rr.leave && rr.back && C.toMin(rr.leave) <= peak.start * 60 && C.toMin(rr.back) > peak.start * 60); }).length >= 5;
    add({ key: 'peak', title: `Your busiest hours are ${hr(peak.start)}–${hr(peak.end)}`, detail: `${fmt(peak.share * 100)}% of a typical day’s electricity (about ${fmt(peak.kwh, 1)} kWh) is used in those three hours${homeEve ? ', when you’re usually home — cooking, lights, laundry and heating or cooling add up' : ''}.${early(hd.length)}`, prelim: hd.length < 14 });
  }
  if (night) {
    const month = (night.alwaysOn / 1000) * 24 * 30;
    add({ key: 'overnight', title: `Overnight your home draws about ${fmt(night.w)} W`, detail: `That’s what keeps running while you sleep. ${night.steady ? 'It stays steady through the night, which points to always-on devices (fridge, router, standby electronics) rather than something cycling.' : `It rises and falls during the night (lowest hour ${fmt(night.base)} W), which points to something that cycles — heating or cooling, a fridge or a dehumidifier.`} Use ${night.eve > night.w ? `drops ${fmt((1 - night.w / night.eve) * 100)}% from the evening (${fmt(night.eve)} W)` : 'is about the same as in the evening'}. ${night.mildNights >= 7 ? `On mild nights, when heating and cooling rest, the floor is about ${fmt(night.alwaysOn)} W — the truly always-on part, about ${fmt(month)} kWh a month${kwhMoney(month)}${night.alwaysOn <= 220 ? ', typical for an apartment' : ''}.` : `The always-on part alone is about ${fmt(month)} kWh a month${kwhMoney(month)}.`}${early(night.nights)}`, prelim: night.nights < 7 });
  } else cannot.push('Time-of-day patterns — your file has daily totals only. Delmarva’s “Download my data” offers hourly (or 15-minute) data; choose that for overnight and busiest-hour findings.');

  // Day to day.
  if (n >= 3 && n < 14) {
    const lo = days.reduce((a, d) => (d.kwh < a.kwh ? d : a)), hi = days.reduce((a, d) => (d.kwh > a.kwh ? d : a));
    add({ key: 'range', title: `Daily use ranged from ${fmt(lo.kwh, 1)} to ${fmt(hi.kwh, 1)} kWh`, detail: `Lowest ${dayName(lo.date)}, highest ${dayName(hi.date)}. ${hi.kwh > 1.5 * lo.kwh ? 'That’s a wide swing — routines (laundry, cooking, being home) or weather can explain it; more days will show which.' : 'Fairly consistent so far.'}${early(n)}`, prelim: true });
  }

  // Weather relationship (≥10 days with measured weather; preliminary under 30).
  const matched = matchedDays(usage, temps);
  const mm = new Map(matched.map((d) => [d.date, d]));
  const fit = matched.length >= 10 ? C.fitBaseline(matched) : null;
  let weather = null;
  if (fit) {
    const term = (f) => { const i = fit.feats.indexOf(f) + 1; return i ? { per: fit.coef[i], se: fit.coefSE?.[i] ?? Infinity } : null; };
    const real = (t) => t && t.per > 0 && t.per > 2 * t.se;
    const heat = term('hdd'), cool = term('cdd'), k = matched.length, pre = k < 30;
    const tl = Math.min(...matched.map((d) => d.temp)), th = Math.max(...matched.map((d) => d.temp));
    const note = pre ? ` Preliminary — ${k} days with measured weather; firmer after about 30.` : '';
    weather = { heat: real(heat) ? heat : null, cool: real(cool) ? cool : null, r2: fit.r2, n: k, prelim: pre };
    if (weather.heat) add({ key: 'weather', title: pre ? 'Early sign: your use rises on colder days' : 'Your electricity use rises on colder days', detail: `About ${fmt(heat.per * 10, 1)} kWh more a day for every 10°F colder than 65°F (±${fmt(1.96 * heat.se * 10, 1)}), from ${k} days between ${fmt(tl)}°F and ${fmt(th)}°F. Weather explains ${fmt(Math.max(0, fit.r2) * 100)}% of your day-to-day differences${fit.r2 >= 0.3 ? ', so heating settings matter here' : ' — a real but modest effect; other things move your use more'}.${note}`, prelim: pre });
    if (weather.cool) add({ key: 'weather', title: pre ? 'Early sign: your use rises on hotter days' : 'Your electricity use rises on hotter days', detail: `About ${fmt(cool.per * 10, 1)} kWh more a day for every 10°F hotter than 65°F (±${fmt(1.96 * cool.se * 10, 1)}), from ${k} days between ${fmt(tl)}°F and ${fmt(th)}°F. Weather explains ${fmt(Math.max(0, fit.r2) * 100)}% of your day-to-day differences${fit.r2 >= 0.3 ? ', so cooling settings matter here' : ' — a real but modest effect; other things move your use more'}.${note}`, prelim: pre });
    if (!weather.heat && !weather.cool) {
      if (!fit.feats.length || th - tl < 8) cannot.push(`How weather affects your use — outdoor temperatures have stayed between ${fmt(tl)}°F and ${fmt(th)}°F, too narrow to tell.`);
      else add({ key: 'weather', title: 'Outdoor temperature barely changes your electricity use', detail: `Across ${k} days from ${fmt(tl)}°F to ${fmt(th)}°F, temperature explains only ${fmt(Math.max(0, fit.r2) * 100)}% of the day-to-day differences.${p.hvacMetered === 'yes' ? ' Heating and cooling settings are unlikely to move your bill much.' : ' Heating and cooling may not be on your apartment’s meter — then thermostat changes won’t show on your bill.'}${note}`, prelim: pre });
    }
  } else cannot.push(`How weather affects your use — needs 10 days with measured weather (have ${matched.length}).`);

  // Unusual days (≥10 days), weather-adjusted when the weather fit is meaningful.
  let spikes = [];
  if (n >= 10) {
    const useFit = fit && fit.r2 >= 0.25;
    const ref = days.slice(-60).map((d) => d.kwh), med = median(ref), mad = (median(ref.map((x) => Math.abs(x - med))) || 0.05 * med) * 1.4826;
    spikes = days.slice(-45).map((d) => {
      const mt = useFit && mm.get(d.date);
      const expected = mt ? Math.max(0, fit.predict(mt)) : med;
      const over = (mt ? d.kwh - expected > Math.max(2.5 * fit.se, 0.25 * expected) : d.kwh - med > Math.max(3.5 * mad, 0.4 * med)) || d.kwh >= 1.6 * med;
      return over ? { date: d.date, kwh: d.kwh, expected, weatherAdjusted: !!mt } : null;
    }).filter(Boolean).sort((a, b) => (b.kwh - b.expected) - (a.kwh - a.expected)).slice(0, 2);
    for (const s of spikes) {
      const day = prof && hourlyByDay(usage, [s.date])[0];
      if (day) s.window = excessWindow(day.h, prof);
      add({ key: 'spike', tone: 'warn', title: `${dayName(s.date)} used more than usual`, detail: `${fmt(s.kwh, 1)} kWh vs. about ${fmt(s.expected, 1)} kWh ${s.weatherAdjusted ? 'expected for that day’s weather' : 'on a typical day'}.${s.window ? ` Most of the extra was between ${hr(s.window.start)} and ${hr(s.window.end)}.` : ''} Guests, laundry or cooking explain most one-off days; a repeat would be worth a look.` });
    }
  } else cannot.push(`Unusual days — needs about 10 days to know what’s typical (have ${n}).`);

  // One weekday unlike the others (≥2 of that weekday with hourly data): evenings 5–10 PM and nights 1–5 AM.
  const WDN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const wdOf = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
  const patterns = [];
  if (hd.length >= 14) {
    for (const [part, hrs, minAbs, minPct, unit] of [['evening', [17, 18, 19, 20, 21], 1, 25, 'kWh'], ['night', [1, 2, 3, 4], 0.4, 30, 'W']]) {
      const val = (d) => sum(hrs.map((h) => d.h[h]));
      for (let w = 0; w < 7; w++) {
        const mine = hd.filter((d) => wdOf(d.date) === w), rest = hd.filter((d) => wdOf(d.date) !== w);
        if (mine.length < 2 || rest.length < 6) continue;
        const a = avg(mine.map(val)), b = avg(rest.map(val)), pct = ((a - b) / b) * 100;
        if (a - b >= minAbs && pct >= minPct && mine.every((d) => val(d) > b)) patterns.push({ part, day: WDN[w], a, b, pct, n: mine.length, unit, hrs: hrs.length });
      }
    }
  }
  patterns.sort((p1, p2) => p2.pct - p1.pct);
  const shown = ['evening', 'night'].map((part) => patterns.find((x) => x.part === part)).filter(Boolean);
  for (const x of shown) {
    const show = (v) => (x.unit === 'W' ? `${fmt((v / x.hrs) * 1000)} W` : `${fmt(v, 1)} kWh`);
    add({ key: 'weekday', tone: 'warn', title: `${x.day} ${x.part === 'evening' ? 'evenings' : 'nights'} use ${fmt(x.pct)}% more than other days`, detail: `${x.part === 'evening' ? '5–10 PM' : '1–5 AM'} averages ${show(x.a)} on ${x.day}s vs. ${show(x.b)} on other days, on all ${x.n} ${x.day}s in your data. A weekly routine (laundry, guests, a device on a timer) usually explains this.` });
  }

  // Heaviest days vs. the weather (≥10 days with weather).
  if (matched.length >= 10 && weather?.heat) {
    const top = [...matched].sort((x, y) => y.kwh - x.kwh).slice(0, 3);
    const cold = [...matched].sort((x, y) => x.temp - y.temp).slice(0, Math.max(3, Math.ceil(matched.length * 0.2))).map((d) => d.date);
    const k = top.filter((d) => cold.includes(d.date)).length;
    if (k >= 2) add({ key: 'heavy', title: 'Your heaviest days were your coldest days', detail: `${k} of your 3 highest-use days (${top.map((d) => `${dayName(d.date)}: ${fmt(d.kwh, 1)} kWh at ${fmt(d.temp)}°F`).join('; ')}) were among the coldest in your data — that’s heating at work, not waste.` });
  }

  // Weekday vs weekend (≥14 days, ≥4 of each).
  const wkd = days.filter((d) => !C.isWeekendDate(d.date)), wke = days.filter((d) => C.isWeekendDate(d.date));
  let week = null;
  if (n >= 14 && wkd.length >= 4 && wke.length >= 4) {
    const a = avg(wkd.map((d) => d.kwh)), b = avg(wke.map((d) => d.kwh));
    week = { weekday: a, weekend: b, pct: ((b - a) / a) * 100 };
    if (Math.abs(week.pct) >= 10) add({ key: 'week', title: `Weekends use ${pctTxt(week.pct)} than weekdays`, detail: `${fmt(b, 1)} kWh a weekend day vs. ${fmt(a, 1)} on weekdays${week.pct > 0 ? ' — being home more usually explains it' : ''}.` });
  }

  // Recent change (≥21 days): last 7 days vs. the 4 weeks before, weather-adjusted when possible.
  let change = null;
  if (n >= 21) {
    const recent = days.slice(-7), prev = days.slice(-35, -7);
    const adj = fit && fit.r2 >= 0.25 && [...recent, ...prev].every((d) => mm.has(d.date));
    const val = (d) => (adj ? d.kwh - fit.predict(mm.get(d.date)) : d.kwh);
    const diff = avg(recent.map(val)) - avg(prev.map(val));
    const s = sd(prev.map(val)) * Math.sqrt(1 / 7 + 1 / prev.length);
    if (Math.abs(diff) > 2 * s && Math.abs(diff) >= 0.15 * perDay) {
      change = { diff, pct: (diff / avg(prev.map((d) => d.kwh))) * 100, adjusted: adj, from: recent[0].date };
      const rh = hourlyByDay(usage, recent.map((d) => d.date)), ph = hourlyByDay(usage, prev.map((d) => d.date));
      if (rh.length >= 4 && ph.length >= 7) change.window = excessWindow(diff > 0 ? profileOf(rh) : profileOf(ph), diff > 0 ? profileOf(ph) : profileOf(rh));
      add({ key: 'change', tone: diff > 0 ? 'warn' : 'good', title: `Your use ${diff > 0 ? 'rose' : 'fell'} about ${fmt(Math.abs(change.pct))}% in the last week`, detail: `${fmt(Math.abs(diff), 1)} kWh a day ${diff > 0 ? 'more' : 'less'} since ${dayName(recent[0].date)} than in the 4 weeks before${adj ? ', after allowing for the weather' : ' (not weather-adjusted)'}.${change.window ? ` The change is mostly between ${hr(change.window.start)} and ${hr(change.window.end)}.` : ''}` });
    }
  }
  if (!change) {
    const sw = similarWeather(usage, temps);
    if (sw.status === 'ok' && sw.meaningful) add({ key: 'similar', tone: sw.direction === 'lower' ? 'good' : 'warn', title: `Last ${sw.n} days: ${fmt(Math.abs(sw.pct))}% ${sw.direction} than similar-weather days`, detail: `${fmt(sw.actualAvg, 1)} kWh a day vs. ${fmt(sw.expectedAvg, 1)} on ${sw.matched} earlier days within ${sw.tol}°F (same weekday/weekend mix). A comparison, not a cause.` });
  }

  // Seasons (≥60 days): months with at least 20 full days.
  if (n >= 60) {
    const byM = {};
    for (const d of days) (byM[d.date.slice(0, 7)] ||= []).push(d);
    const months = Object.entries(byM).filter(([, v]) => v.length >= 20).map(([m, v]) => ({ m, avg: avg(v.map((d) => d.kwh)), t: avg(v.map((d) => temps[d.date]).filter(Number.isFinite)) }));
    if (months.length >= 2) {
      const hi = months.reduce((a, x) => (x.avg > a.avg ? x : a)), lo = months.reduce((a, x) => (x.avg < a.avg ? x : a));
      const mname = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      if (hi.avg > 1.15 * lo.avg) add({ key: 'season', title: `${mname(hi.m)} was your heaviest month`, detail: `${fmt(hi.avg, 1)} kWh a day vs. ${fmt(lo.avg, 1)} in ${mname(lo.m)}, your lightest — ${fmt((hi.avg / lo.avg - 1) * 100)}% more. ${(() => {
        // Does the weather direction actually explain the gap? Heating: heavier month should be colder; cooling: hotter.
        const dT = hi.t - lo.t, coolExpl = weather?.cool && dT >= 3, heatExpl = weather?.heat && dT <= -3;
        return hi.t == null || lo.t == null ? '' : coolExpl || heatExpl ? `The weather explains much of that (${fmt(hi.t)}°F vs ${fmt(lo.t)}°F average).` : `Weather doesn’t explain it: ${mname(hi.m)} averaged ${fmt(hi.t)}°F and ${mname(lo.m)} ${fmt(lo.t)}°F. Time away, guests, or a change in settings or routine are more likely.`;
      })()}` });
    }
  }

  const order = ['stale', 'change', 'weekday', 'spike', 'weather', 'heavy', 'similar', 'overnight', 'peak', 'week', 'season', 'range'];
  findings.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  comparisons.push({ ok: n >= 3, label: 'Day-to-day comparison', detail: n >= 3 ? `${n} full days` : `needs 3 days (have ${n})` });
  comparisons.push({ ok: !!prof, label: 'Time-of-day patterns', detail: prof ? `${hd.length} day${hd.length === 1 ? '' : 's'} with hourly readings` : 'needs hourly data' });
  comparisons.push({ ok: !!week, label: 'Weekdays vs. weekends', detail: week ? 'compared' : 'needs about 2 weeks' });
  comparisons.push({ ok: !!fit, label: 'Weather relationship', detail: fit ? `${matched.length} days with measured weather${matched.length < 30 ? ' (preliminary)' : ''}` : `needs 10 days with weather (have ${matched.length})` });
  comparisons.push({ ok: n >= 10, label: 'Unusual days', detail: n >= 10 ? 'checked' : 'needs about 10 days' });
  cannot.push('Which appliance uses what — the meter measures the whole home, so the app can point to times of day, not devices.');
  if (p.hvacMetered !== 'yes') cannot.push('How much of this is heating or cooling — it isn’t confirmed that they’re on your meter.');
  const others = patterns.filter((x) => !shown.includes(x));
  if (others.length) { const f = findings.find((x) => x.key === 'weekday' && x.title.includes(shown.find((y) => y.part === others[0].part)?.day)); if (f) f.detail += ` ${others.map((x) => `${x.day}s`).join(' and ')} show the same.`; }
  // Compare with this household's own history before calling anything a problem.
  const baseline = householdBaseline({ usage, temps, now });
  if (['typical', 'return_to_typical'].includes(baseline.status) && change && change.diff > 0) {
    findings.splice(findings.findIndex((f) => f.key === 'change'), 1);
    change = null;
  }
  if (baseline.status !== 'insufficient') findings.unshift({ tone: baseline.status === 'unusually_high' ? 'warn' : 'good', prelim: false, key: 'baseline', title: baseline.headline, detail: `${baseline.lines.join(' ')}${baseline.caveats.length ? ` ${baseline.caveats[0]}` : ''}` });
  return { level, n, from: all[0].date, to: last, readings, age, total, perDay, facts, findings, comparisons, cannot, hd, prof, night, peak, spikes, change, week, weather, baseline, patterns: shown, allPatterns: patterns };
}

// ---------- personalized recommendations ----------

const minutesBetween = (a, b) => ((C.toMin(b) - C.toMin(a)) + 1440) % 1440;
/** Hours nobody is home, per weekday, from the routine (per-day when set). */
export function awayHours(profile) {
  const out = {};
  for (const d of C.DOW) { const r = C.routineFor(profile.routine, d); out[d] = r.leave && r.back ? minutesBetween(r.leave, r.back) / 60 : 0; }
  return out;
}
const awaySummary = (profile) => {
  const h = awayHours(profile), days = C.DOW.filter((d) => h[d] > 0);
  const total = days.reduce((a, d) => a + h[d], 0);
  return { total, perDay: total / 7, days, text: days.length === 5 && days.every((d) => !['Sat', 'Sun'].includes(d)) ? 'weekdays' : days.length ? days.map((d) => `${C.DAY_NAME[d]}s`).join(', ') : 'never' };
};
const sigPos = (t) => t && t.per > t.ci && t.per > 0;

/**
 * Deterministic suggestions from this home's data, each answering: what to do, why, the evidence, the likely difference,
 * how confident, and whether the thermostat is involved. Setback suggestions appear only when the data shows weather-driven use.
 * Never goes outside the comfort limits or the heat-pump 2°F guard.
 * `model` is energyWeatherModel(); `summary` is usageSummary(); `report` is usageReport() (optional).
 */
export function opportunities({ state, rec, model, summary, report = null }) {
  const p = state.profile, out = [];
  const plan = (m) => rec.plans.find((x) => x.mode === m);
  const unsureSeason = p.buildingMode === 'unknown';
  const meterNote = METER[p.hvacMetered] && p.hvacMetered !== 'yes' ? ` ${METER[p.hvacMetered]}` : '';
  const rate = C.energyCost(1, p.tariff);
  const money = (k) => (rate != null ? ` (≈ ${'$'}${fmt(k * rate, 2)})` : '');
  const ready = (t) => model?.status === 'ready' && sigPos(t);
  const early = (w) => !ready(model?.[w === 'hdd' ? 'heat' : 'cool']) && report?.weather?.[w === 'hdd' ? 'heat' : 'cool'] && report.weather.n >= 14 ? report.weather[w === 'hdd' ? 'heat' : 'cool'] : null;
  const shows = (w) => ready(model?.[w === 'hdd' ? 'heat' : 'cool']) || !!early(w);
  const conf = (w) => {
    if (unsureSeason) return ['low', 'Your building’s heating/cooling season isn’t set, so this may not apply yet.'];
    if (early(w)) return ['low', 'Based on an early sign in fewer than 30 days of your data.'];
    if (p.hvacMetered === 'yes') return ['high', 'Your own data shows use rising with the weather, and HVAC is on your meter.'];
    return ['medium', 'Your own data shows use rising with the weather; whether HVAC is on your meter isn’t confirmed.'];
  };
  const per = (w) => (ready(model?.[w === 'hdd' ? 'heat' : 'cool']) ? model[w === 'hdd' ? 'heat' : 'cool'].per : early(w)?.per);
  const est = (w, deg, hours) => (per(w) ? per(w) * deg * (hours / 24) * 30 : null);
  const evidence = (w, word) => `In your data (${ready(model?.[w === 'hdd' ? 'heat' : 'cool']) ? model.n : report.weather.n} days), each 1°F ${word} outside adds about ${fmt(per(w), 2)} kWh a day.`;
  const push = (o) => out.push({ reprogram: false, est: null, impact: o.est ? `About ${fmt(o.est)} kWh a month${money(o.est)} — an estimate from your data, not a measurement.` : null, ...o });

  const held = holdsSteady(state); // the household holds one temperature on purpose: no schedule setbacks are suggested
  const heat = plan('heat');
  if (heat && shows('hdd') && !held) {
    const sp = heat.setpoints, hp = p.hvacType === 'heat_pump' || p.hvacType === 'unknown';
    const lim = hp ? 2 : 6, aw = awaySummary(p);
    const awayT = Math.max(p.comfort.min, sp.home - lim);
    if (aw.total >= 12 && sp.away > awayT) { // a setback for a few hours a week isn't worth the comfort and recovery cost
      const [c, cw] = conf('hdd');
      push({ id: 'heat-away', what: `Lower the away heat to ${awayT}° (now ${sp.away}°)`, why: `Nobody is home about ${fmt(aw.total)} hours a week (${aw.text}), and your use climbs on cold days, so heat while the apartment is empty costs you.${hp ? ' Kept to 2°F below Home because larger heat-pump setbacks can trigger costlier auxiliary heat (Delmarva’s thermostat manual).' : ''}${meterNote}`, evidence: evidence('hdd', 'colder'), confidence: c, confidenceWhy: cw, reprogram: true, est: est('hdd', sp.away - awayT, aw.perDay), apply: { k: 'profile.comfort.heat.away', v: awayT, label: 'Away heating' } });
    }
    const sleepT = Math.max(p.comfort.min, sp.home - Math.min(lim, 4));
    const sleepH = avg(C.DOW.map((d) => { const r = C.routineFor(p.routine, d); return minutesBetween(r.sleep, r.wake) / 60; }));
    if (sp.sleep > sleepT) {
      const [c, cw] = conf('hdd');
      push({ id: 'heat-sleep', what: `Lower the overnight heat to ${sleepT}° (now ${sp.sleep}°)`, why: `About ${fmt(sleepH)} hours asleep each night; many people sleep comfortably a few degrees cooler. Comfort comes first — skip this if you sleep cold.${meterNote}`, evidence: evidence('hdd', 'colder'), confidence: c, confidenceWhy: cw, reprogram: true, est: est('hdd', sp.sleep - sleepT, sleepH), apply: { k: 'profile.comfort.heat.sleep', v: sleepT, label: 'Sleep heating' } });
    }
  }
  const cool = plan('cool');
  const coolOk = !held;
  if (cool && shows('cdd') && coolOk) {
    const sp = cool.setpoints, aw = awaySummary(p);
    const awayT = Math.min(p.comfort.max, sp.home + 4);
    if (aw.total >= 12 && sp.away < awayT) {
      const [c, cw] = conf('cdd');
      push({ id: 'cool-away', what: `Raise the away cooling to ${awayT}° (now ${sp.away}°)`, why: `Nobody is home about ${fmt(aw.total)} hours a week (${aw.text}) and your use climbs on hot days; the AC can rest and catch up before you’re back.${meterNote}`, evidence: evidence('cdd', 'hotter'), confidence: c, confidenceWhy: cw, reprogram: true, est: est('cdd', awayT - sp.away, aw.perDay), apply: { k: 'profile.comfort.cool.away', v: awayT, label: 'Away cooling' } });
    }
  }

  // Use that doesn't drop while nobody is home (per the routine, any day).
  // Only meaningful once a schedule with away periods is actually programmed; before that, the thermostat has no reason to ease off.
  const programmed = state.programmed?.fingerprint && state.programmed.fingerprint === planFingerprint(rec.plans);
  const at = !held && report?.night ? awayTests({ state, temps: {}, hd: report.hd || [], report }) : null;
  if (at?.available && at.away_watts >= 0.85 * at.evening_watts && at.away_watts - report.night.base >= 150) { // the overnight floor can include heating, so compare with evenings first
    const extra = ((at.away_watts - report.night.base) / 1000) * at.hours_per_week * 4.3;
    push({ id: 'away-high', what: programmed ? 'Check that the thermostat really eases off while nobody’s home' : 'Program the away setting for when nobody’s home', why: programmed ? `Nobody should be home ${at.away_hours}, yet use stays near evening levels. If heating or cooling runs as if someone were home, the schedule isn’t taking effect — a HOLD on the thermostat is the usual cause.${meterNote}` : `Nobody is home ${at.away_hours}, but use stays near the level when someone is — the thermostat isn’t set to ease off then yet.${meterNote}`, evidence: `While away: about ${fmt(at.away_watts)} W, vs. ${fmt(at.evening_watts)} W once someone’s home and ${fmt(report.night.base)} W at the quietest hour (${at.days} days of hourly data).`, investigate: programmed ? 'While you’re out, look at the thermostat: if it says HOLD AT, press RUN. Something else left running (a space heater, dehumidifier) shows the same pattern.' : 'Program the schedule from Today; afterwards the app checks whether use drops during those hours.', impact: `If use while away fell to the overnight level, about ${fmt(extra)} kWh a month${money(extra)}.`, confidence: p.hvacMetered === 'no' ? 'low' : 'medium', confidenceWhy: 'Measured from your hourly data; the meter can’t show which device is running.', reprogram: true, thermostat: 'Check the thermostat (no reprogramming if the schedule is already set)' });
  }
  // Always-on load.
  if (report?.night && (report.night.alwaysOn ?? report.night.base) >= 250) {
    const b = report.night.alwaysOn ?? report.night.base, month = (b / 1000) * 24 * 30;
    push({ id: 'standby', what: 'Cut always-on power', why: `About ${fmt(b)} W runs even in your quietest hour — ${fmt(month)} kWh a month, ${fmt((month / 30 / report.perDay) * 100)}% of your use. Many apartments idle at 100–200 W.`, evidence: report.night.mildNights >= 7 ? `Median quietest hour on ${report.night.mildNights} mild nights (55–68°F), when heating and cooling rest.` : `Quietest hourly average across ${report.night.nights} day${report.night.nights === 1 ? '' : 's'} of hourly readings.`, investigate: 'Before bed, switch off or unplug what doesn’t need to run overnight (TV boxes, game consoles, chargers, a second fridge or dehumidifier). After a week, import a new file: the 1–5 AM readings show whether it dropped.', impact: `Every 50 W switched off saves about 36 kWh a month${money(36)}.`, confidence: report.night.nights >= 7 ? 'high' : 'medium', confidenceWhy: report.night.nights >= 7 ? 'Consistent across a week or more of nights.' : 'From only a few nights so far.', thermostat: p.hvacMetered !== 'no' && !report.night.steady ? 'No reprogramming needed (if heating or cooling cycles overnight, the overnight setting also counts)' : null });
  } else if (!report?.night && summary?.baseLoad != null && summary.baseLoad >= 0.25) {
    push({ id: 'standby', what: 'Cut always-on power', why: `About ${fmt(summary.baseLoad * 1000)} W runs around the clock — roughly ${fmt(summary.baseLoad * 24 * 30)} kWh a month.`, evidence: `Your quietest hour averages ${fmt(summary.baseLoad, 2)} kWh across ${summary.days} days of hourly data.`, impact: `Every 50 W switched off saves about 36 kWh a month${money(36)}.`, confidence: 'medium', confidenceWhy: 'Measured from your hourly data; which devices cause it isn’t visible to the app.' });
  }
  // A recent unusual day.
  const sp = report?.spikes?.[0];
  if (sp && between(sp.date, report.to) <= 21) {
    const extra = sp.kwh - sp.expected;
    push({ id: 'spike', what: `Find out what ran on ${dayName(sp.date)}`, why: `It used ${fmt(extra, 1)} kWh more than ${sp.weatherAdjusted ? 'the weather explains' : 'a typical day'}.${sp.window ? ` Most of the extra was between ${hr(sp.window.start)} and ${hr(sp.window.end)}.` : ''}`, evidence: `${fmt(sp.kwh, 1)} kWh that day vs. about ${fmt(sp.expected, 1)} expected.`, investigate: 'If it lines up with laundry, cooking, guests or a cold snap, nothing to do. If not, check for something left on at that time (space heater, oven, AC with a window open). A repeat on similar days means it’s a routine worth trimming.', impact: `If it was avoidable and happens weekly, about ${fmt(extra * 4.3)} kWh a month${money(extra * 4.3)}.`, confidence: 'medium', confidenceWhy: 'The day clearly stands out; the cause isn’t visible in whole-home data.' });
  }
  // A weekly pattern on one weekday.
  const pt = report?.patterns?.[0];
  if (pt) {
    const extra = (pt.a - pt.b) * 4.3;
    push({ id: 'weekday', what: `Find out what runs on ${pt.day} ${pt.part === 'evening' ? 'evenings' : 'nights'}`, why: `Every ${pt.day} in your data uses more ${pt.part === 'evening' ? 'between 5 and 10 PM' : 'between 1 and 5 AM'} than other days — a repeating routine, not a one-off.`, evidence: `${fmt(pt.a, 1)} kWh vs. ${fmt(pt.b, 1)} kWh in those hours (${pt.n} ${pt.day}s).`, investigate: pt.part === 'evening' ? `Think about what happens on ${pt.day}s (laundry, cooking for guests, a hobby). If it’s a dryer or oven, full loads and lower heat settings help; if it’s heating while everyone is home, that’s expected.` : `Something runs overnight on ${pt.day}s only — a timer, a device left on after a late evening, or heating set higher. Check before bed next ${pt.day}.`, impact: `If half of it could be avoided, about ${fmt(extra / 2, 1)} kWh a month${money(extra / 2)}.`, confidence: pt.n >= 4 ? 'medium' : 'low', confidenceWhy: `Repeats on all ${pt.n} ${pt.day}s; the cause isn’t visible in whole-home data.` });
  }
  // A recent rise.
  if (report?.change && report.change.diff > 0) {
    const c = report.change, mth = c.diff * 30;
    push({ id: 'rise', what: 'Look for what changed in the last week', why: `Daily use is about ${fmt(c.pct)}% higher since ${dayName(c.from)}${c.adjusted ? ', even after allowing for the weather' : ''}.${c.window ? ` The extra is mostly between ${hr(c.window.start)} and ${hr(c.window.end)}.` : ''}`, evidence: `${fmt(c.diff, 1)} kWh a day more than in the 4 weeks before.`, investigate: 'Think about anything new that week: a space heater, guests, working from home, a thermostat hold or a changed setting. Fix it and the next import will show the drop.', impact: `If it continues, about ${fmt(mth)} kWh a month${money(mth)}.`, confidence: c.adjusted ? 'high' : 'medium', confidenceWhy: c.adjusted ? 'Outside normal day-to-day variation, after allowing for the weather.' : 'Outside normal day-to-day variation; weather not adjusted for.' });
  }
  if (p.hvacMetered === 'unknown') {
    const w = report?.weather;
    const hint = w ? (w.heat || w.cool ? 'Your use does rise with outdoor temperature, which suggests at least part of heating or cooling is on your meter.' : 'Your use barely changes with outdoor temperature, which suggests the building may pay for heating and cooling.') : 'Your data isn’t sufficient yet to suggest an answer.';
    push({ id: 'meter', what: 'Ask building management whether heating and cooling run on your apartment’s meter', why: 'It decides whether thermostat changes can lower your Delmarva bill or only the building’s.', evidence: hint, confidence: 'info', confidenceWhy: '' });
  }
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  // Unexplained waste (no comfort cost) before comfort trade-offs (setbacks); then confidence; then size.
  const tradeoff = (o) => (/^(heat|cool)-/.test(o.id) ? 1 : 0);
  return out.sort((a, b) => (a.confidence === 'info') - (b.confidence === 'info') || tradeoff(a) - tradeoff(b) || order[a.confidence] - order[b.confidence] || (b.est || 0) - (a.est || 0));
}

/** When nothing is worth changing, say what the data showed instead. */
export function noChangeSummary(report, ops) {
  if (!report || report.level === 'none' || ops.some((o) => o.confidence === 'high' || o.confidence === 'medium')) return null;
  const why = [];
  if (report.night) why.push(`always-on use is a modest ${fmt(report.night.alwaysOn ?? report.night.base)} W`);
  if (!report.spikes.length && report.n >= 10) why.push('no days stand out');
  if (report.change == null && report.n >= 21) why.push('use has been steady recently');
  if (report.weather && !report.weather.heat && !report.weather.cool) why.push('weather barely moves your use, so a deeper setback wouldn’t save much');
  return why.length ? `No change recommended right now: ${why.join(', ')}. Your current schedule looks appropriate — keep it, and import a newer file in a few weeks.` : 'No change recommended yet — there isn’t enough evidence for one. Keep your current schedule; more days of data will sharpen this.';
}

// ---------- combining public findings with private data (on this device only) ----------

/** Expected use for forecast days from this home's own weather model; only within the temperatures it has seen. */
export function forecastUse(model, outlook, tariff) {
  if (model?.status !== 'ready') return [];
  const temps = model.days.map((d) => d.temp), lo = Math.min(...temps) - 3, hi = Math.max(...temps) + 3;
  return outlook.filter((d) => d.hours >= 20).map((d) => {
    const mean = (d.high + d.low) / 2;
    if (mean < lo || mean > hi) return null;
    const kwh = Math.max(0, model.predict({ hdd: d.hdd, cdd: d.cdd }));
    return { date: d.date, mean, kwh, cost: C.energyCost(kwh, tariff) };
  }).filter(Boolean);
}

/** A local-only line for a public weather finding: what days like these have meant for this home. */
export function personalizeFinding(item, fc, typicalKwh, now = Date.now()) {
  const until = Date.parse(item?.valid_until);
  if (!Number.isFinite(until) || !fc.length || !(typicalKwh > 0)) return null;
  const today = C.localParts(now).date, end = C.localParts(until).date;
  const days = fc.filter((d) => d.date >= today && d.date <= end);
  if (!days.length) return null;
  const k = avg(days.map((d) => d.kwh)), pct = ((k - typicalKwh) / typicalKwh) * 100;
  if (Math.abs(pct) < 10) return `For your home: days like these usually use about the same as normal (≈${fmt(k, 1)} kWh a day).`;
  return `For your home: days like these have averaged about ${fmt(k, 1)} kWh a day — ${fmt(Math.abs(pct))}% ${pct > 0 ? 'more' : 'less'} than your typical ${fmt(typicalKwh, 1)}. Calculated on this device from your own data.`;
}

// ================= Investigations: competing explanations and priorities =================
// Shared by the app (iPhone) and the Mac companion. Explanations come from a fixed catalog; verdicts use fixed thresholds.

const corr = (x, y) => { const mx = avg(x), my = avg(y), sx = sd(x), sy = sd(y); return sx > 0 && sy > 0 ? sum(x.map((v, i) => (v - mx) * (y[i] - my))) / ((x.length - 1) * sx * sy) : null; };
/** How strongly y rises as it gets colder: r and the change across the observed temperature range as % of mean y. */
function coldEffect(temps, ys) {
  if (temps.length < 4) return { r: null, pct: null };
  const x = temps.map((t) => -t), r = corr(x, ys);
  const mx = avg(x), my = avg(ys), sxx = sum(x.map((v) => (v - mx) ** 2));
  const slope = sxx > 0 ? sum(x.map((v, i) => (v - mx) * (ys[i] - my))) / sxx : 0;
  const range = Math.max(...x) - Math.min(...x);
  return { r, pct: Math.abs(my) > 1e-9 ? ((slope * range) / Math.abs(my)) * 100 : null };
}
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r0 = (x) => (x == null ? null : Math.round(x));
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const wdOf = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const hh = (h) => `${String(h % 24).padStart(2, '0')}:00`;

/** Per-occurrence excess of one weekday's window over the median of other days in the same hours. */
export function patternTests(ctx, { day, part }) {
  const w = DAYS.indexOf(day), hrs = part === 'evening' ? [17, 18, 19, 20, 21] : [1, 2, 3, 4];
  const wide = part === 'evening' ? [15, 16, 17, 18, 19, 20, 21, 22, 23] : [0, 1, 2, 3, 4, 5, 6];
  const mine = ctx.hd.filter((d) => wdOf(d.date) === w), rest = ctx.hd.filter((d) => wdOf(d.date) !== w);
  if (mine.length < 3 || rest.length < 6) return { available: false, note: 'needs at least 3 such days with hourly data' };
  const typ = Array.from({ length: 24 }, (_, h) => median(rest.map((d) => d.h[h])));
  const occ = mine.map((d) => {
    const ex = wide.map((h) => d.h[h] - typ[h]);
    const inWin = hrs.map((h) => d.h[h] - typ[h]);
    const peak = Math.max(...ex), on = wide.find((h, i) => ex[i] > peak * 0.5), off = [...wide].reverse().find((h, i) => ex[wide.length - 1 - i] > peak * 0.5);
    const other = Array.from({ length: 24 }, (_, h) => h).filter((h) => !wide.includes(h));
    return { date: d.date, temp: ctx.temps[d.date], excess: sum(inWin), shape: Math.min(...inWin) / Math.max(1e-6, Math.max(...inWin)), on, off, rest_excess: avg(other.map((h) => d.h[h] - typ[h])) };
  });
  const ex = occ.map((o) => o.excess), mean = avg(ex);
  const big = occ.filter((o) => o.excess > 0.5 * mean);
  const withT = occ.filter((o) => Number.isFinite(o.temp));
  const tSpread = withT.length ? Math.max(...withT.map((o) => o.temp)) - Math.min(...withT.map((o) => o.temp)) : 0;
  const ce = withT.length >= 4 && tSpread >= 6 ? coldEffect(withT.map((o) => o.temp), withT.map((o) => o.excess)) : { r: null, pct: null }; // + means more when colder
  const ons = big.map((o) => o.on).filter((x) => x != null), offs = big.map((o) => o.off).filter((x) => x != null);
  const iqr = (a) => { const s = [...a].sort((x, y) => x - y); return s.length >= 3 ? s[Math.floor(s.length * 0.75)] - s[Math.floor(s.length * 0.25)] : null; };
  const firstBig = occ.findIndex((o) => o.excess > 0.5 * mean);
  const lateStart = firstBig >= 2 && occ.slice(firstBig).every((o) => o.excess > 0.3 * mean);
  const perHourW = (mean / hrs.length) * 1000;
  return {
    available: true, day, part, occurrences: occ.length, weeks_with_excess: big.length,
    avg_extra_kwh: r1(mean), avg_extra_watts: r0(perHourW), size_variation_pct: r0((sd(ex) / Math.max(1e-6, mean)) * 100),
    flatness: r2(avg(occ.map((o) => o.shape))), // ~1 = steady draw across the window (a fixed-power load)
    usual_start: ons.length ? hh(median(ons)) : null, usual_end: offs.length ? hh(median(offs) + 1) : null, start_time_spread_h: iqr(ons),
    colder_more_r: r2(ce.r), cold_effect_pct: r0(ce.pct), temperature_range_f: r0(tSpread),
    rest_of_day_extra_watts: r0(avg(occ.map((o) => o.rest_excess)) * 1000),
    started: lateStart ? occ[firstBig].date : null,
    per_occurrence: occ.slice(-8).map((o) => ({ date: o.date, extra_kwh: r1(o.excess), temp_f: r1(o.temp) })),
  };
}

/** Quietest hour by week and against outdoor temperature. */
export function floorTests(ctx) {
  if (ctx.hd.length < 14) return { available: false, note: 'needs 2 weeks of hourly data' };
  const nights = ctx.hd.map((d) => ({ date: d.date, floor: Math.min(...d.h) * 1000, temp: ctx.temps[d.date] }));
  const withT = nights.filter((n) => Number.isFinite(n.temp));
  const spread = withT.length ? Math.max(...withT.map((n) => n.temp)) - Math.min(...withT.map((n) => n.temp)) : 0;
  const weeks = [];
  for (let i = 0; i + 7 <= nights.length; i += 7) weeks.push({ from: nights[i].date, floor: median(nights.slice(i, i + 7).map((n) => n.floor)) });
  const first = weeks.slice(0, 2).map((w) => w.floor), last = weeks.slice(-2).map((w) => w.floor);
  const jump = weeks.findIndex((w, i) => i >= 1 && w.floor > 1.3 * median(weeks.slice(0, i).map((x) => x.floor)) && weeks.slice(i).every((x) => x.floor > 1.2 * median(weeks.slice(0, i).map((y) => y.floor))));
  return {
    available: true, nights: nights.length, quietest_hour_watts: r0(median(nights.map((n) => n.floor))),
    ...(() => { const ce = withT.length >= 10 && spread >= 8 ? coldEffect(withT.map((n) => n.temp), withT.map((n) => n.floor)) : { r: null, pct: null }; return { colder_more_r: r2(ce.r), cold_effect_pct: r0(ce.pct) }; })(), temperature_range_f: r0(spread),
    early_weeks_watts: r0(avg(first)), recent_weeks_watts: r0(avg(last)), stepped_up_from: jump > 0 ? weeks[jump].from : null,
  };
}

/** Hours nobody is home (from the per-day routine): level vs. when someone is home, temperature dependence, regularity. */
export function awayTests(ctx) {
  ctx = { ...ctx, temps: ctx.temps || {} };
  const rows = [], dayNames = new Set(), ev = [];
  let hoursPerWeek = 0;
  for (const d of C.DOW) { const r = C.routineFor(ctx.state.profile.routine, d); if (r.leave && r.back) hoursPerWeek += minutesBetween(r.leave, r.back) / 60; }
  for (const d of ctx.hd) {
    const dk = C.DOW[wdOf(d.date)], r = C.routineFor(ctx.state.profile.routine, dk);
    if (!r.leave || !r.back) continue;
    const l = Math.ceil(C.toMin(r.leave) / 60), b = Math.floor(C.toMin(r.back) / 60), s = Math.min(23, Math.floor(C.toMin(r.sleep) / 60));
    const hrs = Array.from({ length: Math.max(0, b - l) }, (_, i) => l + i), eve = Array.from({ length: Math.max(0, s - b) }, (_, i) => b + i);
    if (hrs.length < 2 || eve.length < 2) continue;
    dayNames.add(C.DAY_NAME[dk]);
    ev.push(avg(eve.map((h) => d.h[h])) * 1000);
    rows.push({ w: avg(hrs.map((h) => d.h[h])) * 1000, floor: Math.min(...d.h) * 1000, temp: ctx.temps[d.date], flat: Math.min(...hrs.map((h) => d.h[h])) / Math.max(1e-6, Math.max(...hrs.map((h) => d.h[h]))), label: `${hh(l)}-${hh(b)}` });
  }
  if (!hoursPerWeek) return { available: false, note: 'nobody is away on a regular schedule' };
  if (rows.length < 3) return { available: false, note: 'needs at least 3 away periods of 2+ whole hours with hourly data' };
  const withT = rows.filter((r) => Number.isFinite(r.temp)), spread = withT.length ? Math.max(...withT.map((r) => r.temp)) - Math.min(...withT.map((r) => r.temp)) : 0;
  const ce = withT.length >= 8 && spread >= 8 ? coldEffect(withT.map((r) => r.temp), withT.map((r) => r.w - r.floor)) : { r: null, pct: null };
  return {
    available: true, days: rows.length, weekdays: rows.length, away_hours: `on ${[...dayNames].join(', ')} (${[...new Set(rows.map((r) => r.label))].join(', ')})`, hours_per_week: r1(hoursPerWeek),
    away_watts: r0(avg(rows.map((r) => r.w))), evening_watts: r0(avg(ev)), above_floor_watts: r0(avg(rows.map((r) => r.w - r.floor))),
    colder_more_r: r2(ce.r), cold_effect_pct: r0(ce.pct), temperature_range_f: r0(spread),
    day_to_day_variation_pct: r0((sd(rows.map((r) => r.w)) / Math.max(1e-6, avg(rows.map((r) => r.w)))) * 100), flatness: r2(avg(rows.map((r) => r.flat))),
  };
}

/** Recent days vs. the 4 weeks before: where in the day the change is, whether it tracks cold, one-off days, floor. */
export function riseTests(ctx, days = 10) {
  const all = ctx.hd;
  if (all.length < days + 14) return { available: false, note: 'needs about 4 weeks of hourly data' };
  // When did it start? The split (7+ days after, within the last 5 weeks) where daily totals jump most clearly; else the last `days`.
  const tot0 = all.map((d) => sum(d.h));
  let cp = null;
  for (let k = all.length - 7; k >= Math.max(14, all.length - 35); k--) {
    const a = tot0.slice(k), b = tot0.slice(Math.max(0, k - 28), k), se = Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
    const z = se > 0 ? (avg(a) - avg(b)) / se : 0;
    if (!cp || z > cp.z + 0.25) cp = { k, z }; // earlier starts win near-ties
  }
  const k0 = cp && cp.z >= 2.5 ? cp.k : all.length - days;
  const recent = all.slice(k0), before = all.slice(Math.max(0, k0 - 28), k0);
  const blocks = { 'night (0–6)': [0, 6], 'morning (6–12)': [6, 12], 'midday (12–17)': [12, 17], 'evening (17–24)': [17, 24] };
  const bw = (ds, [a, b]) => avg(ds.map((d) => avg(d.h.slice(a, b)))) * 1000;
  const by = Object.fromEntries(Object.entries(blocks).map(([k, r]) => [k, r0(bw(recent, r) - bw(before, r))]));
  const tot = (d) => sum(d.h);
  const base = median(before.map(tot)), ex = recent.map((d) => ({ date: d.date, extra: tot(d) - base, temp: ctx.temps[d.date] }));
  const extraSum = sum(ex.map((x) => Math.max(0, x.extra))), top = [...ex].sort((a, b) => b.extra - a.extra)[0];
  const withT = ex.filter((x) => Number.isFinite(x.temp)), spread = withT.length ? Math.max(...withT.map((x) => x.temp)) - Math.min(...withT.map((x) => x.temp)) : 0;
  const tb = (ds) => avg(ds.map((d) => ctx.temps[d.date]).filter(Number.isFinite));
  const floor = (ds) => median(ds.map((d) => Math.min(...d.h) * 1000));
  const winStat = (ds, [a, b], f) => avg(ds.map((d) => f(...d.h.slice(a, b)))) * 1000;
  const largest = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
  // kWh a day each window adds (change in average watts × hours ÷ 1000), and its share of the total change.
  const hoursIn = (k) => blocks[k][1] - blocks[k][0];
  const contrib = Object.fromEntries(Object.keys(blocks).map((k) => [k, r1((by[k] * hoursIn(k)) / 1000)]));
  const totalUp = Object.values(contrib).filter((v) => v > 0).reduce((a, v) => a + v, 0);
  return {
    available: true, recent_days: recent.length, from: recent[0].date,
    recent_kwh_per_day: r1(avg(recent.map(tot))), before_kwh_per_day: r1(avg(before.map(tot))), median_before_kwh: r1(base),
    change_watts_by_time_of_day: by, largest_change: largest[0], change_kwh_per_day_by_time_of_day: contrib,
    share_of_increase_pct: Object.fromEntries(Object.entries(contrib).map(([k, v]) => [k, totalUp > 0 && v > 0 ? r0((v / totalUp) * 100) : 0])),
    recent_temp_f: r1(tb(recent)), before_temp_f: r1(tb(before)),
    ...(() => { const ce = withT.length >= 6 && spread >= 6 ? coldEffect(withT.map((x) => x.temp), withT.map((x) => x.extra)) : { r: null, pct: null }; return { colder_more_r: r2(ce.r), cold_effect_pct: r0(ce.pct) }; })(), temperature_range_f: r0(spread),
    biggest_day: top ? { date: top.date, extra_kwh: r1(top.extra) } : null, biggest_day_share_pct: extraSum > 0 && top ? r0((Math.max(0, top.extra) / extraSum) * 100) : null,
    days_above_usual: ex.filter((x) => x.extra > 0.1 * base).length, start_detected: !!(cp && cp.z >= 2.5),
    // Steady vs. bursty: did the quietest hour of the busiest-changing window rise (a sustained draw) or mainly its peak hour?
    sustained_rise_watts: r0(winStat(recent, blocks[largest[0]], Math.min) - winStat(before, blocks[largest[0]], Math.min)),
    peak_rise_watts: r0(winStat(recent, blocks[largest[0]], Math.max) - winStat(before, blocks[largest[0]], Math.max)),
    daytime_floor_rise_watts: r0(winStat(recent, [8, 22], Math.min) - winStat(before, [8, 22], Math.min)),
    floor_change_watts: r0(floor(recent) - floor(before)),
    ...windowWeather(ctx, recent, before, blocks[largest[0]]),
  };
}

/** For the window where use changed most: compared at the same outdoor temperature, its relation to temperature, a hot-summer reference, and how the extra is spread over days and hours. Daily mean temperatures only; nothing is estimated. */
function windowWeather(ctx, recent, before, [a, b]) {
  const T = (d) => ctx.temps[d.date], W = (d) => avg(d.h.slice(a, b)) * 1000;
  const rT = recent.filter((d) => Number.isFinite(T(d))), bT = before.filter((d) => Number.isFinite(T(d)));
  const pairs = rT.map((d) => { const m = bT.filter((x) => Math.abs(T(x) - T(d)) <= 3); return m.length >= 2 ? [W(d), avg(m.map(W))] : null; }).filter(Boolean);
  const mAfter = pairs.length ? avg(pairs.map((p) => p[0])) : null, mBefore = pairs.length ? avg(pairs.map((p) => p[1])) : null;
  const rel = (ds) => (ds.length >= 8 && Math.max(...ds.map(T)) - Math.min(...ds.map(T)) >= 6 ? r2(corr(ds.map(T), ds.map(W))) : null);
  const hist = hourlyByDay(ctx.state.usage, C.dailyTotals(ctx.state.usage).filter((d) => d.complete).map((d) => d.date)).filter((d) => ctx.temps[d.date] >= 75);
  const prof = Array.from({ length: 24 }, (_, h) => avg(before.map((d) => d.h[h])));
  const hoursUp = recent.map((d) => d.h.filter((v, h) => (v - prof[h]) * 1000 > 300).length);
  const medBefore = median(before.map(W));
  const wkend = (d) => [0, 6].includes(new Date(`${d.date}T12:00:00Z`).getUTCDay());
  const ch = (f) => r0(avg(recent.filter(f).map(W)) - avg(before.filter(f).map(W)));
  return {
    window: `${String(a).padStart(2, '0')}:00–${String(b).padStart(2, '0')}:00`, window_watts_before: r0(avg(before.map(W))), window_watts_after: r0(avg(recent.map(W))),
    same_temp_days: pairs.length, same_temp_watts_after: r0(mAfter), same_temp_watts_before: r0(mBefore), same_temp_change_pct: pairs.length ? r0(((mAfter - mBefore) / mBefore) * 100) : null,
    hotter_more_r_before: rel(bT), hotter_more_r_after: rel(rT),
    hot_days_reference: hist.length, hot_days_window_watts: hist.length ? r0(avg(hist.map(W))) : null,
    days_window_above_usual: recent.filter((d) => W(d) > medBefore).length, typical_hours_elevated: median(hoursUp),
    weekday_window_change_watts: ch((d) => !wkend(d)), weekend_window_change_watts: ch(wkend),
    night_change_watts: r0((avg(recent.map((d) => avg(d.h.slice(0, 6)))) - avg(before.map((d) => avg(d.h.slice(0, 6))))) * 1000),
  };
}

// ---------- the catalog: explanation → what it predicts → verdict ----------
const V = (ok, no, why) => ({ verdict: ok ? 'supported' : no ? 'ruled out' : 'not yet clear', why });
/** Four-way verdict: the readings support it, can't tell, don't support it (no sign of it, but not excluded), or rule it out. */
const V4 = (verdict, why) => ({ verdict, why });
const tempKnown = (t) => t.colder_more_r != null;
const coldDriven = (t) => tempKnown(t) && t.colder_more_r >= 0.5 && (t.cold_effect_pct ?? 0) >= 30;
const notCold = (t) => tempKnown(t) && (t.colder_more_r < 0.2 || (t.cold_effect_pct ?? 0) < 15);
const coldWhy = (t, what) => (tempKnown(t) ? `${what} vs colder conditions: r = ${t.colder_more_r}, changing ${t.cold_effect_pct}% across a ${t.temperature_range_f}°F range.` : 'Too little temperature variation to test.');

export const CATALOG = {
  night: (t) => [
    { id: 'heating', title: 'Heating runs harder on those nights', ...V(coldDriven(t), notCold(t), coldWhy(t, 'Extra use')),
      action: 'Check the overnight (Night) heat setting and whether a HOLD is active on those nights; keep the Night setting the same every day.', check: `On the next ${t.day}, look at the thermostat before bed: is it holding a higher temperature?`, thermostat: true },
    { id: 'device', title: 'A device runs on a schedule those nights', ...V(t.flatness >= 0.6 && (t.start_time_spread_h ?? 9) <= 1 && !coldDriven(t), t.flatness < 0.3, `Steadiness ${t.flatness} (1 = constant power), start time varies by ${t.start_time_spread_h ?? '?'} h, about ${t.avg_extra_watts} W.`),
      action: `Look for something drawing about ${t.avg_extra_watts} W from ${t.usual_start} to ${t.usual_end} on ${t.day} nights — timers, a space heater, dehumidifier, charging or a console updating.`, check: `On the next ${t.day} around ${t.usual_start}, walk through the apartment and note what is on; switch off suspects and compare the next import.`, thermostat: false },
    { id: 'activity', title: 'People are up or home more those nights', ...V(t.rest_of_day_extra_watts >= 0.3 * t.avg_extra_watts && t.size_variation_pct >= 40, t.rest_of_day_extra_watts < 0.1 * t.avg_extra_watts && t.size_variation_pct < 25, `Rest of that day: ${t.rest_of_day_extra_watts} W extra; size varies ${t.size_variation_pct}% week to week.`),
      action: 'If late nights or guests explain it, there is little to fix; lights and electronics off when not in use is the lever.', check: 'Compare with your calendar: were those late nights or visits?', thermostat: false },
    { id: 'new', title: 'Something new started recently', ...V(!!t.started, !t.started && t.weeks_with_excess >= t.occurrences - 1, t.started ? `First seen ${t.started}; every week since.` : `Present in ${t.weeks_with_excess} of ${t.occurrences} weeks from the start.`),
      action: `Think about what changed around ${t.started || 'the start of your data'}: a new appliance, a new routine, a guest.`, check: 'Recall changes around that date.', thermostat: false },
  ],
  evening: (t) => [
    { id: 'routine', title: 'A weekly appliance routine (laundry, dishwasher, cooking)', ...V(t.flatness >= 0.3 && (t.start_time_spread_h ?? 9) <= 1 && !coldDriven(t), (t.start_time_spread_h ?? 0) >= 3, `Starts around ${t.usual_start} (varies ${t.start_time_spread_h ?? '?'} h), about ${t.avg_extra_kwh} kWh each time.`),
      action: `Full loads, cold-water washing, and air-drying cut most of a laundry-style ${t.avg_extra_kwh} kWh evening; if it is cooking, lids and the microwave help.`, check: `Note what runs on the next ${t.day} evening from ${t.usual_start}.`, thermostat: false },
    { id: 'heating', title: 'Heating works harder when you are home that evening', ...V(coldDriven(t), notCold(t), coldWhy(t, 'Extra use')),
      action: 'Check the Evening heat setting for that day; it should match other days.', check: `Look at the thermostat on the next ${t.day} evening.`, thermostat: true },
    { id: 'activity', title: 'More people home that day (guests, working from home)', ...V(t.rest_of_day_extra_watts >= 0.3 * (t.avg_extra_watts || 1), t.rest_of_day_extra_watts < 0.1 * (t.avg_extra_watts || 1), `Rest of that day: ${t.rest_of_day_extra_watts} W extra vs other days.`),
      action: 'Nothing to fix if it is people at home; it explains the extra use.', check: 'Compare with who is home that day.', thermostat: false },
    { id: 'new', title: 'Something new started recently', ...V(!!t.started, !t.started && t.weeks_with_excess >= t.occurrences - 1, t.started ? `First seen ${t.started}.` : `Present in ${t.weeks_with_excess} of ${t.occurrences} weeks.`),
      action: `Think about what changed around ${t.started || 'the start of your data'}.`, check: 'Recall changes around that date.', thermostat: false },
  ],
  change: (t) => {
    const dT = (t.recent_temp_f ?? 0) - (t.before_temp_f ?? 0), win = t.change_watts_by_time_of_day[t.largest_change];
    const colder = dT <= -3, hotter = dT >= 3, sustained = t.sustained_rise_watts >= 150 || t.daytime_floor_rise_watts >= 150;
    const daytime = ['midday (12–17)', 'morning (6–12)'].includes(t.largest_change);
    const sameTemp = t.same_temp_change_pct, tracksHeat = (t.hotter_more_r_after ?? 0) >= 0.4, tracksNothing = t.hotter_more_r_after != null && Math.abs(t.hotter_more_r_after) < 0.3;
    const beyondSummer = t.hot_days_window_watts != null && t.window_watts_after > t.hot_days_window_watts;
    const sameTempTxt = sameTemp != null ? `At the same outdoor temperatures (${t.same_temp_days} days), ${t.window} now averages ${t.same_temp_watts_after} W vs ${t.same_temp_watts_before} W before (${sameTemp >= 0 ? '+' : ''}${sameTemp}%).` : 'Too few days with matching temperatures to compare.';
    const relTxt = t.hotter_more_r_after != null ? ` Before, ${t.window} use rose with temperature (r = ${t.hotter_more_r_before ?? 'n/a'}); since, r = ${t.hotter_more_r_after}.` : '';
    return [
      { id: 'daytime_load', title: 'Something running for hours during the day (an appliance or equipment)', ...V4(t.sustained_rise_watts >= 300 && t.night_change_watts < 150 && (tracksNothing || !tracksHeat || (sameTemp ?? 0) >= 30) ? 'supported' : t.sustained_rise_watts < 100 ? 'not supported' : 'not yet clear',
        `${t.window} rose from ${t.window_watts_before} W to ${t.window_watts_after} W; its quietest hour rose ${t.sustained_rise_watts} W while nights changed ${t.night_change_watts} W — a load that runs for hours in the day, not around the clock.${relTxt}`),
        action: `Find what draws about ${t.sustained_rise_watts} W for hours ${t.window}: switch suspects off for a few afternoons, then import a newer file.`, check: 'Walk through the apartment mid-afternoon: what is on that wasn’t in September — a space heater, dehumidifier, portable AC, computer or console?', thermostat: false },
      { id: 'space_heater', title: 'A plug-in space heater (unconfirmed)', ...V4(colder && sustained && t.night_change_watts < 150 && !tracksHeat ? 'not yet clear' : !colder && tracksHeat ? 'not supported' : 'not yet clear',
        `It got ${Math.abs(dT).toFixed(0)}°F ${colder ? 'cooler' : 'warmer'} and a steady daytime load appeared — what a heater used in the afternoons would look like. The meter can’t confirm a heater.`),
        action: 'If a space heater is running while the building cools, use it less or ask management about the cold; 1,000–1,500 W adds up quickly.', check: 'Is anyone using a plug-in heater during the day?', thermostat: false },
      { id: 'cooling_setting', title: 'Cooling set colder, on HOLD, or running abnormally', ...V4(sameTemp != null && sameTemp >= 30 ? 'not yet clear' : sameTemp != null && sameTemp < 10 ? 'not supported' : 'not yet clear',
        `${sameTempTxt} That fits a colder setting, a HOLD or an AC fault — but a new appliance would look the same in hourly readings.`),
        action: 'Check the cooling setpoint and clear any HOLD; with cooler, drier weather the AC should be running less, not more.', check: 'Is the AC running more than usual in the afternoons? Is the thermostat on HOLD?', thermostat: true },
      { id: 'cooling_weather', title: 'Cooling working harder because of the weather', ...V4(tracksHeat && !colder ? 'supported' : (colder && (sameTemp ?? 0) >= 30) || (beyondSummer && colder) ? 'not supported' : 'not yet clear',
        `Outside ${t.recent_temp_f}°F vs ${t.before_temp_f}°F before. ${sameTempTxt}${beyondSummer ? ` ${t.window} now uses more than on your summer days of 75°F+ (${t.hot_days_window_watts} W).` : ''}`),
        action: 'Nothing unusual to fix if it is the weather; blinds on sunny windows help.', check: 'Has it been unusually hot or humid indoors?', thermostat: true },
      { id: 'fan_on', title: 'Thermostat fan switched from AUTO to ON', ...V4(t.night_change_watts >= 150 && t.daytime_floor_rise_watts >= 150 ? 'supported' : t.night_change_watts < 100 && win >= 300 ? 'not supported' : 'not yet clear',
        `A fan left ON runs day and night; nights changed ${t.night_change_watts} W while ${t.window} rose ${win} W.`),
        action: 'Set the fan to AUTO unless the building requires ON.', check: 'Look at the fan setting on the thermostat: AUTO or ON?', thermostat: true },
      { id: 'heating', title: 'Central heating running more', ...V((colder) && (sustained || coldDriven(t)), Math.abs(dT) < 1.5 && !sustained && !coldDriven(t), `Outside ${t.recent_temp_f}°F vs ${t.before_temp_f}°F before; the quietest hour of the ${t.largest_change} window rose ${t.sustained_rise_watts} W.`),
        action: 'Check the temperature the thermostat holds while you’re home; 1–2°F lower if comfortable, and no HOLD.', check: 'Is warm air coming from the vents?', thermostat: true },
      { id: 'home', title: 'More time at home than usual', ...V(false, !daytime || win < 100, daytime ? 'A daytime increase fits more time at home — but just as well appliances or the AC, so the readings alone can’t confirm it.' : `The change is mostly ${t.largest_change}, not daytime.`),
        action: 'If people are home more, the extra is mostly normal use; cool or heat only the rooms in use.', check: 'Has anyone been home more than usual?', thermostat: false },
      { id: 'bursts', title: 'Short bursts of appliance use (cooking, laundry, a kettle or hair dryer)', ...V(t.peak_rise_watts >= 2 * Math.max(1, t.sustained_rise_watts) && t.sustained_rise_watts < 100, t.sustained_rise_watts >= 0.6 * Math.max(1, win), `Peak hour rose ${t.peak_rise_watts} W vs ${t.sustained_rise_watts} W for the quietest hour — ${t.sustained_rise_watts >= 0.6 * Math.max(1, win) ? 'the whole level moved up, not just the peaks' : t.sustained_rise_watts >= 300 ? 'both rose: a steady extra load plus higher peaks' : 'mostly the peaks'}. Hourly readings can’t show cycling within an hour.`),
        action: 'Full loads, cold-water washing, air-drying and lids on pots cut appliance bursts.', check: 'Have you been cooking or doing laundry more than usual?', thermostat: false },
      { id: 'device', title: 'Something new running around the clock', ...V4(t.floor_change_watts >= 100 && !(dT <= -3) ? 'supported' : t.floor_change_watts < 40 && t.night_change_watts < 100 ? 'not supported' : 'not yet clear',
        `The overnight floor changed ${t.floor_change_watts} W — an around-the-clock load would show there.${t.floor_change_watts < 40 ? ' A device used only during the day is still possible (see above).' : ''}`),
        action: `Look for something new that stays on — a dehumidifier, aquarium or second fridge.`, check: 'What was plugged in around the start of the rise?', thermostat: false },
      { id: 'oneoff', title: 'One unusual day skews the average', ...V((t.biggest_day_share_pct ?? 0) >= 50, (t.biggest_day_share_pct ?? 100) < 30 && t.days_above_usual >= Math.ceil(t.recent_days / 2), `Biggest day ${t.biggest_day?.date} (+${t.biggest_day?.extra_kwh} kWh) is ${t.biggest_day_share_pct}% of the extra; ${t.days_above_usual} of ${t.recent_days} days were above usual.`),
        action: `If ${t.biggest_day?.date} was a special day (guests, cooking, laundry), there is nothing to fix.`, check: `What happened on ${t.biggest_day?.date}?`, thermostat: false },
    ];
  },
  standby: (t) => [
    { id: 'heating', title: 'Heating or cooling keeps running at night', ...V(coldDriven(t), notCold(t), coldWhy(t, 'Quietest hour')),
      action: 'Part of the overnight floor is heating: the Night setting (within comfort) is the lever, not unplugging devices.', check: 'Compare the floor on mild and cold nights in the next import.', thermostat: true },
    { id: 'devices', title: 'Always-on devices', ...V(!coldDriven(t) && t.quietest_hour_watts >= 200, t.quietest_hour_watts < 150, `Quietest hour about ${t.quietest_hour_watts} W.`),
      action: 'Switch off or unplug what does not need to run overnight (set-top boxes, consoles, a second fridge, dehumidifier), then re-import after a week.', check: 'Turn suspects off for one night and compare the 1–5 AM readings.', thermostat: false },
    { id: 'new', title: 'A new load was added', ...V(!!t.stepped_up_from, !t.stepped_up_from && Math.abs((t.recent_weeks_watts || 0) - (t.early_weeks_watts || 0)) < 0.15 * (t.early_weeks_watts || 1), t.stepped_up_from ? `Floor stepped up from the week of ${t.stepped_up_from}.` : `Early weeks ${t.early_weeks_watts} W, recent weeks ${t.recent_weeks_watts} W.`),
      action: `Think about what was plugged in around ${t.stepped_up_from || 'then'}.`, check: 'Recall what changed that week.', thermostat: false },
  ],
  thermostat: (t) => [
    { id: 'heating', title: 'Heating keeps running while nobody is home', ...V(coldDriven(t), notCold(t), coldWhy(t, 'Away-hours use')),
      action: 'Make sure the schedule is running (press RUN if it shows HOLD AT) and that the Day/away setting is lower than Home.', check: 'At midday, look at the thermostat display.', thermostat: true },
    { id: 'device', title: 'A device stays on during the day', ...V(t.flatness >= 0.7 && t.day_to_day_variation_pct < 20 && !coldDriven(t), t.flatness < 0.4, `Steadiness ${t.flatness}, day-to-day variation ${t.day_to_day_variation_pct}%.`),
      action: `Something adds about ${t.above_floor_watts} W while you are out; check what is left on when leaving.`, check: 'Before leaving, switch off suspects for a week and compare.', thermostat: false },
    { id: 'occupied', title: 'Someone is home on weekdays', ...V(t.day_to_day_variation_pct >= 40, t.day_to_day_variation_pct < 15, `Day-to-day variation ${t.day_to_day_variation_pct}%.`),
      action: 'If someone is home, update the weekday routine in Settings so the schedule matches.', check: 'Is the apartment really empty on weekdays?', thermostat: true },
  ],
};

/** Tests and catalogued explanations for the decision stage's top priority. */
export function explainFinding(ctx, priority) {
  const pt = (part) => (ctx.report.allPatterns || ctx.report.patterns || []).filter((x) => x.part === part).sort((a, b) => b.pct - a.pct)[0];
  let tests = null, kind = priority;
  if (priority === 'overnight' && pt('night')) { tests = patternTests(ctx, { day: pt('night').day, part: 'night' }); kind = 'night'; }
  else if (priority === 'evening' && pt('evening')) tests = patternTests(ctx, { day: pt('evening').day, part: 'evening' });
  else if (priority === 'standby') tests = floorTests(ctx);
  else if (priority === 'thermostat') tests = awayTests(ctx);
  else if (priority === 'change') tests = riseTests(ctx);
  if (!tests?.available || !CATALOG[kind]) return { kind, tests, hypotheses: [] };
  // Direct measurements: the overnight floor, one day's share, peaks vs. steady level. Everything else is inferred from a resemblance.
  const DIRECT = ['device', 'oneoff', 'bursts', 'new', 'devices'];
  return { kind, tests, hypotheses: CATALOG[kind](tests).map((h) => ({ ...h, inferred: !DIRECT.includes(h.id) })) };
}

// ---------- what deserves attention first ----------

export const PRIORITIES = {
  overnight: 'Investigate overnight demand',
  evening: 'Investigate unusually high evening consumption',
  weather: 'Investigate weather-sensitive demand',
  thermostat: 'Review thermostat scheduling',
  standby: 'Review always-on electrical loads',
  change: 'Investigate a recent rise in use',
  none: 'No significant action warranted',
};
export const ROUTE = { change: 'recent_change', overnight: 'overnight_by_night', evening: 'evening_by_weekday', weather: 'weather_relationship', thermostat: 'away_hours', standby: 'hourly_profile', none: null };
export const NO_TOOL = 'No further investigation needed';

export function eligible(inp) {
  const { report: r, state } = inp, p = state.profile;
  const out = ['none'];
  if (r.night) out.push('overnight', 'standby');
  if (risingNow(inp)) out.push('change');
  if (r.prof) out.push('evening');
  if (r.weather?.heat || r.weather?.cool) { if (p.hvacMetered !== 'no') out.push('weather'); }
  if (p.buildingMode !== 'fan_only' && p.hvacMetered !== 'no' && r.hd.length >= 3) out.push('thermostat'); // never thermostat advice when HVAC isn't billed here
  return out;
}

/** kWh a day of a recent, weather-comparable rise (last week vs before, or last 2 weeks vs similar-weather days), else 0. */
function risingNow(inp) {
  const r = inp.report, bl = r.baseline;
  // Within this household's usual range (or lower), only a single unusually high part of the day is worth investigating.
  if (bl && ['typical', 'return_to_typical', 'unusually_low'].includes(bl.status)) {
    const w = (bl.windows || []).filter((x) => x.flag === 'high').sort((a, b) => b.recent_w - b.usual_w - (a.recent_w - a.usual_w))[0];
    return w ? ((w.recent_w - w.usual_w) * (BLOCKS[w.name][1] - BLOCKS[w.name][0])) / 1000 : 0;
  }
  if (r.change?.diff > 0) return r.change.diff;
  const sw = similarWeather(inp.state.usage, inp.temps || {});
  if (sw.status === 'ok' && sw.meaningful && sw.direction === 'higher') return sw.actualAvg - sw.expectedAvg;
  // A clear jump in raw daily totals counts too: when the weather changed at the same time, a weather model can absorb a real
  // change (confounding). Whether the weather explains it is then tested by the explanations, not assumed.
  const t = (r.hd?.length || 0) >= 24 ? riseTests({ state: inp.state, temps: inp.temps || {}, hd: r.hd, report: r }) : null;
  return t?.available && t.start_detected && t.recent_kwh_per_day >= 1.15 * t.before_kwh_per_day ? t.recent_kwh_per_day - t.before_kwh_per_day : 0;
}
const avgHdd = (inp) => { const t = Object.values(inp.temps || {}).filter(Number.isFinite); return t.length ? t.reduce((s, x) => s + Math.max(0, 65 - x), 0) / t.length : 0; };

/** Tested rules: unexplained waste first (largest measured kWh a month, ≥ 10), then weather-driven setbacks, else no action. */
export function ruleDecide(inp) {
  const { report: r, ops } = inp;
  if (r.level === 'none') return { stance: 'abstain', priority: 'none', route: null, impact: {} };
  if (r.n < 7) return { stance: 'gather', priority: 'none', route: NO_TOOL, impact: {} };
  const impact = {};
  const put = (k, v) => { if (v > (impact[k] || 0)) impact[k] = v; };
  const sumBy = {};
  for (const x of r.allPatterns || r.patterns || []) sumBy[x.part] = (sumBy[x.part] || 0) + (x.a - x.b) * 4.3;
  for (const [part, v] of Object.entries(sumBy)) put(part === 'evening' ? 'evening' : 'overnight', v);
  // Always-on load = quietest hour minus the heating/cooling the weather model attributes to that hour.
  const mDays = r.weather ? r.hd.length : 0;
  const hvacW = r.weather?.heat && mDays ? (r.weather.heat.per * avgHdd(inp) * 1000) / 24 : 0;
  const alwaysOn = r.night ? (r.night.mildNights >= 7 ? r.night.alwaysOn : Math.max(0, r.night.base - hvacW)) : 0; // mild-night floor when available
  if (alwaysOn > 250) put('standby', ((alwaysOn - 150) / 1000) * 24 * 30);
  const rise = risingNow(inp);
  if (rise) put('change', rise * 30);
  for (const o of ops) {
    if (o.id === 'away-high') put('thermostat', +(/about (\d[\d,]*)/.exec(o.impact || '')?.[1]?.replace(/,/g, '') || 0));
    if (/^(heat|cool)-/.test(o.id) && o.est) put('weather', o.est);
  }
  const ok = new Set(eligible(inp));
  // Unexplained waste (no comfort cost) comes before comfort trade-offs such as heating/cooling setbacks.
  // A fresh rise counts double: it's easier to trace while recent, and it may keep growing.
  const weight = (k, v) => (k === 'change' ? 2 * v : v);
  const ranked = Object.entries(impact).filter(([k, v]) => ok.has(k) && v >= 10).sort((a, b) => (a[0] === 'weather') - (b[0] === 'weather') || weight(...b) - weight(...a));
  const best = ranked[0];
  const priority = best ? best[0] : 'none';
  return { stance: 'proceed', priority, route: ROUTE[priority] ?? NO_TOOL, impact };
}

// ================= Interactive investigation =================
// One active investigation at a time: what changed, the competing explanations (tested against readings), one useful
// question, how answers move each explanation, a practical recommendation, and whether actions you tried made a difference.
// Answers are the user's reports, not measurements: they shift likelihood but never override what the readings show.

const WINDOWS = { 'night (0–6)': [0, 6], 'morning (6–12)': [6, 12], 'midday (12–17)': [12, 17], 'evening (17–24)': [17, 24] };
const WIN_LABEL = { 'night (0–6)': 'overnight (midnight–6 AM)', 'morning (6–12)': 'mornings (6 AM–noon)', 'midday (12–17)': 'afternoons (noon–5 PM)', 'evening (17–24)': 'evenings (5 PM–midnight)' };
const isIso = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

/** Questions the app may ask. Each says why it matters and which explanations an answer supports (+) or weakens (−). */
export const QUESTIONS = {
  home_more: {
    kinds: ['change', 'thermostat'],
    text: (v) => `Has anyone been home more than usual since about ${md(v.since)}?`,
    why: 'A daytime increase can come from people being home more — or from heating or appliances. Your answer separates them.',
    options: [['lots', 'Yes, considerably more'], ['little', 'A little more'], ['no', 'No, our routine hasn’t changed'], ['unknown', 'I’m not sure']],
    effect: { home: { lots: 2, little: 1, no: -3 }, occupied: { lots: 2, little: 1, no: -3 } },
  },
  heat_on: {
    kinds: ['change', 'overnight', 'evening', 'standby', 'thermostat'], scope: 'home',
    text: () => 'Has your building switched from cooling to heating?',
    why: 'If the heat came on recently, colder days explain part of the change, and the heating schedule becomes the lever.',
    options: [['yes', 'Yes, the heat is on'], ['no', 'No, not yet'], ['unknown', 'I’m not sure']],
    effect: { heating: { yes: 1, no: -3 }, cooling_weather: { yes: -3 }, cooling_setting: { yes: -3 }, space_heater: { no: 1 } },
    known: (s) => (setupInfo(s).complete && s.profile.buildingMode === 'heat_available' ? 'yes' : setupInfo(s).complete && s.profile.buildingMode === 'cool_available' ? 'no' : null),
  },
  new_appliance: {
    kinds: ['change', 'standby', 'overnight'],
    text: (v) => `Around ${md(v.since)}, did you start running something that stays on day and night — a dehumidifier, aquarium, second fridge or freezer?`,
    why: 'Something that stays on raises use at every hour, including overnight; the readings can show that pattern but not which device it is.',
    options: [['yes', 'Yes'], ['no', 'No'], ['unknown', 'I’m not sure']],
    effect: { device: { yes: 2, no: -1 }, new: { yes: 2, no: -1 }, devices: { yes: 1 } },
  },
  daytime_device: {
    kinds: ['change'],
    text: (v) => `Since about ${md(v.since)}, has anything new been running for hours during the day — a space heater, dehumidifier, portable AC, or computer or gaming equipment?`,
    why: 'The readings show a load of several hundred watts running for hours each afternoon. Only you can see what it is.',
    options: [['heater', 'Yes — a space heater'], ['other', 'Yes — something else'], ['no', 'No, nothing new'], ['unknown', 'I’m not sure']],
    effect: { daytime_load: { heater: 2, other: 3, no: -2 }, space_heater: { heater: 3, other: -1, no: -3 } },
  },
  cooling_longer: {
    kinds: ['change'],
    text: (v) => `Have you noticed the AC running more than usual in the afternoons since about ${md(v.since)}?`,
    why: 'Use at the same outdoor temperature nearly doubled. If the AC is running more, the setting or the equipment is the lead; if not, look for an appliance.',
    options: [['yes', 'Yes, more than usual'], ['no', 'No, about the same'], ['unknown', 'I haven’t noticed']],
    effect: { cooling_setting: { yes: 2, no: -2 }, daytime_load: { yes: -1, no: 1 } },
  },
  fan_mode: {
    kinds: ['change'], scope: 'home',
    text: () => 'Is the thermostat’s fan set to AUTO or ON?',
    why: 'A fan left ON runs all day and night. Your nights barely changed, so this is a quick way to rule it in or out.',
    options: [['auto', 'AUTO'], ['on', 'ON'], ['unknown', 'I’m not sure']],
    effect: { fan_on: { on: 3, auto: -3 } },
  },
  space_heater: {
    kinds: ['change'],
    text: (v) => `Have you been running a plug-in space heater since about ${md(v.since)}?`,
    why: 'A space heater draws 1,000–1,500 W while on — a steady daytime load in the readings.',
    options: [['yes', 'Yes'], ['no', 'No'], ['unknown', 'I’m not sure']],
    effect: { space_heater: { yes: 3, no: -3 }, daytime_load: { yes: 1 } },
    coveredBy: ['daytime_device'], // already answered there (it names space heaters) — never asked twice
  },
  more_appliances: {
    kinds: ['change'],
    text: (v) => `Since about ${md(v.since)}, have you been cooking, doing laundry or using other appliances more than usual?`,
    why: 'Appliances show up as short peaks; heating shows up as a steady higher level. Your answer helps tell them apart.',
    options: [['yes', 'Yes, more than usual'], ['no', 'No, about the same'], ['unknown', 'I’m not sure']],
    effect: { bursts: { yes: 2, no: -1 } },
  },
  unusual_day: {
    kinds: ['change'], needs: (v) => !!v.bigDay,
    text: (v) => `Was ${dayName(v.bigDay)} an unusual day at home — guests, big cooking, laundry, a party?`,
    why: 'One busy day can lift a short average without any lasting change.',
    options: [['yes', 'Yes, it was unusual'], ['no', 'No, a normal day'], ['unknown', 'I don’t remember']],
    effect: { oneoff: { yes: 2, no: -1 } },
  },
  routine_day: {
    kinds: ['evening', 'overnight'], needs: (v) => !!v.day,
    text: (v) => `Do you usually do laundry, run the dishwasher or cook a big meal on ${v.day} ${v.part === 'evening' ? 'evenings' : 'nights'}?`,
    why: 'A weekly chore explains a weekly pattern — then the lever is how the appliance is used, not the thermostat.',
    options: [['yes', 'Yes'], ['no', 'No'], ['unknown', 'I’m not sure']],
    effect: { routine: { yes: 2, no: -2 }, activity: { yes: 1 }, device: { no: 1 } },
  },
  thermostat_changed: {
    kinds: ['change', 'thermostat', 'overnight', 'standby'],
    text: () => 'Did anyone change the thermostat settings or leave it on HOLD recently?',
    why: 'A colder cooling setting or a HOLD makes the AC run longer without anyone noticing.',
    options: [['colder', 'Yes — set colder, or on HOLD'], ['warmer', 'Yes — set warmer'], ['no', 'No'], ['unknown', 'Not sure']],
    effect: { cooling_setting: { colder: 2, warmer: -1, no: -1 }, heating: { warmer: 1 } },
  },
  hvac_meter: {
    kinds: ['*'], scope: 'home', setting: 'hvacMetered',
    text: () => 'Is your heating and cooling electricity billed to your own meter?',
    why: 'If the building pays for it, thermostat changes won’t lower your bill, so the advice should focus on other uses.',
    options: [['yes', 'Yes'], ['partial', 'Partly (fan only)'], ['no', 'No, the building pays'], ['unknown', 'I don’t know']],
    effect: {},
    known: (s) => (s.profile.hvacMetered !== 'unknown' ? s.profile.hvacMetered : null),
  },
};
const optLabel = (q, v) => QUESTIONS[q]?.options.find(([k]) => k === v)?.[1] ?? v;

/** The latest answer to a question for this investigation (or for the home, for home-wide questions). */
export function answerFor(state, q, key) {
  const scoped = QUESTIONS[q]?.scope === 'home';
  const list = (state.answers || []).filter((a) => a.q === q && (scoped || a.key === key));
  const a = list[list.length - 1];
  if (a) return { ...a, source: 'you', history: list.length };
  const k = QUESTIONS[q]?.known?.(state);
  return k ? { q, value: k, source: 'settings' } : null;
}

const STATUS = {
  likely: 'Likely', fits: 'Fits the readings', possible: 'Possible', open: 'Not yet clear', less: 'Less likely',
  notsup: 'Not supported by the readings', out: 'Ruled out by the readings', outByYou: 'Ruled out by what you told us', conflict: 'Your answer and the readings disagree',
};
/**
 * Combine the readings' verdict with the household's answers. Answers are reports, not measurements: they shift likelihood,
 * and a confirmed fact (score ≤ −3) rules an explanation out unless the readings directly contradict it (then: conflict).
 * Readings: supported +2, not yet clear 0, not supported −1, ruled out −2.
 */
function statusOf(h, score) {
  const t = { supported: 2, 'not yet clear': 0, 'not supported': -1, 'ruled out': -2 }[h.verdict] ?? 0;
  // A confirmed household fact overrides an explanation judged by resemblance; only direct measurements can "disagree" with you.
  if (score <= -3) return t === 2 && !h.inferred ? 'conflict' : 'outByYou';
  if (!h.inferred && t < 0 && score > 0) return 'conflict'; // you report something a direct measurement doesn't show
  if ((t === -2 && score > 0) || (t === 2 && score < 0)) return h.inferred ? (score < 0 ? 'less' : 'possible') : 'conflict';
  if (t === -2) return 'out';
  if (t === -1 && score <= 0) return 'notsup';
  const total = t + score;
  if (total >= 3 || (t >= -1 && score >= 2)) return 'likely';
  if (t === 2 && score === 0) return 'fits';
  if (total >= 1) return 'possible';
  if (total <= -1) return 'less';
  return 'open';
}

/** The investigation the app leads with, or null when nothing needs investigating. */
export function investigation({ state, temps = {}, now = Date.now(), report = null, ops = null }) {
  const r = report || usageReport({ state, temps, now });
  if (r.level === 'none') return null;
  if (r.n < 14) return { kind: 'gather', title: 'Collecting enough data', headline: `${r.n} full day${r.n === 1 ? '' : 's'} so far — investigations start at about two weeks, so patterns aren’t mistaken for noise.` };
  const o = ops || opportunities({ state, rec: C.recommend(state, [], now), model: C.energyWeatherModel(state.usage, temps), summary: C.usageSummary(state.usage, state.profile.tariff), report: r });
  const pr = ruleDecide({ state, temps, report: r, ops: o });
  if (pr.priority === 'none') return { kind: 'none', title: 'Nothing unusual to investigate', headline: noChangeSummary(r, o) || 'Your recent use looks typical for your home.' };
  const ex = explainFinding({ state, temps, hd: r.hd, report: r }, pr.priority);
  const t = ex.tests;
  if (!t?.available || !ex.hypotheses.length) return { kind: pr.priority, title: PRIORITIES[pr.priority], headline: 'Not enough hourly readings to test explanations yet.', hypotheses: [] };

  // What we know (measured), and the details questions need.
  const v = { kind: pr.priority, since: t.from || r.from, day: t.day, part: t.part, bigDay: (t.biggest_day_share_pct ?? 0) >= 25 ? t.biggest_day?.date : null };
  const known = [];
  let headline = '', attribution = null;
  if (pr.priority === 'change') {
    const pct = ((t.recent_kwh_per_day - t.before_kwh_per_day) / t.before_kwh_per_day) * 100;
    attribution = Object.entries(t.change_kwh_per_day_by_time_of_day).map(([w, k]) => ({ window: WIN_LABEL[w], kwh: k, share: t.share_of_increase_pct[w] })).sort((a, b) => b.kwh - a.kwh);
    headline = `Your electricity use rose about ${fmt(pct)}% since ${md(t.from)}, mostly ${attribution[0].window}.`;
    known.push(`Last ${t.recent_days} days: ${fmt(t.recent_kwh_per_day, 1)} kWh a day, vs ${fmt(t.before_kwh_per_day, 1)} in the 4 weeks before.`);
    known.push(`${cap(attribution[0].window)} account for ${attribution[0].share}% of the increase (about ${fmt(attribution[0].kwh, 1)} kWh a day).`);
    known.push(`${t.recent_temp_f != null && t.before_temp_f != null ? `Outside it averaged ${fmt(t.recent_temp_f)}°F, vs ${fmt(t.before_temp_f)}°F before. ` : 'No outdoor temperatures for this period yet, so weather can’t be checked. '}${t.days_above_usual} of ${t.recent_days} days were above your usual.`);
  } else if (pr.priority === 'overnight' || pr.priority === 'evening') {
    headline = `${t.day} ${t.part === 'evening' ? 'evenings' : 'nights'} use about ${fmt(t.avg_extra_kwh, 1)} kWh more than other days — ${t.weeks_with_excess} of ${t.occurrences} weeks.`;
    known.push(`The extra usually runs ${t.usual_start}–${t.usual_end}, about ${fmt(t.avg_extra_watts)} W on average.`);
    known.push(`Its size varies ${t.size_variation_pct}% from week to week; the rest of that day is ${t.rest_of_day_extra_watts >= 0 ? `${fmt(t.rest_of_day_extra_watts)} W higher` : `${fmt(-t.rest_of_day_extra_watts)} W lower`} than other days.`);
  } else if (pr.priority === 'standby') {
    headline = `About ${fmt(r.night.alwaysOn ?? r.night.base)} W runs around the clock, even on mild nights.`;
    known.push(`Quietest hour over ${t.nights} nights: about ${fmt(t.quietest_hour_watts)} W; early weeks ${fmt(t.early_weeks_watts)} W, recent weeks ${fmt(t.recent_weeks_watts)} W.`);
  } else if (pr.priority === 'thermostat') {
    headline = `On weekdays, use stays near evening levels while nobody should be home (${t.away_hours}).`;
    known.push(`About ${fmt(t.away_watts)} W while away — ${fmt(t.above_floor_watts)} W above the overnight floor.`);
  }
  const key = `${pr.priority}:${v.since}`;

  // Explanations: readings verdict + answers → status, with evidence for and against.
  const qs = Object.entries(QUESTIONS).filter(([, q]) => (q.kinds.includes('*') || q.kinds.includes(pr.priority)) && (!q.needs || q.needs(v)));
  const hyps = ex.hypotheses.map((h) => {
    let score = 0;
    const answers = [], forE = [], againstE = [];
    (h.verdict === 'supported' || h.verdict === 'not yet clear' ? forE : againstE).push(`Readings: ${h.why}`);
    for (const [qid, q] of qs) {
      const eff = q.effect[h.id];
      const a = eff && answerFor(state, qid, key);
      if (!a || a.value === 'unknown') continue;
      let d = eff[a.value] ?? 0;
      // A setting is background, not a report about this change: it may support an explanation but never contradict the readings.
      if (a.source === 'settings') d = 0; // a setting says what is true now, not that something changed — context only
      score += d;
      const line = `${a.source === 'settings' ? 'Your settings' : 'You said'}: “${optLabel(qid, a.value)}”`;
      if (d > 0) forE.push(line); else if (d < 0) againstE.push(line); else if (a.source === 'settings') forE.push(`${line} (context)`);
      answers.push({ q: qid, value: a.value });
    }
    const status = statusOf(h, score);
    const missing = qs.filter(([qid, q]) => q.effect[h.id] && !answerFor(state, qid, key)).map(([, q]) => q.text(v));
    return { ...h, score, status, label: STATUS[status], for: forE, against: againstE, answers, missing, verify: h.check };
  });

  // Next question: the unanswered one most able to change a conclusion.
  const weight = { fits: 3, possible: 2, open: 2, conflict: 2, likely: 1, less: 0.5, notsup: 0, out: 0, outByYou: 0 }; // questions that can move a live explanation
  let question = null, best = 0;
  const lead0 = [...hyps].sort((a, b) => (weight[b.status] ?? 0) - (weight[a.status] ?? 0))[0];
  for (const [qid, q] of qs) {
    if (answerFor(state, qid, key) || (q.coveredBy || []).some((c) => answerFor(state, c, key))) continue;
    // Can it confirm or rule out the leading explanation? Then how many other live explanations does it touch?
    const ws = Object.keys(q.effect).map((hid) => weight[hyps.find((x) => x.id === hid)?.status] ?? 0).sort((a, b) => b - a);
    let w = (ws[0] ?? 0) + 0.5 * ws.slice(1).reduce((a, x) => a + x, 0) + (lead0 && q.effect[lead0.id] && (weight[lead0.status] ?? 0) > 0 ? 1 : 0);
    if (qid === 'hvac_meter' && hyps.some((x) => x.thermostat && x.status !== 'out')) w = 1.5;
    if (w > best) { best = w; question = { id: qid, text: q.text(v), why: q.why, options: q.options }; }
  }

  // Recommendation from the leading explanation; thermostat advice only if HVAC is on this meter.
  const order = { likely: 0, fits: 1, possible: 2, conflict: 3, open: 4, less: 5, notsup: 6, out: 7, outByYou: 8 };
  const ranked = [...hyps].filter((h) => !['out', 'outByYou', 'notsup', 'less'].includes(h.status)).sort((a, b) => order[a.status] - order[b.status] || b.score - a.score);
  const metered = state.profile.hvacMetered;
  const lead = ranked.find((h) => !(h.thermostat && metered === 'no')) || null;
  let recommendation = lead ? recommend(pr.priority, lead, t, r, state, metered, o, ranked) : null;
  // Within the household's usual total range, the finding is about ONE time of day against its own history, not a rise to chase.
  const bl = r.baseline, normalTotal = pr.priority === 'change' && bl && ['typical', 'return_to_typical', 'unusually_low'].includes(bl.status);
  const stand = normalTotal ? (bl.windows || []).filter((x) => x.flag === 'high').sort((a, b) => b.recent_w - b.usual_w - (a.recent_w - a.usual_w))[0] : null;
  const part = (w) => w.name.replace(/ \(.*/, '');
  let supersedes = null, title = PRIORITIES[pr.priority];
  if (normalTotal) {
    supersedes = { status: bl.status, text: `Earlier this was shown as “${headline}” That compares the last two weeks with a short, unusually low stretch. Against your full history, your total use is ${bl.status === 'return_to_typical' ? 'back to normal' : 'normal'}, so that framing is superseded.` };
    title = stand ? 'One part of your day stands out' : 'Back to your usual use';
    headline = stand ? `Your total use is normal, but ${part(stand)}s are the highest they’ve been: ${fmt(stand.recent_w)} W vs a usual ${fmt(stand.low_w)}–${fmt(stand.high_w)} W.` : bl.headline;
    // The usual "since it started" facts compare with the low stretch before, so they are replaced by comparisons with the household's own history.
    known.length = 0;
    known.push(...bl.lines, ...bl.caveats.slice(0, 2).map((c) => `Limit: ${c}`));
    if (stand) known.push('The explanations below were tested against the 4 weeks before the change, which were unusually low overall: they show what changed since then, not how afternoons compare with your usual.');
    if (recommendation && stand) {
      const extra = ((stand.recent_w - stand.usual_w) * (BLOCKS[stand.name][1] - BLOCKS[stand.name][0])) / 1000, rf = rateFor(state);
      recommendation = { ...recommendation, title: `Find out what runs in the ${part(stand)}s (about ${fmt(stand.recent_w - stand.usual_w)} W above your usual)`,
        problem: `${cap(part(stand))}s average ${fmt(stand.recent_w)} W — higher than in any earlier two weeks (usual ${fmt(stand.low_w)}–${fmt(stand.high_w)} W). Your total is normal, so this is about one time of day.`,
        expected: `Compared with your usual ${part(stand)}s that is about ${fmt(extra, 1)} kWh a day, ${fmt(extra * 30)} kWh a month${rf.rate != null ? ` (≈ $${fmt(extra * 30 * rf.rate, 2)} at ${rf.source})` : ''} if it continues. If it is something you chose or need (cooling, equipment you use), it is normal; if you can’t account for it, it is worth tracing.` };
    }
  }
  const awayFlags = unoccupiedUse({ state, now });
  const settled = hyps.filter((h) => h.status === 'likely'), fit = hyps.filter((h) => h.status === 'fits');
  const conflictNote = hyps.some((h) => h.status === 'conflict') ? ' One of your answers disagrees with the readings — worth a second look.' : '';
  const conclusion = settled.length ? `Most likely: ${settled.map((h) => h.title.toLowerCase()).join(' and ')}.${conflictNote}`
    : fit.length ? `Best fit with the readings so far: ${fit.map((h) => h.title.toLowerCase()).join(' and ')} — not confirmed yet.${conflictNote}`
      : `No explanation is settled yet.${conflictNote}`;
  const answered = qs.map(([qid, q]) => ({ qid, q, a: answerFor(state, qid, key) })).filter((x) => x.a).map(({ qid, q, a }) => ({ q: qid, text: q.text(v), value: a.value, label: optLabel(qid, a.value), source: a.source, at: a.at || null, corrected: (a.history || 1) > 1 }));
  return { key, kind: pr.priority, title, headline, known, attribution: normalTotal ? null : attribution, tests: t, hypotheses: hyps, question, answered, conclusion: normalTotal ? `Your total use is normal for you, so this is a question about one time of day, not a fault. ${conclusion}` : conclusion, recommendation, since: v.since, baseline: bl || null, supersedes, away: awayFlags };
}

/** $/kWh: the confirmed rate, else the average implied by the cost column of the imported Delmarva file (last 60 days). */
export function rateFor(state) {
  const confirmed = C.energyCost(1, state.profile.tariff);
  if (confirmed != null) return { rate: confirmed, source: 'your confirmed rate' };
  const days = C.dailyTotals(state.usage).filter((d) => d.complete && d.cost != null).slice(-60);
  const kwh = sum(days.map((d) => d.kwh)), cost = sum(days.map((d) => d.cost));
  return days.length >= 14 && kwh > 0 && cost / kwh > 0.03 && cost / kwh < 1 ? { rate: cost / kwh, source: 'the costs in your Delmarva file' } : { rate: null, source: null };
}

function recommend(kind, h, t, r, state, metered, ops, ranked = []) {
  const rf = rateFor(state), rate = rf.rate, money = (k) => (rate != null ? ` (≈ $${fmt(k * rate, 2)} at ${rf.source})` : '');
  const out = { hypothesis: h.id, title: h.action, problem: '', expected: '', verify: '', hours: null, note: '' };
  const thermoNote = h.thermostat && metered !== 'yes' ? (metered === 'unknown' ? ' Whether this lowers your bill depends on heating and cooling being on your meter (not confirmed yet).' : metered === 'partial' ? ' Only the fan is on your meter, so most of the heating or cooling saving goes to the building.' : '') : '';
  if (kind === 'change') {
    const top = Object.entries(t.change_kwh_per_day_by_time_of_day).sort((a, b) => b[1] - a[1])[0];
    const extraDay = t.recent_kwh_per_day - t.before_kwh_per_day;
    out.problem = `About ${fmt(extraDay, 1)} kWh a day more than before, ${t.share_of_increase_pct[top[0]]}% of it ${WIN_LABEL[top[0]]}.`;
    if (h.status === 'open' || (h.status === 'conflict' && h.id !== 'home')) {
      // Nothing confirmed yet: the useful step is finding out, not acting on a guess.
      const open = (ranked || []).filter((x) => x.status === 'open' || x.status === 'conflict');
      out.title = `Find out what’s adding ${fmt(extraDay, 1)} kWh a day (mostly ${WIN_LABEL[top[0]]})`;
      out.expected = `If it continues, about ${fmt(extraDay * 30)} kWh a month${money(extraDay * 30)}. Finding the cause comes first; the readings can’t name it.`;
      out.detail = `Quick checks: ${open.map((x) => x.check).join(' ')}`;
      out.hours = WINDOWS[top[0]];
      out.verify = 'Answer the question above, or check during those hours; the explanation list updates as soon as you do.';
      return out;
    }
    const [wa, wb] = WINDOWS[t.largest_change], winH = wb - wa;
    const loadKwh = (Math.max(0, (t.window_watts_after ?? 0) - (t.window_watts_before ?? 0)) * winH) / 1000;
    if (h.id === 'daytime_load' || h.id === 'space_heater') {
      out.title = h.id === 'space_heater' && h.status === 'likely' ? 'Use the space heater less — or ask the building about the cold' : `Find what runs for hours in the ${WIN_LABEL[t.largest_change]} (about ${wRange(t.sustained_rise_watts, (t.window_watts_after ?? 0) - (t.window_watts_before ?? 0))} W)`;
      out.expected = `That window now uses about ${fmt(loadKwh, 1)} kWh a day more than before — about ${fmt(loadKwh * 30)} kWh a month${money(loadKwh * 30)} if it continues. Switching the cause off would remove most of it; how much depends on what it is.`;
      out.detail = h.id === 'space_heater' && h.status === 'likely' ? 'A heater running while the building is still cooling is fighting the AC. Dress warmer, heat only the room you’re in for shorter times, or ask management to adjust the cooling.' : `Mid-afternoon, look for anything new that runs for hours: a space heater, dehumidifier, portable AC, aquarium heater, computer or gaming equipment. Switch suspects off for a few afternoons, then import a newer file — the ${t.window} level should drop by about ${fmt(t.sustained_rise_watts)} W if you found it.`;
      out.hours = WINDOWS[t.largest_change];
      out.verify = `Mark it started below. After 7+ days of new readings, the app compares ${WIN_LABEL[t.largest_change]} with the 4 weeks before.`;
      out.note = thermoNote;
      return out;
    }
    if (h.id === 'cooling_setting') {
      const extra = (Math.max(0, (t.same_temp_watts_after ?? 0) - (t.same_temp_watts_before ?? 0)) * winH) / 1000;
      out.title = 'Put the cooling back to your usual setting and clear any HOLD';
      out.expected = `At the same outdoor temperatures ${WIN_LABEL[t.largest_change]} use about ${fmt(extra, 1)} kWh a day more than before — about ${fmt(extra * 30)} kWh a month${money(extra * 30)} if it’s the AC. With cooler, drier weather the AC should be running less.`;
      out.detail = 'Check the cooling setpoint (warmer is cheaper; 76–78°F is typical), make sure it isn’t on HOLD and the fan is on AUTO. If the AC runs constantly at a normal setting, report it to building maintenance — that can be a fault.';
      out.hours = WINDOWS[t.largest_change];
      out.verify = `After 7+ days of new readings, the app compares ${WIN_LABEL[t.largest_change]} with before.`;
      out.note = thermoNote;
      return out;
    }
    if (h.id === 'fan_on') {
      const kwh = (Math.max(0, t.night_change_watts) * 24) / 1000;
      out.title = 'Set the thermostat fan to AUTO';
      out.expected = `A continuously running fan adds roughly ${fmt(t.night_change_watts)} W around the clock here — about ${fmt(kwh * 30)} kWh a month${money(kwh * 30)}.`;
      out.verify = 'After a week of new readings, the app compares overnight use with before.';
      out.hours = [0, 6];
      out.note = thermoNote;
      return out;
    }
    if (h.id === 'cooling_weather') { out.title = 'Nothing unusual — it’s the weather'; out.expected = 'Cooling follows the weather; nothing changed in how your home uses it.'; out.verify = 'Watch whether use falls as the weather cools.'; return out; }
    if (h.id === 'oneoff') { out.title = 'No change needed for one unusual day'; out.expected = 'One busy day doesn’t mean a lasting change.'; out.verify = 'Import a newer file in a week: if daily use is back near the old level, it was a one-off.'; return out; }
    if (h.id === 'home' && h.status === 'conflict') {
      out.title = `Find out what runs ${WIN_LABEL[top[0]]}`;
      out.expected = `Something adds about ${fmt(top[1], 1)} kWh a day then — about ${fmt(top[1] * 30)} kWh a month${money(top[1] * 30)} if it continues. Finding it is the first step; the readings can’t say what it is.`;
      out.detail = `You said nobody is home more, yet the readings show extra use ${WIN_LABEL[top[0]]}. Check the thermostat’s Day setting (is it on HOLD at a home temperature?), timers, and anything left plugged in — a space heater, dehumidifier or charger.`;
      out.hours = WINDOWS[top[0]];
    } else if (h.id === 'home') {
      out.title = `Trim daytime use while you’re home (${WIN_LABEL[top[0]]})`;
      out.expected = `That window adds about ${fmt(top[1], 1)} kWh a day. If you trimmed it by a quarter — an assumption, not a measurement — that’s about ${fmt(top[1] * 0.25 * 30)} kWh a month${money(top[1] * 0.25 * 30)}. If people are simply home more, much of it is normal use.`;
      out.detail = 'Practical levers: heat or cool only the rooms in use, switch off screens and lights in empty rooms, run full laundry and dishwasher loads, and avoid a space heater alongside central heat.';
      out.hours = WINDOWS[top[0]];
    } else if (h.id === 'heating') {
      const sb = ops.find((x) => x.id === 'heat-away')?.est ?? null;
      // Steady extra draw in the window where it shows, times that window's hours (plus any rise in the all-day floor elsewhere).
      const [wa, wb] = WINDOWS[t.largest_change], winH = wb - wa;
      const kwhDay = (Math.max(0, t.sustained_rise_watts) * winH + Math.max(0, t.daytime_floor_rise_watts) * (14 - winH)) / 1000;
      out.title = h.title.startsWith('Cooling') ? 'Ease the cooling setting while you’re home' : 'Lower the heat you live at by 1–2°F, and check for a HOLD';
      out.expected = `The steady extra draw is about ${fmt(t.sustained_rise_watts)} W ${WIN_LABEL[t.largest_change]} (≈${fmt(kwhDay, 1)} kWh a day, ${fmt(kwhDay * 30)} kWh a month${money(kwhDay * 30)}). General guidance (U.S. DOE): roughly 1% of heating energy per °F held lower; 1–2°F would trim a few percent of heating use — an estimate, not a measurement from your data.${sb ? ` A lower Away setting is estimated at about ${fmt(sb)} kWh a month from your data.` : ''}`;
      out.detail = h.action;
      out.hours = [8, 22];
    } else if (h.id === 'device') {
      const kwh = Math.max(0, t.floor_change_watts) * 24 * 30 / 1000;
      out.expected = `Your around-the-clock floor rose about ${fmt(t.floor_change_watts)} W — about ${fmt(kwh)} kWh a month${money(kwh)} if it keeps running.`;
    }
    out.verify = `Mark it as started below. After 7+ days of new readings, the app compares ${out.hours ? WIN_LABEL[top[0]] : 'daily use'} with the 4 weeks before.`;
  } else if (kind === 'overnight' || kind === 'evening') {
    const month = t.avg_extra_kwh * 4.3;
    out.problem = `About ${fmt(t.avg_extra_kwh, 1)} kWh extra each ${t.day} ${t.part === 'evening' ? 'evening' : 'night'} (${t.usual_start}–${t.usual_end}).`;
    out.expected = `That’s about ${fmt(month)} kWh a month${money(month)}. If half of it could be avoided — an assumption — about ${fmt(month / 2)} kWh${money(month / 2)}.`;
    out.hours = t.part === 'evening' ? [17, 22] : [1, 5];
    out.verify = `After 3+ more ${t.day}s, the app compares those hours with the weeks before you started.`;
  } else if (kind === 'standby') {
    const w = r.night.alwaysOn ?? r.night.base, month = (Math.max(0, w - 150) / 1000) * 24 * 30;
    out.problem = `About ${fmt(w)} W runs around the clock.`;
    out.expected = h.id === 'heating' ? 'Part of the overnight floor is heating; the Night setting is the lever.' : `Bringing it to about 150 W (a typical apartment floor — an assumption) would save about ${fmt(month)} kWh a month${money(month)}.`;
    out.hours = [1, 5];
    out.verify = 'After a week of new readings, the app compares your 1–5 AM use with before.';
  } else if (kind === 'thermostat') {
    const month = ((t.above_floor_watts || 0) / 1000) * 8 * 21.7;
    out.problem = `About ${fmt(t.away_watts)} W while nobody should be home.`;
    out.expected = `If weekday daytime use fell to the overnight floor, about ${fmt(month)} kWh a month${money(month)} — an upper bound.`;
    const hm = /(\d{2}):00-(\d{2}):00/.exec(t.away_hours || '');
    out.hours = hm ? [+hm[1], +hm[2]] : null;
    out.verify = 'After a week of new readings, the app compares weekday away hours with before.';
  }
  out.note = thermoNote;
  return out;
}

/** Did an action you tried change anything? Weather-adjusted for whole days when the weather model is meaningful. */
export function evaluateAction({ state, temps = {}, action }) {
  if (!isIso(action.start)) return { status: 'notstarted', label: 'Not started' };
  const days = C.dailyTotals(state.usage).filter((d) => d.complete);
  const after = days.filter((d) => d.date >= action.start), before = days.filter((d) => d.date < action.start && d.date >= addDays(action.start, -28));
  if (after.length < 7 || before.length < 14) return { status: 'notyet', label: `Not measurable yet — ${Math.max(0, 7 - after.length)} more day${7 - after.length === 1 ? '' : 's'} of readings after ${md(action.start)} needed`, days: after.length };
  if (!action.hours) {
    const ev = C.evaluateSavings({ usage: state.usage, temps, changeDate: action.start, tariff: state.profile.tariff, baselineEnd: action.start });
    const map = { likely_savings: 'improvement', likely_increase: 'increase', inconclusive: 'inconclusive' };
    if (map[ev.status]) return { status: map[ev.status], label: LABEL_EVAL[map[ev.status]], diff: -ev.diff / ev.after, unc: ev.unc / ev.after, method: 'whole-day use vs. what the weather predicts', days: ev.after };
  }
  const hd = hourlyByDay(state.usage, [...before, ...after].map((d) => d.date));
  const [a, b] = action.hours || [0, 24];
  const val = (d) => sum(d.h.slice(a, b));
  const A1 = hd.filter((d) => d.date >= action.start).map(val), B1 = hd.filter((d) => d.date < action.start).map(val);
  if (A1.length < 7 || B1.length < 14) return { status: 'notyet', label: 'Not measurable yet — needs hourly readings on both sides', days: A1.length };
  const diff = avg(A1) - avg(B1), se = Math.sqrt(sd(A1) ** 2 / A1.length + sd(B1) ** 2 / B1.length);
  const status = diff < -2 * se ? 'improvement' : diff > 2 * se ? 'increase' : 'inconclusive';
  return { status, label: LABEL_EVAL[status], diff, unc: 2 * se, method: `${a}:00–${b}:00 use per day, ${A1.length} days after vs ${B1.length} days before (not weather-adjusted)`, days: A1.length };
}
const LABEL_EVAL = { improvement: 'Consistent with an improvement', increase: 'Use went up instead', inconclusive: 'Inconclusive so far — the change is within normal day-to-day variation' };
export const ACTION_STATUS = { planning: 'Planning to try', started: 'Started', completed: 'Done', impractical: 'Not practical', nohelp: 'Didn’t help' };

/** Zones for the next apartment. Used only from the move-in date; never applied to earlier history. */
export function zonePlans(state, now = Date.now()) {
  const today = C.localParts(now).date;
  if (!isIso(state.moveIn) || state.moveIn > today || !(state.zones || []).length) return null;
  return state.zones.map((z) => {
    const profile = { ...state.profile, hvacType: z.hvacType, buildingMode: z.availability, hvacMetered: z.metered, comfort: { ...state.profile.comfort, heat: { ...z.heat }, cool: { ...z.cool } } };
    return { zone: z, rec: C.recommend({ ...state, profile }, [], now) };
  });
}

// ================= Backups: merge safely between devices =================
// Restoring never silently replaces data. A backup is validated, compared with this device, and merged: new records are
// added, identical ones kept once, and anything that differs is listed as a conflict for you to choose (default: keep this
// device's value). A copy of this device's data is saved first, the result is read back to verify, and the merge can be undone.

const sameNum = (a, b) => Math.abs(a - b) < 1e-9;
const SETTING_AREAS = { thermostat: 'Thermostat as you set it', buildingMode: 'Building season', comfort: 'Comfort temperatures', routine: 'Routine', tariff: 'Electricity rate', hvacType: 'Equipment', hvacMetered: 'Heating/cooling on your meter', recoveryMin: 'Warm-up time', changeDate: 'Savings start date' };

/** Read a backup file's text: an Energy backup (version 1 or 2) or a household update. Throws with a plain reason. */
export function parseBackup(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('This file isn’t valid JSON.'); }
  if (raw?.kind === 'aeo-household-update') return { kind: 'household', update: validateHousehold(raw) };
  if (!raw || typeof raw !== 'object' || !raw.profile || ![1, 2].includes(raw.version)) throw new Error('This isn’t an Energy app backup.');
  const state = migrate(raw);
  return { kind: 'backup', state, meta: { exportedAt: typeof raw.meta?.exportedAt === 'string' ? raw.meta.exportedAt.slice(0, 30) : null, device: typeof raw.meta?.device === 'string' ? raw.meta.device.slice(0, 20) : null }, aiReports: Array.isArray(raw.aiReports) ? raw.aiReports.slice(-10) : [] };
}

/** What a merge would do. Nothing is changed. */
export function planMerge(local, incoming) {
  const plan = { add: {}, same: {}, conflicts: [] };
  const inc = (k, n = 1) => { plan.add[k] = (plan.add[k] || 0) + n; }, same = (k) => { plan.same[k] = (plan.same[k] || 0) + 1; };
  let readingConflicts = 0;
  const sample = [];
  for (const part of ['hourly', 'daily', 'cost']) {
    for (const [k, v] of Object.entries(incoming.usage[part] || {})) {
      const lv = local.usage[part]?.[k];
      if (lv == null) inc(part === 'cost' ? 'costs' : 'readings');
      else if (sameNum(lv, v)) same('readings');
      else { readingConflicts++; if (sample.length < 3) sample.push(`${k}: ${lv} here vs ${v} in the backup`); }
    }
  }
  if (readingConflicts) plan.conflicts.push({ id: 'readings', label: `${readingConflicts} electricity reading${readingConflicts === 1 ? '' : 's'} differ`, detail: sample.join('; '), local: 'Keep this device’s readings', incoming: 'Use the backup’s readings' });
  const ansKey = (a) => [a.q, a.key, a.value, a.at, a.since].join('|');
  const la = new Set((local.answers || []).map(ansKey));
  for (const a of incoming.answers || []) la.has(ansKey(a)) ? same('answers') : inc('answers');
  const actById = new Map((local.actions || []).map((a) => [a.id, a]));
  for (const a of incoming.actions || []) {
    const l = actById.get(a.id);
    if (!l) inc('actions'); else if (JSON.stringify(l) === JSON.stringify(a)) same('actions');
    else plan.conflicts.push({ id: `action:${a.id}`, label: `“${a.title}”`, detail: `here: ${ACTION_STATUS[l.status]}${l.start ? ` since ${l.start}` : ''}; backup: ${ACTION_STATUS[a.status]}${a.start ? ` since ${a.start}` : ''}`, local: 'Keep this device’s', incoming: 'Use the backup’s' });
  }
  const le = new Map((local.experiments || []).map((e) => [e.id, e]));
  for (const e of incoming.experiments || []) { const l = le.get(e.id); if (!l) inc('experiments'); else if (JSON.stringify(l) === JSON.stringify(e)) same('experiments'); else plan.conflicts.push({ id: `experiment:${e.id}`, label: `Experiment “${e.title}”`, detail: `here: ${l.end ? `ended ${l.end}` : 'running'}${l.decision ? `, ${l.decision}` : ''}; backup: ${e.end ? `ended ${e.end}` : 'running'}${e.decision ? `, ${e.decision}` : ''}`, local: 'Keep this device’s', incoming: 'Use the backup’s' }); }
  const lp = new Set((local.projections || []).map((p) => p.id));
  for (const p of incoming.projections || []) lp.has(p.id) ? same('projections') : inc('projections');
  const bk = (b) => `${b.end}|${b.amount}`, lb = new Set((local.bills || []).map(bk));
  for (const b of incoming.bills || []) lb.has(bk(b)) ? same('statements') : inc('statements');
  const hk = (h) => `${h.date}|${h.fingerprint}`, lh = new Set((local.programmedHistory || []).map(hk));
  for (const h of incoming.programmedHistory || []) lh.has(hk(h)) ? same('schedule history') : inc('schedule history');
  const ok = (o) => `${o.ts}|${o.roomF}|${o.setF}`, lo = new Set((local.observations || []).map(ok));
  for (const o of incoming.observations || []) lo.has(ok(o)) ? same('thermostat notes') : inc('thermostat notes');
  for (const d of Object.keys(incoming.temps || {})) if (!(d in (local.temps || {}))) inc('weather days');
  const zById = new Map((local.zones || []).map((z) => [z.id, z]));
  for (const z of incoming.zones || []) {
    const l = zById.get(z.id);
    if (!l) inc('zones'); else if (JSON.stringify(l) !== JSON.stringify(z)) plan.conflicts.push({ id: `zone:${z.id}`, label: `Next-apartment zone “${z.label}”`, detail: 'its settings differ', local: 'Keep this device’s', incoming: 'Use the backup’s' });
  }
  if (local.moveIn && incoming.moveIn && local.moveIn !== incoming.moveIn) plan.conflicts.push({ id: 'moveIn', label: 'Move-in date', detail: `${local.moveIn} here vs ${incoming.moveIn}`, local: local.moveIn, incoming: incoming.moveIn });
  if (local.programmed && incoming.programmed && local.programmed.date === incoming.programmed.date && local.programmed.fingerprint !== incoming.programmed.fingerprint) plan.conflicts.push({ id: 'programmed', label: 'Which schedule is on the thermostat', detail: `both say programmed on ${local.programmed.date}, but with different schedules`, local: 'This device’s', incoming: 'The backup’s' });
  // Settings: compared by area. A device that was never set up takes the backup's settings by default; otherwise this device's.
  const fresh = !local.profile.setupDone && incoming.profile.setupDone;
  for (const [k, label] of Object.entries(SETTING_AREAS)) {
    if (JSON.stringify(local.profile[k]) === JSON.stringify(incoming.profile[k])) continue;
    plan.conflicts.push({ id: `setting:${k}`, label, detail: `${showSetting(k, local.profile[k])} here vs ${showSetting(k, incoming.profile[k])} in the backup`, local: 'Keep this device’s', incoming: 'Use the backup’s', default: fresh ? 'incoming' : 'local' });
  }
  plan.empty = !Object.keys(plan.add).length && !plan.conflicts.length;
  return plan;
}
function showSetting(k, v) {
  if (k === 'routine') return v?.mode === 'days' ? 'day by day' : `weekdays ${v?.weekday?.wake}–${v?.weekday?.sleep}`;
  if (k === 'comfort') return `heat ${v?.heat?.home}° / cool ${v?.cool?.home}°`;
  if (k === 'thermostat') return v ? `${v.setpoint}°F ${v.hold ? 'HOLD' : ''}, programming ${v.programming || '?'}` : 'not recorded';
  if (k === 'tariff') return v?.confirmed ? `${v.centsPerKwh}¢` : 'not set';
  if (k === 'buildingMode') return { heat_available: 'heating', cool_available: 'cooling', fan_only: 'fan only', unknown: 'not set' }[v] || 'not set';
  if (k === 'hvacMetered') return { yes: 'yes', no: 'no — building pays', partial: 'partly', unknown: 'not sure' }[v] || 'not set';
  if (k === 'recoveryMin') return v ? `${v} min` : 'not set';
  if (v === '' || v == null) return 'not set';
  return String(v).replace(/_/g, ' ');
}

/** The merged state. `choices` maps conflict ids to 'local' | 'incoming'; anything not chosen keeps the conflict's default (this device). */
export function applyMerge(local, incoming, choices = {}, plan = planMerge(local, incoming)) {
  const pick = (id) => choices[id] || plan.conflicts.find((c) => c.id === id)?.default || 'local';
  const out = structuredClone(local);
  for (const part of ['hourly', 'daily', 'cost']) {
    for (const [k, v] of Object.entries(incoming.usage[part] || {})) {
      if (out.usage[part][k] == null || (pick('readings') === 'incoming' && !sameNum(out.usage[part][k], v))) out.usage[part][k] = v;
    }
  }
  for (const [d, t] of Object.entries(incoming.temps || {})) if (!(d in out.temps)) out.temps[d] = t;
  const ansKey = (a) => [a.q, a.key, a.value, a.at, a.since].join('|'), seenA = new Set(out.answers.map(ansKey));
  out.answers = [...out.answers, ...(incoming.answers || []).filter((a) => !seenA.has(ansKey(a)))].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)); // stable: correction order kept
  const byId = new Map(out.actions.map((a) => [a.id, a]));
  for (const a of incoming.actions || []) if (!byId.has(a.id) || pick(`action:${a.id}`) === 'incoming') byId.set(a.id, a);
  out.actions = [...byId.values()];
  const hk = (h) => `${h.date}|${h.fingerprint}`, seenH = new Set(out.programmedHistory.map(hk));
  out.programmedHistory = [...out.programmedHistory, ...(incoming.programmedHistory || []).filter((h) => !seenH.has(hk(h)))].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!out.programmed || (incoming.programmed && (incoming.programmed.date > out.programmed.date || (incoming.programmed.date === out.programmed.date && pick('programmed') === 'incoming')))) out.programmed = incoming.programmed || out.programmed;
  const ok = (o) => `${o.ts}|${o.roomF}|${o.setF}`, seenO = new Set(out.observations.map(ok));
  out.observations = [...out.observations, ...(incoming.observations || []).filter((o) => !seenO.has(ok(o)))].sort((a, b) => a.ts - b.ts).slice(-500);
  const exById = new Map((out.experiments || []).map((e) => [e.id, e]));
  for (const e of incoming.experiments || []) { const l = exById.get(e.id); if (!l || (pick(`experiment:${e.id}`) === 'incoming')) exById.set(e.id, e); }
  out.experiments = [...exById.values()];
  const billK = (b) => `${b.end}|${b.amount}`, seenB = new Set((out.bills || []).map(billK));
  out.bills = cleanBills([...(out.bills || []), ...(incoming.bills || []).filter((b) => !seenB.has(billK(b)))]);
  if (!out.projection && incoming.projection) out.projection = incoming.projection;
  const pHave = new Set((out.projections || []).map((p) => p.id));
  out.projections = cleanProjections([...(out.projections || []), ...(incoming.projections || []).filter((p) => !pHave.has(p.id))]);
  const zById = new Map(out.zones.map((z) => [z.id, z]));
  for (const z of incoming.zones || []) if (!zById.has(z.id) || pick(`zone:${z.id}`) === 'incoming') zById.set(z.id, z);
  out.zones = [...zById.values()].slice(0, 4);
  if (!out.moveIn || pick('moveIn') === 'incoming') out.moveIn = incoming.moveIn || out.moveIn;
  for (const k of Object.keys(SETTING_AREAS)) if (pick(`setting:${k}`) === 'incoming') out.profile[k] = structuredClone(incoming.profile[k]);
  out.profile.setupDone = !!(local.profile.setupDone || incoming.profile.setupDone); // finished on either device = finished
  out.appliedUpdates = [...new Set([...(out.appliedUpdates || []), ...(incoming.appliedUpdates || [])])];
  return migrate(out);
}

/**
 * Write a new state as one transaction: save a copy of the current data, write, read back and compare. localStorage writes one key
 * atomically, so an interruption leaves either the old data or the new — and the copy allows undo either way.
 */
export function commitState(storage, key, next, { snapshotKey = 'aeo.snapshot', reason = 'merge' } = {}) {
  const before = storage.getItem(key);
  storage.setItem(snapshotKey, JSON.stringify({ at: new Date().toISOString(), reason, state: before ? JSON.parse(before) : null }));
  const text = JSON.stringify(next);
  storage.setItem(key, text);
  if (storage.getItem(key) !== text) throw new Error('The saved data didn’t read back the same.');
  return true;
}
/** Put back the copy saved before the last merge, restore or household update (verified the same way). */
export function undoLast(storage, key, { snapshotKey = 'aeo.snapshot' } = {}) {
  const snap = JSON.parse(storage.getItem(snapshotKey) || 'null');
  if (!snap?.state) throw new Error('There’s nothing to undo.');
  const text = JSON.stringify(snap.state);
  storage.setItem(key, text);
  if (storage.getItem(key) !== text) throw new Error('The restored data didn’t read back the same.');
  storage.removeItem?.(snapshotKey);
  return snap;
}

// ================= Household updates: apply confirmed facts in one verified step =================
// A household update carries facts you confirmed (routine, what the building provides, answers). It never changes comfort
// temperatures, and applying it in the app does not reprogram the physical thermostat.

function validateHousehold(raw) {
  const days = raw.routine?.days;
  if (raw.version !== 1 || typeof raw.id !== 'string' || !days || !C.DOW.every((d) => days[d] && typeof days[d].wake === 'string')) throw new Error('This household update is incomplete.');
  for (const d of C.DOW) C.buildDay(days[d], { home: 70, away: 68, sleep: 68 }, 30); // throws with a plain reason for an impossible routine
  if (raw.buildingMode && !(raw.buildingMode in C.BUILDING_MODES)) throw new Error('Unknown building season in the update.');
  const answers = (Array.isArray(raw.answers) ? raw.answers : []).filter((a) => QUESTIONS[a.q] && QUESTIONS[a.q].options.some(([k]) => k === a.value));
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).filter((t) => typeof t === 'string' && t.trim()).slice(0, 20).map((t) => t.trim().slice(0, 300));
  const ub = raw.usualBill && Number.isFinite(+raw.usualBill.low) && Number.isFinite(+raw.usualBill.high) && +raw.usualBill.low > 0 && +raw.usualBill.high >= +raw.usualBill.low ? { low: +raw.usualBill.low, high: +raw.usualBill.high } : null;
  const base = { id: raw.id.slice(0, 60), created: String(raw.created || '').slice(0, 30), note: String(raw.note || '').slice(0, 300), routine: { mode: 'days', days: Object.fromEntries(C.DOW.map((d) => [d, { wake: days[d].wake, leave: days[d].leave || '', back: days[d].back || '', sleep: days[d].sleep }])) }, buildingMode: raw.buildingMode || null, answers };
  const pj = raw.projection && cleanProjections([{ ...raw.projection, source: raw.projection.source || 'Delmarva account screenshot, read by you', enteredAt: '' }])[0];
  return { ...base, notes, usualBill: ub, thermostat: cleanThermostat(raw.thermostat), projection: pj || null };
}
const dayLine = (r) => (r.leave && r.back ? `away ${C.fmtMin(C.toMin(r.leave))}–${C.fmtMin(C.toMin(r.back))}` : 'home all day') + `, up ${C.fmtMin(C.toMin(r.wake))}, bed ${C.fmtMin(C.toMin(r.sleep))}`;
/** Line-by-line preview: each day now → after, the building season, and the answers to be recorded. */
export function previewHousehold(state, update) {
  const lines = C.DOW.map((d) => { const now = dayLine(C.routineFor(state.profile.routine, d)), next = dayLine(update.routine.days[d]); return { day: C.DAY_NAME[d], now, next, changed: now !== next }; });
  return { lines, season: update.buildingMode && update.buildingMode !== state.profile.buildingMode ? { now: state.profile.buildingMode, next: update.buildingMode } : null, notes: update.notes || [], usualBill: update.usualBill || null, thermostat: update.thermostat || null, projection: update.projection || null, answers: update.answers.map((a) => `${{ heat_on: 'Building switched to heating', home_more: 'Home more than usual since the change', daytime_device: 'Anything new running for hours in the day', new_appliance: 'Something new running day and night', cooling_longer: 'Cooling running longer than usual', fan_mode: 'Thermostat fan setting' }[a.q] || QUESTIONS[a.q]?.short || a.q}: ${optLabel(a.q, a.value)}`), applied: (state.appliedUpdates || []).includes(update.id) };
}
/** New state with the confirmed facts applied. Investigation-specific answers are tied to the investigation open right now. */
export function applyHousehold(state, update, { investigationKey = '', today = '' } = {}) {
  const out = structuredClone(state);
  out.profile.routine = { ...out.profile.routine, mode: 'days', days: structuredClone(update.routine.days), weekday: { ...update.routine.days.Mon }, weekend: { ...update.routine.days.Sun } };
  if (update.buildingMode) out.profile.buildingMode = update.buildingMode;
  for (const a of update.answers) {
    const scoped = QUESTIONS[a.q].scope === 'home', key = scoped ? '' : investigationKey;
    if (answerFor(out, a.q, key)?.source === 'you' && answerFor(out, a.q, key).value === a.value) continue; // already recorded: don't duplicate
    out.answers = [...(out.answers || []), { q: a.q, key, value: a.value, at: today, since: '' }];
  }
  const have = new Set((out.notes || []).map((n) => n.text));
  out.notes = [...(out.notes || []), ...(update.notes || []).filter((t) => !have.has(t)).map((text) => ({ text, at: today }))];
  if (update.usualBill) out.profile.usualBill = { ...update.usualBill, source: 'you' };
  if (update.thermostat) out.profile.thermostat = { ...update.thermostat, confirmed: update.thermostat.confirmed || today };
  if (update.projection) {
    const snap = cleanProjections([{ ...update.projection, enteredAt: today, id: undefined }])[0], have = (out.projections || []).some((p) => p.amount === snap.amount && p.periodEnd === snap.periodEnd && p.soFar === snap.soFar);
    if (snap && !have) { const f = forecastBill({ state: out, temps: {}, now: Date.parse(`${today}T12:00:00Z`) }); out.projections = cleanProjections([...(out.projections || []), { ...snap, app: f.available ? { mid: f.mid, low: f.low, high: f.high, method: f.method, through: f.readingsEnd } : null }]); }
  }
  out.appliedUpdates = [...new Set([...(out.appliedUpdates || []), update.id])];
  return migrate(out);
}
/** After saving: does every day read back exactly as intended? */
export function verifyHousehold(saved, update) {
  const bad = C.DOW.filter((d) => JSON.stringify(saved.profile.routine.days[d]) !== JSON.stringify(update.routine.days[d]));
  if (saved.profile.routine.mode !== 'days') bad.push('mode');
  if (update.buildingMode && saved.profile.buildingMode !== update.buildingMode) bad.push('buildingMode');
  if (update.usualBill && (saved.profile.usualBill?.low !== update.usualBill.low || saved.profile.usualBill?.high !== update.usualBill.high)) bad.push('usual bill');
  if ((update.notes || []).some((t) => !(saved.notes || []).some((n) => n.text === t))) bad.push('notes');
  if (update.projection && !(saved.projections || []).some((p) => p.amount === update.projection.amount && p.periodEnd === update.projection.periodEnd && p.soFar === update.projection.soFar)) bad.push('projection');
  if (update.thermostat && JSON.stringify(cleanThermostat(saved.profile.thermostat)) !== JSON.stringify(cleanThermostat({ ...update.thermostat, confirmed: saved.profile.thermostat?.confirmed }))) bad.push('thermostat');
  return { ok: !bad.length, bad };
}

// ================= Household baseline: is current use unusual for THIS household? =================
// Compares the latest two weeks with this household's own history (its usual range of two-week averages, its weather, and the same
// season a year earlier once a year of readings exists). A return to normal after a low stretch is not a problem; a statistically
// detectable change is not the same as an abnormal one. Everything here is computed from readings; nothing is estimated.

const isoGap = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
const isoAdd = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const quant = (sorted, q) => { const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };
const rankIn = (sorted, v) => sorted.filter((x) => x < v).length / sorted.length;
/** Means of every `len`-day window of complete days (windows that straddle a gap in the readings are skipped). */
function rollingMeans(days, len, val = (d) => d.kwh) {
  const out = [];
  for (let i = 0; i + len <= days.length; i++) {
    const w = days.slice(i, i + len);
    if (isoGap(w[0].date, w[len - 1].date) > len + 1) continue;
    out.push({ i, from: w[0].date, to: w[len - 1].date, v: avg(w.map(val)) });
  }
  return out;
}
const BASE_WIN = 14, BASE_MIN_HISTORY = 56;
const BLOCKS = { 'night (0–6)': [0, 6], 'morning (6–12)': [6, 12], 'afternoon (12–17)': [12, 17], 'evening (17–24)': [17, 24] };

/** The latest run (≥ 7 days) where the centered 7-day average stays near the household's 10th percentile and well under its middle: a temporary low stretch. */
function lowStretch(p10, p50, days) {
  const c7 = days.map((_, i) => avg(days.slice(Math.max(0, i - 3), i + 4).map((d) => d.kwh)));
  const thr = p10 * 1.08;
  let best = null, i = 0;
  while (i < days.length) {
    if (c7[i] > thr) { i++; continue; }
    let j = i;
    while (j + 1 < days.length && c7[j + 1] <= thr && isoGap(days[j].date, days[j + 1].date) <= 1) j++;
    const run = days.slice(i, j + 1), m = avg(run.map((d) => d.kwh));
    if (run.length >= 7 && m <= p50 * 0.9) best = { from: run[0].date, to: run[run.length - 1].date, days: run.length, kwh: r1(m) };
    i = j + 1;
  }
  return best;
}

export const BASELINE_STATUS = {
  typical: 'Typical for you', return_to_typical: 'Back to your usual', unusually_high: 'Higher than usual', unusually_low: 'Lower than usual', insufficient: 'Not enough history yet',
};

/**
 * status: typical | return_to_typical | unusually_high | unusually_low | insufficient
 * confidence: high (same season last year, comparable weather) · medium · low (weather not comparable or short history)
 */
export function householdBaseline({ usage, temps = {}, now = Date.now(), win = BASE_WIN }) {
  const days = C.dailyTotals(usage).filter((d) => d.complete).map((d) => ({ date: d.date, kwh: d.kwh, temp: temps[d.date] }));
  const n = days.length;
  const base = { status: 'insufficient', confidence: 'low', n, win, caveats: [], lines: [] };
  if (n < win + BASE_MIN_HISTORY) return { ...base, reason: 'short', headline: 'Not enough history yet to say what’s normal for you.', lines: [`You have ${n} complete day${n === 1 ? '' : 's'}; about ${win + BASE_MIN_HISTORY} (10 weeks) are needed to know your usual range. Changes seen now are early observations, not verdicts.`] };
  const recent = days.slice(-win), hist = days.slice(0, -win);
  if (isoGap(recent[0].date, recent[win - 1].date) > win + 2) return { ...base, reason: 'gaps', headline: 'Recent readings have gaps, so the latest two weeks can’t be compared yet.', lines: ['Import a newer file to fill the gaps.'] };
  const H = rollingMeans(hist, win);
  if (H.length < 20) return { ...base, reason: 'short', headline: 'Not enough history yet to say what’s normal for you.', lines: ['Your earlier readings have too many gaps to show a usual range.'] };
  const sorted = H.map((w) => w.v).sort((a, b) => a - b);
  const p10 = quant(sorted, 0.1), p50 = quant(sorted, 0.5), p90 = quant(sorted, 0.9);
  const medianDay = median(hist.map((d) => d.kwh));
  const R = avg(recent.map((d) => d.kwh)), before = hist.slice(-28), B = avg(before.map((d) => d.kwh));
  const range = { low: r1(p10), mid: r1(p50), high: r1(p90) };
  const stretch = lowStretch(p10, p50, hist);
  const caveats = [];

  // Weather: the earlier days at about the same outdoor temperature (±3°F). A comparison is only fair if enough earlier days are that mild/cold/hot
  // AND they aren't themselves the unusually low stretch.
  const rt = recent.filter((d) => Number.isFinite(d.temp)), ht = hist.filter((d) => Number.isFinite(d.temp));
  let weather = { known: false }, weatherCaveat = null;
  if (rt.length >= 7 && ht.length >= 28) {
    const exp = []; let covered = 0;
    for (const d of rt) { const m = ht.filter((x) => Math.abs(x.temp - d.temp) <= 3); if (m.length >= 3) { covered++; exp.push(avg(m.map((x) => x.kwh))); } }
    // Days at this temperature that come from the low stretch (or the three weeks right after it) can't be a fair baseline.
    const near = (x) => stretch && x.date >= stretch.from && x.date <= isoAdd(stretch.to, 21);
    const matchedDays = new Set(rt.flatMap((d) => ht.filter((x) => Math.abs(x.temp - d.temp) <= 3).map((x) => x.date)));
    const nearShare = matchedDays.size ? ht.filter((x) => matchedDays.has(x.date) && near(x)).length / matchedDays.size : 0;
    const expected = exp.length ? avg(exp) : null, coverage = covered / rt.length, lowBase = expected != null && (expected < p10 || nearShare > 0.5);
    weather = { known: true, recent_temp_f: r1(avg(rt.map((d) => d.temp))), history_temp_f: r1(avg(ht.map((d) => d.temp))), coolest_before_f: r0(Math.min(...ht.map((d) => d.temp))), coverage: r2(coverage),
      expected_kwh: expected != null ? r1(expected) : null, comparable: coverage >= 0.6 && !lowBase, low_base: lowBase };
    weatherCaveat = !weather.comparable ? (lowBase && coverage >= 0.6
      ? `The earlier days this ${weather.recent_temp_f < weather.history_temp_f ? 'cool' : 'warm'} were mostly from your unusually low stretch and the weeks right after it, so they can’t serve as a fair baseline.`
      : `Your earlier days were ${weather.recent_temp_f < weather.history_temp_f ? 'warmer' : 'cooler'} (${fmt(weather.history_temp_f)}°F on average vs ${fmt(weather.recent_temp_f)}°F now), with few at the same temperature, so the weather can’t be matched. A usual range from other seasons is not a weather-adjusted baseline.`) : null;
  } else caveats.push('Outdoor temperatures are missing for part of this period, so the comparison can’t allow for the weather.');

  // Same season last year, once a year of readings exists.
  let seasonal = null;
  if (n >= 330) {
    const a = isoAdd(recent[0].date, -364 - 7), b = isoAdd(recent[win - 1].date, -364 + 7), ly = days.filter((d) => d.date >= a && d.date <= b);
    if (ly.length >= 10) seasonal = { kwh: r1(avg(ly.map((d) => d.kwh))), days: ly.length, pct: r0((R / avg(ly.map((d) => d.kwh)) - 1) * 100) };
  }

  if (!seasonal && weatherCaveat) caveats.push(weatherCaveat);
  let status, confidence = 'medium';
  const above = R > p90 && R >= p50 * 1.15, below = R < p10 && R <= p50 * 0.85;
  if (seasonal) {
    status = seasonal.pct >= 20 ? 'unusually_high' : seasonal.pct <= -20 ? 'unusually_low' : 'typical';
    const lyT = days.filter((d) => d.date >= isoAdd(recent[0].date, -364 - 7) && d.date <= isoAdd(recent[win - 1].date, -364 + 7) && Number.isFinite(d.temp)).map((d) => d.temp);
    const dT = weather.known && lyT.length >= 7 ? Math.abs(weather.recent_temp_f - avg(lyT)) : 0;
    confidence = dT > 8 ? 'medium' : 'high';
    if (dT > 8) caveats.push(`This period was ${fmt(dT)}°F ${weather.recent_temp_f > avg(lyT) ? 'warmer' : 'cooler'} than the same weeks last year, which may account for part of the difference.`);
  } else {
    status = above ? 'unusually_high' : below ? 'unusually_low' : 'typical';
    if (n < 330) caveats.push(`Less than a year of readings (${n} days): no same-season comparison with last year yet.`);
  }
  // A comparison at the same temperature can show the weather explains a high period.
  if (!seasonal && status === 'unusually_high' && weather.comparable && weather.expected_kwh && R <= weather.expected_kwh * 1.15) { status = 'typical'; caveats.push('Days at the same temperature used about as much.'); }
  // Back to normal after a temporary low: the low stretch ended within four weeks before this window and use is now back in range.
  const returned = status === 'typical' && stretch && isoGap(stretch.to, recent[0].date) <= 28 && R >= stretch.kwh * 1.1 && R >= p10;
  if (returned) status = 'return_to_typical';
  if (!seasonal && !weather.comparable) confidence = status === 'unusually_high' || status === 'unusually_low' ? 'low' : 'medium';
  if (!seasonal && n < 120 && confidence === 'high') confidence = 'medium';

  // The same test for each part of the day: a normal total can hide one unusual period.
  const hourly = hourlyByDay(usage, days.map((d) => d.date));
  const windows = [];
  if (hourly.length >= win + BASE_MIN_HISTORY) {
    const hh = hourly.filter((d) => d.date < recent[0].date), rh = hourly.filter((d) => d.date >= recent[0].date);
    for (const [name, [a, b]] of Object.entries(BLOCKS)) {
      const wv = (d) => avg(d.h.slice(a, b)) * 1000, HW = rollingMeans(hh, win, wv).map((w) => w.v).sort((x, y) => x - y);
      if (HW.length < 20 || rh.length < 7) continue;
      const w10 = quant(HW, 0.1), w50 = quant(HW, 0.5), w90 = quant(HW, 0.9), cur = avg(rh.map(wv));
      const flag = cur > w90 && cur >= w50 * 1.15 ? 'high' : cur < w10 && cur <= w50 * 0.85 ? 'low' : null;
      windows.push({ name, recent_w: r0(cur), low_w: r0(w10), usual_w: r0(w50), high_w: r0(w90), rank_pct: r0(rankIn(HW, cur) * 100), flag });
    }
  }

  const rng = `${fmt(range.low, 1)}–${fmt(range.high, 1)}`, span = `${md(recent[0].date)}–${md(recent[win - 1].date)}`;
  const flagged = windows.filter((w) => w.flag === 'high');
  const lines = [`Last ${win} days (${span}): ${fmt(R, 1)} kWh a day. Your usual range for two-week stretches since ${md(days[0].date)}: ${rng} (middle: ${fmt(range.mid, 1)}).`];
  let headline;
  if (status === 'return_to_typical') {
    headline = `Back to your usual level: ${fmt(R, 1)} kWh a day, after an unusually low stretch.`;
    lines.push(`The low stretch (${md(stretch.from)}–${md(stretch.to)}) averaged ${fmt(stretch.kwh, 1)} kWh a day — your lowest since ${md(days[0].date)}. Measured against it, today’s use looks like a ${fmt((R / stretch.kwh - 1) * 100)}% rise; measured against your full history, it is a return to normal, not a new problem.`);
  } else if (status === 'typical') {
    headline = `Typical for you: ${fmt(R, 1)} kWh a day, inside your usual range.`;
    if (Math.abs(R - B) >= 0.1 * B) lines.push(`The 4 weeks before averaged ${fmt(B, 1)} — ordinary swings between stretches.`);
  } else if (status === 'unusually_high') {
    headline = seasonal ? `Higher than usual: ${fmt(R, 1)} kWh a day, ${seasonal.pct}% above the same time last year.` : `Higher than anything in your history: ${fmt(R, 1)} kWh a day (usual ${rng}).`;
  } else {
    headline = seasonal ? `Lower than usual: ${fmt(R, 1)} kWh a day, ${Math.abs(seasonal.pct)}% below the same time last year.` : `Lower than usual: ${fmt(R, 1)} kWh a day (usual ${rng}). Mild weather or time away often explains it; it isn’t a problem.`;
  }
  if (seasonal) lines.push(`Same time last year (${seasonal.days} days): ${fmt(seasonal.kwh, 1)} kWh a day.`);
  if (weather.known && weather.comparable && weather.expected_kwh) lines.push(`Earlier days at about the same temperature (${fmt(weather.recent_temp_f)}°F): ${fmt(weather.expected_kwh, 1)} kWh a day.`);
  for (const w of flagged) lines.push(`${cap(w.name.replace(/ \(.*/, ''))}s are the highest in your history: ${fmt(w.recent_w)} W on average, vs a usual ${fmt(w.low_w)}–${fmt(w.high_w)} W. Your total is ${status === 'unusually_high' ? 'high' : 'normal'}; this one period stands out.`);
  return { status, label: BASELINE_STATUS[status], confidence, headline, lines, caveats, n, win, recent: { from: recent[0].date, to: recent[win - 1].date, kwh: r1(R) }, before_kwh: r1(B), range, low_stretch: stretch, weather, seasonal, windows, p: { p10: r1(p10), p50: r1(p50), p90: r1(p90) } };
}

// ---------- usage while the apartment is normally empty ----------

QUESTIONS.away_home = {
  kinds: ['away'], scope: 'key',
  text: (v) => `Was anyone home, or was something running on a timer, on ${v.dates || 'those afternoons'}?`,
  why: 'Whole-home readings can show that something used power while the apartment was supposed to be empty, but not what it was. Your answer tells us whether it was a change of plans.',
  options: [['home', 'Someone was home'], ['timer', 'Something runs on a timer or schedule then'], ['no', 'No — nobody was home and I know of nothing'], ['unknown', 'I’m not sure']],
  effect: {},
};

/**
 * Hours the routine says nobody is home vs. what the meter shows. Compares the latest occurrences with this household's own earlier ones
 * and with a quiet night. It never says what ran: cooling, a timer, laundry or a visitor would all look alike in hourly readings.
 */
export function unoccupiedUse({ state, now = Date.now(), temps = {} }) {
  const p = state.profile, out = [];
  const hourly = hourlyByDay(state.usage, C.dailyTotals(state.usage).map((d) => d.date));
  if (hourly.length < 28) return out;
  const byDate = new Map(hourly.map((d) => [d.date, d]));
  const dow = (iso) => C.DOW[new Date(`${iso}T12:00:00Z`).getUTCDay()];
  const nightW = median(hourly.map((d) => avg(d.h.slice(1, 5)) * 1000));
  for (const day of C.DOW) {
    const r = C.routineFor(p.routine, day);
    if (!r.leave || !r.back) continue;
    const h0 = Math.ceil(C.toMin(r.leave) / 60), h1 = Math.floor(C.toMin(r.back) / 60);
    if (h1 - h0 < 1) continue;
    const occ = hourly.filter((d) => dow(d.date) === day).map((d) => ({ date: d.date, w: avg(d.h.slice(h0, h1)) * 1000 }));
    if (occ.length < 6) continue;
    const recent = occ.slice(-4), earlier = occ.slice(0, -4);
    if (earlier.length < 4) continue;
    const typical = median(earlier.map((o) => o.w)), cut = Math.max(typical * 1.5, typical + 800);
    const hi = recent.filter((o) => o.w > cut);
    const otherDays = hourly.filter((d) => dow(d.date) !== day && d.date >= recent[0].date).map((d) => avg(d.h.slice(h0, h1)) * 1000);
    // The same hours on other (occupied) days with about the same outdoor temperature as each of the latest occurrences.
    const wm = recent.flatMap((o) => { const t = temps[o.date]; return Number.isFinite(t) ? hourly.filter((d) => dow(d.date) !== day && Number.isFinite(temps[d.date]) && Math.abs(temps[d.date] - t) <= 3).map((d) => avg(d.h.slice(h0, h1)) * 1000) : []; });
    const weatherMatched = wm.length >= 6 ? avg(wm) : null;
    const key = `away:${day}:${recent[recent.length - 1].date}`;
    const answer = answerFor(state, 'away_home', key);
    const flagged = hi.length >= 2;
    out.push({
      id: `away-${day}`, day, key, window: `${C.fmtMin(h0 * 60)}–${C.fmtMin(h1 * 60)}`, flagged, explained: !!(answer && ['home', 'timer'].includes(answer.value)), answer: answer?.value || null,
      recent: recent.map((o) => ({ date: o.date, w: r0(o.w) })), earlier_typical_w: r0(typical), quiet_night_w: r0(nightW), other_days_same_hours_w: otherDays.length ? r0(avg(otherDays)) : null,
      weather_matched_w: weatherMatched != null ? r0(weatherMatched) : null, weather_matched_n: wm.length,
      timing: `Readings are hourly totals — the average power over each hour, not momentary peaks — starting on the hour in local time. ${C.fmtMin(h0 * 60)}–${C.fmtMin(h1 * 60)} lies entirely inside your away time (${C.fmtMin(C.toMin(r.leave))}–${C.fmtMin(C.toMin(r.back))}).`,
      occupied_like: otherDays.length && hi.length ? Math.abs(avg(hi.map((o) => o.w)) / avg(otherDays) - 1) <= 0.35 : null,
      headline: flagged ? `${C.DAY_NAME[day]} ${C.fmtMin(h0 * 60)}–${C.fmtMin(h1 * 60)}, when nobody’s home, used ${fmt(Math.min(...hi.map((o) => o.w)) / 1000, 1)}–${fmt(Math.max(...hi.map((o) => o.w)) / 1000, 1)} kW on ${hi.length} of the last ${recent.length} ${C.DAY_NAME[day]}s.`
        : `${C.DAY_NAME[day]} ${C.fmtMin(h0 * 60)}–${C.fmtMin(h1 * 60)} (nobody home) looks consistent with earlier weeks.`,
      detail: `Earlier ${C.DAY_NAME[day]}s averaged about ${fmt(typical)} W in these hours; the latest ${recent.length}: ${recent.map((o) => `${md(o.date)} ${fmt(o.w)} W`).join(', ')}. A quiet night draws about ${fmt(nightW)} W${otherDays.length ? `, and the same hours on other days (when people are home) average ${fmt(avg(otherDays))} W` : ''}.`,
      comparison: otherDays.length ? `The same hours on other days, when people are home, average ${fmt(avg(otherDays))} W${weatherMatched != null ? `; on other days with about the same outdoor temperature, ${fmt(weatherMatched)} W` : ''}. ${hi.length && Math.abs(avg(hi.map((o) => o.w)) / avg(otherDays) - 1) <= 0.35 ? 'So the empty-apartment hours use about as much as occupied ones — that points to something that runs on its own (cooling cycling, a fridge, a timer) rather than something a person switches on. The readings can’t say which.' : ''}` : '',
      uncertainty: 'Hourly whole-home readings can’t say what ran. Cooling, a timer, laundry, a dehumidifier or someone being home would look the same, and the app doesn’t assume it is the air conditioning.',
      check: `Next ${C.DAY_NAME[day]}, look at what is running at ${C.fmtMin(h0 * 60)}: thermostat (HOLD or schedule), anything on a timer, and whether the building’s cooling is active. Then import the new readings and see whether it repeats.`,
      question: flagged && !answer ? { id: 'away_home', key, text: QUESTIONS.away_home.text({ dates: hi.map((o) => md(o.date)).join(', ').replace(/, ([^,]*)$/, ' and $1') }), why: QUESTIONS.away_home.why, options: QUESTIONS.away_home.options } : null,
    });
  }
  return out.filter((o) => o.flagged);
}

// ================= Setup: what the app already knows =================

/**
 * Setup is complete when the two things the schedule needs are known: the building's season and a routine the household confirmed
 * (finished setup, a per-day routine, or an applied household update). Comfort temperatures and the meter question are optional.
 * Nothing here is written back: an unknown stays unknown.
 */
/**
 * What the household confirmed on the physical thermostat — kept apart from the app's proposed schedule and from "programmed".
 * { mode, setpoint (°F), hold, programming: 'on'|'off', recovery: 'on'|'off'|null, coolingPrice: string|null, confirmed (date), source: 'you' }
 */
export function cleanThermostat(t) {
  if (!t || typeof t !== 'object' || !Number.isFinite(+t.setpoint) || +t.setpoint < 50 || +t.setpoint > 90 || !['cool', 'heat'].includes(t.mode)) return null;
  const onOff = (v) => (['on', 'off'].includes(v) ? v : null);
  return { mode: t.mode, setpoint: +t.setpoint, hold: t.hold === true, programming: onOff(t.programming), recovery: onOff(t.recovery),
    coolingPrice: typeof t.coolingPrice === 'string' && t.coolingPrice ? t.coolingPrice.slice(0, 20) : null, confirmed: isIso(t.confirmed) ? t.confirmed : '', source: 'you' };
}
/** Held at one temperature with programming off: the schedule in the app is only a proposal. */
export const holdsSteady = (state) => { const t = state.profile.thermostat; return !!(t && t.hold && t.programming === 'off'); };
export function setupInfo(state) {
  const p = state.profile, missing = [];
  const routineKnown = !!(p.setupDone || p.routine?.mode === 'days' || (state.appliedUpdates || []).length);
  if (p.buildingMode === 'unknown' || !p.buildingMode) missing.push({ field: 'buildingMode', label: 'Whether your building is heating or cooling now', why: 'The schedule needs to know which system is running.' });
  if (!routineKnown) missing.push({ field: 'routine', label: 'Your daily routine', why: 'Wake, away and sleep times decide when the schedule changes.' });
  const optional = [];
  if (p.hvacMetered === 'unknown') optional.push({ field: 'hvacMetered', label: 'Whether heating and cooling are on your meter', why: 'Only matters for how much thermostat changes can lower your bill.' });
  return { complete: !!p.setupDone || missing.length === 0, missing, optional };
}

// ================= Bills: statements, reconciliation, drivers, estimates =================

const isMoney = (x) => Number.isFinite(x) && Math.abs(x) < 100000;
const optNum = (v) => (v === '' || v == null || !Number.isFinite(+v) ? null : +v);
const BILL_PARTS = ['supply', 'delivery', 'fixed', 'taxes', 'credits', 'adjustments', 'priorBalance', 'payments', 'totalDue'];
/**
 * Statements the household entered (by hand or from a PDF they reviewed). Only `end` and `amount` (current-period charges) are required;
 * every other field stays null when unknown. credits are positive numbers that reduce the bill; adjustments are signed.
 */
export function cleanBills(list) {
  return (Array.isArray(list) ? list : []).filter((b) => b && isIso(b.end) && isMoney(+b.amount) && +b.amount >= 0).slice(-60).map((b) => {
    const out = { id: String(b.id || `${b.end}|${b.amount}`).slice(0, 60), start: isIso(b.start) && b.start < b.end ? b.start : '', end: b.end, kwh: optNum(b.kwh) > 0 ? +b.kwh : null, amount: +b.amount,
      days: Number.isInteger(+b.days) && +b.days > 0 && +b.days < 100 ? +b.days : null, estimatedRead: b.estimatedRead === true, source: ['pdf', 'greenbutton'].includes(b.source) ? b.source : 'manual', at: isIso(b.at) ? b.at : '', statementDate: isIso(b.statementDate) ? b.statementDate : '' };
    for (const k of BILL_PARTS) out[k] = isMoney(optNum(b[k])) ? optNum(b[k]) : null;
    return out;
  }).sort((a, b) => (a.end < b.end ? -1 : 1));
}
/**
 * How a new or corrected statement relates to the saved ones: an exact duplicate, a revision of the same service period (different figures —
 * replace only if the household confirms), or an overlap with a different period (both kept, flagged). Never resolved silently.
 */
export function statementConflicts(saved, rec, { editingId = null } = {}) {
  const list = cleanBills(saved).filter((b) => b.id !== editingId), r = cleanBills([rec])[0];
  if (!r) return { invalid: true, duplicate: null, revision: null, overlaps: [] };
  const same = (b) => b.end === r.end && (b.start || '') === (r.start || '');
  const duplicate = list.find((b) => same(b) && b.amount === r.amount && (b.kwh ?? null) === (r.kwh ?? null)) || null;
  const revision = duplicate ? null : list.find((b) => b.end === r.end || (r.start && b.start === r.start)) || null;
  const overlaps = list.filter((b) => b !== duplicate && b !== revision && b.start && r.start && b.start < r.end && r.start < b.end);
  return { duplicate, revision, overlaps };
}
/**
 * Plan for adding billing periods from a Delmarva billing-data export. Identical periods are skipped; a period whose figures differ from a saved
 * one (a corrected bill) or that overlaps different dates is held for review. Nothing saved is changed by this function.
 */
export function planBillingImport(saved, periods, { today = '' } = {}) {
  const have = cleanBills(saved), plan = { add: [], same: 0, review: [] };
  for (const p of periods) {
    const rec = cleanBills([{ id: `gb|${p.start}|${p.end}`, ...p, source: 'greenbutton', at: today }])[0];
    if (!rec) continue;
    const sameDates = have.filter((b) => b.start === rec.start && b.end === rec.end);
    if (sameDates.some((b) => b.amount === rec.amount && b.kwh === rec.kwh)) { plan.same++; continue; }
    if (sameDates.length) { plan.review.push({ kind: 'changed', incoming: rec, existing: sameDates[0] }); continue; }
    const ov = have.filter((b) => b.start && b.start <= rec.end && rec.start <= b.end);
    if (ov.length) { plan.review.push({ kind: 'overlap', incoming: rec, existing: ov[0] }); continue; }
    plan.add.push(rec);
  }
  return plan;
}
export function cleanProjection(p) {
  if (!p || !isMoney(+p.amount) || +p.amount < 0) return null;
  return { amount: +p.amount, asOf: isIso(p.asOf) ? p.asOf : '', periodEnd: isIso(p.periodEnd) ? p.periodEnd : '', source: 'manual' };
}

/** Billed days: the statement's own count when entered, else end − start (meter read to meter read). */
const billedDays = (b) => b.days || (b.start ? isoGap(b.start, b.end) : null);
/** Energy price per kWh without fixed charges, credits and adjustments — only from parts the statement actually shows. */
function variablePrice(b) {
  if (!b.kwh) return null;
  if (b.supply != null && b.delivery != null) return (b.supply + b.delivery) / b.kwh;
  if (b.fixed != null) return (b.amount - b.fixed - (b.taxes ?? 0) + (b.credits ?? 0) - (b.adjustments ?? 0)) / b.kwh;
  return null;
}

/** Why one statement differs from another, split into parts that are each computed from entered figures; anything else is "other / unexplained". */
export function billDrivers(prev, cur, { tempPrev = null, tempCur = null } = {}) {
  const out = [], dP = billedDays(prev), dC = billedDays(cur), total = cur.amount - prev.amount;
  const known = [];
  if (prev.kwh && cur.kwh && dP && dC) {
    const p0 = (prev.amount - (prev.credits ? -prev.credits : 0) - (prev.adjustments ?? 0) - (prev.fixed ?? 0)) / prev.kwh; // earlier price per kWh incl. taxes, before credits/adjustments
    const kd0 = prev.kwh / dP, kd1 = cur.kwh / dC;
    const days = (dC - dP) * kd0 * p0, use = dC * (kd1 - kd0) * p0;
    out.push({ id: 'days', label: `${dC} billed days vs ${dP}`, amount: r2(days), status: 'confirmed' });
    out.push({ id: 'usage', label: `${fmt(kd1, 1)} kWh a day vs ${fmt(kd0, 1)}`, amount: r2(use), status: 'confirmed' });
    known.push(days, use);
    const vp = variablePrice(prev), vc = variablePrice(cur);
    if (vp != null && vc != null) { const pr = cur.kwh * (vc - vp); out.push({ id: 'price', label: `energy price ${fmt(vc * 100, 2)}¢ vs ${fmt(vp * 100, 2)}¢ per kWh`, amount: r2(pr), status: 'confirmed' }); known.push(pr); }
    else if (prev.fixed == null && cur.fixed == null && !prev.credits && !cur.credits && !prev.adjustments && !cur.adjustments) {
      const p1 = cur.amount / cur.kwh, pr = cur.kwh * (p1 - p0);
      out.push({ id: 'avgprice', label: `average price ${fmt(p1 * 100, 2)}¢ vs ${fmt(p0 * 100, 2)}¢ per kWh (includes any fixed charges and taxes, which aren’t itemised)`, amount: r2(pr), status: 'confirmed' }); known.push(pr);
    }
  }
  for (const [k, label, sign] of [['fixed', 'fixed charges', 1], ['credits', 'credits', -1], ['adjustments', 'adjustments', 1]]) {
    if (prev[k] != null && cur[k] != null && Math.abs(cur[k] - prev[k]) >= 0.005) { const v = sign * (cur[k] - prev[k]); out.push({ id: k, label: `${label} ${money(cur[k])} vs ${money(prev[k])}`, amount: r2(v), status: 'confirmed' }); known.push(v); }
    else if ((prev[k] == null) !== (cur[k] == null) && (prev[k] || cur[k])) out.push({ id: k, label: `${label} shown on only one statement`, amount: null, status: 'unknown' });
  }
  const rest = total - known.reduce((a, x) => a + x, 0);
  if (out.length && Math.abs(rest) >= 0.5) out.push({ id: 'other', label: 'everything else (taxes, rounding, prices or charges not entered)', amount: r2(rest), status: 'unexplained' });
  if (tempPrev != null && tempCur != null && Math.abs(tempCur - tempPrev) >= 3) out.push({ id: 'weather', label: `outdoor average ${fmt(tempCur)}°F vs ${fmt(tempPrev)}°F`, amount: null, status: 'possible' });
  return { total: r2(total), drivers: out };
}

/**
 * The bill picture, keeping sources apart:
 *  measured (readings) · estimate (the file’s per-hour costs, or the app’s projection from your last statement) · statement (entered) · projection (Delmarva’s, entered by you).
 * Billing dates are never guessed; without statements the app uses calendar months and rolling 30-day stretches and says so.
 */
export function billView({ state, temps = {}, now = Date.now() }) {
  const days = C.dailyTotals(state.usage).filter((d) => d.complete);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const missing = [], lines = [];
  const costOf = (ds) => (ds.length && ds.every((d) => d.cost != null) ? sum(ds.map((d) => d.cost)) : null);
  const tempOf = (a, b) => { const t = Object.entries(temps).filter(([d, v]) => d >= a && d <= b && Number.isFinite(v)).map(([, v]) => v); return t.length >= 5 ? r1(avg(t)) : null; };
  const months = {};
  for (const d of days) (months[d.date.slice(0, 7)] ||= []).push(d);
  const monthRows = Object.entries(months).map(([m, ds]) => {
    const [y, mo] = m.split('-').map(Number), dim = new Date(Date.UTC(y, mo, 0)).getUTCDate(), kwh = sum(ds.map((d) => d.kwh)), cost = costOf(ds);
    return { month: m, days: ds.length, daysInMonth: dim, partial: ds.length < dim, kwh: r1(kwh), kwh_per_day: r1(kwh / ds.length), interval_cost: cost != null ? r2(cost) : null, cents_per_kwh: cost != null && kwh ? r2((cost / kwh) * 100) : null };
  });
  const stretches = [];
  if (days.length >= 30) {
    const last = days[days.length - 1].date;
    for (let k = 0; k < 3; k++) {
      const to = isoAdd(last, -30 * k), from = isoAdd(to, -29), ds = days.filter((d) => d.date >= from && d.date <= to);
      if (ds.length >= 28) stretches.push({ from, to, days: ds.length, kwh: r1(sum(ds.map((d) => d.kwh))), interval_cost: costOf(ds) != null ? r2(costOf(ds)) : null });
    }
  }
  let thirty = null;
  if (days.length >= 60) {
    const W30 = [];
    for (let i = 0; i + 30 <= days.length; i++) { const w = days.slice(i, i + 30); if (isoGap(w[0].date, w[29].date) === 29) W30.push({ from: w[0].date, to: w[29].date, kwh: sum(w.map((d) => d.kwh)), cost: costOf(w) }); }
    if (W30.length >= 10) {
      const k = W30.map((w) => w.kwh).sort((a, b) => a - b), latest = W30[W30.length - 1], lowest = W30.reduce((m, w) => (w.kwh < m.kwh ? w : m));
      thirty = { typical_kwh: r0(quant(k, 0.5)), low_kwh: r0(k[0]), high_kwh: r0(k[k.length - 1]), latest: { ...latest, kwh: r0(latest.kwh), cost: latest.cost != null ? r2(latest.cost) : null }, lowest: { ...lowest, kwh: r0(lowest.kwh), cost: lowest.cost != null ? r2(lowest.cost) : null }, n: W30.length,
        latest_vs_typical_pct: r0((latest.kwh / quant(k, 0.5) - 1) * 100) };
    }
  }

  // Statements, reconciled with readings for exactly the same days.
  const bills = cleanBills(state.bills);
  const statements = bills.map((b) => {
    const bd = billedDays(b);
    const win = (a, z) => { const ds = []; for (let d = a; d <= z; d = isoAdd(d, 1)) if (byDate.has(d)) ds.push(byDate.get(d)); return ds; };
    // Meter reads are taken on the start and end dates; the energy in between is either [start, end) or (start, end]. Both are shown.
    const inclusive = b.start && b.days && b.days === isoGap(b.start, b.end) + 1; // Delmarva's billing export lists first and last service day
    const A1 = b.start ? (inclusive ? win(b.start, b.end) : win(b.start, isoAdd(b.end, -1))) : [], A2 = b.start ? (inclusive ? A1 : win(isoAdd(b.start, 1), b.end)) : [];
    const covered = !!b.start && bd != null && A1.length === bd && A2.length === bd;
    const k1 = covered ? sum(A1.map((d) => d.kwh)) : null, k2 = covered ? sum(A2.map((d) => d.kwh)) : null;
    const kwhGap = covered && b.kwh ? Math.min(Math.abs(b.kwh - k1), Math.abs(b.kwh - k2)) / b.kwh : null;
    const kwhWithinRounding = covered && b.kwh != null && Number.isInteger(b.kwh) && Math.min(Math.abs(b.kwh - k1), Math.abs(b.kwh - k2)) < 1; // billed kWh are whole numbers
    const intervalCost = covered ? (costOf(A1) + costOf(A2)) / 2 : null;
    const notes = [];
    if (!b.start) notes.push('No start date entered, so it can’t be matched to readings.');
    else if (!covered) notes.push(`Your readings cover ${Math.min(A1.length, A2.length)} of its ${bd} days.`);
    if (b.estimatedRead) notes.push('Delmarva estimated the meter reading for this bill; a later bill corrects it, so its kWh may not match your readings.');
    if (kwhGap != null && kwhGap > 0.03) notes.push(`Billed kWh differs from your readings by ${fmt(kwhGap * 100, 1)}% — more than rounding.`);
    if (b.source === 'greenbutton' && b === bills[0] && b.days && b.days < 28 && days.length && b.start <= days[0].date) notes.push('Shorter than a usual billing period and it starts on the first day of the export — it may be cut off at the start.');
    if (b.adjustments) notes.push('Includes an adjustment, which is left out of usage comparisons.');
    const ov = bills.filter((o) => o !== b && o.start && b.start && o.start < b.end && b.start < o.end);
    if (ov.length) notes.push(`Overlaps the statement ending ${md(ov[0].end)} — one of them may be a corrected bill; comparisons treat them separately.`);
    return { ...b, billed_days: bd, covered, readings_kwh: k1 != null ? r1((k1 + k2) / 2) : null, readings_kwh_range: k1 != null ? [r1(Math.min(k1, k2)), r1(Math.max(k1, k2))] : null,
      kwh_matches: kwhGap != null ? kwhGap <= 0.03 : null, kwh_within_rounding: kwhWithinRounding, interval_cost: intervalCost != null ? r2(intervalCost) : null, beyond_readings: intervalCost != null ? r2(b.amount - intervalCost) : null,
      cost_per_day: bd ? r2(b.amount / bd) : null, kwh_per_day: bd && b.kwh ? r1(b.kwh / bd) : null, cents_per_kwh: b.kwh ? r2((b.amount / b.kwh) * 100) : null, variable_cents: variablePrice(b) != null ? r2(variablePrice(b) * 100) : null,
      temp_f: b.start ? tempOf(b.start, b.end) : null, notes };
  });
  if (!bills.length) missing.push('Your Delmarva statements: service dates, billed days, kWh, current charges, and if shown supply, delivery, fixed charges, taxes and credits. Without them the app can’t say which dates a bill covers or what is fixed vs. usage-driven.');
  else if (statements.some((s) => !s.covered)) missing.push('Start dates (or readings for every day) for some statements, so they can’t be reconciled.');
  const proj = currentProjection(state), projections = cleanProjections(state.projections);
  if (!proj) missing.push('Delmarva’s current projection, if you want it shown next to the measured numbers. The app never presents its own estimate as Delmarva’s.');

  // Why the latest statement differs from the one before (only from entered figures).
  let compare = null;
  if (statements.length >= 2) {
    const a = statements[statements.length - 2], b = statements[statements.length - 1];
    compare = { prev: a, cur: b, ...billDrivers(a, b, { tempPrev: a.temp_f, tempCur: b.temp_f }) };
    const others = statements.slice(0, -1).filter((s) => s.cost_per_day != null);
    compare.typical_cost_per_day = others.length >= 2 ? r2(median(others.map((s) => s.cost_per_day))) : null;
  }

  // The independent forecast for the current period, from actual service dates and the readings the app has.
  const fcst = forecastBill({ state, temps, now });
  const estimate = fcst.available ? { low: fcst.low, high: fcst.high, mid: fcst.mid, rough: false, pointOk: fcst.pointOk, method: fcst.method_text, uncertainty: fcst.uncertainty } : null;
  if (!fcst.available && days.length && bills.length) missing.push(`No independent forecast yet: ${fcst.reason}`);
  if (fcst.available && statements.length && !statements.some((x) => x.supply != null || x.fixed != null)) missing.push('An itemised statement (supply, delivery, customer charge, taxes) would separate price from usage; the billing export only gives totals.');
  const gap = fcst.available && proj ? explainForecastGap(fcst, proj) : null;
  const accuracy = forecastAccuracy(state), normal = proj ? billNormal(statements, proj.amount, state.profile.usualBill || null) : null;
  const last = statements[statements.length - 1];

  // Lines, source by source.
  if (compare) {
    const { prev: a, cur: b } = compare;
    const srcName = (x) => (x.source === 'greenbutton' ? 'Delmarva’s billing data' : x.source === 'pdf' ? 'your statement PDFs' : 'the statements you entered');
    lines.push({ kind: 'statement', text: `Last two bills (${a.source === b.source ? srcName(b) : `${srcName(a)} and ${srcName(b)}`}): ${money(a.amount)} (${a.billed_days ?? '?'} days to ${md(a.end)}) then ${money(b.amount)} (${b.billed_days ?? '?'} days to ${md(b.end)}) — ${compare.total >= 0 ? 'up' : 'down'} ${money(Math.abs(compare.total))}.` });
    if (compare.drivers.length) lines.push({ kind: 'statement', text: `Why: ${compare.drivers.filter((x) => x.amount != null).map((x) => `${x.label}: ${x.amount >= 0 ? '+' : '−'}${money(Math.abs(x.amount))}${x.status === 'unexplained' ? ' (not explained by entered figures)' : ''}`).join('; ')}.${compare.drivers.some((x) => x.status === 'possible') ? ` Possible, not measured: ${compare.drivers.filter((x) => x.status === 'possible').map((x) => x.label).join('; ')}.` : ''}` });
  }
  const covered = statements.filter((s) => s.covered);
  if (covered.length) {
    lines.push({ kind: 'reconciled', text: `Matched to your readings for the same days: ${covered.map((s) => `to ${md(s.end)}: billed ${s.kwh ? fmt(s.kwh) : '?'} kWh vs measured ${fmt(s.readings_kwh, 2)} kWh${s.kwh_within_rounding ? ' (same, within whole-kWh rounding)' : s.kwh_matches === false ? ' (more than rounding apart)' : ''}; billed amount minus the file’s hourly costs ${money(s.beyond_readings)}`).join(' · ')}.` });
    const gaps = covered.map((s) => s.beyond_readings).filter((x) => x != null);
    lines.push({ kind: 'reconciled', text: gaps.length >= 2 && Math.max(...gaps) - Math.min(...gaps) >= 3 ? `That gap varied from ${money(Math.min(...gaps))} to ${money(Math.max(...gaps))} between bills, so it isn’t one fixed monthly fee. It may be taxes, fees, charges priced differently from the hourly costs, or credits — the export doesn’t itemise it, so the app doesn’t assume which.` : 'That gap may be fixed charges, taxes, fees, a different price or credits — the export doesn’t itemise it, so the app doesn’t assume which.' });
  }
  const story = billingStory(statements, days);
  if (story) lines.unshift(...story.map((text) => ({ kind: 'statement', text })));
  if (proj) lines.push({ kind: 'projection', text: `Delmarva’s projection, entered by you${proj.shownOn ? ` (seen ${md(proj.shownOn)})` : ''}: ${money(proj.amount)} for ${proj.periodStart ? `${md(proj.periodStart)}–` : 'the period ending '}${md(proj.periodEnd)}. It is Delmarva’s number — a projection, not a bill, and the utility’s own update time isn’t known.` });
  if (thirty) {
    const t = thirty, near = Math.abs(t.latest_vs_typical_pct) < 8;
    lines.push({ kind: 'measured', text: `Measured: any 30 days in your readings used ${fmt(t.low_kwh)}–${fmt(t.high_kwh)} kWh (typical ${fmt(t.typical_kwh)}). The latest 30 days (${md(t.latest.from)}–${md(t.latest.to)}): ${fmt(t.latest.kwh)} kWh — ${near ? 'about typical' : `${fmt(Math.abs(t.latest_vs_typical_pct))}% ${t.latest_vs_typical_pct > 0 ? 'above' : 'below'} typical`}.` });
    const hit = statements.filter((x) => x.start).map((x) => ({ x, n: Math.max(0, isoGap(x.start > t.lowest.from ? x.start : t.lowest.from, x.end < t.lowest.to ? x.end : t.lowest.to) + 1) })).sort((a, b) => b.n - a.n)[0];
    lines.push({ kind: 'measured', text: `Your lightest 30 days were ${md(t.lowest.from)}–${md(t.lowest.to)}: ${fmt(t.lowest.kwh)} kWh${t.lowest.cost != null ? ` (about ${money(t.lowest.cost)} by the file’s per-hour costs)` : ''}. ${hit && hit.n >= 15 ? `${hit.n} of those days fall in the ${md(hit.x.start)}–${md(hit.x.end)} billing period.` : `A bill whose dates fall mostly in a stretch like that would come in lower than usual; which bill that is depends on your billing dates${bills.length ? '' : ', which the file doesn’t contain'}.`}` });
  }
  if (stretches.length >= 2) {
    const [c, p] = stretches, dk = c.kwh - p.kwh;
    lines.push({ kind: 'measured', text: `Measured: the latest 30 days (${md(c.from)}–${md(c.to)}) used ${fmt(c.kwh)} kWh vs ${fmt(p.kwh)} in the 30 before — ${dk >= 0 ? 'more' : 'less'} by ${fmt(Math.abs(dk))} kWh (${fmt(Math.abs(dk / p.kwh) * 100)}%). These are rolling stretches, not billing periods.` });
    if (c.interval_cost != null && p.interval_cost != null) lines.push({ kind: 'estimate', text: `Estimate from the file’s per-hour costs: ${money(c.interval_cost)} vs ${money(p.interval_cost)}. This is not a bill: it leaves out fixed charges, taxes and credits, and the file’s own totals aren’t verified against a statement.` });
  }
  const usual = state.profile.usualBill && Number.isFinite(state.profile.usualBill.low) ? state.profile.usualBill : null;
  return { months: monthRows, stretches, thirty, statements, projection: proj, estimate, forecast: fcst, gap, accuracy, normal, projections, compare, lines, missing, hasStatements: bills.length > 0, usual, price: priceStructure(state) };
}
const money = (x) => `$${fmt(x, 2)}`;

// ================= Savings: what is worth changing =================

const SAVE_KIND = { measured: 'Measured', engineering: 'Engineering estimate', modelled: 'Modelled from your readings', illustrative: 'General rule of thumb', unknown: 'Can’t be estimated yet' };
export const SAVINGS_KIND = SAVE_KIND;
const EFFORT_W = { none: 1, low: 1, medium: 1.6, high: 3 }, CONF_W = { high: 1, medium: 0.6, low: 0.3 };

/** Daily kWh against cooling degree days (base 65°F): slope, its standard error, and the days used. Simple least squares; nothing else is assumed. */
function coolingSlope(days, temps) {
  const pts = days.filter((d) => Number.isFinite(temps[d.date])).map((d) => [Math.max(0, temps[d.date] - 65), d.kwh]);
  const n = pts.length, warm = pts.filter(([x]) => x > 0).length;
  if (n < 30 || warm < 20) return null;
  const mx = avg(pts.map((p) => p[0])), my = avg(pts.map((p) => p[1]));
  const sxx = sum(pts.map(([x]) => (x - mx) ** 2)), sxy = sum(pts.map(([x, y]) => (x - mx) * (y - my)));
  if (sxx <= 0) return null;
  const b = sxy / sxx, a = my - b * mx, res = pts.map(([x, y]) => y - a - b * x), se = Math.sqrt(sum(res.map((r) => r * r)) / (n - 2) / sxx);
  const r2v = 1 - sum(res.map((r) => r * r)) / sum(pts.map(([, y]) => (y - my) ** 2));
  return { per_cdd: b, se, r2: r2v, n, warm };
}

/**
 * Ranked opportunities from this household's readings. Each says: the evidence (measured), whether the use is controllable, the expected
 * impact only when it can be estimated (and how), confidence in the evidence, cost and effort, comfort, and how to verify — usually by
 * running a savings experiment. Options the evidence says aren't worth it are listed with the reason, so they aren't raised again.
 * Speculative dollar amounts never rank above evidence: unknown savings are scored on evidence and effort alone.
 */
export function savingsPlan({ state, temps = {}, now = Date.now() }) {
  const r = usageReport({ state, temps, now });
  const days = C.dailyTotals(state.usage).filter((d) => d.complete);
  if (days.length < 14) return { items: [], considered: [], note: 'Needs about two weeks of readings to look for savings.', rate: rateFor(state) };
  const rf = rateFor(state), rate = rf.rate, p = state.profile, metered = p.hvacMetered;
  const $ = (k) => (rate != null ? r2(k * rate) : null);
  const items = [], considered = [];
  const add = (o) => {
    const est = o.savings.dollars ? (o.savings.dollars[0] + o.savings.dollars[1]) / 2 : 0;
    const evidence = { high: 3, medium: 2, low: 1 }[o.confidence];
    // Measured or engineering estimates may add their value; hypothetical amounts add nothing to the rank.
    const score = evidence * 2 + (['measured', 'engineering'].includes(o.savings.kind) ? Math.min(est, 20) / 2 : 0) - (EFFORT_W[o.effort] - 1) * 2 - (o.comfort === 'noticeable' ? 2 : o.comfort === 'slight' ? 0.5 : 0);
    items.push({ cost: 'Free', control: 'unknown', ...o, savings: { ...o.savings, label: SAVE_KIND[o.savings.kind] }, score: r2(score) });
  };
  const bl = r.baseline, part = (w) => w.name.replace(/ \(.*/, '');

  // 1. A part of the day that is higher than this household's own history (measured).
  const hiWin = (bl?.windows || []).filter((w) => w.flag === 'high').sort((a, b) => b.recent_w - b.usual_w - (a.recent_w - a.usual_w))[0];
  if (hiWin) {
    const [h0, h1] = BLOCKS[hiWin.name], extra = ((hiWin.recent_w - hiWin.usual_w) * (h1 - h0) * 30) / 1000;
    add({ id: 'window', short: 'Find what runs in the afternoon', thermostat: false, control: 'unknown', action: `Find out what runs for hours in the ${part(hiWin)} (walk through once and note what’s on).`,
      why: `${cap(part(hiWin))}s lately average ${fmt(hiWin.recent_w)} W — above every earlier two weeks (usual ${fmt(hiWin.low_w)}–${fmt(hiWin.high_w)} W). The meter can’t say what it is.`,
      evidence: `Measured: hourly readings, latest 14 days vs your ${fmt(hiWin.rank_pct)}th-percentile history.`,
      savings: { kind: 'unknown', dollars: null, upTo: $(extra), method: `The extra above your usual is about ${fmt(extra)} kWh a month${$(extra) != null ? ` (≈ $${fmt($(extra), 2)})` : ''} — a measured ceiling, and only if the cause is something you don’t need.` },
      confidence: 'high', effort: 'low', comfort: 'none', verify: 'If you find something to switch off, start an experiment for those hours; the app compares them with the weeks before.',
      experiment: { title: `Switch off what I found running in the ${part(hiWin)}s`, hours: [h0, h1], days: null } });
  }

  // 2. The always-on load: measured; how much of it is removable is unknown.
  const n = r.night;
  if (n && n.mildNights >= 7) {
    const floor = n.alwaysOn, per10 = (10 / 1000) * 24 * 30;
    if (floor > 220) add({ id: 'standby', short: 'Check what stays on overnight', thermostat: false, control: 'unknown', action: 'Look for things that stay on all night, then test switching them off for a week.',
      why: `On mild nights your home draws about ${fmt(floor)} W between 1 and 5 AM. Many apartments sit around 150–220 W, but part of yours may be things you need (fridge, router). Nothing removable has been identified yet.`,
      evidence: `Measured: 1–5 AM average on ${n.mildNights} mild nights.`,
      savings: { kind: 'unknown', dollars: null, method: `Not estimable until something removable is found. For scale: every 10 W switched off all day and night is ${fmt(per10, 1)} kWh a month${$(per10) != null ? ` (≈ $${fmt($(per10), 2)})` : ''} — arithmetic, not a prediction.` },
      confidence: 'high', effort: 'low', comfort: 'none', verify: 'Start an experiment for 1–5 AM when you switch something off; small devices may be below what the meter can show, and the app will say so.',
      experiment: { title: 'Switch off always-on devices overnight', hours: [1, 5], days: null } });
    else considered.push({ id: 'standby', what: 'Cut always-on power', why: `Your mild-night floor is about ${fmt(floor)} W — already typical for an apartment.` });
  } else considered.push({ id: 'standby', what: 'Cut always-on power', why: 'Needs a week of mild nights (no heating or cooling) to measure the always-on load.' });

  // 3. Cooling setpoint: the household's own temperature is the baseline; one degree warmer is an optional, measured experiment.
  const cs = coolingSlope(days, temps), th = p.thermostat, base = th?.mode === 'cool' ? th.setpoint : null;
  if (base != null && p.buildingMode !== 'heat_available') {
    const meterNote = metered === 'yes' ? '' : metered === 'no' ? ' Cooling isn’t on your meter, so this wouldn’t change your bill.' : ' It isn’t confirmed that the cooling equipment runs on your meter, so any saving may not show on your bill.';
    if (metered !== 'no') add({ id: 'setpoint', short: 'Try one degree warmer on warm days', thermostat: true, control: 'yes', action: `Optional test: hold ${base + 1}°F instead of ${base}°F for two weeks of warm weather, then go back if it isn’t comfortable.`,
      why: `You keep the thermostat at ${base}°F on HOLD, day and night, by choice — that stays your baseline. One degree warmer is the smallest change that could matter.${cs ? ` In your readings, outdoor temperature explains only ${fmt(Math.max(0, cs.r2) * 100)}% of daily differences, so past days can’t say what one degree is worth.` : ''}${meterNote} ${base + 2}°F is a further option only if ${base + 1}°F feels fine.`,
      evidence: cs ? `Measured: ${cs.n} days of readings with outdoor temperatures; your confirmed setting (${base}°F HOLD, programming off).` : `Your confirmed setting (${base}°F HOLD, programming off).`,
      savings: { kind: 'unknown', dollars: null, method: 'Not estimated. The test measures it directly; in cool weather the cooling runs little, so the meter may not show a difference and the result will say “no clear difference”.' },
      confidence: 'low', effort: 'low', comfort: 'slight', verify: 'Start a test; the comparison uses the same hours and allows for the weather. The app never changes the thermostat — you set it, and set it back.',
      caveat: metered === 'yes' ? '' : 'Whether cooling is on your meter is unconfirmed.', experiment: { title: `Cooling held at ${base + 1}°F instead of ${base}°F`, hours: null, days: null, cooling: true } });
    else considered.push({ id: 'setpoint', what: `Hold ${base + 1}°F instead of ${base}°F`, why: 'Cooling isn’t on your meter, so it wouldn’t change your bill.' });
  } else if (cs && cs.per_cdd > 2 * cs.se && cs.r2 >= 0.3 && metered === 'yes' && p.buildingMode !== 'heat_available') {
    add({ id: 'cooling-setpoint', thermostat: true, control: 'yes', action: 'When it’s warm, try cooling 1°F warmer while you’re home and test it for two weeks.',
      why: `Your use rises about ${fmt(cs.per_cdd, 2)} kWh a day per degree above 65°F (weather explains ${fmt(cs.r2 * 100)}% of daily differences).`, evidence: `Measured: ${cs.n} days of readings with outdoor temperatures.`,
      savings: { kind: 'unknown', dollars: null, method: 'The effect of one degree can’t be read from past days; a test measures it directly.' },
      confidence: 'medium', effort: 'low', comfort: 'slight', verify: 'Start a test; the comparison allows for outdoor temperature.', experiment: { title: 'Cooling 1°F warmer', hours: null, days: null, cooling: true } });
  } else considered.push({ id: 'cooling-setpoint', what: 'Change the cooling setpoint', why: `${metered !== 'yes' ? 'It isn’t confirmed that the building’s cooling runs on your meter, so a thermostat change may not affect your bill. ' : ''}${cs ? `Outdoor temperature explains only ${fmt(Math.max(0, cs.r2) * 100)}% of your day-to-day differences, so the effect can’t be estimated from past days.` : 'There aren’t enough warm days with temperatures to judge.'} Record your thermostat setting in Settings to get a one-degree test.` });

  // 4. Hours nobody is home: the measured ceiling, and why a setback is uncertain.
  for (const a of unoccupiedUse({ state, now, temps })) {
    if (a.explained) { considered.push({ id: a.id, what: `${C.DAY_NAME[a.day]} ${a.window} while nobody’s home`, why: 'You said someone was home or something runs on a schedule then.' }); continue; }
    const hrs = (C.toMin(a.window.split('–')[1]) - C.toMin(a.window.split('–')[0])) / 60 || 2;
    const extra = (avg(a.recent.map((o) => Math.max(0, o.w - a.quiet_night_w))) * hrs * 4.3) / 1000;
    considered.push({ id: a.id, what: `${C.DAY_NAME[a.day]}s ${a.window} while nobody’s home`, why: `${holdsSteady(state) ? `You hold ${p.thermostat.setpoint}°F on purpose and are out only about ${fmt(hrs)} hours a week, so a schedule setback isn’t suggested. ` : ''}Even if all of the use above a quiet night were avoidable, it is about ${fmt(extra, 1)} kWh a month${$(extra) != null ? ` (≈ $${fmt($(extra), 2)})` : ''} — measured. A short setback would save only part of that, because the apartment is cooled again afterwards; how much is unknown. Small either way; an experiment can check it if you’re curious.`,
      experiment: { title: `Thermostat eases off on ${C.DAY_NAME[a.day]}s while we’re out`, hours: [C.toMin(a.window.split('–')[0]) / 60 | 0, Math.ceil(C.toMin(a.window.split('–')[1]) / 60)], days: [C.DOW.indexOf(a.day)], cooling: true } });
  }

  // Considered, with the reason — so they aren't raised again without new evidence.
  const ps = priceStructure(state);
  considered.push({ id: 'time-shift', what: 'Run laundry or dishes at other hours', why: ps.flat ? `${ps.text} Shifting use saves nothing.` : 'The file doesn’t show whether your price changes by hour, so the benefit of shifting use is unknown.' });
  considered.push({ id: 'peaks', what: 'Avoid short peaks', why: 'Residential bills charge for kWh used; a short peak costs only the energy it uses.' });
  const lamp = (w) => (2 * w * 4 * 30) / 1000;
  considered.push({ id: 'lighting', what: 'Lamps at night', why: `Engineering estimate, assuming two lamps for 4 hours a night: ${fmt(lamp(9))} kWh a month with LED bulbs (9 W) to ${fmt(lamp(60))} kWh with old 60 W bulbs${$(lamp(60)) != null ? ` (at most ≈ $${fmt($(lamp(60)), 2)})` : ''} — too small to explain a daytime change, and likely below what the meter can show. Your lamps’ real wattage would make this exact.` });
  const fanAns = answerFor(state, 'fan_mode', '');
  considered.push({ id: 'fan', what: 'Thermostat fan AUTO instead of ON', why: fanAns?.value === 'auto' ? 'You said the fan is on AUTO.' : 'A fan left ON would raise use day and night; your nights didn’t rise, so it’s unlikely. Still a free 10-second check on the thermostat.' });
  considered.push({ id: 'equipment', what: 'New equipment (thermostat, AC, appliances)', why: 'No purchase has a payback case from your readings; the app won’t suggest spending money without one.' });

  items.sort((a, b) => b.score - a.score);
  const normal = bl && ['typical', 'return_to_typical', 'unusually_low'].includes(bl.status);
  return { items, considered, rate: rf, normal, baselineStatus: bl?.status || null, price: ps,
    note: normal ? 'Your use is normal for your home. Normal isn’t the same as efficient — but no saving below is proven yet. The way to find out is to test one change and let the meter show the result.' : '' };
}


// ================= Statement text → fields for review (never saved without the household checking them) =================

const amt = (x) => (x == null ? null : +String(x).replace(/[$,\s]/g, ''));
const usDate = (m) => { if (!m) return ''; const [mo, d, y] = m.split('/').map(Number), yy = y < 100 ? 2000 + y : y; return yy > 2000 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${yy}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : ''; };
/**
 * Reads only clearly labelled figures from a statement's text. Anything not found stays empty; "Amount due" is never used as the
 * current charges (it can include a prior balance). Returns { fields, found, notFound }.
 */
export function parseStatementText(text) {
  const t = String(text || '').replace(/ /g, ' ');
  const money1 = (re) => { const m = re.exec(t); return m ? amt(m[1]) : null; };
  const D = String.raw`(\d{1,2}/\d{1,2}/\d{2,4})`;
  const per = new RegExp(String.raw`(?:service|billing)\s+period[^\n\d]{0,40}` + D + String.raw`\s*(?:-|–|to|through|thru)\s*` + D, 'i').exec(t)
    || new RegExp(String.raw`(?:service|meter read)[^\n]{0,30}from\s*` + D + String.raw`\s*(?:-|–|to|through)\s*` + D, 'i').exec(t);
  const M = String.raw`[^\n$\d]{0,30}\$?\s*\(?(-?[\d,]+\.\d{2})\)?`;
  const fields = {
    start: per ? usDate(per[1]) : '', end: per ? usDate(per[2]) : '',
    statementDate: (() => { const m = new RegExp(String.raw`(?:bill|statement|billing)\s+date[^\n\d]{0,15}` + D, 'i').exec(t); return m ? usDate(m[1]) : ''; })(),
    days: (() => { const m = /(?:number of days|billing days|days in (?:billing|service) period|days billed)[^\d\n]{0,15}(\d{2})\b/i.exec(t); return m ? +m[1] : null; })(),
    kwh: (() => { const m = /(?:total\s+kwh(?:\s+used)?|kwh\s+used|total\s+usage|energy\s+used)[^\d\n]{0,25}([\d,]+(?:\.\d+)?)/i.exec(t); return m ? amt(m[1]) : null; })(),
    amount: money1(new RegExp(String.raw`(?:total\s+)?current\s+(?:electric\s+)?charges` + M, 'i')),
    supply: money1(new RegExp(String.raw`(?:total\s+)?(?:electric\s+)?supply\s+(?:charges|service)` + M, 'i')),
    delivery: money1(new RegExp(String.raw`(?:total\s+)?(?:electric\s+)?(?:delivery|distribution)\s+(?:charges|service)` + M, 'i')),
    fixed: money1(new RegExp(String.raw`customer\s+charge` + M, 'i')),
    taxes: money1(new RegExp(String.raw`total\s+taxes(?:\s+and\s+(?:fees|surcharges))?` + M, 'i')),
    credits: (() => { const v = money1(new RegExp(String.raw`(?:total\s+)?credits?(?!\s*card)` + M, 'i')); return v == null ? null : Math.abs(v); })(),
    adjustments: money1(new RegExp(String.raw`adjustments?` + M, 'i')),
    priorBalance: money1(new RegExp(String.raw`(?:previous|prior)\s+balance` + M, 'i')),
    payments: (() => { const v = money1(new RegExp(String.raw`payments?(?:\s+received)?(?:\s*-\s*thank you)?` + M, 'i')); return v == null ? null : Math.abs(v); })(),
    totalDue: money1(new RegExp(String.raw`(?:total\s+)?amount\s+due` + M, 'i')),
    estimatedRead: /\bestimated\s+(?:meter\s+)?read(?:ing)?\b/i.test(t) ? true : /\bactual\s+(?:meter\s+)?read(?:ing)?\b/i.test(t) ? false : null,
  };
  if (fields.start && fields.end && fields.start >= fields.end) { fields.start = ''; fields.end = ''; }
  const found = Object.entries(fields).filter(([, v]) => v !== null && v !== '').map(([k]) => k);
  return { fields, found, notFound: Object.keys(fields).filter((k) => !found.includes(k)) };
}

// ================= Price structure: measured from the file, never assumed =================

/**
 * The file only keeps a cost per day. If the price per kWh were different at different hours, a day's cost per kWh would move as the
 * day's load shape moves. So: a stable daily ¢/kWh across days whose shapes differ is evidence of one flat price within the day.
 */
export function priceStructure(state) {
  const days = C.dailyTotals(state.usage).filter((d) => d.complete && d.cost != null && d.kwh > 0).slice(-60);
  if (days.length < 14) return { known: false, reason: 'Needs at least two weeks of readings with costs.' };
  const hd = new Map(hourlyByDay(state.usage, days.map((d) => d.date)).map((d) => [d.date, d]));
  const runs = []; // periods of a constant daily price (prices do change between dates)
  for (const d of days) { const c = (d.cost / d.kwh) * 100, last = runs[runs.length - 1]; if (last && Math.abs(last.cents - c) < 0.02) { last.to = d.date; last.days.push(d); } else runs.push({ cents: c, from: d.date, to: d.date, days: [d] }); }
  const longest = runs.reduce((m, r) => (r.days.length > m.days.length ? r : m));
  const share = longest.days.map((d) => hd.get(d.date)).filter(Boolean).map((x) => sum(x.h.slice(12, 22)) / sum(x.h));
  const shapeSpread = share.length >= 7 ? Math.max(...share) - Math.min(...share) : 0;
  const flat = longest.days.length >= 14 && shapeSpread >= 0.1;
  return { known: flat, flat, cents: r2(longest.cents), days: longest.days.length, from: longest.from, to: longest.to, changes: runs.length - 1,
    text: flat ? `Your cost per kWh in the file was ${fmt(longest.cents, 2)}¢ on each of ${longest.days.length} days (${md(longest.from)}–${md(longest.to)}), even on days when more of your use fell in the afternoon and evening — so the price doesn’t change with the hour.`
      : 'The file doesn’t show whether your price changes by hour.' };
}

// ================= Savings experiments: try one change, measure it honestly =================

export const EXP_STATUS = { running: 'Running', ended: 'Ended' };
const DOW_IDX = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
// ---- time windows: a window is [from, until] in hours. until ≤ from means "through midnight into the next morning" (10 PM → 6 AM).
export const isOvernight = (h) => Array.isArray(h) && h[1] < h[0];
export const windowHours = (h) => (!h ? 24 : h[1] > h[0] ? h[1] - h[0] : 24 - h[0] + h[1]);
const hr12 = (h) => (h === 0 || h === 24 ? '12 AM' : h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h - 12} PM`);
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], DOWFULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Plain-English window: "10 PM → 6 AM the next morning", "weekdays, 12 PM–5 PM", "Fri and Sat nights, 10 PM → 6 AM". */
export function windowLabel(hours, days, { tonight = false } = {}) {
  const over = isOvernight(hours);
  const span = !hours ? 'the whole day' : over ? (tonight ? `${hr12(hours[0])} tonight → ${hr12(hours[1])} tomorrow` : `${hr12(hours[0])} → ${hr12(hours[1])} the next morning`) : `${hr12(hours[0])}–${hr12(hours[1])}`;
  if (!days || days.length === 7) return span;
  const key = [...days].sort().join(',');
  if (over) {
    const who = key === '1,2,3,4,5' ? 'weekday' : key === '0,6' ? 'weekend' : days.length === 1 ? DOWFULL[days[0]] : days.map((d) => DOWS[d]).join(' and ');
    return `${who} nights, ${hr12(hours[0])} → ${hr12(hours[1])}`;
  }
  const who = key === '1,2,3,4,5' ? 'weekdays' : key === '0,6' ? 'weekends' : days.length === 1 ? `${DOWFULL[days[0]]}s` : days.map((d) => DOWS[d]).join(' and ');
  return `${who}, ${span}`;
}
/** Which hours of the week a window covers, as slots (weekday × 24 + hour), counted from the weekday the window STARTS on. */
function windowSlots(e) {
  const [h0, h1] = e.hours || [0, 24], n = windowHours(e.hours), out = new Set();
  for (const d of e.days || [0, 1, 2, 3, 4, 5, 6]) for (let k = 0; k < (e.hours ? n : 24); k++) out.add((d * 24 + (e.hours ? h0 : 0) + k) % 168);
  return out;
}
/** Do two tests ever change the same hours (across midnight too), within overlapping date ranges? */
export function windowsOverlap(a, b) {
  if (a.start > (b.end || '9999') || b.start > (a.end || '9999')) return false;
  const sa = windowSlots(a), sb = windowSlots(b);
  for (const x of sa) if (sb.has(x)) return true;
  return false;
}
export const PLAIN_RESULT = { reduced: 'Electricity use went down.', increased: 'Electricity use went up.', inconclusive: 'No clear difference.', collecting: 'We need more readings.', too_small: 'Too small for the meter to show.', confounded: 'Can’t tell — another change overlapped.', invalid: 'This test needs a valid time.' };

/** Sanitise experiments the household created. A window that makes no sense is flagged invalid — never turned into a whole-day test. */
export function cleanExperiments(list) {
  return (Array.isArray(list) ? list : []).filter((e) => e && typeof e.id === 'string' && typeof e.title === 'string' && isIso(e.start)).slice(-40).map((e) => {
    let hours = null, invalid = e.invalid === 'window' ? 'window' : undefined;
    if (e.hours != null) {
      const h = Array.isArray(e.hours) && e.hours.length === 2 ? e.hours.map((x) => (typeof x === 'number' ? x : NaN)) : null;
      if (h && h.every((x) => Number.isInteger(x) && x >= 0 && x <= 24) && h[0] < 24 && h[0] !== h[1] && !(h[0] === 0 && h[1] === 24 && false)) hours = h[1] === 0 && h[0] > 0 ? [h[0], 24] : h;
      else invalid = 'window';
    }
    return {
      id: e.id.slice(0, 40), title: e.title.slice(0, 160), start: e.start, end: isIso(e.end) && e.end >= e.start ? e.end : '',
      startedAt: /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(e.startedAt || '') ? e.startedAt : '', hours, ...(invalid ? { invalid } : {}),
      days: Array.isArray(e.days) && e.days.length && e.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) ? [...new Set(e.days)].sort() : null,
      watts: Number.isFinite(+e.watts) && +e.watts > 0 && +e.watts < 10000 ? +e.watts : null, hoursPerDay: Number.isFinite(+e.hoursPerDay) && +e.hoursPerDay > 0 && +e.hoursPerDay <= 24 ? +e.hoursPerDay : null,
      cooling: e.cooling === true, exclude: (Array.isArray(e.exclude) ? e.exclude : []).filter(isIso).slice(0, 60), decision: ['keep', 'revert'].includes(e.decision) ? e.decision : null,
      note: String(e.note || '').slice(0, 300), at: isIso(e.at) ? e.at : e.start,
    };
  }).sort((a, b) => (a.start < b.start ? -1 : 1));
}

/**
 * Before/after comparison for one test. A test is a window of hours (overnight windows run from the START date into the next morning) on
 * chosen weekdays (the weekday the window starts on). One value per occurrence = the kWh in that window, counted only when EVERY hour has a
 * reading — an hour that was not recorded is never filled in with zero. "Before" = the 8 weeks before the test began; "after" = occurrences
 * starting at or after the moment the change was confirmed. Temperature adjusts the comparison only when the "before" days show a clear effect.
 * Results: reduced / increased / inconclusive / too small / not attributable / collecting.
 */
export function evaluateExperiment({ state, temps = {}, exp, now = Date.now() }) {
  const e = cleanExperiments([exp])[0];
  if (!e) return { status: 'invalid', label: PLAIN_RESULT.invalid };
  if (e.invalid) return { id: e.id, title: e.title, status: 'invalid', label: PLAIN_RESULT.invalid, detail: 'The time window for this test isn’t valid. Open the test and correct it.', caveats: [] };
  const over = isOvernight(e.hours), [h0, h1] = e.hours || [0, 24], hrs = windowHours(e.hours), perWeek = e.days ? e.days.length : 7;
  const unit = over ? 'night' : 'day', pad = (h) => String(h).padStart(2, '0');
  const H = state.usage.hourly || {};
  const hasDate = new Set(Object.keys(H).map((k) => k.slice(0, 10))), lastDate = [...hasDate].sort().pop() || null;
  const wholeDay = new Map(C.dailyTotals(state.usage).filter((d) => d.complete).map((d) => [d.date, d.kwh]));
  const startedKey = e.startedAt || `${e.start}T${pad(e.hours ? 0 : 0)}`;
  const end = e.end || lastDate || e.start;
  const occ = []; let incomplete = 0, partialStart = 0;
  for (let d = isoAdd(e.start, -56); d <= end; d = isoAdd(d, 1)) {
    if ((e.days && !e.days.includes(DOW_IDX(d))) || e.exclude.includes(d)) continue;
    let value = null, seen = false;
    if (!e.hours) { if (wholeDay.has(d)) value = wholeDay.get(d); else { if (d >= e.start && hasDate.has(d)) incomplete++; continue; } seen = true; }
    else {
      const keys = []; for (let k = 0; k < hrs; k++) { const hh = h0 + k; keys.push(hh < 24 ? `${d}T${pad(hh)}` : `${isoAdd(d, 1)}T${pad(hh - 24)}`); }
      const present = keys.filter((k) => H[k] != null).length;
      if (present === keys.length) { value = sum(keys.map((k) => H[k])); seen = true; } else { if (d >= e.start && (present > 0 || hasDate.has(d))) incomplete++; continue; }
    }
    if (value == null) continue;
    const startKey = `${d}T${pad(e.hours ? h0 : 0)}`, beforeStart = d < e.start;
    const t = Number.isFinite(temps[d]) ? (over && Number.isFinite(temps[isoAdd(d, 1)]) ? (temps[d] + temps[isoAdd(d, 1)]) / 2 : temps[d]) : null;
    occ.push({ date: d, v: value, t, startKey, side: beforeStart ? 'before' : (e.hours ? startKey >= startedKey : (e.startedAt && +e.startedAt.slice(11) > 0 ? d > e.startedAt.slice(0, 10) : d >= e.start)) ? 'after' : 'partial' });
  }
  const before = occ.filter((o) => o.side === 'before'), after = occ.filter((o) => o.side === 'after');
  partialStart = occ.filter((o) => o.side === 'partial').length;
  const needAfter = e.days ? Math.min(4, 2 * perWeek) : 7, needBefore = e.days ? Math.min(6, 3 * perWeek) : 14;
  const out = { id: e.id, title: e.title, window: windowLabel(e.hours, null), days_after: after.length, days_before: before.length, need_after: needAfter, unit, caveats: [] };
  const val = (o) => o.v;
  const overlapping = cleanExperiments(state.experiments).filter((o) => o.id !== e.id && !o.invalid && windowsOverlap(o, { ...e, end }));
  if (before.length < needBefore) return { ...out, status: 'collecting', label: PLAIN_RESULT.collecting, detail: `Needs ${needBefore} comparable ${unit}s in the 8 weeks before ${md(e.start)}; there are ${before.length}.` };
  if (after.length < needAfter) return { ...out, status: 'collecting', label: PLAIN_RESULT.collecting, detail: `${after.length} of ${needAfter} comparable ${unit}s so far${lastDate && lastDate < C.localParts(now).date ? ` — your newest reading is from ${md(lastDate)}. Import a newer Delmarva file after a few more ${unit}s.` : '.'}` };
  // Weather: fitted effect, else none (said plainly).
  const bT = before.filter((o) => o.t != null), aT = after.filter((o) => o.t != null);
  let adjust = () => 0, method = 'plain before/after average (no outdoor temperatures)';
  if (bT.length >= 10 && aT.length === after.length) {
    const xs = bT.map((o) => o.t), ys = bT.map(val), mx = avg(xs), my = avg(ys), sxx = sum(xs.map((x) => (x - mx) ** 2));
    const b = sxx > 0 ? sum(xs.map((x, i) => (x - mx) * (ys[i] - my))) / sxx : 0, res = ys.map((y, i) => y - my - b * (xs[i] - mx));
    const se = sxx > 0 ? Math.sqrt(sum(res.map((r) => r * r)) / Math.max(1, xs.length - 2) / sxx) : Infinity;
    const outside = aT.filter((o) => o.t < Math.min(...xs) - 3 || o.t > Math.max(...xs) + 3).length;
    if (Math.abs(b) > 2 * se && outside <= after.length * 0.3) { adjust = (o) => b * (o.t - mx); method = `before/after, adjusted for outdoor temperature (${fmt(b, 2)} kWh per °F in these hours, from ${bT.length} earlier ${unit}s)`; }
    else if (Math.abs(b) > 2 * se) out.caveats.push('The weather during the test was outside the range of the comparison days, so the weather adjustment can’t be trusted; the result is marked uncertain.');
    else method = `before/after average; outdoor temperature showed no clear effect on these hours (${bT.length} earlier ${unit}s)`;
  }
  const rb = before.map((o) => val(o) - adjust(o)), ra = after.map((o) => val(o) - adjust(o));
  const diff = avg(ra) - avg(rb), se = Math.sqrt(sd(rb) ** 2 / rb.length + sd(ra) ** 2 / ra.length), lo = diff - 1.96 * se, hi = diff + 1.96 * se, mde = 2.8 * se;
  const expected = e.watts && (e.hoursPerDay || hrs) ? (e.watts * Math.min(e.hoursPerDay || hrs, hrs)) / 1000 : null;
  const perMonth = (k) => (k * perWeek * 30) / 7;
  const rf = rateFor(state), $ = (k) => (rf.rate != null ? k * rf.rate : null);
  Object.assign(out, { diff_kwh: r2(diff), ci: [r2(lo), r2(hi)], mde_kwh: r2(mde), method, before_kwh: r2(avg(before.map(val))), after_kwh: r2(avg(after.map(val))), expected_kwh: expected != null ? r2(expected) : null });
  if (incomplete) out.caveats.push(`${incomplete} ${unit}(s) had incomplete readings and were left out.`);
  if (partialStart) out.caveats.push(`The ${unit} you started on was only partly covered, so it isn’t counted.`);
  if (e.exclude.length) out.caveats.push(`${e.exclude.length} ${e.exclude.length === 1 ? 'day' : 'days'} you marked as unusual ${e.exclude.length === 1 ? 'was' : 'were'} left out.`);
  if (out.caveats.some((c) => /outside the range/.test(c))) return { ...out, status: 'inconclusive', label: PLAIN_RESULT.inconclusive, detail: out.caveats.find((c) => /outside the range/.test(c)) };
  if (overlapping.length) return { ...out, status: 'confounded', label: PLAIN_RESULT.confounded, detail: `“${overlapping[0].title}” changes some of the same hours${overlapping.length > 1 ? `, and so do ${overlapping.length - 1} other test(s)` : ''}, so a difference can’t be credited to this change alone.` };
  const money = (k) => { const v = $(perMonth(k)); return v != null ? `$${fmt(v, 2)}` : null; };
  if (expected != null && expected < mde) {
    const eng = perMonth(expected);
    return { ...out, status: 'too_small', label: PLAIN_RESULT.too_small, detail: `The change you described (${fmt(e.watts)} W for ${fmt(Math.min(e.hoursPerDay || hrs, hrs), 1)} h ≈ ${fmt(expected, 2)} kWh a ${unit}) is smaller than the ${unit}-to-${unit} swings in these hours (the meter could only show about ${fmt(mde, 2)} kWh or more). Hourly whole-home readings can’t confirm it.`,
      engineering: { kwh_month: r1(eng), dollars: $(eng) != null ? r2($(eng)) : null, method: `Your stated ${fmt(e.watts)} W × ${fmt(Math.min(e.hoursPerDay || hrs, hrs), 1)} h × ${fmt((perWeek * 30) / 7, 1)} ${unit}s a month${rf.rate != null ? ` × ${fmt(rf.rate * 100, 2)}¢ (${rf.source})` : ''}. An engineering estimate, not a measurement.` } };
  }
  if (hi < 0) {
    const m = perMonth(-diff), mLo = perMonth(-hi), mHi = perMonth(-lo), longEnough = after.length >= (e.days ? 2 * perWeek : 14);
    return { ...out, status: 'reduced', label: PLAIN_RESULT.reduced, detail: `${fmt(-diff, 2)} kWh less each ${unit} in ${windowLabel(e.hours, null)} (range ${fmt(-hi, 2)}–${fmt(-lo, 2)}), over ${after.length} ${unit}s vs ${before.length} before.${longEnough ? '' : ' Keep going: more ${unit}s will firm this up.'.replace('${unit}', unit)}`,
      monthly: { kwh: [r1(mLo), r1(mHi)], kwh_mid: r1(m), dollars: money(-hi) && money(-lo) ? [r2($(mLo)), r2($(mHi))] : null, method: `Measured kWh per ${unit} × ${fmt((perWeek * 30) / 7, 1)} ${unit}s a month${rf.rate != null ? ` × ${fmt(rf.rate * 100, 2)}¢ (${rf.source})` : ''}. Assumes the change continues and conditions stay similar.${e.cooling && state.profile.hvacMetered !== 'yes' ? ' Cooling may not be on your meter — unconfirmed — so the bill effect is uncertain.' : ''}` }, early: !longEnough };
  }
  if (lo > 0) return { ...out, status: 'increased', label: PLAIN_RESULT.increased, detail: `${fmt(diff, 2)} kWh more each ${unit} in ${windowLabel(e.hours, null)} (range ${fmt(lo, 2)}–${fmt(hi, 2)}). The change didn’t help, or something else changed at the same time.` };
  return { ...out, status: 'inconclusive', label: PLAIN_RESULT.inconclusive, detail: `The difference (${diff >= 0 ? '+' : ''}${fmt(diff, 2)} kWh a ${unit}) is within normal ${unit}-to-${unit} variation; the meter could only show about ${fmt(mde, 2)} kWh or more.${expected != null ? ` Your described change is about ${fmt(expected, 2)} kWh a ${unit}.` : ''}` };
}

/** Why the latest billing period differs from the earlier ones — only from the reported figures and the readings for the same days. */
function billingStory(statements, days) {
  const full = statements.filter((x) => x.kwh && x.billed_days && x.amount != null);
  if (full.length < 3) return null;
  const cur = full[full.length - 1], earlier = full.slice(0, -1), kd = (x) => x.kwh / x.billed_days, cd = (x) => x.amount / x.billed_days, ck = (x) => x.amount / x.kwh;
  const lowest = full.reduce((m, x) => (x.amount < m.amount ? x : m));
  const out = [`Billing periods: ${full.map((x) => `${md(x.start)}–${md(x.end)} ${money(x.amount)} (${x.billed_days} days, ${fmt(x.kwh)} kWh)`).join('; ')}.`];
  if (lowest === cur) {
    const mk = median(earlier.map(kd)), mc = median(earlier.map(ck)), md0 = median(earlier.map((x) => x.billed_days));
    out.push(`The ${md(cur.start)}–${md(cur.end)} bill (${money(cur.amount)}) was the lowest because less electricity was used: ${fmt(kd(cur), 1)} kWh a day vs ${fmt(mk, 1)} typical in the earlier periods. It also had ${cur.billed_days} days (typical ${fmt(md0)}), and an average of ${fmt(ck(cur) * 100, 1)}¢ per kWh vs ${fmt(mc * 100, 1)}¢.`);
    const inPer = days.filter((d) => d.date >= cur.start && d.date <= cur.end);
    if (inPer.length === cur.billed_days) {
      const before = days.filter((d) => d.date < cur.start).slice(-60);
      if (before.length >= 30) out.push(`Your readings agree: ${fmt(avg(inPer.map((d) => d.kwh)), 1)} kWh a day in that period vs ${fmt(avg(before.map((d) => d.kwh)), 1)} in the 60 days before — the bill was lower because use was lower, not because of a billing change.`);
    }
  }
  return out;
}

// ================= v20: utility projections, the independent bill forecast, and how both are checked =================

/**
 * Utility projection snapshots the household entered (read from the Delmarva account). Kept as a history: a new reading never replaces an old
 * one, and none of them is ever a bill. `shownOn` is the date the household saw it (empty when not stated); `utilityUpdated` is the utility's own
 * update time, which is not known and is never invented. `app` is the app's own estimate at the moment of entry, kept for later accuracy checks.
 */
export function cleanProjections(list) {
  return (Array.isArray(list) ? list : []).filter((p) => p && isMoney(+p.amount) && +p.amount >= 0 && isIso(p.periodEnd)).slice(-60).map((p) => ({
    id: String(p.id || `p|${p.periodEnd}|${+p.amount}|${isIso(p.shownOn) ? p.shownOn : isIso(p.enteredAt) ? p.enteredAt : ''}`).slice(0, 80),
    amount: +p.amount, soFar: isMoney(+p.soFar) && +p.soFar >= 0 && p.soFar !== '' && p.soFar != null ? +p.soFar : null,
    periodStart: isIso(p.periodStart) && p.periodStart <= p.periodEnd ? p.periodStart : '', periodEnd: p.periodEnd,
    source: typeof p.source === 'string' && p.source ? p.source.slice(0, 60) : 'entered by you', enteredAt: isIso(p.enteredAt) ? p.enteredAt : '', shownOn: isIso(p.shownOn) ? p.shownOn : '', utilityUpdated: null,
    status: 'projected', app: p.app && isMoney(+p.app.mid) ? { mid: +p.app.mid, low: +p.app.low, high: +p.app.high, method: String(p.app.method || '').slice(0, 20), through: isIso(p.app.through) ? p.app.through : '' } : null,
  })).filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i).sort((a, b) => (a.enteredAt + a.id < b.enteredAt + b.id ? -1 : 1));
}
/** The projection to show for the current period: the latest snapshot whose period no final bill has closed. */
export function currentProjection(state) {
  const bills = cleanBills(state.bills);
  const open = cleanProjections(state.projections).filter((p) => !finalBillFor(p, bills));
  return open.length ? open[open.length - 1] : null;
}
/** The actual billing record for a projection's period (same end date within a day, and a compatible start). */
export function finalBillFor(p, bills) {
  return bills.find((b) => b.amount != null && Math.abs(isoGap(b.end, p.periodEnd)) <= 1 && (!p.periodStart || !b.start || Math.abs(isoGap(b.start, p.periodStart)) <= 1)) || null;
}
/** Does this amount fall in the household's ordinary range? Bills within 12% of the median define "ordinary"; the rest are named exceptions. */
export function billNormal(bills, amount, usual = null) {
  const list = bills.filter((b) => b.amount != null);
  if (list.length < 3) return { known: false };
  const med = median(list.map((b) => b.amount)), ord = list.filter((b) => Math.abs(b.amount / med - 1) <= 0.12), out = list.filter((b) => !ord.includes(b));
  const lo = Math.min(...ord.map((b) => b.amount)), hi = Math.max(...ord.map((b) => b.amount));
  // "Ordinary" is the range of those bills widened by 3% on each side: a projection a hair below the lowest ordinary bill isn't unusual.
  return { known: true, within: amount >= lo * 0.97 && amount <= hi * 1.03, range: [lo, hi], n: ord.length, of: list.length, exceptions: out.map((b) => ({ end: b.end, amount: b.amount })), usual };
}

// ---- the forecast: pure, so a backtest can run it with only what was known at the time ----
const FORECAST_ORDER = ['recent7', 'history', 'blend', 'weather'];
const FORECAST_NAME = { recent7: 'Recent days', history: 'Your past bills', blend: 'Recent days + past bills', weather: 'Weather-adjusted' };
export const FORECAST_METHODS = FORECAST_NAME;
/** Price per kWh including everything on the bill (fixed charges, taxes), from the most recent bills' own totals — never from the hourly costs. */
function effectiveCents(prior) {
  const c = prior.filter((b) => b.kwh && b.amount != null).slice(-3).map((b) => b.amount / b.kwh);
  return c.length ? { price: median(c), n: c.length, lo: Math.min(...c), hi: Math.max(...c) } : null;
}
function forecastCore({ days, bills, temps = {}, start, end, upto }) {
  const L = isoGap(start, end) + 1, ok = days.filter((d) => d.date <= upto);
  const meas = ok.filter((d) => d.date >= start && d.date <= end), measKwh = sum(meas.map((d) => d.kwh)), rem = L - meas.length;
  const prior = bills.filter((b) => b.end < start && b.days && b.kwh), pr = effectiveCents(prior);
  const rec7 = ok.length >= 7 ? avg(ok.slice(-7).map((d) => d.kwh)) : null;
  const hist = prior.length ? avg(prior.map((b) => b.kwh / b.days)) : null;
  // Weather: only with a clear temperature effect in the days before the period, and the last week's temperature assumed to continue.
  let wx = null;
  const fit = ok.filter((d) => d.date < start && Number.isFinite(temps[d.date])), cs = fit.length >= 30 ? coolingSlope(fit, temps) : null;
  if (cs && cs.r2 >= 0.3 && cs.per_cdd > 2 * cs.se) { const t = avg(ok.slice(-7).map((d) => temps[d.date]).filter(Number.isFinite)); const my = avg(fit.map((d) => d.kwh)), mx = avg(fit.map((d) => Math.max(0, temps[d.date] - 65))); if (Number.isFinite(t)) wx = my + cs.per_cdd * (Math.max(0, t - 65) - mx); }
  const rate = { recent7: rec7, history: hist, blend: rec7 != null && hist != null ? 0.5 * rec7 + 0.5 * hist : null, weather: wx };
  const out = {};
  for (const m of FORECAST_ORDER) if (rate[m] != null && pr) out[m] = { kwhDay: rate[m], kwh: measKwh + rem * rate[m], dollars: (measKwh + rem * rate[m]) * pr.price };
  return { L, measured: meas.length, measKwh, remaining: rem, lastMeasured: meas.length ? meas[meas.length - 1].date : null, price: pr, methods: out, rate };
}

/**
 * Backtest: forecast each saved bill using only readings up to `k` days into its period and only the bills that ended before it began.
 * Returns the per-bill errors, a summary per method, and which method the current stage selects (lowest mean error; a simpler method wins
 * when within $1.50). With only a handful of bills this is a sanity check, not proof — and it says so.
 */
export function backtestForecast({ state, temps = {}, k = 12 }) {
  const days = C.dailyTotals(state.usage).filter((d) => d.complete), bills = cleanBills(state.bills).map((b) => ({ ...b, days: billedDays(b) })).filter((b) => b.start && b.days && b.kwh && b.amount != null);
  const rows = [];
  bills.forEach((b, i) => {
    const upto = isoAdd(b.start, k - 1), fc = forecastCore({ days, bills: bills.slice(0, i), temps, start: b.start, end: b.end, upto });
    if (fc.measured < Math.min(k, 3)) return rows.push({ end: b.end, start: b.start, days: b.days, actual: b.amount, skipped: 'Not enough readings in the first days of that period.' });
    if (!fc.price) return rows.push({ end: b.end, start: b.start, days: b.days, actual: b.amount, skipped: 'No earlier bill to learn the price from.' });
    rows.push({ end: b.end, start: b.start, days: b.days, actual: b.amount, measured: fc.measured, errors: Object.fromEntries(Object.entries(fc.methods).map(([m, v]) => [m, r2(v.dollars - b.amount)])), forecasts: Object.fromEntries(Object.entries(fc.methods).map(([m, v]) => [m, r2(v.dollars)])) });
  });
  const used = rows.filter((r) => r.errors);
  const summary = {};
  for (const m of FORECAST_ORDER) {
    const e = used.filter((r) => r.errors[m] != null);
    if (e.length) summary[m] = { n: e.length, mae: r2(avg(e.map((r) => Math.abs(r.errors[m])))), bias: r2(avg(e.map((r) => r.errors[m]))), mape: r1(avg(e.map((r) => Math.abs(r.errors[m]) / r.actual)) * 100), worst: r2(Math.max(...e.map((r) => Math.abs(r.errors[m])))) };
  }
  let selected = null;
  for (const m of FORECAST_ORDER) if (summary[m] && summary[m].n >= 3) { const best = Math.min(...Object.values(summary).filter((x) => x.n >= 3).map((x) => x.mae)); if (summary[m].mae <= best + 1.5) { selected = m; break; } }
  return { k, rows, summary, selected, n: used.length, caution: `Based on ${used.length} past bill${used.length === 1 ? '' : 's'} — enough for a sanity check, not for a precise accuracy claim.` };
}

/**
 * The independent forecast for one billing period, from readings the app actually has. Days without a reading are forecast, never counted as zero.
 * The point estimate is shown only when the backtested error is small enough to be useful; otherwise only a range.
 */
export function forecastBill({ state, temps = {}, now = Date.now(), period = null }) {
  const days = C.dailyTotals(state.usage).filter((d) => d.complete), bills = cleanBills(state.bills).map((b) => ({ ...b, days: billedDays(b) })).filter((b) => b.start && b.days && b.kwh && b.amount != null);
  const proj = currentProjection(state);
  const per = period || (proj && proj.periodStart ? { start: proj.periodStart, end: proj.periodEnd } : null) || (bills.length ? (() => { const L = Math.round(median(bills.map((b) => b.days))); const s0 = isoAdd(bills[bills.length - 1].end, 1); return { start: s0, end: isoAdd(s0, L - 1), assumed: true }; })() : null);
  if (!per || !days.length) return { available: false, reason: !bills.length ? 'Needs at least one billing period to learn your price.' : 'Needs readings.' };
  const lastDay = days[days.length - 1].date, upto = lastDay < per.end ? lastDay : per.end;
  const fc = forecastCore({ days, bills, temps, start: per.start, end: per.end, upto });
  const today = C.localParts(now).date, age = Math.max(0, isoGap(lastDay, today));
  const base = { available: true, period: per, days: fc.L, measured: fc.measured, remaining: fc.remaining, lastMeasured: fc.lastMeasured, readingsEnd: lastDay, readingsAgeDays: age, measuredKwh: r1(fc.measKwh), periodAssumed: !!per.assumed };
  if (!fc.price) return { ...base, available: false, reason: 'Needs a past bill with kWh to learn your all-in price per kWh.' };
  const bt = backtestForecast({ state, temps, k: Math.min(Math.max(fc.measured, 3), fc.L - 1) });
  const method = fc.measured < 3 ? 'history' : bt.selected && fc.methods[bt.selected] ? bt.selected : (fc.methods.blend ? 'blend' : fc.methods.recent7 ? 'recent7' : 'history');
  const m = fc.methods[method];
  if (!m) return { ...base, available: false, reason: 'Not enough readings or past bills for any method.' };
  const mae = bt.summary[method]?.mae, half = mae != null && bt.n >= 3 ? 1.5 * mae : 0.12 * m.dollars, mid = m.dollars;
  const tooWide = half > 0.2 * mid;
  const all = Object.fromEntries(Object.entries(fc.methods).map(([k2, v]) => [k2, r2(v.dollars)]));
  return { ...base, method, methodName: FORECAST_NAME[method], mid: r2(mid), low: r2(mid - half), high: r2(mid + half), halfWidth: r2(half), pointOk: !tooWide, kwhDay: r1(m.kwhDay), kwh: r0(m.kwh), cents: r2(fc.price.price * 100), centsRange: [r2(fc.price.lo * 100), r2(fc.price.hi * 100)], priceFrom: fc.price.n,
    recent7: fc.rate.recent7 != null ? r1(fc.rate.recent7) : null, history: fc.rate.history != null ? r1(fc.rate.history) : null, otherMethods: all, backtest: bt,
    uncertainty: bt.n >= 3 ? `typical error in past bills about $${fmt(mae)} (${fmt(bt.summary[method].mape, 1)}%), so the range allows about $${fmt(half)} either way` : 'no past bills to check this against, so a ±12% range is assumed', unmeasured: fc.remaining,
    method_text: `${fmt(fc.measKwh)} kWh measured in the ${fc.measured} days with readings (${md(per.start)}–${md(fc.lastMeasured)}) + ${fc.remaining} days forecast at ${fmt(m.kwhDay, 1)} kWh a day (${method === 'blend' ? `half your last 7 days, ${fmt(fc.rate.recent7, 1)}, half your past bills’ average, ${fmt(fc.rate.history, 1)}` : method === 'recent7' ? 'your last 7 days' : method === 'history' ? 'your past bills’ average' : 'your temperature pattern'}), × ${fmt(fc.price.price * 100, 2)}¢ per kWh (the all-in average of your last ${fc.price.n} bills, which includes fixed charges and taxes) = ${money(mid)}.` };
}

/** Why the app's estimate and Delmarva's projection may differ — computed differences first, then possibilities that are labelled as such. */
export function explainForecastGap(fc, proj) {
  if (!fc?.available || !proj) return null;
  const diff = fc.mid - proj.amount, lines = [], L = fc.days;
  lines.push({ kind: 'size', text: `${money(Math.abs(diff))} ${diff >= 0 ? 'above' : 'below'} Delmarva’s projection. In past bills the app’s forecast was typically about $${fmt(fc.backtest.summary[fc.method]?.mae ?? 0)} off, so ${Math.abs(diff) <= (fc.backtest.summary[fc.method]?.mae ?? Infinity) ? 'this gap is within the app’s normal error: the two forecasts agree.' : 'this gap is larger than the app’s normal error.'}` });
  lines.push({ kind: 'computed', text: `The period is ${L} days (${md(fc.period.start)}–${md(fc.period.end)}). Delmarva’s ${money(proj.amount)} is ${money(proj.amount / L)} a day; the app’s estimate is ${money(fc.mid / L)} a day (${fmt(fc.kwhDay, 1)} kWh × ${fmt(fc.cents, 2)}¢).` });
  if (proj.soFar != null) {
    const days = (proj.soFar * L) / proj.amount;
    lines.push({ kind: 'possible', text: `Possible: Delmarva’s figure equals its ${money(proj.soFar)} so far spread over the whole period if that spending covers ${fmt(days, 1)} days (${money(proj.soFar)} ÷ ${fmt(days, 1)} × ${L}). The screenshot doesn’t say how many days the ${money(proj.soFar)} covers, so this is a guess about Delmarva’s method, not a fact.` });
  }
  lines.push({ kind: 'computed', text: `The app’s readings end ${md(fc.readingsEnd)}: ${fc.measured} of ${L} days are measured, ${fc.remaining} are forecast.${fc.readingsAgeDays > 0 ? ` The newest reading is ${fc.readingsAgeDays} day${fc.readingsAgeDays === 1 ? '' : 's'} old.` : ''}` });
  lines.push({ kind: 'unknown', text: 'Not known: Delmarva’s own method, its current prices, the weather it assumes, and any charges the hourly export leaves out. Neither number is a final bill.' });
  return { diff: r2(diff), lines };
}

/** Utility projection and app estimate, each against the final bill — only once that bill exists. */
export function forecastAccuracy(state) {
  const bills = cleanBills(state.bills), rows = [];
  for (const p of cleanProjections(state.projections)) {
    const b = finalBillFor(p, bills);
    if (b) rows.push({ end: b.end, bill: b.amount, utility: p.amount, utilityErr: r2(p.amount - b.amount), app: p.app?.mid ?? null, appErr: p.app ? r2(p.app.mid - b.amount) : null, shownOn: p.shownOn || p.enteredAt });
  }
  return { rows, pending: cleanProjections(state.projections).filter((p) => !finalBillFor(p, bills)).length, text: rows.length ? '' : 'No projection has been compared with a final bill yet. The first check happens when the bill for the current period arrives.' };
}
