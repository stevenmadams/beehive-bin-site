import { describe, it, expect } from 'vitest';
import { ok, rental, fleet, today, sql } from './helpers.js';

const patch = (id, body) => ok(`/rentals/${id}`, { method: 'PATCH', body });
const tonight = async () => (await ok(`/schedule?from=${today()}&days=1`)).days[0];
const wentOut = (id, on) => sql("UPDATE rentals SET delivered_at = ?1 || 'T20:00:00Z', status = 'out' WHERE id = ?2", on, id);

describe('the evening run', () => {
  it('R1/R2 tonight lists collections first, then deliveries — and a collection needs a delivery behind it', async () => {
    await fleet(100);
    const drop = await rental({ bins: 20, start_date: today() });
    const back = await rental({ bins: 40, start_date: today(-7), email: 'b@example.com' });
    await sql('UPDATE rentals SET due_date = ?1 WHERE id = ?2', today(), back.id);
    const ghost = await rental({ bins: 10, start_date: today(-7), email: 'c@example.com' });
    await sql('UPDATE rentals SET due_date = ?1 WHERE id = ?2', today(), ghost.id);
    await wentOut(back.id, today(-7));   // ghost was never delivered

    const day = await tonight();
    expect(day.jobs.map(j => [j.job, j.id])).toEqual([['collect', back.id], ['deliver', drop.id]]);
    expect(day.binsOut).toBe(20);
    expect(day.binsBack).toBe(40);
  });

  it('R3 cancelled rentals never appear', async () => {
    await fleet(40);
    const r = await rental({ bins: 20, start_date: today() });
    await patch(r.id, { status: 'cancelled', reason: 'x' });
    expect((await tonight()).jobs).toHaveLength(0);
  });

  it('R4/R5 each job carries what the driver needs, and says when it is not ready', async () => {
    await fleet(40);
    const r = await rental({ bins: 20, start_date: today(), customer_notes: 'Gate code 4471' });
    await patch(r.id, { delivery_street: '612 N Sycamore Ave', delivery_unit: 'Apt 4', delivery_city: 'Sunset', delivery_zip: '84015' });
    const [job] = (await tonight()).jobs;
    expect(job).toMatchObject({
      job: 'deliver', bins: 20, first_name: 'Dana', phone: '801-555-0100', contact_pref: 'text',
      address: '612 N Sycamore Ave, Apt 4, Sunset UT 84015', unit: 'Apt 4', zip: '84015', city: 'Sunset',
      agreement_signed_at: null, paid_at: null, done_at: null,
    });
    await patch(r.id, { milestone: 'delivered', done: true, force: true, photo_reason: 'x' });
    const [after] = (await tonight()).jobs;
    expect(after.done_at).toBeTruthy();
    expect(after.done_by).toBe('owner@beehivebin.co');
  });

  it('R6 Sundays are flagged, and a week view spans them', async () => {
    const { days } = await ok(`/schedule?from=${today()}&days=7`);
    expect(days).toHaveLength(7);
    expect(days.filter(d => d.sunday)).toHaveLength(1);
    expect(days.find(d => d.sunday).date).toBe(days.find(d => new Date(`${d.date}T12:00:00Z`).getUTCDay() === 0).date);
  });

  it('R7 the run sheet and availability agree on what is in use', async () => {
    await fleet(40);
    const a = await rental({ bins: 20, start_date: today(-2) });
    await wentOut(a.id, today(-2));
    const inv = (await ok(`/inventory?from=${today()}&days=1`)).days[0];
    expect(inv.committed).toBe(20);
    expect(inv.rentals.map(r => r.id)).toEqual([a.id]);
  });
});
