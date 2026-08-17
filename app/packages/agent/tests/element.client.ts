import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { defineAgentChat } from '../client/element';

/**
 * Browser half of `<agent-chat>`. Same shape as `integration.client.ts` — real
 * DDP against the `itest` fixtures in `integration.server.ts`, bounded polls,
 * no fake timers — but every observation goes through the SHADOW ROOT, and
 * through the `part` attributes specifically: those are the element's public
 * styling seam, so a test that queries them is also a test that they exist and
 * carry the tokens the README promises. Querying `.message.user` instead would
 * pass just as well while the seam quietly rotted.
 *
 * Read the BUDGET NOTE in `integration.client.ts` before adding DDP calls
 * here: the whole browser suite shares one connection and therefore one
 * rate-limit counter.
 */

/** Not `agent-chat`: the default name belongs to apps, and one of the tests
 *  below asserts that importing this package leaves it unregistered. */
const TAG = 'agent-chat-itest';

const waitFor = (
  label: string, ms: number, predicate: () => boolean,
): Promise<void> => new Promise<void>((resolve, reject) => {
  const deadline = Date.now() + ms;
  const poll = setInterval(() => {
    let ok = false;
    try { ok = predicate(); } catch (e) { clearInterval(poll); reject(e); return; }
    if (ok) { clearInterval(poll); resolve(); }
    else if (Date.now() > deadline) {
      clearInterval(poll);
      reject(new Error(`timed out waiting for ${label}`));
    }
  }, 50);
});

type ChatElement = HTMLElement & {
  sessionId: string | null;
  agentInstance: { messages(sessionId: string): { fetch(): any[] } } | null;
};

const mounted: ChatElement[] = [];

function mount(attrs: Record<string, string>): ChatElement {
  const el = document.createElement(TAG) as ChatElement;
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  document.body.appendChild(el);
  mounted.push(el);
  return el;
}

/** One shadow node by part token. `~=` matches a whole token in the
 *  space-separated `part` list, which is exactly how `::part()` matches. */
const part = <T extends HTMLElement>(el: ChatElement, token: string): T =>
  el.shadowRoot!.querySelector(`[part~="${token}"]`) as T;

const partsAll = (el: ChatElement, token: string): HTMLElement[] =>
  Array.from(el.shadowRoot!.querySelectorAll(`[part~="${token}"]`)) as HTMLElement[];

/** Text of every transcript row carrying `token`, minus the in-flight ones
 *  (an assistant bubble is `message assistant` once committed and `message
 *  assistant streaming` while it is still arriving). */
const committed = (el: ChatElement, token: string): string[] =>
  partsAll(el, token)
    .filter((n) => !(n.getAttribute('part') ?? '').split(' ').includes('streaming'))
    .map((n) => n.textContent ?? '');

/** Type into the element's own composer and press its own Send button — the
 *  wiring under test is the form, not `Agent.send`. */
function say(el: ChatElement, text: string) {
  part<HTMLInputElement>(el, 'input').value = text;
  part<HTMLButtonElement>(el, 'send').click();
}

