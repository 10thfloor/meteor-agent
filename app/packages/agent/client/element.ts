import { Tracker } from 'meteor/tracker';
import { Agent } from './agent';
import type { Phase, ViewMessage } from '../common/types';
import { prettySize } from '../common/format';

/**
 * `<agent-chat>` — the packaged UI.
 *
 * One custom element that renders a whole session: transcript (user/assistant
 * bubbles with a streaming cursor, tool rows, notes), phase badge, approval
 * bar, and a composer with Send/Stop. It is the demo app's vanilla renderer
 * with nothing added but packaging, which is the point: the data layer is a
 * reactive minimongo cursor, so the renderer underneath is plain DOM in a
 * `Tracker.autorun`. Drop the tag into Blaze, React, Svelte or an HTML file —
 * a custom element is the same element in all four.
 *
 * NEVER auto-registered. A package that called `customElements.define` at
 * import time would squat the name `agent-chat` in every app that depends on
 * it, and a second definition of the same name is a hard `DOMException`. So
 * registration is the app's call, by name:
 *
 * ```ts
 * import { defineAgentChat } from 'meteor/10thfloor:agent';
 * defineAgentChat();                 // <agent-chat>
 * defineAgentChat('support-chat');   // …or under your own name
 * ```
 */

const DEFAULT_TAG = 'agent-chat';
const DEFAULT_PLACEHOLDER = 'Message the agent…';
/** The reason the built-in Deny button sends. It reaches the MODEL as the
 *  denied tool result, so it says who refused rather than just "denied". A host
 *  that wants to ask the human why calls `el.agentInstance.deny(el.sessionId,
 *  reason)` itself and leaves this button out of the flow. */
const DENY_REASON = 'denied by the user';

/**
 * Static, author-written markup — no interpolation of any kind reaches it.
 * Every piece of TRANSCRIPT content below goes in through `textContent`
 * instead (see `renderRow`): message bodies, tool output and tool arguments
 * are model- and API-shaped strings that no one in this stack has escaped, so
 * `innerHTML` on any of them would be an XSS sink wearing a chat bubble.
 *
 * Theming is `part` attributes plus CSS custom properties, so an app restyles
 * this without piercing the shadow root:
 *
 * ```css
 * agent-chat { --agent-chat-accent: rebeccapurple; }
 * agent-chat::part(message user) { border-radius: 0; }
 * ```
 */
