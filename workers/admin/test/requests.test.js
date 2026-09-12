import { describe, it, expect } from 'vitest';
import { api, ok, request, fleet, today, weekday, sql, sent, STAFF } from './helpers.js';

describe('requests', () => {
  it('S1 a new request counts on the badge and opens with everything sent', async () => {
    const r = await request({ customer_notes: 'Gate code 4471', internal_notes: 'Sounded keen' });
    expect(r.status).toBe('new');
    expect(r.source).toBe('manual');
    expect(r.quoted_total_cents).toBe(7900);          // 20 bins, 1 week
    expect(r.return_date).toBe(addWeeks(weekday(3), 1));
    const stats = await ok('/stats');
    expect(stats.counts.new).toBe(1);
    const one = await ok(`/requests/${r.id}`);
    expect(one.request.customer_notes).toBe('Gate code 4471');
  });

  it('S2 a phone booking needs a name, a package we sell and a way to reach them', async () => {
    const noName = await api('/requests', { method: 'POST', body: { kind: 'reserve', bins: 20, weeks: 1, start_date: weekday(), delivery_city: 'Clinton', phone: '801' } });
    expect(noName.status).toBe(400);
    const badPkg = await api('/requests', { method: 'POST', body: { kind: 'reserve', first_name: 'A', bins: 25, weeks: 1, start_date: weekday(), delivery_city: 'Clinton', phone: '801' } });
    expect(badPkg.error).toMatch(/10, 20, 40 or 60/);
    const noContact = await api('/requests', { method: 'POST', body: { kind: 'reserve', first_name: 'A', bins: 20, weeks: 1, start_date: weekday(), delivery_city: 'Clinton' } });
    expect(noContact.error).toMatch(/phone number or email/);
  });

  it('S3 a phone booking city must be one we serve', async () => {
    const r = await api('/requests', { method: 'POST', body: { kind: 'reserve', first_name: 'A', bins: 20, weeks: 1, start_date: weekday(), delivery_city: 'Clnton', phone: '801' } });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/serve/i);
    // Case and spacing are forgiven; a real city is stored in its proper form.
    const okCity = await ok('/requests', { method: 'POST', body: { kind: 'reserve', first_name: 'A', bins: 20, weeks: 1, start_date: weekday(), delivery_city: ' south ogden ', phone: '801' } });
    expect(okCity.request.delivery_city).toBe('South Ogden');
  });

  it('S4 approving creates the rental, converts the request, and mints a link', async () => {
    await fleet(40);
    const req = await request();
    const d = await ok(`/requests/${req.id}/decision`, { method: 'POST', body: { action: 'approve' } });
    expect(d.request.status).toBe('converted');
    expect(d.rental_id).toBeTruthy();
    const { rental } = await ok(`/rentals/${d.rental_id}`);
    expect(rental.status).toBe('pending');
    expect(rental.bins).toBe(20);
    expect(rental.due_date).toBe(addWeeks(req.start_date, 1));
    expect(rental.total_cents).toBe(7900);
    // The link itself is minted when the rental is started — see S10.
    expect(rental.confirm_token).toBeNull();
  });

  it('S5 approving twice yields one rental', async () => {
    await fleet(40);
    const req = await request();
    const a = await ok(`/requests/${req.id}/decision`, { method: 'POST', body: { action: 'approve' } });
    const b = await ok(`/requests/${req.id}/decision`, { method: 'POST', body: { action: 'approve' } });
    expect(a.rental_id).toBe(b.rental_id);
    expect((await ok('/rentals?status=all')).rentals).toHaveLength(1);
  });

  it('S6 a contact enquiry cannot become a rental', async () => {
    const req = await ok('/requests', { method: 'POST', body: { kind: 'contact', first_name: 'Q', email: 'q@example.com', message: 'Do you deliver to Ogden?' } });
    const d = await api(`/requests/${req.request.id}/decision`, { method: 'POST', body: { action: 'approve' } });
    expect(d.status).toBe(400);
    expect(d.error).toMatch(/Only a reservation/);
  });

  it('S8 declining records the reason; reopening clears it', async () => {
    const req = await request();
    const d = await ok(`/requests/${req.id}/decision`, { method: 'POST', body: { action: 'decline', reason: 'Outside our area' } });
    expect(d.request.status).toBe('declined');
    expect(d.request.decline_reason).toBe('Outside our area');
    expect(d.request.decided_by).toBeTruthy();
    const r = await ok(`/requests/${req.id}/decision`, { method: 'POST', body: { action: 'reopen' } });
    expect(r.request.status).toBe('new');
    expect(r.request.decided_by).toBeNull();
  });

  it('S9 a request whose start date has passed unanswered is lapsed, and not counted as new', async () => {
    const live = await request();
    const old = await request();
    await sql('UPDATE requests SET start_date = ?1 WHERE id = ?2', today(-2), old.id);
    const lapsed = await ok('/requests?status=lapsed');
    expect(lapsed.requests.map(r => r.id)).toEqual([old.id]);
    const stats = await ok('/stats');
    expect(stats.counts.new).toBe(1);
    expect(stats.counts.lapsed).toBe(1);
    expect(live.id).not.toBe(old.id);
  });

  it('searches by name, email and phone', async () => {
    await request({ first_name: 'Marisol', last_name: 'Quintero', email: 'mq@example.com', phone: '801-555-0199' });
    await request({ first_name: 'Ben', last_name: 'Okafor', email: 'ben@example.com', phone: '801-555-0100' });
    expect((await ok('/requests?status=all&q=quintero')).requests).toHaveLength(1);
    expect((await ok('/requests?status=all&q=0100')).requests.map(r => r.first_name)).toEqual(['Ben']);
    expect((await ok('/requests?status=all&q=example.com')).requests).toHaveLength(2);
  });

  it('staff can take a request, and the record says who took it', async () => {
    await fleet(40);
    await ok('/me');
    const r = await ok('/requests', { method: 'POST', as: STAFF, body: { kind: 'reserve', first_name: 'B', bins: 10, weeks: 1, start_date: weekday(3), delivery_city: 'Clinton', phone: '801' } });
    const h = await ok(`/requests/${r.request.id}/history`);
    expect(h.history.find(e => e.action === 'request.create').actor_email).toBe(STAFF);
  });
});

function addWeeks(iso, w) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * w);
  return d.toISOString().slice(0, 10);
}
