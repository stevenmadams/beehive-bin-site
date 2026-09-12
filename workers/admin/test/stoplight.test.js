import { describe, it, expect } from 'vitest';
import { ok, request, rental, fleet, weekday } from './helpers.js';

const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const light = async id => (await ok(`/requests/${id}`)).request.fit;
const lights = async () => Object.fromEntries((await ok('/requests?status=new')).requests.map(r => [r.id, r.fit]));

describe('the stoplight on a request', () => {
  it('green when the bins are free with room to spare', async () => {
    await fleet(40);
    const r = await request({ bins: 10, start_date: weekday(3) });
    expect(await light(r.id)).toMatchObject({ light: 'green', fits: true, available: 40, fleet: 40 });
  });

  it('yellow when it fits but would leave the fleet nearly empty', async () => {
    await fleet(40);
    await rental({ bins: 20, weeks: 1, start_date: weekday(3) });
    const r = await request({ bins: 20, start_date: weekday(4), email: 'y@example.com' });   // 20 free, needs 20 → 0 left
    const f = await light(r.id);
    expect(f.light).toBe('yellow');
    expect(f.fits).toBe(true);
    expect(f.available).toBe(20);
    expect(f.tightest_day).toBe(weekday(4));
  });

  it('red when it does not fit, saying by how much and which day', async () => {
    await fleet(40);
    await rental({ bins: 40, weeks: 1, start_date: weekday(3) });
    const r = await request({ bins: 10, start_date: addDays(weekday(3), 8), email: 'r@example.com' });   // turnaround day
    const f = await light(r.id);
    expect(f).toMatchObject({ light: 'red', fits: false, short_by: 10, available: 0 });
    expect(f.tightest_day).toBe(addDays(weekday(3), 8));
  });

  it('grey when there is nothing to judge: no fleet, no dates, or a contact enquiry', async () => {
    const r = await request({ bins: 10, start_date: weekday(3) });
    expect((await light(r.id)).light).toBe('grey');
    await fleet(40);
    const q = await ok('/requests', { method: 'POST', body: { kind: 'contact', first_name: 'Q', email: 'q@example.com', message: 'hi' } });
    expect((await light(q.request.id)).light).toBe('grey');
  });

  it('the list carries a light per row, with one availability lookup for the lot', async () => {
    await fleet(40);
    await rental({ bins: 40, weeks: 1, start_date: weekday(14) });
    const a = await request({ bins: 10, start_date: weekday(3), email: 'a@example.com' });    // done and turned around before the 14th
    const b = await request({ bins: 10, start_date: weekday(14), email: 'b@example.com' });
    const c = await request({ bins: 60, start_date: weekday(30), email: 'c@example.com' });   // nothing else that far out — still 20 more than we own
    const map = await lights();
    expect(map[a.id].light).toBe('green');
    expect(map[b.id].light).toBe('red');
    expect(map[c.id].light).toBe('red');   // more than we own, ever
    expect(map[c.id].short_by).toBe(20);
  });

  it('a converted request is judged against the world without its own rental in it', async () => {
    await fleet(40);
    const r = await rental({ bins: 40, weeks: 1, start_date: weekday(3) });
    const f = (await ok(`/requests/${r.request_id}`)).request.fit;
    expect(f.light).toBe('yellow');   // it fits exactly — because it is the one holding them
  });
});
