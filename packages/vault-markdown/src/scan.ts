// Line scanner: decides which lines are "visible" Markdown (outside frontmatter, fenced code, `%% %%` and
// `<!-- -->` comments) — docs/vault-contract.md §2, ADR-0004. Deliberately conservative: when in doubt a line is
// treated as hidden, which can only make fewer tasks actionable, never act on the wrong line.

export interface LineScan {
  /** Line is ordinary Markdown: headings and task lines are only recognised on visible lines. */
  readonly visible: readonly boolean[];
  /** After this line the scanner is back in ordinary Markdown (no open frontmatter/fence/comment). */
  readonly cleanAfter: readonly boolean[];
}

type Comment = '%%' | '<!--' | null;

const FRONTMATTER_DELIM = /^---[ \t]*$/;
const FENCE_OPEN = /^[ \t>]*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/;

export function scanLines(lines: readonly string[]): LineScan {
  const n = lines.length;
  const visible = new Array<boolean>(n).fill(false);
  const cleanAfter = new Array<boolean>(n).fill(false);
  let i = 0;
  if (n > 0 && FRONTMATTER_DELIM.test(lines[0]!)) {
    let close = -1;
    for (let j = 1; j < n; j++) {
      if (FRONTMATTER_DELIM.test(lines[j]!)) {
        close = j;
        break;
      }
    }
    // Unclosed `---` is not frontmatter (Obsidian renders it as a thematic break).
    if (close >= 0) {
      cleanAfter[close] = true;
      i = close + 1;
    }
  }
  let fence: { ch: string; len: number } | null = null;
  let comment: Comment = null;
  for (; i < n; i++) {
    const line = lines[i]!;
    if (fence) {
      const m = FENCE_CLOSE.exec(line);
      if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len) fence = null;
      cleanAfter[i] = fence === null;
      continue;
    }
    if (comment === null) {
      const f = FENCE_OPEN.exec(line);
      // A backtick fence's info string may not contain a backtick (CommonMark); otherwise it is inline code.
      if (f && !(f[1]![0] === '`' && f[2]!.includes('`'))) {
        fence = { ch: f[1]![0]!, len: f[1]!.length };
        continue;
      }
      comment = scanComments(stripCodeSpans(line), null);
      visible[i] = comment === null;
      cleanAfter[i] = comment === null;
      continue;
    }
    comment = scanComments(line, comment);
    cleanAfter[i] = comment === null;
  }
  return { visible, cleanAfter };
}

/** Walk comment delimiters left to right; returns the comment state at end of line. */
function scanComments(line: string, start: Comment): Comment {
  let state = start;
  let pos = 0;
  for (;;) {
    if (state === null) {
      const a = line.indexOf('%%', pos);
      const b = line.indexOf('<!--', pos);
      if (a < 0 && b < 0) return null;
      if (b < 0 || (a >= 0 && a < b)) {
        state = '%%';
        pos = a + 2;
      } else {
        state = '<!--';
        pos = b + 4;
      }
    } else {
      const close = state === '%%' ? '%%' : '-->';
      const c = line.indexOf(close, pos);
      if (c < 0) return state;
      state = null;
      pos = c + close.length;
    }
  }
}

/** Remove inline code spans (matching backtick runs) so `%%` or `<!--` inside code do not open comments. */
export function stripCodeSpans(line: string): string {
  let out = '';
  let pos = 0;
  while (pos < line.length) {
    const open = line.indexOf('`', pos);
    if (open < 0) break;
    let runEnd = open;
    while (line[runEnd] === '`') runEnd++;
    const run = runEnd - open;
    let search = runEnd;
    let close = -1;
    while (search < line.length) {
      const c = line.indexOf('`', search);
      if (c < 0) break;
      let e = c;
      while (line[e] === '`') e++;
      if (e - c === run) {
        close = c;
        search = e;
        break;
      }
      search = e;
    }
    if (close < 0) {
      out += line.slice(pos, runEnd);
      pos = runEnd;
    } else {
      out += line.slice(pos, open);
      pos = search;
    }
  }
  return out + line.slice(pos);
}
