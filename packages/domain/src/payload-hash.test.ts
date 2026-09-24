import { describe, expect, it } from 'vitest';
import { canonicalJson, payloadHash } from './payload-hash.ts';

describe('canonicalJson (RFC 8785 subset used by envelopes)', () => {
  it('sorts object keys by UTF-16 code units at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });
  it('orders non-ASCII keys by code unit, not locale', () => {
    // 'é' (U+00E9) sorts after 'z'; '😀' (surrogates D83D…) after 'é'.
    expect(canonicalJson({ '😀': 1, é: 2, z: 3 })).toBe('{"z":3,"é":2,"😀":1}');
  });
  it('keeps string escapes JSON-standard and does not normalise Unicode', () => {
    expect(canonicalJson({ t: 'Café "q"\n' })).toBe('{"t":"Café \\"q\\"\\n"}');
  });
  it('rejects values JSON cannot represent exactly', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson({ u: undefined })).toThrow();
  });
});

describe('payloadHash', () => {
  it('is independent of key order in the submitted body', async () => {
    const a = await payloadHash({ operationId: 'x', type: 'CaptureTask', payload: { text: 't', due: '2026-10-01' } });
    const b = await payloadHash({ payload: { due: '2026-10-01', text: 't' }, type: 'CaptureTask', operationId: 'x' });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('changes when any value changes (a retry with a different payload is detectable)', async () => {
    const a = await payloadHash({ payload: { text: 't' } });
    const b = await payloadHash({ payload: { text: 'u' } });
    expect(a).not.toBe(b);
  });
  it('matches a known SHA-256 vector', async () => {
    // sha256('{"a":1}')
    expect(await payloadHash({ a: 1 })).toBe('sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  });
});
