import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';

/* The public Worker: form submissions, the customer's confirmation flow, and
   Square's webhook. Runs in workerd against a real D1. The admin Worker's
   Billing entrypoint (which holds the Square token) is a stub here; so is
   everything on the internet, so a test can read what would have been sent. */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, '../migrations'));
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: path.join(import.meta.dirname, 'wrangler.toml') },
      miniflare: {
        compatibilityDate: '2026-08-22',
        bindings: {
          TEST_MIGRATIONS: migrations,
          RESEND_API_KEY: 'test-key',
          SQUARE_WEBHOOK_SIGNATURE_KEY: 'test-signing-key',
          SQUARE_WEBHOOK_URL: 'https://api.beehivebin.co/square/webhook',
        },
        outboundService: 'world-stub',
        serviceBindings: { WORLD: 'world-stub', ADMIN_STUB: { name: 'beehive-admin', entrypoint: 'Billing' } },
        workers: [{
          name: 'beehive-admin',
          modules: true,
          scriptPath: path.join(import.meta.dirname, 'test/stub-admin.js'),
          // The same database as the Worker under test — the stub writes the
          // card and payment onto the rental the way the real Billing does.
          d1Databases: { DB: '4dfd9b23-a6a4-40ba-87ee-0e9abc57d828' },
        }, {
          name: 'world-stub',
          modules: true,
          scriptPath: path.join(import.meta.dirname, 'test/stub-world.js'),
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
