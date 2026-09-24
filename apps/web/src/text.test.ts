import { describe, expect, it } from 'vitest';
import { plainWikilinks } from './text.ts';

describe('plainWikilinks', () => {
  it('renders aliases and bare targets as plain text', () => {
    expect(plainWikilinks('Call [[People/Bike shop|the bike shop]] about [[Wheels]]')).toBe(
      'Call the bike shop about Wheels',
    );
  });

  it('leaves markup-looking text untouched (it is rendered as a text node)', () => {
    expect(plainWikilinks('<img src=x onerror=alert(1)> [[a]]')).toBe('<img src=x onerror=alert(1)> a');
  });
});
