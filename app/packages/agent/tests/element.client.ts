import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import {
  defineAgentChat,
  isStructuredAssistantContent,
  sanitizeCleanAssistantContent,
} from '../client/element';

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
  composerMode: 'ask' | 'note';
  agentInstance: {
    messages(sessionId: string): { fetch(): any[] };
    session(sessionId: string): any;
    send(sessionId: string, text: string): Promise<string>;
    contribute(sessionId: string, text: string): Promise<string>;
    approve(sessionId: string, expectedToolCallId?: string): Promise<void>;
    deny(sessionId: string, reason?: string, expectedToolCallId?: string): Promise<void>;
  } | null;
  mentionSources: Record<string, any>;
};

/** A stand-in for a live collection: the two calls the element makes, and a
 *  setter so a test can change what it holds mid-run. */
function fakeCollection(rows: unknown[]) {
  let docs = rows;
  return {
    find: (_sel: unknown, _opts: unknown) => ({ fetch: () => docs }),
    set: (next: unknown[]) => { docs = next; },
  };
}

const mounted: ChatElement[] = [];

function mount(attrs: Record<string, string>): ChatElement {
  const el = document.createElement(TAG) as ChatElement;
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  document.body.appendChild(el);
  mounted.push(el);
  return el;
}

let transcriptFixture = 0;

/** Paint durable rows through the element's public transcript surface without
 *  spending a live DDP method call. The Agent is still real; only its
 *  collection-shaped read boundary is replaced for this element instance. */
