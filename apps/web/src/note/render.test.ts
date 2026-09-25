// Threat T3 (docs/threat-model.md): the XSS payload corpus renders inert through the full pipeline, and each layer
// (Markdown with raw HTML off; allowlist sanitiser) holds on its own.
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { createNoteRenderer, createSanitizer, renderMarkdown } from './render.ts';

const { window } = new JSDOM('');
const render = createNoteRenderer(window as never);
const sanitize = createSanitizer(window as never);

const ALLOWED = new Set(['P', 'BR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'EM', 'S', 'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN']);

/** Structural inertness: allowlisted elements only, no event handlers or styles, links http(s) with rel. */
function assertInert(html: string) {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  for (const el of doc.body.querySelectorAll('*')) {
    expect(ALLOWED.has(el.tagName), `element ${el.tagName}`).toBe(true);
    for (const attr of el.getAttributeNames()) {
      expect(['href', 'class', 'start', 'rel', 'target'], `attribute ${attr} on ${el.tagName}`).toContain(attr);
    }
    if (el.tagName === 'A' && el.hasAttribute('href')) {
      expect(el.getAttribute('href')).toMatch(/^https?:\/\//i);
      expect(el.getAttribute('rel')).toBe('noopener noreferrer');
    }
  }
  return doc;
}

const CORPUS: Record<string, string> = {
  script: '<script>alert(1)</script>',
  scriptInline: 'text <script>alert(1)</script> more',
  onHandler: '<img src=x onerror=alert(1)>',
  onHandlerInline: 'a <b onmouseover="alert(1)">b</b>',
  svg: '<svg onload=alert(1)><circle r="1"/></svg>',
  svgBlock: '<svg>\n<script>alert(1)</script>\n</svg>',
  rawHtmlBlock: '<div>\n<iframe src="https://evil.example"></iframe>\n</div>',
  style: '<style>body{display:none}</style>',
  jsLink: '[click](javascript:alert(1))',
  jsLinkCase: '[click](JaVaScRiPt:alert(1))',
  jsLinkEntity: '[click](javascript&#58;alert(1))',
  jsLinkSpace: '[click]( javascript:alert(1))',
  dataLink: '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  vbLink: '[click](vbscript:msgbox(1))',
  fileLink: '[click](file:///etc/passwd)',
  jsImage: '![alt](javascript:alert(1))',
  dataImage: '![pic](data:image/png;base64,iVBORw0KGgo=)',
  remoteImage: '![tracker](https://evil.example/pixel.png)',
  jsAutolink: '<javascript:alert(1)>',
  jsRefLink: '[x][r]\n\n[r]: javascript:alert(1)',
  htmlInLinkText: '[<img src=x onerror=alert(1)>](https://example.com)',
  wikilinkHtml: '[[<img src=x onerror=alert(1)>|<script>alert(1)</script>]]',
  titleAttr: '[x](https://example.com "onmouseover=alert(1)")',
  entityScript: '&lt;script&gt;alert(1)&lt;/script&gt;',
  comment: '<!-- <script>alert(1)</script> -->',
  mathml: '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
};

describe('linked-note rendering is inert (T3 corpus)', () => {
  it.each(Object.entries(CORPUS))('%s', (_name, source) => {
    const html = render(source);
    const doc = assertInert(html);
    expect(html).not.toMatch(/<(script|svg|img|iframe|style|math|object|embed)\b/i);
    expect(html).not.toMatch(/<[^>]*\son[a-z]+\s*=/i); // escaped text like `&lt;img onerror=` is inert
    expect(doc.querySelectorAll('a:not([href])').length + doc.querySelectorAll('a[href]').length).toBe(doc.querySelectorAll('a').length);
    expect(html).not.toMatch(/href="(?!https?:)/i);
  });

  it('raw HTML is shown as text, not dropped silently', () => {
    const doc = assertInert(render('<b>bold?</b>'));
    expect(doc.body.textContent).toContain('<b>bold?</b>');
    expect(doc.querySelector('b')).toBeNull();
  });

  it('http(s) links survive with rel="noopener noreferrer" and open outside the app', () => {
    const doc = assertInert(render('[site](https://example.com/a?b=1) and [plain](http://example.org)'));
    const links = [...doc.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a?b=1', 'http://example.org']);
    for (const a of links) {
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.getAttribute('target')).toBe('_blank');
    }
  });

  it('non-http links stay literal text; images become their alt text', () => {
    const doc = assertInert(render('[mail](mailto:a@example.com) ![a cat](https://example.com/cat.png)'));
    expect(doc.querySelectorAll('a')).toHaveLength(0);
    expect(doc.body.textContent).toContain('a cat');
    expect(doc.body.textContent).not.toContain('cat.png');
  });

  it('wikilinks in a note are plain text (not resolvable outside a task line); aliases shown', () => {
    const doc = assertInert(render('See [[Projects/Garden/Plan|the plan]] and [[Recipe]] and ![[Embed]].'));
    expect([...doc.querySelectorAll('span.wikilink')].map((s) => s.textContent)).toEqual(['the plan', 'Recipe', 'Embed']);
    expect(doc.querySelectorAll('a')).toHaveLength(0);
  });

  it('ordinary Markdown still renders', () => {
    const doc = assertInert(render('# Title\n\n- one\n- **two**\n\n3. three\n\n> quote\n\n```js\ncode()\n```\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n'));
    expect(doc.querySelector('h1')?.textContent).toBe('Title');
    expect(doc.querySelectorAll('li')).toHaveLength(3);
    expect(doc.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(doc.querySelector('pre code')?.textContent).toBe('code()\n');
    expect(doc.querySelector('td')).not.toBeNull();
  });
});

describe('each layer holds alone', () => {
  it.each(Object.entries(CORPUS))('Markdown layer (raw HTML disabled) emits no live markup: %s', (_name, source) => {
    const html = renderMarkdown(source);
    expect(html).not.toMatch(/<(script|svg|img|iframe|style|math|div|b)\b/i);
    expect(html).not.toMatch(/href="(?!https?:)/i);
  });

  it.each([
    '<script>alert(1)</script><p>x</p>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)></svg>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="data:text/html,x">x</a>',
    '<a href="https://example.com" onclick="alert(1)" style="color:red" target="_self">x</a>',
    '<iframe src="https://evil.example"></iframe>',
    '<p style="background:url(javascript:alert(1))" data-x="1" aria-label="x">p</p>',
    '<form action="https://evil.example"><input name=q></form>',
  ])('sanitiser alone neutralises %j', (html) => {
    const out = sanitize(html);
    assertInert(out);
    expect(out).not.toMatch(/javascript:|data:|onerror|onclick|onload|style=|<iframe|<form|<input/i);
  });
});
