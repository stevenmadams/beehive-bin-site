import { describe, it, expect } from 'vitest';
import { api, ok, rental, fleet, today, weekday, sql, OWNER, STAFF } from './helpers.js';

const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = iso => new Date(`${iso}T12:00:00Z`).getUTCDay();
const me = async as => (await ok('/me', { as })).user;

describe('staff availability', () => {
  it('A1 a weekly pattern per person, and one-off changes to it', async () => {
    const o = await me(OWNER);
    // Mon–Sat 5–9pm
    for (const wd of [1, 2, 3, 4, 5, 6]) {
      await ok('/shifts', { method: 'POST', body: { employee_id: o.id, weekday: wd, start: '17:00', end: '21:00' } });
    }
    const { shifts } = await ok('/shifts');
    expect(shifts.filter(s => s.employee_id === o.id && s.weekday != null)).toHaveLength(6);
    // A Wednesday off, and a Sunday on for once.
    const wed = [1, 2, 3, 4, 5, 6, 7].map(n => addDays(today(), n)).find(d => dow(d) === 3);
    const sun = [1, 2, 3, 4, 5, 6, 7].map(n => addDays(today(), n)).find(d => dow(d) === 0);
    await ok('/shifts', { method: 'POST', body: { employee_id: o.id, date: wed, off: true, note: 'Dentist' } });
    await ok('/shifts', { method: 'POST', body: { employee_id: o.id, date: sun, start: '12:00', end: '15:00' } });
    const cov = (await ok(`/coverage?from=${today(1)}&days=7`)).days;
    const onWed = cov.find(d => d.date === wed);
    const onSun = cov.find(d => d.date === sun);
    expect(onWed.staff).toEqual([]);
    expect(onWed.note).toMatch(/Dentist/);
    expect(onSun.staff).toEqual([{ id: o.id, name: 'owner', start: '12:00', end: '15:00' }]);
    const aMon = cov.find(d => dow(d.date) === 1);
    expect(aMon.staff[0]).toMatchObject({ start: '17:00', end: '21:00' });
    expect(aMon.slots.map(s => s.label)).toEqual(['5–6pm', '6–7pm', '7–8pm', '8–9pm']);
  });

  it('A2 staff set their own; only an owner sets someone else\'s', async () => {
    const o = await me(OWNER);
    const s = await me(STAFF);
    expect((await api('/shifts', { method: 'POST', as: STAFF, body: { employee_id: s.id, weekday: 1, start: '17:00', end: '20:00' } })).status).toBe(201);
    expect((await api('/shifts', { method: 'POST', as: STAFF, body: { employee_id: o.id, weekday: 1, start: '17:00', end: '20:00' } })).status).toBe(403);
    const { shifts } = await ok('/shifts');
    expect((await api(`/shifts/${shifts[0].id}`, { method: 'DELETE', as: 'third@beehivebin.co' })).status).toBe(403);
    expect((await api(`/shifts/${shifts[0].id}`, { method: 'DELETE', as: STAFF })).status).toBe(200);
  });

  it('A3 a shift is sane: end after start, real times, a weekday or a date but not both', async () => {
    const o = await me(OWNER);
    const bad = body => api('/shifts', { method: 'POST', body: { employee_id: o.id, ...body } });
    expect((await bad({ weekday: 1, start: '20:00', end: '17:00' })).status).toBe(400);
    expect((await bad({ weekday: 1, start: '5pm', end: '9pm' })).status).toBe(400);
    expect((await bad({ weekday: 7, start: '17:00', end: '21:00' })).status).toBe(400);
    expect((await bad({ weekday: 1, date: today(1), start: '17:00', end: '21:00' })).status).toBe(400);
    expect((await bad({ start: '17:00', end: '21:00' })).status).toBe(400);
  });
});

