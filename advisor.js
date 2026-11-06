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
  }
  facts.push({ v: `${fmt(total, total < 100 ? 1 : 0)} kWh`, l: `used in ${n} full day${n === 1 ? '' : 's'}` });
  facts.push({ v: `${fmt(perDay, 1)} kWh`, l: 'a day on average' });
  if (peak) facts.push({ v: `${hr(peak.start)}–${hr(peak.end)}`, l: 'busiest hours' });
  if (night) facts.push({ v: `${fmt(night.w)} W`, l: 'overnight draw (1–5 AM)' });
  const early = (k) => (k < 14 ? ` Early observation from ${k} day${k === 1 ? '' : 's'}.` : '');
  if (peak) {
    const homeEve = p.routine?.weekday?.back && C.toMin(p.routine.weekday.back) <= peak.start * 60 + 60;
    add({ key: 'peak', title: `Your busiest hours are ${hr(peak.start)}–${hr(peak.end)}`, detail: `${fmt(peak.share * 100)}% of a typical day’s electricity (about ${fmt(peak.kwh, 1)} kWh) is used in those three hours${homeEve ? ', when you’re usually home — cooking, lights, laundry and heating or cooling add up' : ''}.${early(hd.length)}`, prelim: hd.length < 14 });
  }
  if (night) {
    const month = (night.base / 1000) * 24 * 30;
    add({ key: 'overnight', title: `Overnight your home draws about ${fmt(night.w)} W`, detail: `That’s what keeps running while you sleep. ${night.steady ? 'It stays steady through the night, which points to always-on devices (fridge, router, standby electronics) rather than something cycling.' : `It rises and falls during the night (lowest hour ${fmt(night.base)} W), which points to something that cycles — heating or cooling, a fridge or a dehumidifier.`} Use ${night.eve > night.w ? `drops ${fmt((1 - night.w / night.eve) * 100)}% from the evening (${fmt(night.eve)} W)` : 'is about the same as in the evening'}. The always-on part alone is about ${fmt(month)} kWh a month${kwhMoney(month)}.${early(night.nights)}`, prelim: night.nights < 7 });
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
    if (weather.heat) add({ key: 'weather', title: pre ? 'Early sign: your use rises on colder days' : 'Your electricity use rises on colder days', detail: `About ${fmt(heat.per * 10, 1)} kWh more a day for every 10°F colder than 65°F (±${fmt(1.96 * heat.se * 10, 1)}), from ${k} days between ${fmt(tl)}°F and ${fmt(th)}°F. Weather explains ${fmt(Math.max(0, fit.r2) * 100)}% of your day-to-day differences, so heating settings matter here.${note}`, prelim: pre });
    if (weather.cool) add({ key: 'weather', title: pre ? 'Early sign: your use rises on hotter days' : 'Your electricity use rises on hotter days', detail: `About ${fmt(cool.per * 10, 1)} kWh more a day for every 10°F hotter than 65°F (±${fmt(1.96 * cool.se * 10, 1)}), from ${k} days between ${fmt(tl)}°F and ${fmt(th)}°F. Cooling settings matter here.${note}`, prelim: pre });
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
      const over = mt ? d.kwh - expected > Math.max(2.5 * fit.se, 0.25 * expected) : d.kwh - med > Math.max(3.5 * mad, 0.4 * med);
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
    for (const d of days) (byM[d.date.slice(0, 7)] ||= []).push(d.kwh);
    const months = Object.entries(byM).filter(([, v]) => v.length >= 20).map(([m, v]) => ({ m, avg: avg(v) }));
    if (months.length >= 2) {
      const hi = months.reduce((a, x) => (x.avg > a.avg ? x : a)), lo = months.reduce((a, x) => (x.avg < a.avg ? x : a));
      const mname = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      if (hi.avg > 1.15 * lo.avg) add({ key: 'season', title: `${mname(hi.m)} was your heaviest month`, detail: `${fmt(hi.avg, 1)} kWh a day vs. ${fmt(lo.avg, 1)} in ${mname(lo.m)}, your lightest — ${fmt((hi.avg / lo.avg - 1) * 100)}% more.${weather?.heat || weather?.cool ? ' The weather relationship above explains much of that.' : ''}` });
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
    const lim = hp ? 2 : 6, wd = p.routine.weekday;
    const awayH = wd.leave && wd.back ? minutesBetween(wd.leave, wd.back) / 60 : 0;
    const awayT = Math.max(p.comfort.min, sp.home - lim);
    if (awayH >= 4 && sp.away > awayT) {
      const [c, cw] = conf('hdd');
      push({ id: 'heat-away', what: `Lower the weekday away heat to ${awayT}° (now ${sp.away}°)`, why: `Nobody is home for about ${fmt(awayH)} hours on weekdays, and your use climbs on cold days, so heat while you’re out costs you.${hp ? ' Kept to 2°F below Home because larger heat-pump setbacks can trigger costlier auxiliary heat (Delmarva’s thermostat manual).' : ''}${meterNote}`, evidence: evidence('hdd', 'colder'), confidence: c, confidenceWhy: cw, reprogram: true, est: est('hdd', sp.away - awayT, awayH * 5 / 7), apply: { k: 'profile.comfort.heat.away', v: awayT, label: 'Away heating' } });
    }
    const sleepT = Math.max(p.comfort.min, sp.home - Math.min(lim, 4));
    const sleepH = minutesBetween(wd.sleep, wd.wake) / 60;
    if (sp.sleep > sleepT) {
      const [c, cw] = conf('hdd');
      push({ id: 'heat-sleep', what: `Lower the overnight heat to ${sleepT}° (now ${sp.sleep}°)`, why: `About ${fmt(sleepH)} hours asleep each night; many people sleep comfortably a few degrees cooler. Comfort comes first — skip this if you sleep cold.${meterNote}`, evidence: evidence('hdd', 'colder'), confidence: c, confidenceWhy: cw, reprogram: true, est: est('hdd', sp.sleep - sleepT, sleepH), apply: { k: 'profile.comfort.heat.sleep', v: sleepT, label: 'Sleep heating' } });
    }
  }
  const cool = plan('cool');
  if (cool && shows('cdd')) {
    const sp = cool.setpoints, wd = p.routine.weekday;
    const awayH = wd.leave && wd.back ? minutesBetween(wd.leave, wd.back) / 60 : 0;
    const awayT = Math.min(p.comfort.max, sp.home + 4);
    if (awayH >= 4 && sp.away < awayT) {
      const [c, cw] = conf('cdd');
      push({ id: 'cool-away', what: `Raise the weekday away cooling to ${awayT}° (now ${sp.away}°)`, why: `Nobody is home for about ${fmt(awayH)} hours on weekdays and your use climbs on hot days; the AC can rest and catch up before you’re back.${meterNote}`, evidence: evidence('cdd', 'hotter'), confidence: c, confidenceWhy: cw, reprogram: true, est: est('cdd', awayT - sp.away, awayH * 5 / 7), apply: { k: 'profile.comfort.cool.away', v: awayT, label: 'Away cooling' } });
    }
  }

  // Use that doesn't drop while nobody is home on weekdays.
  const wd = p.routine.weekday;
  const wdays = (report?.hd || []).filter((d) => !C.isWeekendDate(d.date));
  if (wd.leave && wd.back && wdays.length >= 3 && report?.night) {
    const l = Math.ceil(C.toMin(wd.leave) / 60) + 1, b = Math.floor(C.toMin(wd.back) / 60), s = Math.min(23, Math.floor(C.toMin(wd.sleep) / 60));
    const hrsAway = Array.from({ length: Math.max(0, b - l) }, (_, i) => l + i), hrsEve = Array.from({ length: Math.max(0, s - b) }, (_, i) => b + i);
    if (hrsAway.length >= 3 && hrsEve.length >= 2) {
      const w = (hs) => avg(wdays.flatMap((d) => hs.map((h) => d.h[h]))) * 1000;
      const awayW = w(hrsAway), eveW = w(hrsEve), baseW = report.night.base;
      if (awayW >= 0.85 * eveW && awayW - baseW >= 150) { // the overnight floor can include heating, so compare with evenings first
        const extra = ((awayW - baseW) / 1000) * hrsAway.length * 21.7;
        push({ id: 'away-high', what: 'Check that the thermostat really eases off while you’re out', why: `Nobody should be home ${fmt(hrsAway.length)} hours on weekdays, yet use stays near evening levels. If heating or cooling runs as if you were home, the schedule isn’t taking effect — a HOLD on the thermostat is the usual cause.${meterNote}`, evidence: `Weekdays ${hr(l)}–${hr(b)}: about ${fmt(awayW)} W, vs. ${fmt(eveW)} W in the evening and ${fmt(baseW)} W at the quietest hour (${wdays.length} weekdays of hourly data).`, investigate: 'At midday, look at the thermostat: if it says HOLD AT, press RUN. Then compare the away temperature with the schedule on Today. Something else left running (a space heater, dehumidifier) shows the same pattern.', impact: `If daytime use fell to the overnight level, about ${fmt(extra)} kWh a month${money(extra)}.`, confidence: p.hvacMetered === 'no' ? 'low' : 'medium', confidenceWhy: 'Measured from your hourly data; the meter can’t show which device is running.', reprogram: true, thermostat: 'Check the thermostat (no reprogramming if the schedule is already set)' });
      }
    }
  }
  // Always-on load.
  if (report?.night && report.night.base >= 200) {
    const b = report.night.base, month = (b / 1000) * 24 * 30;
    push({ id: 'standby', what: 'Cut always-on power', why: `About ${fmt(b)} W runs even in your quietest hour — ${fmt(month)} kWh a month, ${fmt((month / 30 / report.perDay) * 100)}% of your use. Many apartments idle at 100–200 W.`, evidence: `Quietest hourly average across ${report.night.nights} day${report.night.nights === 1 ? '' : 's'} of hourly readings.`, investigate: 'Before bed, switch off or unplug what doesn’t need to run overnight (TV boxes, game consoles, chargers, a second fridge or dehumidifier). After a week, import a new file: the 1–5 AM readings show whether it dropped.', impact: `Every 50 W switched off saves about 36 kWh a month${money(36)}.`, confidence: report.night.nights >= 7 ? 'high' : 'medium', confidenceWhy: report.night.nights >= 7 ? 'Consistent across a week or more of nights.' : 'From only a few nights so far.', thermostat: p.hvacMetered !== 'no' && !report.night.steady ? 'No reprogramming needed (if heating or cooling cycles overnight, the overnight setting also counts)' : null });
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
  if (report.night) why.push(`always-on use is a modest ${fmt(report.night.base)} W`);
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
