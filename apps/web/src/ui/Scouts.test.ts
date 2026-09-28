import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { ScoutTime } from './ScoutTime.tsx';

it('primary time text is friendly, with exact Copenhagen date and offset only in the title', () => {
  for (const [at, title] of [
    ['2026-10-25T00:00:00Z', '25 Oct 2026 02:00 (GMT+2, Europe/Copenhagen)'],
    ['2026-10-25T01:00:00Z', '25 Oct 2026 02:00 (GMT+1, Europe/Copenhagen)'],
  ]) {
    const html = renderToStaticMarkup(createElement(ScoutTime, { at: at!, now: '2026-10-25T03:00:00Z' }));
    const time = new JSDOM(html).window.document.querySelector('time')!;
    expect(time.textContent).toBe('Today 02:00');
    expect(time.textContent).not.toContain(at);
    expect(time.title).toBe(title);
  }
});
