import { expect, it, vi } from 'vitest';
import { coalescedRead } from './coalescedRead.ts';

const deferred = () => {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((res) => (resolve = res));
  return { promise, resolve };
};

it('wakes that fire together share one read', async () => {
  const d = deferred();
  const read = vi.fn(() => d.promise);
  const run = coalescedRead(read);
  const first = run('wake');
  expect(run('wake')).toBe(first);
  expect(run('wake')).toBe(first);
  d.resolve('ok');
  await expect(first).resolves.toBe('ok');
  expect(read).toHaveBeenCalledTimes(1);
});

it('a wake after the shared read finished reads again (no reuse window)', async () => {
  const read = vi.fn(async () => 'ok');
  const run = coalescedRead(read);
  await run('wake');
  await run('wake');
  expect(read).toHaveBeenCalledTimes(2);
});

it('refresh and receipt reads never join a wake read, and a wake never joins them', async () => {
  const d = deferred();
  const read = vi.fn(() => d.promise);
  const run = coalescedRead(read);
  const wake = run('wake');
  const refresh = run('refresh');
  const receipt = run('receipt');
  expect(refresh).not.toBe(wake);
  expect(receipt).not.toBe(wake);
  expect(receipt).not.toBe(refresh);
  d.resolve('ok');
  await Promise.all([wake, refresh, receipt]);
  expect(read).toHaveBeenCalledTimes(3);
  const d2 = deferred();
  read.mockImplementation(() => d2.promise);
  const receipt2 = run('receipt');
  expect(run('wake')).not.toBe(receipt2);
  d2.resolve('ok');
});

it('a failed wake read is released so the next wake retries', async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('ok');
  const run = coalescedRead(read);
  const failed = run('wake');
  expect(run('wake')).toBe(failed);
  await expect(failed).rejects.toThrow('offline');
  await expect(run('wake')).resolves.toBe('ok');
  expect(read).toHaveBeenCalledTimes(2);
});
