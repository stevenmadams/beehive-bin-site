/* Cloudflare Access identity verification.

   Access sits in front of admin.beehivebin.co and handles the whole login:
   email one-time PIN, session, revocation. It hands each request a signed JWT
   in `Cf-Access-Jwt-Assertion`. We verify that signature ourselves rather than
   trusting the header — otherwise anyone who found the Worker's origin URL
   could forge a header and walk straight in. */

const CERTS_TTL_MS = 60 * 60 * 1000; // Access rotates keys slowly; an hour is safe.
let certsCache = { at: 0, teamDomain: '', keys: null };

const b64urlToBytes = s => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};
const b64urlToJSON = s => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

async function getKeys(teamDomain) {
  const fresh = certsCache.keys
    && certsCache.teamDomain === teamDomain
    && Date.now() - certsCache.at < CERTS_TTL_MS;
  if (fresh) return certsCache.keys;

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access certs ${res.status}`);
  const { keys } = await res.json();
  if (!Array.isArray(keys) || !keys.length) throw new Error('access certs empty');

  const imported = new Map();
  for (const jwk of keys) {
    imported.set(jwk.kid, await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify'],
    ));
  }
  certsCache = { at: Date.now(), teamDomain, keys: imported };
  return imported;
}

/* Returns the verified email, or throws. `aud` is the Access application's AUD
   tag: without checking it, a JWT minted for any *other* app in the same
   Cloudflare team would be accepted here. */
export async function verifyAccessJwt(token, { teamDomain, aud }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [rawHeader, rawPayload, rawSig] = parts;

  const header = b64urlToJSON(rawHeader);
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);

  const keys = await getKeys(teamDomain);
  const key = keys.get(header.kid);
  if (!key) throw new Error('unknown kid');

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key,
    b64urlToBytes(rawSig),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  );
  if (!ok) throw new Error('bad signature');

  const claims = b64urlToJSON(rawPayload);
  const now = Math.floor(Date.now() / 1000);
  const skew = 60; // clock drift between Cloudflare's edge and ours

  if (typeof claims.exp !== 'number' || claims.exp + skew < now) throw new Error('expired');
  if (typeof claims.nbf === 'number' && claims.nbf - skew > now) throw new Error('not yet valid');
  if (claims.iss !== `https://${teamDomain}`) throw new Error('bad issuer');

  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(aud)) throw new Error('bad audience');

  const email = String(claims.email || '').trim().toLowerCase();
  if (!email) throw new Error('no email claim');
  return email;
}
