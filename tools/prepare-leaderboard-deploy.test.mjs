import { describe, expect, it } from 'vitest';
import { deploymentConfig } from './prepare-leaderboard-deploy.mjs';

describe('leaderboard deployment configuration', () => {
  const source = '{ "name": "vault-companion", "workers_dev": false, "assets": { "directory": "../web/dist" } }';
  it('adds the private binding while preserving the origin and asset settings', () => {
    const value = JSON.parse(deploymentConfig(source, 'a'.repeat(32)));
    expect(value.kv_namespaces).toEqual([{ binding: 'LEADERBOARD_KV', id: 'a'.repeat(32) }]);
    expect(value.workers_dev).toBe(false);
    expect(value.assets.directory).toBe('../web/dist');
  });
  it.each([undefined, '', 'bad-id', 'a'.repeat(31), 'x'.repeat(32)])('refuses absent or invalid namespace %s', id => {
    expect(() => deploymentConfig(source, id)).toThrow('LEADERBOARD_KV_NAMESPACE_ID');
  });
  it('refuses changed or preexisting bindings instead of silently deploying without storage', () => {
    expect(() => deploymentConfig('{}', 'a'.repeat(32))).toThrow('anchor');
    expect(() => deploymentConfig(source + '"kv_namespaces"', 'a'.repeat(32))).toThrow('already exists');
  });
});
