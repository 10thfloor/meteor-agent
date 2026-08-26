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

/**
 * Something a message can name with `@`.
 *
 * The package resolves the session's own MODEL participants into this shape for
 * free, because those are the handles that actually address a turn
 * (`resolveAddressee` in common/participants.ts parses exactly one leading
 * `@name` against them). An app adds its OWN subjects — a customer, a ticket, an
 * account — through the `mentionables` property, and those are deliberately
 * inert: they render and they autocomplete, but naming one schedules nothing,
 * because the package will not invent a routing rule for a noun it cannot see.
 *
 * `handle` is what follows the `@`, and it may not contain whitespace. Anything
 * that does not match a known handle stays plain text, which is the same rule
 * the addressee parse uses: an unmatched `@name` is speech, not markup.
 */
export interface Mentionable {
  handle: string;
  /** Shown in the chip and the typeahead. Defaults to `handle`. */
  label?: string;
  /** Free-form; becomes a `part` token, so `::part(mention guest)` works. */
  kind?: string;
  /** A second line in the typeahead — an email, a role, a last-seen date. */
  detail?: string;
  /**
   * The symbol that summons it. Defaults to `@`.
   *
   * A second symbol is worth having when the things being named are of a
   * different ORDER, not merely a different type: `@` reaches people (and, for
   * model participants, actually routes the turn), while something like `#`
   * points at an item in a catalogue that could never take a turn. One symbol
   * for both makes the composer offer a product where a person belongs.
   *
   * Only `@` is ever parsed as an addressee — see `resolveAddressee` — so a
   * mentionable under any other symbol is inert by construction, whatever kind
   * it claims.
   */
  prefix?: string;
}

const DEFAULT_PREFIX = '@';
/** Same character class as `LEADING_MENTION` in common/participants.ts. The two
 *  must agree for `@`: a token this renders as a chip but the parser will not
 *  accept as an addressee is a chip that promises routing it cannot deliver. */
const HANDLE_CLASS = '[\\w.-]';
/** Prefixes are author-supplied strings that go straight into a character
 *  class, so a `-` or a `]` would otherwise change what the pattern matches. */
const escapeForClass = (s: string) => s.replace(/[\\\]^-]/g, '\\$&');

