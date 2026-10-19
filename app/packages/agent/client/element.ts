import { Tracker } from 'meteor/tracker';
import { Agent } from './agent';
import { renderAssistantMarkdown } from './markdown';
import { ACTIVE_PHASES, type Phase, type ViewMessage } from '../common/types';
import { prettySize } from '../common/format';
import { modelMentionHandles, modelParticipantByHandle } from '../common/participants';

/** `<agent-chat>` — a custom element rendering a whole session. Never
 *  auto-registered (a second `customElements.define` is a DOMException);
 *  the app calls `defineAgentChat()` or `defineAgentChat('my-tag')`. */

const DEFAULT_TAG = 'agent-chat';
const DEFAULT_PLACEHOLDER = 'Message the agent…';
const DEFAULT_NOTE_PLACEHOLDER = 'Add a crew note…';
export type ComposerMode = 'ask' | 'note';
export interface ComposerSubmission {
  sessionId: string;
  text: string;
  mode: ComposerMode;
  /** Explicit model participant selected by the host. Crew notes omit it. */
  recipient?: string;
}
/** Optional application-owned write boundary. Throw to preserve the draft. */
export type ComposerSubmissionHandler = (submission: ComposerSubmission) => Promise<unknown>;
export interface ComposerDraftOptions {
  selectionStart?: number;
  selectionEnd?: number;
  focus?: boolean;
}
export interface ChatTimelineItem {
  id: string;
  createdAt: Date | number;
  afterMessageId?: string;
  element: HTMLElement;
}
/** Public property/method surface for typed app-owned custom elements. */
export interface AgentChatElement extends HTMLElement {
  readonly sessionId: string | null;
  readonly agentInstance: Agent | null;
  composerMode: ComposerMode;
  /** Model participant ID for asks. Undefined preserves leading-@/primary routing. */
  recipient: string | undefined;
  submissionHandler: ComposerSubmissionHandler | null;
  allowEmptySubmit: boolean;
  draftText: string;
  mentionSources: Record<string, MentionSource>;
  timelineItems: ChatTimelineItem[];
  /** Show "Reply in thread" on user and assistant rows. */
  threadable: boolean;
  /** Paint only rows with `seq >= fromSeq`; `null` paints every row. */
  fromSeq: number | null;
  setDraft(text: string, options?: ComposerDraftOptions): void;
  focusComposer(): void;
  submitDraft(): Promise<void>;
  insertMention(prefix: string, handle: string): boolean;
  openMentions(prefix: string): boolean;
  /** Reveal an already rendered, visible message without changing the session. */
  revealMessage(messageId: string): boolean;
}

function composerMode(value: string | null): ComposerMode {
  return value === 'note' ? 'note' : 'ask';
}

/** Something a message can name with `@`. Model participants are resolved
 *  automatically; app-specific subjects (via `mentionables`) autocomplete
 *  and render but schedule nothing. */
export interface Mentionable {
  handle: string;
  /** Shown in the chip and the typeahead. Defaults to `handle`. */
  label?: string;
  /** Free-form; becomes a `part` token, so `::part(mention ticket)` works. */
  kind?: string;
  /** A second line in the typeahead — an address, a role, a price, a date. */
  detail?: string;
  /** Non-@ references can open an app-owned detail view without sending. */
  actionable?: boolean;
}

/** A field name or a function derived from the record. */
type Field<T> = string | ((record: never) => T | undefined);

/** Structural — any object with a reactive `find().fetch()`. */
export interface MentionCollection {
  find(selector: unknown, options: unknown): { fetch(): unknown[] };
}

