/* One row per person.

   Matched by email first, then by phone — the two things a customer types
   the same way twice. Details fill in rather than overwrite: a later request
   with a surname adds it; a later request with a different surname does not
   rename someone. Both Workers use this, so a website submission and a
   phone-in land on the same person. */

export const emailKey = v => { const s = String(v ?? '').trim().toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null; };
export const phoneKey = v => {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? d : null;
};

export async function customerFor(env, { email, phone, first_name, last_name, city }, by = 'system') {
  const e = emailKey(email), p = phoneKey(phone);
  if (!e && !p) return null;

  let row = e ? await env.DB.prepare('SELECT * FROM customers WHERE email = ?1').bind(e).first() : null;
  if (!row && p) {
    /* A phone matches only when one side has no email. Two different emails
       on one phone are two people who share a line — a couple, a parent and
       a student — not one person with two addresses. */
    const byPhone = await env.DB.prepare('SELECT * FROM customers WHERE phone = ?1').bind(p).first();
    if (byPhone && (!e || !byPhone.email)) row = byPhone;
  }

  if (!row) {
    const res = await env.DB.prepare(
      'INSERT INTO customers (email, phone, first_name, last_name, city) VALUES (?1,?2,?3,?4,?5)',
    ).bind(e, p, first_name || null, last_name || null, city || null).run();
    return res.meta.last_row_id;
  }

  // Fill blanks; never overwrite what is there. A phone-only person who now
  // gives an email gains it — unless that email already belongs to someone.
  const patch = {};
  if (!row.email && e) {
    const clash = await env.DB.prepare('SELECT id FROM customers WHERE email = ?1').bind(e).first();
    if (!clash) patch.email = e;
  }
  if (!row.phone && p) patch.phone = p;
  // The phone-only row now has an email: take it (unique index permitting).
  if (row.email == null && e && !patch.email) {
    const clash = await env.DB.prepare('SELECT id FROM customers WHERE email = ?1').bind(e).first();
    if (!clash) patch.email = e;
  }
  if (!row.first_name && first_name) patch.first_name = first_name;
  if (!row.last_name && last_name) patch.last_name = last_name;
  if (!row.city && city) patch.city = city;
  if (Object.keys(patch).length) {
    const sets = Object.keys(patch).map((k, i) => `${k} = ?${i + 1}`).join(', ');
    await env.DB.prepare(`UPDATE customers SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_by = ?${Object.keys(patch).length + 1} WHERE id = ?${Object.keys(patch).length + 2}`)
      .bind(...Object.values(patch), by, row.id).run();
  }
  return row.id;
}
