// Payload hash for operation-ID reuse detection: sha256 over RFC 8785 (JCS) canonical JSON of the
// envelope exactly as submitted, before schema defaults (docs/commands.md, review F18).

/** RFC 8785 canonical JSON for the value space of parsed JSON bodies. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    return JSON.stringify(value); // ECMAScript number serialisation is the JCS number form
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    // Default sort compares UTF-16 code units, which is what JCS requires.
    const keys = Object.keys(value).sort();
    const members = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`value not representable in JSON: ${typeof value}`);
}

export async function payloadHash(rawEnvelope: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(rawEnvelope));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
