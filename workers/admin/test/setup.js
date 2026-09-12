import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/* Every test starts from an empty database. */
beforeEach(async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'",
  ).all();
  // One transaction with foreign keys deferred, so order does not matter.
  await env.DB.batch([
    env.DB.prepare('PRAGMA defer_foreign_keys = true'),
    ...results.map(({ name }) => env.DB.prepare(`DELETE FROM "${name}"`)),
  ]);
  // D1 forbids touching sqlite_sequence directly; AUTOINCREMENT ids simply
  // keep counting across tests, which is fine.
  await env.MAILER.fetch('http://stub/reset');
  await env.SQUARE_STUB.fetch('http://stub/reset');
});