describe('what that means for a day', () => {
  it('A4 with no shifts at all, every day is covered by the usual window — nothing breaks on day one', async () => {
    const d = (await ok(`/coverage?from=${weekday(3)}&days=1`)).days[0];
    expect(d.configured).toBe(false);
    expect(d.staff).toEqual([]);
    expect(d.slots.length).toBeGreaterThan(0);
    expect(d.slots.every(s => s.free > 0)).toBe(true);
  });

  it('A5 once anyone has a pattern, a day nobody is on has no slots, and the website is told so', async () => {
    const o = await me(OWNER);
    await ok('/shifts', { method: 'POST', body: { employee_id: o.id, weekday: 1, start: '17:00', end: '21:00' } });   // Mondays only
    const cov = (await ok(`/coverage?from=${today(1)}&days=7`)).days;
    const tue = cov.find(d => dow(d.date) === 2);
    expect(tue.configured).toBe(true);
    expect(tue.slots).toEqual([]);
    expect(tue.open).toBe(false);
    expect(cov.find(d => dow(d.date) === 1).open).toBe(true);
  });

  it('A6 two drivers double the room in an hour; booked jobs use it up; a full slot is not offered', async () => {
    await fleet(100);
    const o = await me(OWNER);
    const s = await me(STAFF);
    const mon = [1, 2, 3, 4, 5, 6, 7].map(n => addDays(today(), n)).find(d => dow(d) === 1);
    await ok('/shifts', { method: 'POST', body: { employee_id: o.id, weekday: 1, start: '17:00', end: '19:00' } });
    await ok('/shifts', { method: 'POST', body: { employee_id: s.id, weekday: 1, start: '18:00', end: '19:00' } });
    await ok('/settings', { method: 'PATCH', body: { jobsPerSlot: 2 } });
    let day = (await ok(`/coverage?from=${mon}&days=1`)).days[0];
    expect(day.slots.map(s => [s.label, s.capacity, s.free])).toEqual([['5–6pm', 2, 2], ['6–7pm', 4, 4]]);

    for (let i = 0; i < 3; i++) {
      const r = await rental({ bins: 10, start_date: mon, email: `c${i}@example.com` });
      await ok(`/rentals/${r.id}`, { method: 'PATCH', body: { delivery_slot: '18:00' } });
    }
    day = (await ok(`/coverage?from=${mon}&days=1`)).days[0];
    expect(day.slots.find(s => s.start === '18:00')).toMatchObject({ used: 3, free: 1 });
    const r = await rental({ bins: 10, start_date: mon, email: 'd@example.com' });
    await ok(`/rentals/${r.id}`, { method: 'PATCH', body: { delivery_slot: '18:00' } });
    day = (await ok(`/coverage?from=${mon}&days=1`)).days[0];
    expect(day.slots.find(s => s.start === '18:00').free).toBe(0);
    // Picking the slot writes the window the run sheet orders by.
    expect((await ok(`/rentals/${r.id}`)).rental.delivery_window).toBe('6–7pm');
    // A fifth cannot take it.
    const e = await rental({ bins: 10, start_date: mon, email: 'e@example.com' });
    const full = await api(`/rentals/${e.id}`, { method: 'PATCH', body: { delivery_slot: '18:00' } });
    expect(full.status).toBe(409);
    expect(full.error).toMatch(/full/);
    // Unless done on purpose.
    expect((await api(`/rentals/${e.id}`, { method: 'PATCH', body: { delivery_slot: '18:00', force: true } })).status).toBe(200);
  });

  it('A7 a blackout beats everyone\'s availability; the run sheet says who is on', async () => {
    const o = await me(OWNER);
    for (const wd of [1, 2, 3, 4, 5, 6]) await ok('/shifts', { method: 'POST', body: { employee_id: o.id, weekday: wd, start: '17:00', end: '21:00' } });
    const day = weekday(3);
    await ok('/blackouts', { method: 'POST', body: { date: day, reason: 'Closed' } });
    expect((await ok(`/coverage?from=${day}&days=1`)).days[0].open).toBe(false);
    const sched = (await ok(`/schedule?from=${addDays(day, 1)}&days=1`)).days[0];
    if (dow(sched.date) !== 0) expect(sched.staff.map(s => s.name)).toEqual(['owner']);
  });
});
