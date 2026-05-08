// ── Supabase Edge Function: enable-banking-callback ───────────
// Reçoit le code OAuth, échange contre session, importe transactions

import jwt from "npm:jsonwebtoken@9";
import { createHash } from "node:crypto";

const APP_ID       = Deno.env.get('ENABLEBANKING_APP_ID')!;
const PRIVATE_KEY  = Deno.env.get('ENABLEBANKING_PRIVATE_KEY')!;
const SUPABASE_URL = 'https://qvyxdpplabsbvjvpoubf.supabase.co';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APP_URL      = 'https://cjcrqvbpjr-del.github.io/budget-boutidy';

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

async function importTransactions(
  transactions: Array<{date: string, montant: number, libelle: string}>,
  chargesFixes: any[],
  parametres: any
) {
  let importees = 0, doublons = 0, reconciliees = 0;

  const salaireG = Number(parametres?.salaire_g || 0);
  const salaireA = Number(parametres?.salaire_a || 0);

  for (const tx of transactions) {
    const hash = makeHash(tx.date, tx.montant, tx.libelle);
    const periode = getPeriode(tx.date);

    // 1. Doublon ?
    const existR = await fetch(`${SUPABASE_URL}/rest/v1/transactions?hash_doublon=eq.${hash}&limit=1`, { headers: sbHeaders() });
    if ((await existR.json()).length > 0) { doublons++; continue; }

    // 2. Réconciliation charge fixe (dépenses) ?
    // Critère 1 : montant dans ±15% du montant prévu
    // Critère 2 (fallback) : libellé contient les 5 premiers chars du nom de la charge
    let chargeFixeId = null;
    if (tx.montant < 0) {
      const absM = Math.abs(tx.montant);
      const lib  = tx.libelle.toLowerCase();
      for (const charge of chargesFixes) {
        const prevu   = Number(charge.montant_prevu || 0);
        const byAmount = prevu > 0 && Math.abs(absM - prevu) / prevu <= 0.15;
        const byName   = charge.nom && lib.includes(charge.nom.toLowerCase().slice(0, 5));
        if (byAmount || byName) {
          await fetch(`${SUPABASE_URL}/rest/v1/charges_fixes?id=eq.${charge.id}`, {
            method: 'PATCH', headers: sbHeaders(),
            body: JSON.stringify({ montant_reel: tx.montant }),
          });
          // Supprimer tout doublon existant pour cette charge dans la période
          await fetch(`${SUPABASE_URL}/rest/v1/transactions?charge_fixe_id=eq.${charge.id}&periode=eq.${periode}&hash_doublon=neq.${hash}`,
            { method: 'DELETE', headers: sbHeaders() }
          );
          chargeFixeId = charge.id;
          reconciliees++;
          break;
        }
      }
    }

    // 3. Détection salaire (revenus) : ±25% du salaire prévu → mise à jour paramètres
    if (tx.montant > 0) {
      if (salaireG > 0 && Math.abs(tx.montant - salaireG) / salaireG <= 0.25) {
        await fetch(`${SUPABASE_URL}/rest/v1/parametres?cle=eq.salaire_g`, {
          method: 'PATCH', headers: sbHeaders(),
          body: JSON.stringify({ valeur: JSON.stringify(tx.montant) }),
        });
        console.log(`[EB] salaire_g mis à jour: ${tx.montant}`);
      } else if (salaireA > 0 && Math.abs(tx.montant - salaireA) / salaireA <= 0.25) {
        await fetch(`${SUPABASE_URL}/rest/v1/parametres?cle=eq.salaire_a`, {
          method: 'PATCH', headers: sbHeaders(),
          body: JSON.stringify({ valeur: JSON.stringify(tx.montant) }),
        });
        console.log(`[EB] salaire_a mis à jour: ${tx.montant}`);
      }
    }

    // 4. Insérer
    await fetch(`${SUPABASE_URL}/rest/v1/transactions`, {
      method: 'POST',
      headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        date: tx.date, libelle: tx.libelle, montant: tx.montant,
        categorie_emoji: detectCategorie(tx.libelle),
        personne: 'commun',
        type: tx.montant < 0 ? (chargeFixeId ? 'charge_fixe' : 'depense') : 'revenu',
        source: 'bancaire', periode, charge_fixe_id: chargeFixeId, hash_doublon: hash,
      }),
    });
    importees++;
  }

  return { importees, doublons, reconciliees };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return Response.redirect(`${APP_URL}?bank_error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return Response.redirect(`${APP_URL}?bank_error=no_code`);
  }

  try {
    // 1. Échanger le code contre une session
    const sessionRes = await fetch('https://api.enablebanking.com/sessions', {
      method: 'POST', headers: ebHeaders(), body: JSON.stringify({ code }),
    });
    if (!sessionRes.ok) {
      return Response.redirect(`${APP_URL}?bank_error=session_failed`);
    }

    const session = await sessionRes.json();
    const sessionId = session.session_id;
    const accounts = session.accounts || [];
    console.log('[EB] session_id:', sessionId);
    console.log('[EB] accounts:', JSON.stringify(accounts));

    // 2. Sauvegarder le session_id
    await fetch(`${SUPABASE_URL}/rest/v1/parametres`, {
      method: 'POST',
      headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ cle: 'eb_session_id', valeur: JSON.stringify(sessionId) }),
    });

    // 3. Charges fixes + paramètres salaires pour réconciliation
    const cfRes = await fetch(`${SUPABASE_URL}/rest/v1/charges_fixes?actif=eq.true`, { headers: sbHeaders() });
    const chargesFixes = cfRes.ok ? await cfRes.json() : [];

    const pmRes = await fetch(`${SUPABASE_URL}/rest/v1/parametres`, { headers: sbHeaders() });
    const pmRows = pmRes.ok ? await pmRes.json() : [];
    const parametres: any = {};
    for (const row of pmRows) { try { parametres[row.cle] = JSON.parse(row.valeur); } catch { parametres[row.cle] = row.valeur; } }

    // 4. Transactions des 90 derniers jours
    const dateFin   = new Date().toISOString().split('T')[0];
    const dateDebut = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().split('T')[0];

    let totalImportees = 0, totalDoublons = 0, totalReconciliees = 0;

    for (const account of accounts) {
      const accountId = account.uid || account;
      const txRes = await fetch(
        `https://api.enablebanking.com/accounts/${accountId}/transactions?date_from=${dateDebut}&date_to=${dateFin}`,
        { headers: ebHeaders() }
      );
      if (!txRes.ok) continue;

      const txData = await txRes.json();
      console.log('[EB] transactions pour', accountId, ':', txData.transactions?.length, 'statut fetch:', txRes.status);
      const transactions = (txData.transactions || [])
        .map((t: any) => {
          const amount = Number(t.transaction_amount?.amount);
          const indicator = t.credit_debit_indicator;
          const montant = indicator === 'DBIT' ? -Math.abs(amount) : Math.abs(amount);
          return {
            date: t.booking_date || t.value_date,
            libelle: t.remittance_information?.[0] || t.creditor_name || t.debtor_name || '',
            montant,
          };
        })
        .filter((t: any) => t.date && !isNaN(t.montant));

      const r = await importTransactions(transactions, chargesFixes, parametres);
      totalImportees    += r.importees;
      totalDoublons     += r.doublons;
      totalReconciliees += r.reconciliees;
    }

    return Response.redirect(
      `${APP_URL}?bank_connected=1&importees=${totalImportees}&doublons=${totalDoublons}&reconciliees=${totalReconciliees}`
    );

  } catch (e) {
    console.error('[EB] callback error:', e);
    return Response.redirect(`${APP_URL}?bank_error=${encodeURIComponent(e.message)}`);
  }
});