const FRAME = `
<style>
  :host {
    /* Public knobs, resolved once into private aliases so the rest of the
       sheet reads plainly. The defaults are the system color keywords, which
       (with color-scheme below) track the OS light/dark preference — an app
       that sets nothing still looks native in both. */
    --_accent: var(--agent-chat-accent, #2b7de9);
    --_bg: var(--agent-chat-bg, Canvas);
    --_fg: var(--agent-chat-fg, CanvasText);
    --_warn: var(--agent-chat-warn, #d97706);
    --_danger: var(--agent-chat-danger, #dc2626);
    --_radius: var(--agent-chat-radius, 0.75rem);
    color-scheme: light dark;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--_bg);
    color: var(--_fg);
    font-family: var(--agent-chat-font, system-ui, sans-serif);
  }
  /* Same lesson as the .approval[hidden] rule below, one level up: the
     display:flex on :host beats the UA's [hidden] { display: none }, so
     <agent-chat hidden> would render without this.
     (No backticks anywhere in this sheet — it is a template literal.) */
  :host([hidden]) { display: none; }

  .root { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  header {
    display: flex; align-items: baseline; gap: 0.75rem; padding: 0.75rem 1rem;
    border-bottom: 1px solid color-mix(in srgb, var(--_fg) 15%, transparent);
  }
  .phase { font-size: 0.8rem; opacity: 0.7; margin-left: auto; }
  .phase[data-phase="streaming"], .phase[data-phase="calling"] { color: var(--_accent); opacity: 1; }
  .phase[data-phase="awaiting"] { color: var(--_warn); opacity: 1; }
  .phase[data-phase="error"], .phase[data-phase="stopped"] { color: var(--_danger); opacity: 1; }

  .messages {
    flex: 1; overflow-y: auto; padding: 1rem;
    display: flex; flex-direction: column; gap: 0.5rem;
  }
  .message {
    max-width: 85%; padding: 0.5rem 0.75rem; border-radius: var(--_radius);
    white-space: pre-wrap; word-break: break-word;
  }
  .message.user { align-self: flex-end; background: var(--_accent); color: #fff; }
  .message.assistant { align-self: flex-start; background: color-mix(in srgb, var(--_fg) 8%, var(--_bg)); }
  .message.assistant.streaming::after { content: '▍'; animation: agent-chat-blink 1s steps(1) infinite; }
  .message.tool {
    align-self: flex-start; max-width: 100%; display: flex; gap: 0.4rem;
    font-size: 0.8rem; opacity: 0.75; font-family: ui-monospace, monospace;
  }
  .tool-name { white-space: nowrap; }
  /* Tool output is unbounded (a page of JSON is normal); clamp it here and let
     a host that wants it whole say ::part(tool-content) { -webkit-line-clamp: none }. */
  .tool-content {
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .message.note { align-self: center; text-align: center; font-size: 0.8rem; opacity: 0.6; }
  .message.note.error { color: var(--_danger); opacity: 0.9; }
  .calls { display: block; font-size: 0.8rem; opacity: 0.7; font-family: ui-monospace, monospace; }
  /* Attribution (participants spec §4.1): the speaker line a rostered row
     carries. Absent on 1:1 rows, so nothing changes for the classic pair. */
  .speaker { display: block; font-size: 0.72rem; opacity: 0.65; font-weight: 600; }
  /* Attachment chips (participants spec §7.3): one per ref, click-to-mint. */
  .attachments { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.35rem; }
  .attachment {
    font-size: 0.78rem; padding: 0.15rem 0.5rem; border-radius: 0.5rem;
    border: 1px solid color-mix(in srgb, var(--_fg) 25%, transparent);
    background: color-mix(in srgb, var(--_fg) 6%, var(--_bg));
    color: inherit; cursor: pointer;
  }
  .message.user .attachment {
    border-color: color-mix(in srgb, #fff 45%, transparent);
    background: color-mix(in srgb, #fff 15%, transparent);
  }

  .approval {
    display: flex; gap: 0.5rem; align-items: center; padding: 0.75rem 1rem;
    border-top: 1px solid var(--_warn);
    background: color-mix(in srgb, var(--_warn) 12%, var(--_bg));
    font-size: 0.9rem;
  }
  /* The display:flex above beats the UA's [hidden] { display: none } — without
     this rule the approval bar renders even when nothing is pending. */
  .approval[hidden] { display: none; }
  .approval-text { flex: 1; }

  .composer {
    display: flex; gap: 0.5rem; padding: 0.75rem 1rem;
    border-top: 1px solid color-mix(in srgb, var(--_fg) 15%, transparent);
  }
  .input {
    flex: 1; padding: 0.5rem 0.75rem; border-radius: 0.5rem; font: inherit;
    border: 1px solid color-mix(in srgb, var(--_fg) 25%, transparent);
    background: var(--_bg); color: var(--_fg);
  }
  button {
    padding: 0.5rem 0.9rem; border-radius: 0.5rem; border: none; font: inherit;
    background: var(--_accent); color: #fff; cursor: pointer;
  }
  button.secondary { background: color-mix(in srgb, var(--_fg) 12%, var(--_bg)); color: var(--_fg); }
  @keyframes agent-chat-blink { 50% { opacity: 0; } }
</style>
<div class="root" part="root">
  <header part="header">
    <slot name="header"></slot>
    <span class="phase" part="phase idle" data-phase="idle">idle</span>
  </header>
  <div class="messages" part="messages" role="log" aria-live="polite"></div>
  <div class="approval" part="approval" hidden>
    <span class="approval-text" part="approval-text"></span>
    <button type="button" class="approve" part="button approve">Approve</button>
    <button type="button" class="deny secondary" part="button deny">Deny</button>
  </div>
  <form class="composer" part="composer">
    <input class="input" part="input" autocomplete="off" />
    <button type="submit" class="send" part="button send">Send</button>
    <button type="button" class="stop secondary" part="button stop" title="Interrupt the turn">Stop</button>
  </form>
</div>
`;

