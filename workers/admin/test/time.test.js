import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ok, rental, request, fleet, sql, sent, today, weekday } from './helpers.js';

afterEach(() => vi.useRealTimers());
const at = iso => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(iso)); };
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

describe('delivery and pickup windows', () => {
  it('a window is set per rental, defaults from settings, and shows on the run sheet in window order', async () => {
    await fleet(60);
    expect((await ok('/settings')).defaultWindow).toBe('6–8pm');
    await ok('/settings', { method: 'PATCH', body: { defaultWindow: '5–7pm' } });
    const late = await rental({ bins: 10, start_date: today() });
    const early = await rental({ bins: 20, start_date: today(), email: 'e@example.com' });
    expect(late.delivery_window).toBe('5–7pm');   // the default at the time it was made
    await ok(`/rentals/${early.id}`, { method: 'PATCH', body: { delivery_window: '4–5pm', pickup_window: 'Before 6pm' } });
    await ok(`/rentals/${late.id}`, { method: 'PATCH', body: { delivery_window: '7–8pm' } });
    const [a, b] = (await ok('/schedule?days=1')).days[0].jobs;
    expect([a.id, a.window]).toEqual([early.id, '4–5pm']);
    expect([b.id, b.window]).toEqual([late.id, '7–8pm']);
    // The window survives into what the customer is told.
    const r = (await ok(`/rentals/${early.id}`)).rental;
    expect(r.pickup_window).toBe('Before 6pm');
  });

  it('a window is short text — not a novel', async () => {
    await fleet(10);
    const r = await rental({ bins: 10 });
    expect((await api(`/rentals/${r.id}`, { method: 'PATCH', body: { delivery_window: 'x'.repeat(41) } })).status).toBe(400);
  });
});

describe('blackout dates', () => {
  it('an owner blocks a day; bookings, approvals and reschedules onto it are refused; the run sheet flags it', async () => {
    await fleet(40);
    const day = weekday(5);
    await ok('/blackouts', { method: 'POST', body: { date: day, reason: 'Thanksgiving' } });
    expect((await ok('/blackouts')).blackouts).toEqual([{ date: day, reason: 'Thanksgiving', created_by: 'owner@beehivebin.co' }]);
    const req = await api('/requests', { method: 'POST', body: { kind: 'reserve', first_name: 'A', bins: 10, weeks: 1, start_date: day, delivery_city: 'Clinton', phone: '801' } });
    expect(req.error).toMatch(/Thanksgiving/);
    const r = await rental({ bins: 10, start_date: weekday(3) });
    expect((await api(`/rentals/${r.id}/reschedule`, { method: 'POST', body: { start_date: day } })).error).toMatch(/Thanksgiving/);
    // A due date landing on it is not refused — pickup can be the day after — but the run sheet says so.
    const sched = (await ok(`/schedule?from=${day}&days=1`)).days[0];
    expect(sched.blackout).toBe('Thanksgiving');
    expect((await api('/blackouts', { method: 'POST', body: { date: day }, as: 'staff@beehivebin.co' })).status).toBe(403);
    await ok(`/blackouts/${day}`, { method: 'DELETE' });
    expect((await ok('/blackouts')).blackouts).toHaveLength(0);
  });

  it('a run of days off is one entry, and every job inside it is reported', async () => {
    await fleet(40);
    const a = weekday(5), b = addDays(a, 6);
    const r = await rental({ bins: 10, start_date: addDays(a, 2) });
    const res = await ok('/blackouts', { method: 'POST', body: { date: a, to: b, reason: 'Away' } });
    expect(res.days).toBe(7);
    expect(res.affected).toEqual([{ id: r.id, name: 'Dana Whitfield', job: 'deliver', date: addDays(a, 2) }]);
    expect((await ok('/blackouts')).blackouts.filter(x => x.reason === 'Away')).toHaveLength(7);
    expect((await api('/blackouts', { method: 'POST', body: { date: b, to: a } })).status).toBe(400);
  });

  it('a pending rental already on a day that gets blacked out is reported, not silently left', async () => {
    await fleet(40);
    const r = await rental({ bins: 10, start_date: weekday(5) });
    const res = await ok('/blackouts', { method: 'POST', body: { date: weekday(5), reason: 'Closed' } });
    expect(res.affected).toEqual([{ id: r.id, name: 'Dana Whitfield', job: 'deliver', date: weekday(5) }]);
  });
});

