// ADR-0067: the pure game engine as its own entry point (`@vault-companion/domain/game`), so the phone can predict
// XP without importing the rest of the domain (stores, commands, GitHub-shaped code).
export * from './types.ts';
export * from './config.ts';
export * from './catalogue.ts';
export * from './engine.ts';
export * from './describe.ts';
export * from './step-milestones.ts';
export * from './wire.ts';
