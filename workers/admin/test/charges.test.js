import { describe, it, expect } from 'vitest';
import { api, ok, rental, fleet, today, sql, squareCalls, OWNER } from './helpers.js';

const patch = (id, body) => ok(`/rentals/${id}`, { method: 'PATCH', body });
const charges = id => ok(`/rentals/${id}/charges`);

/* A rental that went out `outDays` ago and was due back `dueDaysAgo` ago. */
async function lateRental({ bins = 20, outDays = 10, dueDaysAgo = 3, returned = false, card = false } = {}) {
  await fleet(60);
  const r = await rental({ bins, weeks: 1, start_date: today(-outDays) });
  await sql(`UPDATE rentals SET due_date = ?1, delivered_at = ?2 || 'T20:00:00Z', status = 'out',
             agreement_signed_at = ?2 || 'T10:00:00Z', paid_at = ?2 || 'T10:00:00Z'
             ${card ? ", square_card_id = 'card_9', card_brand = 'VISA', card_last4 = '4242'" : ''}
             WHERE id = ?3`, today(-dueDaysAgo), today(-outDays), r.id);
  if (returned) {
    await sql("UPDATE rentals SET returned_at = ?1 || 'T19:00:00Z', status = 'back' WHERE id = ?2", today(), r.id);
  }
  return (await ok(`/rentals/${r.id}`)).rental;
}

describe('what §4 allows', () => {
  it('S27 three days late on 20 bins proposes one partial week at $40, nothing else', async () => {
    const r = await lateRental({ bins: 20, dueDaysAgo: 3 });
    const { proposals } = await charges(r.id);
    const late = proposals.find(p => p.kind === 'late');
    expect(late).toMatchObject({ qty: 1, unit_cents: 4000, amount_cents: 4000, taxable: 1 });
    expect(late.reason).toMatch(/1 week past/);
    // Under 48h? No — 3 days is past it, so §7 is offered too, as a separate line.
    expect(proposals.filter(p => p.section === 7)).toHaveLength(1);
  });

  it('eight days late is two weeks; the extra-week rate follows the package', async () => {
    const r = await lateRental({ bins: 60, dueDaysAgo: 8 });
    const late = (await charges(r.id)).proposals.find(p => p.kind === 'late');
    expect(late).toMatchObject({ qty: 2, unit_cents: 9000, amount_cents: 18000 });
  });

  it('one day late is still a partial week; on time is nothing', async () => {
    const r = await lateRental({ dueDaysAgo: 1 });
    const { proposals } = await charges(r.id);
    expect(proposals.find(p => p.kind === 'late').qty).toBe(1);
    expect(proposals.find(p => p.section === 7)).toBeUndefined();   // 24h < 48h

    const onTime = await lateRental({ dueDaysAgo: -2 });
    expect((await charges(onTime.id)).proposals).toHaveLength(0);
  });

  it('S28 counting the bins back turns a shortfall into a charge; marking them lost is separate and nagged for', async () => {
    const r = await lateRental({ bins: 20, returned: true, dueDaysAgo: 0 });
    expect((await charges(r.id)).proposals).toHaveLength(0);
    await ok(`/rentals/${r.id}/counted`, { method: 'POST', body: { bins_returned: 18 } });
    const { proposals } = await charges(r.id);
    const missing = proposals.find(p => p.kind === 'missing');
    expect(missing).toMatchObject({ qty: 2, unit_cents: 1500, amount_cents: 3000 });
    expect(proposals.find(p => p.blocked)?.blocked).toMatch(/2 bins are unaccounted for but none are marked lost/);

    const { items } = await ok('/items');
    for (const b of items.slice(0, 2)) await ok(`/items/${b.id}`, { method: 'PATCH', body: { condition: 'lost', rental_id: r.id } });
    const after = await charges(r.id);
    expect(after.proposals.find(p => p.blocked)).toBeUndefined();
    expect(after.proposals.find(p => p.kind === 'missing').bin_labels).toBe('B-001, B-002');
    expect((await ok('/settings')).fleetTotal).toBe(58);

    const over = await api(`/rentals/${r.id}/counted`, { method: 'POST', body: { bins_returned: 21 } });
    expect(over.status).toBe(400);
  });

  it('damage is priced per bin flagged to the rental, and names them', async () => {
    const r = await lateRental({ returned: true, dueDaysAgo: 0 });
    const { items } = await ok('/items');
    await ok(`/items/${items[4].id}`, { method: 'PATCH', body: { condition: 'damaged', notes: 'Tape residue', rental_id: r.id } });
    await ok(`/items/${items[7].id}`, { method: 'PATCH', body: { condition: 'damaged', rental_id: r.id } });
    const dmg = (await charges(r.id)).proposals.find(p => p.kind === 'damage');
    expect(dmg).toMatchObject({ qty: 2, amount_cents: 3000, bin_labels: 'B-005, B-008' });
  });

  it('I8 a damaged dolly is flagged for a human, never priced', async () => {
    const r = await lateRental({ returned: true, dueDaysAgo: 0 });
    await ok('/items', { method: 'POST', body: { kind: 'dolly', count: 1 } });
    const dolly = (await ok('/items?kind=dolly')).items[0];
    await ok(`/items/${dolly.id}`, { method: 'PATCH', body: { condition: 'damaged', rental_id: r.id } });
    const { proposals } = await charges(r.id);
    expect(proposals.find(p => p.kind === 'damage')).toBeUndefined();
    expect(proposals.find(p => p.blocked).blocked).toMatch(/D-001 \(damaged\).*only sets a rate for bins/);
  });

  it('§7 is offered only while the bins are still out, and replaces the late fee once taken', async () => {
    const r = await lateRental({ bins: 10, dueDaysAgo: 5 });
    const seven = (await charges(r.id)).proposals.find(p => p.section === 7);
    expect(seven).toMatchObject({ kind: 'missing', qty: 10, amount_cents: 15000 });
    await ok(`/rentals/${r.id}/charges`, { method: 'POST', body: { kind: seven.kind, qty: seven.qty, unit_cents: seven.unit_cents, reason: seven.reason } });
    const { proposals } = await charges(r.id);
    expect(proposals.find(p => p.section === 7)).toBeUndefined();
  });
});

