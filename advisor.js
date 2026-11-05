// Turns state + data into decisions and plain-English findings. Pure functions; no DOM, no network.
import * as C from './core.js';

export const STATE_VERSION = 2;
const MIN_DAYS = 30;

/** Load any saved/backup state (v1 or v2) without losing settings, usage, readings or temperatures. */
export function migrate(raw) {
  const s = C.mergeState(raw);
  const p = raw && typeof raw === 'object' ? raw.programmed : null;
  s.programmed = p && typeof p.fingerprint === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? { fingerprint: p.fingerprint.slice(0, 4000), date: p.date } : null;
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

  const sv = C.evaluateSavings({ usage: state.usage, temps, changeDate: p.changeDate, tariff: p.tariff });
  if (sv.status === 'no_change_date') out.push({ tone: 'info', title: 'Savings tracking starts when you program the schedule', detail: 'Use the guided programming on Today; the app then compares your use with what the weather would predict.' });
  else if (sv.status === 'insufficient') out.push({ tone: 'info', title: 'Not enough data yet to tell whether the new schedule saves energy', detail: `Needs 14 days before and 7 after ${dayName(p.changeDate)} with usage and weather (have ${sv.before ?? 0} and ${sv.after ?? 0}).` });
  else if (sv.status === 'likely_savings') out.push({ tone: 'good', title: 'The new schedule appears to be saving energy', detail: `About ${fmt(sv.diff)} kWh (${fmt(sv.pct, 1)}%) less than the weather predicts over ${sv.after} days (95% range ±${fmt(sv.unc)} kWh). A weather-adjusted estimate, not proof.` });
  else if (sv.status === 'likely_increase') out.push({ tone: 'warn', title: 'Use went up after the schedule change', detail: `About ${fmt(-sv.diff)} kWh more than the weather predicts over ${sv.after} days (±${fmt(sv.unc)}). Other changes at home can cause this.` });
  else if (sv.status === 'inconclusive') out.push({ tone: 'info', title: 'No clear change since the new schedule', detail: `The difference (${fmt(sv.diff)} kWh over ${sv.after} days) is within normal variation (±${fmt(sv.unc)}). More days will sharpen this.` });

  const s = C.usageSummary(state.usage, p.tariff);
  if (s?.baseLoad != null) out.push({ tone: 'info', title: `About ${fmt(s.baseLoad * 1000)} W is always on`, detail: `That’s roughly ${fmt(s.baseLoad * 24 * 30)} kWh a month from things that never switch off (fridge, router, standby electronics). Unplugging idle devices saves energy no thermostat can.` });
  return out;
}
