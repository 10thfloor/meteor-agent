import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';

// Isolate the shipped Capabilities scaffold and styles in a viewport of known
// size. The fixtures have no application scripts, subscriptions, or saved data.
if (Meteor.isClient) describe('Constellation decision layout', function () {
  this.timeout(15_000);
  let frame;
  let doc;
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const byId = (id) => doc.getElementById(id);
  const style = (element) => frame.contentWindow.getComputedStyle(element);
  const repeat = (count, render) => Array.from({ length: count }, (_, index) => render(index + 1)).join('');
  const question = (index) => `<section class="decision-question"><header><strong>Evidence check ${index}</strong><span class="op-muted">Choice</span></header><p>Read the supplied evidence and decide whether the source directly supports the claim. Include missing context and contrary evidence in the judgment.</p><ol><li>Supported by direct evidence</li><li>More evidence needed</li></ol></section>`;
  const content = {
    overview: () => `<div class="decision-question-list">${repeat(8, question)}</div><section class="decision-section"><h4>Inputs</h4><div class="decision-input-chips"><span><strong>Evidence</strong><code>context</code><small>text · required</small></span></div></section><section class="decision-section"><h4>Shared with</h4><button class="op-link" data-layout-bottom type="button">Change sharing</button></section>`,
    test: () => `<p class="decision-privacy-note">Input is sent to TypeSafe when a live test is run.</p><form class="decision-form-stack"><div class="decision-form-stack">${repeat(5, (index) => `<label>Evidence ${index}<textarea rows="4">Source evidence for the decision.</textarea></label>`)}</div><button class="primary-action" type="button">Run live test</button></form><section class="decision-section"><h4>Saved tests</h4>${repeat(8, (index) => `<div class="decision-fixture"><button class="op-link" type="button">Evidence example ${index}</button><button class="op-link" type="button">Remove</button></div>`)}<button class="secondary-action" type="button">Run saved tests</button><details class="decision-save-example" open><summary>Save these inputs as a test</summary><form class="decision-form-stack"><label>Test name<input value="Missing evidence"></label><label>Expected option<select><option>More evidence needed</option></select></label><button class="secondary-action" data-layout-bottom type="button">Save test example</button></form></details></section>`,
    history: () => repeat(5, (index) => `<details class="decision-history-row" open><summary><span><strong>Evaluation ${index}</strong><small>Manual test · revision 1</small></span><span>Completed</span></summary><div class="decision-history-body"><div class="decision-answers"><div class="decision-answer"><span>Evidence check</span><strong>Supported</strong></div></div><details class="decision-history-inputs" open><summary>Exact inputs</summary><dl class="decision-values"><div><dt>context</dt><dd class="decision-text-value">${'Source evidence with supporting detail. '.repeat(25)}</dd></div></dl></details><details class="decision-history-inputs" open><summary>Questions used</summary>${question(index)}${index === 5 ? '<p class="op-hint" data-layout-bottom>End of recorded evaluation</p>' : ''}</details></div></details>`),
  };

  before(async () => {
    const deadline = Date.now() + 10_000;
    while (!document.getElementById('capability-panel-decisions')) {
      if (Date.now() >= deadline) assert.fail('the Capabilities scaffold did not mount');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  afterEach(() => {
    frame?.remove();
    frame = undefined;
    doc = undefined;
  });

  async function mount(width, height, tab) {
    frame = document.createElement('iframe');
    frame.title = 'Isolated decision layout fixture';
    frame.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;border:0;z-index:100000;`;
    frame.srcdoc = '<!doctype html><html><head></head><body></body></html>';
    const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    document.body.append(frame);
    await loaded;
    doc = frame.contentDocument;
    const stylesheet = doc.createElement('style');
    stylesheet.textContent = [...document.styleSheets].filter((sheet) => !sheet.disabled)
      .map((sheet) => [...sheet.cssRules].map((rule) => rule.cssText).join('\n')).join('\n');
    doc.head.append(stylesheet);

    // Keep the real ancestors: the bug involves the available height beneath
    // the header, navigation, summary, and toolbar, not just the detail itself.
    const source = document.getElementById('view-capabilities');
    const view = source.cloneNode(true);
    view.classList.add('active');
    view.hidden = false;
    for (const attribute of ['actions', 'summary', 'panel']) {
      for (const element of view.querySelectorAll(`[data-capability-${attribute}]`)) {
        const selected = element.getAttribute(`data-capability-${attribute}`) === 'decisions';
        element.hidden = !selected;
        if (attribute === 'panel') element.classList.toggle('active', selected);
      }
    }
    for (const button of view.querySelectorAll('[data-capability-tab]')) {
      const selected = button.dataset.capabilityTab === 'decisions';
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
    }
    const app = document.getElementById('app-frame').cloneNode(false);
    const shell = document.getElementById('workspace-shell').cloneNode(false);
    const stage = source.parentElement.cloneNode(false);
    shell.dataset.currentView = 'capabilities';
    shell.append(document.querySelector('.primary-rail').cloneNode(false),
      document.getElementById('mission-sidebar').cloneNode(false), stage);
    stage.append(view);
    app.append(document.querySelector('.window-bar').cloneNode(true), shell);
    doc.body.append(app);
    byId('decision-page-notice').replaceChildren();
    byId('decision-list').innerHTML = repeat(24, (index) => `<button class="decision-list-item ${index === 1 ? 'selected' : ''}" type="button"><span class="decision-item-heading"><strong>Evidence decision ${index}</strong><span>Enabled</span></span><span class="decision-item-description">Review whether the available evidence supports the next action.</span><span class="decision-item-meta">Workspace<span>Revision 1</span></span></button>`);
    const detail = byId('decision-detail');
    detail.hidden = false;
    detail.innerHTML = `<header class="decision-detail-heading"><div><span class="decision-eyebrow">Workspace · Revision 1</span><h3>Evidence decision</h3></div><span>Enabled</span></header><p class="decision-description">Check source support before choosing the next action.</p><div class="decision-detail-actions"><button class="secondary-action" type="button">Share with crew</button><button class="secondary-action" type="button">Edit</button><button class="secondary-action" type="button">Disable</button><button class="op-link" type="button">Remove</button></div><div class="op-tabs decision-detail-tabs" role="tablist" aria-label="Decision detail">${[['overview', 'Definition'], ['test', 'Test'], ['history', 'History']].map(([key, label]) => `<button data-decision-tab="${key}" role="tab" aria-selected="${key === tab}" type="button">${label}</button>`).join('')}</div><section class="decision-content" role="tabpanel">${content[tab]()}</section>`;
    await nextFrame();
    await nextFrame();
  }

  function assertScrollable(element, description) {
    assert.match(style(element).overflowY, /^(auto|scroll)$/, `${description} accepts vertical scrolling`);
    assert.isAbove(element.clientHeight, 80, `${description} has usable visible height`);
    assert.isAbove(element.scrollHeight, element.clientHeight + 100, `${description} has overflowing fixture content`);
  }

  function assertBottomVisible(element, scroller, description) {
    const bounds = element.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    assert.isAtLeast(bounds.top, viewport.top - 1, `${description} is above the scroll viewport bottom`);
    assert.isAtMost(bounds.bottom, viewport.bottom + 1, `${description} is reachable without clipping`);
    assert.isAtMost(bounds.bottom, frame.contentWindow.innerHeight + 1, `${description} is inside the app viewport`);
  }

  for (const tab of ['overview', 'test', 'history']) {
    it(`scrolls tall ${tab === 'overview' ? 'Definition' : tab} content independently of the desktop decision list`, async () => {
      await mount(1280, 720, tab);
      const detail = byId('decision-detail');
      const list = byId('decision-list');
      const layout = detail.parentElement;
      assertScrollable(detail, 'decision detail');
      assertScrollable(list, 'decision list');
      assert.isAtMost(layout.getBoundingClientRect().bottom,
        byId('capability-panel-decisions').getBoundingClientRect().bottom + 1, 'the grid fits below the toolbar');
      assert.closeTo(list.getBoundingClientRect().top, detail.getBoundingClientRect().top, 1, 'desktop panels sit side by side');
      detail.scrollTop = detail.scrollHeight;
      await nextFrame();
      assert.isAbove(detail.scrollTop, 0);
      assert.equal(list.scrollTop, 0, 'reading a detail does not move the list');
      assertBottomVisible(detail.querySelector('[data-layout-bottom]'), detail, `${tab} final content`);
      const detailScroll = detail.scrollTop;
      list.scrollTop = list.scrollHeight;
      await nextFrame();
      assert.equal(detail.scrollTop, detailScroll, 'browsing the list does not move the detail');
      assertBottomVisible(list.lastElementChild, list, 'last decision');
      assert.isAtMost(detail.scrollWidth, detail.clientWidth + 1, 'detail content stays within the panel width');
      assert.equal(detail.tabIndex, 0, 'the detail scroll area is keyboard focusable');
      detail.focus({ preventScroll: true });
      assert.strictEqual(doc.activeElement, detail);
    });
  }

  it('keeps the final saved-test control reachable in a short desktop window', async () => {
    await mount(1000, 680, 'test');
    const detail = byId('decision-detail');
    assertScrollable(detail, 'short-window detail');
    detail.scrollTop = detail.scrollHeight;
    await nextFrame();
    assertBottomVisible(detail.querySelector('[data-layout-bottom]'), detail, 'Save test example');
  });

  it('scrolls the stacked layout to the final control at the compact breakpoint', async () => {
    // 840px is the app's minimum supported width and exercises the <=850px layout.
    await mount(840, 720, 'test');
    const detail = byId('decision-detail');
    const list = byId('decision-list');
    const layout = detail.parentElement;
    assertScrollable(layout, 'stacked decisions');
    assertScrollable(list, 'compact decision list');
    assert.isAtMost(list.getBoundingClientRect().bottom, detail.getBoundingClientRect().top + 1,
      'compact details follow the list');
    assert.isAtMost(list.clientHeight, 270, 'the decision list leaves room to reach the detail');
    assert.equal(style(detail).overflowY, 'visible', 'the stacked view uses the outer scroll area');
    list.scrollTop = list.scrollHeight;
    layout.scrollTop = Math.max(0,
      list.lastElementChild.getBoundingClientRect().bottom - layout.getBoundingClientRect().bottom);
    await nextFrame();
    assertBottomVisible(list.lastElementChild, list, 'last compact decision');
    layout.scrollTop = layout.scrollHeight;
    await nextFrame();
    assert.isAbove(layout.scrollTop, 0);
    assertBottomVisible(detail.querySelector('[data-layout-bottom]'), layout, 'compact Save test example');
    assert.isAtMost(layout.scrollWidth, layout.clientWidth + 1, 'compact content has no horizontal overflow');
  });
});
