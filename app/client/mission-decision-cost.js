import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';

const count = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
const number = (value) => count(value).toLocaleString('en-US');
const money = (value) => value > 0 && value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
const exactMoney = (value) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 9 })}`;

export function missionDecisionCostView(summary, { ready = true, failed = false } = {}) {
  if (failed || (ready && !summary)) return { value: 'Unavailable', state: 'unavailable',
    detail: 'Could not load Jev usage. Reopen this mission to retry.' };
  if (!ready) return { value: '…', state: 'loading', detail: 'Loading Jev usage for this mission.' };
  const usd = count(summary.costUsd);
  const pending = count(summary.pendingEvaluations);
  const uncertain = count(summary.uncertainEvaluations);
  const unpriced = count(summary.unpricedEvaluations);
  const incomplete = uncertain + unpriced > 0;
  const hasPrice = count(summary.pricedEvaluations) > 0;
  const value = incomplete && !hasPrice ? 'Unknown' : `${money(usd)}${incomplete ? '+' : ''}`;
  const notices = [];
  if (unpriced) notices.push(`${number(unpriced)} evaluation${unpriced === 1 ? '' : 's'} excluded: no verified price for the returned model.`);
  if (uncertain) notices.push(`${number(uncertain)} evaluation${uncertain === 1 ? '' : 's'} excluded: usage unconfirmed. Check TypeSafe billing.`);
  if (pending) notices.push(`${number(pending)} evaluation${pending === 1 ? '' : 's'} in progress; cost updates when usage arrives.`);
  return { value, state: incomplete ? 'partial' : pending ? 'pending' : 'ready',
    amount: incomplete && !hasPrice ? 'Unknown' : exactMoney(usd),
    evaluations: number(summary.evaluations), inputTokens: number(summary.inputTokens), outputTokens: number(summary.outputTokens), notices,
    note: incomplete ? 'Partial estimate' : pending ? 'Updating…' : '' };
}

/** Read-only, mission-scoped subscription; never infer spend from token reservations. */
export function initializeMissionDecisionCost({ root, settings, usage, mission,
  subscribe = (...args) => Meteor.subscribe(...args) }) {
  const tile = root.querySelector('[data-jev-cost-tile]');
  const value = root.querySelector('[data-jev-cost-value]');
  const note = root.querySelector('[data-jev-cost-note]');
  const detail = root.querySelector('[data-jev-cost-detail]');
  const message = detail.querySelector('[data-jev-cost-message]');
  const breakdown = detail.querySelector('[data-jev-cost-breakdown]');
  const changed = new Tracker.Dependency();
  let selection = {};
  let expanded = false;
  const toggle = () => {
    expanded = !expanded;
    tile.setAttribute('aria-expanded', String(expanded));
    detail.hidden = !expanded;
  };
  tile.addEventListener('click', toggle);
  const subscriptionComputation = Tracker.autorun(() => {
    const missionId = mission();
    // Pausing evaluations must not hide costs already incurred.
    const connected = settings.findOne({}, { fields: { providerConfigured: 1 } })?.providerConfigured === true;
    if (selection.missionId === missionId && selection.connected === connected) return;
    selection.handle?.stop();
    const next = { missionId, connected, failed: false, handle: null };
    selection = next;
    expanded = false;
    // Own this subscription by its key, not by unrelated invalidations of the
    // mission/settings computations. Meteor's automatic cleanup is disabled.
    if (connected && missionId) next.handle = Tracker.nonreactive(() => subscribe('constellation.decisions.missionUsage', missionId, {
      onError() { next.failed = true; if (selection === next) changed.changed(); },
    }));
    changed.changed();
  });
  const renderComputation = Tracker.autorun(() => {
    changed.depend();
    const { missionId, connected, handle, failed } = selection;
    const visible = connected && !!missionId;
    tile.hidden = !visible;
    detail.hidden = !visible || !expanded;
    tile.setAttribute('aria-expanded', String(expanded));
    if (!visible) return;
    const view = missionDecisionCostView(usage.findOne(missionId), { ready: handle?.ready() === true, failed });
    value.textContent = view.value;
    tile.dataset.state = view.state;
    tile.setAttribute('aria-label', `Jev cost estimate: ${view.value}${view.note ? `, ${view.note}` : ''}. View cost details`);
    note.textContent = view.note ?? '';
    note.hidden = !view.note;
    message.hidden = !view.detail;
    message.textContent = view.detail ?? '';
    breakdown.hidden = !!view.detail;
    if (!view.detail) {
      detail.querySelector('[data-jev-cost-amount]').textContent = view.amount;
      detail.querySelector('[data-jev-cost-currency]').hidden = view.amount === 'Unknown';
      detail.querySelector('[data-jev-evaluations]').textContent = view.evaluations;
      detail.querySelector('[data-jev-input]').textContent = view.inputTokens;
      detail.querySelector('[data-jev-output]').textContent = view.outputTokens;
      const notices = detail.querySelector('[data-jev-cost-notices]');
      notices.hidden = !view.notices.length;
      notices.replaceChildren(...view.notices.map((text) => {
        const item = detail.ownerDocument.createElement('li');
        item.textContent = text;
        return item;
      }));
    }
    tile.setAttribute('aria-busy', String(view.state === 'loading' || view.state === 'pending'));
  });
  return { dispose() { subscriptionComputation.stop(); renderComputation.stop(); selection.handle?.stop(); tile.removeEventListener('click', toggle); } };
}
