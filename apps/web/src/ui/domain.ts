// Redesign R5 (review #10): one hue per domain. A component names its domain (`data-domain`); icons-colour.css maps the
// domain to `--domain-hue`. Green, yellow and red stay status-only, so no domain maps to them.

export const DOMAINS = ['training', 'learning', 'research', 'tasks', 'health', 'weather', 'events', 'markets'] as const;
export type Domain = (typeof DOMAINS)[number];

/** The tokens.css custom property that holds a domain's hue. */
export function domainHue(domain: Domain): string {
  return `--hue-${domain}`;
}

/** The domain a Log view belongs to; Progress spans all of them, so it keeps the neutral accent. */
export const LOG_VIEW_DOMAIN: Readonly<Record<'training' | 'history' | 'health' | 'learning' | 'reading', Domain | null>> = {
  training: 'training',
  history: null,
  health: 'health',
  learning: 'learning',
  reading: 'research',
};
