import { lexer, type Token, type Tokens } from 'marked';

/**
 * Safe assistant Markdown.
 *
 * Marked is used only as a lexer. Its HTML renderer is never called. We walk
 * the token tree into a small, allowlisted DOM and write every content leaf as
 * a Text node, so raw HTML and malformed streaming output stay inert.
 */

type TextNodes = (value: string) => Node[];

export type MarkdownRenderOptions = {
  /** Allows the chat element to retain its existing mention-chip renderer. */
  textNodes?: TextNodes;
};

const LANGUAGE = /^[a-z0-9+#._-]{1,32}$/i;
const SAFE_PROTOCOLS = new Set(['https:', 'mailto:']);

function setPart(element: HTMLElement, value: string): void {
  element.setAttribute('part', value);
}

function appendNodes(parent: Node, nodes: Node[]): void {
  for (const node of nodes) parent.appendChild(node);
}

function appendText(parent: Node, value: string, render: TextNodes): void {
  if (value) appendNodes(parent, render(value));
}

function safeLink(value: string): string | null {
  const source = String(value ?? '').trim();
  if (!source || /[\u0000-\u001f\u007f]/.test(source) || source.startsWith('//')) return null;
  try {
    const url = new URL(source);
    if (!SAFE_PROTOCOLS.has(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function languageName(value: string | undefined): string {
  const candidate = String(value ?? '').trim().split(/\s+/, 1)[0] ?? '';
  return LANGUAGE.test(candidate) ? candidate.toLowerCase() : '';
}

function safeTitle(value: string): string {
  return [...value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')]
    .slice(0, 200)
    .join('');
}

function appendCode(parent: Node, token: Tokens.Code): void {
  const language = languageName(token.lang);
  const frame = document.createElement('div');
  frame.className = 'markdown-code-frame';
  setPart(frame, 'markdown-code-frame');
  if (language) {
    const label = document.createElement('span');
    label.className = 'markdown-language';
    setPart(label, 'markdown-language');
    label.textContent = language;
    frame.appendChild(label);
  }
  const pre = document.createElement('pre');
  pre.className = 'markdown-code-block';
  setPart(pre, 'markdown-code-block');
  const code = document.createElement('code');
  setPart(code, 'markdown-code');
  if (language) code.dataset.language = language;
  code.textContent = token.text;
  pre.appendChild(code);
  frame.appendChild(pre);
  parent.appendChild(frame);
}

function appendLink(parent: Node, token: Tokens.Link, render: TextNodes): void {
  const href = safeLink(token.href);
  if (!href) {
    // Keep the complete source visible so a rejected destination cannot turn
    // into deceptively normal linked-looking prose.
    appendText(parent, token.raw, render);
    return;
  }
  const link = document.createElement('a');
  link.className = 'markdown-link';
  setPart(link, 'markdown-link');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer nofollow';
  link.referrerPolicy = 'no-referrer';
  if (token.title) link.title = safeTitle(token.title);
  appendInline(link, token.tokens, render);
  parent.appendChild(link);
}

function appendInline(parent: Node, tokens: Token[], render: TextNodes): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const text = token as Tokens.Text;
        if (text.tokens?.length) appendInline(parent, text.tokens, render);
        else appendText(parent, text.text, render);
        break;
      }
      case 'escape':
        appendText(parent, (token as Tokens.Escape).text, render);
        break;
      case 'strong': {
        const strong = document.createElement('strong');
        strong.className = 'markdown-strong';
        setPart(strong, 'markdown-strong');
        appendInline(strong, (token as Tokens.Strong).tokens, render);
        parent.appendChild(strong);
        break;
      }
      case 'em': {
        const emphasis = document.createElement('em');
        emphasis.className = 'markdown-emphasis';
        setPart(emphasis, 'markdown-emphasis');
        appendInline(emphasis, (token as Tokens.Em).tokens, render);
        parent.appendChild(emphasis);
        break;
      }
      case 'del': {
        const deleted = document.createElement('del');
        deleted.className = 'markdown-strikethrough';
        setPart(deleted, 'markdown-strikethrough');
        appendInline(deleted, (token as Tokens.Del).tokens, render);
        parent.appendChild(deleted);
        break;
      }
      case 'codespan': {
        const code = document.createElement('code');
        code.className = 'markdown-inline-code';
        setPart(code, 'markdown-code markdown-inline-code');
        code.textContent = (token as Tokens.Codespan).text;
        parent.appendChild(code);
        break;
      }
      case 'br': {
        const br = document.createElement('br');
        setPart(br, 'markdown-break');
        parent.appendChild(br);
        break;
      }
      case 'link':
        appendLink(parent, token as Tokens.Link, render);
        break;
      case 'image':
        // Remote images are a tracking surface. Preserve the authored syntax
        // as text rather than fetching or silently discarding it.
        appendText(parent, token.raw, render);
        break;
      case 'html':
        appendText(parent, token.raw, render);
        break;
      default:
        appendText(parent, token.raw, render);
    }
  }
}

function appendList(parent: Node, token: Tokens.List, render: TextNodes): void {
  const list = document.createElement(token.ordered ? 'ol' : 'ul');
  list.className = 'markdown-list';
  setPart(
    list,
    `markdown-list ${token.ordered ? 'markdown-ordered-list' : 'markdown-unordered-list'}`,
  );
  if (token.ordered && typeof token.start === 'number' && token.start > 1) {
    (list as HTMLOListElement).start = token.start;
  }
  for (const item of token.items) {
    const listItem = document.createElement('li');
    setPart(listItem, `markdown-list-item${item.task ? ' markdown-task' : ''}`);
    if (item.task) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !!item.checked;
      checkbox.disabled = true;
      checkbox.tabIndex = -1;
      checkbox.setAttribute('aria-label', item.checked ? 'Completed' : 'Not completed');
      setPart(checkbox, 'markdown-checkbox');
      listItem.appendChild(checkbox);
    }
    appendBlocks(listItem, item.tokens, render);
    list.appendChild(listItem);
  }
  parent.appendChild(list);
}

function appendTable(parent: Node, token: Tokens.Table, render: TextNodes): void {
  const frame = document.createElement('div');
  frame.className = 'markdown-table-frame';
  setPart(frame, 'markdown-table-frame');
  const table = document.createElement('table');
  table.className = 'markdown-table';
  setPart(table, 'markdown-table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  token.header.forEach((entry, index) => {
    const cell = document.createElement('th');
    cell.scope = 'col';
    setPart(cell, 'markdown-table-heading');
    if (token.align[index]) cell.style.textAlign = token.align[index]!;
    appendInline(cell, entry.tokens, render);
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  table.appendChild(head);
  const body = document.createElement('tbody');
  for (const entries of token.rows) {
    const row = document.createElement('tr');
    entries.forEach((entry, index) => {
      const cell = document.createElement('td');
      setPart(cell, 'markdown-table-cell');
      if (token.align[index]) cell.style.textAlign = token.align[index]!;
      appendInline(cell, entry.tokens, render);
      row.appendChild(cell);
    });
    body.appendChild(row);
  }
  table.appendChild(body);
  frame.appendChild(table);
  parent.appendChild(frame);
}

function appendBlocks(parent: Node, tokens: Token[], render: TextNodes): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
      case 'def':
        break;
      case 'paragraph': {
        const paragraph = document.createElement('p');
        paragraph.className = 'markdown-paragraph';
        setPart(paragraph, 'markdown-paragraph');
        appendInline(paragraph, (token as Tokens.Paragraph).tokens, render);
        parent.appendChild(paragraph);
        break;
      }
      case 'heading': {
        const headingToken = token as Tokens.Heading;
        const depth = Math.max(1, Math.min(6, headingToken.depth));
        const heading = document.createElement(`h${depth}`);
        heading.className = `markdown-heading markdown-heading-${depth}`;
        setPart(heading, `markdown-heading markdown-heading-${depth}`);
        appendInline(heading, headingToken.tokens, render);
        parent.appendChild(heading);
        break;
      }
      case 'code':
        appendCode(parent, token as Tokens.Code);
        break;
      case 'blockquote': {
        const quote = document.createElement('blockquote');
        quote.className = 'markdown-blockquote';
        setPart(quote, 'markdown-blockquote');
        appendBlocks(quote, (token as Tokens.Blockquote).tokens, render);
        parent.appendChild(quote);
        break;
      }
      case 'list':
        appendList(parent, token as Tokens.List, render);
        break;
      case 'table':
        appendTable(parent, token as Tokens.Table, render);
        break;
      case 'hr': {
        const rule = document.createElement('hr');
        setPart(rule, 'markdown-rule');
        parent.appendChild(rule);
        break;
      }
      case 'html':
        appendText(parent, token.raw, render);
        break;
      case 'text': {
        const text = token as Tokens.Text;
        if (text.tokens?.length) appendInline(parent, text.tokens, render);
        else appendText(parent, text.text, render);
        break;
      }
      default:
        appendText(parent, token.raw, render);
    }
  }
}

/** Render the supported GFM/CommonMark token set into an inert DOM subtree. */
export function renderAssistantMarkdown(
  value: string, options: MarkdownRenderOptions = {},
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'markdown';
  setPart(root, 'markdown');
  const render = options.textNodes ?? ((text: string) => [document.createTextNode(text)]);
  try {
    appendBlocks(root, lexer(String(value ?? ''), {
      async: false, breaks: true, gfm: true, pedantic: false,
    }), render);
  } catch {
    // Correctness never depends on the parser. A malformed or future token
    // stream degrades to safe text instead of dropping the assistant reply.
    root.replaceChildren(document.createTextNode(String(value ?? '')));
  }
  return root;
}
