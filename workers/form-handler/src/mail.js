/* Outbound email, in one place.

   Both the RPC mailer the panel calls and the confirmation flow send mail, and
   they must agree on the from address and reply-to — a customer replying to a
   signed-copy email should land in the same inbox as every other reply. */

export const INBOX = 'support@beehivebin.co';
export const FROM = 'Beehive Bin Co. <noreply@beehivebin.co>';

export async function sendEmail(env, { to, subject, text, html, replyTo = INBOX }) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'no Resend key configured' };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject,
      text,
      ...(html ? { html } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.log('resend error', res.status, detail);
    return { ok: false, error: `Resend returned ${res.status}` };
  }
  return { ok: true };
}
