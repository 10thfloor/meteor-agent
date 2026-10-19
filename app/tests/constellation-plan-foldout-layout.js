import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { Tracker } from 'meteor/tracker';
import { defineAgentChat } from 'meteor/10thfloor:agent';

// Exercise actual run cards in the real chat's flex transcript. Records remain
// client-only; layout checks never launch, approve, stop, or save a plan.
if (Meteor.isClient) describe('Constellation plan foldout layout', function () {
  this.timeout(15_000);
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const style = (element) => getComputedStyle(element);
  const assertInset = (element, pixels, description) => {
    const computed = style(element);
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      assert.equal(computed[`padding${side}`], `${pixels}px`, `${description}: ${side.toLowerCase()} inset`);
    }
  };
  const assertZeroMargin = (element, description) => {
    const computed = style(element);
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      assert.equal(computed[`margin${side}`], '0px', `${description}: no inherited ${side.toLowerCase()} margin`);
    }
  };
  let createPlanRunTimeline;
  let fixture;

  before(async () => {
    ({ createPlanRunTimeline } = await import('../client/plan-chat-runs.js'));
    defineAgentChat('agent-chat');
  });

  beforeEach(() => {
    const id = `plan-foldout-layout-${Random.id()}`;
    const mount = document.createElement('section');
    mount.style.cssText = 'position:fixed;left:20px;top:20px;width:720px;height:460px;z-index:100000;background:#101512;';
    const chat = document.createElement('agent-chat');
    chat.setAttribute('agent', id);
    chat.setAttribute('session-id', id);
    chat.style.cssText = 'height:100%;width:100%;';
    mount.append(chat);
    document.body.append(mount);
    fixture = { id, mount, chat, runs: new Mongo.Collection(null), popovers: [] };
    fixture.surface = createPlanRunTimeline({
      chat, currentMission: () => id, missionConfig: () => ({ title: 'Layout mission', status: 'active' }),
      runs: fixture.runs, openContext: () => {}, openChild: () => {}, toast: () => {},
    });
  });

  afterEach(async () => {
    for (const popover of fixture.popovers) {
      if (popover.matches(':popover-open')) popover.hidePopover();
      popover.remove();
    }
    fixture.surface.dispose();
    fixture.mount.remove();
    Tracker.flush();
    await nextFrame();
    fixture = undefined;
  });

  function insertRun({ review = true, summary = 'The evidence is complete.\nThe release is ready for review.' } = {}) {
    const id = `${fixture.id}-run`;
    const steps = [{ id: 'prepare', label: 'Check the release', primitive: 'agent', agent: 'researcher',
      status: 'completed', summary, childSessionId: `${fixture.id}-source`, dependsOn: [] }];
    if (review) steps.push({ id: 'review', label: 'Review the result', primitive: 'approval', status: 'awaiting',
      waitReason: 'approval', fingerprint: 'layout-only-review', prompt: 'Are the sources sufficient to continue?', dependsOn: ['prepare'] });
    fixture.runs.insert({ _id: id, missionId: fixture.id, name: 'Release review', definitionRevision: 3,
      createdAt: new Date('2026-09-10T17:00:00Z'), status: review ? 'awaiting' : 'completed', steps });
    Tracker.flush();
    const card = fixture.chat.timelineItems.find((item) => item.id === `plan-run-${id}`).element;
    card.querySelector('[data-chat-run-toggle]').click();
    return card;
  }

  it('uses deliberate insets and gaps throughout expanded review and evidence panels', async () => {
    const card = insertRun();
    await nextFrame();
    const body = card.querySelector('.plan-run-body');
    assert.equal(style(body).display, 'flex');
    assert.equal(style(body).flexDirection, 'column');
    assert.equal(style(body).rowGap, '16px');
    assertInset(body, 16, 'expanded run body');
    for (const child of body.children) assertZeroMargin(child, 'run body child');

    const review = card.querySelector('.plan-run-review');
    assert.equal(style(review).display, 'grid');
    assert.equal(style(review).rowGap, '12px');
    assertInset(review, 16, 'review panel');
    const evidence = card.querySelector('.plan-run-evidence');
    assert.equal(style(evidence).display, 'grid');
    assert.equal(style(evidence).rowGap, '12px');
    assertZeroMargin(evidence, 'evidence stack');
    const item = evidence.querySelector('.plan-run-evidence-item');
    assert.equal(style(item).display, 'grid');
    assert.equal(style(item).rowGap, '8px');
    assertInset(item, 14, 'source result');
    assertZeroMargin(item, 'source result');
    assertZeroMargin(item.querySelector('p'), 'source text');

    const divider = body.getBoundingClientRect().top + parseFloat(style(body).borderTopWidth);
    assert.closeTo(body.querySelector('.plan-run-meta').getBoundingClientRect().top - divider, 16, 1,
      'metadata must not sit against the expansion divider');
  });

  it('separates the result label from text without browser-default paragraph margins', async () => {
    const card = insertRun({ review: false });
    await nextFrame();
    const result = card.querySelector('.plan-run-result');
    const text = result.querySelector('p');
    assert.isFalse(result.hidden);
    assert.equal(style(result).whiteSpace, 'normal', 'section markup whitespace is not result content');
    assert.equal(style(result).display, 'grid');
    assert.equal(style(result).rowGap, '8px');
    assert.equal(style(text).whiteSpace, 'pre-wrap', 'line breaks inside the actual result remain intact');
    assertZeroMargin(result, 'result section');
    assertZeroMargin(text, 'result paragraph');
    assert.closeTo(text.getBoundingClientRect().top - result.querySelector('h4').getBoundingClientRect().bottom,
      8, 1, 'result label and text have one intentional gap');
  });

  it('keeps an expanded narrow card intact while the conversation scrolls', async () => {
    fixture.mount.style.width = '360px';
    const longToken = 'A'.repeat(180);
    const card = insertRun({ summary: Array.from({ length: 18 }, (_, index) =>
      `Evidence ${index + 1}: reviewed the complete release checklist. ${longToken}`).join('\n') });
    await nextFrame();
    await nextFrame();
    const messages = fixture.chat.shadowRoot.querySelector('.messages');
    const body = card.querySelector('.plan-run-body');
    const evidence = card.querySelector('.plan-run-evidence-item');
    const footer = card.querySelector('.plan-run-actions');
    assert.equal(style(messages).display, 'flex', 'use the actual flex conversation layout');
    assert.equal(style(card).flexShrink, '0', 'an expanded card must not shrink and clip its contents');
    assertInset(card.querySelector('.plan-run-summary'), 16, 'narrow summary');
    assertInset(body, 16, 'narrow body');
    assert.isAbove(messages.scrollHeight, messages.clientHeight, 'long cards make the conversation scroll');
    assert.isAtMost(card.scrollHeight, card.clientHeight + 1, 'the card must contain its expanded children');
    for (const element of [card, body, evidence, evidence.querySelector('p'), footer]) {
      assert.isAtMost(element.scrollWidth, element.clientWidth + 1, 'long text must wrap within the available inset');
    }
    const bounds = card.getBoundingClientRect();
    for (const element of [body, evidence, footer]) {
      const child = element.getBoundingClientRect();
      assert.isAtLeast(child.left, bounds.left);
      assert.isAtMost(child.right, bounds.right + 1);
      assert.isAtMost(child.bottom, bounds.bottom, 'expanded controls must not extend below the card');
    }
    messages.scrollTop = messages.scrollHeight;
    await nextFrame();
    assert.isAbove(messages.scrollTop, 0, 'the result footer remains reachable through conversation scrolling');
    assert.isAtMost(footer.getBoundingClientRect().bottom, messages.getBoundingClientRect().bottom + 1);
  });

  it('aligns chooser and preview gutters and wraps long labels at compact widths', async () => {
    // Minimal static scaffold isolates spacing from catalog transport; the
    // selectors and nested flex/grid structure match the production popover.
    const picker = document.createElement('div');
    picker.className = 'chat-plan-picker';
    picker.setAttribute('popover', 'manual');
    picker.style.cssText = 'left:16px;top:16px;max-height:calc(100vh - 32px);';
    picker.innerHTML = `<div class="chat-plan-browse">
      <header class="chat-plan-picker-heading"><h2>Plans</h2></header>
      <div class="chat-plan-search"><input aria-label="Layout-only search"></div>
      <footer class="chat-plan-picker-foot"><span>Select to attach as context</span></footer>
    </div><div class="chat-plan-preview">
      <header class="chat-plan-picker-heading"><button class="plan-text-button">Plans</button></header>
      <div class="plan-preview-content"><div class="plan-preview-title"><svg viewBox="0 0 20 20" aria-hidden="true"></svg>
        <div><h2></h2><p>This mission · Version 3</p></div></div>
        <ol class="plan-preview-steps"><li><span class="plan-preview-step-number">1</span><div><strong>Review references</strong><small></small></div></li></ol>
      </div><footer class="plan-preview-footer"><button class="plan-text-button">Open plan</button></footer>
    </div>`;
    picker.querySelector('.plan-preview-title h2').textContent = 'Release'.repeat(30);
    picker.querySelector('.plan-preview-steps small').textContent = 'Researcher'.repeat(25);
    fixture.popovers.push(picker);
    document.body.append(picker);
    picker.showPopover();
    for (const width of [480, 320]) {
      picker.style.width = `${width}px`;
      await nextFrame();
      for (const element of picker.querySelectorAll('.chat-plan-picker-heading,.chat-plan-picker-foot,.plan-preview-content,.plan-preview-footer')) {
        assert.equal(style(element).paddingLeft, '16px', `${width}px panel: consistent left gutter`);
        assert.equal(style(element).paddingRight, '16px', `${width}px panel: consistent right gutter`);
      }
      const search = picker.querySelector('.chat-plan-search');
      assert.equal(style(search).marginLeft, '16px');
      assert.equal(style(search).marginRight, '16px');
      for (const selector of ['.plan-preview-content', '.plan-preview-title', '.plan-preview-steps']) {
        const element = picker.querySelector(selector);
        assert.isAtMost(element.scrollWidth, element.clientWidth + 1, `${selector} must wrap within a ${width}px panel`);
      }
      assert.equal(style(picker.querySelector('.plan-preview-title > div')).minWidth, '0px');
      assert.equal(style(picker.querySelector('.plan-preview-steps li > div')).minWidth, '0px');
      assert.equal(style(picker.querySelector('.plan-preview-steps small')).overflowWrap, 'anywhere');
    }
  });
});
