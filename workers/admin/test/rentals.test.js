import { describe, it, expect } from 'vitest';
import { api, ok, rental, fleet, today, weekday, sql, sent, photo, OWNER, STAFF } from './helpers.js';

const patch = (id, body, opts) => api(`/rentals/${id}`, { method: 'PATCH', body, ...opts });

describe('starting a rental', () => {
  it('S10 emailing the link mints the token and records the send', async () => {
    await fleet(40);
    const r = await rental();
    const k = await ok(`/rentals/${r.id}/invoice`, { method: 'POST' });
    expect(k.rental.confirm_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(k.rental.confirm_sent_at).toBeTruthy();
    const mail = await sent();
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ kind: 'confirm', to: 'dana@example.com', bins: 20, weeks: 1 });
    expect(mail[0].link).toBe(`https://book.beehivebin.co/${k.rental.confirm_token}`);
    // Resending keeps the same token: the first email is still valid.
    const again = await ok(`/rentals/${r.id}/send`, { method: 'POST' });
    expect(again.rental.confirm_token).toBe(k.rental.confirm_token);
    expect(await sent()).toHaveLength(2);
  });

  it('refuses to start a rental with no email — there is nowhere to send the link', async () => {
    await fleet(40);
    const r = await rental({ email: '', phone: '801-555-0100' });
    const k = await api(`/rentals/${r.id}/invoice`, { method: 'POST' });
    expect(k.status).toBe(400);
    expect(k.error).toMatch(/no email/);
  });
});

describe('agreement and payment', () => {
  it('S11 recording an agreement by hand needs to say how; it is never shown as an e-signature', async () => {
    await fleet(40);
    const r = await rental();
    const bare = await patch(r.id, { milestone: 'agreement', done: true });
    expect(bare.status).toBe(428);
    const ok1 = await patch(r.id, { milestone: 'agreement', done: true, reason: 'Signed the paper copy at the door' });
    expect(ok1.status).toBe(200);
    expect(ok1.rental.agreement_manual).toBe(1);
    expect(ok1.rental.agreement_manual_by).toBe(OWNER);
    expect(ok1.rental.agreement_name).toBeNull();
  });

  it('S12 a customer e-signature cannot be touched from the panel', async () => {
    await fleet(40);
    const r = await rental();
    await sql("UPDATE rentals SET agreement_signed_at = '2026-09-01T10:00:00Z', agreement_name = 'Dana Whitfield', agreement_version = 'v3' WHERE id = ?1", r.id);
    const undo = await patch(r.id, { milestone: 'agreement', done: false });
    expect(undo.status).toBe(409);
    expect(undo.error).toMatch(/Dana Whitfield signed/);
    const redo = await patch(r.id, { milestone: 'agreement', done: true, reason: 'x' });
    expect(redo.status).toBe(409);
  });

  it('S13 a Square-paid invoice cannot be un-paid here', async () => {
    await fleet(40);
    const r = await rental();
    await sql("UPDATE rentals SET paid_at = '2026-09-01T10:00:00Z', square_status = 'PAID' WHERE id = ?1", r.id);
    const undo = await patch(r.id, { milestone: 'paid', done: false });
    expect(undo.status).toBe(409);
    expect(undo.error).toMatch(/Refund it in Square/);
  });

  it('status is derived: signed + paid = confirmed, delivered = out, returned = returned', async () => {
    await fleet(40);
    const r = await rental({ start_date: today() });
    expect(r.status).toBe('pending');
    await patch(r.id, { milestone: 'agreement', done: true, reason: 'paper' });
    expect((await ok(`/rentals/${r.id}`)).rental.status).toBe('pending');
    await patch(r.id, { milestone: 'paid', done: true });
    expect((await ok(`/rentals/${r.id}`)).rental.status).toBe('confirmed');
    await photo(r.id, 'delivery');
    await patch(r.id, { milestone: 'delivered', done: true });
    expect((await ok(`/rentals/${r.id}`)).rental.status).toBe('out');
  });
});

