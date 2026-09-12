import { describe, it, expect } from 'vitest';
import { api, ok, rental, request, fleet, today, weekday, sql, OWNER } from './helpers.js';

const patch = (id, body) => api(`/rentals/${id}`, { method: 'PATCH', body });
const finish = async id => {
  await patch(id, { milestone: 'agreement', done: true, reason: 'paper' });
  await patch(id, { milestone: 'paid', done: true });
  await patch(id, { milestone: 'delivered', done: true, force: true, photo_reason: 'x' });
  await ok(`/rentals/${id}/unlock`, { method: 'POST', body: { step: 'returned' } });
  await patch(id, { milestone: 'returned', done: true, force: true, photo_reason: 'x' });
  await patch(id, { milestone: 'inspected', done: true });
};

describe('a request is a question; once answered it leaves the list', () => {
  it('Q1 a converted request cannot be moved back to new — its rental is real', async () => {
    await fleet(40);
    const r = await rental();
    const back = await api(`/requests/${r.request_id}/decision`, { method: 'POST', body: { action: 'reopen' } });
    expect(back.status).toBe(409);
    expect(back.error).toMatch(/rental #\d+/);
    expect((await ok(`/requests/${r.request_id}`)).request.status).toBe('converted');
  });

  it('Q2 the request list is new and lapsed only; booked and declined are found on the customer', async () => {
    await fleet(40);
    const fresh = await request();
    const r = await rental({ email: 'booked@example.com' });
    const dec = await request({ email: 'no@example.com' });
    await ok(`/requests/${dec.id}/decision`, { method: 'POST', body: { action: 'decline', reason: 'Too far' } });
    const old = await request({ email: 'old@example.com' });
    await sql('UPDATE requests SET start_date = ?1 WHERE id = ?2', today(-3), old.id);
    expect((await ok('/requests')).requests.map(x => x.id)).toEqual([fresh.id]);
    expect((await ok('/requests?status=lapsed')).requests.map(x => x.id)).toEqual([old.id]);
    expect(r.request_id).toBeTruthy();
  });

  it('Q3 a lapsed request is given a new date (back to new) or declined (to the customer)', async () => {
    await fleet(40);
    const old = await request({ email: 'old@example.com' });
    await sql('UPDATE requests SET start_date = ?1 WHERE id = ?2', today(-3), old.id);
    const moved = await ok(`/requests/${old.id}`, { method: 'PATCH', body: { start_date: weekday(5) } });
    expect(moved.request.lapsed).toBe(0);
    expect(moved.request.return_date).toBeTruthy();
    expect((await ok('/requests')).requests.map(x => x.id)).toEqual([old.id]);
    expect((await api(`/requests/${old.id}`, { method: 'PATCH', body: { start_date: today(-1) } })).status).toBe(400);
  });
});

describe('a rental is a job; when it is done it leaves the list', () => {
  it('J1 active means pending, confirmed, out, or back and not yet inspected; inspected and cancelled are history', async () => {
    await fleet(60);
    const pending = await rental({ bins: 10, start_date: today(), email: 'p@example.com' });
    const done = await rental({ bins: 10, start_date: today(), email: 'd@example.com' });
    await finish(done.id);
    const back = await rental({ bins: 10, start_date: today(), email: 'b@example.com' });
    await patch(back.id, { milestone: 'delivered', done: true, force: true, photo_reason: 'x' });
    await ok(`/rentals/${back.id}/unlock`, { method: 'POST', body: { step: 'returned' } });
    await patch(back.id, { milestone: 'returned', done: true, force: true, photo_reason: 'x' });
    const gone = await rental({ bins: 10, start_date: weekday(3), email: 'g@example.com' });
    await patch(gone.id, { status: 'cancelled', reason: 'x' });

    const active = (await ok('/rentals?status=active')).rentals.map(r => r.id).sort();
    expect(active).toEqual([pending.id, back.id].sort());
    expect((await ok('/rentals?status=back')).rentals.map(r => r.id)).toEqual([back.id]);
    expect((await ok('/stats')).rentals.active).toBe(2);
  });
});

describe('a customer is a person', () => {
  it('C1 one record per person, merged by email, across requests and rentals', async () => {
    await fleet(60);
    const a = await rental({ email: 'Dana@Example.com', bins: 10, start_date: today() });
    await finish(a.id);
    const again = await request({ email: 'dana@example.com', bins: 20, start_date: weekday(20) });
    await request({ email: 'someone@example.com', first_name: 'Sam', last_name: 'Ortiz', phone: '801-555-0199' });
    const { customers } = await ok('/customers');
    expect(customers).toHaveLength(2);
    const dana = customers.find(c => c.email === 'dana@example.com');
    expect(dana).toMatchObject({ first_name: 'Dana', last_name: 'Whitfield', rentals: 1, requests: 2, open_requests: 1 });
    expect(dana.spent_cents).toBe(3900);   // the finished 10-bin rental, at the standard rate
    const one = await ok(`/customers/${dana.id}`);
    expect(one.rentals.map(r => r.id)).toEqual([a.id]);
    expect(one.requests.map(r => r.id).sort()).toEqual([a.request_id, again.id].sort());
    expect((await ok(`/requests/${again.id}`)).request.customer_id).toBe(dana.id);
  });

  it('C2 a phone-only enquiry matches by phone; the same person by email later is the same customer', async () => {
    const q = await ok('/requests', { method: 'POST', body: { kind: 'contact', first_name: 'Rae', phone: '(801) 555-0177', message: 'Saturdays?' } });
    const r2 = await request({ first_name: 'Rae', last_name: 'Lund', email: 'rae@example.com', phone: '801.555.0177' });
    const { customers } = await ok('/customers');
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ last_name: 'Lund', email: 'rae@example.com', requests: 2 });
    expect((await ok(`/requests/${q.request.id}`)).request.customer_id).toBe(customers[0].id);
    expect(r2.customer_id).toBe(customers[0].id);
  });

  it('C3 declined and lapsed people are there for next time, filterable; past renters too', async () => {
    await fleet(60);
    const dec = await request({ email: 'no@example.com' });
    await ok(`/requests/${dec.id}/decision`, { method: 'POST', body: { action: 'decline', reason: 'Too far' } });
    const old = await request({ email: 'old@example.com' });
    await sql('UPDATE requests SET start_date = ?1 WHERE id = ?2', today(-3), old.id);
    const a = await rental({ email: 'done@example.com', bins: 10, start_date: today() });
    await finish(a.id);
    expect((await ok('/customers?filter=declined')).customers.map(c => c.email)).toEqual(['no@example.com']);
    expect((await ok('/customers?filter=lapsed')).customers.map(c => c.email)).toEqual(['old@example.com']);
    expect((await ok('/customers?filter=renters')).customers.map(c => c.email)).toEqual(['done@example.com']);
    expect((await ok('/customers?q=old')).customers).toHaveLength(1);
    const one = await ok(`/customers/${(await ok('/customers?filter=declined')).customers[0].id}`);
    expect(one.requests[0]).toMatchObject({ status: 'declined', decline_reason: 'Too far' });
  });

  it('C4 notes live on the person, and an owner can fix their details', async () => {
    const r = await request({ email: 'n@example.com' });
    const { customers } = await ok('/customers');
    const c = customers[0];
    const n = await ok(`/customers/${c.id}/notes`, { method: 'POST', body: { body: 'Moving again in spring — call in March' } });
    expect(n.notes[0].author).toBe(OWNER);
    const fixed = await ok(`/customers/${c.id}`, { method: 'PATCH', body: { phone: '801-555-0100', last_name: 'Whitfield-Ng' } });
    expect(fixed.customer.last_name).toBe('Whitfield-Ng');
    expect((await api(`/customers/${c.id}`, { method: 'PATCH', body: { email: 'x' }, as: 'staff@beehivebin.co' })).status).toBe(403);
    expect(r.customer_id).toBe(c.id);
  });
});

