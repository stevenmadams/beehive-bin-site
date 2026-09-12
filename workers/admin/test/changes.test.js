import { describe, it, expect } from 'vitest';
import { api, ok, rental, fleet, today, weekday, sql, sent, squareCalls, OWNER } from './helpers.js';

const patch = (id, body) => api(`/rentals/${id}`, { method: 'PATCH', body });
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const paid = async (id, on = today()) =>
  sql("UPDATE rentals SET agreement_signed_at = ?1 || 'T10:00:00Z', paid_at = ?1 || 'T10:00:00Z', square_status = 'PAID', status = 'confirmed' WHERE id = ?2", on, id);

describe('C16/S22 cancelling a paid rental', () => {
  it('48 hours or more before delivery: the full amount is owed back', async () => {
    await fleet(40);
    const r = await rental({ bins: 20, weeks: 1, start_date: weekday(5) });
    await paid(r.id);
    const c = await patch(r.id, { status: 'cancelled', reason: 'Move fell through' });
    expect(c.status).toBe(200);
    expect(c.rental.status).toBe('cancelled');
    expect(c.refund).toMatchObject({ percent: 100, cents: 7900, paid_cents: 7900 });
    const h = await ok(`/rentals/${r.id}/history`);
    expect(h.history.find(e => e.action === 'rental.cancelled_after_payment').detail).toMatch(/\$79\.00 \(100%\) to refund in Square/);
  });

  it('under 48 hours: half — and the panel says so before anyone confirms', async () => {
    await fleet(40);
    const r = await rental({ bins: 40, weeks: 1, start_date: today(1) });
    await paid(r.id);
    const preview = await ok(`/rentals/${r.id}/cancel-preview`);
    expect(preview).toMatchObject({ percent: 50, cents: 6450, paid_cents: 12900 });
    expect(preview.hours_before).toBeLessThan(48);
    const c = await patch(r.id, { status: 'cancelled', reason: 'x' });
    expect(c.refund).toMatchObject({ percent: 50, cents: 6450 });
  });

  it('exactly the delivery day counts as under 48 hours; unpaid owes nothing', async () => {
    await fleet(40);
    const r = await rental({ bins: 10, weeks: 1, start_date: today() });
    await paid(r.id);
    expect((await ok(`/rentals/${r.id}/cancel-preview`)).percent).toBe(50);
    const u = await rental({ bins: 10, weeks: 1, start_date: weekday(9), email: 'u@example.com' });
    const p = await ok(`/rentals/${u.id}/cancel-preview`);
    expect(p).toMatchObject({ percent: 100, cents: 0, paid_cents: 0 });
  });
});