interface MentionShape {
  /** The `part` token every entry from this source carries. */
  kind?: string;
  actionable?: boolean;
  /** Visible feedback while a source is loading or has no matching entries. */
  emptyText?: string;
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

/** Three forms: a reactive collection, a plain list, or raw search/resolve
 *  functions. Collection reads run inside the element's Tracker.autorun. */
export type MentionSource =
  | (MentionShape & { collection: MentionCollection; list?: never })
  | (MentionShape & { list: unknown[] | (() => unknown[]); collection?: never })
  | {
    kind?: string;
    actionable?: boolean;
    emptyText?: string;
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
  emptyText?: string;
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

/** Normalize any source form into search + lookup. Collection/list forms
 *  materialize once per resolver and cache (resolver is per-paint/keystroke). */
function normalizeSource(src: MentionSource): ResolvedSource {
  if ('search' in src && typeof src.search === 'function') {
    const decorate = (m: Mentionable): Mentionable => ({
      ...m, kind: m.kind ?? src.kind, actionable: m.actionable ?? src.actionable,
    });
    const ok = (list: Mentionable[] | undefined) => (list ?? [])
      .filter((m) => m && m.handle).map(decorate);
    return {
      search: (q) => ok(src.search(q)),
      lookup: (h) => {
        const found = src.lookup ? src.lookup(h) : ok(src.search(h)).find((m) => m.handle === h);
        return found ? decorate(found) : null;
      },
      emptyText: src.emptyText,
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
        actionable: cfg.actionable,
      }))
      .filter((m) => m.handle !== '');
    return cache;
  };
  return {
    search: (q) => all().filter((m) => matches(m, q.toLowerCase())).slice(0, cfg.limit ?? DEFAULT_LIMIT),
    lookup: (h) => all().find((m) => m.handle === h) ?? null,
    emptyText: cfg.emptyText,
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
    : new RegExp(`(${set})(${HANDLE_CLASS}{1,64})(?!${HANDLE_CLASS})`, 'g');
}
/** Default deny reason — reaches the model as the tool result text. */
const DENY_REASON = 'denied by the user';
const DENY_GUIDANCE_MAX = 400;
const MESSAGE_TARGET_DURATION = 2_000;

/** Static markup only — transcript content never reaches `innerHTML`; assistant
 *  Markdown is an allowlisted DOM tree whose leaves are Text nodes.
 *  Themed via `part` attributes and CSS custom properties. */
const FRAME = `
<style>
  :host {
    /* Public knobs → private aliases; defaults are system color keywords. */
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
  /* display:flex on :host beats the UA [hidden] rule. */
  :host([hidden]) { display: none; }

  .root {
    display: flex; flex-direction: column; flex: 1; min-height: 0;
    container: agent-chat / inline-size;
  }
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
  .new-messages {
    align-self: center; z-index: 1; margin: -3rem 0 0.65rem;
    min-height: 2rem; padding: 0.35rem 0.75rem; border-radius: 999px;
    box-shadow: 0 0.35rem 1rem color-mix(in srgb, var(--_fg) 18%, transparent);
  }
  .new-messages[hidden] { display: none; }
  .message {
    max-width: 85%; padding: 0.5rem 0.75rem; border-radius: var(--_radius);
    white-space: pre-wrap; word-break: break-word;
  }
  .message.message-target {
    outline: 2px solid var(--_accent); outline-offset: 3px;
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--_accent) 14%, transparent);
  }
  .message.threadable { position: relative; }
  .thread-button {
    position: absolute; top: -0.7rem; right: 0.5rem;
    padding: 0.1rem 0.5rem; border-radius: 999px; font: inherit; font-size: 0.75rem;
    border: 1px solid color-mix(in srgb, var(--_fg) 18%, var(--_bg));
    background: var(--_bg); color: var(--_fg); cursor: pointer;
    opacity: 0; pointer-events: none;
  }
  .message.threadable:hover .thread-button,
  .message.threadable:focus-within .thread-button { opacity: 1; pointer-events: auto; }
  .thread-button:focus-visible { outline: 2px solid var(--_accent); outline-offset: 2px; }
  .message.user { align-self: flex-end; background: var(--_accent); color: #fff; }
  .message.assistant { align-self: flex-start; background: color-mix(in srgb, var(--_fg) 8%, var(--_bg)); }
  .message.assistant.streaming::after { content: '▍'; animation: agent-chat-blink 1s steps(1) infinite; }
  .markdown {
    min-width: 0; white-space: normal; word-break: normal; overflow-wrap: anywhere;
    font: inherit; line-height: 1.55;
  }
  .markdown > :first-child { margin-top: 0; }
  .markdown > :last-child { margin-bottom: 0; }
  .markdown-paragraph { margin: 0.45rem 0; }
  .markdown-heading {
    margin: 0.85rem 0 0.35rem; font-weight: 720; line-height: 1.25;
    letter-spacing: -0.012em;
  }
  .markdown-heading-1 { font-size: 1.25rem; }
  .markdown-heading-2 { font-size: 1.14rem; }
  .markdown-heading-3 { font-size: 1.05rem; }
  .markdown-heading-4, .markdown-heading-5, .markdown-heading-6 { font-size: 1rem; }
  .markdown-list { margin: 0.45rem 0; padding-left: 1.4rem; }
  .markdown-list .markdown-list { margin: 0.2rem 0; }
  .markdown-list-item { padding-left: 0.12rem; }
  .markdown-list-item + .markdown-list-item { margin-top: 0.2rem; }
  .markdown-list-item > .markdown-paragraph { margin: 0; }
  .markdown-checkbox { margin: 0 0.4rem 0 -1.25rem; accent-color: var(--_accent); }
  .markdown-strong { font-weight: 700; }
  .markdown-inline-code {
    border: 1px solid color-mix(in srgb, var(--_fg) 12%, transparent);
    border-radius: 0.3rem; padding: 0.08rem 0.28rem;
    background: color-mix(in srgb, var(--_fg) 7%, var(--_bg));
    font: 0.88em/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    white-space: break-spaces;
  }
  .markdown-code-frame {
    position: relative; min-width: 0; margin: 0.55rem 0;
    border: 1px solid color-mix(in srgb, var(--_fg) 13%, transparent);
    border-radius: calc(var(--_radius) * 0.78); overflow: hidden;
    background: color-mix(in srgb, var(--_fg) 6%, var(--_bg));
  }
  .markdown-language {
    display: block; padding: 0.35rem 0.7rem 0;
    color: color-mix(in srgb, var(--_fg) 52%, transparent);
    font: 650 0.64rem/1.25 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    letter-spacing: 0.055em; text-transform: uppercase;
  }
  .markdown-code-block {
    max-width: 100%; overflow-x: auto; margin: 0; padding: 0.7rem;
    white-space: pre; word-break: normal; overflow-wrap: normal; tab-size: 2;
    font: 0.82rem/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  .markdown-blockquote {
    margin: 0.55rem 0; padding: 0.05rem 0 0.05rem 0.75rem;
    border-left: 2px solid color-mix(in srgb, var(--_accent) 58%, transparent);
    color: color-mix(in srgb, var(--_fg) 72%, transparent);
  }
  .markdown-rule {
    height: 1px; margin: 0.8rem 0; border: 0;
    background: color-mix(in srgb, var(--_fg) 14%, transparent);
  }
  .markdown-link { color: var(--_accent); text-decoration: underline; text-underline-offset: 0.14em; }
  .markdown-link:hover { text-decoration-thickness: 2px; }
  .markdown-link:focus-visible { outline: 2px solid var(--_accent); outline-offset: 2px; border-radius: 0.15rem; }
  .markdown-table-frame { max-width: 100%; overflow-x: auto; margin: 0.55rem 0; }
  .markdown-table { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  .markdown-table th, .markdown-table td {
    padding: 0.42rem 0.55rem; border: 1px solid color-mix(in srgb, var(--_fg) 14%, transparent);
    text-align: left; vertical-align: top;
  }
  .markdown-table th { background: color-mix(in srgb, var(--_fg) 6%, var(--_bg)); font-weight: 700; }
  .message.tool {
    align-self: flex-start; max-width: 100%; display: flex; gap: 0.4rem;
    font-size: 0.8rem; opacity: 0.75; font-family: ui-monospace, monospace;
  }
  .message.operation {
    align-self: flex-start; max-width: 100%; font-size: 0.8rem; opacity: 0.72;
  }
  .message.operation.error { color: var(--_danger); opacity: 0.9; }
  .message.operation.handoff {
    display: grid; gap: 0.4rem; max-width: 86%; opacity: 1;
    padding: 0.7rem 0.9rem; border: 1px solid color-mix(in srgb, var(--_accent) 22%, transparent);
    border-radius: var(--_radius); background: color-mix(in srgb, var(--_accent) 5%, var(--_bg));
  }
  .handoff-header { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.35rem 0.7rem; }
  .handoff-route { font-weight: 650; }
  .handoff-status { color: color-mix(in srgb, var(--_fg) 70%, transparent); font-size: 0.75rem; }
  .handoff-message { min-width: 0; font-size: 0.9rem; }
  .message.operation.delegation, .message.note.delegation {
    display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem 1rem; opacity: 1;
  }
  .delegation-status { opacity: 0.72; }
  .delegation-link {
    display: inline-flex; align-items: center; min-height: 2rem; padding: 0.3rem 0.55rem;
    border: 1px solid color-mix(in srgb, var(--_accent) 28%, transparent); border-radius: 0.45rem;
    background: color-mix(in srgb, var(--_accent) 7%, var(--_bg)); color: var(--_accent);
    font: inherit; font-weight: 600; cursor: pointer; text-align: left;
  }
  .delegation-link:hover { background: color-mix(in srgb, var(--_accent) 15%, var(--_bg)); }
  .delegation-link:focus-visible { outline: 2px solid var(--_accent); outline-offset: 3px; }
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
  .operations { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.25rem; }
  .operation-status { font-size: 0.8rem; opacity: 0.72; }
  /* Attribution (participants spec §4.1): the speaker line a rostered row
     carries. Absent on 1:1 rows, so nothing changes for the classic pair. */
  .speaker { display: block; font-size: 0.72rem; opacity: 0.65; font-weight: 600; }
  .source, .recipient { font-weight: 500; }
  .crew-note-header {
    display: flex; align-items: center; flex-wrap: wrap; gap: 0.4rem 0.65rem;
    margin-bottom: 0.5rem; white-space: normal;
  }
  .crew-note-header .speaker { min-width: 0; margin: 0; overflow-wrap: anywhere; }
  .crew-note-badge {
    display: inline-flex; align-items: center; width: fit-content;
    flex-shrink: 0; margin: 0; padding: 0.12rem 0.4rem;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 0.35rem; font-size: 0.7rem; font-weight: 600;
    letter-spacing: 0.01em; line-height: 1.35; white-space: nowrap;
  }
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

  /* Inline so a mention wraps with its sentence. */
  .mention {
    border-radius: 0.35rem; padding: 0 0.2rem; font-weight: 500;
    background: color-mix(in srgb, var(--_fg) 13%, transparent);
  }
  button.mention {
    display: inline; color: inherit; font: inherit; font-weight: 600;
    padding: 0 0.2rem; border-radius: 0.35rem; line-height: inherit;
    text-decoration: underline; text-underline-offset: 0.15em;
    background: color-mix(in srgb, var(--_fg) 13%, transparent);
  }
  button.mention:hover { background: color-mix(in srgb, var(--_accent) 28%, transparent); }
  button.mention:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
  /* ADDRESSED: a leading @-mention that schedules a turn. */
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
  .suggestion-empty { padding: 0.6rem 0.75rem; font-size: 0.85rem; opacity: 0.75; }

  .approval {
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 0.75rem; align-items: center; padding: 0.85rem 1rem;
    border-top: 1px solid var(--_warn);
    background: color-mix(in srgb, var(--_warn) 12%, var(--_bg));
    font-size: 0.9rem;
  }
  /* The display:flex above beats the UA's [hidden] { display: none } — without
     this rule the approval bar renders even when nothing is pending. */
  .approval[hidden] { display: none; }
  .approval-signal {
    width: 2rem; height: 2rem; display: grid; place-items: center; align-self: start;
    border: 1px solid color-mix(in srgb, var(--_warn) 38%, transparent);
    border-radius: 0.6rem; background: color-mix(in srgb, var(--_warn) 14%, transparent);
    color: var(--_warn); font-weight: 750;
  }
  /* approval-text remains the aggregate public seam: clean mode contains
     bounded human context; debug alone adds the exact record below it. */
  .approval-text { min-width: 0; display: flex; flex-direction: column; gap: 0.25rem; }
  .approval-kicker {
    color: var(--_warn); font-size: 0.72rem; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase;
  }
  .approval-title { color: var(--_fg); font-size: 0.96rem; line-height: 1.35; }
  .approval-summary {
    color: color-mix(in srgb, var(--_fg) 72%, transparent);
    font-size: 0.82rem; line-height: 1.45; white-space: pre-wrap; word-break: break-word;
  }
  .approval-summary[hidden], .approval-debug[hidden] { display: none; }
  .approval-meta { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.15rem; }
  .approval-meta > span {
    min-height: 1.35rem; display: inline-flex; align-items: center;
    border: 1px solid color-mix(in srgb, var(--_fg) 14%, transparent);
    border-radius: 999px; padding: 0.1rem 0.45rem;
    color: color-mix(in srgb, var(--_fg) 65%, transparent); font-size: 0.72rem;
  }
  .approval-status {
    min-height: 1.15rem; color: color-mix(in srgb, var(--_fg) 62%, transparent);
    font-size: 0.75rem; line-height: 1.35;
  }
  .approval-guidance {
    display: flex; flex-direction: column; gap: 0.3rem; margin-top: 0.2rem;
  }
  .approval-guidance-label {
    color: color-mix(in srgb, var(--_fg) 62%, transparent);
    font-size: 0.75rem; line-height: 1.35;
  }
  .deny-guidance {
    width: 100%; box-sizing: border-box; padding: 0.45rem 0.6rem;
    border: 1px solid color-mix(in srgb, var(--_fg) 22%, transparent);
    border-radius: 0.45rem; background: var(--_bg); color: var(--_fg); font: inherit;
  }
  .deny-guidance:disabled { opacity: 0.6; }
  .approval[data-state="error"] .approval-status { color: var(--_danger); }
  .approval[data-state="approved"] .approval-status,
  .approval[data-state="denied"] .approval-status { color: var(--_warn); }
  .approval-debug {
    max-height: 9rem; overflow: auto; margin: 0.35rem 0 0; padding: 0.55rem;
    border: 1px solid color-mix(in srgb, var(--_fg) 14%, transparent);
    border-radius: 0.45rem; background: color-mix(in srgb, var(--_fg) 5%, var(--_bg));
    color: color-mix(in srgb, var(--_fg) 75%, transparent);
    font: 0.72rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap; word-break: break-word;
  }
  .approval-actions { display: flex; align-items: center; gap: 0.45rem; }
  .approval-actions button { min-width: 5.6rem; min-height: 2.25rem; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; }
  .approval-actions button:disabled { opacity: 0.62; cursor: progress; }
  .approval-actions button[data-loading="true"]::before {
    content: ''; width: 0.65rem; height: 0.65rem; border-radius: 50%;
    border: 1.5px solid color-mix(in srgb, currentColor 28%, transparent);
    border-top-color: currentColor; animation: agent-chat-spin 0.7s linear infinite;
  }
  @container agent-chat (max-width: 38rem) {
    .approval { grid-template-columns: auto minmax(0, 1fr); align-items: start; }
    .approval-actions {
      grid-column: 2; width: 100%; display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 0.25rem;
    }
  }
  @container agent-chat (max-width: 26rem) {
    .approval { grid-template-columns: 1fr; }
    .approval-signal { display: none; }
    .approval-actions { grid-column: 1; }
  }

  .composer {
    display: flex; gap: 0.5rem; padding: 0.75rem 1rem;
    border-top: 1px solid color-mix(in srgb, var(--_fg) 15%, transparent);
    /* The typeahead anchors to this. */
    position: relative;
  }
  slot[name="composer-actions"] { display: contents; }
  slot[name="composer-header"], slot[name="composer-context"], slot[name="composer-toolbar"] { display: contents; }
  .composer-footer, .composer-buttons { display: contents; }
  :host([composer-layout="panel"]) .composer { flex-direction: column; }
  :host([composer-layout="panel"]) .input { flex: none; width: 100%; }
  :host([composer-layout="panel"]) .composer-footer {
    display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem;
  }
  :host([composer-layout="panel"]) .composer-buttons {
    display: flex; gap: 0.5rem; margin-left: auto; align-items: center;
  }
  slot[name="activity"]::slotted(*) { flex-shrink: 0; max-height: 35%; overflow-y: auto; }
  :host([composer-mode="note"]) .composer {
    background: color-mix(in srgb, var(--_fg) 4%, var(--_bg));
  }
  .message.user.crew-note {
    background: color-mix(in srgb, var(--_fg) 8%, var(--_bg));
    border: 1px solid color-mix(in srgb, var(--_fg) 22%, transparent);
    color: var(--_fg);
  }
  .input {
    flex: 1; min-width: 0; padding: 0.5rem 0.75rem; border-radius: 0.5rem; font: inherit;
    border: 1px solid color-mix(in srgb, var(--_fg) 25%, transparent);
    background: var(--_bg); color: var(--_fg);
    box-sizing: border-box; resize: none; line-height: 1.5; overflow-y: hidden;
  }
  .input:disabled { opacity: 0.7; cursor: progress; }
  .recovery {
    padding: 0.65rem 1rem; border-top: 1px solid color-mix(in srgb, var(--_danger) 28%, transparent);
    background: color-mix(in srgb, var(--_danger) 7%, var(--_bg));
    color: color-mix(in srgb, var(--_fg) 78%, transparent);
    font-size: 0.82rem; line-height: 1.4;
  }
  .recovery[hidden], .stop[hidden] { display: none; }
  button {
    padding: 0.5rem 0.9rem; border-radius: 0.5rem; border: none; font: inherit;
    background: var(--_accent); color: #fff; cursor: pointer;
  }
  .send:disabled { opacity: 0.7; cursor: progress; }
  .send[data-loading="true"]::before {
    content: ''; display: inline-block; width: 0.65rem; height: 0.65rem;
    margin-right: 0.4rem; border-radius: 50%; vertical-align: -0.05rem;
    border: 1.5px solid color-mix(in srgb, currentColor 28%, transparent);
    border-top-color: currentColor; animation: agent-chat-spin 0.7s linear infinite;
  }
  button.secondary { background: color-mix(in srgb, var(--_fg) 12%, var(--_bg)); color: var(--_fg); }
  @keyframes agent-chat-blink { 50% { opacity: 0; } }
  @keyframes agent-chat-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .approval-actions button[data-loading="true"]::before,
    .send[data-loading="true"]::before { animation: none; }
  }
</style>
<div class="root" part="root">
  <header part="header">
    <slot name="header"></slot>
    <span class="phase" part="phase idle" data-phase="idle">idle</span>
  </header>
  <div class="messages" part="messages" role="log" aria-live="polite"></div>
  <button type="button" class="new-messages secondary" part="new-messages" hidden>
    New messages
  </button>
  <div class="approval" part="approval pending" role="region"
       aria-labelledby="agent-chat-approval-kicker agent-chat-approval-title"
       aria-describedby="agent-chat-approval-summary agent-chat-approval-meta agent-chat-approval-status"
       data-state="pending" hidden>
    <span class="approval-signal" part="approval-signal" aria-hidden="true">!</span>
    <div class="approval-text" part="approval-text">
      <span class="approval-kicker" id="agent-chat-approval-kicker" part="approval-kicker">Approval required</span>
      <strong class="approval-title" id="agent-chat-approval-title" part="approval-title"></strong>
      <span class="approval-summary" id="agent-chat-approval-summary" part="approval-summary"></span>
      <div class="approval-meta" id="agent-chat-approval-meta" part="approval-meta">
        <span class="approval-tool" part="approval-tool"></span>
        <span class="approval-requester" part="approval-requester"></span>
        <span class="approval-identity" part="approval-identity inherited"></span>
        <span class="approval-source" part="approval-source"></span>
        <span class="approval-scope" part="approval-scope">One call</span>
      </div>
      <span class="approval-status" id="agent-chat-approval-status" part="approval-status"
            role="status" aria-live="polite" aria-atomic="true"></span>
      <label class="approval-guidance" part="approval-guidance">
        <span class="approval-guidance-label" part="approval-guidance-label">Correction for the agent (optional)</span>
        <input type="text" class="deny-guidance" part="deny-guidance"
               maxlength="${DENY_GUIDANCE_MAX}" autocomplete="off"
               placeholder="What should the agent do instead?" />
      </label>
      <pre class="approval-debug" part="approval-debug" hidden></pre>
    </div>
    <div class="approval-actions" part="approval-actions">
      <button type="button" class="deny secondary" part="button deny">Don’t allow</button>
      <button type="button" class="approve" part="button approve">Approve once</button>
    </div>
  </div>
  <div class="recovery" part="recovery" role="status" aria-live="polite" hidden></div>
  <slot name="activity"></slot>
  <form class="composer" part="composer ask">
    <div class="typeahead" id="agent-chat-typeahead" part="typeahead" role="listbox" hidden></div>
    <slot name="composer-header"></slot>
    <slot name="composer-context"></slot>
    <textarea class="input" part="input" rows="1" autocomplete="off" role="combobox"
           aria-expanded="false" aria-autocomplete="list" aria-controls="agent-chat-typeahead"></textarea>
    <div class="composer-footer" part="composer-footer">
      <slot name="composer-toolbar"></slot>
      <slot name="composer-actions"></slot>
      <div class="composer-buttons" part="composer-buttons">
        <button type="submit" class="send" part="button send ask">Send</button>
        <button type="button" class="stop secondary" part="button stop"
                title="Interrupt the turn" hidden disabled>Stop</button>
      </div>
    </div>
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
function noteText(m: ViewMessage, names: Map<string, string>): string {
  if (m.kind === 'approval') {
    const verdict = m.timedOut ? 'Timed out' : m.approved ? 'Approved' : 'Denied';
    const action = m.toolCallId ? names.get(m.toolCallId) : undefined;
    return `${verdict}${action ? ` · ${humanizeIdentifier(action)}` : ''}`
      + `${m.reason ? ` — ${m.reason}` : ''}`;
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

type TranscriptMode = 'clean' | 'debug';

/** Clean is fail-closed: only the two explicit debug spellings expose the
 * exact machine trace. `quiet`/`full` remain compatibility aliases. */
function transcriptMode(value: string | null): TranscriptMode {
  return value === 'debug' || value === 'full' ? 'debug' : 'clean';
}

function parsesJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/** True only when the whole assistant message is a machine-shaped payload.
 * Prose that happens to contain braces remains prose. An explicit JSON/JSONC
 * fence is machine-shaped even if the provider emitted malformed JSON inside. */
export function isStructuredAssistantContent(value: string): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;
  const fence = /^```([\w-]*)[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```$/.exec(text);
  if (!fence) return parsesJson(text);
  const language = fence[1].toLowerCase();
  if (language === 'json' || language === 'jsonc') return true;
  if (language) return false;
  return parsesJson(fence[2].trim());
}

const STRUCTURED_DATA_HIDDEN = 'Structured data hidden';
const JSON_ESCAPE = /\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/;

/** Return the exclusive end of one balanced object/array candidate. Strings
 * and their escaped delimiters do not affect nesting. */
function structuredCandidateEnd(value: string, start: number): number | null {
  const stack = [value[start] === '{' ? '}' : ']'];
  let quoted = false;
  let escaped = false;
  for (let i = start + 1; i < value.length; i += 1) {
    const char = value[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') { stack.push('}'); continue; }
    if (char === '[') { stack.push(']'); continue; }
    if (char !== '}' && char !== ']') continue;
    if (stack.at(-1) !== char) return null;
    stack.pop();
    if (stack.length === 0) return i + 1;
  }
  return null;
}

function isJsonStructure(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

/** A balanced candidate gets the authoritative JSON.parse check. For a
 * truncated stream/result, use only unmistakable serialization prefixes so
 * prose placeholders such as `{accountId}` remain intact. */
function looksLikeTruncatedStructure(value: string): boolean {
  if (value.startsWith('{')) {
    return /^\{\s*"(?:[^"\\]|\\.)*"\s*:/.test(value);
  }
  return /^\[\s*(?:\{|\[|"(?:[^"\\]|\\.)*"\s*(?:,|$)|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?\s*,|(?:true|false|null)\s*,)/.test(value);
}

function suppressEmbeddedStructures(value: string, streaming: boolean): string {
  let rendered = '';
  let cursor = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '{' && value[i] !== '[') continue;
    const end = structuredCandidateEnd(value, i);
    if (end !== null && isJsonStructure(value.slice(i, end))) {
      rendered += value.slice(cursor, i) + STRUCTURED_DATA_HIDDEN;
      cursor = end;
      i = end - 1;
      continue;
    }
    if (end === null && (streaming || looksLikeTruncatedStructure(value.slice(i)))) {
      // There is no reliable boundary after an unfinished payload. Hide the
      // remainder rather than guessing and briefly exposing a partial record.
      return rendered + value.slice(cursor, i) + STRUCTURED_DATA_HIDDEN;
    }
  }
  return rendered + value.slice(cursor);
}

function decodeJsonStringBody(value: string): string {
  let decoded = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== '\\' || i + 1 >= value.length) { decoded += char; continue; }
    const escaped = value[i + 1];
    if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(value.slice(i + 2, i + 6))) {
      decoded += String.fromCharCode(Number.parseInt(value.slice(i + 2, i + 6), 16));
      i += 5;
      continue;
    }
    const escapes: Record<string, string> = {
      '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
    };
    if (escaped in escapes) {
      decoded += escapes[escaped];
      i += 1;
    } else {
      decoded += `\\${escaped}`;
      i += 1;
    }
  }
  return decoded;
}

/** A provider can double-encode line breaks before truncation. Once a fragment
 * is already known to be a JSON string, residual line escapes are formatting,
 * not useful literal machine syntax. */
function decodeResidualLineEscapes(value: string): string {
  return value.replace(/\\r\\n/g, '\n').replace(/\\[nr]/g, '\n');
}

function decodeEmbeddedJsonStrings(value: string): string {
  let rendered = '';
  let cursor = 0;
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== '"') continue;
    let sawJsonEscape = false;
    let end: number | null = null;
    for (let i = start + 1; i < value.length; i += 1) {
      if (value[i] === '\\' && i + 1 < value.length) {
        const escape = value.slice(i).match(/^\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/);
        if (escape) sawJsonEscape = true;
        // Any escaped character cannot close the string, valid JSON or not.
        i += 1;
        continue;
      }
      if (value[i] === '"') { end = i + 1; break; }
    }
    if (!sawJsonEscape) {
      if (end !== null) start = end - 1;
      continue;
    }

    let decoded: string | null = null;
    if (end !== null) {
      try {
        const parsed = JSON.parse(value.slice(start, end));
        if (typeof parsed === 'string') decoded = parsed;
      } catch {
        // A malformed closed quote is ordinary text; leave it byte-for-byte.
      }
    } else if (JSON_ESCAPE.test(value.slice(start + 1))) {
      decoded = decodeJsonStringBody(value.slice(start + 1));
    }
    if (decoded === null) {
      if (end !== null) start = end - 1;
      continue;
    }

    rendered += value.slice(cursor, start) + decodeResidualLineEscapes(decoded);
    if (end === null) return rendered;
    cursor = end;
    start = end - 1;
  }
  return rendered + value.slice(cursor);
}

/** Clean-mode assistant prose transform. It decodes embedded JSON string
 * serialization (including a truncated final string), removes embedded raw
 * object/array records, and deliberately leaves ordinary quotes/placeholders
 * alone. Debug rendering never calls this helper. */
export function sanitizeCleanAssistantContent(value: string, streaming = false): string {
  const source = String(value ?? '');
  const withoutRawStructures = suppressEmbeddedStructures(source, streaming);
  const decodedStrings = decodeEmbeddedJsonStrings(withoutRawStructures);
  // Decoding can reveal an object that was escaped inside the string.
  return suppressEmbeddedStructures(decodedStrings, streaming);
}

function isStructuredAssistantStream(value: string, streaming: boolean): boolean {
  if (isStructuredAssistantContent(value)) return true;
  if (!streaming) return false;
  // During an object/array or JSON-fence stream, fail closed before the closing
  // token makes it parseable; otherwise raw JSON would flash on screen first.
  return /^\s*[\[{]/.test(value)
    || /^\s*```(?:json|jsonc)?(?:[^\S\r\n]*\r?\n|\s*$)/i.test(value);
}

function humanizeIdentifier(value: string | undefined, fallback = 'Tool'): string {
  const text = String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fallback;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const SENSITIVE_ARG = /(auth(?:orization)?|bearer|cookie|credential|password|passphrase|secret|token|api.?key|private.?key|signing.?key|session(?:id|key)?)/i;
const CREDENTIAL_VALUE = /^(?:bearer\s+)?(?:[a-z0-9+/_=-]{28,}|(?:sk|pk|ghp|xox[baprs])[-_][a-z0-9_-]{16,})$/i;
const UNSAFE_APPROVAL_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function cleanApprovalText(value: unknown, max: number): string {
  const clean = String(value ?? '').replace(UNSAFE_APPROVAL_TEXT, '').replace(/\s+/g, ' ').trim();
  const characters = [...clean];
  return characters.length > max ? `${characters.slice(0, max - 1).join('')}…` : clean;
}

function summaryValue(value: unknown): string {
  if (value === null) return 'None';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    const count = Object.keys(value as Record<string, unknown>).length;
    return `${count} field${count === 1 ? '' : 's'}`;
  }
  const clean = cleanApprovalText(value, 72);
  if (CREDENTIAL_VALUE.test(clean)) return 'Redacted';
  if (isStructuredAssistantContent(clean)) return 'Structured value';
  return clean;
}

/** Bounded, non-JSON approval context. Values stay useful for a human verdict,
 * while nested records and credentials collapse instead of leaking a payload. */
function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    const value = summaryValue(args);
    return value && value !== 'None' ? `Input: ${value}` : '';
  }
  const entries = Object.entries(args as Record<string, unknown>).slice(0, 4);
  const parts = entries.map(([key, value]) => (
    `${humanizeIdentifier(key, 'Input')}: ${SENSITIVE_ARG.test(key) ? 'Redacted' : summaryValue(value)}`
  ));
  const extra = Object.keys(args as Record<string, unknown>).length - entries.length;
  if (extra > 0) parts.push(`+${extra} more`);
  return parts.join(' · ');
}

