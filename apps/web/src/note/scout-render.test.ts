import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { createScoutRenderer, labelScoutTables } from './scout-render.ts';

const { window } = new JSDOM('');
const render = createScoutRenderer(window as unknown as Parameters<typeof createScoutRenderer>[0]);
const read = (html: string) => new JSDOM(html).window.document;
describe('scout findings cards', () => {
  it('labels every cell and preserves sanitised links and title content', () => {
    const doc = read(render('| Item | Store | Price | Was | Until |\n| --- | --- | --- | --- | --- |\n| [Tea](https://example.com) | Shop | 12 | 20 | Sunday |'));
    expect(doc.querySelectorAll('.scout-table-cards tbody tr')).toHaveLength(1);
    expect(Array.from(doc.querySelectorAll('td'), (cell) => cell.dataset['label'])).toEqual(['Item', 'Store', 'Price', 'Was', 'Until']);
    expect(doc.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(doc.querySelector('td')?.textContent).toBe('Tea');
  });
  it.each([
    '<table><tr><td>No header</td></tr></table>',
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>Only one</td></tr></tbody></table>',
    '<table><thead><tr><th></th></tr></thead><tbody><tr><td>Empty header</td></tr></tbody></table>',
  ])('wraps irregular tables without guessing labels: %s', (html) => {
    const doc = read(labelScoutTables(html, window.document));
    expect(doc.querySelector('.scout-table-scroll > table')).not.toBeNull();
    expect(doc.querySelector('.scout-table-cards')).toBeNull();
  });
  it.each(['| One |', '| One | Two | Three |'])('detects uneven Markdown before parser normalisation: %s', (row) => {
    const doc = read(render(`| A | B |\n| --- | --- |\n${row}`));
    expect(doc.querySelector('.scout-table-scroll > table')).not.toBeNull();
    expect(doc.querySelector('.scout-table-cards')).toBeNull();
  });
  it('uses text-only labels and keeps unsafe HTML and links inert', () => {
    const doc = read(render('| <img src=x onerror=alert(1)> | Link |\n| --- | --- |\n| <script>alert(1)</script> | [bad](javascript:alert(1)) |'));
    expect(doc.querySelector('td')?.dataset['label']).toBe('<img src=x onerror=alert(1)>');
    expect(doc.querySelector('script, img, [onerror], a')).toBeNull();
  });
});
