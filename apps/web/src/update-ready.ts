// Retain early service-worker announcements until React subscribes.
let ready = false;
const listeners = new Set<() => void>();
export const getUpdateReady = () => ready;
export function announceUpdateReady() {
  ready = true;
  for (const listener of listeners) listener();
}
export function subscribeUpdateReady(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
