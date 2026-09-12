/* Which bins are on which rental.

   A rental knows how many bins it has; inventory knows how many exist. This
   is where the two meet: a row per bin per rental, written when they go out
   and resolved at inspection. Once it exists, "which bin came back cracked"
   and "where is B-017 tonight" are lookups, not memories. */

const now = () => new Date().toISOString().replace(/\.\d+/, '');

/* Bins currently out: on a rental that is not cancelled, and not yet
   resolved by inspection. Includes rentals marked returned but not inspected
   — the bins are in the van, not on the shelf. */
const LIVE = `r.status != 'cancelled' AND ri.back_at IS NULL`;

export async function itemsOn(env, rentalId) {
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.label, i.kind, i.condition, i.notes, i.flagged_rental_id,
            ri.assigned_at, ri.assigned_by, ri.back_at, ri.back_by, ri.back_condition, ri.back_note
     FROM rental_items ri JOIN items i ON i.id = ri.item_id
     WHERE ri.rental_id = ?1 ORDER BY i.kind = 'bin' DESC, i.label`,
  ).bind(rentalId).all();
  return results;
}

/* Where each item is, for the inventory list: { item_id → {rental_id, name, since} }. */
export async function whereabouts(env) {
  const { results } = await env.DB.prepare(
    `SELECT ri.item_id, r.id AS rental_id, r.first_name, r.last_name, r.start_date, r.delivered_at, r.returned_at
     FROM rental_items ri JOIN rentals r ON r.id = ri.rental_id WHERE ${LIVE}`,
  ).all();
  const map = {};
  for (const x of results) {
    map[x.item_id] = {
      rental_id: x.rental_id,
      name: [x.first_name, x.last_name].filter(Boolean).join(' '),
      since: x.delivered_at ? x.delivered_at.slice(0, 10) : null,
      stage: x.returned_at ? 'to inspect' : x.delivered_at ? 'out' : 'assigned',
    };
  }
  return map;
}

class Refusal extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/* Put bins on a rental: by label, or auto-picked from the lowest-numbered
   free ones up to the package size. Refuses a bin that is damaged, on
   another live rental, or unknown, by name — the person is holding it. */
export async function assign(env, user, rental, { labels, auto }) {
  if (rental.status === 'cancelled') throw new Refusal(409, 'This rental is cancelled.');
  if (rental.inspected_at) throw new Refusal(409, 'This rental is finished and inspected.');

  const current = await itemsOn(env, rental.id);
  const room = Math.max(0, (rental.bins || 0) - current.filter(i => i.kind === 'bin').length);
  const taken = await whereabouts(env);

  let picks = [];
  if (auto) {
    if (!room) return { items: current, added: [] };
    const { results } = await env.DB.prepare(
      "SELECT id, label FROM items WHERE kind = 'bin' AND condition = 'good' ORDER BY label").all();
    picks = results.filter(i => !taken[i.id] && !current.some(c => c.id === i.id)).slice(0, room);
    if (!picks.length) throw new Refusal(409, 'No free bins on the list to assign.');
  } else {
    for (const raw of labels || []) {
      const label = String(raw).trim().toUpperCase();
      if (!label) continue;
      const item = await env.DB.prepare('SELECT id, label, kind, condition FROM items WHERE upper(label) = ?1').bind(label).first();
      if (!item) throw new Refusal(404, `No item labelled ${label}.`);
      if (current.some(c => c.id === item.id)) continue;
      if (item.condition !== 'good') throw new Refusal(409, `${item.label} is marked ${item.condition} — it should not go out.`);
      const t = taken[item.id];
      if (t) throw new Refusal(409, `${item.label} is on rental #${t.rental_id} (${t.name}) and not back yet.`);
      picks.push(item);
    }
    const bins = picks.filter(p => p.kind === 'bin').length;
    if (bins > room) {
      throw new Refusal(409, `This rental already has ${current.filter(i => i.kind === 'bin').length} of its ${rental.bins} bins. Take one off first, or it is a bigger package.`);
    }
  }

  for (const p of picks) {
    await env.DB.prepare('INSERT OR IGNORE INTO rental_items (rental_id, item_id, assigned_by) VALUES (?1,?2,?3)')
      .bind(rental.id, p.id, user.email).run();
  }
  if (picks.length) {
    const labels = picks.map(p => p.label);
    await audit(env, user.email, 'rental.bins_assigned', 'rental', rental.id,
      `${picks.length} ${picks.length === 1 ? 'bin' : 'bins'}${auto ? ' (auto)' : ''}: ${labels.length > 2 ? `${labels[0]}–${labels.at(-1)}` : labels.join(', ')}`);
  }
  return { items: await itemsOn(env, rental.id), added: picks.map(p => p.label) };
}

