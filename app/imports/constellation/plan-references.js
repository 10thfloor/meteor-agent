// Plan handles are references, not commands. Only this complete, deliberately
// small grammar can start work; quoted, conditional and conversational mentions
// remain ordinary chat.
export const PLAN_HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function planHandleBase(name) {
  return String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '') || 'plan';
}

/** Preserve the surrounding source grammar while excluding literal code.
 * In particular, a filename such as `/workspace/report #review.md` is not a
 * plan reference. Backtick runs pair by exact length, so filenames containing
 * backticks remain safe when the caller chooses a longer code-span delimiter. */
function outsideCode(text) {
  let fence = null;
  const blocks = text.split('\n').map((line) => {
    // Quoted fenced blocks obey the same rule as ordinary fenced blocks.
    const content = line.replace(/\r$/, '').replace(/^(?: {0,3}>[ \t]?)+/, '');
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(content);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) fence = null;
      return line.replace(/[^\r]/g, ' ');
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    if (open && (open[1][0] !== '`' || !open[2].includes('`'))) {
      fence = { marker: open[1][0], length: open[1].length };
      return line.replace(/[^\r]/g, ' ');
    }
    return line;
  }).join('\n');
  // Inline spans may cross a line break, but never cross a paragraph/fenced
  // block boundary. Masked fenced lines are blank for this purpose.
  return blocks.split(/(\r?\n[ \t]*\r?\n)/).map((part) => {
    const runs = [...part.matchAll(/`+/g)].map((match) => {
      let backslashes = 0;
      for (let index = match.index - 1; index >= 0 && part[index] === '\\'; index -= 1) backslashes += 1;
      return { start: match.index, length: match[0].length, escaped: backslashes % 2 === 1, next: null };
    });
    const nextByLength = new Map();
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index]; run.next = nextByLength.get(run.length) ?? null;
      nextByLength.set(run.length, index);
    }
    const result = []; let cursor = 0;
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index];
      if (run.escaped || run.next === null) continue;
      const close = runs[run.next]; const end = close.start + close.length;
      result.push(part.slice(cursor, run.start), part.slice(run.start, end).replace(/[^\r\n]/g, '\uFFFC'));
      cursor = end; index = run.next;
    }
    return result.join('') + part.slice(cursor);
  }).join('');
}

export function planReferenceHandles(text) {
  if (typeof text !== 'string') return [];
  return [...new Set([...outsideCode(text).matchAll(/(?:^|[\s(])#([a-z0-9][a-z0-9_-]{0,63})(?![a-z0-9_-])/gi)]
    .map((match) => match[1].toLowerCase()))];
}

export function parsePlanRunCommand(text) {
  if (typeof text !== 'string') return null;
  const source = text.trim();
  const handle = /^run\s+#([a-z0-9][a-z0-9_-]{0,63})[.!]?$/i.exec(source);
  if (handle) return { handle: handle[1].toLowerCase() };
  if (/^run this mission['’]s plan[.!]?$/i.test(source)) return { currentMission: true };
  return null;
}
