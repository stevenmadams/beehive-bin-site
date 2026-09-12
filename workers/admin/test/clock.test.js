import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ok, rental, request, fleet, sql, photo } from './helpers.js';

/* Every scenario here runs at 7:30pm Mountain — the van is out, and UTC has
   already rolled over to tomorrow. Dates are pinned rather than relative so
   the assertions can name them. */
const SEP12_EVENING = new Date('2026-09-13T01:30:00Z');   // 7:30pm MDT, Sat 12 Sep 2026
afterEach(() => vi.useRealTimers());
const evening = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(SEP12_EVENING); };

describe('the business day is Mountain Time, not UTC', () => {
  it('T1 "tonight" at 7:30pm is still tonight', async () => {
    await fleet(40);
    const tonight = await rental({ bins: 20, start_date: '2026-09-12' });
    const tomorrow = await rental({ bins: 10, start_date: '2026-09-14', email: 'b@example.com' });
    evening();
    const { from, days } = await ok('/schedule?days=1');
    expect(from).toBe('2026-09-12');
    expect(days[0].jobs.map(j => j.id)).toEqual([tonight.id]);
    expect(tomorrow.id).not.toBe(tonight.id);
  });

  it('T2 bins due back tonight are not overdue at 7:30pm, and no late fee is proposed', async () => {
    await fleet(40);
    const r = await rental({ bins: 20, weeks: 1, start_date: '2026-09-05' });
    await sql("UPDATE rentals SET due_date = '2026-09-12', delivered_at = '2026-09-05T20:00:00Z', status = 'out' WHERE id = ?1", r.id);
    evening();
    expect((await ok('/stats')).rentals.overdue).toBe(0);
    expect((await ok(`/rentals/${r.id}/charges`)).proposals).toHaveLength(0);
    // ...and it is on tonight's run sheet as a collection.
    expect((await ok('/schedule?days=1')).days[0].jobs.map(j => j.job)).toEqual(['collect']);
  });

  it('T3 a rental starting tomorrow is not stalled or lapsed at 7:30pm tonight', async () => {
    await fleet(40);
    const req = await request({ start_date: '2026-09-14' });
    const r = await rental({ start_date: '2026-09-14', email: 'c@example.com' });
    evening();
    expect((await ok('/stats')).rentals.stalled).toBe(0);
    expect((await ok('/stats')).counts.lapsed).toBe(0);
    expect((await ok('/requests?status=lapsed')).requests).toHaveLength(0);
    expect((await ok(`/rentals/${r.id}`)).rental.stalled).toBe(0);
    expect((await ok(`/requests/${req.id}`)).request.lapsed).toBe(0);
  });

  it('T4 the delivery lock for Monday does not open at 7:30pm Saturday; tonight\'s is open', async () => {
    await fleet(40);
    const tomorrow = await rental({ start_date: '2026-09-14' });
    const tonight = await rental({ start_date: '2026-09-12', email: 'd@example.com' });
    evening();
    const early = await photo(tomorrow.id, 'delivery');
    expect(early.status).toBe(423);
    expect(early.error).toMatch(/not due out until 2026-09-14/);
    expect((await photo(tonight.id, 'delivery')).status).toBe(201);
  });

  it('T5 a phone booking for Monday is accepted at 7:30pm Saturday; rescheduling to it too; Sunday never', async () => {
    await fleet(40);
    const r = await rental({ start_date: '2026-09-15' });
    evening();
    const req = await api('/requests', { method: 'POST', body: { kind: 'reserve', first_name: 'E', bins: 10, weeks: 1, start_date: '2026-09-14', delivery_city: 'Clinton', phone: '801', email: 'e@example.com' } });
    expect(req.status).toBe(201);
    const sunday = await api('/requests', { method: 'POST', body: { kind: 'reserve', first_name: 'E', bins: 10, weeks: 1, start_date: '2026-09-13', delivery_city: 'Clinton', phone: '801' } });
    expect(sunday.error).toMatch(/Sunday/);
    const moved = await api(`/rentals/${r.id}/reschedule`, { method: 'POST', body: { start_date: '2026-09-14' } });
    expect(moved.status).toBe(200);
    expect((await api(`/rentals/${r.id}/reschedule`, { method: 'POST', body: { start_date: '2026-09-11' } })).status).toBe(400);
  });

  it('T6 availability "today" and the late-week count follow the Mountain date', async () => {
    await fleet(40);
    const r = await rental({ bins: 20, weeks: 1, start_date: '2026-09-04' });
    await sql("UPDATE rentals SET due_date = '2026-09-11', delivered_at = '2026-09-04T20:00:00Z', status = 'out' WHERE id = ?1", r.id);
    evening();
    // One day late (12th vs 11th) — one partial week, "1 days over", not two.
    const late = (await ok(`/rentals/${r.id}/charges`)).proposals.find(p => p.kind === 'late');
    expect(late.qty).toBe(1);
    expect(late.note).toMatch(/Currently 1 days? over/);
    expect((await ok('/inventory?days=1')).days[0].date).toBe('2026-09-12');
  });

  it('T7 the 48-hour refund line is measured to the start of the Mountain day', async () => {
    await fleet(40);
    // Delivery Monday 14th. At 7:30pm Sat 12th that is 28.5h away → 50%.
    const r = await rental({ bins: 20, weeks: 1, start_date: '2026-09-14' });
    await sql("UPDATE rentals SET paid_at = 'x', agreement_signed_at = 'x' WHERE id = ?1", r.id);
    evening();
    const p = await ok(`/rentals/${r.id}/cancel-preview`);
    expect(p.percent).toBe(50);
    expect(p.hours_before).toBe(29);
    // Delivery Tuesday 15th: 52.5h → 100%.
    const s = await rental({ bins: 20, weeks: 1, start_date: '2026-09-15', email: 'f@example.com' });
    await sql("UPDATE rentals SET paid_at = 'x' WHERE id = ?1", s.id);
    expect((await ok(`/rentals/${s.id}/cancel-preview`)).percent).toBe(100);
  });
});

describe('collected at 7pm on the due date is on time', () => {
  it('T8 no late week, no settling — the business date of the collection is what counts', async () => {
    await fleet(40);
    const r = await rental({ bins: 20, weeks: 1, start_date: '2026-09-05' });
    await sql("UPDATE rentals SET due_date = '2026-09-12', delivered_at = '2026-09-05T20:00:00Z', status = 'out', agreement_signed_at = 'x', paid_at = 'x' WHERE id = ?1", r.id);
    evening();   // 7:30pm MDT, Sat 12 Sep — 01:30Z on the 13th
    await ok(`/rentals/${r.id}/unlock`, { method: 'POST', body: { step: 'returned' } });
    const back = await ok(`/rentals/${r.id}`, { method: 'PATCH', body: { milestone: 'returned', done: true, force: true, photo_reason: 'x' } });
    expect(back.rental.returned_at).toBe('2026-09-13T01:30:00Z');
    expect(back.rental.returned_on).toBe('2026-09-12');
    expect((await ok(`/rentals/${r.id}/charges`)).proposals.find(p => p.kind === 'late')).toBeUndefined();
    await ok(`/rentals/${r.id}`, { method: 'PATCH', body: { milestone: 'inspected', done: true } });
    expect((await ok(`/rentals/${r.id}`)).rental.phase).toBe('done');
  });
});
