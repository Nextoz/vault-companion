import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { postCommand } from './api.ts';
import { openPendingStore } from './queue/db.ts';
import { PendingQueue } from './queue/queue.ts';
import { App } from './ui/App.tsx';
import './styles.css';

async function start() {
  const root = createRoot(document.getElementById('root') as HTMLElement);
  // Ask the browser to keep the queue through storage pressure; the UI says "kept on this device while possible".
  void navigator.storage?.persist?.().catch(() => false);

  const receipts = new EventTarget();
  const queue = await PendingQueue.open({
    store: await openPendingStore(),
    send: postCommand,
    onReceipt: () => receipts.dispatchEvent(new Event('receipt')),
  });

  root.render(
    <StrictMode>
      <App queue={queue} receipts={receipts} />
    </StrictMode>,
  );

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }
}

start().catch(() => {
  // Without IndexedDB the queue cannot keep actions safely; say so instead of pretending.
  const root = document.getElementById('root');
  if (root) root.textContent = 'This browser is blocking on-device storage, so actions cannot be kept safely.';
});
