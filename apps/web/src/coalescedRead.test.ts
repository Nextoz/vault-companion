import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { coalescedRead } from './coalescedRead.ts';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('shares a slow read, then measures the wake cooldown from completion', async () => {
  const read = vi.fn(() => new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 2000)));
  const run = coalescedRead(read);
  const first = run('wake');
  expect(run('wake')).toBe(first);
  expect(run('refresh')).toBe(first);
  await vi.advanceTimersByTimeAsync(2000);
  await first;
  await vi.advanceTimersByTimeAsync(999);
  expect(run('wake')).toBe(first);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  const next = run('wake');
  expect(next).not.toBe(first);
  await vi.advanceTimersByTimeAsync(2000);
  await next;
  expect(read).toHaveBeenCalledTimes(2);
});

it('refresh and receipts bypass cooldown; a receipt cannot join a pre-save read', async () => {
  const read = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
  const run = coalescedRead(read);
  const initial = run('wake');
  await vi.advanceTimersByTimeAsync(10);
  await initial;
  const refresh = run();
  expect(run('wake')).toBe(refresh);
  const receipt = run('receipt');
  expect(receipt).not.toBe(refresh);
  expect(run('wake')).toBe(receipt);
  await vi.advanceTimersByTimeAsync(10);
  await Promise.all([refresh, receipt]);
  const saved = run('receipt');
  expect(run('wake')).toBe(saved);
  await vi.advanceTimersByTimeAsync(10);
  await saved;
  expect(read).toHaveBeenCalledTimes(4);
});

it('releases rejected flights and keeps read kinds independent', async () => {
  const session = coalescedRead(vi.fn().mockRejectedValue(new Error('offline')));
  const tasks = coalescedRead(vi.fn().mockResolvedValue('tasks'));
  const failed = session('wake');
  expect(session('wake')).toBe(failed);
  await expect(failed).rejects.toThrow('offline');
  await expect(tasks('wake')).resolves.toBe('tasks');
  expect(session('wake')).toBe(failed);
  await vi.advanceTimersByTimeAsync(1000);
  const retry = session('wake');
  expect(retry).not.toBe(failed);
  await expect(retry).rejects.toThrow('offline');
});
