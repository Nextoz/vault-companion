import { describe, expect, it } from 'vitest';
import { plainWikilinks, taskSegments } from './text.ts';

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

describe('taskSegments', () => {
  it('numbers links like the kernel and shows aliases', () => {
    expect(taskSegments('Read [[Projects/Plan|the plan]] then [[Recipe#Dough]] now', ['Projects/Plan', 'Recipe'])).toEqual([
      { kind: 'text', text: 'Read ' },
      { kind: 'link', text: 'the plan', linkIndex: 0 },
      { kind: 'text', text: ' then ' },
      { kind: 'link', text: 'Recipe#Dough', linkIndex: 1 },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('empty targets do not consume an index; a link the read does not confirm is plain text', () => {
    expect(taskSegments('[[#Heading]] [[A]] [[B]]', ['A', 'Other'])).toEqual([
      { kind: 'text', text: '#Heading' },
      { kind: 'text', text: ' ' },
      { kind: 'link', text: 'A', linkIndex: 0 },
      { kind: 'text', text: ' ' },
      { kind: 'text', text: 'B' },
    ]);
  });

  it('no links: the text is one segment', () => {
    expect(taskSegments('<b>x</b>', [])).toEqual([{ kind: 'text', text: '<b>x</b>' }]);
  });
});
