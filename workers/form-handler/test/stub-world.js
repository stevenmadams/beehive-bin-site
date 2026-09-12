/* Everything outbound. Resend gets a 200 and the email is kept; anything else
   is refused so a test cannot quietly depend on the network. */
const mail = [];
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === 'stub') {
      if (url.pathname === '/reset') { mail.length = 0; return new Response('ok'); }
      return Response.json(mail);
    }
    if (url.hostname === 'api.resend.com') {
      mail.push(await request.json());
      return Response.json({ id: `email_${mail.length}` });
    }
    return new Response(`not mocked: ${url.hostname}`, { status: 502 });
  },
};
