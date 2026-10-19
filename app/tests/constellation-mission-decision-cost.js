import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';

if (Meteor.isClient) describe('Constellation mission Jev cost', function () {
  let initialize; let view; let root; let settings; let usage; let controls;
  let missionId; let missionChanged; let requests; let isReady; let readyChanged;
  const summary = (patch = {}) => ({ costUsd: 0, inputTokens: 0, outputTokens: 0, evaluations: 0,
    pricedEvaluations: 0, pendingEvaluations: 0, unpricedEvaluations: 0, uncertainEvaluations: 0, ...patch });
  const $ = (selector) => root.querySelector(selector);
  const flush = () => Tracker.flush();
  before(async () => {
    const costModule = await import('../client/mission-decision-cost');
    initialize = costModule.initializeMissionDecisionCost; view = costModule.missionDecisionCostView;
  });
  beforeEach(() => {
    root = document.querySelector('.mission-health').cloneNode(true);
    settings = new Mongo.Collection(null); usage = new Mongo.Collection(null);
    settings.insert({ _id: 'settings', providerConfigured: false, enabled: false });
    missionId = 'mission-a'; missionChanged = new Tracker.Dependency();
    isReady = true; readyChanged = new Tracker.Dependency(); requests = [];
    controls = initialize({ root, settings, usage,
      mission: () => { missionChanged.depend(); return missionId; },
      subscribe: (name, id, callbacks) => {
        const request = { name, id, callbacks, stopped: false,
          ready() { readyChanged.depend(); return isReady; }, stop() { this.stopped = true; } };
        requests.push(request); return request;
      },
    });
  });
  afterEach(() => controls.dispose());
  const connect = () => { settings.update('settings', { $set: { providerConfigured: true } }); flush(); };

  it('hides the tile and does not subscribe without a connection', () => {
    assert.isTrue($('[data-jev-cost-tile]').hidden);
    assert.lengthOf(requests, 0);
  });
  it('shows connected Jev usage even when evaluations are paused, and restores layout on disconnect', () => {
    usage.insert({ _id: missionId, ...summary() }); connect();
    assert.isFalse($('[data-jev-cost-tile]').hidden);
    assert.equal($('[data-jev-cost-value]').textContent, '$0.00');
    assert.equal(requests[0].name, 'constellation.decisions.missionUsage');
    settings.update('settings', { $set: { providerConfigured: false } }); flush();
    assert.isTrue(requests[0].stopped);
    assert.isTrue($('[data-jev-cost-tile]').hidden);
  });
  it('shows tiny charges rather than rounding paid usage to zero, with accessible exact details', () => {
    usage.insert({ _id: missionId, ...summary({ costUsd: 0.0000084, evaluations: 1,
      pricedEvaluations: 1, inputTokens: 200, outputTokens: 35 }) }); connect();
    assert.equal($('[data-jev-cost-value]').textContent, '<$0.01');
    const tile = $('[data-jev-cost-tile]'); tile.click();
    assert.equal(tile.getAttribute('aria-expanded'), 'true');
    assert.isFalse($('[data-jev-cost-detail]').hidden);
    assert.equal($('[data-jev-cost-amount]').textContent, '$0.0000084');
    assert.equal($('[data-jev-cost-currency]').textContent, 'USD');
    assert.isFalse($('[data-jev-cost-currency]').hidden);
    assert.equal($('[data-jev-evaluations]').textContent, '1');
    assert.equal($('[data-jev-input]').textContent, '200');
    assert.equal($('[data-jev-output]').textContent, '35');
    assert.isFalse($('[data-jev-cost-breakdown]').hidden);
    assert.isTrue($('[data-jev-cost-message]').hidden);
    assert.isTrue($('[data-jev-cost-notices]').hidden);
    assert.include(tile.getAttribute('aria-label'), 'Jev cost estimate');
    tile.click(); assert.isTrue($('[data-jev-cost-detail]').hidden);
  });
  it('groups the expanded amount and usage into labeled semantic rows instead of a dense paragraph', () => {
    usage.insert({ _id: missionId, ...summary({ costUsd: 0.042, evaluations: 2,
      pricedEvaluations: 2, inputTokens: 1000000, outputTokens: 1250 }) });
    connect(); $('[data-jev-cost-tile]').click();
    const detail = $('[data-jev-cost-detail]');
    const breakdown = $('[data-jev-cost-breakdown]');
    assert.equal(detail.tagName, 'SECTION');
    assert.equal($('[data-jev-cost-tile]').getAttribute('aria-controls'), detail.id);
    assert.equal(breakdown.querySelector('h3').textContent, 'Estimated Jev cost');
    assert.ok(breakdown.querySelector('dl.health-cost-usage'));
    for (const [selector, label, value] of [
      ['[data-jev-evaluations]', 'Evaluations', '2'],
      ['[data-jev-input]', 'Input tokens', '1,000,000'],
      ['[data-jev-output]', 'Output tokens', '1,250'],
    ]) {
      const field = $(selector);
      assert.equal(field.tagName, 'DD');
      assert.strictEqual(field.closest('dl'), breakdown.querySelector('dl.health-cost-usage'));
      assert.equal(field.previousElementSibling.tagName, 'DT');
      assert.equal(field.previousElementSibling.textContent.trim(), label);
      assert.equal(field.textContent, value);
    }
    assert.equal($('[data-jev-cost-amount]').textContent, '$0.042');
    assert.ok(breakdown.querySelector('.health-cost-pricing h4'));
    assert.ok(breakdown.querySelector('.health-cost-pricing dl'));
    assert.include(breakdown.querySelector('.health-cost-footnote').textContent, 'model-spend limit');
    for (const container of [detail, breakdown]) {
      const directText = [...container.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent.trim()).join('');
      assert.equal(directText, '', 'detail content stays in distinct readable elements');
    }
    assert.notMatch(detail.textContent, /evaluations?\s*·.*input tokens\s*·/);
  });
  it('reactively updates spend without resetting an open breakdown', () => {
    usage.insert({ _id: missionId, ...summary() }); connect(); $('[data-jev-cost-tile]').click();
    usage.update(missionId, { $set: { costUsd: 0.042, inputTokens: 1000000, pricedEvaluations: 1, evaluations: 1 } }); flush();
    assert.equal($('[data-jev-cost-value]').textContent, '$0.04');
    assert.isFalse($('[data-jev-cost-detail]').hidden);
    assert.equal($('[data-jev-cost-amount]').textContent, '$0.042');
    assert.equal($('[data-jev-input]').textContent, '1,000,000');
  });
  it('keeps the subscription and breakdown intact on same-mission or unrelated settings updates', () => {
    usage.insert({ _id: missionId, ...summary() }); connect(); $('[data-jev-cost-tile]').click();
    missionChanged.changed(); flush();
    settings.update('settings', { $set: { enabled: true, limits: { callsPerMission: 40 } } }); flush();
    assert.lengthOf(requests, 1); assert.isFalse(requests[0].stopped);
    assert.isFalse($('[data-jev-cost-detail]').hidden);
  });
  it('resubscribes by mission and never carries the previous mission’s cost or open details forward', () => {
    usage.insert({ _id: missionId, ...summary({ costUsd: 3, pricedEvaluations: 1 }) }); connect();
    $('[data-jev-cost-tile]').click();
    isReady = false; missionId = 'mission-b'; missionChanged.changed(); flush();
    assert.isTrue(requests[0].stopped); assert.equal(requests[1].id, 'mission-b');
    assert.equal($('[data-jev-cost-value]').textContent, '…');
    assert.equal($('[data-jev-cost-tile]').getAttribute('aria-busy'), 'true');
    assert.isTrue($('[data-jev-cost-detail]').hidden);
    usage.insert({ _id: missionId, ...summary() }); isReady = true; readyChanged.changed(); flush();
    assert.equal($('[data-jev-cost-value]').textContent, '$0.00');
  });
  it('does not present unavailable or failed subscriptions as zero cost', () => {
    connect(); assert.equal($('[data-jev-cost-value]').textContent, 'Unavailable');
    assert.isFalse($('[data-jev-cost-message]').hidden);
    assert.isTrue($('[data-jev-cost-breakdown]').hidden);
    usage.insert({ _id: missionId, ...summary({ costUsd: 1 }) }); flush();
    requests[0].callbacks.onError(); flush();
    assert.equal($('[data-jev-cost-value]').textContent, 'Unavailable');
    assert.include($('[data-jev-cost-message]').textContent, 'Reopen this mission');
    assert.isFalse($('[data-jev-cost-message]').hidden);
    assert.isTrue($('[data-jev-cost-breakdown]').hidden);
  });
  it('shows loading and failure messages separately from the loaded breakdown while details stay open', () => {
    isReady = false; connect(); $('[data-jev-cost-tile]').click();
    assert.isFalse($('[data-jev-cost-detail]').hidden);
    assert.isFalse($('[data-jev-cost-message]').hidden);
    assert.include($('[data-jev-cost-message]').textContent, 'Loading Jev usage');
    assert.isTrue($('[data-jev-cost-breakdown]').hidden);
    usage.insert({ _id: missionId, ...summary({ costUsd: .042, evaluations: 1,
      pricedEvaluations: 1, inputTokens: 1000000 }) });
    isReady = true; readyChanged.changed(); flush();
    assert.isTrue($('[data-jev-cost-message]').hidden);
    assert.isFalse($('[data-jev-cost-breakdown]').hidden);
    assert.equal($('[data-jev-cost-amount]').textContent, '$0.042');
    requests[0].callbacks.onError(); flush();
    assert.isFalse($('[data-jev-cost-detail]').hidden);
    assert.isFalse($('[data-jev-cost-message]').hidden);
    assert.isTrue($('[data-jev-cost-breakdown]').hidden, 'a stale estimate must not appear beneath a failure');
  });
  it('keeps unknown usage visible with distinct notices and removes them when usage is confirmed', () => {
    usage.insert({ _id: missionId, ...summary({ evaluations: 2, uncertainEvaluations: 1,
      unpricedEvaluations: 1, inputTokens: 200, outputTokens: 35 }) });
    connect(); $('[data-jev-cost-tile]').click();
    assert.equal($('[data-jev-cost-value]').textContent, 'Unknown');
    assert.equal($('[data-jev-cost-amount]').textContent, 'Unknown');
    assert.isTrue($('[data-jev-cost-currency]').hidden, 'an unknown amount must not look like a confirmed dollar value');
    assert.isTrue($('[data-jev-cost-message]').hidden);
    assert.isFalse($('[data-jev-cost-breakdown]').hidden);
    assert.equal($('[data-jev-evaluations]').textContent, '2');
    assert.isFalse($('[data-jev-cost-notices]').hidden);
    const notices = [...$('[data-jev-cost-notices]').querySelectorAll('li')].map((item) => item.textContent);
    assert.lengthOf(notices, 2);
    assert.isTrue(notices.some((text) => text.includes('no verified price')));
    assert.isTrue(notices.some((text) => text.includes('usage unconfirmed')));
    usage.update(missionId, { $set: { costUsd: .042, pricedEvaluations: 2,
      uncertainEvaluations: 0, unpricedEvaluations: 0 } }); flush();
    assert.isTrue($('[data-jev-cost-notices]').hidden);
    assert.equal($('[data-jev-cost-amount]').textContent, '$0.042');
    assert.isFalse($('[data-jev-cost-currency]').hidden);
    assert.lengthOf($('[data-jev-cost-notices]').children, 0, 'resolved notices must not remain in the breakdown');
    assert.isFalse($('[data-jev-cost-detail]').hidden);
  });
  it('shows unknown and partially confirmed usage explicitly', () => {
    const unknown = view(summary({ uncertainEvaluations: 1, evaluations: 1 }));
    assert.equal(unknown.value, 'Unknown'); assert.equal(unknown.note, 'Partial estimate');
    const partial = view(summary({ costUsd: .1, pricedEvaluations: 2, unpricedEvaluations: 1, uncertainEvaluations: 1 }));
    assert.equal(partial.value, '$0.10+');
    assert.include(partial.notices.join(' '), 'no verified price');
    assert.include(partial.notices.join(' '), 'usage unconfirmed');
  });
  it('shows in-flight usage as updating without inventing a charge', () => {
    const pending = view(summary({ pendingEvaluations: 1, evaluations: 1 }));
    assert.equal(pending.value, '$0.00'); assert.equal(pending.state, 'pending');
    assert.equal(pending.note, 'Updating…'); assert.include(pending.notices.join(' '), 'cost updates when usage arrives');
  });
});