function tokenPattern(prefixes: string[], trailing: boolean): RegExp {
  const set = `[${prefixes.map(escapeForClass).join('')}]`;
  return trailing
    ? new RegExp(`(${set})(${HANDLE_CLASS}{0,64})$`)
    : new RegExp(`(${set})(${HANDLE_CLASS}{1,64})`, 'g');
}
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

  /* A resolved @handle. Inline so it wraps with the sentence it is part of —
     a chip that cannot break mid-line turns one long mention into a scrollbar. */
  .mention {
    border-radius: 0.35rem; padding: 0 0.2rem; font-weight: 600;
    background: color-mix(in srgb, var(--_accent) 20%, transparent);
  }
  /* Anything that is not a model participant is a SUBJECT, not an addressee.
     It reads as a reference rather than a call, because naming it schedules
     nothing — see the Mentionable docblock. */
  .mention.subject {
    background: color-mix(in srgb, var(--_fg) 13%, transparent); font-weight: 500;
  }
  /* On the user bubble the accent IS the background, so the chip has to lift
     off white instead of off the page. */
  .message.user .mention { background: color-mix(in srgb, #fff 30%, transparent); }

  .typeahead {
    position: absolute; left: 1rem; right: 1rem; bottom: calc(100% - 0.25rem);
    z-index: 2; max-height: 12rem; overflow-y: auto; padding: 0.25rem;
    border-radius: var(--_radius); background: var(--_bg);
    border: 1px solid color-mix(in srgb, var(--_fg) 22%, transparent);
    box-shadow: 0 0.5rem 1.5rem color-mix(in srgb, var(--_fg) 18%, transparent);
  }
  .typeahead[hidden] { display: none; }
  .suggestion {
    display: flex; align-items: baseline; gap: 0.5rem; width: 100%;
    padding: 0.35rem 0.5rem; border-radius: 0.4rem; cursor: pointer;
    background: none; color: var(--_fg); text-align: left; font: inherit;
  }
  .suggestion[aria-selected="true"] {
    background: color-mix(in srgb, var(--_accent) 18%, transparent);
  }
  .suggestion-handle { font-weight: 600; }
  .suggestion-detail { font-size: 0.8rem; opacity: 0.65; margin-left: auto; }

  .approval {
    display: flex; gap: 0.5rem; align-items: center; padding: 0.75rem 1rem;
    border-top: 1px solid var(--_warn);
    background: color-mix(in srgb, var(--_warn) 12%, var(--_bg));
    font-size: 0.9rem;
  }
  /* The display:flex above beats the UA's [hidden] { display: none } — without
     this rule the approval bar renders even when nothing is pending. */
  .approval[hidden] { display: none; }
  /* The summary leads and the exact record follows on its own lines, so the
     newline between them has to survive rendering. */
  .approval-text { flex: 1; white-space: pre-wrap; word-break: break-word; }

  .composer {
    display: flex; gap: 0.5rem; padding: 0.75rem 1rem;
    border-top: 1px solid color-mix(in srgb, var(--_fg) 15%, transparent);
    /* The typeahead anchors to this. */
    position: relative;
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
    <div class="typeahead" part="typeahead" role="listbox" hidden></div>
    <input class="input" part="input" autocomplete="off" role="combobox"
           aria-expanded="false" aria-autocomplete="list" />
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

/**
 * One transcript row, or `null` for a row this verbosity does not show.
 *
 * `quiet` is the reading an OPERATOR wants: the conversation, and the decisions
 * they have to make. A tool's raw result and the `→ name({…})` trace under an
 * assistant bubble are the machine's working, and in a business UI they bury
 * the answer under JSON.
 *
 * Dropping them is not enough on its own: an assistant row that only called
 * tools has NO text of its own, so hiding the trace alone would leave an empty
 * bubble per tool round. Quiet therefore drops the whole row when nothing human
 * -readable is left — which is why this is a filter here and not a `::part`
 * rule in the host page, where the empty row is unaddressable.
 *
 * Errors, budget stops and approval notes are never quiet: they are the reasons
 * a person is needed.
 */
function renderRow(
  m: ViewMessage, names: Map<string, string>,
  download?: (attachmentId: string) => void,
  quiet = false,
  mentions: Map<string, Mentionable> = new Map(),
): HTMLElement | null {
  if (quiet) {
    // A tool result is the machine's working, not the answer.
    if (m.role === 'tool') return null;
    // Compaction is bookkeeping about the transcript, not about the business.
    if (m.role === 'note' && m.kind === 'compaction') return null;
    // An assistant turn that only called tools says nothing a person can read.
    const speaks = (m.content ?? '').trim() !== '' || !!m.attachments?.length;
    if (m.role === 'assistant' && !speaks && !m.streaming) return null;
  }
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
  if (m.truncatedHead) row.append(document.createTextNode('…'));
  row.append(...renderText(m.content ?? '', mentions));
  if (m.toolCalls?.length && !quiet) {
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

/**
 * Message text, with every RESOLVED `@handle` lifted into a chip.
 *
 * Returns nodes rather than markup on purpose. Message bodies are model- and
 * API-shaped strings that nothing in this stack has escaped, so the rule the
 * FRAME docblock sets — every piece of transcript content goes in through
 * `textContent` — holds here too: the gaps between mentions become text nodes
 * and the chips get their label the same way. No `innerHTML` path exists.
 *
 * An unresolved token stays in its text node, which keeps the rendering honest
 * against `resolveAddressee`: if the roster does not know the name, the message
 * did not address anyone, and it should not look as though it did.
 */
function renderText(text: string, mentions: Map<string, Mentionable>): Node[] {
  if (!text) return [];
  if (mentions.size === 0) return [document.createTextNode(text)];
  const prefixes = [...new Set([...mentions.values()].map((m) => m.prefix ?? DEFAULT_PREFIX))];
  const nodes: Node[] = [];
  let cursor = 0;
  // A fresh regex per call: /g carries `lastIndex` between uses, and one shared
  // across rows would skip matches on every other row.
  const scan = tokenPattern(prefixes, false);
  let hit: RegExpExecArray | null = scan.exec(text);
  while (hit !== null) {
    // "@risk." — the class admits '.' and '-', so sentence punctuation rides
    // into the capture. Same two-step as `resolveAddressee`: try the token, then
    // retry with trailing punctuation trimmed. A real handle cannot END in it,
    // so the trim can only recover a match, never invent one.
    const prefix = hit[1];
    const raw = hit[2];
    const trimmed = raw.replace(/[.-]+$/, '');
    const found = mentions.get(prefix + raw)
      ?? (trimmed !== raw ? mentions.get(prefix + trimmed) : undefined);
    if (found) {
      const handle = mentions.get(prefix + raw) ? raw : trimmed;
      if (hit.index > cursor) nodes.push(document.createTextNode(text.slice(cursor, hit.index)));
      const chip = document.createElement('span');
      const kind = found.kind ?? 'subject';
      chip.className = `mention ${kind}`;
      chip.setAttribute('part', `mention ${kind}`);
      chip.textContent = `${prefix}${found.label ?? handle}`;
      if (found.detail) chip.title = found.detail;
      nodes.push(chip);
      cursor = hit.index + prefix.length + handle.length;
    }
    hit = scan.exec(text);
  }
  if (cursor < text.length) nodes.push(document.createTextNode(text.slice(cursor)));
  return nodes;
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
    static get observedAttributes() {
      return ['agent', 'session-id', 'placeholder', 'verbosity'];
    }

    private ui!: {
      phase: HTMLElement;
      messages: HTMLElement;
      approval: HTMLElement;
      approvalText: HTMLElement;
      input: HTMLInputElement;
      typeahead: HTMLElement;
    };
    /** App-supplied `@`-able subjects. A property, not an attribute: this is a
     *  list of objects, and a JSON attribute would make every roster change a
     *  re-parse of a string the host already had in hand. */
    private appMentions: Mentionable[] = [];
    /** The suggestions currently offered, and which one Enter would take. */
    private suggestions: Mentionable[] = [];
    private cursorAt = -1;
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
        typeahead: q<HTMLElement>('.typeahead'),
      };
      q<HTMLFormElement>('.composer').addEventListener('submit', (e: Event) => {
        e.preventDefault();
        // Enter with the typeahead open completes the mention; it does not
        // send. Submit is the only place that can know this, because the
        // keydown handler cannot cancel a form submission it did not cause.
        if (this.suggestions.length > 0) { this.acceptSuggestion(); return; }
        void this.submit();
      });
      this.ui.input.addEventListener('input', () => this.refreshSuggestions());
      // `click` rather than `mousedown`: the input keeps focus because the
      // button lives in the same shadow root and we never blur it.
      this.ui.input.addEventListener('keydown', (e: KeyboardEvent) => this.onKeyDown(e));
      // Any caret move can leave or enter a token, so the offered list has to
      // follow the caret and not only the keystrokes that changed the text.
      this.ui.input.addEventListener('click', () => this.refreshSuggestions());
      this.ui.input.addEventListener('blur', () => this.closeSuggestions());
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

    /**
     * Extra `@`-able subjects, on top of the session's own model participants.
     *
     * Set it to the nouns THIS app's users talk about — customers, tickets,
     * accounts. They render as chips and complete in the composer; they do not
     * route, because only a model participant can take a turn.
     *
     * Copied on the way in, so a host mutating the array it passed cannot
     * silently change what the element believes without a repaint.
     */
    get mentionables(): Mentionable[] { return [...this.appMentions]; }

    set mentionables(list: Mentionable[]) {
      this.appMentions = Array.isArray(list) ? list.filter((m) => m && m.handle) : [];
      this.paint();
    }

    /**
     * `prefix + handle` → subject, for both the transcript and the typeahead.
     *
     * Keyed WITH the prefix so `@ast-1` and `#ast-1` are different subjects
     * rather than one overwriting the other — which is the whole point of a
     * second symbol.
     *
     * The session's MODEL participants come first and the app's list is layered
     * over them, so an app can relabel `@risk` but cannot accidentally shadow a
     * real addressee with an inert subject of the same name.
     */
    private mentionMap(): Map<string, Mentionable> {
      const out = new Map<string, Mentionable>();
      const session = this.client && this.sid ? this.client.session(this.sid) : null;
      for (const p of session?.participants ?? []) {
        if (p.kind !== 'model' || !p.agent) continue;
        out.set(DEFAULT_PREFIX + p.agent, {
          handle: p.agent, label: p.agent, kind: 'agent',
          detail: p.displayName, prefix: DEFAULT_PREFIX,
        });
      }
      for (const m of this.appMentions) {
        const prefix = m.prefix ?? DEFAULT_PREFIX;
        out.set(prefix + m.handle, { kind: 'subject', ...m, prefix });
      }
      return out;
    }

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
      // `verbosity` changes only what is DRAWN. Re-subscribing for it would
      // tear down a live session to change a display filter.
      if (name === 'verbosity') { this.paint(); return; }
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
      // `verbosity="quiet"` drops the machine's working (tool results, the
      // `→ name({…})` traces, and the tool-only assistant rows those leave
      // behind). Anything else — including an absent attribute — is `full`,
      // so the default is unchanged for every existing consumer.
      const quiet = this.getAttribute('verbosity') === 'quiet';
      const mentions = this.mentionMap();
      const nodes: HTMLElement[] = rows
        .map((m) => renderRow(m, names, download, quiet, mentions))
        .filter((n): n is HTMLElement => n !== null);
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
        // The tool's own park-time account (participants spec §8) LEADS, and
        // the exact arguments follow it — the shape every channel lens
        // already uses. Rendering the summary INSTEAD of the args left the
        // approver with no access to the record they are authorizing, which
        // matters most for the tools that summarize hardest: a memory
        // promotion shows 300 marked characters of a fact that may be 2000.
        const argsJson = JSON.stringify(ask.args, null, 2) ?? '';
        const clamped = argsJson.length > 2000 ? `${argsJson.slice(0, 2000)}…` : argsJson;
        this.ui.approvalText.textContent = ask.display
          ? `${ask.display}${runsAs}\n\n${clamped}`
          : `The agent wants to run ${ask.name}(${clamped})${runsAs}`;
      }
    }

    /**
     * The token being typed, or null.
     *
     * Anchored to the CARET, not the whole value: a message may already contain
     * finished mentions, and completing the one under the cursor is the only
     * behaviour that does not rewrite text the user has moved on from.
     */
    private tokenAtCaret(): { start: number; query: string; prefix: string } | null {
      const { input } = this.ui;
      // A range selection has no single insertion point to complete at.
      if (input.selectionStart === null || input.selectionStart !== input.selectionEnd) return null;
      const caret = input.selectionStart;
      const prefixes = [...new Set(
        [...this.mentionMap().values()].map((m) => m.prefix ?? DEFAULT_PREFIX),
      )];
      if (prefixes.length === 0) return null;
      const hit = tokenPattern(prefixes, true).exec(input.value.slice(0, caret));
      if (!hit) return null;
      // The symbol must open a word — mid-token (an email address) it is not a
      // mention.
      const before = hit.index === 0 ? '' : input.value[hit.index - 1];
      if (before !== '' && !/\s/.test(before)) return null;
      return { start: hit.index, prefix: hit[1], query: hit[2] };
    }

    private refreshSuggestions() {
      const token = this.tokenAtCaret();
      if (!token) { this.closeSuggestions(); return; }
      const q = token.query.toLowerCase();
      const all = [...this.mentionMap().values()];
      const matches = all
        // Only what THIS symbol names: typing `#` must not offer a person.
        .filter((m) => (m.prefix ?? DEFAULT_PREFIX) === token.prefix)
        .filter((m) => `${m.handle} ${m.label ?? ''}`.toLowerCase().includes(q));
      if (matches.length === 0) { this.closeSuggestions(); return; }
      // Agents before subjects: in a chat the addressable thing is the more
      // likely intent, and a roster is short enough that it never buries the
      // subject list.
      matches.sort((a, b) => Number(a.kind === 'subject') - Number(b.kind === 'subject'));
      this.suggestions = matches.slice(0, 8);
      this.cursorAt = 0;
      this.paintSuggestions();
    }

    private paintSuggestions() {
      const { typeahead, input } = this.ui;
      typeahead.replaceChildren(...this.suggestions.map((m, i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'suggestion';
        row.setAttribute('part', 'suggestion');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(i === this.cursorAt));
        const handle = document.createElement('span');
        handle.className = 'suggestion-handle';
        handle.setAttribute('part', 'suggestion-handle');
        handle.textContent = `${m.prefix ?? DEFAULT_PREFIX}${m.label ?? m.handle}`;
        row.append(handle);
        if (m.detail) {
          const detail = document.createElement('span');
          detail.className = 'suggestion-detail';
          detail.setAttribute('part', 'suggestion-detail');
          detail.textContent = m.detail;
          row.append(detail);
        }
        // `mousedown`, not `click`: the input's blur fires first on a click and
        // would close the list out from under the press.
        row.addEventListener('mousedown', (e: MouseEvent) => {
          e.preventDefault();
          this.cursorAt = i;
          this.acceptSuggestion();
        });
        return row;
      }));
      typeahead.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    private closeSuggestions() {
      if (this.suggestions.length === 0) return;
      this.suggestions = [];
      this.cursorAt = -1;
      this.ui.typeahead.hidden = true;
      this.ui.typeahead.replaceChildren();
      this.ui.input.setAttribute('aria-expanded', 'false');
    }

    private onKeyDown(e: KeyboardEvent) {
      if (this.suggestions.length === 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const n = this.suggestions.length;
        this.cursorAt = (this.cursorAt + step + n) % n;
        this.paintSuggestions();
        return;
      }
      if (e.key === 'Tab') { e.preventDefault(); this.acceptSuggestion(); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.closeSuggestions(); }
      // Enter deliberately falls through to the form's submit handler, which
      // completes instead of sending while this list is open.
    }

    private acceptSuggestion() {
      const chosen = this.suggestions[this.cursorAt];
      const token = this.tokenAtCaret();
      if (!chosen || !token) { this.closeSuggestions(); return; }
      const { input } = this.ui;
      const caret = input.selectionStart ?? input.value.length;
      // The trailing space is what ends the token: without it the next
      // keystroke re-opens the list against a handle that is already complete.
      const insert = `${chosen.prefix ?? DEFAULT_PREFIX}${chosen.handle} `;
      input.value = input.value.slice(0, token.start) + insert + input.value.slice(caret);
      const at = token.start + insert.length;
      input.setSelectionRange(at, at);
      this.closeSuggestions();
      input.focus();
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
