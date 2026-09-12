import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { rentalWithLink, open, post, card, rental, mail, billing, billingFails, audit, weekday } from './helpers.js';

const address = (over = {}) => ({
  step: 'address', delivery_street: '612 N Sycamore Ave', delivery_unit: 'Apt 4', delivery_city: 'Sunset', delivery_zip: '84015',
  delivery_notes: 'Gate code 4471', same: 'on', ...over,
});

/* Walks the customer up to a given step. */
async function upTo(step, over = {}) {
  const r = await rentalWithLink(over);
  if (step === 'review') return r;
  await post(r.token, { step: 'review' });
  if (step === 'address') return r;
  await post(r.token, address());
  if (step === 'agreement') return r;
  await post(r.token, { step: 'agreement', agreement_name: 'Dana Whitfield', accept: 'on' });
  if (step === 'card') return r;
  await card(r.token, { sourceId: 'cnon:card-nonce-ok', verificationToken: 'verf:1', holderName: 'Dana Whitfield', postalCode: '84015' });
  return r;
}

describe('opening the link', () => {
  it('C8 shows the package, dates and the price with tax for their city', async () => {
    const r = await rentalWithLink({ delivery_city: 'Riverdale', total_cents: 7900 });   // 7.45%
    const page = await open(r.token);
    expect(page.status).toBe(200);
    expect(page.html).toContain('20 bins');
    expect(page.html).toContain('$79');
    expect(page.html).toContain('$84.89');   // 7900 × 1.0745, rounded
    expect(page.html).toContain('7.45%');
    expect(page.html).toMatch(/1\. Your rental/);
  });

  it('C9 a made-up link is a 404 that says nothing', async () => {
    for (const t of ['nope', crypto.randomUUID(), '../../etc']) {
      const page = await open(t);
      expect(page.status).toBe(404);
      expect(page.html).not.toMatch(/bins arriving|\$\d/);
    }
  });

  it('C15 a cancelled rental says so rather than pretending the link is broken', async () => {
    const r = await rentalWithLink({ status: 'cancelled' });
    const page = await open(r.token);
    expect(page.status).toBe(410);
    expect(page.html).toMatch(/cancelled/i);
    expect(page.html).not.toMatch(/Pay|Sign/);
    // And posting to it does nothing.
    expect((await post(r.token, address())).status).toBe(410);
    expect((await rental(r.id)).delivery_address).toBeNull();
  });

  it('the steps are gated: you cannot sign before an address, and cannot skip ahead', async () => {
    const r = await rentalWithLink();
    expect((await open(r.token)).html).toMatch(/Your rental/);
    // Signing with no address saved is refused (no address yet → agreement step is not reachable).
    const early = await post(r.token, { step: 'agreement', agreement_name: 'Dana Whitfield', accept: 'on' });
    expect((await rental(r.id)).agreement_signed_at).toBeNull();
    // Sent back to where they actually are, not shown an error.
    expect(early.status).toBe(303);
    expect(early.location).toBe(`/${r.token}`);
  });
});

describe('addresses', () => {
  it('C10 delivery with unit and zip; pickup the same, or different', async () => {
    const r = await upTo('address');
    const res = await post(r.token, address());
    expect(res.status).toBe(303);
    const row = await rental(r.id);
    expect(row.delivery_address).toBe('612 N Sycamore Ave, Apt 4, Sunset UT 84015');
    expect(row.pickup_address).toBe(row.delivery_address);
    expect(row.delivery_notes).toBe('Gate code 4471');
    expect(row.pickup_notes).toBeNull();

    await post(r.token, address({ same: '', pickup_street: '88 W 1200 S', pickup_city: 'Clearfield', pickup_zip: '84015', pickup_notes: 'Side door' }));
    const two = await rental(r.id);
    expect(two.pickup_address).toBe('88 W 1200 S, Clearfield UT 84015');
    expect(two.pickup_notes).toBe('Side door');
    // The next page is the agreement.
    expect((await open(r.token)).html).toMatch(/Rental Agreement/);
  });

  it('a city off the list, a bad zip, or a blank street is sent back with a reason', async () => {
    const r = await upTo('address');
    expect((await post(r.token, address({ delivery_city: 'Provo' }))).html).toMatch(/choose a delivery city/);
    expect((await post(r.token, address({ delivery_zip: '8401' }))).html).toMatch(/five-digit/);
    expect((await post(r.token, address({ delivery_street: '' }))).html).toMatch(/street address/);
    expect((await rental(r.id)).delivery_address).toBeNull();
  });

  it('changing the delivery address after signing is written to the history', async () => {
    const r = await upTo('card');
    await post(r.token, address({ delivery_street: '99 Moved Ln' }));
    const log = await audit();
    expect(log.find(e => e.action === 'rental.address_changed').detail).toMatch(/612 N Sycamore Ave.*→ 99 Moved Ln/);
  });
});