describe('lead time', () => {
  it('the website needs a day\'s notice by default; the panel can book same-day on purpose', async () => {
    await fleet(40);
    expect((await ok('/settings')).leadDays).toBe(1);
    const sameDay = await api('/requests', { method: 'POST', body: { kind: 'reserve', first_name: 'A', bins: 10, weeks: 1, start_date: today(), delivery_city: 'Clinton', phone: '801' } });
    expect(sameDay.status).toBe(201);   // staff know what they are doing
    await ok('/settings', { method: 'PATCH', body: { leadDays: 3 } });
    expect((await ok('/settings')).leadDays).toBe(3);
  });
});

describe('reminders', () => {
  it('the morning cron emails tomorrow\'s deliveries and tomorrow\'s pickups, once each', async () => {
    await fleet(60);
    at('2026-09-14T15:00:00Z');   // 9am Monday 14th
    const drop = await rental({ bins: 20, start_date: '2026-09-15' });
    await sql("UPDATE rentals SET agreement_signed_at = 'x', paid_at = 'x', status = 'confirmed', delivery_window = '6–8pm', delivery_address = '1 Main St, Clinton UT 84015' WHERE id = ?1", drop.id);
    const back = await rental({ bins: 10, start_date: '2026-09-08', email: 'back@example.com' });
    await sql("UPDATE rentals SET due_date = '2026-09-15', delivered_at = 'x', status = 'out', pickup_window = '5–7pm' WHERE id = ?1", back.id);
    const unconfirmed = await rental({ bins: 10, start_date: '2026-09-15', email: 'no@example.com' });   // never signed: not reminded
    const later = await rental({ bins: 10, start_date: '2026-09-16', email: 'later@example.com' });
    await sql("UPDATE rentals SET agreement_signed_at = 'x', paid_at = 'x' WHERE id = ?1", later.id);

    const res = await ok('/reminders/run', { method: 'POST' });
    expect(res.sent).toBe(2);
    const mail = await sent();
    const reminders = mail.filter(m => m.kind === 'reminder');
    expect(reminders.map(m => [m.to, m.job, m.window])).toEqual([
      ['dana@example.com', 'deliver', '6–8pm'],
      ['back@example.com', 'collect', '5–7pm'],
    ]);
    expect(reminders[0].address).toBe('1 Main St, Clinton UT 84015');
    // Again the same morning: nothing new.
    expect((await ok('/reminders/run', { method: 'POST' })).sent).toBe(0);
    // The record shows it.
    expect((await ok(`/rentals/${drop.id}`)).rental.reminded_delivery_at).toBeTruthy();
    expect((await ok(`/rentals/${unconfirmed.id}`)).rental.reminded_delivery_at).toBeNull();
  });

  it('runs from the cron at 9am Mountain and not at 3am', async () => {
    await fleet(20);
    at('2026-09-14T15:00:00Z');
    const drop = await rental({ bins: 20, start_date: '2026-09-15' });
    await sql("UPDATE rentals SET agreement_signed_at = 'x', paid_at = 'x' WHERE id = ?1", drop.id);
    const { createScheduledController, createExecutionContext, waitOnExecutionContext, env } = await import('cloudflare:test');
    const worker = (await import('../src/index.js')).default;
    for (const cron of ['0 9 * * *', '0 15 * * *']) {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ cron }), env, ctx);
      await waitOnExecutionContext(ctx);
    }
    expect((await sent()).filter(m => m.kind === 'reminder')).toHaveLength(1);
  });
});

