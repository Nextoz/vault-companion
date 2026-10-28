import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { installFocusOnClick } from './focus-on-click.ts';

// jsdom, like WebKit, does not focus a button on a synthetic click: the listener must do it.
function page() {
  const dom = new JSDOM('<button id="open"><span id="label">Open</span></button><button id="off" disabled>Off</button><p id="text">x</p>');
  const doc = dom.window.document;
  const click = (id: string) => doc.getElementById(id)!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return { doc, click };
}

it('focuses the pressed button, also when the tap lands on its child, before bubbling handlers run', () => {
  const { doc, click } = page();
  installFocusOnClick(doc);
  let focusedInHandler: Element | null = null;
  doc.getElementById('open')!.addEventListener('click', () => { focusedInHandler = doc.activeElement; });
  click('label');
  expect(doc.activeElement?.id).toBe('open');
  expect((focusedInHandler as Element | null)?.id).toBe('open');
});

it('leaves focus alone for non-buttons, disabled buttons and after uninstall', () => {
  const { doc, click } = page();
  const uninstall = installFocusOnClick(doc);
  click('text'); expect(doc.activeElement).toBe(doc.body);
  click('off'); expect(doc.activeElement).toBe(doc.body);
  uninstall(); click('open'); expect(doc.activeElement).toBe(doc.body);
});
