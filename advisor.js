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
  if (!state.profile.setupDone) return { kind: 'setup' };
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
  return { level, n, from: all[0].date, to: last, readings, age, total, perDay, facts, findings, comparisons, cannot, hd, prof, night, peak, spikes, change, week, weather, patterns: shown, allPatterns: patterns };
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

  const heat = plan('heat');
  if (heat && shows('hdd')) {
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
  if (cool && shows('cdd')) {
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
  const at = report?.night ? awayTests({ state, temps: {}, hd: report.hd || [], report }) : null;
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
    days_above_usual: ex.filter((x) => x.extra > 0.1 * base).length, start_detected: k0 !== all.length - days,
    // Steady vs. bursty: did the quietest hour of the busiest-changing window rise (a sustained draw) or mainly its peak hour?
    sustained_rise_watts: r0(winStat(recent, blocks[largest[0]], Math.min) - winStat(before, blocks[largest[0]], Math.min)),
    peak_rise_watts: r0(winStat(recent, blocks[largest[0]], Math.max) - winStat(before, blocks[largest[0]], Math.max)),
    daytime_floor_rise_watts: r0(winStat(recent, [8, 22], Math.min) - winStat(before, [8, 22], Math.min)),
    floor_change_watts: r0(floor(recent) - floor(before)),
  };
}