describe('statuses match the stages', () => {
  it('P1 booked → confirmed → out → back → settling → done, and the list filters by each', async () => {
    await fleet(60);
    const r = await rental({ bins: 10, start_date: today() });
    const phase = async () => (await ok(`/rentals/${r.id}`)).rental.phase;
    expect((await ok(`/rentals/${r.id}`)).rental.status).toBe('booked');
    await patch(r.id, { milestone: 'agreement', done: true, reason: 'paper' });
    await patch(r.id, { milestone: 'paid', done: true });
    expect(await phase()).toBe('confirmed');
    await patch(r.id, { milestone: 'delivered', done: true, force: true, photo_reason: 'x' });
    expect(await phase()).toBe('out');
    await ok(`/rentals/${r.id}/unlock`, { method: 'POST', body: { step: 'returned' } });
    await patch(r.id, { milestone: 'returned', done: true, force: true, photo_reason: 'x' });
    expect(await phase()).toBe('back');
    expect((await ok('/rentals?status=back')).rentals.map(x => x.id)).toEqual([r.id]);
    // Flag one bin lost at inspection: there is something to settle.
    const { items } = await ok(`/rentals/${r.id}/items`);
    await ok(`/rentals/${r.id}/items/inspect`, { method: 'POST', body: { items: [{ id: items[0].id, back: false }] } });
    await patch(r.id, { milestone: 'inspected', done: true });
    expect(await phase()).toBe('settling');
    expect((await ok('/rentals?status=settling')).rentals.map(x => x.id)).toEqual([r.id]);
    expect((await ok('/rentals?status=active')).rentals.map(x => x.id)).toEqual([r.id]);   // still work to do
    expect((await ok('/stats')).rentals.settling).toBe(1);
    // Decide it — add the charge and waive it — and it is done.
    const { proposals } = await ok(`/rentals/${r.id}/charges`);
    const m = proposals.find(p => p.kind === 'missing');
    const c = await ok(`/rentals/${r.id}/charges`, { method: 'POST', body: { kind: 'missing', qty: m.qty, unit_cents: m.unit_cents, reason: m.reason } });
    expect(await phase()).toBe('settling');   // drafted, not yet charged
    await ok(`/charges/${c.charges[0].id}/waive`, { method: 'POST', body: { reason: 'Turned up later' } });
    expect(await phase()).toBe('done');
    expect((await ok('/rentals?status=active')).rentals).toHaveLength(0);
    expect((await ok('/rentals?status=done')).rentals.map(x => x.id)).toEqual([r.id]);
  });

  it('P2 a clean rental is done the moment it is inspected; a late one is settling until the late week is decided', async () => {
    await fleet(60);
    const clean = await rental({ bins: 10, start_date: today(-7), email: 'c@example.com' });
    await sql("UPDATE rentals SET due_date = ?1, agreement_signed_at='x', paid_at='x', delivered_at='x', returned_at=?1 || 'T20:00:00Z', status='back' WHERE id = ?2", today(), clean.id);
    await patch(clean.id, { milestone: 'inspected', done: true });
    expect((await ok(`/rentals/${clean.id}`)).rental.phase).toBe('done');
    const late = await rental({ bins: 10, start_date: today(-10), email: 'l@example.com' });
    await sql("UPDATE rentals SET due_date = ?1, agreement_signed_at='x', paid_at='x', delivered_at='x', returned_at=?2 || 'T20:00:00Z', status='back' WHERE id = ?3", today(-3), today(), late.id);
    await patch(late.id, { milestone: 'inspected', done: true });
    expect((await ok(`/rentals/${late.id}`)).rental.phase).toBe('settling');
  });
});

