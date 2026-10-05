// What the Mission health panel says, worked out apart from the page that says it.
//
// A Mission has three alerts, set in its settings: turns, tool calls and model spend. Each gets a meter of its own,
// coloured by how near that alert is, so the panel answers "which one?" as well as "how close?". The Mission's one
// state line names the alert that is nearest when one is near.

/** From this share of an alert on, a meter says so. */
export const NEAR = 0.8;
/** The least a meter shows once anything is used. */
const MIN_FILL = 0.015;

const ALERTS = Object.freeze([
  { key: 'turns', label: 'Turns', name: 'turn' },
  { key: 'toolCalls', label: 'Tool calls', name: 'tool-call' },
  { key: 'spend', label: 'Model spend', name: 'spend' },
]);

const money = (value) => `$${Number(value).toFixed(2)}`;

/** 1234 as "1.2k"; small numbers as they are. */
export const compactCount = (value) => (value > 999 ? `${(value / 1000).toFixed(1)}k` : String(value));

/** An alert set to nothing is reached by anything at all. */
const shareOf = (used, alert) => (alert > 0 ? used / alert : (used > 0 ? 1 : 0));

/**
 * One meter for each alert, in the order they are shown.
 * `level` is `ok`, `near` (from 80% of the alert) or `reached`.
 */
export function missionMeters(usage, spent, thresholds) {
  const used = {
    turns: Number(spent?.turns ?? 0),
    toolCalls: Number(spent?.toolCalls ?? 0),
    spend: Number(usage?.cost ?? 0),
  };
  return ALERTS.map(({ key, label, name }) => {
    const alert = Number(thresholds?.[key] ?? 0);
    const share = shareOf(used[key], alert);
    const show = key === 'spend' ? money : String;
    return {
      key,
      label,
      name,
      used: used[key],
      alert,
      share,
      // What the bar shows. Past its alert a meter is full, not wider than its track; and anything used at all
      // shows as something, where one cent of five dollars would otherwise be half a pixel.
      fill: used[key] > 0 ? Math.min(1, Math.max(MIN_FILL, share)) : 0,
      level: share >= 1 ? 'reached' : (share >= NEAR ? 'near' : 'ok'),
      usedText: show(used[key]),
      alertText: show(alert),
    };
  });
}

/** Tokens have no alert: a total, and where it went once there is any. */
export function tokenTotals(usage) {
  const input = Number(usage?.input ?? 0);
  const output = Number(usage?.output ?? 0);
  return {
    total: compactCount(input + output),
    split: input + output > 0 ? `${compactCount(input)} in · ${compactCount(output)} out` : '',
  };
}

/**
 * The Mission's state in a word or two, a key for its colour, and `detail`: the same said in full, for a tooltip
 * and for a screen reader. What stops a Mission comes first, then what needs somebody, then what is merely
 * happening.
 *
 * The label stays short enough to sit beside the panel's heading. When an alert is near or reached it does not
 * say which: the meter of that alert is in the same colour, right underneath. `detail` does say.
 */
export function missionHealthState({ status, archived, runtime, phase, busy, meters }) {
  const state = (key, label, detail = label) => ({ key, label, detail });
  if (status === 'completed') return archived ? state('archived', 'Archived') : state('completed', 'Completed');
  if (status === 'paused') return state('paused', 'Paused');
  if (runtime === 'error') return state('attention', 'Needs attention');
  // The nearest alert speaks for the Mission; of two equally near, the one shown first.
  const nearest = [...(meters ?? [])].sort((a, b) => b.share - a.share)[0];
  const reading = nearest ? `${nearest.usedText} of ${nearest.alertText}` : '';
  if (nearest?.level === 'reached') return state('reached', 'Alert reached', `${capitalized(nearest.name)} alert reached: ${reading}`);
  if (nearest?.level === 'near') return state('near', 'Nearing alert', `Nearing the ${nearest.name} alert: ${reading}`);
  if (phase === 'awaiting') return state('awaiting', 'Awaiting you');
  if (runtime === 'stopped') return state('stopped', 'Stopped');
  return busy ? state('active', 'Active') : state('nominal', 'Nominal');
}

const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);
