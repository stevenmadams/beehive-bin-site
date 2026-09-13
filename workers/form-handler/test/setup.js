import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, vi } from 'vitest';

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

/* The clock is a Wednesday morning, every run. A fixture that says "deliver
   today" must mean the same thing on a Sunday as on a Tuesday; tests that
   care about the hour set their own time on top of this. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-16T16:00:00Z'));   // 10am Mountain, Wed 16 Sep 2026
});
afterEach(() => vi.useRealTimers());

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