/** One transcript row. Clean mode replaces machine records with bounded
 * operational receipts; debug mode preserves the exact historical renderer. */
function renderRow(
  m: ViewMessage, names: Map<string, string>,
  download?: (attachmentId: string) => void,
  mode: TranscriptMode = 'clean',
  mentions: Map<string, ResolvedSource> = new Map(),
  agentNames: Map<string, string> = new Map(),
  /** Set when the element is `threadable`: the session the rows belong to. */
  threadSessionId: string | null = null,
): HTMLElement | null {
  const row = renderRowContent(m, names, download, mode, mentions, agentNames);
  if (row && threadSessionId !== null && !m.streaming
    && (m.role === 'user' || m.role === 'assistant')) {
    row.classList.add('threadable');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'thread-button';
    button.setAttribute('part', 'thread-button');
    button.setAttribute('aria-label', 'Reply in thread');
    button.title = 'Reply in thread';
    button.dataset.messageId = m._id;
    button.textContent = 'Reply in thread';
    button.addEventListener('click', () => {
      button.dispatchEvent(new CustomEvent('agent-chat:open-thread', {
        detail: { sessionId: threadSessionId, messageId: m._id, seq: m.seq },
        bubbles: true, composed: true,
      }));
    });
    row.append(button);
  }
  return row;
}