describe('<agent-chat>', () => {
  /** Set by the streaming test and reused by the teardown test, which mounts
   *  against the SAME session so it needs neither a `start` nor a `send`. */
  let streamedSession: string | null = null;

  before(() => { defineAgentChat(TAG); });

  afterEach(() => {
    while (mounted.length) mounted.pop()!.remove();
  });

  it('never registers itself, and defineAgentChat is idempotent per tag', () => {
    // The whole reason registration is the app's call: a package that defined
    // `agent-chat` on import would squat the name in every app depending on
    // it, and the second definition of a name is a hard DOMException.
    assert.isUndefined(
      customElements.get('agent-chat'),
      'importing the package must not register the default tag',
    );

    const first = defineAgentChat(TAG);
    assert.strictEqual(customElements.get(TAG), first);
    assert.strictEqual(defineAgentChat(TAG), first, 'a repeat define is a no-op');

    const alt = defineAgentChat(`${TAG}-alt`);
    assert.isFunction(alt);
    assert.notStrictEqual(
      alt, first,
      'a different tag must get a fresh class — customElements refuses to reuse one',
    );
  });

  it('auto-starts a session, announces it, and streams a reply into the shadow DOM', async function () {
    this.timeout(60000);
    await Meteor.callAsync('itest.reset');

    const announced: string[] = [];
    const el = document.createElement(TAG) as ChatElement;
    // Listen BEFORE connecting: the auto-start begins on connectedCallback.
    el.addEventListener('agent-chat:session', (e: Event) => {
      announced.push((e as CustomEvent).detail.sessionId);
    });
    el.setAttribute('agent', 'itest');
    el.setAttribute('placeholder', 'say something');
    document.body.appendChild(el);
    mounted.push(el);

    await waitFor('the element to auto-start a session', 30000, () => !!el.sessionId);
    streamedSession = el.sessionId;
    assert.deepEqual(
      announced, [streamedSession],
      'auto-start must emit agent-chat:session exactly once, carrying the id it opened',
    );
    assert.equal(
      part<HTMLInputElement>(el, 'input').placeholder, 'say something',
      'the placeholder attribute must reach the composer',
    );

    say(el, 'hello');
    await waitFor('the user bubble', 30000, () => committed(el, 'user').includes('hello'));

    // The in-flight row exists only while the turn streams (the server fixture
    // paces the mock provider for exactly this reason), so it has to be caught
    // as it goes by. Its `streaming` part token is what a host styles the
    // cursor with, so its existence is the assertion.
    let cursor: string | null = null;
    const capture = setInterval(() => {
      const row = el.shadowRoot!.querySelector('[part~="assistant"][part~="streaming"]');
      if (row) cursor = row.textContent ?? '';
    }, 50);
    try {
      await waitFor('the committed assistant bubble', 30000, () =>
        committed(el, 'assistant').some((t) => t.length > 0));
    } finally {
      clearInterval(capture);
    }

    assert.deepEqual(committed(el, 'assistant'), ['live streamed reply']);
    assert.isNotNull(cursor, 'no in-flight row was ever rendered — deltas never reached the DOM');
    assert.isTrue(
      'live streamed reply'.startsWith(cursor!),
      `the in-flight row must render a prefix of the final text, got "${cursor}"`,
    );

    await waitFor('the phase badge to settle', 30000, () =>
      part(el, 'phase').textContent === 'idle');
    assert.include(
      (part(el, 'phase').getAttribute('part') ?? '').split(' '), 'idle',
      'the phase badge must expose the phase as a part token, not only as text',
    );
    assert.isTrue(part(el, 'approval').hidden, 'nothing is parked, so the bar stays hidden');
  });

  it('parks on a gated tool and resolves it through the approval bar buttons', async function () {
    this.timeout(60000);
    const el = mount({ agent: 'itest-gate' });
    await waitFor('the gated element to start', 30000, () => !!el.sessionId);

    say(el, 'refund order A-1');

    const bar = part(el, 'approval');
    await waitFor('the approval bar to appear', 30000, () => !bar.hidden);
    assert.include(
      part(el, 'approval-text').textContent ?? '', 'refund',
      'the bar must name the tool the agent wants to run',
    );
    assert.equal(part(el, 'phase').textContent, 'awaiting');

    part<HTMLButtonElement>(el, 'approve').click();

    await waitFor('the approval note', 30000, () =>
      committed(el, 'note').some((t) => t.startsWith('Approved')));
    await waitFor('the follow-up reply', 30000, () =>
      committed(el, 'assistant').includes('all done'));

    // The tool row is the one place the element improves on the raw
    // transcript: a `role: 'tool'` message carries only a toolCallId, so the
    // name comes from the assistant row that requested it.
    assert.include(part(el, 'tool-name').textContent ?? '', 'refund');
    assert.include(part(el, 'tool-content').textContent ?? '', 'refunded');
    assert.isTrue(bar.hidden, 'the bar must retract once the verdict is in');
  });

  it('tears down on disconnect, and re-mounts clean', async function () {
    this.timeout(60000);
    assert.isString(streamedSession, 'this test replays the streaming test\'s session');

    const announced: string[] = [];
    const el = document.createElement(TAG) as ChatElement;
    el.addEventListener('agent-chat:session', (e: Event) => {
      announced.push((e as CustomEvent).detail.sessionId);
    });
    el.setAttribute('agent', 'itest');
    el.setAttribute('session-id', streamedSession!);
    document.body.appendChild(el);
    mounted.push(el);

    await waitFor('the transcript to arrive over DDP', 30000, () =>
      committed(el, 'assistant').includes('live streamed reply'));
    assert.deepEqual(announced, [], 'a session-id was given, so nothing was auto-started');

    const instance = el.agentInstance!;
    assert.isNotNull(instance);

    el.remove();

    // Three observations, because "it stopped" has three halves: the Agent is
    // released, the merged view it maintained is emptied (which is what
    // `Agent.stop()` guarantees, and the only externally visible proof the
    // subscription and the merge computation are gone), and the shadow DOM
    // repaints to match rather than leaving a dead transcript on screen.
    assert.isNull(el.agentInstance, 'disconnectedCallback must release the Agent');
    assert.lengthOf(
      instance.messages(streamedSession!).fetch(), 0,
      'disconnect must stop the subscription and clear the merged view',
    );
    assert.lengthOf(
      el.shadowRoot!.querySelectorAll('[part~="message"]'), 0,
      'and the shadow DOM must repaint empty',
    );

    // Not one-way: a fresh element on the same session rebuilds both halves,
    // with no `start` and no `send` — the cheapest possible proof that the
    // teardown left nothing broken behind it.
    const again = mount({ agent: 'itest', 'session-id': streamedSession! });
    await waitFor('the re-mounted element to repopulate', 30000, () =>
      committed(again, 'assistant').includes('live streamed reply'));
    assert.include(committed(again, 'user'), 'hello');
  });

  it('renders message text as TEXT — markup in a transcript is never parsed', async function () {
    this.timeout(60000);
    // Reuses the streaming test's session rather than starting a new one, per
    // the budget note at the top of this file: this costs the shared
    // rate-limit counter one `agent.send` and no `agent.start`.
    assert.isString(streamedSession, 'this test replays the streaming test\'s session');

    // Every transcript string reaches the DOM through `textContent`
    // (client/element.ts), and this is the assertion that keeps it that way: a
    // single `innerHTML =` anywhere in `renderRow` turns a chat bubble into an
    // XSS sink, and the content is attacker-influenced by definition — it is
    // whatever a user typed or a model (or a tool result) echoed back.
    const PAYLOAD = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
    const el = mount({ agent: 'itest', 'session-id': streamedSession! });
    await waitFor('the transcript to arrive over DDP', 30000, () =>
      committed(el, 'assistant').includes('live streamed reply'));

    say(el, PAYLOAD);
    await waitFor('the payload to render as a user bubble', 30000, () =>
      committed(el, 'user').includes(PAYLOAD));

    // Verbatim, in the row's TEXT: nothing was stripped or escaped away
    // either — an element that silently ate the markup would be a different
    // bug, and just as wrong.
    const row = partsAll(el, 'user').find((n) => n.textContent === PAYLOAD);
    assert.isDefined(row, 'the raw text must survive verbatim in the row');

    assert.lengthOf(
      el.shadowRoot!.querySelectorAll('img, script'), 0,
      'markup in a message must never become nodes in the shadow tree',
    );
    assert.isUndefined(
      (window as any).__xss,
      'and nothing in it may execute — no onerror, no inline script',
    );
  });
});
