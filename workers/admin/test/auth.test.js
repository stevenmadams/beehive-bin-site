import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { api, ok, OWNER, STAFF, sql } from './helpers.js';

describe('who can do what', () => {
  it('P1 first domain sign-in is owner, the next is staff', async () => {
    expect((await ok('/me', { as: OWNER })).user.role).toBe('owner');
    expect((await ok('/me', { as: STAFF })).user.role).toBe('staff');
    expect((await ok('/me', { as: 'third@beehivebin.co' })).user.role).toBe('staff');
  });

  it('P2 an outside address must be on the staff list', async () => {
    await ok('/me', { as: OWNER });
    const r = await api('/me', { as: 'helper@gmail.com' });
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/not on the staff list/);

    await ok('/employees', { method: 'POST', body: { email: 'helper@gmail.com', name: 'Helper' } });
    expect((await ok('/me', { as: 'helper@gmail.com' })).user.role).toBe('staff');
  });

  it('P3 a deactivated employee is refused even on the domain', async () => {
    await ok('/me', { as: OWNER });
    const { user } = await ok('/me', { as: STAFF });
    await ok(`/employees/${user.id}`, { method: 'PATCH', body: { active: false } });
    const r = await api('/me', { as: STAFF });
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/revoked/);
  });

  it('P4 staff cannot add employees, add or delete items, or change settings', async () => {
    await ok('/me', { as: OWNER });
    await ok('/me', { as: STAFF });
    expect((await api('/employees', { method: 'POST', as: STAFF, body: { email: 'x@beehivebin.co' } })).status).toBe(403);
    expect((await api('/items', { method: 'POST', as: STAFF, body: { count: 5 } })).status).toBe(403);
    expect((await api('/settings', { method: 'PATCH', as: STAFF, body: { turnaroundDays: 2 } })).status).toBe(403);
    await ok('/items', { method: 'POST', body: { count: 1 } });
    const { items } = await ok('/items');
    expect((await api(`/items/${items[0].id}`, { method: 'DELETE', as: STAFF })).status).toBe(403);
    // ...but can do the day-to-day: mark a bin damaged.
    expect((await api(`/items/${items[0].id}`, { method: 'PATCH', as: STAFF, body: { condition: 'damaged' } })).status).toBe(200);
  });

  it('P5 the last active owner cannot be demoted or deactivated', async () => {
    const { user } = await ok('/me', { as: OWNER });
    const demote = await api(`/employees/${user.id}`, { method: 'PATCH', body: { role: 'staff' } });
    expect(demote.status).toBeGreaterThanOrEqual(400);
    const off = await api(`/employees/${user.id}`, { method: 'PATCH', body: { active: false } });
    expect(off.status).toBeGreaterThanOrEqual(400);
    expect((await ok('/me', { as: OWNER })).user.role).toBe('owner');
  });

  it('P6 a request that came through the edge ignores the dev bypass', async () => {
    const res = await SELF.fetch('https://admin.beehivebin.co/api/me', {
      headers: { 'x-dev-email': OWNER, 'cf-ray': '8a1b2c3d4e5f-SLC' },
    });
    expect(res.status).toBe(401);
  });

  it('serves the panel, not the API, for non-/api paths', async () => {
    const res = await SELF.fetch('https://admin.beehivebin.co/healthz');
    expect(await res.text()).toMatch(/ok/);
  });
});
