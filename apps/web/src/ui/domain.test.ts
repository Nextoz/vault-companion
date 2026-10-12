import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOG_VIEWS } from '../log-view.ts';
import { DOMAINS, LOG_VIEW_DOMAIN, domainHue } from './domain.ts';

const tokens = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8');
const css = readFileSync(new URL('../icons-colour.css', import.meta.url), 'utf8');

describe('domain hues', () => {
  it('every domain has a --hue token in tokens.css and a data-domain rule in icons-colour.css', () => {
    for (const domain of DOMAINS) {
      expect(tokens, domain).toContain(`${domainHue(domain)}:`);
      expect(css, domain).toContain(`[data-domain='${domain}'] { --domain-hue: var(${domainHue(domain)}); }`);
    }
  });
  it('maps names to their token', () => {
    expect(domainHue('training')).toBe('--hue-training');
    expect(domainHue('research')).toBe('--hue-research');
  });
  it('gives every Log view a domain or none, never an unknown one', () => {
    expect(Object.keys(LOG_VIEW_DOMAIN).sort()).toEqual([...LOG_VIEWS].sort());
    for (const domain of Object.values(LOG_VIEW_DOMAIN)) if (domain !== null) expect(DOMAINS).toContain(domain);
    expect(LOG_VIEW_DOMAIN.reading).toBe('research');
  });
});
