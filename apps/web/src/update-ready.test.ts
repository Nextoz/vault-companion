import { expect, it, vi } from 'vitest';

it('retains readiness before subscription and notifies mounted subscribers', async () => {
  vi.resetModules();
  const { announceUpdateReady, getUpdateReady, subscribeUpdateReady } = await import('./update-ready.ts');
  expect(getUpdateReady()).toBe(false);
  announceUpdateReady(); // registration resolves before App mounts
  const listener = vi.fn();
  const unsubscribe = subscribeUpdateReady(listener);
  expect(getUpdateReady()).toBe(true);
  announceUpdateReady();
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
  announceUpdateReady();
  expect(listener).toHaveBeenCalledOnce();
});
