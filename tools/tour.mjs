// PW1: the `pnpm tour` runner. The web e2e config excludes tour.spec.ts unless VC_TOUR=1, so this script sets it for
// the build and the tour run. Kept in Node (rather than a `VAR=1` shell prefix) so it works on Windows and POSIX.
import { spawnSync } from 'node:child_process';

const env = { ...process.env, VC_TOUR: '1' };
const commands = [
  'pnpm --filter @vault-companion/web exec vite build',
  'pnpm --filter @vault-companion/web exec playwright test tour.spec.ts --project=iphone-15-webkit',
];
for (const command of commands) {
  const result = spawnSync(command, { stdio: 'inherit', shell: true, env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
