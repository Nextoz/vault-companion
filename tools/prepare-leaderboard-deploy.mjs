import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function deploymentConfig(source, namespaceId) {
  if (!/^[a-f0-9]{32}$/i.test(namespaceId ?? '')) throw Error('LEADERBOARD_KV_NAMESPACE_ID must be configured before deployment');
  if (source.includes('"kv_namespaces"')) throw Error('KV configuration already exists; inspect before replacing it');
  const anchor = '"name": "vault-companion",';
  if (source.split(anchor).length !== 2) throw Error('Worker configuration anchor changed');
  return source.replace(anchor, `${anchor}\n  "kv_namespaces": [{ "binding": "LEADERBOARD_KV", "id": "${namespaceId}" }],`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const worker = fileURLToPath(new URL('../apps/worker/', import.meta.url));
  const source = await fs.readFile(path.join(worker, 'wrangler.jsonc'), 'utf8');
  await fs.writeFile(path.join(worker, 'wrangler.leaderboard.jsonc'), deploymentConfig(source, process.env.LEADERBOARD_KV_NAMESPACE_ID), { mode: 0o600 });
  console.log('Prepared private deployment configuration with leaderboard storage.');
}
