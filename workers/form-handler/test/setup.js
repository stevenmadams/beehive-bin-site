import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

beforeEach(async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'",
  ).all();
  await env.DB.batch([
    env.DB.prepare('PRAGMA defer_foreign_keys = true'),
    ...results.map(({ name }) => env.DB.prepare(`DELETE FROM "${name}"`)),
  ]);
  await env.WORLD.fetch('http://stub/reset');
  await env.ADMIN_STUB.fetch('http://stub/reset');
});
