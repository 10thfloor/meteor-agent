import { lexer } from 'marked';

// Markdown for a thread's answers, as DOM.
//
// The same rule as the packaged chat element follows: marked is the lexer and
// nothing more. Its HTML renderer is never called. The token tree is walked
// into a short list of elements, and every piece of content becomes a Text
// node, so raw HTML in an answer, and the half-finished Markdown of an answer
// still arriving, stay inert.

const SAFE_PROTOCOLS = new Set(['https:', 'mailto:']);
const LANGUAGE = /^[a-z0-9+#._-]{1,32}$/i;

/** The link's destination if it is one a click may follow, otherwise null. */
export function safeLink(value) {
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

const element = (tag, className) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

function inline(parent, tokens) {
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'strong':
      case 'em':
      case 'del': {
        const node = element(token.type === 'del' ? 's' : token.type);
        inline(node, token.tokens);
        parent.appendChild(node);
        break;
      }
      case 'codespan': {
        const node = element('code');
        node.textContent = token.text;
        parent.appendChild(node);
        break;
      }
      case 'br':
        parent.appendChild(element('br'));
        break;
      case 'link': {
        const href = safeLink(token.href);
        if (href === null) {
          // Not a destination a click may follow: its words stay, as words.
          inline(parent, token.tokens);
          break;
        }
        const node = element('a');
        node.href = href;
        node.target = '_blank';
        node.rel = 'noopener noreferrer';
        inline(node, token.tokens);
        parent.appendChild(node);
        break;
      }
      case 'image':
        // No image is fetched on a model's say-so; its description is shown.
        parent.appendChild(document.createTextNode(token.text || token.href || ''));
        break;
      case 'text':
        if (token.tokens?.length) inline(parent, token.tokens);
        else parent.appendChild(document.createTextNode(token.text ?? ''));
        break;
      case 'escape':
        parent.appendChild(document.createTextNode(token.text ?? ''));
        break;
      case 'checkbox':
        // The list item carries the task's state; see `blocks`.
        break;
      default:
        // `html` among them: shown as the characters it is made of.
        parent.appendChild(document.createTextNode(token.raw ?? token.text ?? ''));
    }
  }
}

function blocks(parent, tokens) {
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'space':
      case 'def':
      case 'checkbox':
        break;
      case 'paragraph': {
        const node = element('p');
        inline(node, token.tokens);
        parent.appendChild(node);
        break;
      }
      case 'heading': {
        // One size of heading: an answer is not a page.
        const node = element('p', 'threads-md-heading');
        node.setAttribute('role', 'heading');
        node.setAttribute('aria-level', String(Math.min(Math.max(token.depth, 1), 6)));
        inline(node, token.tokens);
        parent.appendChild(node);
        break;
      }
      case 'code': {
        const frame = element('pre');
        const language = String(token.lang ?? '').trim().split(/\s+/, 1)[0] ?? '';
        if (LANGUAGE.test(language)) frame.dataset.language = language.toLowerCase();
        const code = element('code');
        code.textContent = token.text;
        frame.appendChild(code);
        parent.appendChild(frame);
        break;
      }
      case 'blockquote': {
        const node = element('blockquote');
        blocks(node, token.tokens);
        parent.appendChild(node);
        break;
      }
      case 'list': {
        const list = element(token.ordered ? 'ol' : 'ul');
        if (token.ordered && Number.isInteger(token.start) && token.start !== 1) list.start = token.start;
        for (const item of token.items ?? []) {
          const node = element('li');
          if (item.task) node.dataset.task = item.checked ? 'done' : 'open';
          blocks(node, item.tokens);
          list.appendChild(node);
        }
        parent.appendChild(list);
        break;
      }
      case 'table': {
        const scroll = element('div', 'threads-md-table');
        const table = element('table');
        const head = element('tr');
        for (const cell of token.header ?? []) {
          const node = element('th');
          inline(node, cell.tokens);
          head.appendChild(node);
        }
        const thead = element('thead');
        thead.appendChild(head);
        table.appendChild(thead);
        const body = element('tbody');
        for (const row of token.rows ?? []) {
          const line = element('tr');
          for (const cell of row) {
            const node = element('td');
            inline(node, cell.tokens);
            line.appendChild(node);
          }
          body.appendChild(line);
        }
        table.appendChild(body);
        scroll.appendChild(table);
        parent.appendChild(scroll);
        break;
      }
      case 'hr':
        parent.appendChild(element('hr'));
        break;
      case 'text': {
        // Loose text inside a list item.
        if (token.tokens?.length) {
          const node = element('p');
          inline(node, token.tokens);
          parent.appendChild(node);
        } else {
          parent.appendChild(document.createTextNode(token.text ?? ''));
        }
        break;
      }
      default:
        parent.appendChild(document.createTextNode(token.raw ?? ''));
    }
  }
}

/** Replace `target`'s content with `source` rendered as Markdown. */
export function renderMarkdown(target, source) {
  const fragment = document.createDocumentFragment();
  try {
    blocks(fragment, lexer(String(source ?? ''), { gfm: true, breaks: false }));
  } catch {
    // Text that the lexer cannot take is still text.
    fragment.replaceChildren(document.createTextNode(String(source ?? '')));
  }
  target.replaceChildren(fragment);
}