export async function unassign(env, user, rental, itemId) {
  if (rental.inspected_at) throw new Refusal(409, 'This rental is finished and inspected.');
  const row = await env.DB.prepare(
    'SELECT i.label FROM rental_items ri JOIN items i ON i.id = ri.item_id WHERE ri.rental_id = ?1 AND ri.item_id = ?2',
  ).bind(rental.id, itemId).first();
  if (!row) throw new Refusal(404, 'That bin is not on this rental.');
  await env.DB.prepare('DELETE FROM rental_items WHERE rental_id = ?1 AND item_id = ?2').bind(rental.id, itemId).run();
  await audit(env, user.email, 'rental.bin_removed', 'rental', rental.id, row.label);
  return itemsOn(env, rental.id);
}

/* The inspection. Each bin: back fine, back with an issue, or not back.
   Writes the bin's own condition and the rental's count, so inventory, the
   fleet and the charges panel all read the same fact. Re-running it
   corrects: a lost bin that turns up goes back to good. */
export async function inspect(env, user, rental, body) {
  if (!rental.returned_at) throw new Refusal(409, 'The bins are not marked back yet.');
  const current = await itemsOn(env, rental.id);
  const byId = new Map(current.map(i => [i.id, i]));
  const wanted = Array.isArray(body.items) ? body.items : [];
  const at = now();
  let back = 0;
  const missing = [], damaged = [];

  for (const it of wanted) {
    const item = byId.get(Number(it.id));
    if (!item) continue;
    const isBack = it.back !== false;
    const cond = !isBack ? 'lost' : it.condition === 'damaged' ? 'damaged' : 'good';
    const note = String(it.note || '').trim().slice(0, 300) || null;

    await env.DB.prepare(
      `UPDATE rental_items SET back_at = ?1, back_by = ?2, back_condition = ?3, back_note = ?4
       WHERE rental_id = ?5 AND item_id = ?6`,
    ).bind(at, user.email, cond, note, rental.id, item.id).run();

    /* The bin's own record. A flag from this rental is ours to set and ours
       to clear; a bin someone else marked damaged for another reason is left
       alone. */
    if (cond === 'good') {
      if (item.flagged_rental_id === rental.id || item.condition === 'good') {
        await env.DB.prepare("UPDATE items SET condition = 'good', flagged_rental_id = NULL, updated_at = ?1, updated_by = ?2 WHERE id = ?3")
          .bind(at, user.email, item.id).run();
      }
      back++;
    } else {
      await env.DB.prepare(
        `UPDATE items SET condition = ?1, flagged_rental_id = ?2, notes = coalesce(?3, notes), updated_at = ?4, updated_by = ?5 WHERE id = ?6`,
      ).bind(cond, rental.id, note, at, user.email, item.id).run();
      (cond === 'lost' ? missing : damaged).push({ id: item.id, label: item.label, note });
      if (cond === 'damaged') back++;
    }
  }

  const binsBack = current.filter(i => i.kind === 'bin').length
    ? (await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM rental_items ri JOIN items i ON i.id = ri.item_id
         WHERE ri.rental_id = ?1 AND i.kind = 'bin' AND ri.back_condition IN ('good','damaged')`).bind(rental.id).first()).n
    : null;
  if (binsBack !== null) {
    await env.DB.prepare('UPDATE rentals SET bins_returned = ?1 WHERE id = ?2').bind(binsBack, rental.id).run();
  }
  if (missing.length || damaged.length) {
    await audit(env, user.email, 'rental.inspection_flags', 'rental', rental.id,
      [missing.length ? `missing: ${missing.map(m => m.label).join(', ')}` : '',
       damaged.length ? `damaged: ${damaged.map(d => d.label).join(', ')}` : ''].filter(Boolean).join(' · '));
  }
  return { items: await itemsOn(env, rental.id), back, missing, damaged };
}

/* Ticking "inspected" with the list untouched: everything unresolved came
   back fine. */
export async function resolveRest(env, user, rental) {
  const current = await itemsOn(env, rental.id);
  const rest = current.filter(i => !i.back_at);
  if (rest.length) await inspect(env, user, rental, { items: rest.map(i => ({ id: i.id, back: true })) });
}

/* Cancelling releases the bins — they never went anywhere. */
export async function release(env, rentalId) {
  await env.DB.prepare('DELETE FROM rental_items WHERE rental_id = ?1 AND back_at IS NULL').bind(rentalId).run();
}

async function audit(env, actor, action, entity, id, detail) {
  await env.DB.prepare(
    'INSERT INTO audit_log (actor_email, action, entity, entity_id, detail) VALUES (?1,?2,?3,?4,?5)',
  ).bind(actor, action, entity, String(id), detail).run();
}