describe('deciding', () => {
  it('adding a proposal records who; it is not proposed twice; waiving needs a reason and sticks', async () => {
    const r = await lateRental({ dueDaysAgo: 3 });
    const late = (await charges(r.id)).proposals.find(p => p.kind === 'late');
    const added = await ok(`/rentals/${r.id}/charges`, { method: 'POST', body: { kind: 'late', qty: late.qty, unit_cents: late.unit_cents, reason: late.reason } });
    expect(added.charges[0]).toMatchObject({ kind: 'late', amount_cents: 4000, created_by: OWNER, waived_at: null });
    expect((await charges(r.id)).proposals.find(p => p.kind === 'late')).toBeUndefined();

    expect((await api(`/charges/${added.charges[0].id}/waive`, { method: 'POST', body: {} })).status).toBe(400);
    const w = await ok(`/charges/${added.charges[0].id}/waive`, { method: 'POST', body: { reason: 'Bereavement' } });
    expect(w.charges[0]).toMatchObject({ waived_by: OWNER, waive_reason: 'Bereavement' });
    // S29: still not proposed — the decision was made.
    expect((await charges(r.id)).proposals.find(p => p.kind === 'late')).toBeUndefined();
    expect((await charges(r.id)).owed_cents).toBe(0);
  });

  it('a hand-entered charge must say what it is for, and price sanely', async () => {
    const r = await lateRental();
    expect((await api(`/rentals/${r.id}/charges`, { method: 'POST', body: { kind: 'other', qty: 1, unit_cents: 500 } })).error).toMatch(/customer sees/);
    expect((await api(`/rentals/${r.id}/charges`, { method: 'POST', body: { kind: 'other', qty: 1, unit_cents: 0, reason: 'x' } })).status).toBe(400);
    expect((await api(`/rentals/${r.id}/charges`, { method: 'POST', body: { kind: 'fee', qty: 1, unit_cents: 500, reason: 'x' } })).status).toBe(400);
    const c = await ok(`/rentals/${r.id}/charges`, { method: 'POST', body: { kind: 'other', qty: 3, unit_cents: 500, reason: 'Extra flights of stairs', taxable: false } });
    expect(c.charges[0]).toMatchObject({ amount_cents: 1500, taxable: 0 });
  });
});

