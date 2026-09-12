import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { api, ok, rental, fleet, today, sql, OWNER } from './helpers.js';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const upload = async (id, kind, type = 'image/png', body = PNG) => {
  const res = await SELF.fetch(`https://admin.beehivebin.co/api/rentals/${id}/photos?kind=${kind}&caption=front%20porch`, {
    method: 'POST', headers: { 'x-dev-email': OWNER, 'content-type': type }, body,
  });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
};
/* A rental that finished `daysAgo` days ago with one delivery photo. */
async function finished(daysAgo) {
  await fleet(40);
  const r = await rental({ start_date: today() });
  const p = await upload(r.id, 'delivery');
  await sql("UPDATE rentals SET delivered_at = 'x', returned_at = ?1 || 'T20:00:00Z', status = 'back' WHERE id = ?2", today(-daysAgo), r.id);
  return { r, photo: p.photos[0] };
}

describe('photos', () => {
  it('only images, only with bytes, and served back with the right type', async () => {
    await fleet(40);
    const r = await rental({ start_date: today() });
    expect((await upload(r.id, 'delivery', 'text/plain', new TextEncoder().encode('hi'))).status).toBe(400);
    expect((await upload(r.id, 'delivery', 'image/png', new Uint8Array())).status).toBe(400);
    expect((await upload(r.id, 'selfie')).status).toBe(400);
    const p = await upload(r.id, 'delivery');
    expect(p.status).toBe(201);
    expect(p.photos[0]).toMatchObject({ kind: 'delivery', taken_by: OWNER, caption: 'front porch', bytes: PNG.length });
    const img = await SELF.fetch(`https://admin.beehivebin.co/api/photo/${encodeURIComponent(p.photos[0].r2_key)}`, { headers: { 'x-dev-email': OWNER } });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
  });

  it('S30 the sweep removes photos 90 days after the rental ended, and not before', async () => {
    const young = await finished(89);
    const old = await finished(91);
    const res = await ok('/photos/sweep', { method: 'POST' });
    expect(res.deleted).toBe(1);
    expect((await ok(`/rentals/${young.r.id}/photos`)).photos).toHaveLength(1);
    expect((await ok(`/rentals/${old.r.id}/photos`)).photos).toHaveLength(0);
    // Gone from storage too, not just hidden.
    const img = await SELF.fetch(`https://admin.beehivebin.co/api/photo/${encodeURIComponent(old.photo.r2_key)}`, { headers: { 'x-dev-email': OWNER } });
    expect(img.status).toBe(404);
    expect((await ok('/audit')).entries.find(e => e.action === 'photos.swept')).toMatchObject({ actor_email: 'retention', detail: '1 photo(s) past 90 days' });
  });

  it('a dispute hold keeps them past the limit until it is lifted', async () => {
    const { r } = await finished(120);
    await ok(`/rentals/${r.id}/photo-hold`, { method: 'POST', body: { hold: true } });
    expect((await ok('/photos/sweep', { method: 'POST' })).deleted).toBe(0);
    await ok(`/rentals/${r.id}/photo-hold`, { method: 'POST', body: { hold: false } });
    expect((await ok('/photos/sweep', { method: 'POST' })).deleted).toBe(1);
  });

  it('the sweep runs on the cron, without anyone signed in', async () => {
    await finished(100);
    const { createScheduledController, createExecutionContext, waitOnExecutionContext } = await import('cloudflare:test');
    const worker = (await import('../src/index.js')).default;
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '0 9 * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);
    const { count } = await env.DB.prepare('SELECT COUNT(*) AS count FROM rental_photos WHERE deleted_at IS NULL').first();
    expect(count).toBe(0);
  });

  it('only an owner runs the sweep by hand', async () => {
    await ok('/me');   // enrol the owner first, or "staff" would be first through the door
    expect((await api('/photos/sweep', { method: 'POST', as: 'staff@beehivebin.co' })).status).toBe(403);
  });
});
