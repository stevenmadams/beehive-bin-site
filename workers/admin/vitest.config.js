import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';

/* Runs the admin Worker inside workerd with a real (in-memory) D1 and R2, so a
   test that says "the fleet drops by one" is exercising the same SQL that
   runs in production, not a mock of it. */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, '../migrations'));
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: path.join(import.meta.dirname, 'wrangler.toml') },
      miniflare: {
        // The pool ships its own workerd, which trails the compatibility date
        // in wrangler.toml by a few weeks. Nothing between the two dates
        // changes behaviour this code relies on.
        compatibilityDate: '2026-08-22',
        bindings: {
          TEST_MIGRATIONS: migrations,
          // Same bypass `wrangler dev` uses. No cf-ray header in tests.
          ACCESS_DEV_EMAIL: 'owner@beehivebin.co',
          // Enough for the Square client to try; the calls land on the stub.
          SQUARE_ACCESS_TOKEN: 'test-token',
          SQUARE_ENV: 'sandbox',
          SQUARE_LOCATION_ID: 'LJR9D95SRQSN7',
        },
        // Nothing under test may reach the internet. Every outbound fetch —
        // Square, anything — is answered by the fake.
        outboundService: 'square-stub',
        serviceBindings: { SQUARE_STUB: 'square-stub' },
        // The panel talks to beehive-forms over RPC to send mail. In tests
        // that is a stub that records what would have been sent.
        workers: [{
          name: 'beehive-forms',
          modules: true,
          scriptPath: path.join(import.meta.dirname, 'test/stub-forms.js'),
        }, {
          name: 'square-stub',
          modules: true,
          scriptPath: path.join(import.meta.dirname, 'test/stub-square.js'),
        }],
      },
    })],
    test: {
      root: import.meta.dirname,
      include: ['test/**/*.test.js'],
      setupFiles: ['./test/setup.js'],
    },
  };
});
