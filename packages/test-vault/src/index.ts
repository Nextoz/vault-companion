// Synthetic vault fixtures (docs/testing.md#fixture-requirements). All text is invented.
// `fixtures/lf/**` is authored; `fixtures/crlf/**` is generated from it by `pnpm --filter @vault-companion/test-vault fixtures`.
import { readdirSync, readFileSync } from 'node:fs';

export const FIXTURES_ROOT = new URL('../fixtures/', import.meta.url);

export type FixtureEol = 'lf' | 'crlf';
export const FIXTURE_EOLS: readonly FixtureEol[] = ['lf', 'crlf'];

// Byte-exact: invalid UTF-8 throws, a BOM stays in the string.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Read a fixture by path relative to `fixtures/`, e.g. `lf/todo-list.md` or `crlf/expected/complete-water.md`. */
export function loadFixture(name: string): string {
  return decoder.decode(readFileSync(new URL(name, FIXTURES_ROOT)));
}

/** Read the `lf` or `crlf` variant of an authored fixture, e.g. `loadVariant('crlf', 'todo-list.md')`. */
export function loadVariant(eol: FixtureEol, name: string): string {
  return loadFixture(`${eol}/${name}`);
}

/** Relative paths (with `/`) of every authored `.md` fixture under `fixtures/lf/`. */
export function listAuthoredFixtures(): string[] {
  return readdirSync(new URL('lf/', FIXTURES_ROOT), { recursive: true, encoding: 'utf8' })
    .map((p) => p.replaceAll('\\', '/'))
    .filter((p) => p.endsWith('.md'))
    .sort();
}
