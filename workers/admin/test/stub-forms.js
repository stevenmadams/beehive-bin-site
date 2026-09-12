import { WorkerEntrypoint } from 'cloudflare:workers';

/* Stands in for beehive-forms' Mailer. Nothing is sent; each call is recorded
   in this isolate and read back over the same binding, so a test can assert
   that the confirmation link went to the right address. */
const sent = [];

export class Mailer extends WorkerEntrypoint {
  async sendConfirmLink(msg) { sent.push({ kind: 'confirm', ...msg }); return { ok: true }; }
  async sendRescheduled(msg) { sent.push({ kind: 'rescheduled', ...msg }); return { ok: true }; }

  // The binding points at this class, so the test-side read-back goes here too.
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/reset') { sent.length = 0; return new Response('ok'); }
    return Response.json(sent);
  }
}

export default { fetch: () => new Response('stub') };
