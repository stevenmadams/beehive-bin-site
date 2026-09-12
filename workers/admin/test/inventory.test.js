import { describe, it, expect } from 'vitest';
import { api, ok, rental, request, fleet, today, weekday, sql } from './helpers.js';

const avail = async (from = today(), days = 1) => (await ok(`/inventory?from=${from}&days=${days}`)).days;
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

describe('the list', () => {
  it('I1 numbering continues across batches', async () => {
    const a = await fleet(40);
    expect([a.first, a.last]).toEqual(['B-001', 'B-040']);
    const b = await ok('/items', { method: 'POST', body: { count: 10 } });
    expect([b.first, b.last]).toEqual(['B-041', 'B-050']);
    expect((await ok('/settings')).fleetTotal).toBe(50);
  });

  it('I2/I3 other equipment has its own kind and prefix; spellings collapse', async () => {
    await fleet(5);
    const d = await ok('/items', { method: 'POST', body: { kind: 'dolly', count: 2 } });
    expect(d.first).toBe('D-001');
    await ok('/items', { method: 'POST', body: { kind: 'Hand Truck', count: 1 } });
    await ok('/items', { method: 'POST', body: { kind: 'hand-truck', count: 1 } });
    await ok('/items', { method: 'POST', body: { kind: 'HAND_TRUCK', count: 1 } });
    const { kinds } = await ok('/items');
    expect(kinds.hand_truck.total).toBe(3);
    expect(Object.keys(kinds).sort()).toEqual(['bin', 'dolly', 'hand_truck']);
    const { items } = await ok('/items?kind=hand_truck');
    expect(items.map(i => i.label)).toEqual(['HT-001', 'HT-002', 'HT-003']);
    // Bins first, always — they are what the business sells.
    expect((await ok('/items')).items[0].kind).toBe('bin');
  });

  it('I4 a damaged bin leaves the fleet at once; a damaged dolly changes nothing bookable', async () => {
    await fleet(10);
    await ok('/items', { method: 'POST', body: { kind: 'dolly', count: 2 } });
    const { items } = await ok('/items');
    const bin = items.find(i => i.kind === 'bin');
    const dolly = items.find(i => i.kind === 'dolly');
    await ok(`/items/${bin.id}`, { method: 'PATCH', body: { condition: 'damaged', notes: 'Cracked lid' } });
    expect((await ok('/settings')).fleetTotal).toBe(9);
    expect((await avail())[0].fleet).toBe(9);
    await ok(`/items/${dolly.id}`, { method: 'PATCH', body: { condition: 'lost' } });
    expect((await ok('/settings')).fleetTotal).toBe(9);
    expect((await ok('/settings')).outOfService).toBe(1);   // bins only
    // Repaired: back in.
    await ok(`/items/${bin.id}`, { method: 'PATCH', body: { condition: 'good' } });
    expect((await ok('/settings')).fleetTotal).toBe(10);
  });

  it('I9 only an owner adds a batch or removes an item; anyone updates condition', async () => {
    await fleet(2);
    const { items } = await ok('/items');
    expect((await api(`/items/${items[0].id}`, { method: 'DELETE', as: 'staff@beehivebin.co' })).status).toBe(403);
    await ok(`/items/${items[0].id}`, { method: 'DELETE' });
    expect((await ok('/items')).items).toHaveLength(1);
  });
});

describe('availability', () => {
  it('I5 a rental holds its bins from start through due date plus turnaround', async () => {
    await fleet(40);
    const start = weekday(3);
    await rental({ bins: 20, weeks: 1, start_date: start });
    const days = await avail(addDays(start, -1), 11);
    const byDate = Object.fromEntries(days.map(d => [d.date, d.available]));
    expect(byDate[addDays(start, -1)]).toBe(40);   // day before: nothing held
    expect(byDate[start]).toBe(20);
    expect(byDate[addDays(start, 7)]).toBe(20);    // due date: still held
    expect(byDate[addDays(start, 8)]).toBe(20);    // turnaround day: still held
    expect(byDate[addDays(start, 9)]).toBe(40);    // free again
  });

  it('I10 turnaround is a setting; 0 means same-night reuse', async () => {
    await fleet(40);
    const start = weekday(3);
    await rental({ bins: 20, weeks: 1, start_date: start });
    await ok('/settings', { method: 'PATCH', body: { turnaroundDays: 0 } });
    const days = await avail(addDays(start, 7), 2);
    expect(days[0].available).toBe(20);   // due date
    expect(days[1].available).toBe(40);   // next day, no turnaround
    await ok('/settings', { method: 'PATCH', body: { turnaroundDays: 3 } });
    expect((await avail(addDays(start, 10), 1))[0].available).toBe(20);
    expect((await avail(addDays(start, 11), 1))[0].available).toBe(40);
  });

  it('I6 an early return releases the bins early', async () => {
    await fleet(40);
    const r = await rental({ bins: 20, weeks: 2, start_date: today(-3) });
    await sql("UPDATE rentals SET delivered_at = ?1 || 'T20:00:00Z', status = 'out' WHERE id = ?2", today(-3), r.id);
    expect((await avail(today(), 1))[0].available).toBe(20);
    await sql("UPDATE rentals SET returned_at = ?1 || 'T20:00:00Z', status = 'back' WHERE id = ?2", today(-1), r.id);
    // Returned yesterday, one day turnaround: today they are on the shelf.
    expect((await avail(today(), 1))[0].available).toBe(20);
    expect((await avail(today(1), 1))[0].available).toBe(40);
  });

  it('I7 a cancelled rental holds nothing', async () => {
    await fleet(40);
    const r = await rental({ bins: 40, weeks: 1, start_date: weekday(3) });
    expect((await avail(weekday(3), 1))[0].available).toBe(0);
    await ok(`/rentals/${r.id}`, { method: 'PATCH', body: { status: 'cancelled', reason: 'moved on' } });
    expect((await avail(weekday(3), 1))[0].available).toBe(40);
  });

  it('S7 approving what will not fit is refused with the tight day, and the override is audited', async () => {
    await fleet(40);
    const start = weekday(3);
    await rental({ bins: 40, weeks: 1, start_date: start });
    // Overlaps the turnaround day of the first rental.
    const req = await request({ bins: 10, weeks: 1, start_date: addDays(start, 8), email: 'x@example.com' });
    const d = await api(`/requests/${req.id}/decision`, { method: 'POST', body: { action: 'approve' } });
    expect(d.status).toBe(409);
    expect(d.error).toContain(`Only 0 bins are free on ${addDays(start, 8)}`);
    expect(d.error).toContain('short by 10');
    // Nothing was created by the refusal.
    expect((await ok('/rentals?status=all')).rentals).toHaveLength(1);

    const forced = await ok(`/requests/${req.id}/decision`, { method: 'POST', body: { action: 'approve', force: true } });
    const h = await ok(`/rentals/${forced.rental_id}/history`);
    expect(h.history.find(e => e.action === 'rental.overbooked').detail).toMatch(/short by 10/);
  });

  it('an empty inventory says so rather than refusing every booking as full', async () => {
    const req = await request();
    const d = await api(`/requests/${req.id}/decision`, { method: 'POST', body: { action: 'approve' } });
    expect(d.status).toBe(409);
    expect(d.error).toMatch(/no bins on the inventory list/);
    const q = await ok(`/availability?start=${weekday(3)}&due=${addDays(weekday(3), 7)}&bins=10`);
    expect(q.fleetUnknown).toBe(true);
  });
});
