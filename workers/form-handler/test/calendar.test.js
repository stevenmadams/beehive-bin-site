import { describe, it, expect, vi, afterEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { today, weekday, addDays } from './helpers.js';

afterEach(() => vi.useRealTimers());
const cal = async (qs = '') => {
  const res = await SELF.fetch(`https://api.beehivebin.co/calendar?${qs}`, { headers: { Origin: 'https://beehivebin.co' } });
  return { status: res.status, cors: res.headers.get('access-control-allow-origin'), ...(await res.json()) };
};
const dow = iso => new Date(`${iso}T12:00:00Z`).getUTCDay();
const addBins = async n => {
  await env.DB.prepare("INSERT INTO employees (email, name, role, created_by) VALUES ('o@beehivebin.co','o','owner','t')").run();
  for (let i = 1; i <= n; i++) await env.DB.prepare("INSERT INTO items (kind, label, condition, created_by) VALUES ('bin', ?1, 'good', 't')").bind(`B-${String(i).padStart(3, '0')}`).run();
};

describe('the website calendar', () => {
  it('says which days a booking can start on, and why not for the rest', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-16T16:00:00Z'));   // Mon 16 Nov 2026, 9am
    await env.DB.prepare("INSERT INTO blackouts (date, reason, created_by) VALUES ('2026-11-20', 'Away', 't')").run();
    const c = await cal('from=2026-11-16&days=14&bins=20&weeks=1');
    expect(c.status).toBe(200);
    expect(c.cors).toBe('https://beehivebin.co');
    const by = Object.fromEntries(c.days.map(d => [d.date, d]));
    expect(by['2026-11-16']).toMatchObject({ open: false });            // today: needs a day's notice
    expect(by['2026-11-16'].why).toMatch(/notice/i);
    expect(by['2026-11-17'].open).toBe(true);
    expect(by['2026-11-22']).toMatchObject({ open: false, why: 'Sunday' });
    expect(by['2026-11-20']).toMatchObject({ open: false, why: 'Away' });
    expect(by['2026-11-26']).toMatchObject({ open: false, why: 'Thanksgiving' });
    expect(by['2026-11-27']).toMatchObject({ open: false, why: 'Day after Thanksgiving' });
    expect(c.closedWeekdays).toEqual([0]);
    // No fleet entered: nothing is called full.
    expect(c.days.filter(d => d.open).every(d => d.fits)).toBe(true);
  });

  it('marks a day full for the package asked about, not for a smaller one, and never says how many bins exist', async () => {
    await addBins(40);
    const start = weekday(5);
    await env.DB.prepare(
      `INSERT INTO rentals (created_by, first_name, email, bins, weeks, start_date, due_date, total_cents, delivery_city, status)
       VALUES ('t','A','a@example.com', 40, 1, ?1, ?2, 12900, 'Clinton', 'confirmed')`).bind(start, addDays(start, 7)).run();
    const big = await cal(`from=${today()}&days=20&bins=20&weeks=1`);
    const d = big.days.find(x => x.date === addDays(start, 2));
    expect(d.open).toBe(true);
    expect(d.fits).toBe(false);
    expect(JSON.stringify(big)).not.toMatch(/fleet|available|committed/);
    // Ten days later the 40 are back and turned around.
    expect(big.days.find(x => x.date === addDays(start, 10) && dow(addDays(start, 10)) !== 0)?.fits ?? true).toBe(true);
  });

  it('is capped and validated', async () => {
    expect((await cal('from=nope')).status).toBe(400);
    expect((await cal(`from=${today()}&days=400`)).days.length).toBeLessThanOrEqual(120);
  });
});
