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
  /** Free-form; becomes a `part` token, so `::part(mention ticket)` works. */
  kind?: string;
  /** A second line in the typeahead — an address, a role, a price, a date. */
  detail?: string;
}

/** A field name on the record, or a function derived from it. A function is
 *  what a stored column cannot express: a handle slugged from a display name,
 *  a label joined from two columns. */
type Field<T> = string | ((record: never) => T | undefined);

/** The shape this element needs from a live collection: a reactive `find` it
 *  can `fetch`. Structural on purpose — the package neither imports Mongo nor
 *  requires that the thing on the other side IS Mongo. */
export interface MentionCollection {
  find(selector: unknown, options: unknown): { fetch(): unknown[] };
}

interface MentionShape {
  /** The `part` token every entry from this source carries. */
  kind?: string;
  /** What follows the symbol. Required — nothing else identifies the record. */
  handle: Field<string>;
  /** Defaults to the handle. */
  label?: Field<string>;
  detail?: Field<string>;
  /** How many the typeahead offers at once. Default 8. */
  limit?: number;
  /** Ceiling on records pulled from a collection in one read. Default 1000 —
   *  a guard against an unbounded publication, not a page size. */
  max?: number;
}

/**
 * Where the things one symbol names come from.
 *
 * Three forms, because the shapes an app actually has are not all the same:
 * a live collection whose contents change under the user, a plain list that is
 * computed or static, or — when neither fits — the two functions the element
 * really needs. The first two are conveniences over the third.
 *
 * A collection is read inside the element's own `Tracker.autorun`, so chips
 * repaint when the underlying data changes with nothing to wire up.
 */
export type MentionSource =
  | (MentionShape & { collection: MentionCollection; list?: never })
  | (MentionShape & { list: unknown[] | (() => unknown[]); collection?: never })
  | {
    kind?: string;
    /** Everything matching what has been typed so far. `''` means "the symbol
     *  was just typed" — answer with a sensible opening set, not everything. */
    search(query: string): Mentionable[];
    /** One exact handle, for rendering a chip in text already written. Omit it
     *  and `search(handle)` is used, which is correct but does more work. */
    lookup?(handle: string): Mentionable | null | undefined;
  };

/** What a symbol resolves to once the three source forms are flattened. */
interface ResolvedSource {
  search(query: string): Mentionable[];
  lookup(handle: string): Mentionable | null;
}

const DEFAULT_PREFIX = '@';
const DEFAULT_LIMIT = 8;
const DEFAULT_MAX = 1000;

function fieldOf<T>(record: unknown, field: Field<T> | undefined): T | undefined {
  if (field === undefined) return undefined;
  if (typeof field === 'function') return (field as (r: unknown) => T | undefined)(record);
  return (record as Record<string, T> | null)?.[field];
}

function matches(m: Mentionable, needle: string): boolean {
  return `${m.handle} ${m.label ?? ''}`.toLowerCase().includes(needle);
}

/**
 * One source, whatever form it arrived in, as `search` + `lookup`.
 *
 * The collection and list forms MATERIALISE ONCE per resolver and cache, so a
 * paint that renders forty rows reads the collection once rather than forty
 * times. The cache is safe because a resolver is built fresh per paint and per
 * keystroke — it never outlives the read it was made for, so it cannot go
 * stale against the data it came from.
 */
