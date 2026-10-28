// WebKit (iPhone Safari) does not focus a button when it is tapped or clicked, unlike Chrome and Firefox. Every sheet
// remembers `document.activeElement` as its opener and returns focus there on close; on WebKit that was <body>, so
// focus was lost after closing a sheet. One capture-phase listener focuses the pressed button before React's handlers
// run, for every opener at once, without changing their markup.

/** Focuses the button a click lands on (if not already focused). Returns the uninstall function. */
export function installFocusOnClick(root: Document | HTMLElement): () => void {
  const onClick = (event: Event) => {
    // Duck-typed, not `instanceof Element`: the target may belong to another realm (iframe, test DOM).
    const target = event.target as Partial<Element> | null;
    if (typeof target?.closest !== 'function') return;
    const button = target.closest<HTMLElement>('button:not(:disabled)');
    if (button && button.ownerDocument.activeElement !== button) button.focus({ preventScroll: true });
  };
  root.addEventListener('click', onClick, true);
  return () => root.removeEventListener('click', onClick, true);
}
