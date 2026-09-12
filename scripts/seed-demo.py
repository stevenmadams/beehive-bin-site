#!/usr/bin/env python3
"""Plant one of everything, so the panel can be tested by hand.

    python3 scripts/seed-demo.py            # local dev database
    python3 scripts/seed-demo.py --remote   # the live one
    python3 scripts/seed-demo.py --remove [--remote]

Every row it writes is marked — emails end in @demo.example.com, labels start
with T-, created_by is 'demo-seed' — so --remove takes exactly those out and
nothing else. Dates are relative to today (Mountain Time), so the same seed
gives a live-looking board whenever it is run: something delivering tonight,
something overdue, something to inspect, something to settle.

It writes SQL, not API calls: the panel's rules (a photo before delivery, a
signature before payment) are the thing being tested, not the thing seeding.
"""
import argparse, datetime, json, os, subprocess, sys, tempfile, uuid
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, 'workers/admin/wrangler.toml')
TODAY = datetime.datetime.now(ZoneInfo('America/Denver')).date()

def d(n):            # a date n days from today, YYYY-MM-DD
    return (TODAY + datetime.timedelta(days=n)).isoformat()
def wd(n):           # like d(), but never a Sunday
    x = TODAY + datetime.timedelta(days=n)
    while x.weekday() == 6: x += datetime.timedelta(days=1)
    return x.isoformat()
def ts(n, hour=19, minute=0):   # an instant n days from today at hour:minute Mountain, as UTC ISO
    local = datetime.datetime.combine(TODAY + datetime.timedelta(days=n), datetime.time(hour, minute), ZoneInfo('America/Denver'))
    return local.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
class Raw(str): pass   # a SQL fragment (a subquery), not a string value
def q(v):
    if v is None: return 'NULL'
    if isinstance(v, Raw): return str(v)
    if isinstance(v, bool): return '1' if v else '0'
    if isinstance(v, (int, float)): return str(v)
    return "'" + str(v).replace("'", "''") + "'"
def ins(table, **cols):
    return f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join(q(v) for v in cols.values())});"

SEED = 'demo-seed'
PRICES = {10: 3900, 20: 7900, 40: 12900, 60: 17900}
EXTRA = {10: 2500, 20: 4000, 40: 6500, 60: 9000}
def total(bins, weeks): return PRICES[bins] + (weeks - 1) * EXTRA[bins]

# ---- the people -------------------------------------------------------------
PEOPLE = [
  # key,        first,     last,        email,                         phone,        city,        pref
  ('dana',    'Dana',    'Whitfield', 'dana@demo.example.com',     '8015550101', 'Clinton',    'text'),
  ('marcus',  'Marcus',  'Webb',      'marcus@demo.example.com',   '8015550102', 'Syracuse',   'call'),
  ('priya',   'Priya',   'Natarajan', 'priya@demo.example.com',    '8015550103', 'Layton',     'email'),
  ('tom',     'Tom',     'Eriksen',   'tom@demo.example.com',      '8015550104', 'Roy',        'text'),
  ('lena',    'Lena',    'Ortiz',     'lena@demo.example.com',     '8015550105', 'Kaysville',  'text'),
  ('sam',     'Sam',     'Okafor',    'sam@demo.example.com',      '8015550106', 'Clearfield', 'call'),
  ('jo',      'Jo',      'Halvorsen', 'jo@demo.example.com',       '8015550107', 'Riverdale',  'email'),
  ('rae',     'Rae',     'Lund',      'rae@demo.example.com',      '8015550108', 'Sunset',     'text'),
  ('ben',     'Ben',     'Castillo',  'ben@demo.example.com',      '8015550109', 'Ogden',      'call'),
  ('mei',     'Mei',     'Tanaka',    'mei@demo.example.com',      '8015550110', 'Farmington', 'text'),
  ('quinn',   'Quinn',   None,        None,                        '8015550111', None,         'call'),   # phone only
  ('ada',     'Ada',     'Brennan',   'ada@demo.example.com',      '8015550112', 'West Point', 'email'),
]