function normalizeSource(src: MentionSource): ResolvedSource {
  if ('search' in src && typeof src.search === 'function') {
    const ok = (list: Mentionable[] | undefined) => (list ?? []).filter((m) => m && m.handle);
    return {
      search: (q) => ok(src.search(q)),
      lookup: (h) => (src.lookup
        ? src.lookup(h) ?? null
        : ok(src.search(h)).find((m) => m.handle === h) ?? null),
    };
  }
  const cfg = src as MentionShape & {
    collection?: MentionCollection; list?: unknown[] | (() => unknown[]);
  };
  let cache: Mentionable[] | null = null;
  const all = (): Mentionable[] => {
    if (cache) return cache;
    const records: unknown[] = cfg.collection
      ? cfg.collection.find({}, { limit: cfg.max ?? DEFAULT_MAX }).fetch()
      : (typeof cfg.list === 'function' ? cfg.list() : cfg.list ?? []);
    cache = records
      .map((r) => ({
        handle: String(fieldOf<string>(r, cfg.handle) ?? ''),
        label: fieldOf<string>(r, cfg.label),
        detail: fieldOf<string>(r, cfg.detail),
        kind: cfg.kind,
      }))
      .filter((m) => m.handle !== '');
    return cache;
  };
  return {
    search: (q) => all().filter((m) => matches(m, q.toLowerCase())).slice(0, cfg.limit ?? DEFAULT_LIMIT),
    lookup: (h) => all().find((m) => m.handle === h) ?? null,
  };
}
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

  /* A resolved handle. Inline so it wraps with the sentence it is part of —
     a chip that cannot break mid-line turns one long mention into a scrollbar.
     The QUIET treatment is the default, because merely naming something is the
     common case and it schedules nothing. */
  .mention {
    border-radius: 0.35rem; padding: 0 0.2rem; font-weight: 500;
    background: color-mix(in srgb, var(--_fg) 13%, transparent);
  }
  /* ADDRESSED: a leading at-sign naming a model participant, which is the only
     mention that actually schedules a turn. It gets the accent and the arrow,
     because it is the one that DID something. (No backticks in this sheet —
     it is a template literal.) */
  .mention.addressed {
    background: color-mix(in srgb, var(--_accent) 22%, transparent);
    font-weight: 600;
  }
  .mention.addressed::before {
    content: '→'; margin-right: 0.15rem; opacity: 0.75; font-weight: 400;
  }
  /* On the user bubble the accent IS the background, so a chip has to lift off
     white instead of off the page. */
  .message.user .mention { background: color-mix(in srgb, #fff 22%, transparent); }
  .message.user .mention.addressed { background: color-mix(in srgb, #fff 38%, transparent); }

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
  // The near miss. Says what was meant and what to do, because the fix is a
  // rewrite by whoever (or whatever) wrote the message.
  if (m.kind === 'unrouted-mention') {
    return m.error?.reason
      ?? `@${m.mentioned} was named but not addressed — nothing was sent.`;
  }
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
  mentions: Map<string, ResolvedSource> = new Map(),
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
function renderText(text: string, mentions: Map<string, ResolvedSource>): Node[] {
  if (!text) return [];
  if (mentions.size === 0) return [document.createTextNode(text)];
  const prefixes = [...mentions.keys()];
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
    const source = mentions.get(prefix);
    const exact = source?.lookup(raw) ?? null;
    const found = exact ?? (trimmed !== raw ? source?.lookup(trimmed) ?? null : null);
    if (found) {
      const handle = exact ? raw : trimmed;
      if (hit.index > cursor) nodes.push(document.createTextNode(text.slice(cursor, hit.index)));
      const chip = document.createElement('span');
      const kind = found.kind ?? 'subject';
      // ADDRESSED vs merely NAMED. `resolveAddressee` reads one position — the
      // leading token — so `@risk` at the front of a message schedules Risk's
      // turn and `@risk` in the second paragraph schedules nothing. Rendering
      // both identically is a chip that promises routing it cannot deliver:
      // the transcript then shows a confident mention beside a roster that
      // never woke, and the reader has no way to tell which happened.
      const addressed = kind === 'agent'
        && prefix === DEFAULT_PREFIX
        && /^\s*$/.test(text.slice(0, hit.index));
      const flags = addressed ? `${kind} addressed` : kind;
      chip.className = `mention ${flags}`;
      chip.setAttribute('part', `mention ${flags}`);
      chip.textContent = `${prefix}${found.label ?? handle}`;
      chip.title = found.detail
        ?? (addressed ? `Addressed to ${handle} — schedules their turn` : '');
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
    private sources: Record<string, MentionSource> = {};
    /** The suggestions currently offered, and which one Enter would take. */
    private suggestions: Mentionable[] = [];
    /** The symbol that opened the list. Carried separately because a record no
     *  longer knows its own symbol — the source it came from is keyed by one. */
    private suggestPrefix: string = DEFAULT_PREFIX;
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
     * What each symbol names, keyed BY the symbol.
     *
     * ```js
     * chat.mentionSources = {
     *   '@': { collection: Customers, handle: (c) => slug(c.name), label: 'name', kind: 'customer' },
     *   '#': { list: () => tickets.open(), handle: 'id', label: 'title', kind: 'ticket' },
     * };
     * ```
     *
     * The element owns the UI — matching, the typeahead, the keyboard, chips in
     * the transcript — and the app owns only WHERE the records come from. It
     * never inspects a record beyond the fields named here, so nothing about
     * the app's domain reaches the package.
     *
     * `@` always carries the session's own MODEL participants, layered UNDER
     * anything set here: an app can add subjects to `@` but cannot shadow a
     * real addressee with an inert one of the same name. Every other symbol is
     * inert by construction, because `resolveAddressee` parses one leading `@`
     * and nothing else.
     *
     * A second symbol earns its place when the things named are of a different
     * ORDER, not merely a different type: `@` reaches someone who could answer;
     * `#` might name a row in a price list that could never take a turn. One
     * symbol for both makes the composer offer a product where a person belongs.
     */
    get mentionSources(): Record<string, MentionSource> { return { ...this.sources }; }

    set mentionSources(next: Record<string, MentionSource>) {
      this.sources = next && typeof next === 'object' ? { ...next } : {};
      this.paint();
    }

    /**
     * Symbol → resolved source, for both the transcript and the typeahead.
     *
     * Built FRESH on every read, which is what makes the collection form
     * reactive: `find().fetch()` runs inside the caller's `Tracker.autorun`, so
     * a paint re-registers its dependency each time and re-runs when the data
     * changes. It is also what makes each source's internal cache safe.
     */
    private mentionMap(): Map<string, ResolvedSource> {
      const out = new Map<string, ResolvedSource>();
      for (const [prefix, src] of Object.entries(this.sources)) {
        if (src) out.set(prefix, normalizeSource(src));
      }

      const session = this.client && this.sid ? this.client.session(this.sid) : null;
      const roster: Mentionable[] = [];
      for (const p of session?.participants ?? []) {
        if (p.kind !== 'model' || !p.agent) continue;
        roster.push({ handle: p.agent, label: p.agent, kind: 'agent', detail: p.displayName });
      }
      if (roster.length === 0 && !out.has(DEFAULT_PREFIX)) return out;

      // The roster goes FIRST in both directions, so a real addressee always
      // wins the name over an app subject that happens to share it.
      const app = out.get(DEFAULT_PREFIX);
      out.set(DEFAULT_PREFIX, {
        search: (q) => {
          const needle = q.toLowerCase();
          const hits = roster.filter((m) => matches(m, needle));
          const extra = (app?.search(q) ?? []).filter(
            (m) => !roster.some((r) => r.handle === m.handle),
          );
          return [...hits, ...extra];
        },
        lookup: (h) => roster.find((m) => m.handle === h) ?? app?.lookup(h) ?? null,
      });
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
      const prefixes = [...this.mentionMap().keys()];
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
      // Only what THIS symbol names: typing `#` must not offer a person. The
      // source does its own matching, so a big collection can filter at the
      // query rather than shipping everything here to be sieved.
      const source = this.mentionMap().get(token.prefix);
      const hits = source ? source.search(token.query) : [];
      if (hits.length === 0) { this.closeSuggestions(); return; }
      // Agents before everything else: in a chat the addressable thing is the
      // likelier intent, and a roster is short enough that it never buries the
      // rest.
      const ranked = [...hits].sort(
        (a, b) => Number(a.kind !== 'agent') - Number(b.kind !== 'agent'),
      );
      this.suggestions = ranked.slice(0, 8);
      this.suggestPrefix = token.prefix;
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
        handle.textContent = `${this.suggestPrefix}${m.label ?? m.handle}`;
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
      const insert = `${token.prefix}${chosen.handle} `;
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
