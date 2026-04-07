// ── API: /api/enable-banking/start ────────────────────────────
// Initie la connexion bancaire Enable Banking
// Génère le JWT, appelle POST /auth, renvoie l'URL de redirection

const crypto = require('crypto');

const APP_ID      = process.env.ENABLEBANKING_APP_ID;
const CERT_ID     = process.env.ENABLEBANKING_CERT_ID || APP_ID;
const PRIVATE_KEY = process.env.ENABLEBANKING_PRIVATE_KEY;
const BASE_URL    = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3001';
const REDIRECT_URI = `${BASE_URL}/api/enable-banking/callback`;

function makeJWT() {
  const header  = b64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: CERT_ID }));
  const now     = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    iss: 'enablebanking.com',
    aud: 'api.enablebanking.com',
    iat: now,
    exp: now + 3600,
  }));
  const data = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256').update(data).sign(PRIVATE_KEY, 'base64url');
  return `${data}.${sign}`;
}

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}

module.exports = async function handler(req, res) {
  if (!APP_ID || !PRIVATE_KEY) {
    return res.status(500).json({ error: 'Enable Banking non configuré (variables manquantes)' });
  }

  try {
    const jwt = makeJWT();

    // Crédit Mutuel — code ASPSP exact selon Enable Banking
    const body = {
      access: { valid_until: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString() },
      aspsp: { name: 'Credit Mutuel', country: 'FR' },
      state: 'bb_' + Date.now(),
      redirect_url: REDIRECT_URI,
    };

    const r = await fetch('https://api.enablebanking.com/auth', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('[EnableBanking] /auth error:', r.status, err);
      return res.status(502).json({ error: 'Enable Banking refusé', detail: err });
    }

    const data = await r.json();
    // Retourner l'URL de redirection vers la banque
    res.json({ url: data.url });

  } catch (e) {
    console.error('[EnableBanking] start error:', e);
    res.status(500).json({ error: e.message });
  }
};
