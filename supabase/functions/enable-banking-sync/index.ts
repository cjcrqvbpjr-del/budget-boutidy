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

function normalizePem(pem: string): string {
  let s = pem.replace(/\\n/g, '\n').trim();
  if (s.includes('-----BEGIN') && s.includes('\n')) return s;
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

    const pmRes = await fetch(`${SUPABASE_URL}/rest/v1/parametres`, { headers: sbHeaders() });
    const pmRows = pmRes.ok ? await pmRes.json() : [];
    const parametres: any = {};
    for (const row of pmRows) { try { parametres[row.cle] = JSON.parse(row.valeur); } catch { parametres[row.cle] = row.valeur; } }
    const salaireG = Number(parametres?.salaire_g || 0);
    const salaireA = Number(parametres?.salaire_a || 0);

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
        const amount  = Number(t.transaction_amount?.amount);
        const montant = t.credit_debit_indicator === 'DBIT' ? -Math.abs(amount) : Math.abs(amount);
        if (!date || isNaN(montant)) continue;

        const hash = makeHash(date, montant, libelle);
        const periode = getPeriode(date);

        const existR = await fetch(`${SUPABASE_URL}/rest/v1/transactions?hash_doublon=eq.${hash}&limit=1`, { headers: sbHeaders() });
        if ((await existR.json()).length > 0) { doublons++; continue; }

        // Réconciliation charge fixe
        // Critère 1 : montant dans ±15% du montant prévu
        // Critère 2 (fallback) : libellé contient le nom de la charge (insensible casse)
        let chargeFixeId = null;
        if (montant < 0) {
          const absM = Math.abs(montant);
          const lib  = libelle.toLowerCase();
          for (const charge of chargesFixes) {
            const prevu  = Number(charge.montant_prevu || 0);
            const byAmount = prevu > 0 && Math.abs(absM - prevu) / prevu <= 0.15;
            const byName   = charge.nom && lib.includes(charge.nom.toLowerCase().slice(0, 5));
            if (byAmount || byName) {
              await fetch(`${SUPABASE_URL}/rest/v1/charges_fixes?id=eq.${charge.id}`, {
                method: 'PATCH', headers: sbHeaders(),
                body: JSON.stringify({ montant_reel: montant }),
              });
              // Supprimer un doublon éventuel de la même période (même charge_fixe_id)
              await fetch(`${SUPABASE_URL}/rest/v1/transactions?charge_fixe_id=eq.${charge.id}&periode=eq.${periode}&hash_doublon=neq.${hash}`,
                { method: 'DELETE', headers: sbHeaders() }
              );
              chargeFixeId = charge.id;
              reconciliees++;
              break;
            }
          }
        }

        // Détection salaire (revenus) : ±25% du salaire prévu → mise à jour paramètres
        if (montant > 0) {
          if (salaireG > 0 && Math.abs(montant - salaireG) / salaireG <= 0.25) {
            await fetch(`${SUPABASE_URL}/rest/v1/parametres?cle=eq.salaire_g`, {
              method: 'PATCH', headers: sbHeaders(),
              body: JSON.stringify({ valeur: JSON.stringify(montant) }),
            });
          } else if (salaireA > 0 && Math.abs(montant - salaireA) / salaireA <= 0.25) {
            await fetch(`${SUPABASE_URL}/rest/v1/parametres?cle=eq.salaire_a`, {
              method: 'PATCH', headers: sbHeaders(),
              body: JSON.stringify({ valeur: JSON.stringify(montant) }),
            });
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