describe('signing', () => {
  it('C11 the typed name has to be theirs — or say it is on their behalf', async () => {
    const r = await upTo('agreement');
    const junk = await post(r.token, { step: 'agreement', agreement_name: 'dfenklsfdskl', accept: 'on' });
    expect(junk.status).toBe(200);
    expect(junk.html).toMatch(/on_behalf/);
    expect((await rental(r.id)).agreement_signed_at).toBeNull();

    // A surname match is enough — "D. Whitfield", "Dana Whitfield-Ng".
    await post(r.token, { step: 'agreement', agreement_name: 'D Whitfield', accept: 'on' });
    expect((await rental(r.id)).agreement_name).toBe('D Whitfield');
  });

  it('on behalf of someone is allowed and recorded as such', async () => {
    const r = await upTo('agreement');
    await post(r.token, { step: 'agreement', agreement_name: 'Marcus Whitfield-Reyes', accept: 'on', on_behalf: 'on' });
    const row = await rental(r.id);
    expect(row.signed_on_behalf).toBe(1);
    expect((await audit()).find(e => e.action === 'rental.agreement_signed').detail).toMatch(/\(on behalf\)/);
  });

  it('C12 signing records the version, IP and browser, and emails a copy; it cannot be signed twice', async () => {
    const r = await upTo('agreement');
    const before = new Date().toISOString();
    expect((await post(r.token, { step: 'agreement', agreement_name: 'Dana Whitfield' })).html).toMatch(/tick the box/);
    await post(r.token, { step: 'agreement', agreement_name: 'Dana Whitfield', accept: 'on' });
    const row = await rental(r.id);
    expect(row).toMatchObject({ agreement_name: 'Dana Whitfield', agreement_ip: '203.0.113.9', agreement_ua: 'TestBrowser/1.0' });
    expect(row.agreement_version).toMatch(/^[0-9a-f]{12}$/);
    expect(row.agreement_signed_at >= before.slice(0, 19)).toBe(true);
    const copy = (await mail()).find(m => /agreement/i.test(m.subject));
    expect(copy.to).toEqual(['dana@example.com']);
    expect(copy.text).toContain('Dana Whitfield');

    await post(r.token, { step: 'agreement', agreement_name: 'Someone Else', accept: 'on', on_behalf: 'on' });
    expect((await rental(r.id)).agreement_name).toBe('Dana Whitfield');
    expect((await mail()).filter(m => /agreement/i.test(m.subject))).toHaveLength(1);
  });

  it('after signing, the next step is the card — never payment without one', async () => {
    const r = await upTo('card');
    const page = await open(r.token);
    expect(page.html).toMatch(/card/i);
    expect(page.html).toContain('sandbox-sq0idb');   // Square's SDK is loaded with our app id
  });
});

describe('paying', () => {
  it('C13 storing the card charges the rental and the page says paid', async () => {
    const r = await upTo('done');
    const calls = await billing();
    expect(calls.map(c => c.op)).toEqual(['storeCard', 'charge']);
    expect(calls[0].payload).toMatchObject({ sourceId: 'cnon:card-nonce-ok', holderName: 'Dana Whitfield' });
    const row = await rental(r.id);
    expect(row.status).toBe('confirmed');
    expect(row.paid_at).toBeTruthy();
    const page = await open(r.token);
    expect(page.html).toMatch(/all set/);
    expect(page.html).toContain('View your receipt');
  });

  it('C14 revisiting after paying never asks for money again', async () => {
    const r = await upTo('done');
    for (const step of [undefined, 'review', 'address']) {
      const page = await open(r.token, step);
      expect(page.html).toMatch(/all set/);
      expect(page.html).not.toMatch(/Pay now|card-container/);
    }
    // A second card post is a no-op, not a second charge.
    await card(r.token, { sourceId: 'cnon:again' });
    expect((await billing()).filter(c => c.op === 'charge')).toHaveLength(1);
  });

  it('a card cannot be stored before the agreement is signed', async () => {
    const r = await upTo('agreement');
    const res = await card(r.token, { sourceId: 'cnon:early' });
    expect(res.status).toBe(409);
    expect(await billing()).toHaveLength(0);
  });

  it('a stored card survives a failed charge — the authorisation is the thing to keep', async () => {
    const r = await upTo('card');
    await billingFails({ charge: 'card declined' });
    const res = await card(r.token, { sourceId: 'cnon:x' });
    expect(res.ok).toBe(true);
    const row = await rental(r.id);
    expect(row.square_card_id).toBe('card_1');
    expect(row.paid_at).toBeNull();
    const page = await open(r.token);
    expect(page.html).toMatch(/Pay/);
  });
});

describe('the window', () => {
  it('is shown to the customer once they are all set, and in the day-before reminder', async () => {
    const r = await rentalWithLink();
    await env.DB.prepare("UPDATE rentals SET delivery_window = '6–8pm', pickup_window = 'after 5' WHERE id = ?1").bind(r.id).run();
    await post(r.token, { step: 'review' });
    await post(r.token, { step: 'address', delivery_street: '1 Main St', delivery_city: 'Clinton', delivery_zip: '84015', same: 'on' });
    await post(r.token, { step: 'agreement', agreement_name: 'Dana Whitfield', accept: 'on' });
    await card(r.token, { sourceId: 'cnon:ok' });
    const page = await open(r.token);
    expect(page.html).toContain('6–8pm');
    expect(page.html).toContain('after 5');

    const { Mailer } = await import('../src/index.js');
    const res = await new Mailer({}, env).sendReminder({ to: 'dana@example.com', name: 'Dana', job: 'deliver', date: r.start_date, bins: 20, window: '6–8pm', address: '1 Main St, Clinton UT 84015', dueDate: r.due_date });
    expect(res.ok).toBe(true);
    const m = (await mail()).at(-1);
    expect(m.subject).toMatch(/tomorrow/i);
    expect(m.text).toContain('between 6–8pm');
    expect(m.text).toContain('1 Main St');
    const back = await new Mailer({}, env).sendReminder({ to: 'dana@example.com', name: 'Dana', job: 'collect', date: r.due_date, bins: 20, window: null, address: '1 Main St', dueDate: r.due_date });
    expect(back.ok).toBe(true);
    expect((await mail()).at(-1).text).toMatch(/stacked.*front door/i);
  });
});