describe('collecting', () => {
  it('C19 charges go out itemised on one invoice, taxed at the delivery city rate, and charged to the card on file', async () => {
    const r = await lateRental({ bins: 20, dueDaysAgo: 3, returned: true, card: true });
    await ok(`/rentals/${r.id}/counted`, { method: 'POST', body: { bins_returned: 19 } });
    const { proposals } = await charges(r.id);
    for (const p of proposals.filter(p => !p.blocked)) {
      await ok(`/rentals/${r.id}/charges`, { method: 'POST', body: { kind: p.kind, qty: p.qty, unit_cents: p.unit_cents, reason: p.reason, bin_labels: p.bin_labels, taxable: true } });
    }
    const before = await charges(r.id);
    expect(before.outstanding_cents).toBe(4000 + 1500);
    expect(before.card).toMatchObject({ last4: '4242' });

    const inv = await ok(`/rentals/${r.id}/charges/invoice`, { method: 'POST' });
    expect(inv.charges.every(c => c.square_invoice_id && c.invoiced_at)).toBe(true);
    expect(new Set(inv.charges.map(c => c.square_invoice_id)).size).toBe(1);
    // Paid on publish: the fake behaves like Square with CARD_ON_FILE.
    expect(inv.charges.every(c => c.square_status === 'PAID')).toBe(true);

    const calls = await squareCalls();
    const order = calls.find(c => c.path === '/v2/orders').body.order;
    expect(order.line_items.map(l => [l.name, l.quantity, l.base_price_money.amount])).toEqual([
      ['Late return', '1', 4000],
      ['Unreturned bins', '1', 1500],
    ]);
    expect(order.taxes[0]).toMatchObject({ name: 'Utah sales tax', percentage: '7.25', scope: 'ORDER' });   // Clinton
    const invoice = calls.find(c => c.path === '/v2/invoices').body.invoice;
    expect(invoice.payment_requests[0]).toMatchObject({ automatic_payment_source: 'CARD_ON_FILE', card_id: 'card_9' });
    expect(invoice.delivery_method).toBe('EMAIL');
    expect((await charges(r.id)).outstanding_cents).toBe(0);
  });

  it('with no card on file, the invoice is emailed for the customer to pay, and stays outstanding until they do', async () => {
    const r = await lateRental({ dueDaysAgo: 3, returned: true });
    await ok(`/rentals/${r.id}/charges`, { method: 'POST', body: { kind: 'late', qty: 1, unit_cents: 4000, reason: 'Late' } });
    const inv = await ok(`/rentals/${r.id}/charges/invoice`, { method: 'POST' });
    expect(inv.charges[0].square_status).toBe('UNPAID');
    expect(inv.charges[0].square_invoice_url).toMatch(/pay-invoice/);
    const invoice = (await squareCalls()).find(c => c.path === '/v2/invoices').body.invoice;
    expect(invoice.payment_requests[0].automatic_payment_source).toBe('NONE');
    // Once on an invoice, it is Square's to cancel — not waivable here.
    expect((await api(`/charges/${inv.charges[0].id}/waive`, { method: 'POST', body: { reason: 'x' } })).status).toBe(409);
  });

  it('a mixed invoice taxes only the taxable lines', async () => {
    const r = await lateRental({ dueDaysAgo: 3, returned: true });
    await ok(`/rentals/${r.id}/charges`, { method: 'POST', body: { kind: 'late', qty: 1, unit_cents: 4000, reason: 'Late', taxable: true } });
    await ok(`/rentals/${r.id}/charges`, { method: 'POST', body: { kind: 'other', qty: 1, unit_cents: 2000, reason: 'Stairs', taxable: false } });
    await ok(`/rentals/${r.id}/charges/invoice`, { method: 'POST' });
    const order = (await squareCalls()).find(c => c.path === '/v2/orders').body.order;
    expect(order.taxes[0].scope).toBe('LINE_ITEM');
    expect(order.line_items[0].applied_taxes).toEqual([{ tax_uid: 'utah-sales-tax' }]);
    expect(order.line_items[1].applied_taxes).toBeUndefined();
  });

  it('nothing outstanding means nothing to invoice', async () => {
    const r = await lateRental();
    expect((await api(`/rentals/${r.id}/charges/invoice`, { method: 'POST' })).status).toBe(400);
  });
});