def build():
    sql = ['PRAGMA defer_foreign_keys = true;']
    cid = {}
    for key, first, last, email, phone, city, pref in PEOPLE:
        cid[key] = Raw(f"(SELECT id FROM customers WHERE {'email = ' + q(email) if email else 'phone = ' + q(phone)})")
        sql.append(ins('customers', email=email, phone=phone, first_name=first, last_name=last, city=city, updated_by=SEED))
    P = {p[0]: p for p in PEOPLE}

    # ---- inventory: 200 bins, 4 dollies, 2 hand trucks -------------------
    # Enough that the live rentals below can each have their own bins, with
    # twenty spare — so Mei's 60-bin request goes red on the stoplight.
    for i in range(1, 201):
        sql.append(ins('items', kind='bin', label=f'T-{i:03d}', condition='good', acquired_on=d(-90), cost_cents=2450, created_by=SEED))
    for i in range(1, 5):
        sql.append(ins('items', kind='dolly', label=f'TD-{i:03d}', condition='good', acquired_on=d(-60), cost_cents=8900, created_by=SEED))
    sql.append(ins('items', kind='hand_truck', label='THT-001', condition='good', acquired_on=d(-60), cost_cents=14000, created_by=SEED))
    sql.append(ins('items', kind='hand_truck', label='THT-002', condition='damaged', notes='Bent axle', acquired_on=d(-60), cost_cents=14000, created_by=SEED))
    item = lambda label: Raw(f"(SELECT id FROM items WHERE label = {q(label)})")

    # ---- requests ---------------------------------------------------------
    def request(key, kind='reserve', bins=None, weeks=None, start=None, status='new', notes=None, message=None,
                decided=None, reason=None, source='web', created=None, pcity=None):
        _, first, last, email, phone, city, pref = P[key]
        sql.append(ins('requests', kind=kind, status=status, first_name=first, last_name=last, email=email, phone=phone,
            bins=bins, weeks=weeks, start_date=start,
            return_date=((datetime.date.fromisoformat(start) + datetime.timedelta(days=7 * weeks)).isoformat() if start and weeks else None),
            quoted_total_cents=(total(bins, weeks) if bins else None), delivery_city=city, pickup_city=pcity,
            customer_notes=notes, message=message, decided_at=decided, decided_by=('admin@beehivebin.co' if decided else None),
            decline_reason=reason, raw_json=json.dumps({'seed': SEED}), source=source, contact_pref=pref,
            created_at=created or ts(-1, 10), customer_id=cid[key]))
        return Raw("(SELECT id FROM requests WHERE raw_json LIKE '%demo-seed%' ORDER BY id DESC LIMIT 1)")

    # open questions
    request('priya', bins=10, weeks=1, start=wd(5), notes='Third floor, no elevator. Text when you are close.', created=ts(0, 8, 40))
    request('ben', bins=20, weeks=2, start=wd(9), source='manual', notes='Wants the bins before the movers on Saturday.', created=ts(-1, 15))
    request('mei', bins=60, weeks=1, start=wd(3), created=ts(-2, 19))                       # will not fit: the 60s are out
    request('quinn', kind='contact', message='Do you deliver to Hooper? And can I get 15 instead of 20?', created=ts(0, 7, 15))
    request('ada', bins=10, weeks=1, start=d(-3), created=ts(-8, 12))                        # lapsed
    # answered ones, on the customer
    request('rae', bins=40, weeks=1, start=wd(4), status='declined', decided=ts(-1, 9), reason='No bins free that week — offered the following Monday', created=ts(-3, 11))
    request('tom', kind='contact', message='Left a voicemail about a storage unit move.', status='declined', decided=ts(-6, 9), reason='Never picked up', created=ts(-7, 14))

    # ---- rentals ----------------------------------------------------------
    R = {}
    def rental(key, name, bins, weeks, start, status, created=None, **more):
        _, first, last, email, phone, city, pref = P[key]
        due = (datetime.date.fromisoformat(start) + datetime.timedelta(days=7 * weeks)).isoformat()
        req = request(key, bins=bins, weeks=weeks, start=start, status='converted', decided=created or ts(-3, 10), created=created or ts(-3, 9))
        addr = more.pop('addr', None)
        cols = dict(request_id=req, created_by=SEED, status=status, first_name=first, last_name=last, email=email, phone=phone,
                    contact_pref=pref, bins=bins, weeks=weeks, start_date=start, due_date=due, total_cents=total(bins, weeks),
                    delivery_city=city, pickup_city=city, delivery_window='6–8pm', pickup_window='6–8pm',
                    confirm_token=str(uuid.uuid4()), created_at=created or ts(-3, 10), customer_id=cid[key])
        if addr:
            street, unit, zipc = addr
            line = ', '.join(x for x in [street, unit, f'{city} UT {zipc}'] if x)
            cols.update(delivery_street=street, delivery_unit=unit, delivery_zip=zipc, delivery_address=line,
                        pickup_street=street, pickup_unit=unit, pickup_zip=zipc, pickup_address=line)
        cols.update(more)
        # The business day of each visit, beside the instant.
        for col in ('delivered', 'returned'):
            if cols.get(f'{col}_at'):
                utc = datetime.datetime.strptime(cols[f'{col}_at'], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
                cols[f'{col}_on'] = utc.astimezone(ZoneInfo('America/Denver')).date().isoformat()
        sql.append(ins('rentals', **cols))
        R[name] = Raw(f"(SELECT id FROM rentals WHERE confirm_token = {q(cols['confirm_token'])})")
        return R[name]

    signed = lambda key, n: dict(agreement_signed_at=ts(n, 20, 5), agreement_name=f'{P[key][1]} {P[key][2]}', agreement_ip='203.0.113.9',
                                 agreement_ua='Mozilla/5.0 (iPhone)', agreement_version='ce7dff2a2378', details_confirmed_at=ts(n, 20), confirm_sent_at=ts(n, 9))
    paid = lambda n, cents: dict(paid_at=ts(n, 20, 9), square_customer_id='cust_demo', square_order_id='ord_demo', square_invoice_id=f'inv_demo_{n}',
                                 square_invoice_url='https://squareup.com/pay-invoice/demo', square_status='PAID',
                                 square_card_id='card_demo', card_brand='VISA', card_last4='4242', card_exp='12/30', card_stored_at=ts(n, 20, 8))

    # A. booked, link not sent yet — approved an hour ago
    rental('priya', 'A', 10, 1, wd(6), 'booked', created=ts(0, 8), addr=None)
    # B. booked, link sent, waiting on the customer
    rental('marcus', 'B', 20, 1, wd(4), 'booked', created=ts(-2, 10), confirm_sent_at=ts(-2, 10, 5), delivery_slot='18:00', delivery_window='6–7pm')
    # C. booked and stalled — start date passed, never confirmed
    rental('ben', 'C', 20, 1, d(-2), 'booked', created=ts(-9, 10), confirm_sent_at=ts(-9, 10, 5))
    # D. confirmed, delivering the day after tomorrow, bins picked
    rental('lena', 'D', 40, 1, wd(2), 'confirmed', created=ts(-5, 10), addr=('1900 W Storage Way', 'Unit 214', '84037'),
           delivery_slot='17:00', delivery_window='5–6pm', pickup_slot='18:00', pickup_window='6–7pm',
           delivery_notes='Gate code 4471. Dog in the yard — friendly.', **signed('lena', -4), **paid(-4, total(40, 1)))
    # E. confirmed, delivering TONIGHT
    rental('sam', 'E', 20, 1, d(0), 'confirmed', created=ts(-6, 10), addr=('88 W 1200 S', None, '84015'),
           delivery_slot='18:00', delivery_window='6–7pm', delivery_notes='Leave them on the porch, we are at work until 6.',
           **signed('sam', -5), **paid(-5, total(20, 1)))
    # F. out — Dana's second rental — due in 5 days
    rental('dana', 'F', 20, 1, wd(-2), 'out', created=ts(-8, 10), addr=('612 N Sycamore Ave', 'Apt 4', '84015'),
           delivery_slot='19:00', delivery_window='7–8pm', pickup_slot='19:00', pickup_window='7–8pm',
           delivered_at=ts(-2, 19, 22), delivered_by='admin@beehivebin.co', reminded_delivery_at=ts(-3, 9),
           **signed('dana', -7), **paid(-7, total(20, 1)))
    # G. out and OVERDUE — due 3 days ago
    rental('jo', 'G', 40, 1, d(-10), 'out', created=ts(-14, 10), addr=('2201 Harrison Blvd', None, '84401'),
           delivered_at=ts(-10, 18, 40), delivered_by='admin@beehivebin.co', reminded_delivery_at=ts(-11, 9), reminded_pickup_at=ts(-4, 9),
           **signed('jo', -13), **paid(-13, total(40, 1)))
    # H. back — collected tonight, not yet inspected
    rental('tom', 'H', 20, 2, d(-14), 'back', created=ts(-18, 10), addr=('4410 S 1900 W', None, '84067'),
           delivered_at=ts(-14, 19), delivered_by='admin@beehivebin.co', returned_at=ts(0, 17, 45), returned_by='admin@beehivebin.co',
           **signed('tom', -17), **paid(-17, total(20, 2)))
    # I. inspected, SETTLING: two days late, one bin lost, one damaged; late fee drafted, damage waived, missing undecided
    rental('marcus', 'I', 20, 1, d(-11), 'inspected', created=ts(-15, 10), addr=('1740 S 2000 W', None, '84075'),
           delivered_at=ts(-11, 19), delivered_by='admin@beehivebin.co', returned_at=ts(-2, 19, 30), returned_by='admin@beehivebin.co',
           inspected_at=ts(-1, 10), inspected_by='admin@beehivebin.co', bins_returned=19,
           **signed('marcus', -14), **paid(-14, total(20, 1)))
    # J. done — Dana's first rental, three weeks ago, clean
    rental('dana', 'J', 10, 1, d(-28), 'inspected', created=ts(-33, 10), addr=('612 N Sycamore Ave', 'Apt 4', '84015'),
           delivered_at=ts(-28, 19), delivered_by='admin@beehivebin.co', returned_at=ts(-21, 19), returned_by='admin@beehivebin.co',
           inspected_at=ts(-20, 10), inspected_by='admin@beehivebin.co', bins_returned=10,
           **signed('dana', -32), **paid(-32, total(10, 1)))
    # K. done — with a late fee charged and paid
    rental('lena', 'K', 40, 2, d(-40), 'inspected', created=ts(-45, 10), addr=('1900 W Storage Way', 'Unit 214', '84037'),
           delivered_at=ts(-40, 19), delivered_by='admin@beehivebin.co', returned_at=ts(-24, 19), returned_by='admin@beehivebin.co',
           inspected_at=ts(-23, 10), inspected_by='admin@beehivebin.co', bins_returned=40,
           **signed('lena', -44), **paid(-44, total(40, 2)))
    # L. cancelled after payment — refund noted
    rental('rae', 'L', 20, 1, wd(8), 'cancelled', created=ts(-4, 10), **signed('rae', -4), **paid(-4, total(20, 1)))
    # M. out, with a paid extension, due in 9 days
    rental('mei', 'M', 60, 1, d(-5), 'out', created=ts(-9, 10), addr=('355 N Main St', None, '84025'),
           delivered_at=ts(-5, 19), delivered_by='admin@beehivebin.co', **signed('mei', -8), **paid(-8, total(60, 1)))
    sql.append(f"UPDATE rentals SET due_date = {q(d(9))} WHERE id = {R['M']};")

    # ---- bins on the rentals that went out ---------------------------------
    def load(name, first, count):
        for k in range(first, first + count):
            sql.append(ins('rental_items', rental_id=R[name], item_id=item(f'T-{k:03d}'), assigned_at=ts(-1, 12), assigned_by=SEED))
    load('D', 1, 40)      # picked, going out the day after tomorrow
    load('F', 41, 20)     # out
    load('G', 61, 40)     # out, overdue
    load('H', 101, 20)    # back, to inspect
    load('M', 121, 60)    # out, extended

    # I finished before F went out with the same twenty — history, not a clash.
    i_labels = [f'T-{k:03d}' for k in range(41, 61)]
    for k, label in enumerate(i_labels):
        cond = 'damaged' if k == 2 else 'lost' if k == 7 else 'good'
        note = 'Tape residue on the lid' if cond == 'damaged' else 'Not among the stack' if cond == 'lost' else None
        sql.append(ins('rental_items', rental_id=R['I'], item_id=item(label), assigned_at=ts(-11, 18), assigned_by=SEED,
                       back_at=ts(-1, 10), back_by='admin@beehivebin.co', back_condition=cond, back_note=note))
    sql.append(f"UPDATE items SET condition = 'damaged', flagged_rental_id = {R['I']}, notes = 'Tape residue on the lid', updated_by = {q(SEED)} WHERE label = 'T-043';")
    sql.append(f"UPDATE items SET condition = 'lost', flagged_rental_id = {R['I']}, notes = 'Did not come back', updated_by = {q(SEED)} WHERE label = 'T-048';")

    # ---- charges ----------------------------------------------------------
    sql.append(ins('charges', rental_id=R['I'], kind='late', qty=1, unit_cents=4000, amount_cents=4000, taxable=1,
                   reason=f'Late return — 1 week past {d(-4)} (collected {d(-2)})', created_by='admin@beehivebin.co', created_at=ts(-1, 10, 30)))
    sql.append(ins('charges', rental_id=R['I'], kind='damage', qty=1, unit_cents=1500, amount_cents=1500, taxable=1,
                   reason='Damage beyond normal wear — 1 bin', bin_labels='T-043', created_by='admin@beehivebin.co', created_at=ts(-1, 10, 31),
                   waived_at=ts(-1, 10, 40), waived_by='admin@beehivebin.co', waive_reason='Residue came off with the steamer'))
    sql.append(ins('charges', rental_id=R['K'], kind='late', qty=1, unit_cents=6500, amount_cents=6500, taxable=1,
                   reason=f'Late return — 1 week past {d(-26)} (collected {d(-24)})', created_by='admin@beehivebin.co', created_at=ts(-23, 10, 30),
                   square_invoice_id='inv_demo_late_k', square_invoice_url='https://squareup.com/pay-invoice/demo-k', square_status='PAID',
                   invoiced_at=ts(-23, 10, 35), paid_at=ts(-23, 10, 36)))

    # ---- an extension on M ------------------------------------------------
    sql.append(ins('rental_extensions', rental_id=R['M'], weeks=1, amount_cents=9000, previous_due_date=d(2), new_due_date=d(9),
                   reason='Closing pushed a week', created_by='admin@beehivebin.co', created_at=ts(-1, 14),
                   square_invoice_id='inv_demo_ext_m', square_invoice_url='https://squareup.com/pay-invoice/demo-m', square_status='PAID', paid_at=ts(-1, 14, 20)))

    # ---- notes, history, hours, days off ----------------------------------
    note = lambda entity, eid, body, who='admin@beehivebin.co', n=-1, pinned=0: sql.append(
        ins('internal_notes', entity=entity, entity_id=eid, body=body, author=who, created_at=ts(n, 11), pinned=pinned))
    note('rental', R['D'], 'Called to confirm the window — 5–6 works, she will leave the gate open.', n=-1)
    note('rental', R['G'], 'Texted twice about pickup, no reply. Try calling after 6.', n=-2, pinned=1)
    note('rental', R['I'], 'Marcus was apologetic about the late return; waived the damage, keeping the late week.', n=-1)
    note('customer', cid['dana'], 'Second time with us. Moving again in spring — call in March.', n=-1, pinned=1)
    note('request', Raw("(SELECT id FROM requests WHERE first_name = 'Ben' AND raw_json LIKE '%demo-seed%')"), 'Phoned in. Prefers a Saturday drop if we can.', n=-1)

    audit = lambda action, entity, eid, detail, who='admin@beehivebin.co', n=-1, h=10: sql.append(
        ins('audit_log', actor_email=who, action=action, entity=entity, entity_id=eid, detail=detail, at=ts(n, h)))
    audit('request.decline', 'request', Raw("(SELECT id FROM requests WHERE first_name = 'Rae' AND raw_json LIKE '%demo-seed%')"), 'No bins free that week', n=-1, h=9)
    audit('rental.delivered', 'rental', R['F'], 'done=true', n=-2, h=19)
    audit('rental.cancelled_after_payment', 'rental', R['L'], 'Move fell through — $79.00 (100%) to refund in Square, 48h or more before delivery', n=-1, h=16)
    audit('rental.cancel', 'rental', R['L'], 'Move fell through', n=-1, h=16)
    audit('rental.inspection_flags', 'rental', R['I'], 'missing: T-048 · damaged: T-043', n=-1, h=10)
    audit('charge.waive', 'rental', R['I'], 'damage $15.00 waived — Residue came off with the steamer', n=-1, h=10)
    audit('square.invoice.payment_made', 'rental', R['K'], 'PAID', who='square-webhook', n=-23, h=10)
    audit('photos.swept', None, None, '0 photo(s) past 90 days', who='retention', n=0, h=3)
    audit('rental.reminded_deliver', 'rental', R['E'], P['sam'][3], who='reminders', n=-1, h=9)

    owner = Raw("(SELECT id FROM employees WHERE role = 'owner' AND active = 1 ORDER BY id LIMIT 1)")
    for wday in (1, 2, 3, 4, 5, 6):
        sql.append(ins('shifts', employee_id=owner, weekday=wday, start_time='17:00', end_time='21:00', created_by=SEED))
    sql.append(ins('shifts', employee_id=owner, date=wd(6), off=1, note='Dentist', created_by=SEED))
    sql.append(ins('blackouts', date=d(20), reason='Away', created_by=SEED))
    sql.append(ins('blackouts', date=d(21), reason='Away', created_by=SEED))
    sql.append(ins('blackouts', date=d(22), reason='Away', created_by=SEED))
    return '\n'.join(sql)

REMOVE = """
PRAGMA defer_foreign_keys = true;
DELETE FROM rental_items WHERE rental_id IN (SELECT id FROM rentals WHERE created_by = 'demo-seed');
DELETE FROM charges WHERE rental_id IN (SELECT id FROM rentals WHERE created_by = 'demo-seed');
DELETE FROM rental_extensions WHERE rental_id IN (SELECT id FROM rentals WHERE created_by = 'demo-seed');
DELETE FROM internal_notes WHERE (entity = 'rental' AND entity_id IN (SELECT id FROM rentals WHERE created_by = 'demo-seed'))
   OR (entity = 'request' AND entity_id IN (SELECT id FROM requests WHERE raw_json LIKE '%demo-seed%'))
   OR (entity = 'customer' AND entity_id IN (SELECT id FROM customers WHERE email LIKE '%@demo.example.com' OR phone LIKE '80155501%'));
DELETE FROM audit_log WHERE (entity = 'rental' AND entity_id IN (SELECT id FROM rentals WHERE created_by = 'demo-seed'))
   OR (entity = 'request' AND entity_id IN (SELECT id FROM requests WHERE raw_json LIKE '%demo-seed%'))
   OR (actor_email IN ('retention','reminders') AND at > datetime('now', '-2 days'));
DELETE FROM rentals WHERE created_by = 'demo-seed';
DELETE FROM requests WHERE raw_json LIKE '%demo-seed%';
DELETE FROM customers WHERE email LIKE '%@demo.example.com' OR phone LIKE '80155501%';
DELETE FROM items WHERE created_by = 'demo-seed';
DELETE FROM shifts WHERE created_by = 'demo-seed';
DELETE FROM blackouts WHERE created_by = 'demo-seed';
"""

def run(sql, remote):
    with tempfile.NamedTemporaryFile('w', suffix='.sql', delete=False) as f:
        f.write(sql); path = f.name
    cmd = ['npx', 'wrangler', 'd1', 'execute', 'beehive', '-c', CFG, '--file', path,
           '--remote' if remote else '--local']
    if not remote: cmd += ['--persist-to', os.path.join(ROOT, 'workers/admin/.wrangler/state')]
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    os.unlink(path)
    if r.returncode != 0:
        print(r.stdout[-2000:], r.stderr[-2000:], file=sys.stderr); sys.exit(1)
    return r.stdout

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--remote', action='store_true')
    ap.add_argument('--remove', action='store_true')
    ap.add_argument('--print', action='store_true', help='show the SQL instead of running it')
    a = ap.parse_args()
    sql = REMOVE if a.remove else build()
    if a.print: print(sql); sys.exit(0)
    where = 'the LIVE database' if a.remote else 'the local database'
    print(('Removing demo data from ' if a.remove else 'Seeding ') + where + '…')
    run(sql, a.remote)
    print('Done.' if a.remove else 'Done. Remove it later with: python3 scripts/seed-demo.py --remove' + (' --remote' if a.remote else ''))
