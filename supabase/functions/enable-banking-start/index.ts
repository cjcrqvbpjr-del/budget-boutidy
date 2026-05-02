// ── Supabase Edge Function: enable-banking-start ──────────────
import jwt from "npm:jsonwebtoken@9";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const APP_ID       = Deno.env.get('ENABLEBANKING_APP_ID')!;
const PRIVATE_KEY  = Deno.env.get('ENABLEBANKING_PRIVATE_KEY')!;
const CALLBACK_URL = 'https://qvyxdpplabsbvjvpoubf.supabase.co/functions/v1/enable-banking-callback';

function normalizePem(pem: string): string {
  // Remplace les \n échappés par de vrais sauts de ligne
  let s = pem.replace(/\\n/g, '\n').trim();
  // Si le PEM a déjà des vrais sauts de ligne, on le retourne tel quel
  if (s.includes('-----BEGIN') && s.includes('\n')) return s;
  // Sinon on reconstruit le PEM
  const match = s.match(/-----BEGIN ([^-]+)-----/);
  if (!match) return s;
  const type = match[1];
  const b64 = s.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const lines = (b64.match(/.{1,64}/g) || []).join('\n');
  return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----`;
}

function makeJWT(): string {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = normalizePem(PRIVATE_KEY);
  return jwt.sign(
    { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 },
    privateKey,
    { algorithm: 'RS256', header: { kid: APP_ID, typ: 'JWT' } }
  );
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  if (!APP_ID || !PRIVATE_KEY) {
    return new Response(JSON.stringify({ error: 'Variables manquantes' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }

  try {
    const token = makeJWT();
    const body = {
      access: { valid_until: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString() },
      aspsp: { name: 'Crédit Mutuel', country: 'FR' },
      state: 'bb_' + Date.now(),
      redirect_url: CALLBACK_URL,
    };

    const r = await fetch('https://api.enablebanking.com/auth', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('[EB] /auth error:', r.status, err);
      return new Response(JSON.stringify({ error: 'Enable Banking refusé', detail: err }), {
        status: 502, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    const data = await r.json();
    return new Response(JSON.stringify({ url: data.url }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });

  } catch (e) {
    console.error('[EB] start error:', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }
});
