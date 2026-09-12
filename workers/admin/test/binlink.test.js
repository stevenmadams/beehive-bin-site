import { describe, it, expect } from 'vitest';
import { api, ok, rental, fleet, today, weekday, sql, photo, OWNER, STAFF } from './helpers.js';

const patch = (id, body, as = OWNER) => api(`/rentals/${id}`, { method: 'PATCH', body, as });
const onRental = id => ok(`/rentals/${id}/items`);
const deliver = id => patch(id, { milestone: 'delivered', done: true, force: true, photo_reason: 'test' });
const unlockReturn = id => ok(`/rentals/${id}/unlock`, { method: 'POST', body: { step: 'returned' } });
const back = id => patch(id, { milestone: 'returned', done: true, force: true, photo_reason: 'test' });
const inspected = id => patch(id, { milestone: 'inspected', done: true });

describe('which bins are on a rental', () => {
  it('B1 bins are assigned by label, or auto-picked from the free ones, up to the package size', async () => {
    await fleet(40);
    const r = await rental({ bins: 10, start_date: today() });
    expect((await onRental(r.id)).items).toEqual([]);
    const a = await ok(`/rentals/${r.id}/items`, { method: 'POST', body: { labels: ['B-003', 'B-007'] } });
    expect(a.items.map(i => i.label)).toEqual(['B-003', 'B-007']);
    const auto = await ok(`/rentals/${r.id}/items`, { method: 'POST', body: { auto: true } });
    expect(auto.items).toHaveLength(10);
    // Filled from the lowest free numbers, skipping the two already on.
    expect(auto.items.map(i => i.label)).toEqual(['B-001', 'B-002', 'B-003', 'B-004', 'B-005', 'B-006', 'B-007', 'B-008', 'B-009', 'B-010']);
    const over = await api(`/rentals/${r.id}/items`, { method: 'POST', body: { labels: ['B-011'] } });
    expect(over.status).toBe(409);
    expect(over.error).toMatch(/already has 10/);
    await ok(`/rentals/${r.id}/items/${auto.items[0].id}`, { method: 'DELETE' });
    expect((await onRental(r.id)).items).toHaveLength(9);
  });

  it('B2 a bin cannot be on two live rentals, and a damaged or unknown bin cannot go out', async () => {
    await fleet(30);
    const a = await rental({ bins: 10, start_date: today() });
    const b = await rental({ bins: 10, start_date: today(), email: 'b@example.com' });
    await ok(`/rentals/${a.id}/items`, { method: 'POST', body: { labels: ['B-001'] } });
    const clash = await api(`/rentals/${b.id}/items`, { method: 'POST', body: { labels: ['B-001'] } });
    expect(clash.status).toBe(409);
    expect(clash.error).toMatch(/B-001 is on rental #\d+ \(Dana Whitfield\)/);
    const { items } = await ok('/items');
    await ok(`/items/${items[1].id}`, { method: 'PATCH', body: { condition: 'damaged' } });
    expect((await api(`/rentals/${b.id}/items`, { method: 'POST', body: { labels: ['B-002'] } })).error).toMatch(/damaged/);
    expect((await api(`/rentals/${b.id}/items`, { method: 'POST', body: { labels: ['B-999'] } })).error).toMatch(/No item labelled B-999/);
    // Once a is back AND inspected, B-001 is free again — back in the van is not back on the shelf.
    await deliver(a.id); await unlockReturn(a.id); await back(a.id);
    expect((await api(`/rentals/${b.id}/items`, { method: 'POST', body: { labels: ['B-001'] } })).status).toBe(409);
    await inspected(a.id);
    expect((await api(`/rentals/${b.id}/items`, { method: 'POST', body: { labels: ['B-001'] } })).status).toBe(201);
  });

  it('B3 delivering with nothing assigned auto-assigns the free bins, and inventory says where each one is', async () => {
    await fleet(40);
    const r = await rental({ bins: 20, start_date: today() });
    await deliver(r.id);
    const { items } = await onRental(r.id);
    expect(items).toHaveLength(20);
    const inv = (await ok('/items')).items;
    expect(inv.find(i => i.label === 'B-001').out_with).toMatchObject({ rental_id: r.id, name: 'Dana Whitfield' });
    expect(inv.find(i => i.label === 'B-021').out_with).toBeNull();
    expect((await ok('/items?where=out')).items).toHaveLength(20);
    expect((await ok('/items?where=in')).items).toHaveLength(20);
    const h = await ok(`/rentals/${r.id}/history`);
    expect(h.history.find(e => e.action === 'rental.bins_assigned').detail).toMatch(/20 bins.*B-001–B-020/);
  });

  it('B4 the inspection: ticked came back fine, a flagged issue is damage or loss with a note — count, charges and fleet all follow', async () => {
    await fleet(40);
    const r = await rental({ bins: 10, start_date: today() });
    await deliver(r.id);
    await sql("UPDATE rentals SET due_date = ?1 WHERE id = ?2", today(), r.id);
    await back(r.id);
    const { items } = await onRental(r.id);
    const res = await ok(`/rentals/${r.id}/items/inspect`, { method: 'POST', body: { items: [
      ...items.map(i => ({ id: i.id, back: true })).filter((_, n) => n !== 1 && n !== 3),
      { id: items[1].id, back: true, condition: 'damaged', note: 'Tape residue' },
      { id: items[3].id, back: false },
    ]}});
    expect(res.back).toBe(9);
    expect(res.missing.map(i => i.label)).toEqual(['B-004']);
    expect(res.damaged.map(i => i.label)).toEqual(['B-002']);
    expect((await ok(`/rentals/${r.id}`)).rental.bins_returned).toBe(9);
    // Inventory reflects it without anyone visiting the Inventory tab.
    const inv = (await ok('/items')).items;
    expect(inv.find(i => i.label === 'B-004')).toMatchObject({ condition: 'lost', flagged_rental_id: r.id });
    expect(inv.find(i => i.label === 'B-002')).toMatchObject({ condition: 'damaged', flagged_rental_id: r.id, notes: 'Tape residue' });
    expect((await ok('/settings')).fleetTotal).toBe(38);   // one lost, one damaged
    // And the charges panel proposes exactly what happened — no nag.
    await inspected(r.id);
    expect((await onRental(r.id)).items.find(i => i.label === 'B-004').back_condition).toBe('lost');   // the flag stands
    const { proposals } = await ok(`/rentals/${r.id}/charges`);
    expect(proposals.find(p => p.kind === 'missing')).toMatchObject({ qty: 1, bin_labels: 'B-004' });
    expect(proposals.find(p => p.kind === 'damage')).toMatchObject({ qty: 1, bin_labels: 'B-002' });
    expect(proposals.find(p => p.blocked)).toBeUndefined();
  });

  it('B5 a lost bin that turns up: tick it back and it is good again, the count corrects, the fleet recovers', async () => {
    await fleet(20);
    const r = await rental({ bins: 10, start_date: today() });
    await deliver(r.id);
    await sql("UPDATE rentals SET returned_at = 'x', status = 'returned' WHERE id = ?1", r.id);
    const { items } = await onRental(r.id);
    const all = items.map(i => ({ id: i.id, back: true }));
    await ok(`/rentals/${r.id}/items/inspect`, { method: 'POST', body: { items: [...all.slice(0, 9), { id: items[9].id, back: false }] } });
    expect((await ok('/settings')).fleetTotal).toBe(19);
    expect((await ok(`/rentals/${r.id}`)).rental.bins_returned).toBe(9);
    await ok(`/rentals/${r.id}/items/inspect`, { method: 'POST', body: { items: all } });
    expect((await ok('/settings')).fleetTotal).toBe(20);
    expect((await ok(`/rentals/${r.id}`)).rental.bins_returned).toBe(10);
    expect((await ok('/items')).items.find(i => i.label === 'B-010').condition).toBe('good');
  });

  it('B6 inspection is its own step after the bins are back; ticking it with the list untouched means all came back fine', async () => {
    await fleet(10);
    const r = await rental({ bins: 10, start_date: today() });
    await deliver(r.id);
    // Not before they are back.
    expect((await inspected(r.id)).status).toBe(409);
    await unlockReturn(r.id); await back(r.id);
    // Back but not yet inspected: still out with the rental as far as the shelf is concerned.
    expect((await ok('/items?where=out')).items).toHaveLength(10);
    expect((await ok('/stats')).rentals.to_inspect).toBe(1);
    const done = await inspected(r.id);
    expect(done.status).toBe(200);
    expect(done.rental.inspected_by).toBe(OWNER);
    const { items } = await onRental(r.id);
    expect(items.every(i => i.back_at && i.back_condition === 'good')).toBe(true);
    expect((await ok(`/rentals/${r.id}`)).rental.bins_returned).toBe(10);
    expect((await ok('/items?where=out')).items).toHaveLength(0);
    expect((await ok('/stats')).rentals.to_inspect).toBe(0);
  });

  it('B7 staff do all of this; nobody assigns to a cancelled or finished rental', async () => {
    await fleet(20);
    await ok('/me');
    const r = await rental({ bins: 10, start_date: today() });
    expect((await api(`/rentals/${r.id}/items`, { method: 'POST', as: STAFF, body: { auto: true } })).status).toBe(201);
    await patch(r.id, { status: 'cancelled', reason: 'x' });
    expect((await api(`/rentals/${r.id}/items`, { method: 'POST', body: { labels: ['B-015'] } })).status).toBe(409);
    // Cancelling released them.
    expect((await ok('/items?where=out')).items).toHaveLength(0);
  });
});