function mountTranscript(rows: any[], attrs: Record<string, string> = {}): ChatElement {
  transcriptFixture += 1;
  const el = mount({
    agent: 'itest',
    'session-id': `element-render-${transcriptFixture}`,
    ...attrs,
  });
  const client = el.agentInstance!;
  client.messages = () => ({ fetch: () => rows });
  // The public mention-source setter performs the same synchronous repaint a
  // Tracker invalidation would, while keeping these tests independent of DDP.
  el.mentionSources = el.mentionSources;
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

  it('classifies whole assistant JSON without mistaking inline braces for a payload', () => {
    assert.isTrue(isStructuredAssistantContent('{"status":"internal","items":[1,2]}'));
    assert.isTrue(isStructuredAssistantContent('[{"id":1}]'));
    assert.isTrue(isStructuredAssistantContent('"machine string"'));
    assert.isTrue(isStructuredAssistantContent('true'));
    assert.isTrue(isStructuredAssistantContent('```json\n{"raw":true}\n```'));
    assert.isTrue(isStructuredAssistantContent('```\n[{"raw":true}]\n```'));

    assert.isFalse(isStructuredAssistantContent(''));
    assert.isFalse(isStructuredAssistantContent('Use {accountId} when the tool runs.'));
    assert.isFalse(isStructuredAssistantContent('Result: {"ok":true}'));
    assert.isFalse(isStructuredAssistantContent('```js\nconst value = { ok: true };\n```'));
  });

  it('cleans embedded machine fragments while preserving ordinary prose', () => {
    assert.equal(
      sanitizeCleanAssistantContent(
        'Research is back… "Research synthesis\\n\\n1. First finding\\n2. Second finding"',
      ),
      'Research is back… Research synthesis\n\n1. First finding\n2. Second finding',
      'a complete JSON-encoded string fragment becomes readable text',
    );
    assert.equal(
      sanitizeCleanAssistantContent(
        'Research is back… "Research synthesis\\n\\n1. First finding',
      ),
      'Research is back… Research synthesis\n\n1. First finding',
      'a truncated JSON string still decodes its escaped newlines',
    );
    assert.equal(
      sanitizeCleanAssistantContent('Research is back… "Line one\\\\n\\\\nLine two'),
      'Research is back… Line one\n\nLine two',
      'double-encoded line breaks do not survive as visible backslash escapes',
    );
    assert.equal(
      sanitizeCleanAssistantContent('Note: "caf\\u00e9\\nready"'),
      'Note: café\nready',
    );
    assert.equal(
      sanitizeCleanAssistantContent(
        'Summary: {"status":"internal","items":[1,2]} Continue.',
      ),
      'Summary: Structured data hidden Continue.',
      'an embedded object payload is replaced as a unit',
    );
    assert.equal(
      sanitizeCleanAssistantContent('Candidates: [{"id":1},{"id":2}].'),
      'Candidates: Structured data hidden.',
      'an embedded array payload is replaced as a unit',
    );
    assert.equal(
      sanitizeCleanAssistantContent('Partial: {"secret":"value"'),
      'Partial: Structured data hidden',
      'an unfinished object payload fails closed',
    );
    assert.equal(
      sanitizeCleanAssistantContent('Streaming: {"secret"', true),
      'Streaming: Structured data hidden',
      'a streaming payload is hidden before enough bytes arrive to parse it',
    );
    assert.equal(
      sanitizeCleanAssistantContent(
        'Payload: "Result: {\\"ok\\":true}\\nDone"',
      ),
      'Payload: Result: Structured data hidden\nDone',
      'structured data revealed by decoding is suppressed in the same pass',
    );

    assert.equal(
      sanitizeCleanAssistantContent('Use {accountId} when the tool runs.'),
      'Use {accountId} when the tool runs.',
    );
    assert.equal(
      sanitizeCleanAssistantContent('She said "ship it" before lunch.'),
      'She said "ship it" before lunch.',
    );
    assert.equal(
      sanitizeCleanAssistantContent('She said "use {accountId}" before lunch.'),
      'She said "use {accountId}" before lunch.',
    );
    assert.equal(
      sanitizeCleanAssistantContent('This object-shaped example is { ok: true }.'),
      'This object-shaped example is { ok: true }.',
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

  it('switches the composer between waking asks and non-waking crew notes', async function () {
    this.timeout(30000);
    assert.isString(streamedSession);
    const el = mount({ agent: 'itest', 'session-id': streamedSession! });
    await waitFor('the existing session to arrive', 30000, () =>
      committed(el, 'assistant').includes('live streamed reply'));

    const input = part<HTMLInputElement>(el, 'input');
    const send = part<HTMLButtonElement>(el, 'send');
    assert.equal(el.composerMode, 'ask');
    assert.equal(input.placeholder, 'Message the agent…');
    assert.equal(input.getAttribute('aria-label'), 'Message the agent');
    assert.equal(send.textContent, 'Send');
    assert.include((part(el, 'composer').getAttribute('part') ?? '').split(' '), 'ask');

    const client = el.agentInstance!;
    const liveSend = client.send.bind(client);
    const liveContribute = client.contribute.bind(client);
    const calls: Array<{ mode: string; sessionId: string; text: string }> = [];
    client.send = async (sessionId, text) => {
      calls.push({ mode: 'ask', sessionId, text });
      return sessionId;
    };
    client.contribute = async (sessionId, text) => {
      calls.push({ mode: 'note', sessionId, text });
      return sessionId;
    };
    const receipts: string[] = [];
    el.addEventListener('agent-chat:submitted', (event: Event) => {
      receipts.push((event as CustomEvent).detail.mode);
    });
    try {
      let resolveAsk!: (sessionId: string) => void;
      client.send = (sessionId, text) => {
        calls.push({ mode: 'ask', sessionId, text });
        return new Promise<string>((resolve) => { resolveAsk = resolve; });
      };
      say(el, 'Run this once');
      assert.lengthOf(calls, 1, 'the first ask is issued immediately');
      assert.isTrue(input.disabled);
      assert.isTrue(send.disabled);
      assert.equal(send.textContent, 'Sending…');
      assert.equal(send.dataset.loading, 'true');
      assert.equal(part(el, 'composer').getAttribute('aria-busy'), 'true');
      assert.include((send.getAttribute('part') ?? '').split(' '), 'loading');
      // A programmatic submit can bypass a disabled button; the internal guard
      // is the final duplicate boundary.
      input.value = 'duplicate attempt';
      part<HTMLFormElement>(el, 'composer').dispatchEvent(new Event('submit', {
        bubbles: true, cancelable: true,
      }));
      assert.lengthOf(calls, 1, 'a second submit while busy is ignored');
      input.value = '';
      resolveAsk(streamedSession!);
      await waitFor('the ask controls to recover', 1000, () => !send.disabled);
      assert.equal(send.textContent, 'Send');
      assert.equal(part(el, 'composer').getAttribute('aria-busy'), 'false');
      assert.deepEqual(receipts, ['ask']);

      el.composerMode = 'note';
      assert.equal(el.getAttribute('composer-mode'), 'note');
      assert.equal(input.placeholder, 'Add a crew note…');
      assert.equal(input.getAttribute('aria-label'), 'Add a crew note');
      assert.equal(send.textContent, 'Add note');
      assert.include((part(el, 'composer').getAttribute('part') ?? '').split(' '), 'note');
      let resolveNote!: (sessionId: string) => void;
      client.contribute = (sessionId, text) => {
        calls.push({ mode: 'note', sessionId, text });
        return new Promise<string>((resolve) => { resolveNote = resolve; });
      };
      say(el, 'Decision is due Friday.');
      assert.deepEqual(calls[1], {
        mode: 'note', sessionId: streamedSession!, text: 'Decision is due Friday.',
      });
      assert.isTrue(input.disabled);
      assert.isTrue(send.disabled);
      assert.equal(send.textContent, 'Adding note…');
      assert.equal(send.dataset.loading, 'true');
      resolveNote(streamedSession!);
      await waitFor('the note controls to recover', 1000, () => !send.disabled);
      assert.equal(send.textContent, 'Add note');
      assert.deepEqual(receipts, ['ask', 'note']);

      el.setAttribute('composer-mode', 'unknown');
      assert.equal(el.composerMode, 'ask', 'invalid values fail closed to the waking path');
      assert.equal(send.textContent, 'Send');

      el.composerMode = 'note';
      let rejectNote!: (error: Error) => void;
      client.contribute = () => new Promise<string>((_resolve, reject) => {
        rejectNote = reject;
      });
      say(el, 'Keep this draft');
      assert.equal(send.textContent, 'Adding note…');
      assert.isTrue(input.disabled);
      rejectNote(new Error('offline'));
      await waitFor('the failed note to restore its draft', 1000, () => (
        input.value !== '' && !input.disabled && !send.disabled
      ));
      assert.equal(input.value, 'Keep this draft');
      assert.equal(send.textContent, 'Add note');
    } finally {
      client.send = liveSend;
      client.contribute = liveContribute;
    }
  });

  it('parks on a gated tool and resolves it through the approval bar buttons', async function () {
    this.timeout(60000);
    const el = mount({ agent: 'itest-gate' });
    await waitFor('the gated element to start', 30000, () => !!el.sessionId);

    say(el, 'refund order A-1');

    const bar = part(el, 'approval');
    await waitFor('the approval bar to appear', 30000, () => !bar.hidden);
    // Every part below is a public styling seam, not an implementation-class
    // query. Keep the whole approval card themeable without asking a host to
    // pierce the shadow root or treat the aggregate text as one opaque blob.
    for (const token of [
      'approval-signal', 'approval-text', 'approval-kicker', 'approval-title',
      'approval-summary', 'approval-meta', 'approval-tool', 'approval-identity',
      'approval-requester', 'approval-source', 'approval-scope', 'approval-status',
      'approval-guidance', 'approval-guidance-label', 'deny-guidance',
      'approval-debug', 'approval-actions', 'deny', 'approve',
    ]) {
      assert.exists(part(el, token), `the approval surface must expose ::part(${token})`);
    }
    assert.equal(bar.getAttribute('role'), 'region');
    assert.equal(
      bar.getAttribute('aria-labelledby'),
      'agent-chat-approval-kicker agent-chat-approval-title',
    );
    assert.equal(
      bar.getAttribute('aria-describedby'),
      'agent-chat-approval-summary agent-chat-approval-meta agent-chat-approval-status',
    );
    assert.isNull(
      bar.getAttribute('aria-live'),
      'the whole interactive region must not be re-announced on every status update',
    );
    assert.isNull(bar.getAttribute('aria-atomic'));
    assert.equal(part(el, 'approval-kicker').id, 'agent-chat-approval-kicker');
    assert.equal(part(el, 'approval-title').id, 'agent-chat-approval-title');
    assert.equal(part(el, 'approval-summary').id, 'agent-chat-approval-summary');
    assert.equal(part(el, 'approval-meta').id, 'agent-chat-approval-meta');
    assert.equal(part(el, 'approval-signal').getAttribute('aria-hidden'), 'true');
    assert.equal(part(el, 'approval-kicker').textContent, 'Approval required');
    assert.include(
      part(el, 'approval-title').textContent ?? '', 'Refund',
      'the decision title must name the action the agent wants to take',
    );
    assert.include(
      part(el, 'approval-summary').textContent ?? '', 'Order: A-1',
      'clean mode must put bounded human context in its dedicated summary',
    );
    assert.notInclude(
      part(el, 'approval-summary').textContent ?? '', '"order"',
      'clean mode must never put raw argument JSON in front of an operator',
    );
    // …and WHO it will run as. The fixture's tool carries `runAs`, so the
    // approver is authorizing an escalation, not an ordinary call — free to
    // assert here (no extra DDP calls, see the budget note above) and the only
    // end-to-end proof that `pending.runAs` survives park, publication and
    // render.
    assert.include(
      part(el, 'approval-identity').textContent ?? '', 'refund-service',
      'a parked tool with runAs must say so in front of the approver',
    );
    assert.include(
      (part(el, 'approval-identity').getAttribute('part') ?? '').split(' '), 'elevated',
      'an explicit runAs identity must expose its escalated styling state',
    );
    assert.include(part(el, 'approval-tool').textContent ?? '', 'Refund');
    assert.include(part(el, 'approval-requester').textContent ?? '', 'Itest gate');
    assert.equal(part(el, 'approval-source').textContent, 'App tool');
    assert.equal(part(el, 'approval-scope').textContent, 'One call');
    assert.include(part(el, 'approval-status').textContent ?? '', 'mission can continue');
    assert.equal(part(el, 'approval-status').id, 'agent-chat-approval-status');
    assert.equal(part(el, 'approval-status').getAttribute('role'), 'status');
    assert.equal(part(el, 'approval-status').getAttribute('aria-live'), 'polite');
    assert.equal(part(el, 'approval-status').getAttribute('aria-atomic'), 'true');
    assert.equal(bar.dataset.state, 'pending');
    assert.include((bar.getAttribute('part') ?? '').split(' '), 'pending');
    const debug = part(el, 'approval-debug');
    assert.isTrue(debug.hidden, 'clean mode keeps the exact record collapsed');
    assert.equal(debug.textContent, '', 'clean mode leaves no raw record in the DOM');
    const deny = part<HTMLButtonElement>(el, 'deny');
    const approve = part<HTMLButtonElement>(el, 'approve');
    const guidance = part<HTMLInputElement>(el, 'deny-guidance');
    const stop = part<HTMLButtonElement>(el, 'stop');
    const recovery = part(el, 'recovery');
    assert.equal(deny.textContent, 'Don’t allow');
    assert.equal(approve.textContent, 'Approve once');
    assert.equal(guidance.value, '');
    assert.equal(guidance.placeholder, 'What should the agent do instead?');
    assert.isFalse(guidance.disabled, 'corrective guidance is optional, not a prerequisite');
    assert.equal(bar.getAttribute('aria-busy'), 'false');
    assert.isFalse(deny.disabled);
    assert.isFalse(approve.disabled);
    assert.equal(part(el, 'phase').textContent, 'awaiting');
    assert.isTrue(stop.hidden, 'an approval wait is not interruptible from the Stop control');
    assert.isTrue(stop.disabled);
    assert.isTrue(recovery.hidden);

    // `pending` is durable audit/recovery state, not sufficient proof that a
    // decision is actionable. Repaint this already-published ask as stopped,
    // without another method/subscription call, then restore the live view.
    const client = el.agentInstance!;
    const liveSession = client.session.bind(client);
    client.session = (sessionId: string) => {
      const session = liveSession(sessionId);
      return session ? { ...session, phase: 'stopped' } : session;
    };
    try {
      el.mentionSources = el.mentionSources; // synchronous repaint, zero DDP
      assert.equal(part(el, 'phase').textContent, 'stopped');
      assert.isTrue(bar.hidden, 'a retained ask outside awaiting must not render as actionable');
      assert.isTrue(approve.disabled);
      assert.isTrue(deny.disabled);
      assert.isTrue(stop.hidden);
      assert.isTrue(stop.disabled);
      assert.isFalse(recovery.hidden);
      assert.equal(recovery.textContent, 'Turn stopped. Send a message to continue.');

      for (const activePhase of ['streaming', 'calling', 'retrying', 'compacting']) {
        client.session = (id: string) => {
          const active = liveSession(id);
          return active ? {
            ...active,
            phase: activePhase,
            ...(activePhase === 'calling'
              ? { activeChild: { sessionId: 'child-live', toolCallId: 'child-call' } }
              : {}),
          } : active;
        };
        el.mentionSources = el.mentionSources;
        assert.isFalse(stop.hidden, `${activePhase} exposes the interrupt control`);
        assert.isFalse(stop.disabled, `${activePhase} makes Stop actionable`);
        assert.isTrue(recovery.hidden, `${activePhase} is not a recovery state`);
      }

      for (const settledPhase of ['idle', 'awaiting']) {
        client.session = (id: string) => {
          const settled = liveSession(id);
          return settled ? { ...settled, phase: settledPhase } : settled;
        };
        el.mentionSources = el.mentionSources;
        assert.isTrue(stop.hidden, `${settledPhase} must not offer a dead Stop action`);
        assert.isTrue(stop.disabled);
        assert.isTrue(recovery.hidden);
      }

      client.session = (id: string) => {
        const failed = liveSession(id);
        return failed ? { ...failed, phase: 'error' } : failed;
      };
      el.mentionSources = el.mentionSources;
      assert.isTrue(stop.hidden);
      assert.isTrue(stop.disabled);
      assert.isFalse(recovery.hidden);
      assert.equal(
        recovery.textContent,
        'Turn failed. Review the error and send a message to retry.',
      );
    } finally {
      client.session = liveSession;
      el.mentionSources = el.mentionSources;
    }
    assert.equal(part(el, 'phase').textContent, 'awaiting');
    assert.isFalse(bar.hidden);
    assert.isFalse(approve.disabled);
    assert.isFalse(deny.disabled);
    assert.isTrue(stop.hidden);
    assert.isTrue(recovery.hidden);

    // A tool's human description is advisory and can accidentally embed its
    // machine payload. Exercise the clean boundary against the already-live
    // ask; changing this local view and repainting performs no DDP call.
    client.session = (sessionId: string) => {
      const session = liveSession(sessionId);
      return session ? {
        ...session,
        pending: { ...session.pending, display: 'Approve {"token":"secret"}' },
      } : session;
    };
    try {
      el.mentionSources = el.mentionSources;
      assert.include(part(el, 'approval-summary').textContent ?? '', 'Structured data hidden');
      assert.notInclude(part(el, 'approval-text').textContent ?? '', '"token"');
      assert.notInclude(part(el, 'approval-text').textContent ?? '', 'secret');
    } finally {
      client.session = liveSession;
      el.mentionSources = el.mentionSources;
    }
    assert.include(part(el, 'approval-summary').textContent ?? '', 'Order: A-1');

    // Debug is explicit and reversible. It is the only mode that renders the
    // exact approval record; returning to clean removes it synchronously.
    el.setAttribute('verbosity', 'debug');
    assert.isFalse(debug.hidden);
    assert.include(debug.textContent ?? '', '"order": "A-1"');
    assert.notInclude(part(el, 'approval-summary').textContent ?? '', '"order"');
    el.setAttribute('verbosity', 'clean');
    assert.isTrue(debug.hidden);
    assert.equal(debug.textContent, '');

    // A denial remains one click when no correction is needed. When guidance
    // is supplied, it is bounded to this exact displayed call. Stub only the
    // transport so this proof adds no verdict to the shared DDP budget.
    const displayedToolCallId = client.session(el.sessionId!).pending.toolCallId;
    const liveDeny = client.deny.bind(client);
    let submittedDenial: {
      sessionId: string; reason?: string; expectedToolCallId?: string;
    } | null = null;
    guidance.value = 'Use the read-only lookup instead.';
    client.deny = async (sessionId, reason, expectedToolCallId) => {
      submittedDenial = { sessionId, reason, expectedToolCallId };
    };
    deny.click();
    assert.deepEqual(submittedDenial, {
      sessionId: el.sessionId!,
      reason: 'Use the read-only lookup instead.',
      expectedToolCallId: displayedToolCallId,
    });
    assert.equal(bar.dataset.state, 'denying');
    assert.isTrue(guidance.disabled);
    await waitFor('the local denial proof to settle', 1000, () =>
      bar.getAttribute('aria-busy') === 'false');

    guidance.value = '';
    assert.isFalse(deny.disabled, 'blank optional guidance still leaves immediate denial enabled');
    submittedDenial = null;
    deny.click();
    assert.deepEqual(submittedDenial, {
      sessionId: el.sessionId!,
      reason: 'denied by the user',
      expectedToolCallId: displayedToolCallId,
    });
    await waitFor('the immediate denial proof to settle', 1000, () =>
      bar.getAttribute('aria-busy') === 'false');
    client.deny = liveDeny;

    // The network promise cannot be the feedback mechanism: the decision must
    // look pending in the same click turn. This is still the test's ONE verdict
    // call, preserving the shared live-DDP budget.
    const liveApprove = client.approve.bind(client);
    let submittedToolCallId: string | undefined;
    client.approve = (sessionId: string, expectedToolCallId?: string) => {
      submittedToolCallId = expectedToolCallId;
      return liveApprove(sessionId, expectedToolCallId);
    };
    approve.click();
    client.approve = liveApprove;
    assert.equal(
      submittedToolCallId, displayedToolCallId,
      'the click must authorize the exact call rendered, never a replacement ask',
    );
    assert.equal(bar.getAttribute('aria-busy'), 'true');
    assert.isTrue(approve.disabled);
    assert.isTrue(deny.disabled, 'the opposite verdict must lock while approval is in flight');
    assert.equal(approve.dataset.loading, 'true');
    assert.equal(bar.dataset.state, 'approving');
    assert.include((bar.getAttribute('part') ?? '').split(' '), 'approving');
    assert.include(part(el, 'approval-status').textContent ?? '', 'Approving this call');
    assert.include((approve.getAttribute('part') ?? '').split(' '), 'loading');
    assert.equal(approve.textContent, 'Approving…');
    assert.equal(deny.dataset.loading, 'false');
    assert.notInclude((deny.getAttribute('part') ?? '').split(' '), 'loading');

    await waitFor('the approval note', 30000, () =>
      committed(el, 'note').some((t) => t.startsWith('Approved')));
    await waitFor('the follow-up reply', 30000, () =>
      committed(el, 'assistant').includes('all done'));

    // Clean is the DEFAULT. It keeps useful operational receipts but no raw
    // tool row, raw args, or raw result payload reaches the DOM.
    assert.lengthOf(partsAll(el, 'tool'), 0);
    assert.lengthOf(partsAll(el, 'tool-calls'), 0);
    const cleanOperations = partsAll(el, 'operation').map((node) => node.textContent ?? '');
    assert.isTrue(cleanOperations.some((text) => text.includes('Refund requested')));
    assert.isTrue(cleanOperations.some((text) => text.includes('Refund completed')));
    const cleanTranscript = part(el, 'messages').textContent ?? '';
    assert.notInclude(cleanTranscript, '"order"');
    assert.notInclude(cleanTranscript, '"refunded"');
    assert.notInclude(cleanTranscript, '"amount"');
    assert.isTrue(bar.hidden, 'the bar must retract once the verdict is in');
    assert.equal(bar.getAttribute('aria-busy'), 'false');
    assert.isTrue(approve.disabled, 'a retracted decision cannot be clicked again');
    assert.isTrue(deny.disabled);
    assert.equal(approve.dataset.loading, 'false');
    assert.notInclude((approve.getAttribute('part') ?? '').split(' '), 'loading');
    assert.equal(approve.textContent, 'Approve once');

    el.setAttribute('verbosity', 'debug');
    assert.include(part(el, 'tool-name').textContent ?? '', 'refund');
    assert.include(part(el, 'tool-content').textContent ?? '', '"refunded":true');
    assert.include(part(el, 'tool-calls').textContent ?? '', '"order":"A-1"');

    // VERBOSITY, on the session this test already built — it is the only one
    // with the shape that matters (a tool-calling assistant row, a tool result,
    // and a real reply) and re-driving one would spend the shared DDP budget
    // this file's header warns about. The attribute only re-paints, so the
    // assertions below are synchronous.
    el.setAttribute('verbosity', 'quiet');
    assert.lengthOf(partsAll(el, 'tool'), 0, 'quiet drops the tool result row');
    assert.lengthOf(partsAll(el, 'tool-calls'), 0, 'and the → name({…}) trace');
    // The subtle one: an assistant row that ONLY called tools has no text of
    // its own, so hiding the trace alone would leave an empty bubble behind.
    assert.isTrue(
      committed(el, 'assistant').every((t) => t.trim() !== ''),
      'quiet leaves no empty assistant bubble where a tool-only turn was',
    );
    assert.include(
      committed(el, 'assistant'), 'all done',
      'the actual reply is the thing quiet keeps',
    );
    assert.isTrue(
      committed(el, 'note').some((t) => t.startsWith('Approved')),
      'and an approval note is never quiet — it is why a person was needed',
    );

    // Legacy `full` is the compatibility alias for explicit `debug`: exact
    // records come back, without mutating the transcript.
    el.setAttribute('verbosity', 'full');
    assert.include(part(el, 'tool-content').textContent ?? '', 'refunded');
    assert.isAbove(partsAll(el, 'tool-calls').length, 0);
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

  it('renders common assistant Markdown as semantic, themeable content', () => {
    const markdown = [
      '## Release notes',
      '',
      '- **Fast** startup',
      '- *Safe* output',
      '',
      'Use `npm test` before release.',
      '',
      '```typescript',
      'const answer: number = 42;',
      '```',
    ].join('\n');
    const el = mountTranscript([{
      _id: 'markdown-common', sessionId: 'element-render', seq: 1,
      role: 'assistant', content: markdown, createdAt: new Date(),
    }]);
    const row = part(el, 'assistant');
    const content = row.querySelector<HTMLElement>('[part~="markdown"]');
    assert.exists(content, 'assistant prose exposes one Markdown styling boundary');

    const heading = content!.querySelector<HTMLElement>('h2');
    assert.equal(heading?.textContent, 'Release notes');
    assert.include((heading?.getAttribute('part') ?? '').split(' '), 'markdown-heading');

    const list = content!.querySelector<HTMLElement>('ul');
    assert.exists(list);
    assert.include((list?.getAttribute('part') ?? '').split(' '), 'markdown-list');
    const items = Array.from(list!.querySelectorAll<HTMLElement>('li'));
    assert.deepEqual(items.map((item) => item.textContent), ['Fast startup', 'Safe output']);
    assert.isTrue(items.every((item) => (
      (item.getAttribute('part') ?? '').split(' ').includes('markdown-list-item')
    )));

    const strong = content!.querySelector<HTMLElement>('strong');
    const emphasis = content!.querySelector<HTMLElement>('em');
    assert.equal(strong?.textContent, 'Fast');
    assert.include((strong?.getAttribute('part') ?? '').split(' '), 'markdown-strong');
    assert.equal(emphasis?.textContent, 'Safe');
    assert.include((emphasis?.getAttribute('part') ?? '').split(' '), 'markdown-emphasis');

    const inlineCode = content!.querySelector<HTMLElement>('p code');
    assert.equal(inlineCode?.textContent, 'npm test');
    assert.include((inlineCode?.getAttribute('part') ?? '').split(' '), 'markdown-inline-code');

    const block = content!.querySelector<HTMLElement>('pre');
    const code = block?.querySelector<HTMLElement>('code');
    assert.exists(block);
    assert.include((block?.getAttribute('part') ?? '').split(' '), 'markdown-code-block');
    assert.equal(code?.textContent?.trimEnd(), 'const answer: number = 42;');
    assert.equal(code?.dataset.language, 'typescript');
    assert.include((code?.getAttribute('part') ?? '').split(' '), 'markdown-code');
    const language = content!.querySelector<HTMLElement>('[part~="markdown-language"]');
    assert.equal(language?.textContent, 'typescript');
  });

  it('renders safe Markdown links with hardened navigation metadata', () => {
    const el = mountTranscript([{
      _id: 'markdown-links', sessionId: 'element-render', seq: 1,
      role: 'assistant',
      content: '[Meteor docs](https://docs.meteor.com/) and [Support](mailto:help@example.com)',
      createdAt: new Date(),
    }]);
    const links = Array.from(
      part(el, 'assistant').querySelectorAll<HTMLAnchorElement>('[part~="markdown-link"]'),
    );
    assert.deepEqual(links.map((link) => link.textContent), ['Meteor docs', 'Support']);
    assert.deepEqual(
      links.map((link) => link.getAttribute('href')),
      ['https://docs.meteor.com/', 'mailto:help@example.com'],
    );
    for (const link of links) {
      assert.equal(link.target, '_blank');
      const rel = link.rel.split(/\s+/);
      assert.include(rel, 'noopener');
      assert.include(rel, 'noreferrer');
    }
  });

  it('keeps raw HTML inert and rejects active Markdown URL schemes', () => {
    (window as any).__markdownXss = undefined;
    const source = [
      '[Run](javascript:window.__markdownXss=1)',
      '[Load](data:text/html;base64,PHNjcmlwdD4=)',
      '[Plain HTTP](http://example.com)',
      '[Protocol relative](//example.com/path)',
      '[Credentials](https://user:pass@example.com/path)',
      '![Tracking pixel](https://tracker.example/pixel.png)',
      '<img src=x onerror="window.__markdownXss=1">',
      '<script>window.__markdownXss=1</script>',
    ].join('\n\n');
    const el = mountTranscript([{
      _id: 'markdown-hostile', sessionId: 'element-render', seq: 1,
      role: 'assistant', content: source, createdAt: new Date(),
    }]);
    const row = part(el, 'assistant');

    assert.lengthOf(row.querySelectorAll('a'), 0, 'unsafe destinations never become links');
    assert.lengthOf(
      row.querySelectorAll('img, script, iframe, object, embed, style'), 0,
      'raw HTML never becomes active shadow-DOM nodes',
    );
    assert.include(row.textContent ?? '', 'Run');
    assert.include(row.textContent ?? '', 'Load');
    assert.include(row.textContent ?? '', 'Tracking pixel');
    assert.include(row.textContent ?? '', '<img');
    assert.include(row.textContent ?? '', '<script>');
    assert.isUndefined((window as any).__markdownXss);
  });

  it('keeps user-authored Markdown and HTML literal', () => {
    (window as any).__userXss = undefined;
    const source = [
      '# User heading',
      '',
      '**literal emphasis** and [literal link](https://example.com)',
      '',
      '```javascript',
      'window.__userXss = 1;',
      '```',
      '<img src=x onerror="window.__userXss=1">',
    ].join('\n');
    const el = mountTranscript([{
      _id: 'markdown-user', sessionId: 'element-render', seq: 1,
      role: 'user', content: source, createdAt: new Date(),
    }]);
    const row = part(el, 'user');

    assert.equal(row.textContent, source, 'the user message survives byte-for-byte as text');
    assert.isNull(row.querySelector('[part~="markdown"]'));
    assert.lengthOf(
      row.querySelectorAll('h1, h2, h3, h4, h5, h6, ul, ol, li, strong, em, pre, code, a, img, script'),
      0,
      'user syntax never becomes Markdown or HTML nodes',
    );
    assert.isUndefined((window as any).__userXss);
  });

  it('sanitizes clean assistant prose before rendering its Markdown', () => {
    const source = [
      '## Summary',
      '',
      '**Status:** {"token":"secret"}',
      '',
      'Use {accountId} for the lookup.',
    ].join('\n');
    const el = mountTranscript([{
      _id: 'markdown-clean', sessionId: 'element-render', seq: 1,
      role: 'assistant', content: source, createdAt: new Date(),
    }]);
    const row = part(el, 'assistant');

    assert.equal(row.querySelector('h2')?.textContent, 'Summary');
    assert.equal(row.querySelector('strong')?.textContent, 'Status:');
    assert.include(row.textContent ?? '', 'Structured data hidden');
    assert.notInclude(row.textContent ?? '', '"token"');
    assert.notInclude(row.textContent ?? '', 'secret');
    assert.include(row.textContent ?? '', '{accountId}', 'ordinary braces remain useful prose');
  });

  it('shows a whole structured response only after debug is explicitly enabled', () => {
    const source = '```json\n{"raw":true,"token":"secret"}\n```';
    const el = mountTranscript([{
      _id: 'markdown-structured', sessionId: 'element-render', seq: 1,
      role: 'assistant', content: source, createdAt: new Date(),
    }]);

    const clean = part(el, 'assistant');
    assert.equal(part(el, 'structured-hidden').textContent, 'Structured response hidden');
    assert.notInclude(clean.textContent ?? '', '"token"');
    assert.lengthOf(clean.querySelectorAll('pre, code'), 0);

    el.setAttribute('verbosity', 'debug');
    const debug = part(el, 'assistant');
    assert.equal(debug.textContent, source, 'debug exposes the exact record as literal text');
    assert.isNull(debug.querySelector('[part~="structured-hidden"]'));
    assert.isNull(debug.querySelector('[part~="markdown"]'));
    assert.lengthOf(debug.querySelectorAll('pre, code, img, script'), 0);

    el.setAttribute('verbosity', 'clean');
    const cleanAgain = part(el, 'assistant');
    assert.equal(part(el, 'structured-hidden').textContent, 'Structured response hidden');
    assert.notInclude(cleanAgain.textContent ?? '', 'secret');
  });

  it('renders an unfinished streaming fence as inert code and upgrades cleanly on commit', () => {
    (window as any).__streamXss = undefined;
    const partial = [
      '```html',
      '<img src=x onerror="window.__streamXss=1">',
      '<script>window.__streamXss=1</script>',
    ].join('\n');
    const rows: any[] = [{
      _id: 'markdown-stream', sessionId: 'element-render', seq: 1,
      role: 'assistant', content: partial, streaming: true, createdAt: new Date(),
    }];
    const el = mountTranscript(rows);
    let row = part(el, 'assistant');
    let code = row.querySelector<HTMLElement>('pre code');

    assert.exists(code, 'CommonMark permits EOF to close a streaming fence');
    assert.equal(code?.textContent?.trimEnd(), partial.slice('```html\n'.length));
    assert.equal(code?.dataset.language, 'html');
    assert.lengthOf(row.querySelectorAll('img, script'), 0);
    assert.isUndefined((window as any).__streamXss);
    assert.include((row.getAttribute('part') ?? '').split(' '), 'streaming');

    rows[0] = { ...rows[0], content: `${partial}\n\`\`\``, streaming: false };
    el.mentionSources = el.mentionSources;
    row = part(el, 'assistant');
    code = row.querySelector<HTMLElement>('pre code');
    assert.exists(code);
    assert.equal(code?.textContent?.trimEnd(), partial.slice('```html\n'.length));
    assert.lengthOf(row.querySelectorAll('img, script'), 0);
    assert.notInclude((row.getAttribute('part') ?? '').split(' '), 'streaming');
    assert.isUndefined((window as any).__streamXss);
  });

  it('chips the @handles it knows and leaves the rest as text', async function () {
    this.timeout(60000);
    // Reuses the streaming test's session, per the budget note at the top:
    // one `agent.send`, no `agent.start`.
    assert.isString(streamedSession, 'this test replays the streaming test\'s session');
    const el = mount({ agent: 'itest', 'session-id': streamedSession! });
    el.mentionSources = {
      '@': { list: [{ id: 'acme', name: 'Acme Ltd' }], handle: 'id', label: 'name', kind: 'account' },
    };
    await waitFor('the transcript to arrive over DDP', 30000, () =>
      committed(el, 'assistant').includes('live streamed reply'));

    // Three tokens, one message: a known handle, the same handle with sentence
    // punctuation stuck to it, and one the element has never heard of.
    say(el, 'ask @acme, then @acme. but not @nobody');
    await waitFor('the mention row to render', 30000, () =>
      partsAll(el, 'mention').length >= 2);

    const chips = partsAll(el, 'mention').map((n) => n.textContent);
    assert.deepEqual(
      chips, ['@Acme Ltd', '@Acme Ltd'],
      'both spellings resolve to one subject, and the label is what shows',
    );
    assert.include(
      (partsAll(el, 'mention')[0].getAttribute('part') ?? '').split(' '), 'account',
      'the kind rides the part list so ::part(mention account) can reach it',
    );

    // The un-chipped half has to survive EXACTLY — a renderer that rebuilds
    // text around its chips is a renderer that can drop a character.
    const row = partsAll(el, 'user').find((n) => (n.textContent ?? '').includes('nobody'))!;
    assert.strictEqual(
      row.textContent, 'ask @Acme Ltd, then @Acme Ltd. but not @nobody',
      'punctuation, spacing and the unresolved token all stay put',
    );
    assert.lengthOf(
      row.querySelectorAll('[part~="mention"]'), 2,
      '@nobody matches no subject, so it stays plain text — same rule the '
      + 'addressee parser uses',
    );
  });

  it('marks a mention that ADDRESSES differently from one that only names', async function () {
    this.timeout(60000);
    assert.isString(streamedSession, 'this test replays the streaming test\'s session');
    const el = mount({ agent: 'itest', 'session-id': streamedSession! });
    // `itest` has no roster, so the agent kind comes from the app list here —
    // what is under test is the POSITION rule, not where the entry came from.
    el.mentionSources = {
      '@': { list: [{ id: 'analyst' }], handle: 'id', label: 'id', kind: 'agent' },
    };
    await waitFor('the transcript to arrive over DDP', 30000, () =>
      committed(el, 'assistant').includes('live streamed reply'));

    say(el, '@analyst please look, and later ask @analyst again');
    await waitFor('the row to render', 30000, () =>
      partsAll(el, 'user').some((n) => (n.textContent ?? '').includes('later ask')));

    const row = partsAll(el, 'user').find((n) => (n.textContent ?? '').includes('later ask'))!;
    const chips = Array.from(row.querySelectorAll('[part~="mention"]'));
    assert.lengthOf(chips, 2);
    // Only the leading one schedules a turn, so only it may look like it did.
    assert.include(
      (chips[0].getAttribute('part') ?? '').split(' '), 'addressed',
      'the leading mention is the one that routes',
    );
    assert.notInclude(
      (chips[1].getAttribute('part') ?? '').split(' '), 'addressed',
      'a mid-text mention schedules nothing and must not claim otherwise',
    );
  });

  it('renders crew notes as non-routing updates with an explicit badge', async function () {
    this.timeout(60000);
    assert.isString(streamedSession, 'this test replays the streaming test\'s session');
    const el = mount({ agent: 'itest', 'session-id': streamedSession! });
    await waitFor('the existing session to arrive', 30000, () =>
      committed(el, 'assistant').includes('live streamed reply'));
    const client = el.agentInstance!;
    const liveMessages = client.messages.bind(client);
    client.messages = () => ({
      fetch: () => [
        {
          _id: 'render-ask', sessionId: streamedSession!, seq: 1, role: 'user',
          content: '@analyst please answer', createdAt: new Date(),
        },
        {
          _id: 'render-note', sessionId: streamedSession!, seq: 2, role: 'user',
          kind: 'crew-note', content: '@analyst status update', createdAt: new Date(),
        },
      ],
    });
    try {
      el.mentionSources = {
        '@': { list: [{ id: 'analyst' }], handle: 'id', label: 'id', kind: 'agent' },
      };
      const note = part(el, 'crew-note');
      const ask = partsAll(el, 'user').find((row) =>
        (row.textContent ?? '').includes('please answer'))!;
      const noteMention = note.querySelector('[part~="mention"]') as HTMLElement;
      const askMention = ask.querySelector('[part~="mention"]') as HTMLElement;

      assert.equal(part(el, 'crew-note-badge').textContent, 'Crew note');
      assert.notInclude(
        (noteMention.getAttribute('part') ?? '').split(' '), 'addressed',
        'a non-waking note must not look routed even when it starts with @agent',
      );
      assert.notInclude(noteMention.title, 'schedules their turn');
      assert.include(
        (askMention.getAttribute('part') ?? '').split(' '), 'addressed',
        'the same leading token on a normal ask still communicates routing',
      );
      assert.include(askMention.title, 'schedules their turn');
    } finally {
      client.messages = liveMessages;
    }
  });

  it('preserves a reader\'s viewport and offers New messages until they return', function () {
    const el = mount({ agent: 'itest', 'session-id': 'no-such-scroll-session' });
    const client = el.agentInstance!;
    const liveMessages = client.messages.bind(client);
    let rows: any[] = [{
      _id: 'scroll-1', sessionId: 'no-such-scroll-session', seq: 1,
      role: 'assistant', content: 'first', createdAt: new Date(),
    }];
    client.messages = () => ({ fetch: () => rows });
    const messages = part<HTMLElement>(el, 'messages');
    const input = part<HTMLInputElement>(el, 'input');
    const newer = part<HTMLButtonElement>(el, 'new-messages');
    let scrollHeight = 300;
    let scrollTop = 0;
    Object.defineProperty(messages, 'scrollHeight', {
      configurable: true, get: () => scrollHeight,
    });
    Object.defineProperty(messages, 'clientHeight', {
      configurable: true, get: () => 100,
    });
    Object.defineProperty(messages, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (next: number) => { scrollTop = next; },
    });
    try {
      messages.scrollTop = 200;
      el.mentionSources = {}; // synchronous transcript repaint
      assert.isTrue(newer.hidden, 'a pinned reader follows the initial tail');

      messages.scrollTop = 40;
      messages.dispatchEvent(new Event('scroll'));
      input.focus();
      rows = [...rows, {
        _id: 'scroll-2', sessionId: 'no-such-scroll-session', seq: 2,
        role: 'assistant', content: 'second', createdAt: new Date(),
      }];
      scrollHeight = 420;
      el.mentionSources = {}; // stand-in for Tracker invalidation

      assert.equal(messages.scrollTop, 40, 'new rows do not pull a reader off their place');
      assert.strictEqual(el.shadowRoot!.activeElement, input, 'composer focus survives repaint');
      assert.isFalse(newer.hidden);
      assert.equal(newer.textContent?.trim(), 'New messages');
      assert.include((newer.getAttribute('part') ?? '').split(' '), 'pending');

      newer.click();
      assert.equal(messages.scrollTop, 420);
      assert.isTrue(newer.hidden);
    } finally {
      client.messages = liveMessages;
    }
  });

  it('completes an @mention in the composer instead of sending it', function () {
    // No session and no DDP at all: the typeahead reads the element's own
    // sources, so this costs the shared rate-limit counter nothing.
    const el = mount({ agent: 'itest', 'session-id': 'no-such-session' });
    el.mentionSources = {
      '@': {
        list: [
          { id: 'ada-lovelace', name: 'Ada Lovelace', role: 'contact' },
          { id: 'grace-hopper', name: 'Grace Hopper', role: 'contact' },
        ],
        handle: 'id',
        label: 'name',
        detail: 'role',
      },
    };
    const input = part<HTMLInputElement>(el, 'input');
    const typeahead = part<HTMLElement>(el, 'typeahead');
    assert.isTrue(typeahead.hidden, 'nothing offered until an @ is typed');

    const type = (text: string) => {
      input.value = text;
      input.setSelectionRange(text.length, text.length);
      input.dispatchEvent(new Event('input'));
    };

    type('tell me about @ada');
    assert.isFalse(typeahead.hidden, 'a token under the caret opens the list');
    assert.deepEqual(
      partsAll(el, 'suggestion').map((n) => n.textContent),
      ['@Ada Lovelacecontact'],
      'and it filters to what actually matches',
    );

    // Enter — via the form's own Send, which is what Enter triggers — must
    // COMPLETE here, not send. A composer that sends "@ada" because the user
    // pressed Enter to pick a name is the whole reason this is tested.
    part<HTMLButtonElement>(el, 'send').click();
    assert.strictEqual(
      input.value, 'tell me about @ada-lovelace ',
      'the HANDLE is inserted (not the label — the handle is what resolves), '
      + 'with the space that ends the token',
    );
    assert.isTrue(typeahead.hidden, 'and the list closes behind it');

    // An @ mid-word is an email address, not a mention.
    type('mail me at someone@example');
    assert.isTrue(typeahead.hidden, 'an @ that does not open a word is not a mention');
  });

  it('keeps a second symbol separate from @, in the composer and the transcript', async function () {
    this.timeout(60000);
    assert.isString(streamedSession, 'this test replays the streaming test\'s session');
    const el = mount({ agent: 'itest', 'session-id': streamedSession! });
    // One symbol from a LIVE COLLECTION, one from a plain list — both forms
    // exercised in the pairing they exist for.
    const people = fakeCollection([{ id: 'ada', name: 'Ada' }]);
    el.mentionSources = {
      '@': { collection: people, handle: 'id', label: 'name', kind: 'contact' },
      '#': { list: [{ sku: 'sku-42', title: 'Widget' }], handle: 'sku', label: 'title', kind: 'part' },
    };
    const input = part<HTMLInputElement>(el, 'input');
    const typeahead = part<HTMLElement>(el, 'typeahead');

    const type = (text: string) => {
      input.value = text;
      input.setSelectionRange(text.length, text.length);
      input.dispatchEvent(new Event('input'));
    };

    // Each symbol offers only what it names. Offering a person under `#` is the
    // failure this separation exists to prevent.
    type('order #');
    assert.deepEqual(
      partsAll(el, 'suggestion').map((n) => n.textContent), ['#Widget'],
      '# offers parts only',
    );
    part<HTMLButtonElement>(el, 'send').click();
    assert.strictEqual(input.value, 'order #sku-42 ', '# completes with its own symbol');

    type('ask @');
    assert.deepEqual(
      partsAll(el, 'suggestion').map((n) => n.textContent), ['@Ada'],
      '@ does not offer the parts list',
    );
    assert.isFalse(typeahead.hidden);

    // The collection is LIVE: change what it holds and the next read sees it,
    // with nothing re-assigned on the element.
    people.set([{ id: 'ada', name: 'Ada' }, { id: 'grace', name: 'Grace' }]);
    type('ask @gr');
    assert.deepEqual(
      partsAll(el, 'suggestion').map((n) => n.textContent), ['@Grace'],
      'a row added to the collection is offered without touching mentionSources',
    );

    // Clear the open list before sending. With suggestions showing, Send
    // COMPLETES rather than submits — which is the behaviour asserted above,
    // and it silently ate this message until the clear was added.
    type('');
    assert.isTrue(typeahead.hidden);

    await waitFor('the transcript to arrive over DDP', 30000, () =>
      committed(el, 'assistant').includes('live streamed reply'));
    say(el, 'put @ada on #sku-42, not #nonsense');
    // Waiting on THIS row, not on a chip count: the session is shared with the
    // test above, whose message already renders two chips here.
    await waitFor('the new row to render', 30000, () =>
      partsAll(el, 'user').some((n) => (n.textContent ?? '').includes('nonsense')));

    const row = partsAll(el, 'user').find((n) => (n.textContent ?? '').includes('nonsense'))!;
    assert.strictEqual(
      row.textContent, 'put @Ada on #Widget, not #nonsense',
      'each chip keeps the symbol it was written with, and an unknown one stays text',
    );
    const kinds = Array.from(row.querySelectorAll('[part~="mention"]'))
      .map((n) => (n.getAttribute('part') ?? '').split(' ')[1]);
    assert.deepEqual(kinds, ['contact', 'part'], 'and each carries its own kind');
  });

  /**
   * LAST in the file: it resets the fixtures' collections, which the tests
   * above reuse across each other.
   *
   * Re-pointing an element takes two attribute writes, and attributes arrive
   * one at a time. Attaching on each of them made the INTERMEDIATE combination
   * real — session-id removed, old agent still in place — which has no session
   * and therefore auto-STARTS one, on the server, that nothing will ever
   * render. The generation guard hides it from the client, which is exactly why
   * the assertion has to be a server-side count.
   */
  it('coalesces synchronous attribute churn into ONE attach, with no orphan session', async function () {
    this.timeout(60000);
    await Meteor.callAsync('itest.reset');

    // A session id nobody has: the publication authorizes nothing and serves
    // nothing, which is all this needs — the element is attached and quiet, and
    // it has cost the rate limiter no `agent.start` at all.
    const el = mount({ agent: 'itest', 'session-id': 'no-such-session' });
    await waitFor('the element to settle on the given session', 20000, () =>
      el.sessionId === 'no-such-session');

    // The churn, synchronously, in the order a host would write it.
    el.removeAttribute('session-id');
    el.setAttribute('agent', 'itest-gate');

    await waitFor('the coalesced attach to start exactly one session', 30000, () =>
      !!el.sessionId && el.sessionId !== 'no-such-session');
    // A stray start would have been issued BEFORE the surviving one and, on one
    // ordered DDP connection, answered before it too — so it is already in the
    // database by now. The pause is belt and braces.
    await new Promise((resolve) => { setTimeout(resolve, 500); });

    const counts = await Meteor.callAsync('itest.sessionCounts');
    assert.deepEqual(
      counts, { 'itest-gate': 1 },
      'exactly one session, for the agent the attributes FINALLY named — an `itest` '
      + 'session here is the orphan the intermediate attribute state used to start',
    );
  });
});
