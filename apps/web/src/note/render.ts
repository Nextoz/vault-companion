// Linked-note rendering (docs/security.md "Rendering", threat T3). Two independent layers, each sufficient alone for
// the XSS corpus in render.test.ts:
//   1. markdown-it with raw HTML disabled: every `<…>` in the note is escaped text; links must be http(s), otherwise
//      they stay literal text; images are reduced to their alt text (no remote fetches, no `data:`/`javascript:` src).
//   2. DOMPurify with a tag/attribute allowlist over that output; every surviving `href` is re-checked (http(s) only)
//      and gets `rel="noopener noreferrer"` and `target="_blank"`.
// Wikilinks inside a note are shown as plain text: the contract resolves links only from a current task line.
import DOMPurify, { type WindowLike } from 'dompurify';
import MarkdownItFactory, { type MarkdownIt } from 'markdown-it';

const SAFE_HREF = /^https?:\/\//i;

const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 's', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span',
];
const ALLOWED_ATTR = ['href', 'class', 'start'];

function markdown(): MarkdownIt {
  const md = MarkdownItFactory({ html: false, linkify: false, typographer: false });
  md.validateLink = (url) => SAFE_HREF.test(url.trim());
  md.renderer.rules['image'] = (tokens, idx, options, env, self) =>
    md.utils.escapeHtml(self.renderInlineAsText(tokens[idx]!.children ?? [], options, env));
  // `[[target]]`, `[[target|alias]]`, `![[embed]]` → the visible name as escaped text (same grammar as the kernel).
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const src = state.src;
    const start = src.charCodeAt(state.pos) === 0x21 ? state.pos + 1 : state.pos;
    if (!src.startsWith('[[', start)) return false;
    const end = src.indexOf(']]', start + 2);
    if (end < 0) return false;
    const inner = src.slice(start + 2, end);
    if (inner.trim() === '' || /[[\]\n]/.test(inner)) return false;
    if (!silent) {
      const bar = inner.indexOf('|');
      const token = state.push('wikilink', '', 0);
      token.content = (bar >= 0 ? inner.slice(bar + 1) : inner).trim() || inner.trim();
    }
    state.pos = end + 2;
    return true;
  });
  md.renderer.rules['wikilink'] = (tokens, idx) => `<span class="wikilink">${md.utils.escapeHtml(tokens[idx]!.content)}</span>`;
  return md;
}

const md = markdown();

/** Layer 1 alone: note Markdown → HTML with raw HTML escaped. Never inserted without layer 2. */
export const renderMarkdown = (source: string): string => md.render(source);

/** Layer 2 alone: allowlist sanitiser over HTML. `win` is the page's window in the app, a jsdom window in tests. */
export function createSanitizer(win: WindowLike): (html: string) => string {
  const purify = DOMPurify(win);
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName !== 'A') return;
    const href = node.getAttribute('href');
    if (href === null || !SAFE_HREF.test(href)) {
      node.removeAttribute('href');
      return;
    }
    node.setAttribute('rel', 'noopener noreferrer');
    node.setAttribute('target', '_blank');
  });
  return (html) =>
    purify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      // Every attribute value not marked URI-safe must match this, which is what keeps hrefs http(s)-only.
      ALLOWED_URI_REGEXP: SAFE_HREF,
      ADD_URI_SAFE_ATTR: ['start'],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    });
}

export type NoteRenderer = (source: string) => string;

export function createNoteRenderer(win: WindowLike): NoteRenderer {
  const sanitize = createSanitizer(win);
  return (source) => sanitize(renderMarkdown(source));
}
