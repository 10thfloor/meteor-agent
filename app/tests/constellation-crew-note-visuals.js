import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { defineAgentChat } from 'meteor/10thfloor:agent';

// Render the actual chat element and Constellation theme with local-only rows.
// No transcript writes, agent turns, or crew membership changes are required.
if (Meteor.isClient) describe('Constellation crew note visuals', function () {
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const part = (node, token) => node.querySelector(`[part~="${token}"]`);
  let mount;
  let chat;
  let writes;

  before(() => defineAgentChat());
  beforeEach(() => {
    writes = [];
    mount = document.createElement('div');
    mount.style.cssText = 'position:fixed;left:16px;top:16px;width:440px;height:640px;z-index:99999;background:#101211;';
    chat = document.createElement('agent-chat');
    chat.setAttribute('agent', 'orchestrator');
    chat.setAttribute('session-id', `crew-note-visuals-${Random.id()}`);
    mount.append(chat);
    document.body.append(mount);
    chat.agentInstance.session = () => null;
    chat.agentInstance.messages = () => ({ fetch: () => [] });
    chat.agentInstance.send = async (...args) => { writes.push({ mode: 'ask', args }); };
    chat.agentInstance.contribute = async (...args) => { writes.push({ mode: 'note', args }); };
  });
  afterEach(() => {
    mount.remove();
    assert.isEmpty(writes, 'a presentation check must not send a message or wake an agent');
  });

  const render = async (rows) => {
    chat.agentInstance.messages = () => ({ fetch: () => rows.map((row, index) => ({
      _id: `crew-note-row-${index}`, seq: index + 1, role: 'user',
      createdAt: new Date(2026, 8, 10, 11, index), ...row,
    })) });
    chat.mentionSources = {
      '@': { kind: 'agent', list: [{ handle: 'atlas', name: 'Atlas' }], handle: 'handle', label: 'name' },
    };
    await nextFrame();
    return [...chat.shadowRoot.querySelectorAll('.message.user')];
  };

  it('keeps crew notes distinct from the muted regular chat surface', async () => {
    const [note, ask] = await render([
      { kind: 'crew-note', content: 'The release is ready for review.' },
      { content: 'Please review the release.' },
    ]);
    const noteStyle = getComputedStyle(note);
    const askStyle = getComputedStyle(ask);
    assert.strictEqual(noteStyle.backgroundImage, 'none');
    assert.strictEqual(noteStyle.backgroundColor, 'rgb(27, 40, 50)');
    assert.strictEqual(noteStyle.color, 'rgb(214, 226, 237)');
    assert.strictEqual(noteStyle.borderTopStyle, 'solid');
    assert.strictEqual(noteStyle.borderTopColor, 'rgb(64, 92, 112)');
    assert.strictEqual(askStyle.backgroundImage, 'none', 'full-width messages do not use a bright gradient');
    assert.strictEqual(askStyle.backgroundColor, 'rgb(36, 37, 31)');
    assert.strictEqual(askStyle.color, 'rgb(229, 230, 223)');
    assert.strictEqual(askStyle.borderTopStyle, 'solid');
    assert.strictEqual(askStyle.borderTopColor, 'rgb(66, 66, 53)');
    assert.strictEqual(askStyle.fontWeight, '400', 'message content uses normal reading weight');
    assert.notEqual(noteStyle.backgroundColor, askStyle.backgroundColor);
    assert.notEqual(noteStyle.color, askStyle.color);
    assert.isNull(part(ask, 'crew-note-header'));
    assert.isNull(part(ask, 'crew-note-badge'));
  });

  it('keeps user message text and attribution readable on the muted surface', async () => {
    const [ask] = await render([{
      content: 'Please review the release.',
      from: { participant: 'h:me', name: 'You' }, source: { kind: 'desktop' },
    }]);
    const luminance = (color) => {
      const channels = color.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
      assert.ok(channels, 'contrast checks require an opaque sRGB color');
      const linear = channels.slice(1).map((channel) => {
        const normalized = Number(channel) / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const surface = luminance(getComputedStyle(ask).backgroundColor);
    const attribution = part(ask, 'speaker-user');
    assert.equal(attribution.textContent, 'You · Desktop');
    for (const [element, label] of [[ask, 'Message body'], [attribution, 'User attribution']]) {
      const style = getComputedStyle(element);
      assert.equal(style.opacity, '1', `${label} is not faded out`);
      const text = luminance(style.color);
      const ratio = (Math.max(surface, text) + 0.05) / (Math.min(surface, text) + 0.05);
      assert.isAtLeast(ratio, 4.5, `${label} meets normal-text contrast requirements`);
    }
  });

  it('groups the note label with attribution and preserves desktop and channel sources', async () => {
    const [desktop, channel, anonymous] = await render([
      { kind: 'crew-note', content: 'Desktop update.',
        from: { participant: 'h:alex', name: 'Alex' }, source: { kind: 'desktop' } },
      { kind: 'crew-note', content: 'Channel update.',
        from: { participant: 'h:dana', name: 'Dana' }, source: { kind: 'channel', channel: 'slack' } },
      { kind: 'crew-note', content: 'An older note without participant metadata.' },
    ]);
    for (const row of [desktop, channel, anonymous]) {
      const header = part(row, 'crew-note-header');
      const badge = part(row, 'crew-note-badge');
      assert.ok(header);
      assert.strictEqual(header.parentElement, row);
      assert.strictEqual(badge.parentElement, header, 'the label belongs to the header, not the note text');
      assert.strictEqual(badge.textContent, 'Crew note');
      assert.strictEqual(row.firstElementChild, header);
      assert.notInclude(header.textContent, 'update.');
    }
    assert.strictEqual(part(desktop, 'speaker-crew-note').textContent, 'Alex · Desktop');
    assert.strictEqual(part(channel, 'speaker-crew-note').textContent, 'Dana · Slack');
    assert.isNull(part(anonymous, 'speaker'));
    assert.ok(part(anonymous, 'crew-note-badge'), 'legacy notes remain identifiable without attribution');
  });

  it('keeps the direct recipient in compact user-message attribution but never on crew notes', async () => {
    chat.agentInstance.session = () => ({ participants: [
      { id: 'm:operator', kind: 'model', agent: 'operator', displayName: 'Relay' },
    ] });
    const [ask, note, legacy] = await render([
      { content: 'Please review this.', to: 'm:operator',
        from: { participant: 'h:me', name: 'You' }, source: { kind: 'desktop' } },
      { kind: 'crew-note', content: 'No reply needed.', to: 'm:operator',
        from: { participant: 'h:me', name: 'You' }, source: { kind: 'desktop' } },
      { content: 'Earlier direct request.', to: 'm:operator' },
    ]);
    const recipient = part(ask, 'recipient-user');
    const attribution = part(ask, 'speaker-user');
    assert.equal(attribution.textContent, 'You · Desktop · To Relay');
    assert.strictEqual(recipient.parentElement, attribution);
    assert.notInclude(attribution.textContent, 'Please review');
    assert.isNull(part(note, 'recipient-user'), 'notes must not imply that a reply was requested');
    assert.equal(part(legacy, 'recipient-user').textContent, 'To Relay');
    assert.isBelow(parseFloat(getComputedStyle(recipient).fontSize), parseFloat(getComputedStyle(ask).fontSize));
    assert.isAtMost(ask.scrollWidth, ask.clientWidth + 1, 'metadata remains inside the bubble');
  });

  it('keeps long attribution, the badge, and multiline literal text contained at a narrow width', async () => {
    mount.style.width = '320px';
    const content = 'First line.\n<img src=x onerror="window.crewNoteInjected=true">\nA second update for the crew.';
    const [note] = await render([{ kind: 'crew-note', content,
      from: { participant: 'h:long-name', name: 'AveryWithAnUnusuallyLongUnbrokenParticipantName' },
      source: { kind: 'channel', channel: 'team_updates' },
    }]);
    const header = part(note, 'crew-note-header');
    const badge = part(note, 'crew-note-badge');
    const noteRect = note.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const badgeRect = badge.getBoundingClientRect();
    const body = document.createRange();
    body.setStartAfter(header);
    body.setEnd(note, note.childNodes.length);
    const bodyRect = body.getBoundingClientRect();
    assert.isAbove(noteRect.width, 0, 'fixture must have a real layout');
    assert.isAtMost(note.scrollWidth, note.clientWidth + 1, 'long names and note text must wrap');
    assert.isAtLeast(headerRect.left, noteRect.left);
    assert.isAtMost(headerRect.right, noteRect.right);
    assert.isAtLeast(badgeRect.left, headerRect.left);
    assert.isAtMost(badgeRect.right, headerRect.right + 1);
    assert.isAtLeast(bodyRect.top, headerRect.bottom + 4, 'note text starts on its own line with breathing room');
    assert.include(note.textContent, content);
    assert.isNull(note.querySelector('img, script'), 'human note contents must remain literal text');
    assert.strictEqual(getComputedStyle(note).whiteSpace, 'pre-wrap', 'intentional line breaks remain visible');
  });

  it('keeps crew-note mentions non-routing while ordinary leading mentions stay addressed', async () => {
    const [note, ask] = await render([
      { kind: 'crew-note', content: '@atlas the decision is recorded.' },
      { content: '@atlas please review the decision.' },
    ]);
    const noteMention = part(note, 'mention');
    const askMention = part(ask, 'mention');
    assert.strictEqual(noteMention.tagName, 'SPAN');
    assert.notInclude(noteMention.getAttribute('part').split(' '), 'addressed');
    assert.notInclude(noteMention.title, 'schedules their turn');
    assert.include(askMention.getAttribute('part').split(' '), 'addressed');
    assert.include(askMention.title, 'schedules their turn');
    noteMention.click();
    assert.isEmpty(writes);
  });

  for (const width of [1120, 360]) {
    it(`aligns full-width chat bubbles with the compact composer in a ${width}px container`, async () => {
      mount.style.width = `${width}px`;
      chat.id = 'mission-chat';
      chat.setAttribute('multiline', '');
      chat.setAttribute('composer-layout', 'panel');
      const recipient = document.createElement('div');
      recipient.slot = 'composer-header';
      recipient.className = 'mission-recipient';
      recipient.innerHTML = '<button class="mission-recipient-button" type="button"><span class="mission-recipient-avatar">A</span><span class="mission-recipient-label">Ask Atlas</span></button>';
      const add = document.createElement('button');
      add.slot = 'composer-toolbar';
      add.className = 'composer-add-button';
      add.type = 'button';
      add.textContent = '+ Add';
      chat.append(recipient, add);
      await render([
        { content: 'Please review the mission.' },
        { role: 'assistant', content: 'I will review the mission and report the results.' },
        { kind: 'crew-note', content: 'The release is ready for review.' },
      ]);
      chat.setDraft('');
      await nextFrame();

      const composer = part(chat.shadowRoot, 'composer');
      const messages = part(chat.shadowRoot, 'messages');
      const input = part(chat.shadowRoot, 'input');
      const chatBounds = chat.getBoundingClientRect();
      const composerBounds = composer.getBoundingClientRect();
      const gutter = parseFloat(getComputedStyle(chat).getPropertyValue('--mission-chat-gutter'));
      assert.isAbove(gutter, 0, 'the shared gutter must be explicitly defined');
      assert.closeTo(composerBounds.left - chatBounds.left, gutter, 1);
      assert.closeTo(chatBounds.right - composerBounds.right, gutter, 1);
      const bubbles = [...messages.querySelectorAll('.message.user, .message.assistant')];
      assert.lengthOf(bubbles, 3, 'the fixture covers user, assistant, and crew-note bubbles');
      for (const bubble of bubbles) {
        const bounds = bubble.getBoundingClientRect();
        assert.closeTo(bounds.left, composerBounds.left, 1, 'messages and composer share the left gutter');
        assert.closeTo(bounds.right, composerBounds.right, 1, 'messages and composer share the right gutter');
        assert.isAtMost(bubble.scrollWidth, bubble.clientWidth + 1, 'bubble text stays inside its padding');
      }
      assert.isAtMost(messages.scrollWidth, messages.clientWidth + 1, 'transcript does not overflow horizontally');
      assert.isAtMost(composer.scrollWidth, composer.clientWidth + 1, 'composer controls remain contained');
      assert.isAtMost(composerBounds.height, 145, 'empty composer does not retain the old tall writing area');
      assert.equal(input.rows, 1, 'the mission composer starts with one line');
      assert.isAtLeast(recipient.querySelector('button').getBoundingClientRect().height, 32);
      assert.isAtLeast(add.getBoundingClientRect().height, 32);
      assert.isAtLeast(part(chat.shadowRoot, 'send').getBoundingClientRect().height, 32);
    });
  }
});
