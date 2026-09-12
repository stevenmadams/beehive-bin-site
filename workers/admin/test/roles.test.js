import { describe, it, expect } from 'vitest';
import { api, ok, rental, request, fleet, today, weekday, sql, photo, OWNER, STAFF } from './helpers.js';

const asStaff = (path, opts = {}) => api(path, { ...opts, as: STAFF });
const patch = (id, body, as = STAFF) => api(`/rentals/${id}`, { method: 'PATCH', body, as });

describe('what staff can do', () => {
  it('R1 the evening run: photos, milestones, addresses, windows, counting, damage, notes', async () => {
    await fleet(40);
    const r = await rental({ start_date: today() });
    await ok('/me', { as: STAFF });
    expect((await photo(r.id, 'delivery', STAFF)).status).toBe(201);
    expect((await patch(r.id, { milestone: 'delivered', done: true, force: true })).status).toBe(200);
    expect((await patch(r.id, { pickup_street: '9 Elm', pickup_city: 'Roy', pickup_zip: '84067' })).status).toBe(200);
    expect((await patch(r.id, { pickup_window: '7–8pm' })).status).toBe(200);
    expect((await asStaff(`/rentals/${r.id}/counted`, { method: 'POST', body: { bins_returned: 19 } })).status).toBe(200);
    const { items } = await ok('/items');
    expect((await asStaff(`/items/${items[0].id}`, { method: 'PATCH', body: { condition: 'damaged', rental_id: r.id } })).status).toBe(200);
    expect((await asStaff(`/rentals/${r.id}/notes`, { method: 'POST', body: { body: 'Left by the side gate' } })).status).toBe(201);
    // And they can read what they need.
    expect((await asStaff('/schedule?days=1')).status).toBe(200);
    expect((await asStaff(`/rentals/${r.id}/charges`)).status).toBe(200);
    expect((await asStaff(`/rentals/${r.id}/history`)).status).toBe(200);
    expect((await asStaff('/requests')).status).toBe(200);
  });

  it('R2 takes a booking by phone, but does not approve it — that emails a contract', async () => {
    await fleet(40);
    await ok('/me');
    const req = await asStaff('/requests', { method: 'POST', body: { kind: 'reserve', first_name: 'A', bins: 10, weeks: 1, start_date: weekday(3), delivery_city: 'Clinton', phone: '801' } });
    expect(req.status).toBe(201);
    for (const action of ['approve', 'decline', 'reopen']) {
      const d = await asStaff(`/requests/${req.request.id}/decision`, { method: 'POST', body: { action, reason: 'x' } });
      expect(d.status).toBe(403);
    }
    expect((await ok('/rentals?status=all')).rentals).toHaveLength(0);
  });

  it('R3 nothing that moves money or changes the deal: link, cancel, reschedule, extend, charges', async () => {
    await fleet(40);
    const r = await rental({ start_date: weekday(3) });
    await sql("UPDATE rentals SET due_date = ?1, delivered_at = 'x', status = 'out', agreement_signed_at = 'x', paid_at = 'x', square_card_id = 'c' WHERE id = ?2", today(-3), r.id);
    await ok('/me', { as: STAFF });
    expect((await asStaff(`/rentals/${r.id}/invoice`, { method: 'POST' })).status).toBe(403);
    expect((await asStaff(`/rentals/${r.id}/send`, { method: 'POST' })).status).toBe(403);
    expect((await patch(r.id, { status: 'cancelled', reason: 'x' })).status).toBe(403);
    expect((await asStaff(`/rentals/${r.id}/reschedule`, { method: 'POST', body: { start_date: weekday(9) } })).status).toBe(403);
    expect((await asStaff(`/rentals/${r.id}/extensions`, { method: 'POST', body: { weeks: 1 } })).status).toBe(403);
    expect((await asStaff(`/rentals/${r.id}/charges`, { method: 'POST', body: { kind: 'late', qty: 1, unit_cents: 4000, reason: 'x' } })).status).toBe(403);
    const c = await ok(`/rentals/${r.id}/charges`, { method: 'POST', body: { kind: 'late', qty: 1, unit_cents: 4000, reason: 'x' } });
    expect((await asStaff(`/charges/${c.charges[0].id}/waive`, { method: 'POST', body: { reason: 'x' } })).status).toBe(403);
    expect((await asStaff(`/rentals/${r.id}/charges/invoice`, { method: 'POST' })).status).toBe(403);
    // Nothing changed.
    expect((await ok(`/rentals/${r.id}/charges`)).charges[0].invoiced_at).toBeNull();
  });

  it('R4 sees no staff list and no activity log; sees only their own hours', async () => {
    const o = await ok('/me');
    const s = await ok('/me', { as: STAFF });
    await ok('/shifts', { method: 'POST', body: { employee_id: o.user.id, weekday: 1, start: '17:00', end: '21:00' } });
    await ok('/shifts', { method: 'POST', body: { employee_id: s.user.id, weekday: 2, start: '17:00', end: '21:00' }, as: STAFF });
    expect((await asStaff('/employees')).status).toBe(403);
    expect((await asStaff('/audit')).status).toBe(403);
    const mine = await asStaff('/shifts');
    expect(mine.status).toBe(200);
    expect(mine.shifts.map(x => x.employee_id)).toEqual([s.user.id]);
    expect((await ok('/shifts')).shifts).toHaveLength(2);
    // The role comes back on /me so the panel can draw the right menu.
    expect(s.user.role).toBe('staff');
  });
});

describe('the activity log', () => {
  it('filters by who, when and what; owner only', async () => {
    await fleet(40);
    await ok('/me', { as: STAFF });
    const r = await rental();
    await ok(`/rentals/${r.id}/notes`, { method: 'POST', body: { body: 'x' }, as: STAFF });
    const all = await ok('/audit');
    expect(all.actors).toContain(OWNER);
    const mine = await ok(`/audit?actor=${STAFF}`);
    expect(mine.entries.every(e => e.actor_email === STAFF)).toBe(true);
    const rentalOnly = await ok(`/audit?q=${r.id}&entity=rental`);
    expect(rentalOnly.entries.every(e => e.entity === 'rental')).toBe(true);
    expect((await ok(`/audit?from=${today(1)}`)).entries).toHaveLength(0);
    expect((await api('/audit', { as: STAFF })).status).toBe(403);
  });
});
