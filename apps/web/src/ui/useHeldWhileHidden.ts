import { useRef } from 'react';

/** PERF-B: a hidden view reacts to a refresh once, when it is shown again. Holds the last value seen while visible. */
export function useHeldWhileHidden<T>(value: T, visible: boolean): T {
  const held = useRef<T>(value);
  if (visible) held.current = value;
  return held.current;
}
