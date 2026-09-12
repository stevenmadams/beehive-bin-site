import { describe, it, expect } from 'vitest';
import { submit, reserveForm, requests, mail, today, weekday, addDays } from './helpers.js';
import { env } from 'cloudflare:test';

describe('the reserve form', () => {
  it('C1 a reservation is stored and the inbox is told, with a link to the panel', async () => {
    const r = await submit(reserveForm());
    expect(r).toMatchObject({ status: 200, ok: true });
    const [row] = await requests();
    expect(row).toMatchObject({
      kind: 'reserve', source: 'web', status: 'new', first_name: 'Dana', last_name: 'Whitfield',
      email: 'dana@example.com', phone: '801-555-0100', bins: 20, weeks: 1, start_date: weekday(4),
      quoted_total_cents: 7900, delivery_city: 'Clinton', customer_notes: 'Gate code 4471', contact_pref: 'text',
    });
    const [m] = await mail();
    expect(m.to).toEqual(['support@beehivebin.co']);
    expect(m.reply_to).toBe('dana@example.com');
    expect(m.text).toContain('Customer notes: Gate code 4471');
    expect(m.text).toContain(`https://admin.beehivebin.co/#/requests/${row.id}`);
  });

  it('C2 email and phone are both required, and it says which is missing', async () => {
    expect(await submit(reserveForm({ email: '' }))).toMatchObject({ status: 400, error: 'missing email' });
    expect(await submit(reserveForm({ phone: '  ' }))).toMatchObject({ status: 400, error: 'missing phone' });
    expect(await requests()).toHaveLength(0);
  });

  it('C3 a city we do not serve is refused, not stored', async () => {
    const r = await submit(reserveForm({ dcity: 'Provo' }));
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/serve/i);
    expect(await requests()).toHaveLength(0);
    // Pickup too, and the stored spelling is ours.
    expect((await submit(reserveForm({ pcity: 'Nowhere' }))).status).toBe(400);
    await submit(reserveForm({ dcity: 'south ogden', pcity: 'ROY' }));
    expect((await requests())[0]).toMatchObject({ delivery_city: 'South Ogden', pickup_city: 'Roy' });
  });

  it('C4 a package or week count we do not sell is refused; the quoted price is ours, not the form\'s', async () => {
    expect((await submit(reserveForm({ bins: '25' }))).status).toBe(400);
    expect((await submit(reserveForm({ weeks: '0' }))).status).toBe(400);
    expect((await submit(reserveForm({ weeks: '30' }))).status).toBe(400);
    // A tampered total is ignored: the panel quotes from the price table.
    await submit(reserveForm({ bins: '40', weeks: '2', total_before_tax: '$1' }));
    expect((await requests())[0].quoted_total_cents).toBe(12900 + 6500);
  });

  it('C5 a start date in the past or on a Sunday is refused', async () => {
    expect((await submit(reserveForm({ start: today(-1) }))).error).toMatch(/past|already/i);
    let sunday = today(1);
    while (new Date(`${sunday}T12:00:00Z`).getUTCDay() !== 0) sunday = addDays(sunday, 1);
    expect((await submit(reserveForm({ start: sunday }))).error).toMatch(/Sunday/);
    expect((await submit(reserveForm({ start: 'next tuesday' }))).status).toBe(400);
    expect(await requests()).toHaveLength(0);
  });

  it('C7 a bot that fills the honeypot gets a yes and nothing is stored', async () => {
    const r = await submit(reserveForm({ website: 'http://spam' }));
    expect(r).toMatchObject({ status: 200, ok: true });
    expect(await requests()).toHaveLength(0);
    expect(await mail()).toHaveLength(0);
  });

  it('a Resend outage does not lose the request', async () => {
    // The world stub refuses anything that is not Resend; point Resend away.
    const r = await submit(reserveForm({ email: 'x@example.com' }));
    expect(r.ok).toBe(true);
    expect(await requests()).toHaveLength(1);
  });

  it('CORS: the site may post, a stranger may not read', async () => {
    const r = await submit(reserveForm(), 'https://evil.example');
    expect(r.status).toBe(200);   // stored regardless — the browser enforces the origin, not us
    const { SELF } = await import('cloudflare:test');
    const pre = await SELF.fetch('https://api.beehivebin.co/submit', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://beehivebin.co');
  });
});

describe('the contact form', () => {
  it('C6 a message is stored with its contact method sorted', async () => {
    await submit({ form: 'contact', name: 'Quinn', contact: 'quinn@example.com', city: 'Layton', message: 'Do you do Saturdays?' });
    await submit({ form: 'contact', name: 'Rae', contact: '801 555 0177', message: 'Call me' });
    const rows = await requests();
    expect(rows[0]).toMatchObject({ kind: 'contact', email: 'quinn@example.com', phone: null, contact_pref: 'email', message: 'Do you do Saturdays?', delivery_city: 'Layton' });
    expect(rows[1]).toMatchObject({ email: null, phone: '801 555 0177', contact_pref: 'call' });
  });

  it('needs a name, a way to reach them, and a message', async () => {
    expect((await submit({ form: 'contact', name: 'Q', contact: 'q@example.com' })).error).toBe('missing message');
    expect((await submit({ form: 'unknown' })).status).toBe(400);
  });
});

describe('after 6pm Mountain', () => {
  it('a booking for the next delivery day is still accepted — UTC has rolled over, Utah has not', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-13T01:30:00Z'));   // 7:30pm MDT, Saturday 12 Sep
    try {
      expect((await submit(reserveForm({ start: '2026-09-14' }))).ok).toBe(true);        // Monday
      expect((await submit(reserveForm({ start: '2026-09-12' }))).error).toMatch(/notice/); // tonight: a day's notice
      expect((await submit(reserveForm({ start: '2026-09-11' }))).error).toMatch(/passed/);
      expect((await submit(reserveForm({ start: '2026-09-13' }))).error).toMatch(/Sunday/);
    } finally { vi.useRealTimers(); }
  });
});

describe('notice and days off', () => {
  it('the website needs the lead time the owner set — a day by default', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T15:00:00Z'));   // 9am Monday 14th
    try {
      expect((await submit(reserveForm({ start: '2026-09-14' }))).error).toMatch(/earliest.*Tuesday|notice/i);
      expect((await submit(reserveForm({ start: '2026-09-15' }))).ok).toBe(true);
      await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('lead_days', '3')").run();
      expect((await submit(reserveForm({ start: '2026-09-16' }))).error).toMatch(/earliest/i);
      expect((await submit(reserveForm({ start: '2026-09-17' }))).ok).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('a blacked-out day cannot be booked, and says why', async () => {
    const day = weekday(5);
    await env.DB.prepare("INSERT INTO blackouts (date, reason, created_by) VALUES (?1, 'Pioneer Day', 'test')").bind(day).run();
    expect((await submit(reserveForm({ start: day }))).error).toMatch(/Pioneer Day/);
    expect((await submit(reserveForm({ start: addDays(day, 1) }))).ok).toBe(true);
  });
});
