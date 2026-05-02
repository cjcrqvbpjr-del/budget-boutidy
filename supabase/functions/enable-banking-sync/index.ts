// ── Supabase Edge Function: enable-banking-sync ───────────────
// Sync manuelle : récupère les 7 derniers jours de transactions

import jwt from "npm:jsonwebtoken@9";
import { createHash } from "node:crypto";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const APP_ID       = Deno.env.get('ENABLEBANKING_APP_ID')!;
const PRIVATE_KEY  = Deno.env.get('ENABLEBANKING_PRIVATE_KEY')!;
const SUPABASE_URL = 'https://qvyxdpplabsbvjvpoubf.supabase.co';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function makeJWT(): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 },
    PRIVATE_KEY,
    { algorithm: 'RS256', header: { kid: APP_ID, typ: 'JWT' } }
  );
}

function ebHeaders() {
  return { 'Authorization': `Bearer ${makeJWT()}`, 'Content-Type': 'application/json' };
}
function sbHeaders() {
  return { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
}

function getPeriode(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  const jour = d.getUTCDate(), annee = d.getUTCFullYear(), mois = d.getUTCMonth();
  if (jour >= 28) return `${annee}-${String(mois + 1).padStart(2, '0')}`;
  const prev = new Date(Date.UTC(annee, mois - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
}

function makeHash(date: string, montant: number, libelle: string): string {
  const str = `${date}|${Math.round(montant * 100)}|${(libelle || '').trim().toLowerCase().slice(0, 50)}`;
  return createHash('sha256').update(str).digest('hex').slice(0, 32);
}

function detectCategorie(libelle: string): string {
  const l = (libelle || '').toLowerCase();
  if (/lidl|aldi|leclerc|carrefour|intermarché|monoprix|casino|super u|franprix/.test(l)) return '🛒';
  if (/restau|restaurant|brasserie|café|mcdonald|burger|sushi|pizza/.test(l)) return '🍽️';
  if (/total|bp|esso|shell|carburant/.test(l)) return '⛽';
  if (/pharmacie|médecin|docteur|hôpital/.test(l)) return '💊';
  if (/amazon|amzn/.test(l)) return '📦';
  if (/zara|h&m|primark|kiabi/.test(l)) return '👗';
  if (/netflix|spotify|disney|canal/.test(l)) return '🎮';
  return '📌';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    // Récupérer le session_id depuis Supabase
    const paramRes = await fetch(`${SUPABASE_URL}/rest/v1/parametres?cle=eq.eb_session_id`, { headers: sbHeaders() });
    const params = await paramRes.json();
    if (!params.length) {
      return new Response(JSON.stringify({ error: 'Banque non connectée' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    const sessionId = JSON.parse(params[0].valeur);

    // Récupérer les comptes
    const sessionRes = await fetch(`https://api.enablebanking.com/sessions/${sessionId}`, { headers: ebHeaders() });
    if (!sessionRes.ok) {
      return new Response(JSON.stringify({ error: 'Session expirée — reconnectez la banque' }), {
        status: 401, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    const session = await sessionRes.json();
    const accounts = session.accounts || [];

    const dateFin   = new Date().toISOString().split('T')[0];
    const dateDebut = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().split('T')[0];

    const cfRes = await fetch(`${SUPABASE_URL}/rest/v1/charges_fixes?actif=eq.true`, { headers: sbHeaders() });
    const chargesFixes = cfRes.ok ? await cfRes.json() : [];

    let importees = 0, doublons = 0, reconciliees = 0;

    for (const account of accounts) {
      const accountId = account.uid || account;
      const txRes = await fetch(
        `https://api.enablebanking.com/accounts/${accountId}/transactions?date_from=${dateDebut}&date_to=${dateFin}`,
        { headers: ebHeaders() }
      );
      if (!txRes.ok) continue;

      const txData = await txRes.json();
      for (const t of (txData.transactions || [])) {
        const date    = t.booking_date || t.value_date;
        const libelle = t.remittance_information?.[0] || t.creditor_name || t.debtor_name || '';
        const montant = Number(t.transaction_amount?.amount);
        if (!date || isNaN(montant)) continue;

        const hash = makeHash(date, montant, libelle);
        const periode = getPeriode(date);

        const existR = await fetch(`${SUPABASE_URL}/rest/v1/transactions?hash_doublon=eq.${hash}&limit=1`, { headers: sbHeaders() });
        if ((await existR.json()).length > 0) { doublons++; continue; }

        let chargeFixeId = null;
        if (montant < 0) {
          for (const charge of chargesFixes) {
            const prevu = Number(charge.montant_prevu || 0);
            if (prevu > 0 && Math.abs(Math.abs(montant) - prevu) / prevu <= 0.05) {
              await fetch(`${SUPABASE_URL}/rest/v1/charges_fixes?id=eq.${charge.id}`, {
                method: 'PATCH', headers: sbHeaders(),
                body: JSON.stringify({ montant_reel: montant }),
              });
              await fetch(`${SUPABASE_URL}/rest/v1/transactions?charge_fixe_id=eq.${charge.id}&periode=eq.${periode}&source=eq.auto`,
                { method: 'DELETE', headers: sbHeaders() }
              );
              chargeFixeId = charge.id;
              reconciliees++;
              break;
            }
          }
        }

        await fetch(`${SUPABASE_URL}/rest/v1/transactions`, {
          method: 'POST',
          headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            date, libelle, montant,
            categorie_emoji: detectCategorie(libelle),
            personne: 'commun',
            type: montant < 0 ? (chargeFixeId ? 'charge_fixe' : 'depense') : 'revenu',
            source: 'bancaire', periode, charge_fixe_id: chargeFixeId, hash_doublon: hash,
          }),
        });
        importees++;
      }
    }

    return new Response(JSON.stringify({ ok: true, importees, doublons, reconciliees }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });

  } catch (e) {
    console.error('[EB] sync error:', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }
});