describe('days we do not go out', () => {
  const dow = iso => new Date(`${iso}T12:00:00Z`).getUTCDay();
  const nextDow = (wd, from = 1) => { let d = today(from); while (dow(d) !== wd) d = addDays(d, 1); return d; };
  const book = (start, as) => api('/requests', { method: 'POST', as, body: { kind: 'reserve', first_name: 'A', bins: 10, weeks: 1, start_date: start, delivery_city: 'Clinton', phone: '801' } });

  it('Sunday by default, visible in settings; the days are a setting, not a rule in the code', async () => {
    await fleet(40);
    expect((await ok('/settings')).closedWeekdays).toEqual([0]);
    expect((await book(nextDow(0))).error).toMatch(/Sunday/);
    // Close Mondays too.
    await ok('/settings', { method: 'PATCH', body: { closedWeekdays: [0, 1] } });
    expect((await ok('/settings')).closedWeekdays).toEqual([0, 1]);
    expect((await book(nextDow(1))).error).toMatch(/Monday/);
    expect((await book(nextDow(2))).status).toBe(201);
    // Open Sundays (a setting, so it can be undone).
    await ok('/settings', { method: 'PATCH', body: { closedWeekdays: [] } });
    expect((await book(nextDow(0))).status).toBe(201);
    // The run sheet and the calendar say which days are closed.
    await ok('/settings', { method: 'PATCH', body: { closedWeekdays: [0, 1] } });
    const days = (await ok(`/schedule?from=${nextDow(1)}&days=1`)).days;
    expect(days[0].closedDay).toBe('Monday');
    expect((await ok(`/coverage?from=${nextDow(1)}&days=1`)).days[0].open).toBe(false);
  });

  it('every day closed is refused as a setting — it would close the business', async () => {
    expect((await api('/settings', { method: 'PATCH', body: { closedWeekdays: [0, 1, 2, 3, 4, 5, 6] } })).status).toBe(400);
  });
});

describe('holidays', () => {
  const book = (start) => api('/requests', { method: 'POST', body: { kind: 'reserve', first_name: 'A', bins: 10, weeks: 1, start_date: start, delivery_city: 'Clinton', phone: '801' } });

  it('are worked out, not typed: Thanksgiving 2026 is the 26th, Memorial Day the 25th of May', async () => {
    const { holidays } = await ok('/holidays?year=2026');
    const by = Object.fromEntries(holidays.map(h => [h.key, h]));
    expect(by.thanksgiving.date).toBe('2026-11-26');
    expect(by.memorial_day.date).toBe('2026-05-25');
    expect(by.labor_day.date).toBe('2026-09-07');
    expect(by.mlk_day.date).toBe('2027-01-18' === by.mlk_day.date ? by.mlk_day.date : '2026-01-19');
    expect(by.pioneer_day.date).toBe('2026-07-24');
    expect(by.day_after_thanksgiving.date).toBe('2026-11-27');
    expect(holidays.length).toBeGreaterThanOrEqual(14);
  });

  it('the big ones are closed by default; a booking on one is refused by name; the owner can untick', async () => {
    await fleet(40);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T18:00:00Z'));
    try {
      expect((await ok('/settings')).closedHolidays).toContain('thanksgiving');
      expect((await ok('/settings')).closedHolidays).not.toContain('columbus_day');
      expect((await book('2026-11-26')).error).toMatch(/Thanksgiving/);
      expect((await book('2026-10-12')).status).toBe(201);   // Columbus Day: open
      const cov = (await ok('/coverage?from=2026-11-26&days=1')).days[0];
      expect(cov.open).toBe(false);
      expect(cov.blackout).toBe('Thanksgiving');
      await ok('/settings', { method: 'PATCH', body: { closedHolidays: ['christmas'] } });
      expect((await book('2026-11-27')).status).toBe(201);
      expect((await book('2026-12-25')).error).toMatch(/Christmas/);
    } finally { vi.useRealTimers(); }
  });
});