// ---------- the catalog: explanation → what it predicts → verdict ----------
const V = (ok, no, why) => ({ verdict: ok ? 'supported' : no ? 'ruled out' : 'not yet clear', why });
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
    const colder = dT <= -3 && t.recent_temp_f < 62, hotter = dT >= 3 && t.recent_temp_f > 70, sustained = t.sustained_rise_watts >= 150 || t.daytime_floor_rise_watts >= 150;
    const daytime = ['midday (12–17)', 'morning (6–12)'].includes(t.largest_change);
    return [
      { id: 'heating', title: colder || !hotter ? 'Heating running more (season change or settings)' : 'Cooling running more', ...V((colder || hotter) && (sustained || coldDriven(t)), Math.abs(dT) < 1.5 && !sustained && !coldDriven(t), `Outside ${t.recent_temp_f}°F vs ${t.before_temp_f}°F before; the quietest hour of the ${t.largest_change} window rose ${t.sustained_rise_watts} W and the daytime floor ${t.daytime_floor_rise_watts} W — ${sustained ? 'a steady extra draw, the way heating or cooling cycles' : 'not a steady extra draw'}.`),
        action: colder || !hotter ? 'Check the temperature the thermostat holds while you’re home: if it’s above your comfortable minimum, try 1–2°F lower. Make sure it isn’t on HOLD, and don’t run a plug-in heater alongside central heat.' : 'Check the cooling setting while you’re home; 1–2°F warmer and closed blinds on sunny windows cut cooling time.', check: 'Is warm air coming from the vents through the afternoon? Is a space heater on?', thermostat: true },
      { id: 'home', title: 'More time at home than usual', ...V(false, !daytime || win < 100, daytime ? 'A daytime increase fits more time at home — but just as well heating or appliances, so the readings alone can’t confirm it.' : `The change is mostly ${t.largest_change}, not daytime.`),
        action: 'If people are home more, the extra is mostly normal use; heat or cool only the rooms in use.', check: 'Has anyone been home more than usual?', thermostat: false },
      { id: 'bursts', title: 'Short bursts of appliance use (cooking, laundry, a kettle or hair dryer)', ...V(t.peak_rise_watts >= 2 * Math.max(1, t.sustained_rise_watts) && t.sustained_rise_watts < 100, t.sustained_rise_watts >= 0.6 * Math.max(1, win), `Peak hour rose ${t.peak_rise_watts} W vs ${t.sustained_rise_watts} W for the quietest hour of that window — ${t.sustained_rise_watts >= 0.6 * Math.max(1, win) ? 'the whole level moved up, not just the peaks' : 'mostly the peaks'}.`),
        action: 'Full loads, cold-water washing, air-drying and lids on pots cut appliance bursts.', check: 'Have you been cooking or doing laundry more than usual?', thermostat: false },
      { id: 'device', title: 'Something new runs all the time', ...V(t.floor_change_watts >= 100 && !(dT <= -3), t.floor_change_watts < 40, `Quietest-hour floor changed by ${t.floor_change_watts} W${t.floor_change_watts >= 100 && dT <= -3 ? ' — but it also got colder, which can raise the floor' : ''}.`),
        action: `Look for something new that stays on — a dehumidifier, aquarium or second fridge; about ${t.floor_change_watts} W extra around the clock.`, check: 'What was plugged in around the start of the rise?', thermostat: false },
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
  return { kind, tests, hypotheses: CATALOG[kind](tests) };
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
  const r = inp.report;
  if (r.change?.diff > 0) return r.change.diff;
  const sw = similarWeather(inp.state.usage, inp.temps || {});
  return sw.status === 'ok' && sw.meaningful && sw.direction === 'higher' ? sw.actualAvg - sw.expectedAvg : 0;
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
    effect: { home: { lots: 2, little: 1, no: -2 }, occupied: { lots: 2, little: 1, no: -2 } },
  },
  heat_on: {
    kinds: ['change', 'overnight', 'evening', 'standby', 'thermostat'], scope: 'home',
    text: () => 'Has your building switched from cooling to heating?',
    why: 'If the heat came on recently, colder days explain part of the change, and the heating schedule becomes the lever.',
    options: [['yes', 'Yes, the heat is on'], ['no', 'No, not yet'], ['unknown', 'I’m not sure']],
    effect: { heating: { yes: 1, no: -2 } },
    known: (s) => (s.profile.setupDone && s.profile.buildingMode === 'heat_available' ? 'yes' : s.profile.setupDone && s.profile.buildingMode === 'cool_available' ? 'no' : null),
  },
  new_appliance: {
    kinds: ['change', 'standby', 'overnight'],
    text: (v) => `Did you start using a space heater, dehumidifier or another plug-in appliance around ${md(v.since)}?`,
    why: 'Something new that stays on raises use at every hour, including overnight; the readings can show that pattern but not which device it is.',
    options: [['yes', 'Yes'], ['no', 'No'], ['unknown', 'I’m not sure']],
    effect: { device: { yes: 2, no: -1 }, new: { yes: 2, no: -1 }, devices: { yes: 1 } },
  },
  space_heater: {
    kinds: ['change'],
    text: (v) => `Have you been running a plug-in space heater since about ${md(v.since)}?`,
    why: 'A space heater draws 1,000–1,500 W while on — a steady extra load that looks like heating in the readings.',
    options: [['yes', 'Yes'], ['no', 'No'], ['unknown', 'I’m not sure']],
    effect: { heating: { yes: 2 } },
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
    why: 'A warmer setting or a HOLD raises heating use without anyone noticing.',
    options: [['warmer', 'Yes, warmer or on HOLD'], ['cooler', 'Yes, cooler'], ['no', 'No'], ['unknown', 'Not sure']],
    effect: { heating: { warmer: 1, cooler: -1 } },
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
  likely: 'Likely', fits: 'Fits the readings', possible: 'Possible', open: 'Not yet clear', unlikely: 'Unlikely', out: 'Ruled out by the readings', conflict: 'Your answer and the readings disagree',
};
/** Combine the readings' verdict with the user's answers. Answers shift likelihood; they never turn a measured "ruled out" into "likely". */
function statusOf(h, score) {
  const t = h.verdict === 'supported' ? 2 : h.verdict === 'ruled out' ? -2 : 0;
  if (t === -2 && score > 0) return 'conflict';
  if (t === 2 && score < 0) return 'conflict';
  if (t === -2) return 'out';
  const total = t + score;
  return total >= 3 || (t === 0 && score >= 2) ? 'likely' : t === 2 && score === 0 ? 'fits' : total >= 1 ? 'possible' : total <= -1 ? 'unlikely' : 'open';
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
    known.push(`Outside it averaged ${fmt(t.recent_temp_f)}°F, vs ${fmt(t.before_temp_f)}°F before. ${t.days_above_usual} of ${t.recent_days} days were above your usual.`);
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
    (h.verdict === 'supported' ? forE : h.verdict === 'ruled out' ? againstE : forE).push(`Readings: ${h.why}`);
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
    return { ...h, score, status, label: STATUS[status], for: forE, against: againstE, answers };
  });

  // Next question: the unanswered one most able to change a conclusion.
  const weight = { fits: 3, possible: 2, open: 2, conflict: 2, likely: 1, unlikely: 1, out: 0 }; // confirming the leading explanation first
  let question = null, best = 0;
  for (const [qid, q] of qs) {
    if (answerFor(state, qid, key)) continue;
    let w = Object.keys(q.effect).reduce((sum0, hid) => sum0 + (weight[hyps.find((x) => x.id === hid)?.status] ?? 0), 0);
    if (qid === 'hvac_meter' && hyps.some((x) => x.thermostat && x.status !== 'out')) w = 1.5;
    if (w > best) { best = w; question = { id: qid, text: q.text(v), why: q.why, options: q.options }; }
  }

  // Recommendation from the leading explanation; thermostat advice only if HVAC is on this meter.
  const order = { likely: 0, fits: 1, possible: 2, conflict: 3, open: 4, unlikely: 5, out: 6 };
  const ranked = [...hyps].filter((h) => h.status !== 'out' && h.status !== 'unlikely').sort((a, b) => order[a.status] - order[b.status] || b.score - a.score);
  const metered = state.profile.hvacMetered;
  const lead = ranked.find((h) => !(h.thermostat && metered === 'no')) || null;
  const recommendation = lead ? recommend(pr.priority, lead, t, r, state, metered, o, ranked) : null;
  const settled = hyps.filter((h) => h.status === 'likely'), fit = hyps.filter((h) => h.status === 'fits');
  const conflictNote = hyps.some((h) => h.status === 'conflict') ? ' One of your answers disagrees with the readings — worth a second look.' : '';
  const conclusion = settled.length ? `Most likely: ${settled.map((h) => h.title.toLowerCase()).join(' and ')}.${conflictNote}`
    : fit.length ? `Best fit with the readings so far: ${fit.map((h) => h.title.toLowerCase()).join(' and ')} — not confirmed yet.${conflictNote}`
      : `No explanation is settled yet.${conflictNote}`;
  const answered = qs.map(([qid, q]) => ({ qid, q, a: answerFor(state, qid, key) })).filter((x) => x.a).map(({ qid, q, a }) => ({ q: qid, text: q.text(v), value: a.value, label: optLabel(qid, a.value), source: a.source, at: a.at || null, corrected: (a.history || 1) > 1 }));
  return { key, kind: pr.priority, title: PRIORITIES[pr.priority], headline, known, attribution, tests: t, hypotheses: hyps, question, answered, conclusion, recommendation, since: v.since };
}

function recommend(kind, h, t, r, state, metered, ops, ranked = []) {
  const rate = C.energyCost(1, state.profile.tariff), money = (k) => (rate != null ? ` (≈ $${fmt(k * rate, 2)})` : '');
  const out = { hypothesis: h.id, title: h.action, problem: '', expected: '', verify: '', hours: null, note: '' };
  const thermoNote = h.thermostat && metered !== 'yes' ? (metered === 'unknown' ? ' Whether this lowers your bill depends on heating and cooling being on your meter (not confirmed yet).' : metered === 'partial' ? ' Only the fan is on your meter, so most of the heating saving goes to the building.' : '') : '';
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