/** `id -> name` for every tool call the transcript has announced, so a `role:
 *  'tool'` row (which carries only `toolCallId`) can be labelled with the name
 *  the model actually asked for. */
function toolNames(rows: ViewMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of rows) {
    for (const call of m.toolCalls ?? []) names.set(call.id, call.name);
  }
  return names;
}

/** The demo's wording, unchanged — notes are structured rows, and this is the
 *  one place that turns them into a sentence. */
function noteText(m: ViewMessage): string {
  if (m.kind === 'approval') {
    const verdict = m.timedOut ? 'Timed out' : m.approved ? 'Approved' : 'Denied';
    return `${verdict}${m.reason ? ` — ${m.reason}` : ''}`;
  }
  if (m.kind === 'compaction') return '· earlier conversation compacted ·';
  // The watcher's re-link. The row exists to be a HANDLE (it carries
  // `childSessionId` + `childAgent`), so the sentence names the agent a reader
  // would go looking for rather than the slug.
  if (m.kind === 'orphan-child') {
    return `· recovered subagent session${m.childAgent ? ` — ${m.childAgent}` : ''} ·`;
  }
  return m.error?.reason ?? m.kind ?? '';
}

function renderRow(
  m: ViewMessage, names: Map<string, string>,
  download?: (attachmentId: string) => void,
): HTMLElement {
  const row = document.createElement('div');
  // `part` and `class` carry the same tokens: the class drives the sheet
  // above, the part exposes the identical hook to the host page. Note rows add
  // their `kind`, so `::part(note error)` is addressable without piercing.
  const flags = [
    m.role,
    m.streaming ? 'streaming' : '',
    m.role === 'note' && m.kind ? m.kind : '',
  ].filter(Boolean) as string[];
  row.className = ['message', ...flags].join(' ');
  row.setAttribute('part', ['message', ...flags].join(' '));

  if (m.role === 'note') {
    row.textContent = noteText(m);
    return row;
  }

  if (m.role === 'tool') {
    const name = document.createElement('span');
    name.className = 'tool-name';
    name.setAttribute('part', 'tool-name');
    name.textContent = `⚙ ${(m.toolCallId && names.get(m.toolCallId)) || 'tool'}`;
    const body = document.createElement('span');
    body.className = 'tool-content';
    body.setAttribute('part', 'tool-content');
    body.textContent = m.content ?? '';
    row.append(name, body);
    return row;
  }

  // Attribution (participants spec §4.1): rows in a rostered session carry
  // `from`, and a group transcript that does not say who is speaking is
  // unreadable. A small name line above the text; 1:1 sessions carry no
  // `from` worth showing (the roles already say who spoke) — the stamp is
  // rendered only when the roster made names meaningful, which the server
  // signals by stamping deltas/rows in rostered sessions with display names
  // resolved from the roster.
  if (m.from && (m.role === 'user' || m.role === 'assistant')) {
    const speaker = document.createElement('span');
    speaker.className = 'speaker';
    speaker.setAttribute('part', 'speaker');
    speaker.textContent = m.from.name;
    row.append(speaker);
  }
  // `truncatedHead` means compaction (or a capped-collection gap) dropped the
  // start of this row's text; the ellipsis says so rather than silently
  // presenting a fragment as the whole message.
  row.append(document.createTextNode((m.truncatedHead ? '…' : '') + (m.content ?? '')));
  if (m.toolCalls?.length) {
    const calls = document.createElement('span');
    calls.className = 'calls';
    calls.setAttribute('part', 'tool-calls');
    calls.textContent = m.toolCalls
      .map((c) => ` → ${c.name}(${JSON.stringify(c.args)})`)
      .join('');
    row.append(calls);
  }
  // Attachment chips (participants spec §7.3): the refs already ride the
  // published row; the click MINTS a single-use download URL and navigates —
  // the server's attachment-disposition means the page never leaves. All
  // text through textContent, like every other row part.
  if (m.attachments?.length && download) {
    const wrap = document.createElement('span');
    wrap.className = 'attachments';
    wrap.setAttribute('part', 'attachments');
    for (const ref of m.attachments) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'attachment';
      chip.setAttribute('part', 'attachment');
      chip.textContent = `📎 ${ref.name} (${prettySize(ref.size)})`;
      chip.addEventListener('click', () => download(ref.id));
      wrap.append(chip);
    }
    row.append(wrap);
  }
  return row;
}

