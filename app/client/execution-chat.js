import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { setChatTimelineSource } from './chat-timeline';
import { createExecutionChatCard } from './execution-chat-card';

const active = new Set(['queued', 'preparing', 'running', 'stopping']);
const time = (value) => { const result = new Date(value ?? NaN).getTime(); return Number.isFinite(result) ? result : null; };

/** Live receipts only: this surface never schedules or replays code. */
export function initializeExecutionChat(host) {
  const cards = new Map();
  const changed = new Tracker.Dependency();
  const subscribe = host.subscribe ?? ((...args) => Meteor.subscribe(...args));
  const connection = host.connectionStatus ?? (() => Meteor.status());
  const now = host.now ?? Date.now;
  const startTimer = host.setInterval ?? globalThis.setInterval.bind(globalThis);
  const stopTimer = host.clearInterval ?? globalThis.clearInterval.bind(globalThis);
  const makeCard = host.createCard ?? createExecutionChatCard;
  let missionId = null; let subscription = null; let subscriptionFailed = false;
  let disposed = false; let generation = 0; let timer = null; let signature = '';
  let transport = 'loading';

  function syncTimeline() {
    const items = [...cards.values()].sort((a, b) => (time(a.job.createdAt) ?? 0) - (time(b.job.createdAt) ?? 0))
      .map((entry) => ({ id: `code-run-${entry.job._id}`, createdAt: entry.job.createdAt, element: entry.card.element }));
    const next = JSON.stringify(items.map((item) => [item.id, time(item.createdAt)]));
    if (next === signature) return;
    signature = next; setChatTimelineSource(host.chat, 'code', items);
  }
  function update(entry) {
    const job = entry.job;
    const start = time(job.createdAt) ?? time(job.startedAt);
    if (!active.has(job.status)) {
      const end = time(job.completedAt);
      entry.elapsedMs = start !== null && end !== null ? Math.max(0, end - start) : null;
    } else if (transport === 'connected' && start !== null) entry.elapsedMs = Math.max(0, now() - start);
    entry.card.update({ ...job, agentDisplayName: host.agentName?.(job.agent) ?? job.agent,
      connectionState: transport, elapsedMs: entry.elapsedMs, stopping: entry.stopPending,
      actionError: entry.actionError });
  }
  function syncClock() {
    const needed = transport === 'connected' && [...cards.values()].some((entry) => active.has(entry.job.status));
    if (needed && timer === null) timer = startTimer(() => {
      if (!disposed) for (const entry of cards.values()) if (active.has(entry.job.status)) update(entry);
    }, 1000);
    if (!needed && timer !== null) { stopTimer(timer); timer = null; }
  }
  function clearCards() {
    for (const entry of cards.values()) entry.card.dispose();
    cards.clear(); signature = ''; setChatTimelineSource(host.chat, 'code', []);
    if (timer !== null) { stopTimer(timer); timer = null; }
  }
  function create(job) {
    const scope = missionId; const openedGeneration = generation;
    const entry = { job, elapsedMs: null, stopPending: false, actionError: '', card: null };
    const current = () => !disposed && generation === openedGeneration && missionId === scope && cards.get(job._id) === entry;
    entry.card = makeCard({
      onView: () => { if (current()) host.openRun?.(job._id, scope); },
      onStop: async () => {
        if (!current() || transport !== 'connected' || !active.has(entry.job.status) || entry.stopPending || entry.job.status === 'stopping') return;
        entry.stopPending = true; entry.actionError = ''; update(entry);
        try {
          await (host.stopRun ? host.stopRun(job._id) : Meteor.callAsync('constellation.execution.stop', { jobId: job._id }));
        } catch {
          if (current()) entry.actionError = 'Could not confirm the stop. Open the run to check its status.';
        } finally {
          if (current()) { entry.stopPending = false; update(entry); }
        }
      },
    });
    return entry;
  }
  function render() {
    if (disposed) return;
    changed.depend();
    const nextMission = host.currentMission();
    if (nextMission !== missionId) {
      generation += 1; subscription?.stop(); subscription = null; subscriptionFailed = false;
      clearCards(); missionId = nextMission; const selected = generation;
      if (missionId) subscription = Tracker.nonreactive(() => subscribe('constellation.execution.missionJobs', missionId, {
        onError() { if (!disposed && selected === generation) { subscriptionFailed = true; changed.changed(); } },
      }));
    }
    if (!missionId) { transport = 'loading'; return; }
    transport = connection()?.connected !== true ? 'reconnecting' : subscriptionFailed ? 'unavailable'
      : subscription?.ready() !== true ? 'loading' : 'connected';
    const rows = host.jobs.find({ missionId, erasedAt: { $exists: false } }, {
      fields: { code: 0, stdout: 0, stderr: 0, inputFiles: 0 }, sort: { createdAt: -1 }, limit: 100,
    }).fetch();
    // Keep all active work, plus recent history. A reconnect must not make an
    // unfinished run vanish or imply that it finished successfully.
    const visible = new Map(rows.filter((job, index) => index < 40 || active.has(job.status)).map((job) => [job._id, job]));
    const erased = new Set(host.jobs.find({ missionId, erasedAt: { $exists: true } }, { fields: { _id: 1 } }).fetch().map((job) => job._id));
    if (transport !== 'connected') for (const [id, entry] of cards) if (!visible.has(id) && !erased.has(id)) visible.set(id, entry.job);
    for (const [id, entry] of cards) if (!visible.has(id)) { entry.card.dispose(); cards.delete(id); }
    for (const job of visible.values()) {
      let entry = cards.get(job._id);
      if (!entry) { entry = create(job); cards.set(job._id, entry); }
      entry.job = job; update(entry);
    }
    syncTimeline(); syncClock();
  }
  const computation = Tracker.autorun(render);
  return { render, dispose() {
    if (disposed) return; disposed = true; generation += 1; computation.stop(); subscription?.stop(); clearCards();
  } };
}
