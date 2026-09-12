import { describe, it, expect } from 'vitest';
import { api, ok, rental, request, fleet, OWNER, STAFF } from './helpers.js';

describe('notes and history', () => {
  it('S24 a note is attributed; only its author (or an owner) can delete it, and deletion is a strike-through, not an erasure', async () => {
    const r = await request();
    await ok('/me', { as: STAFF });
    const a = await ok(`/requests/${r.id}/notes`, { method: 'POST', body: { body: 'Sounded keen, wants Saturday' }, as: STAFF });
    expect(a.notes[0]).toMatchObject({ author: STAFF, body: 'Sounded keen, wants Saturday', deleted_at: null });
    const empty = await api(`/requests/${r.id}/notes`, { method: 'POST', body: { body: '   ' } });
    expect(empty.status).toBe(400);

    const other = await api(`/notes/${a.notes[0].id}`, { method: 'PATCH', body: { deleted: true }, as: 'third@beehivebin.co' });
    expect(other.status).toBe(403);
    const own = await ok(`/notes/${a.notes[0].id}`, { method: 'PATCH', body: { deleted: true }, as: STAFF });
    expect(own.notes[0].deleted_at).toBeTruthy();
    expect(own.notes[0].deleted_by).toBe(STAFF);
    expect(own.notes[0].body).toBe('Sounded keen, wants Saturday');   // still readable
  });

  it('a note on a rental is separate from the request it came from', async () => {
    await fleet(40);
    const r = await rental({ internal_notes: 'Phoned in' });
    const reqNotes = await ok(`/requests/${r.request_id}/notes`);
    expect(reqNotes.notes.map(n => n.body)).toEqual(['Phoned in']);
    await ok(`/rentals/${r.id}/notes`, { method: 'POST', body: { body: 'Wants 7am drop' } });
    expect((await ok(`/rentals/${r.id}/notes`)).notes.map(n => n.body)).toEqual(['Wants 7am drop']);
  });

  it('S25 history says who did what, newest first', async () => {
    await fleet(40);
    const r = await rental();
    await ok(`/rentals/${r.id}`, { method: 'PATCH', body: { milestone: 'agreement', done: true, reason: 'paper' }, as: STAFF });
    await ok(`/rentals/${r.id}`, { method: 'PATCH', body: { status: 'cancelled', reason: 'Move fell through' } });
    const { history } = await ok(`/rentals/${r.id}/history`);
    expect(history[0]).toMatchObject({ action: 'rental.cancel', actor_email: OWNER, detail: 'Move fell through' });
    expect(history.some(e => e.action === 'rental.create')).toBe(true);
    expect(history.at(-1).action).toBe('rental.create');
  });

  it('the audit log is append-only from the API — there is no way to edit or delete an entry', async () => {
    await fleet(1);
    for (const m of ['DELETE', 'PATCH', 'POST']) {
      expect((await api('/audit', { method: m, body: {} })).status).toBe(404);
    }
    const { entries } = await ok('/audit');
    expect(entries.length).toBeGreaterThan(0);
  });
});