function failureRow(message: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'message note error';
  row.setAttribute('part', 'message note error');
  row.textContent = message;
  return row;
}

/** Meteor.Error carries the human half on `reason`; everything else on
 *  `message`. Neither is guaranteed, hence the last resort. */
function messageOf(e: unknown): string {
  const err = e as { reason?: string; message?: string } | null;
  return err?.reason || err?.message || String(e);
}

/**
 * Register `<agent-chat>` (or any tag name you prefer) and return its
 * constructor.
 *
 * Idempotent PER TAG: calling it twice with the same name is a no-op that
 * returns whatever is already registered — including, if the app registered
 * something else under that name first, that other element; the platform gives
 * no way to check provenance, and throwing would be worse than yielding.
 * Calling it with a DIFFERENT name registers again, from a fresh class:
 * `customElements.define` refuses to reuse one constructor for two names, so
 * the class is built per call rather than hoisted to module scope.
 */
export function defineAgentChat(tagName: string = DEFAULT_TAG): CustomElementConstructor {
  const existing = customElements.get(tagName);
  if (existing) return existing;

  class AgentChat extends HTMLElement {
    static get observedAttributes() { return ['agent', 'session-id', 'placeholder']; }

    private ui!: {
      phase: HTMLElement;
      messages: HTMLElement;
      approval: HTMLElement;
      approvalText: HTMLElement;
      input: HTMLInputElement;
    };
    private client: Agent | null = null;
    private sid: string | null = null;
    private computation: Tracker.Computation | null = null;
    /** Bumped by every attach/detach. An in-flight `start()` compares against
     *  it before touching the DOM, so an element removed (or re-pointed at
     *  another session) while the method call was on the wire cannot resurrect
     *  itself when the call resolves. */
    private generation = 0;
    /** True between connected and disconnected. `attributeChangedCallback`
     *  fires BEFORE `connectedCallback` during an upgrade — once per observed
     *  attribute — so without this flag a `<agent-chat agent="x">` already in
     *  the markup would attach three times over. */
    private live = false;
    /** A re-attach is already queued for the end of this microtask — see
     *  `queueReattach`. */
    private reattachQueued = false;
    /** The generation the queued re-attach expects to still be current. */
    private reattachGeneration = -1;
    private failure: string | null = null;

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = FRAME;
      const q = <T extends Element>(sel: string) => root.querySelector(sel) as unknown as T;
      this.ui = {
        phase: q<HTMLElement>('.phase'),
        messages: q<HTMLElement>('.messages'),
        approval: q<HTMLElement>('.approval'),
        approvalText: q<HTMLElement>('.approval-text'),
        input: q<HTMLInputElement>('.input'),
      };
      q<HTMLFormElement>('.composer').addEventListener('submit', (e: Event) => {
        e.preventDefault();
        void this.submit();
      });
      q<HTMLButtonElement>('.stop').addEventListener('click', () => {
        void this.act((a, s) => a.interrupt(s));
      });
      q<HTMLButtonElement>('.approve').addEventListener('click', () => {
        void this.act((a, s) => a.approve(s));
      });
      q<HTMLButtonElement>('.deny').addEventListener('click', () => {
        void this.act((a, s) => a.deny(s, DENY_REASON));
      });
    }

    /** The session being rendered — null until an auto-start resolves. */
    get sessionId(): string | null { return this.sid; }

    /** The underlying client `Agent`, for anything the element does not do
     *  itself (`fork`, `usage`, a denial with a typed reason). Null while
     *  detached. */
    get agentInstance(): Agent | null { return this.client; }

    connectedCallback() {
      this.live = true;
      this.applyPlaceholder();
      this.attach();
    }

    disconnectedCallback() {
      this.live = false;
      this.detach();
    }

    attributeChangedCallback(name: string, before: string | null, after: string | null) {
      if (before === after || !this.live) return;
      if (name === 'placeholder') { this.applyPlaceholder(); return; }
      // `agent` or `session-id`: a clean re-subscribe, COALESCED — see
      // `queueReattach`.
      this.queueReattach();
    }

    /**
     * Tear down now, re-attach once, at the end of the microtask.
     *
     * Attributes are set one at a time and re-pointing an element routinely
     * takes two of them (`el.removeAttribute('session-id')` then
     * `el.setAttribute('agent', …)`, or a framework patching both in one
     * render). Attaching on each callback made the INTERMEDIATE combination
     * real: the element with the session-id removed and the old agent still in
     * place has no session, so `attach()` called `start()` — and a moment later
     * the second attribute landed, detached, and started again. The generation
     * guard stopped the first session from ever being rendered, which is
     * precisely the problem: it was created on the server, owned by nobody, and
     * left in the user's session list. One orphan per re-point.
     *
     * The DETACH still happens synchronously, on every callback. It is what
     * stops the old subscription and bumps the generation, and an in-flight
     * `start()` must be orphaned the instant the attributes stop describing it,
     * not a microtask later.
     *
     * The re-attach is deferred to a microtask and deduped, so a run of
     * synchronous attribute writes produces exactly ONE attach, against the
     * attribute values as they finally stand. The generation captured after the
     * detach is the guard: any connect, disconnect or further churn in between
     * bumps it, and the queued attach — now describing a state that no longer
     * exists — does nothing.
     */
    private queueReattach() {
      this.detach();
      this.failure = null;
      // The LATEST detach's generation, on a field rather than in the closure:
      // the second write of a churn re-detaches (bumping the generation again)
      // but does not queue a second microtask, so a captured local would leave
      // the one queued callback comparing against a stale number and skipping
      // the attach entirely.
      this.reattachGeneration = this.generation;
      if (this.reattachQueued) return;
      this.reattachQueued = true;
      queueMicrotask(() => {
        this.reattachQueued = false;
        if (!this.live || this.generation !== this.reattachGeneration) return;
        this.attach();
      });
    }

    private applyPlaceholder() {
      this.ui.input.placeholder = this.getAttribute('placeholder') ?? DEFAULT_PLACEHOLDER;
    }

    private attach() {
      const generation = ++this.generation;
      const name = this.getAttribute('agent');
      if (!name) {
        this.fail(new Error('<agent-chat> needs an `agent` attribute naming a registered agent'));
        return;
      }
      this.client = new Agent(name);

      const given = this.getAttribute('session-id');
      if (given) { this.watch(given); return; }

      // No `session-id`: open one. The event is how a host persists the id it
      // never chose — localStorage, a route, a user document — and hand it
      // back as `session-id` on the next load.
      this.client.start().then((sessionId) => {
        if (generation !== this.generation) return;
        this.watch(sessionId);
        this.dispatchEvent(new CustomEvent('agent-chat:session', {
          detail: { sessionId }, bubbles: true, composed: true,
        }));
      }, (e: unknown) => {
        if (generation === this.generation) this.fail(e);
      });
    }

    private watch(sessionId: string) {
      this.sid = sessionId;
      this.client!.subscribe(sessionId);
      if (this.computation) this.computation.stop();
      // ONE autorun for the whole element, repainting from `replaceChildren`.
      // The tradeoff is deliberate: every delta rebuilds every row, which is
      // free at chat scale (tens of rows, a few repaints a second) and buys
      // zero diffing code and zero stale-node bugs. A transcript in the
      // thousands of rows wants a keyed patch instead — at which point you are
      // writing a framework, so reach for yours and use `Agent` directly.
      this.computation = Tracker.autorun(() => this.paint());
    }

    private detach() {
      this.generation++;
      if (this.computation) { this.computation.stop(); this.computation = null; }
      // The optional guard on `stop()`: this element owns its own Agent, so it
      // can only ever agree — passing it keeps the call honest about which
      // session the teardown is for, and costs nothing.
      if (this.client) this.client.stop(this.sid ?? undefined);
      this.client = null;
      this.sid = null;
      this.paint();
    }

    private paint() {
      const { client, sid } = this;
      const rows: ViewMessage[] = client && sid
        ? (client.messages(sid).fetch() as ViewMessage[])
        : [];
      const names = toolNames(rows);
      // The chip's mint-and-navigate: a click-time capability, never a
      // standing URL (participants spec §7.3). `assign` on an
      // attachment-disposition response downloads without navigating away.
      const download = client && sid
        ? (attachmentId: string) => {
          void client.attachmentUrl(sid, attachmentId)
            .then((url) => { window.location.assign(url); })
            .catch((e) => { console.warn('[agent-chat] download refused:', e); });
        }
        : undefined;
      const nodes: HTMLElement[] = rows.map((m) => renderRow(m, names, download));
      if (this.failure) nodes.push(failureRow(this.failure));
      this.ui.messages.replaceChildren(...nodes);
      this.ui.messages.scrollTop = this.ui.messages.scrollHeight;

      const phase: Phase = client && sid ? client.status(sid) : 'idle';
      this.ui.phase.textContent = phase;
      this.ui.phase.dataset.phase = phase;
      this.ui.phase.setAttribute('part', `phase ${phase}`);

      const ask = client && sid ? client.pending(sid) : undefined;
      const parked = !!ask && !ask.verdict;
      (this.ui.approval as HTMLElement).hidden = !parked;
      if (parked) {
        // `runAs` is announced whenever the parked tool has one, because the
        // person clicking Approve is authorizing an IDENTITY as well as an
        // action: a tool that runs as `service-account` is not the same request
        // as one that runs as them. Presence, not truthiness — `null` is the
        // anonymous service context and says so in words, while an absent field
        // means the ordinary case (the tool runs as the session's owner) and
        // adds nothing to the sentence.
        const runsAs = ask.runAs === undefined
          ? '' : ` — runs as ${ask.runAs ?? 'anonymous'}`;
        this.ui.approvalText.textContent =
          `The agent wants to run ${ask.name}(${JSON.stringify(ask.args)})${runsAs}`;
      }
    }

    private async submit() {
      const text = this.ui.input.value.trim();
      if (!text) return;
      const { client, sid } = this;
      if (!client || !sid) {
        this.fail(new Error('no session yet — the agent is still starting'));
        return;
      }
      this.ui.input.value = '';
      try {
        this.clearFailure();
        await client.send(sid, text);
      } catch (e) {
        // Put the text back: a send that failed (rate limit, offline, a
        // session the server no longer has) must not eat what was typed.
        this.ui.input.value = text;
        this.fail(e);
      }
    }

    private async act(fn: (agent: Agent, sessionId: string) => Promise<unknown>) {
      const { client, sid } = this;
      if (!client || !sid) return;
      try {
        this.clearFailure();
        await fn(client, sid);
      } catch (e) {
        this.fail(e);
      }
    }

    private clearFailure() {
      if (this.failure === null) return;
      this.failure = null;
      this.paint();
    }

    /** Surface a method rejection where the user is already looking (a note
     *  row) AND as an event, so a host can react — the demo drops its saved
     *  session id when the server no longer recognizes it. */
    private fail(e: unknown) {
      this.failure = messageOf(e);
      this.dispatchEvent(new CustomEvent('agent-chat:error', {
        detail: { error: e, message: this.failure }, bubbles: true, composed: true,
      }));
      this.paint();
    }
  }

  customElements.define(tagName, AgentChat);
  return AgentChat;
}
