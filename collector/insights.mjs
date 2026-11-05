// Last validation gate for operator insights before they are published on the public site.
// The Worker validates too; this runs inside the public collector workflow so nothing unchecked is ever committed.
const BANNED = [
  /\$\s?\d|\d\s?(dollars|usd)\b|\bsav(e|es|ed|ing|ings)\b[^.]{0,40}\d/i, // money/savings figures
  /\d\s?kwh/i, // household kWh
  /\b(your|the) thermostat (is|reads|shows|currently|now)\b|\b(indoor|room) temperature (is|reads)\b/i, // live readings
  /\b(i|we|the app|the operator) (have |has |will )?(set|changed|adjusted|turned|sent|programmed)\b/i, // control claims
  /\bj2\b|\bjack\b|rewir|firmware|\bradio\b|\bwiring\b/i, // hardware
  /\byour (usage|bill|consumption|meter)\b|\byou used\b/i, // household data
  /https?:|<[a-z/]/i, // links or markup
];
const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isoOk = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** Returns { ok, value } with only known fields, or { ok: false, error }. */
export function checkInsights(text) {
  if (typeof text !== 'string' || text.length > 16000) return { ok: false, error: 'missing or too large' };
  let j;
  try { j = JSON.parse(text); } catch { return { ok: false, error: 'not JSON' }; }
  if (!j || !isoOk(j.generatedAt) || !Array.isArray(j.items) || j.items.length > 6) return { ok: false, error: 'bad envelope' };
  const items = [];
  for (const x of j.items) {
    if (!x || !/^[a-z0-9_]{1,40}$/.test(x.topic) || !str(x.title, 80) || !str(x.detail, 400) || !(x.action == null || str(x.action, 120))
      || !['info', 'good', 'warn'].includes(x.tone) || ![1, 2, 3].includes(x.priority) || !['operator', 'rules'].includes(x.source) || !isoOk(x.valid_until)) return { ok: false, error: `bad item ${x?.topic}` };
    const t = `${x.title} ${x.detail} ${x.action || ''}`;
    if (BANNED.some((re) => re.test(t))) return { ok: false, error: `unsupported claim in ${x.topic}` };
    items.push({ topic: x.topic, title: x.title, detail: x.detail, action: x.action ?? null, tone: x.tone, priority: x.priority, source: x.source, valid_until: x.valid_until });
  }
  const events = (Array.isArray(j.events) ? j.events : []).slice(0, 10)
    .filter((e) => e && /^[a-z_]{1,20}$/.test(e.type) && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && [1, 2].includes(e.severity))
    .map(({ type, date, severity }) => ({ type, date, severity }));
  const maintenance = str(j.maintenance, 200) && !BANNED.slice(6).some((re) => re.test(j.maintenance)) ? j.maintenance : null;
  return { ok: true, value: { generatedAt: j.generatedAt, items, events, maintenance } };
}