function renderRowContent(
  m: ViewMessage, names: Map<string, string>,
  download: ((attachmentId: string) => void) | undefined,
  mode: TranscriptMode,
  mentions: Map<string, ResolvedSource>,
  agentNames: Map<string, string>,
): HTMLElement | null {
  const debug = mode === 'debug';
  if (!debug) {
    // Compaction is bookkeeping about the transcript, not about the business.
    if (m.role === 'note' && m.kind === 'compaction') return null;
  }
  const row = document.createElement('div');
  row.dataset.messageId = m._id;
  row.tabIndex = -1;
  // `part` and `class` carry the same tokens: the class drives the sheet
  // above, the part exposes the identical hook to the host page. Note rows add
  // their `kind`, so `::part(note error)` is addressable without piercing.
  const renderedRole = !debug && m.role === 'tool' ? 'operation' : m.role;
  const flags = [
    renderedRole,
    m.streaming ? 'streaming' : '',
    !debug && m.role === 'tool' && m.error ? 'error' : '',
    m.childSessionId && (m.role === 'tool' || m.kind === 'orphan-child') ? 'delegation' : '',
    m.role === 'note' && m.kind ? m.kind : '',
    m.kind === 'crew-note' ? 'crew-note' : '',
    m.role === 'user' && m.threadSessionId ? 'threaded' : '',
    !debug && m.role === 'tool' && m.kind === 'handoff' && !m.error ? 'handoff' : '',
    // Application-owned system sources can style their operational receipts
    // without rewriting the durable, model-facing message content.
    m.role === 'system' && /^s:[a-z0-9][a-z0-9-]{0,63}$/.test(m.from?.participant ?? '')
      ? `system-source-${m.from!.participant.slice(2)}` : '',
  ].filter(Boolean) as string[];
  row.className = ['message', ...flags].join(' ');
  row.setAttribute('part', ['message', ...flags].join(' '));

  const rawTool = (m.toolCallId && names.get(m.toolCallId)) || undefined;
  const childAgent = m.childAgent || (rawTool && agentNames.has(rawTool) ? rawTool : undefined);
  const childName = (childAgent && agentNames.get(childAgent))
    || (rawTool && agentNames.get(rawTool)) || humanizeIdentifier(childAgent || rawTool, 'Agent');
  const appendWorkLink = () => {
    if (!m.childSessionId) return;
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'delegation-link';
    link.setAttribute('part', 'delegation-link');
    link.textContent = `View ${childName}’s work`;
    link.addEventListener('click', () => {
      link.dispatchEvent(new CustomEvent('agent-chat:open-run', {
        detail: { sessionId: m.childSessionId, ...(childAgent ? { agent: childAgent } : {}) },
        bubbles: true, composed: true,
      }));
    });
    row.append(link);
  };

  if (m.role === 'note') {
    row.textContent = m.kind === 'orphan-child' && m.childSessionId
      ? `${childName}’s work recovered` : noteText(m, names);
    if (m.kind === 'orphan-child') appendWorkLink();
    return row;
  }

  if (m.role === 'tool') {
    const tool = (rawTool && agentNames.get(rawTool)) || humanizeIdentifier(rawTool);
    if (!debug) {
      if (m.kind === 'handoff' && !m.error) {
        const source = (m.from?.participant?.startsWith('m:')
          ? agentNames.get(m.from.participant.slice(2)) : undefined) || m.from?.name || 'Agent';
        const target = m.to?.startsWith('m:')
          ? agentNames.get(m.to.slice(2)) || humanizeIdentifier(m.to.slice(2)) : 'Agent';
        const header = document.createElement('div');
        header.className = 'handoff-header';
        header.setAttribute('part', 'handoff-header');
        const route = document.createElement('span');
        route.className = 'handoff-route';
        route.setAttribute('part', 'handoff-route');
        route.textContent = `${source} → ${target}`;
        const status = document.createElement('span');
        status.className = 'handoff-status';
        status.setAttribute('part', 'handoff-status');
        status.textContent = 'Sent';
        header.append(route, status);
        row.append(header);
        if (m.transcriptContent) {
          const body = document.createElement('div');
          body.className = 'handoff-message';
          body.setAttribute('part', 'handoff-message');
          body.append(renderAssistantMarkdown(sanitizeCleanAssistantContent(m.transcriptContent)));
          row.append(body);
        }
        return row;
      }
      const outcome = m.error ? 'failed' : 'completed';
      const projected = m.transcriptContent ?? m.displayContent;
      const status = document.createElement('span');
      if (m.childSessionId) status.className = 'delegation-status';
      status.textContent = projected && !isStructuredAssistantStream(projected, false)
        ? projected
        : m.childSessionId ? `${childName}’s work ${outcome}` : `${tool} ${outcome}`;
      row.append(status);
      appendWorkLink();
      return row;
    }
    const name = document.createElement('span');
    name.className = 'tool-name';
    name.setAttribute('part', 'tool-name');
    name.textContent = `⚙ ${(m.toolCallId && names.get(m.toolCallId)) || 'tool'}`;
    const body = document.createElement('span');
    body.className = 'tool-content';
    body.setAttribute('part', 'tool-content');
    body.textContent = m.content ?? '';
    row.append(name, body);
    appendWorkLink();
    return row;
  }

  // Speaker attribution — only shown in rostered sessions where names
  // disambiguate (1:1 carries no `from`).
  const noteHeader = m.kind === 'crew-note' ? document.createElement('div') : null;
  if (noteHeader) {
    noteHeader.className = 'crew-note-header';
    noteHeader.setAttribute('part', 'crew-note-header');
  }
  const addressedUser = m.role === 'user' && m.kind !== 'crew-note' && !!m.to;
  if ((m.from && (m.role === 'user' || m.role === 'assistant')) || addressedUser) {
    const speaker = document.createElement('span');
    speaker.className = 'speaker';
    speaker.setAttribute('part', `speaker speaker-${m.role}${noteHeader ? ' speaker-crew-note' : ''}`);
    speaker.textContent = m.from?.participant?.startsWith('m:')
      ? agentNames.get(m.from.participant.slice(2)) || m.from.name : m.from?.name || '';
    if (m.source) {
      const source = document.createElement('span');
      source.className = 'source';
      source.setAttribute('part', `source source-${m.source.kind}`);
      source.textContent = `${speaker.hasChildNodes() ? ' · ' : ''}${m.source.kind === 'desktop'
        ? 'Desktop'
        : humanizeIdentifier(m.source.channel, 'Channel')}`;
      speaker.append(source);
    }
    if (addressedUser) {
      const agent = m.to!.startsWith('m:') ? m.to!.slice(2) : m.to!;
      const recipient = document.createElement('span');
      recipient.className = 'recipient';
      recipient.setAttribute('part', 'recipient recipient-user');
      recipient.textContent = `${speaker.hasChildNodes() ? ' · ' : ''}To ${agentNames.get(agent) || humanizeIdentifier(agent, 'Agent')}`;
      speaker.append(recipient);
    }
    (noteHeader ?? row).append(speaker);
  }
  if (noteHeader) {
    const badge = document.createElement('span');
    badge.className = 'crew-note-badge';
    badge.setAttribute('part', 'crew-note-badge');
    badge.textContent = 'Crew note';
    noteHeader.append(badge);
    row.append(noteHeader);
  }
  // `truncatedHead` means compaction (or a capped-collection gap) dropped the
  // start of this row's text; the ellipsis says so rather than silently
  // presenting a fragment as the whole message.
  const structured = !debug
    && m.role === 'assistant'
    && isStructuredAssistantStream(m.content ?? '', m.streaming);
  if (m.truncatedHead && !structured) row.append(document.createTextNode('…'));
  if (structured) {
    const hidden = document.createElement('span');
    hidden.className = 'structured-hidden';
    hidden.setAttribute('part', 'structured-hidden');
    hidden.textContent = 'Structured response hidden';
    row.append(hidden);
  } else if (!debug && m.role === 'assistant') {
    const content = sanitizeCleanAssistantContent(m.content ?? '', m.streaming);
    let addressingEligible = true;
    row.append(renderAssistantMarkdown(content, {
      textNodes: (text) => {
        const nodes = renderText(text, mentions, addressingEligible);
        if (/\S/.test(text)) addressingEligible = false;
        return nodes;
      },
    }));
  } else {
    row.append(...renderText(m.content ?? '', mentions, m.kind !== 'crew-note'));
  }
  if (m.toolCalls?.length && debug) {
    const calls = document.createElement('span');
    calls.className = 'calls';
    calls.setAttribute('part', 'tool-calls');
    calls.textContent = m.toolCalls
      .map((c) => ` → ${c.name}(${JSON.stringify(c.args)})`)
      .join('');
    row.append(calls);
  } else if (m.toolCalls?.length) {
    const operations = document.createElement('span');
    operations.className = 'operations';
    operations.setAttribute('part', 'operations');
    for (const call of m.toolCalls) {
      const operation = document.createElement('span');
      operation.className = 'operation-status';
      operation.setAttribute('part', 'operation');
      operation.textContent = `${agentNames.get(call.name) || humanizeIdentifier(call.name)} requested`;
      operations.append(operation);
    }
    row.append(operations);
  }
  // Attachment chips — click mints a one-time download URL.
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

/** Lift resolved `@handle` tokens into chips; unresolved tokens stay as text.
 *  `allowAddressing=false` keeps a non-waking crew note truthful even when it
 *  starts with an Agent handle. All content via `textContent` — no innerHTML. */
function renderText(
  text: string, mentions: Map<string, ResolvedSource>, allowAddressing = true,
): Node[] {
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
    const before = hit.index === 0 ? '' : text[hit.index - 1];
    if (before && /[\w@]/.test(before)) { hit = scan.exec(text); continue; }
    // Retry with trailing punctuation trimmed — same two-step as resolveAddressee.
    const prefix = hit[1];
    const raw = hit[2];
    const trimmed = raw.replace(/[.-]+$/, '');
    const source = mentions.get(prefix);
    const exact = source?.lookup(raw) ?? null;
    const found = exact ?? (trimmed !== raw ? source?.lookup(trimmed) ?? null : null);
    if (found) {
      const handle = exact ? raw : trimmed;
      if (hit.index > cursor) nodes.push(document.createTextNode(text.slice(cursor, hit.index)));
      const actionable = found.actionable === true && prefix !== DEFAULT_PREFIX;
      const chip = document.createElement(actionable ? 'button' : 'span');
      if (chip instanceof HTMLButtonElement) {
        chip.type = 'button';
        chip.setAttribute('aria-label', `View ${found.kind ?? 'reference'}: ${found.label ?? handle}`);
        chip.addEventListener('click', () => {
          chip.dispatchEvent(new CustomEvent('agent-chat:mention', {
            detail: { prefix, handle, kind: found.kind ?? 'subject' }, bubbles: true, composed: true,
          }));
        });
      }
      const kind = found.kind ?? 'subject';
      // Only a leading @-mention is ADDRESSED; mid-text is merely named.
      // Different styling prevents a chip that promises routing it cannot deliver.
      const addressed = allowAddressing
        && kind === 'agent'
        && prefix === DEFAULT_PREFIX
        && /^\s*$/.test(text.slice(0, hit.index));
      const flags = addressed ? `${kind} addressed` : kind;
      chip.className = `mention ${flags}`;
      chip.setAttribute('part', `mention ${flags}`);
      chip.textContent = `${prefix}${found.label ?? handle}`;
      chip.title = addressed
        ? `Addressed to ${found.label ?? handle} — schedules their turn`
        : (found.detail ?? '');
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

/** Register `<agent-chat>` (or a custom tag) and return its constructor.
 *  Idempotent per tag; a different name registers a fresh class. */
export function defineAgentChat(tagName: string = DEFAULT_TAG): CustomElementConstructor {
  const existing = customElements.get(tagName);
  if (existing) return existing;

  class AgentChat extends HTMLElement {
    static get observedAttributes() {
      return ['agent', 'session-id', 'placeholder', 'verbosity', 'composer-mode', 'recipient', 'composer-disabled', 'send-disabled', 'aria-disabled', 'multiline', 'composer-layout', 'submit-label', 'threadable', 'from-seq'];
    }

    private ui!: {
      phase: HTMLElement;
      messages: HTMLElement;
      newMessages: HTMLButtonElement;
      approval: HTMLElement;
      approvalText: HTMLElement;
      approvalTitle: HTMLElement;
      approvalSummary: HTMLElement;
      approvalTool: HTMLElement;
      approvalRequester: HTMLElement;
      approvalIdentity: HTMLElement;
      approvalSource: HTMLElement;
      approvalStatus: HTMLElement;
      denyGuidance: HTMLInputElement;
      approvalDebug: HTMLElement;
      approve: HTMLButtonElement;
      deny: HTMLButtonElement;
      stop: HTMLButtonElement;
      recovery: HTMLElement;
      composer: HTMLFormElement;
      input: HTMLTextAreaElement;
      send: HTMLButtonElement;
      typeahead: HTMLElement;
    };
    /** App-supplied `@`-able subjects. A property, not an attribute: this is a
     *  list of objects, and a JSON attribute would make every roster change a
     *  re-parse of a string the host already had in hand. */
    private sources: Record<string, MentionSource> = {};
    /** Hosts may intercept a write, but never bypass composer busy/error state. */
    submissionHandler: ComposerSubmissionHandler | null = null;
    /** Attachment-only writes require an application handler to interpret them. */
    allowEmptySubmit = false;
    /** The suggestions currently offered, and which one Enter would take. */
    private suggestions: Mentionable[] = [];
    /** The symbol that opened the list. Carried separately because a record no
     *  longer knows its own symbol — the source it came from is keyed by one. */
    private suggestPrefix: string = DEFAULT_PREFIX;
    private cursorAt = -1;
    private composing = false;
    /** Modal focus restoration can reset a native input's caret before an
     * app picker inserts. Keep the last deliberate selection across blur. */
    private composerSelection: { text: string; start: number; end: number } | null = null;
    private timeline: ChatTimelineItem[] = [];
    private timelineSlots = new Map<string, HTMLSlotElement>();
    private timelineSequence = 0;
    private client: Agent | null = null;
    private sid: string | null = null;
    private computation: Tracker.Computation | null = null;
    /** Bumped on attach/detach; in-flight calls check it before touching the DOM. */
    private generation = 0;
    /** Guards against pre-connect attribute callbacks firing during upgrade. */
    private live = false;
    /** A re-attach is already queued for the end of this microtask — see
     *  `queueReattach`. */
    private reattachQueued = false;
    /** The generation the queued re-attach expects to still be current. */
    private reattachGeneration = -1;
    private failure: string | null = null;
    /** One composer write at a time. Captures mode/text so attribute churn
     *  cannot relabel an already-issued request or allow a duplicate submit. */
    private submission: { mode: ComposerMode; text: string; recipient?: string } | null = null;
    /** Transcript scrolling is reader-owned once they leave the bottom. */
    private transcriptSignature: string | null = null;
    private renderedTranscriptRows = 0;
    private newMessagesPending = false;
    /** A reveal belongs to this attachment, and expires even during streaming. */
    private messageTarget: { id: string; expiresAt: number; timer: number } | null = null;
    private approvalAction: { action: 'approve' | 'deny'; toolCallId: string } | null = null;
    private approvalError: { toolCallId: string; message: string } | null = null;
    /** Input belongs to one rendered Gate and must never bleed into the next. */
    private approvalGuidanceFor: string | null = null;

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = FRAME;
      const q = <T extends Element>(sel: string) => root.querySelector(sel) as unknown as T;
      this.ui = {
        phase: q<HTMLElement>('.phase'),
        messages: q<HTMLElement>('.messages'),
        newMessages: q<HTMLButtonElement>('.new-messages'),
        approval: q<HTMLElement>('.approval'),
        approvalText: q<HTMLElement>('.approval-text'),
        approvalTitle: q<HTMLElement>('.approval-title'),
        approvalSummary: q<HTMLElement>('.approval-summary'),
        approvalTool: q<HTMLElement>('.approval-tool'),
        approvalRequester: q<HTMLElement>('.approval-requester'),
        approvalIdentity: q<HTMLElement>('.approval-identity'),
        approvalSource: q<HTMLElement>('.approval-source'),
        approvalStatus: q<HTMLElement>('.approval-status'),
        denyGuidance: q<HTMLInputElement>('.deny-guidance'),
        approvalDebug: q<HTMLElement>('.approval-debug'),
        approve: q<HTMLButtonElement>('.approve'),
        deny: q<HTMLButtonElement>('.deny'),
        stop: q<HTMLButtonElement>('.stop'),
        recovery: q<HTMLElement>('.recovery'),
        composer: q<HTMLFormElement>('.composer'),
        input: q<HTMLTextAreaElement>('.input'),
        send: q<HTMLButtonElement>('.send'),
        typeahead: q<HTMLElement>('.typeahead'),
      };
      this.ui.composer.addEventListener('submit', (e: Event) => {
        e.preventDefault();
        // Enter with the typeahead open completes the mention; it does not
        // send. Submit is the only place that can know this, because the
        // keydown handler cannot cancel a form submission it did not cause.
        if (this.suggestions.length > 0) { this.acceptSuggestion(); return; }
        void this.submit();
      });
      this.ui.input.addEventListener('input', (event: Event) => {
        this.composerSelection = null;
        if (!this.hasAttribute('multiline') && /[\r\n]/.test(this.ui.input.value)) {
          this.ui.input.value = this.ui.input.value.replace(/[\r\n]+/g, ' ');
        }
        this.draftChanged();
        if (this.composing || (event instanceof InputEvent && event.isComposing)) {
          this.closeSuggestions(); return;
        }
        this.refreshSuggestions();
      });
      this.ui.input.addEventListener('compositionstart', () => {
        this.composing = true; this.closeSuggestions();
      });
      this.ui.input.addEventListener('compositionend', () => {
        this.composing = false;
        // Some browsers emit the final input after compositionend. Only
        // refresh here if that input did not already transfer focus to a picker.
        queueMicrotask(() => {
          if (!this.composing && this.shadowRoot?.activeElement === this.ui.input) this.refreshSuggestions();
        });
      });
      // `click` rather than `mousedown`: the input keeps focus because the
      // button lives in the same shadow root and we never blur it.
      this.ui.input.addEventListener('keydown', (e: KeyboardEvent) => {
        this.composerSelection = null;
        this.onKeyDown(e);
      });
      // Any caret move can leave or enter a token, so the offered list has to
      // follow the caret and not only the keystrokes that changed the text.
      this.ui.input.addEventListener('mousedown', () => { this.composerSelection = null; });
      this.ui.input.addEventListener('click', () => {
        this.composerSelection = null;
        this.refreshSuggestions();
      });
      this.ui.input.addEventListener('blur', () => {
        const { input } = this.ui;
        this.composerSelection = {
          text: input.value,
          start: input.selectionStart ?? input.value.length,
          end: input.selectionEnd ?? input.value.length,
        };
        this.closeSuggestions();
      });
      this.ui.messages.addEventListener('scroll', () => {
        if (!this.nearTranscriptBottom()) return;
        this.newMessagesPending = false;
        this.syncNewMessages();
      });
      this.ui.newMessages.addEventListener('click', () => {
        this.newMessagesPending = false;
        this.ui.messages.scrollTop = this.ui.messages.scrollHeight;
        this.syncNewMessages();
      });
      this.ui.stop.addEventListener('click', () => {
        // Re-check at action time as well as paint time. A stale/programmatic
        // click must not turn an idle, parked, or terminal session into stopped.
        const { client, sid } = this;
        if (this.getAttribute('aria-disabled') === 'true'
          || !client || !sid || !ACTIVE_PHASES.includes(client.status(sid))) return;
        void this.act((a, s) => a.interrupt(s));
      });
      this.ui.approve.addEventListener('click', () => { void this.decide('approve'); });
      this.ui.deny.addEventListener('click', () => { void this.decide('deny'); });
    }

    /** The session being rendered — null until an auto-start resolves. */
    get sessionId(): string | null { return this.sid; }

    /** Whether the composer wakes a model (`ask`) or only records shared
     * human context (`note`). Invalid attribute values fail closed to ask. */
    /** Show "Reply in thread" on user and assistant rows. A click dispatches
     *  `agent-chat:open-thread` with `{ sessionId, messageId, seq }`; the host
     *  opens the thread (for example with `Agent#thread`). */
    get threadable(): boolean { return this.hasAttribute('threadable'); }

    set threadable(next: boolean) { this.toggleAttribute('threadable', !!next); }

    /** Paint only rows with `seq >= fromSeq` (display only; the model still
     *  sees every row). The first painted row — the thread's parent message —
     *  carries the `thread-root` part. For a thread session pass its
     *  `thread.anchorSeq`. `null` (no attribute) paints every row. */
    get fromSeq(): number | null {
      const raw = this.getAttribute('from-seq');
      if (raw === null || raw.trim() === '') return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    }

    set fromSeq(next: number | null) {
      if (next === null || next === undefined || !Number.isFinite(next)) {
        this.removeAttribute('from-seq');
      } else {
        this.setAttribute('from-seq', String(next));
      }
    }

    get composerMode(): ComposerMode { return composerMode(this.getAttribute('composer-mode')); }

    set composerMode(next: ComposerMode) { this.setAttribute('composer-mode', next); }

    /** The host owns the recipient picker and persistence. Capture this value
     * once per submission so a later selection cannot redirect an issued send. */
    get recipient(): string | undefined { return this.getAttribute('recipient') ?? undefined; }

    set recipient(next: string | undefined) {
      if (next === undefined) this.removeAttribute('recipient');
      else this.setAttribute('recipient', next);
    }

    /** The underlying client `Agent`, for anything the element does not do
     *  itself (`fork`, `usage`, a denial with a typed reason). Null while
     *  detached. */
    get agentInstance(): Agent | null { return this.client; }

    get draftText(): string { return this.ui.input.value; }
    set draftText(text: string) { this.setDraft(text); }

    setDraft(text: string, options: ComposerDraftOptions = {}) {
      const { input } = this.ui;
      input.value = this.hasAttribute('multiline') ? String(text) : String(text).replace(/[\r\n]+/g, ' ');
      this.composerSelection = null;
      const start = options.selectionStart ?? input.value.length;
      this.closeSuggestions();
      if (options.focus) input.focus({ preventScroll: true });
      input.setSelectionRange(start, options.selectionEnd ?? start);
      this.draftChanged();
    }

    focusComposer() {
      this.restoreComposerSelection();
      const { input } = this.ui;
      const start = input.selectionStart; const end = input.selectionEnd;
      input.focus({ preventScroll: true });
      input.setSelectionRange(start, end);
    }

    async submitDraft(): Promise<void> { await this.submit(); }

    private draftChanged() {
      this.resizeComposer();
      this.dispatchEvent(new CustomEvent('agent-chat:draft-change', {
        detail: { text: this.ui.input.value, sessionId: this.sid }, bubbles: true, composed: true,
      }));
    }

    private resizeComposer() {
      const { input } = this.ui;
      const multiline = this.hasAttribute('multiline');
      if (!multiline) { input.rows = 1; input.style.height = ''; input.style.overflowY = ''; return; }
      const style = getComputedStyle(input);
      const configuredRows = parseFloat(style.getPropertyValue('--agent-chat-input-min-rows'));
      const minimumRows = Number.isFinite(configuredRows) ? Math.max(1, Math.min(6, Math.round(configuredRows))) : 2;
      input.rows = minimumRows;
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || 24;
      const inset = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
        + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      input.style.height = 'auto';
      const ceiling = 6 * line + inset;
      const height = Math.max(minimumRows * line + inset, Math.min(input.scrollHeight + 2, ceiling));
      input.style.height = `${height}px`;
      input.style.overflowY = input.scrollHeight > ceiling ? 'auto' : 'hidden';
    }

    get timelineItems(): ChatTimelineItem[] { return [...this.timeline]; }
    set timelineItems(next: ChatTimelineItem[]) {
      const items = Array.isArray(next) ? next : [];
      const ids = new Set<string>();
      const valid = items.filter((item) => {
        if (!item?.id || ids.has(item.id) || !(item.element instanceof HTMLElement)) return false;
        ids.add(item.id); return true;
      });
      for (const previous of this.timeline) {
        if (!valid.some((item) => item.id === previous.id && item.element === previous.element)) previous.element.remove();
      }
      for (const [id, slot] of this.timelineSlots) {
        if (!ids.has(id)) { slot.remove(); this.timelineSlots.delete(id); }
      }
      this.timeline = valid.map((item) => ({ ...item }));
      for (const item of this.timeline) {
        let slot = this.timelineSlots.get(item.id);
        if (!slot) {
          slot = document.createElement('slot');
          slot.name = `agent-chat-timeline-${++this.timelineSequence}`;
          slot.dataset.timelineId = item.id;
          slot.setAttribute('part', 'timeline-item');
          this.timelineSlots.set(item.id, slot);
        }
        item.element.slot = slot.name;
        if (item.element.parentElement !== this) this.append(item.element);
      }
      this.paint();
    }

    /** Mention sources keyed by symbol. `@` always includes model participants
     *  underneath; other symbols are inert (no routing). */
    get mentionSources(): Record<string, MentionSource> { return { ...this.sources }; }

    set mentionSources(next: Record<string, MentionSource>) {
      this.sources = next && typeof next === 'object' ? { ...next } : {};
      this.paint();
      if (this.shadowRoot?.activeElement === this.ui.input) this.refreshSuggestions();
      else this.closeSuggestions();
    }

    /** A local navigation action: never fetch, switch verbosity, or write. */
    revealMessage(messageId: string): boolean {
      if (typeof messageId !== 'string' || !messageId || !this.live) return false;
      const row = this.visibleMessageRow(messageId);
      if (!row) return false;
      this.clearMessageTarget();
      this.messageTarget = {
        id: messageId,
        expiresAt: Date.now() + MESSAGE_TARGET_DURATION,
        timer: window.setTimeout(() => this.clearMessageTarget(), MESSAGE_TARGET_DURATION),
      };
      this.markMessageTarget(row);
      const { messages } = this.ui;
      const bounds = row.getBoundingClientRect();
      const viewport = messages.getBoundingClientRect();
      const top = messages.scrollTop + bounds.top - viewport.top - messages.clientTop
        - Math.max(0, (messages.clientHeight - bounds.height) / 2);
      messages.scrollTo({
        top: Math.max(0, Math.min(top, messages.scrollHeight - messages.clientHeight)),
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      });
      row.focus({ preventScroll: true });
      return true;
    }

    private visibleMessageRow(messageId: string): HTMLElement | null {
      // Only renderer-owned direct rows count. IDs are data, never selectors;
      // host-owned timeline content cannot impersonate a transcript message.
      const row = [...this.ui.messages.children].find((node) => (
        node instanceof HTMLElement && node.classList.contains('message')
          && node.dataset.messageId === messageId
      )) as HTMLElement | undefined;
      if (!row || !row.getClientRects().length) return null;
      const style = getComputedStyle(row);
      return style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0'
        ? null : row;
    }

    private markMessageTarget(row: HTMLElement) {
      row.classList.add('message-target');
      row.part.add('message-target');
    }

    private clearMessageTarget() {
      if (this.messageTarget) window.clearTimeout(this.messageTarget.timer);
      this.messageTarget = null;
      for (const row of this.ui.messages.querySelectorAll<HTMLElement>('.message-target')) {
        row.classList.remove('message-target');
        row.part.remove('message-target');
      }
    }

    /** Insert a resolved reference at the current (also preserved on blur)
     * caret. This only edits the draft; the host still owns access checks. */
    insertMention(prefix: string, handle: string): boolean {
      if (this.submission || this.getAttribute('aria-disabled') === 'true') return false;
      const found = this.mentionMap().get(prefix)?.lookup(handle);
      if (!found) return false;
      this.restoreComposerSelection();
      if (!this.requestMentionSelection(prefix, found)) { this.closeSuggestions(); return true; }
      this.insertComposerToken(`${prefix}${found.handle} `, prefix);
      this.closeSuggestions();
      this.mentionSelected(prefix, found);
      return true;
    }

    private mentionSelected(prefix: string, mention: Mentionable) {
      this.dispatchEvent(new CustomEvent('agent-chat:mention-selected', {
        detail: { prefix, handle: mention.handle, kind: mention.kind ?? 'subject' },
        bubbles: true, composed: true,
      }));
    }

    private requestMentionSelection(prefix: string, mention: Mentionable): boolean {
      const { input } = this.ui;
      const token = this.tokenAtCaret();
      return this.dispatchEvent(new CustomEvent('agent-chat:mention-select', {
        detail: { prefix, handle: mention.handle, kind: mention.kind ?? 'subject', range: {
          start: token?.prefix === prefix ? token.start : input.selectionStart ?? input.value.length,
          end: input.selectionEnd ?? input.value.length,
        } }, bubbles: true, composed: true, cancelable: true,
      }));
    }

    /** Opens the same picker as typing its symbol, so discoverable app actions
     * and keyboard shortcuts share one selection path. Never submits. */
    openMentions(prefix: string): boolean {
      if (this.submission || this.getAttribute('aria-disabled') === 'true'
        || !this.mentionMap().has(prefix)) return false;
      this.restoreComposerSelection();
      const token = this.tokenAtCaret();
      if (token?.prefix !== prefix) this.insertComposerToken(prefix, prefix);
      this.ui.input.focus();
      this.refreshSuggestions();
      return true;
    }

    private restoreComposerSelection() {
      const { input } = this.ui;
      const saved = this.composerSelection;
      this.composerSelection = null;
      if (saved?.text === input.value) input.setSelectionRange(saved.start, saved.end);
    }

    private insertComposerToken(value: string, prefix: string) {
      const { input } = this.ui;
      const token = this.tokenAtCaret();
      const start = token?.prefix === prefix ? token.start : input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const before = input.value.slice(0, start);
      const insert = `${before && !/\s$/.test(before) ? ' ' : ''}${value}`;
      input.value = before + insert + input.value.slice(end);
      const caret = start + insert.length;
      input.focus();
      input.setSelectionRange(caret, caret);
      this.draftChanged();
    }

    /** Symbol to resolved source. Built fresh per read for Tracker reactivity. */
    private mentionMap(): Map<string, ResolvedSource> {
      const out = new Map<string, ResolvedSource>();
      for (const [prefix, src] of Object.entries(this.sources)) {
        if (src) out.set(prefix, normalizeSource(src));
      }

      const session = this.client && this.sid ? this.client.session(this.sid) : null;
      const entries = session ? modelMentionHandles(session) : [];
      const roster: Mentionable[] = entries.map(({ participant: p, handle }) => ({
        handle, label: p.displayName, kind: 'agent',
        ...(handle !== p.displayName ? { detail: `Use @${handle}` } : {}),
      }));
      const resolveRoster = (handle: string) => {
        const participant = session ? modelParticipantByHandle(session, handle) : undefined;
        return participant ? roster[entries.findIndex((entry) => entry.participant.id === participant.id)] : undefined;
      };
      if (roster.length === 0 && !out.has(DEFAULT_PREFIX)) return out;

      // The roster goes FIRST in both directions, so a real addressee always
      // wins the name over an app subject that happens to share it.
      const app = out.get(DEFAULT_PREFIX);
      out.set(DEFAULT_PREFIX, {
        search: (q) => {
          const needle = q.toLowerCase();
          const hits = roster.filter((m, index) => matches(m, needle)
            || entries[index].participant.agent!.toLowerCase().includes(needle));
          const extra = (app?.search(q) ?? []).filter(
            (m) => !resolveRoster(m.handle),
          );
          return [...hits, ...extra];
        },
        lookup: (h) => resolveRoster(h) ?? app?.lookup(h) ?? null,
      });
      return out;
    }

    connectedCallback() {
      this.live = true;
      this.applyComposerMode();
      this.attach();
    }

    disconnectedCallback() {
      this.live = false;
      this.detach();
    }

    attributeChangedCallback(name: string, before: string | null, after: string | null) {
      if (before === after || !this.live) return;
      if (['placeholder', 'composer-mode', 'recipient', 'multiline', 'composer-layout', 'submit-label'].includes(name)) {
        this.applyComposerMode();
        this.resizeComposer();
        return;
      }
      if (name === 'aria-disabled') {
        if (after === 'true') this.closeSuggestions();
        this.paint();
        return;
      }
      // Recipient availability gates a new message, not the ability to stop
      // work already running or answer an approval from another crew member.
      if (name === 'composer-disabled') {
        if (after === 'true') this.closeSuggestions();
        this.applyComposerMode();
        return;
      }
      if (name === 'send-disabled') { this.applyComposerMode(); return; }
      // `verbosity` changes only what is DRAWN. Re-subscribing for it would
      // tear down a live session to change a privacy/display boundary.
      if (name === 'verbosity' || name === 'threadable' || name === 'from-seq') {
        this.paint();
        return;
      }
      // `agent` or `session-id`: a clean re-subscribe, COALESCED — see
      // `queueReattach`.
      this.queueReattach();
    }

    /** Detach now, re-attach once at end of microtask. Coalesces rapid attribute
     *  writes so intermediate combos never create orphan sessions. */
    private queueReattach() {
      this.detach();
      this.failure = null;
      // A draft refers to its original Session. Moving the same element to
      // another conversation must not carry a selected subject across scopes.
      this.ui.input.value = '';
      this.draftChanged();
      this.timelineItems = [];
      // On a field (not a closure local) so a second detach updates the guard
      // the already-queued microtask will check.
      this.reattachGeneration = this.generation;
      if (this.reattachQueued) return;
      this.reattachQueued = true;
      queueMicrotask(() => {
        this.reattachQueued = false;
        if (!this.live || this.generation !== this.reattachGeneration) return;
        this.attach();
      });
    }

    private applyComposerMode() {
      const busy = !!this.submission;
      const mode = this.submission?.mode ?? this.composerMode;
      const note = mode === 'note';
      const recipient = this.submission ? this.submission.recipient : this.recipient;
      const session = this.client && this.sid ? this.client.session(this.sid) : undefined;
      const participant = session?.participants?.find((entry) => entry.kind === 'model'
        && (entry.id === recipient || entry.agent === recipient));
      const recipientLabel = recipient === undefined ? 'the agent'
        : participant?.displayName || participant?.agent || (session ? 'unavailable agent' : 'selected agent');
      const hostDisabled = this.getAttribute('aria-disabled') === 'true';
      const composerDisabled = hostDisabled || this.getAttribute('composer-disabled') === 'true';
      this.ui.input.placeholder = this.getAttribute('placeholder')
        ?? (note ? DEFAULT_NOTE_PLACEHOLDER : recipient === undefined ? DEFAULT_PLACEHOLDER : `Message ${recipientLabel}…`);
      this.ui.input.setAttribute('aria-label', note ? 'Add a crew note' : `Message ${recipientLabel}`);
      this.ui.input.disabled = busy || composerDisabled;
      this.ui.send.disabled = busy || composerDisabled || this.getAttribute('send-disabled') === 'true';
      this.ui.send.textContent = busy
        ? (note ? 'Adding note…' : 'Sending…')
        : (this.getAttribute('submit-label') || (note ? 'Add note' : 'Send'));
      this.ui.send.dataset.loading = String(busy);
      this.ui.composer.setAttribute('aria-busy', String(busy));
      this.ui.composer.setAttribute('part', `composer ${mode}${busy ? ' submitting' : ''}`);
      this.ui.send.setAttribute('part', `button send ${mode}${busy ? ' loading' : ''}`);
      this.resizeComposer();
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
      // Full repaint per delta — cheap at chat scale, zero diffing code.
      this.computation = Tracker.autorun(() => this.paint());
    }

    private detach() {
      this.generation++;
      this.clearMessageTarget();
      this.submission = null;
      this.composing = false;
      this.closeSuggestions();
      this.composerSelection = null;
      this.approvalAction = null;
      this.approvalError = null;
      this.transcriptSignature = null;
      this.renderedTranscriptRows = 0;
      this.newMessagesPending = false;
      if (this.computation) { this.computation.stop(); this.computation = null; }
      // The optional guard on `stop()`: this element owns its own Agent, so it
      // can only ever agree — passing it keeps the call honest about which
      // session the teardown is for, and costs nothing.
      if (this.client) this.client.stop(this.sid ?? undefined);
      this.client = null;
      this.sid = null;
      this.paint();
    }

    private nearTranscriptBottom(): boolean {
      const { messages } = this.ui;
      return messages.scrollHeight - messages.clientHeight - messages.scrollTop <= 56;
    }

    private syncNewMessages() {
      this.ui.newMessages.hidden = !this.newMessagesPending;
      this.ui.newMessages.setAttribute(
        'part', `new-messages${this.newMessagesPending ? ' pending' : ''}`,
      );
    }

    /** Cheap append/stream identity. Transcript rows are immutable apart from
     *  the merged live tail, whose lengths/streaming flag change per delta. */
    private signatureFor(rows: ViewMessage[]): string {
      const tail = rows.at(-1);
      const signature = tail
        ? [
          rows.length, tail._id, tail.content?.length ?? 0,
          tail.thinking?.length ?? 0, tail.streaming ? 1 : 0,
          tail.toolCalls?.length ?? 0, tail.kind ?? '', this.failure ?? '',
        ].join(':')
        : `0:${this.failure ?? ''}`;
      return `${signature}:${this.timeline.map((item) => `${item.id}:${item.afterMessageId ?? ''}`).join(',')}`;
    }

    private timelineNodes(
      rows: ViewMessage[], render: (row: ViewMessage) => HTMLElement | null,
      /** Rows outside the `from-seq` window; items placed after them stay hidden too. */
      hidden: Set<string> | null = null,
    ): HTMLElement[] {
      const at = (value: Date | number | undefined) => {
        const number = value instanceof Date ? value.getTime() : value;
        return typeof number === 'number' && Number.isFinite(number) ? number : Number.POSITIVE_INFINITY;
      };
      const sorted = [...this.timeline].sort((a, b) => at(a.createdAt) - at(b.createdAt)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const buckets = new Map<number, HTMLElement[]>();
      for (const item of sorted) {
        if (item.afterMessageId && hidden?.has(item.afterMessageId)) continue;
        const anchor = item.afterMessageId ? rows.findIndex((row) => row._id === item.afterMessageId) : -1;
        const following = rows.findIndex((row) => at(row.createdAt) > at(item.createdAt)
          || (at(row.createdAt) === at(item.createdAt) && row._id > item.id));
        const position = anchor >= 0 ? anchor + 1 : following >= 0 ? following : rows.length;
        const nodes = buckets.get(position) ?? [];
        nodes.push(this.timelineSlots.get(item.id)!);
        buckets.set(position, nodes);
      }
      const nodes: HTMLElement[] = [];
      for (let index = 0; index <= rows.length; index += 1) {
        nodes.push(...(buckets.get(index) ?? []));
        if (index < rows.length) {
          const row = render(rows[index]);
          if (row) nodes.push(row);
        }
      }
      return nodes;
    }

    private paint() {
      const { client, sid } = this;
      const all: ViewMessage[] = client && sid
        ? (client.messages(sid).fetch() as ViewMessage[])
        : [];
      // `from-seq` is a display window only: earlier rows stay in the model's
      // context. Tool names still come from every row.
      const fromSeq = this.fromSeq;
      const rows = fromSeq === null ? all : all.filter((m) => m.seq >= fromSeq);
      const hidden = fromSeq === null
        ? null
        : new Set(all.filter((m) => m.seq < fromSeq).map((m) => m._id));
      const names = toolNames(all);
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
      // Exact machine records are opt-in. Legacy quiet/full map to clean/debug.
      const mode = transcriptMode(this.getAttribute('verbosity'));
      const mentions = this.mentionMap();
      const session = client && sid ? client.session(sid) : null;
      const agentNames = new Map((session?.participants ?? [])
        .filter((p) => p.kind === 'model' && p.agent)
        .map((p) => [p.agent!, p.displayName]));
      // The first shown row is the thread's parent message: the session's
      // recorded anchor when it is in view, else the first row in the window.
      const rootId = fromSeq === null
        ? null
        : (rows.find((m) => m._id === session?.thread?.messageId) ?? rows[0])?._id ?? null;
      const nodes = this.timelineNodes(rows, (m) => {
        const row = renderRow(
          m, names, download, mode, mentions, agentNames,
          this.threadable && sid ? sid : null,
        );
        if (row && m._id === rootId) {
          row.classList.add('thread-root');
          row.setAttribute('part', `${row.getAttribute('part')} thread-root`);
        }
        return row;
      }, hidden);
      if (this.failure) nodes.push(failureRow(this.failure));
      // Subscription hydration starts from an empty collection. Treat the
      // first durable rows as pinned even if layout has not established a
      // useful scrollHeight yet; after that, actual reader position wins.
      const wasPinned = !this.messageTarget
        && (this.renderedTranscriptRows === 0 || this.nearTranscriptBottom());
      const previousScrollTop = this.ui.messages.scrollTop;
      // Rows are rebuilt each paint; keep keyboard focus on a thread button.
      const focusedThread = (this.shadowRoot?.activeElement as HTMLElement | null)
        ?.classList.contains('thread-button')
        ? (this.shadowRoot!.activeElement as HTMLElement).dataset.messageId
        : undefined;
      const targetWasFocused = !!this.messageTarget
        && (this.shadowRoot?.activeElement as HTMLElement | null)?.dataset.messageId === this.messageTarget.id;
      const signature = this.signatureFor(rows);
      const changed = this.transcriptSignature !== null
        && signature !== this.transcriptSignature;
      // Keep app-owned timeline slots mounted so expanding a card or focusing
      // one of its controls survives unrelated message/stream paints.
      const keep = new Set(nodes);
      for (const old of [...this.ui.messages.children]) if (!keep.has(old as HTMLElement)) old.remove();
      let cursor: ChildNode | null = this.ui.messages.firstChild;
      for (const node of nodes) {
        if (node === cursor) cursor = cursor.nextSibling;
        else this.ui.messages.insertBefore(node, cursor);
      }
      if (focusedThread !== undefined) {
        const button = [...this.ui.messages.querySelectorAll<HTMLElement>('.thread-button')]
          .find((candidate) => candidate.dataset.messageId === focusedThread);
        button?.focus({ preventScroll: true });
      }
      if (this.messageTarget) {
        const target = this.visibleMessageRow(this.messageTarget.id);
        if (!target || this.messageTarget.expiresAt <= Date.now()) this.clearMessageTarget();
        else {
          this.markMessageTarget(target);
          if (targetWasFocused) target.focus({ preventScroll: true });
        }
      }
      if (wasPinned) {
        this.ui.messages.scrollTop = this.ui.messages.scrollHeight;
        this.newMessagesPending = false;
      } else {
        // Replacing rows resets scrollTop in browsers. Restore the reader's
        // viewport exactly; appended content is below it.
        this.ui.messages.scrollTop = previousScrollTop;
        if (changed) this.newMessagesPending = true;
      }
      this.transcriptSignature = signature;
      this.renderedTranscriptRows = rows.length + this.timeline.length;
      this.syncNewMessages();
      this.applyComposerMode();

      const phase: Phase = session?.phase ?? 'idle';
      this.ui.phase.textContent = phase;
      this.ui.phase.dataset.phase = phase;
      this.ui.phase.setAttribute('part', `phase ${phase}`);

      // ACTIVE_PHASES is the runtime's single definition of a live turn. A
      // root waiting on a live subagent remains `calling`, so the same rule
      // also exposes Stop for the child walk without trusting activeChild's
      // explicitly non-contractual hint.
      const interruptible = ACTIVE_PHASES.includes(phase);
      const hostDisabled = this.getAttribute('aria-disabled') === 'true';
      this.ui.stop.hidden = !interruptible;
      this.ui.stop.disabled = !interruptible || hostDisabled;
      this.ui.stop.setAttribute('part', `button stop${interruptible ? ' interruptible' : ''}`);

      const recovery = phase === 'stopped'
        ? 'Turn stopped. Send a message to continue.'
        : (phase === 'error'
          ? 'Turn failed. Review the error and send a message to retry.'
          : '');
      this.ui.recovery.textContent = recovery;
      this.ui.recovery.hidden = !recovery;
      this.ui.recovery.setAttribute('part', `recovery${recovery ? ` ${phase}` : ''}`);

      const ask = session?.pending;
      // Pending is durable state, but it is actionable only while the Session
      // is actually parked. A paused/stopped mission may retain the marker for
      // audit or recovery and must not show a dead approval control.
      const parked = phase === 'awaiting' && !!ask && !ask.verdict;
      const decision = ask && this.approvalAction?.toolCallId === ask.toolCallId
        ? this.approvalAction
        : null;
      const approvalError = ask && this.approvalError?.toolCallId === ask.toolCallId
        ? this.approvalError
        : null;
      const visible = parked || (!!decision && !!ask);
      const action = decision?.action ?? null;
      const state = approvalError
        ? 'error'
        : (ask?.verdict === 'approved' && decision
          ? 'approved'
          : (ask?.verdict === 'denied' && decision
            ? 'denied'
            : (action === 'approve' ? 'approving' : (action === 'deny' ? 'denying' : 'pending'))));
      this.ui.approval.hidden = !visible;
      this.ui.approval.dataset.state = state;
      this.ui.approval.setAttribute('part', `approval ${state}`);
      this.ui.approval.setAttribute('aria-busy', String(!!decision));
      this.ui.approve.disabled = !parked || hostDisabled || !!decision;
      this.ui.deny.disabled = !parked || hostDisabled || !!decision;
      this.ui.denyGuidance.disabled = !parked || hostDisabled || !!decision;
      this.ui.approve.dataset.loading = String(action === 'approve');
      this.ui.deny.dataset.loading = String(action === 'deny');
      this.ui.approve.textContent = action === 'approve' ? 'Approving…' : 'Approve once';
      this.ui.deny.textContent = action === 'deny' ? 'Blocking…' : 'Don’t allow';
      this.ui.approve.setAttribute('part', `button approve${action === 'approve' ? ' loading' : ''}`);
      this.ui.deny.setAttribute('part', `button deny${action === 'deny' ? ' loading' : ''}`);
      if (visible && ask) {
        if (this.approvalGuidanceFor !== ask.toolCallId) {
          this.approvalGuidanceFor = ask.toolCallId;
          this.ui.denyGuidance.value = '';
        }
        const display = typeof ask.display === 'string' ? ask.display : '';
        const safeDisplay = display && !isStructuredAssistantContent(display)
          ? cleanApprovalText(sanitizeCleanAssistantContent(display), 280)
          : '';
        const summary = safeDisplay || summarizeToolArgs(ask.args);
        const runAs = ask.runAs === undefined
          ? 'Runs as session owner'
          : `Runs as ${cleanApprovalText(ask.runAs ?? 'anonymous', 96)}`;
        const requestingAgent = ask.agent ?? session?.agent;
        const requester = session?.participants?.find(
          (participant) => participant.kind === 'model' && participant.agent === requestingAgent,
        )?.displayName ?? humanizeIdentifier(requestingAgent, 'Agent');
        this.ui.approvalTitle.textContent = humanizeIdentifier(ask.name);
        this.ui.approvalSummary.textContent = summary;
        this.ui.approvalSummary.hidden = !summary;
        this.ui.approvalTool.textContent = `Tool · ${humanizeIdentifier(ask.name)}`;
        this.ui.approvalRequester.textContent = `Requested by ${requester}`;
        this.ui.approvalIdentity.textContent = runAs;
        this.ui.approvalIdentity.setAttribute(
          'part', `approval-identity ${ask.runAs === undefined ? 'inherited' : 'elevated'}`,
        );
        this.ui.approvalSource.textContent = ask.mcpServer ? 'MCP tool' : 'App tool';
        const status = approvalError?.message
          ?? (state === 'approving'
            ? 'Approving this call…'
            : (state === 'denying'
              ? 'Blocking this call…'
              : (state === 'approved'
                ? 'Approved · Continuing…'
                : (state === 'denied'
                  ? 'Not allowed · Continuing…'
                  : 'Review this request before the mission can continue.'))));
        if (this.ui.approvalStatus.textContent !== status) {
          this.ui.approvalStatus.textContent = status;
        }
        if (mode === 'debug') {
          // Debug preserves the exact approval record for operator diagnostics.
          const argsJson = JSON.stringify(ask.args, null, 2) ?? '';
          this.ui.approvalDebug.textContent = argsJson.length > 2000
            ? `${argsJson.slice(0, 2000)}…`
            : argsJson;
          this.ui.approvalDebug.hidden = false;
        } else {
          this.ui.approvalDebug.textContent = '';
          this.ui.approvalDebug.hidden = true;
        }
      } else {
        this.approvalGuidanceFor = null;
        this.ui.denyGuidance.value = '';
        this.ui.denyGuidance.disabled = true;
        this.ui.approvalTitle.textContent = '';
        this.ui.approvalSummary.textContent = '';
        this.ui.approvalTool.textContent = '';
        this.ui.approvalRequester.textContent = '';
        this.ui.approvalIdentity.textContent = '';
        this.ui.approvalSource.textContent = '';
        if (this.ui.approvalStatus.textContent) this.ui.approvalStatus.textContent = '';
        this.ui.approvalDebug.textContent = '';
        this.ui.approvalDebug.hidden = true;
      }
    }

    /** The mention token at the caret, or null. Only completes at the cursor. */
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
      if (this.composing) { this.closeSuggestions(); return; }
      const token = this.tokenAtCaret();
      if (!token) { this.closeSuggestions(); return; }
      const bounds = this.ui.input.getBoundingClientRect();
      const proceed = this.dispatchEvent(new CustomEvent('agent-chat:mention-query', {
        detail: { prefix: token.prefix, query: token.query,
          range: { start: token.start, end: this.ui.input.selectionEnd ?? this.ui.input.value.length },
          rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
            top: bounds.top, right: bounds.right, bottom: bounds.bottom, left: bounds.left } },
        bubbles: true, composed: true, cancelable: true,
      }));
      if (!proceed) { this.closeSuggestions(); return; }
      // Only what THIS symbol names: typing `#` must not offer a person. The
      // source does its own matching, so a big collection can filter at the
      // query rather than shipping everything here to be sieved.
      const source = this.mentionMap().get(token.prefix);
      const hits = source ? source.search(token.query) : [];
      if (hits.length === 0) {
        this.closeSuggestions();
        if (source?.emptyText) {
          const empty = document.createElement('div');
          empty.className = 'suggestion-empty';
          empty.setAttribute('part', 'suggestion-empty');
          empty.setAttribute('role', 'status');
          empty.textContent = source.emptyText;
          this.ui.typeahead.replaceChildren(empty);
          this.ui.typeahead.hidden = false;
          this.ui.input.setAttribute('aria-expanded', 'true');
        }
        return;
      }
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
        row.id = `agent-chat-suggestion-${i}`;
        row.tabIndex = -1;
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
        // Assistive technology and HTMLElement.click() can invoke semantic
        // click without mousedown. The first acceptance clears suggestions,
        // so an ordinary pointer's following click cannot insert twice.
        row.addEventListener('click', () => {
          if (this.suggestions[i] !== m) return;
          this.cursorAt = i;
          this.acceptSuggestion();
        });
        return row;
      }));
      typeahead.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-activedescendant', `agent-chat-suggestion-${this.cursorAt}`);
    }

    private closeSuggestions() {
      this.suggestions = [];
      this.cursorAt = -1;
      this.ui.typeahead.hidden = true;
      this.ui.typeahead.replaceChildren();
      this.ui.input.setAttribute('aria-expanded', 'false');
      this.ui.input.removeAttribute('aria-activedescendant');
    }

    private onKeyDown(e: KeyboardEvent) {
      if (this.composing || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        if (e.shiftKey && this.hasAttribute('multiline')) return;
        e.preventDefault();
        if (this.suggestions.length) this.acceptSuggestion();
        else void this.submit();
        return;
      }
      if (e.key === 'Escape' && !this.ui.typeahead.hidden) {
        e.preventDefault(); this.closeSuggestions(); return;
      }
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
      // Enter is handled above because a textarea's native Enter is a newline,
      // not an implicit form submit. The send button shares the same guard.
    }

    private acceptSuggestion() {
      const chosen = this.suggestions[this.cursorAt];
      const token = this.tokenAtCaret();
      if (!chosen || !token || token.prefix !== this.suggestPrefix
        || !this.mentionMap().get(token.prefix)?.lookup(chosen.handle)) {
        this.closeSuggestions(); return;
      }
      const { input } = this.ui;
      if (!this.requestMentionSelection(token.prefix, chosen)) { this.closeSuggestions(); return; }
      const caret = input.selectionStart ?? input.value.length;
      // The trailing space is what ends the token: without it the next
      // keystroke re-opens the list against a handle that is already complete.
      const insert = `${token.prefix}${chosen.handle} `;
      input.value = input.value.slice(0, token.start) + insert + input.value.slice(caret);
      const at = token.start + insert.length;
      input.setSelectionRange(at, at);
      this.closeSuggestions();
      input.focus();
      this.draftChanged();
      this.mentionSelected(token.prefix, chosen);
    }

    private async submit() {
      if (this.submission || this.getAttribute('aria-disabled') === 'true'
        || this.getAttribute('composer-disabled') === 'true'
        || this.getAttribute('send-disabled') === 'true') return;
      const text = this.ui.input.value.trim();
      if (!text && !(this.allowEmptySubmit && this.submissionHandler)) return;
      const { client, sid } = this;
      if (!client || !sid) {
        this.fail(new Error('no session yet — the agent is still starting'));
        return;
      }
      const mode = this.composerMode;
      const recipient = mode === 'ask' ? this.recipient : undefined;
      const handler = this.submissionHandler;
      const generation = this.generation;
      const submission = { mode, text, ...(recipient === undefined ? {} : { recipient }) };
      this.clearFailure();
      this.submission = submission;
      this.ui.input.value = '';
      this.draftChanged();
      this.closeSuggestions();
      this.applyComposerMode();
      try {
        if (handler) await handler({ sessionId: sid, ...submission });
        else if (mode === 'note') await client.contribute(sid, text);
        else await client.send(sid, text, recipient === undefined ? undefined : { to: recipient });
        if (generation === this.generation) {
          this.dispatchEvent(new CustomEvent('agent-chat:submitted', {
            detail: { sessionId: sid, mode, ...(recipient === undefined ? {} : { recipient }) },
            bubbles: true, composed: true,
          }));
        }
      } catch (e) {
        // Put the text back: a write that failed (rate limit, offline, a
        // session the server no longer has) must not eat what was typed.
        if (generation === this.generation) {
          this.ui.input.value = text;
          this.draftChanged();
          this.fail(e);
        }
      } finally {
        if (generation === this.generation && this.submission === submission) {
          this.submission = null;
          this.applyComposerMode();
        }
      }
    }

    private async decide(action: 'approve' | 'deny') {
      const { client, sid } = this;
      if (this.getAttribute('aria-disabled') === 'true' || !client || !sid || this.approvalAction) return;
      const ask = client.pending(sid);
      if (client.status(sid) !== 'awaiting' || !ask || ask.verdict) return;
      const generation = this.generation;
      const toolCallId = ask.toolCallId;
      // Read before the busy repaint disables the field. `cleanApprovalText`
      // removes controls, folds whitespace, and bounds programmatically-set
      // values even when the browser's maxlength was bypassed.
      const denialReason = action === 'deny'
        ? (cleanApprovalText(this.ui.denyGuidance.value, DENY_GUIDANCE_MAX) || DENY_REASON)
        : undefined;
      this.approvalError = null;
      this.approvalAction = { action, toolCallId };
      this.paint();
      try {
        this.clearFailure();
        if (action === 'approve') await client.approve(sid, toolCallId);
        else await client.deny(sid, denialReason, toolCallId);
      } catch (e) {
        if (generation === this.generation) {
          this.approvalError = { toolCallId, message: messageOf(e) };
          this.fail(e);
        }
      } finally {
        if (generation === this.generation) {
          this.approvalAction = null;
          if (this.live) this.paint();
        }
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
