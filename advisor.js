// Turns state + data into decisions and plain-English findings. Pure functions; no DOM, no network.
import * as C from './core.js';

export const STATE_VERSION = 2;
const MIN_DAYS = 30;

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
  s.version = STATE_VERSION;
  return s;
}

/** Identifies a recommended weekly schedule, so the app knows whether the thermostat was programmed with it. */
export const planFingerprint = (plans) => JSON.stringify(plans.map((p) => [p.mode, ...['weekday', 'weekend'].map((k) => p[k].map((d) => [d.start, d.temp]))]));

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
    steps.push({ kind: 'menu', mode: pl.mode, title: `Open the ${sched.toLowerCase()}`, lines: ['Press MENU.', 'Highlight Programming with ▲/▼, then press the center button.', 'Make sure Time-based Programming is On.', `Highlight ${sched} and press the center button.`, 'Choose Weekdays/Weekends and press the center button.'] });
    for (const [group, day] of [['Mon–Fri', pl.weekday], ['Sat–Sun', pl.weekend]]) {
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
  const p = state.profile, out = [];
  const days = C.dailyTotals(state.usage).filter((d) => d.complete);
  if (!days.length) return out;
  const last = days[days.length - 1].date;
  const age = Math.floor((Date.parse(`${C.localParts(now).date}T12:00:00Z`) - Date.parse(`${last}T12:00:00Z`)) / 864e5);
  if (age > 14) out.push({ tone: 'warn', title: `Your electricity data is ${age} days old`, detail: `It ends ${dayName(last)}. Import a newer Delmarva file to keep these insights current.` });

  const m = C.energyWeatherModel(state.usage, temps, MIN_DAYS);
  const sig = (t) => t && Math.abs(t.per) > t.ci && t.per > 0;
  if (m.status !== 'ready') {
    out.push({ tone: 'info', title: 'Still learning how weather affects your use', detail: `${m.n} of ${MIN_DAYS} days have both electricity and observed weather. Findings about temperature appear after that — nothing is guessed before then.` });
  } else {
    if (sig(m.heat)) out.push({ tone: 'info', title: 'Your electricity use rises on colder days', detail: `About ${fmt(m.heat.per * 10, 1)} kWh more per day for every 10°F colder than 65°F (95% range ±${fmt(m.heat.ci * 10, 1)}), from ${m.n} days. Small heating setbacks are worth it here.` });
    if (sig(m.cool)) out.push({ tone: 'info', title: 'Your electricity use rises on hotter days', detail: `About ${fmt(m.cool.per * 10, 1)} kWh more per day for every 10°F hotter than 65°F (95% range ±${fmt(m.cool.ci * 10, 1)}), from ${m.n} days. A higher “away” cooling setting is worth it here.` });
    if (!sig(m.heat) && !sig(m.cool)) out.push({ tone: 'info', title: 'Outdoor temperature barely changes your electricity use', detail: `Across ${m.n} days, weather explains only ${fmt(Math.max(0, m.r2) * 100)}% of the day-to-day differences.${p.hvacMetered === 'yes' ? '' : ' Your heating and cooling may not be on your apartment’s meter — worth confirming with building management, because then thermostat changes won’t show on your bill.'}` });
    for (const d of unusualDays(m)) out.push({ tone: 'warn', title: `${dayName(d.date)} used more than usual`, detail: `${fmt(d.kwh, 1)} kWh vs. about ${fmt(d.expected, 1)} kWh expected for that day’s weather. Guests, laundry or cooking can explain one-off days.` });
  }

  const sv = savingsReport({ usage: state.usage, temps, tariff: p.tariff, hvacMetered: p.hvacMetered, history: state.programmedHistory, changeDate: p.changeDate });
  const w = sv.weather, from = sv.timeline.baselineEnd;
  if (sv.status === 'no_change_date') out.push({ tone: 'info', title: 'Savings tracking starts when you program the schedule', detail: 'Use the guided programming on Today; the app then compares your use with what the weather would predict.' });
  else if (sv.status === 'insufficient') out.push({ tone: 'info', title: 'Not enough data yet to tell whether the new schedule saves energy', detail: `Needs 14 days before and 7 after ${dayName(from)} with usage and weather (have ${sv.before ?? 0} and ${sv.after ?? 0}).` });
  else if (sv.status === 'likely_savings') out.push({ tone: 'good', title: 'Use is lower than the weather predicts since the schedule change', detail: `About ${fmt(w.diff)} kWh (${fmt(w.pct, 1)}%) less over ${w.days} days (95% range ±${fmt(w.unc)} kWh). Consistent with the new schedule helping, but not proof — other changes at home also count.` });
  else if (sv.status === 'likely_increase') out.push({ tone: 'warn', title: 'Use went up after the schedule change', detail: `About ${fmt(-w.diff)} kWh more than the weather predicts over ${w.days} days (±${fmt(w.unc)}). Other changes at home can cause this.` });
  else if (sv.status === 'inconclusive') out.push({ tone: 'info', title: 'No clear change since the new schedule', detail: `The difference (${fmt(w.diff)} kWh over ${w.days} days) is within normal variation (±${fmt(w.unc)}). More days will sharpen this.` });

  const sw = similarWeather(state.usage, temps);
  if (sw.status === 'ok' && sw.meaningful) out.push({ tone: sw.direction === 'lower' ? 'good' : 'warn', title: `Last ${sw.n} days: ${fmt(Math.abs(sw.pct))}% ${sw.direction} than similar-weather days`, detail: `${fmt(sw.actualAvg, 1)} kWh a day vs. ${fmt(sw.expectedAvg, 1)} on ${sw.matched} earlier ${sw.matched === 1 ? 'day' : 'days'} with outdoor temperatures within ${sw.tol}°F (same weekday/weekend mix). A comparison, not a cause.` });

  const s = C.usageSummary(state.usage, p.tariff);
  if (s?.baseLoad != null) out.push({ tone: 'info', title: `About ${fmt(s.baseLoad * 1000)} W is always on`, detail: `That’s roughly ${fmt(s.baseLoad * 24 * 30)} kWh a month from things that never switch off (fridge, router, standby electronics). Unplugging idle devices saves energy no thermostat can.` });
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

// ---------- personalized recommendations ----------

const minutesBetween = (a, b) => ((C.toMin(b) - C.toMin(a)) + 1440) % 1440;
const sigPos = (t) => t && t.per > t.ci && t.per > 0;

/**
 * Deterministic suggestions, each answering: what to change, why, what evidence, how confident, and whether it needs reprogramming.
 * Never goes outside the comfort limits or the heat-pump 2°F guard. `model` is energyWeatherModel(); `summary` is usageSummary().
 */
export function opportunities({ state, rec, model, summary }) {
  const p = state.profile, out = [];
  const plan = (m) => rec.plans.find((x) => x.mode === m);
  const unsureSeason = p.buildingMode === 'unknown';
  const meterNote = METER[p.hvacMetered] && p.hvacMetered !== 'yes' ? ` ${METER[p.hvacMetered]}` : '';
  const conf = (term) => {
    if (unsureSeason) return ['low', 'Your building’s heating/cooling season isn’t set, so this may not apply yet.'];
    if (model?.status === 'ready' && sigPos(term) && p.hvacMetered === 'yes') return ['high', 'Your own data shows use rising with the weather, and HVAC is on your meter.'];
    if (model?.status === 'ready' && sigPos(term)) return ['medium', 'Your own data shows use rising with the weather; whether HVAC is on your meter isn’t confirmed.'];
    return ['low', model?.status === 'ready' ? 'Your data doesn’t show a clear weather effect, so the benefit to your bill is uncertain.' : 'Based on general guidance; your own data isn’t sufficient yet.'];
  };
  const est = (term, deg, hours) => (model?.status === 'ready' && sigPos(term) ? term.per * deg * (hours / 24) * 30 : null);
  const evidence = (term, word) => (model?.status === 'ready' && sigPos(term)
    ? `In your data (${model.n} days), each 1°F ${word} outside adds about ${fmt(term.per, 2)} kWh a day.`
    : 'General guidance: each degree of setback held for about 8 hours saves roughly 1% of heating or cooling energy (U.S. Department of Energy).');
  const push = (o) => out.push({ reprogram: false, est: null, ...o });

  const heat = plan('heat');
  if (heat) {
    const sp = heat.setpoints, hp = p.hvacType === 'heat_pump' || p.hvacType === 'unknown';
    const lim = hp ? 2 : 6;
    const wd = p.routine.weekday;
    const awayH = wd.leave && wd.back ? minutesBetween(wd.leave, wd.back) / 60 : 0;
    const awayT = Math.max(p.comfort.min, sp.home - lim);
    if (awayH >= 4 && sp.away > awayT) {
      const [c, cw] = conf(model?.heat);
      const kwh = est(model?.heat, sp.away - awayT, awayH * 5 / 7);
      push({ id: 'heat-away', what: `Lower the weekday away heat to ${awayT}° (now ${sp.away}°)`, why: `Nobody is home for about ${fmt(awayH)} hours on weekdays, so the apartment needs less heat then.${hp ? ' Kept to 2°F below Home because larger heat-pump setbacks can trigger costlier auxiliary heat (Delmarva’s thermostat manual).' : ''}${meterNote}`, evidence: evidence(model?.heat, 'colder'), confidence: c, confidenceWhy: cw, reprogram: true, est: kwh, apply: { k: 'profile.comfort.heat.away', v: awayT, label: 'Away heating' } });
    }
    const sleepT = Math.max(p.comfort.min, sp.home - Math.min(lim, 4));
    const sleepH = minutesBetween(p.routine.weekday.sleep, p.routine.weekday.wake) / 60;
    if (sp.sleep > sleepT) {
      const [c, cw] = conf(model?.heat);
      push({ id: 'heat-sleep', what: `Lower the overnight heat to ${sleepT}° (now ${sp.sleep}°)`, why: `About ${fmt(sleepH)} hours asleep each night; many people sleep comfortably a few degrees cooler. Comfort comes first — skip this if you sleep cold.${meterNote}`, evidence: evidence(model?.heat, 'colder'), confidence: c, confidenceWhy: cw, reprogram: true, est: est(model?.heat, sp.sleep - sleepT, sleepH), apply: { k: 'profile.comfort.heat.sleep', v: sleepT, label: 'Sleep heating' } });
    }
  }
  const cool = plan('cool');
  if (cool) {
    const sp = cool.setpoints, wd = p.routine.weekday;
    const awayH = wd.leave && wd.back ? minutesBetween(wd.leave, wd.back) / 60 : 0;
    const awayT = Math.min(p.comfort.max, sp.home + 4);
    if (awayH >= 4 && sp.away < awayT) {
      const [c, cw] = conf(model?.cool);
      push({ id: 'cool-away', what: `Raise the weekday away cooling to ${awayT}° (now ${sp.away}°)`, why: `Nobody is home for about ${fmt(awayH)} hours on weekdays; the AC can rest and catch up before you’re back.${meterNote}`, evidence: evidence(model?.cool, 'hotter'), confidence: c, confidenceWhy: cw, reprogram: true, est: est(model?.cool, awayT - sp.away, awayH * 5 / 7), apply: { k: 'profile.comfort.cool.away', v: awayT, label: 'Away cooling' } });
    }
  }
  if (summary?.baseLoad != null && summary.baseLoad >= 0.25) {
    push({ id: 'base-load', what: 'Find devices that are always on', why: `About ${fmt(summary.baseLoad * 1000)} W runs around the clock — roughly ${fmt(summary.baseLoad * 24 * 30)} kWh a month. Old fridges, dehumidifiers, gaming consoles and set-top boxes are common culprits.`, evidence: `Your quietest hour averages ${fmt(summary.baseLoad, 2)} kWh across ${summary.days} days of hourly data.`, confidence: 'medium', confidenceWhy: 'Measured from your hourly data; which devices cause it isn’t visible to the app.' });
  }
  if (p.hvacMetered === 'unknown') {
    const hint = model?.status === 'ready' ? (sigPos(model.heat) || sigPos(model.cool) ? 'Your use does rise with outdoor temperature, which suggests at least part of heating or cooling is on your meter.' : 'Your use barely changes with outdoor temperature, which suggests the building may pay for heating and cooling.') : 'Your data isn’t sufficient yet to suggest an answer.';
    push({ id: 'meter', what: 'Ask building management whether heating and cooling run on your apartment’s meter', why: 'It decides whether thermostat changes can lower your Delmarva bill or only the building’s.', evidence: hint, confidence: 'info', confidenceWhy: '' });
  }
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  return out.sort((a, b) => order[a.confidence] - order[b.confidence] || (b.est || 0) - (a.est || 0));
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