describe('delivery', () => {
  it('S15 delivery is locked before the start date; unlocking is recorded and lets a photo through', async () => {
    await fleet(40);
    const r = await rental({ start_date: weekday(5) });
    const early = await photo(r.id, 'delivery');
    expect(early.status).toBe(423);
    expect(early.error).toMatch(/not due out until/);

    const u = await ok(`/rentals/${r.id}/unlock`, { method: 'POST', body: { step: 'delivered' } });
    expect(u.rental.delivery_unlocked_by).toBe(OWNER);
    expect((await photo(r.id, 'delivery')).status).toBe(201);
    const h = await ok(`/rentals/${r.id}/history`);
    expect(h.history.some(e => e.action === 'rental.delivery_unlocked')).toBe(true);
  });

  it('S14 committing the delivery records who and when, and is allowed unpaid only on purpose', async () => {
    await fleet(40);
    const r = await rental({ start_date: today() });
    await photo(r.id, 'delivery', STAFF);
    const unpaid = await patch(r.id, { milestone: 'delivered', done: true }, { as: STAFF });
    expect(unpaid.status).toBe(409);
    expect(unpaid.error).toMatch(/Deliver anyway/);
    const forced = await patch(r.id, { milestone: 'delivered', done: true, force: true }, { as: STAFF });
    expect(forced.status).toBe(200);
    expect(forced.rental.delivered_by).toBe(STAFF);
    expect(forced.rental.delivered_at).toBeTruthy();
    const h = await ok(`/rentals/${r.id}/history`);
    expect(h.history.find(e => e.action === 'rental.delivered_early').detail).toMatch(/agreement_signed_at, paid_at/);
  });

  it('S18 delivering with no photo needs a reason, which is audited', async () => {
    await fleet(40);
    const r = await rental({ start_date: today() });
    const noPhoto = await patch(r.id, { milestone: 'delivered', done: true, force: true });
    expect(noPhoto.status).toBe(428);
    expect(noPhoto.error).toMatch(/No delivery photo/);
    const withWhy = await patch(r.id, { milestone: 'delivered', done: true, force: true, photo_reason: 'Phone died' });
    expect(withWhy.status).toBe(200);
    const h = await ok(`/rentals/${r.id}/history`);
    expect(h.history.find(e => e.action === 'rental.delivered_no_photo').detail).toBe('Phone died');
  });

  it('S17 photos are frozen once the visit is committed', async () => {
    await fleet(40);
    const r = await rental({ start_date: today() });
    const p = await photo(r.id, 'delivery');
    const id = p.photos[0].id;
    // Staged: the person who took it can remove it.
    expect((await api(`/photos/${id}`, { method: 'DELETE' })).status).toBe(200);
    await photo(r.id, 'delivery');
    const { photos } = await ok(`/rentals/${r.id}/photos`);
    await patch(r.id, { milestone: 'delivered', done: true, force: true });
    const del = await api(`/photos/${photos[0].id}`, { method: 'DELETE' });
    expect(del.status).toBe(409);
    expect(del.error).toMatch(/marked done/);
  });

  it('S19 the delivery address freezes after delivery', async () => {
    await fleet(40);
    const r = await rental({ start_date: today() });
    const a = await patch(r.id, { delivery_street: '612 N Sycamore Ave', delivery_unit: 'Apt 4', delivery_city: 'Sunset', delivery_zip: '84015' });
    expect(a.rental.delivery_address).toBe('612 N Sycamore Ave, Apt 4, Sunset UT 84015');
    await patch(r.id, { milestone: 'delivered', done: true, force: true, photo_reason: 'test' });
    const b = await patch(r.id, { delivery_street: '1 Wrong St' });
    expect(b.status).toBe(409);
    expect(b.error).toMatch(/already been delivered/);
    // The pickup address is still open — the bins have not come back yet.
    const c = await patch(r.id, { pickup_street: '88 W 1200 S', pickup_city: 'Clearfield', pickup_zip: '84015' });
    expect(c.status).toBe(200);
  });
});

describe('return', () => {
  it('S16 nothing comes back before it went out', async () => {
    await fleet(40);
    const r = await rental({ start_date: today() });
    const p = await photo(r.id, 'pickup');
    expect(p.status).toBe(409);
    expect(p.error).toMatch(/not been delivered/);
    const m = await patch(r.id, { milestone: 'returned', done: true, force: true, photo_reason: 'x' });
    expect(m.status).toBe(409);
  });

  it('return is locked before the due date and unlockable, like delivery', async () => {
    await fleet(40);
    const r = await rental({ start_date: today() });
    await patch(r.id, { milestone: 'delivered', done: true, force: true, photo_reason: 'x' });
    expect((await photo(r.id, 'pickup')).status).toBe(423);
    await ok(`/rentals/${r.id}/unlock`, { method: 'POST', body: { step: 'returned' } });
    expect((await photo(r.id, 'pickup')).status).toBe(201);
    const back = await patch(r.id, { milestone: 'returned', done: true, force: true });
    expect(back.status).toBe(200);
    expect(back.rental.status).toBe('returned');
    expect(back.rental.returned_by).toBe(OWNER);
  });
});

describe('cancelling', () => {
  it('S20 a pending rental cancels with a reason, and can be reinstated', async () => {
    await fleet(40);
    const r = await rental();
    expect((await patch(r.id, { status: 'cancelled' })).status).toBe(428);
    const c = await patch(r.id, { status: 'cancelled', reason: 'Move fell through' });
    expect(c.rental.status).toBe('cancelled');
    const back = await patch(r.id, { status: 'pending' });
    expect(back.rental.status).toBe('pending');
  });

  it('S21 not while the bins are out, and not after they are back', async () => {
    await fleet(40);
    const r = await rental({ start_date: today() });
    await patch(r.id, { milestone: 'delivered', done: true, force: true, photo_reason: 'x' });
    const out = await patch(r.id, { status: 'cancelled', reason: 'x' });
    expect(out.status).toBe(409);
    expect(out.error).toMatch(/still out/);
    await ok(`/rentals/${r.id}/unlock`, { method: 'POST', body: { step: 'returned' } });
    await patch(r.id, { milestone: 'returned', done: true, force: true, photo_reason: 'x' });
    const done = await patch(r.id, { status: 'cancelled', reason: 'x' });
    expect(done.status).toBe(409);
    expect(done.error).toMatch(/finished/);
  });

  it('S26/S27 stalled and overdue are flagged and counted', async () => {
    await fleet(60);
    const stalled = await rental();
    await sql('UPDATE rentals SET start_date = ?1 WHERE id = ?2', today(-3), stalled.id);
    const late = await rental({ email: 'b@example.com' });
    await sql("UPDATE rentals SET start_date = ?1, due_date = ?2, delivered_at = ?1 || 'T20:00:00Z', status = 'out' WHERE id = ?3", today(-10), today(-2), late.id);

    const stats = await ok('/stats');
    expect(stats.rentals.stalled).toBe(1);
    expect(stats.rentals.overdue).toBe(1);
    expect((await ok('/rentals?status=stalled')).rentals.map(r => r.id)).toEqual([stalled.id]);
    expect((await ok(`/rentals/${stalled.id}`)).rental.stalled).toBe(1);
  });
});
