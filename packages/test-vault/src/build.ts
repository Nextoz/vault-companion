// Fixture builder: every authored LF fixture gets a CRLF twin with identical content otherwise.
import { mkdirSync, writeFileSync } from 'node:fs';
import { FIXTURES_ROOT, listAuthoredFixtures, loadVariant } from './index.ts';

export function toCrlf(lf: string): string {
  if (lf.includes('\r')) throw new Error('authored fixtures must be LF-only');
  return lf.replaceAll('\n', '\r\n');
}

/** Relative path → expected CRLF content, for every authored fixture. */
export function buildCrlfFixtures(): Map<string, string> {
  return new Map(listAuthoredFixtures().map((name) => [name, toCrlf(loadVariant('lf', name))]));
}

export function writeCrlfFixtures(): number {
  const built = buildCrlfFixtures();
  for (const [name, content] of built) {
    const target = new URL(`crlf/${name}`, FIXTURES_ROOT);
    mkdirSync(new URL('.', target), { recursive: true });
    writeFileSync(target, Buffer.from(content, 'utf8'));
  }
  return built.size;
}
