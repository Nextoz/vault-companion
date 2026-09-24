// Fixture integrity: CRLF twins are in sync with the LF sources, and the family has the shapes
// docs/testing.md#fixture-requirements demands (a fixture silently losing a shape would weaken the golden tests).
import { describe, expect, it } from 'vitest';
import { buildCrlfFixtures } from './build.ts';
import { listAuthoredFixtures, loadFixture, loadVariant } from './index.ts';

describe('fixture family', () => {
  it('every committed crlf/ file equals the builder output (run `pnpm --filter @vault-companion/test-vault fixtures`)', () => {
    const built = buildCrlfFixtures();
    expect(built.size).toBeGreaterThan(10);
    for (const [name, content] of built) expect(loadFixture(`crlf/${name}`)).toBe(content);
  });

  it('LF sources contain no CR; CRLF twins contain no bare LF', () => {
    for (const name of listAuthoredFixtures()) {
      expect(loadVariant('lf', name)).not.toContain('\r');
      expect(/(^|[^\r])\n/.test(loadVariant('crlf', name))).toBe(false);
    }
  });

  it('the To-Do List fixture has every required shape', () => {
    const t = loadVariant('lf', 'todo-list.md');
    const required = [
      /^---\ntitle: [^\n]+\naliases:\n {2}- /, // frontmatter with lists
      /\n\nThis note is the one list/, // prose before the first heading
      /\n```tasks\n[^`]*- \[ \] [^`]*\n```\n/, // fenced tasks block with a task-looking line
      /`- \[ \] Something #todo/, // inline-code task example
      /\n~~~\n- \[ \][^~]*## Open\n~~~\n/, // ~~~ fence hiding a heading
      /\n%%\n- \[ \][^%]*## Done\n%%\n/, // %% comment hiding a heading
      /\n<!--\n- \[ \][^>]*## Open\n-->\n/, // HTML comment hiding a heading
      /\n## Open\n\n- \[ \][^\n]*\n[^\n]*\n[^\n]*\n\n- \[ \]/, // blank-line separated groups in Open
      /\n- \[x\] Return the library books[^\n]*✅ 2026-09-05\n/, // completed line inside Open
      /\n_Completed and cancelled items move here, newest first\. Trim to ~20\._\n/, // italic note in Done
      /❌ 2026-09-22 afløst af nyt\n/, // ❌ date reason
      /✅ 2026-09-19 \(took two tries\)\n/, // ✅ date (trailing text)
      /Mid ❌ 2026-09-17 /, // mid-line ❌
      /\n\| due \| 📅 \|/, // table with emoji
      /\[\[Projects\/Summer Trip\|the trip plan\]\]/, // wikilink with alias
      /æ.*ø.*å|rugbrød/, // Danish
      /🥐/, // 4-byte emoji in a description
      /\n(- \[ \] Sort the receipts #todo ➕ 2026-09-04\n){2}/, // duplicate identical lines
      /\n- \[ \] Draft the garden plan[^\n]*\n {4}- [^\n]*\n {4}- [^\n]*\n\n {4}- /, // children + blank inside block
      /🔁 every week/, // recurring
      /🆔 park01/, // id
      /🔺 📅 2026-10-01 ⏳ 2026-09-28 🛫 2026-09-26 ➕/, // varied field order
      /⏫\uFE0F/, // priority with U+FE0F
      / \^dentist\n/, // block id
    ];
    for (const re of required) expect(t).toMatch(re);
  });

  it('no-final-newline fixtures really end without an EOL', () => {
    for (const name of ['todo-done-last.md', 'todo-open-last.md']) {
      expect(loadVariant('lf', name).endsWith('\n')).toBe(false);
      expect(loadVariant('crlf', name).endsWith('\n')).toBe(false);
    }
  });
});