describe('S23 rescheduling', () => {
  it('moves the start and due dates together, re-checks the bins, and tells the customer', async () => {
    await fleet(40);
    const r = await rental({ bins: 20, weeks: 2, start_date: weekday(3) });
    const to = addDays(weekday(3), 7);
    const m = await ok(`/rentals/${r.id}/reschedule`, { method: 'POST', body: { start_date: to, reason: 'Closing slipped a week' } });
    expect(m.rental.start_date).toBe(to);
    expect(m.rental.due_date).toBe(addDays(to, 14));
    const h = await ok(`/rentals/${r.id}/history`);
    expect(h.history[0]).toMatchObject({ action: 'rental.reschedule' });
    expect(h.history[0].detail).toContain(`${weekday(3)} → ${to}`);
    const mail = await sent();
    expect(mail.at(-1)).toMatchObject({ kind: 'rescheduled', to: 'dana@example.com', startDate: to });
  });

  it('refuses a date that would overbook, a Sunday, or the past — and anything once the bins are out', async () => {
    await fleet(40);
    const a = await rental({ bins: 40, weeks: 1, start_date: weekday(20) });
    const b = await rental({ bins: 10, weeks: 1, start_date: weekday(3), email: 'b@example.com' });
    const clash = await api(`/rentals/${b.id}/reschedule`, { method: 'POST', body: { start_date: weekday(20) } });
    expect(clash.status).toBe(409);
    expect(clash.error).toMatch(/Only 0 bins are free/);
    // Its own bins do not count against it.
    const same = await ok(`/rentals/${a.id}/reschedule`, { method: 'POST', body: { start_date: addDays(weekday(20), 1) } });
    expect(same.rental.start_date).toBe(addDays(weekday(20), 1));

    let sunday = today(1);
    while (new Date(`${sunday}T12:00:00Z`).getUTCDay() !== 0) sunday = addDays(sunday, 1);
    expect((await api(`/rentals/${b.id}/reschedule`, { method: 'POST', body: { start_date: sunday } })).error).toMatch(/Sunday/);
    expect((await api(`/rentals/${b.id}/reschedule`, { method: 'POST', body: { start_date: today(-1) } })).status).toBe(400);

    await sql("UPDATE rentals SET delivered_at = 'x', status = 'out' WHERE id = ?1", b.id);
    const out = await api(`/rentals/${b.id}/reschedule`, { method: 'POST', body: { start_date: weekday(20) } });
    expect(out.status).toBe(409);
    expect(out.error).toMatch(/already out/);
  });

  it('a signed agreement names the old dates, so rescheduling after signing is flagged, not hidden', async () => {
    await fleet(40);
    const r = await rental({ bins: 20, weeks: 1, start_date: weekday(3) });
    await paid(r.id);
    const m = await ok(`/rentals/${r.id}/reschedule`, { method: 'POST', body: { start_date: weekday(8) } });
    expect(m.rental.start_date).toBe(weekday(8));
    expect(m.note).toMatch(/agreement/i);
    const h = await ok(`/rentals/${r.id}/history`);
    expect(h.history.find(e => e.action === 'rental.reschedule').detail).toMatch(/after signing/);
  });
});

describe('C18 extending', () => {
  it('an extension that would overbook the following customer is refused', async () => {
    await fleet(50);
    const start = today(-3);
    const a = await rental({ bins: 40, weeks: 1, start_date: start });
    await sql("UPDATE rentals SET delivered_at = ?1 || 'T20:00:00Z', status = 'out', agreement_signed_at = 'x', paid_at = 'x' WHERE id = ?2", start, a.id);
    // Someone else has 20 from the day after a's turnaround — leaving 30, not 40.
    await rental({ bins: 20, weeks: 1, start_date: addDays(start, 9), email: 'n@example.com' });
    const ext = await api(`/rentals/${a.id}/extensions`, { method: 'POST', body: { weeks: 1 } });
    expect(ext.status).toBe(409);
    expect(ext.error).toMatch(/Only 30 bins are free on/);
    expect((await ok(`/rentals/${a.id}/extensions`)).extensions).toHaveLength(0);
    // Nothing was sent to Square either.
    expect((await squareCalls()).filter(c => c.path === '/v2/invoices')).toHaveLength(0);
  });

  it('otherwise it invoices the extra weeks and moves the due date', async () => {
    await fleet(40);
    const start = today(-3);
    const a = await rental({ bins: 20, weeks: 1, start_date: start });
    await sql("UPDATE rentals SET delivered_at = ?1 || 'T20:00:00Z', status = 'out', agreement_signed_at = 'x', paid_at = 'x' WHERE id = ?2", start, a.id);
    const ext = await ok(`/rentals/${a.id}/extensions`, { method: 'POST', body: { weeks: 2, reason: 'Still packing' } });
    expect(ext.extensions[0]).toMatchObject({ weeks: 2, amount_cents: 8000, new_due_date: addDays(start, 21) });
    expect((await ok(`/rentals/${a.id}`)).rental.due_date).toBe(addDays(start, 21));
    const order = (await squareCalls()).find(c => c.path === '/v2/orders').body.order;
    expect(order.line_items[0].name).toMatch(/2 extra weeks/);
  });
});