describe('a question from the contact form', () => {
  const question = (over = {}) => ok('/requests', { method: 'POST', body: { kind: 'contact', first_name: 'Quinn', phone: '801-555-0111', message: 'Do you deliver to Hooper?', ...over } });

  it('Q4 cannot be approved or declined — it is answered, and then it leaves the list', async () => {
    const q = await question();
    expect((await api(`/requests/${q.request.id}/decision`, { method: 'POST', body: { action: 'approve' } })).status).toBe(400);
    const a = await ok(`/requests/${q.request.id}/decision`, { method: 'POST', body: { action: 'answer', reason: 'Yes to Hooper; 20 is the smallest package' } });
    expect(a.request.status).toBe('answered');
    expect(a.request.decline_reason).toBe('Yes to Hooper; 20 is the smallest package');
    expect((await ok('/requests')).requests).toHaveLength(0);
    const { customers } = await ok('/customers?q=0111');
    const one = await ok(`/customers/${customers[0].id}`);
    expect(one.requests[0].status).toBe('answered');
  });

  it('Q5 becomes a booking: a new reservation for the same person, and the question is marked answered by it', async () => {
    await fleet(40);
    const q = await question();
    const r = await ok('/requests', { method: 'POST', body: { kind: 'reserve', first_name: 'Quinn', last_name: 'Park', phone: '801-555-0111', email: 'quinn@example.com', bins: 20, weeks: 1, start_date: weekday(4), delivery_city: 'Hooper', answers: q.request.id } });
    expect(r.request.customer_id).toBe(q.request.customer_id);
    const asked = await ok(`/requests/${q.request.id}`);
    expect(asked.request.status).toBe('answered');
    expect(asked.request.decline_reason).toMatch(new RegExp(`request #${r.request.id}`));
    expect((await ok('/requests')).requests.map(x => x.id)).toEqual([r.request.id]);
  });

  it('a reservation cannot be "answered" — it is approved or declined', async () => {
    const r = await request();
    expect((await api(`/requests/${r.id}/decision`, { method: 'POST', body: { action: 'answer' } })).status).toBe(400);
  });
});
