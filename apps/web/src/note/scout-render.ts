import MarkdownIt from 'markdown-it';
import type { WindowLike } from 'dompurify';
import { createNoteRenderer } from './render.ts';
import { hasEvenScoutTableRows, hasRegularScoutTableShape } from './scout-table.ts';

const parser = MarkdownIt({ html: false });

/** Only accepts the existing renderer's sanitised HTML. Labels use DOM setters, never HTML interpolation. */
export function labelScoutTables(html: string, document: Document, irregular: Set<number> = new Set()): string {
  const root = document.createElement('div');
  root.innerHTML = html;
  root.querySelectorAll('table').forEach((table, index) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'scout-table-scroll';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', 'Findings table');
    table.replaceWith(wrapper);
    wrapper.append(table);
    const headers = Array.from(table.tHead?.rows[0]?.cells ?? []);
    const rows = Array.from(table.tBodies).flatMap((body) => Array.from(body.rows));
    if (irregular.has(index) || table.tHead?.rows.length !== 1 ||
        !hasRegularScoutTableShape(headers.map((cell) => cell.textContent), rows.map((row) => Array.from(row.cells, (cell) => cell.textContent))) ||
        headers.some((cell) => cell.tagName !== 'TH') ||
        table.querySelector('[colspan], [rowspan], table, tfoot') ||
        rows.some((row) => row.cells.length !== headers.length || Array.from(row.cells).some((cell) => cell.tagName !== 'TD'))) return;
    table.classList.add('scout-table-cards');
    for (const row of rows) Array.from(row.cells).forEach((cell, i) => {
      cell.dataset['label'] = headers[i]!.textContent.trim();
    });
  });
  return root.innerHTML;
}

export function createScoutRenderer(win: WindowLike & { document: Document }) {
  const render = createNoteRenderer(win);
  return (source: string): string => {
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const tables = parser.parse(source, {}).filter((token) => token.type === 'table_open');
    const irregular = new Set<number>();
    tables.forEach((token, index) => {
      if (!token.map) { irregular.add(index); return; }
      if (!hasEvenScoutTableRows(lines, token.map)) irregular.add(index);
    });
    return labelScoutTables(render(source), win.document, irregular);
  };
}
