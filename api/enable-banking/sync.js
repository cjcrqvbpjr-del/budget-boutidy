// ── API: /api/enable-banking/sync ─────────────────────────────
// Sync manuelle/automatique : récupère les dernières transactions
// Utilise la session Enable Banking existante stockée en Supabase

const crypto = require('crypto');

const APP_ID       = process.env.ENABLEBANKING_APP_ID;
const CERT_ID      = process.env.ENABLEBANKING_CERT_ID || APP_ID;
const PRIVATE_KEY  = process.env.ENABLEBANKING_PRIVATE_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qvyxdpplabsbvjvpoubf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function makeJWT() {
  const header  = b64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: CERT_ID }));
  const now     = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    iss: 'enablebanking.com', aud: 'api.enablebanking.com',
    iat: now, exp: now + 3600,
  }));
  const data = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256').update(data).sign(PRIVATE_KEY, 'base64url');
  return `${data}.${sign}`;
}

function b64url(str) { return Buffer.from(str).toString('base64url'); }
function ebHeaders() { return { 'Authorization': `Bearer ${makeJWT()}`, 'Content-Type': 'application/json' }; }
function sbHeaders() { return { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' }; }

function getPeriode(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const jour = d.getUTCDate(), annee = d.getUTCFullYear(), mois = d.getUTCMonth();
  if (jour >= 28) return `${annee}-${String(mois + 1).padStart(2, '0')}`;
  const prev = new Date(Date.UTC(annee, mois - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
}

function makeHash(date, montant, libelle) {
  return crypto.createHash('sha256')
    .update(`${date}|${Math.round(montant * 100)}|${(libelle || '').trim().toLowerCase().slice(0, 50)}`)
    .digest('hex').slice(0, 32);
}

function detectCategorie(libelle) {
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

module.exports = async function handler(req, res) {
  // CORS pour appels depuis le frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Récupérer le session_id depuis Supabase
    const paramRes = await fetch(`${SUPABASE_URL}/rest/v1/parametres?cle=eq.eb_session_id`, { headers: sbHeaders() });
    const params = await paramRes.json();
    if (!params.length) return res.status(400).json({ error: 'Banque non connectée' });

    const sessionId = JSON.parse(params[0].valeur);

    // Récupérer les comptes de la session
    const sessionRes = await fetch(`https://api.enablebanking.com/sessions/${sessionId}`, { headers: ebHeaders() });
    if (!sessionRes.ok) return res.status(401).json({ error: 'Session expirée — reconnectez la banque' });

    const session = await sessionRes.json();
    const accounts = session.accounts || [];

    // Transactions des 7 derniers jours (sync quotidienne)
    const dateFin   = new Date().toISOString().split('T')[0];
    const dateDebut = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().split('T')[0];

    // Charges fixes pour réconciliation
    const cfRes = await fetch(`${SUPABASE_URL}/rest/v1/charges_fixes?actif=eq.true`, { headers: sbHeaders() });
    const chargesFixes = cfRes.ok ? await cfRes.json() : [];

    let importees = 0, doublons = 0, reconciliees = 0;

    for (const accountId of accounts) {
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

        // Doublon ?
        const existing = await fetch(`${SUPABASE_URL}/rest/v1/transactions?hash_doublon=eq.${hash}&limit=1`, { headers: sbHeaders() });
        if ((await existing.json()).length > 0) { doublons++; continue; }

        // Réconciliation charge fixe ?
        let chargeFixeId = null;
        if (montant < 0) {
          for (const charge of chargesFixes) {
            const montantPrevu = Number(charge.montant_prevu || 0);
            if (montantPrevu > 0 && Math.abs(Math.abs(montant) - montantPrevu) / montantPrevu <= 0.05) {
              await fetch(`${SUPABASE_URL}/rest/v1/charges_fixes?id=eq.${charge.id}`, {
                method: 'PATCH', headers: sbHeaders(),
                body: JSON.stringify({ montant_reel: montant }),
              });
              await fetch(
                `${SUPABASE_URL}/rest/v1/transactions?charge_fixe_id=eq.${charge.id}&periode=eq.${getPeriode(date)}&source=eq.auto`,
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
            source: 'bancaire',
            periode: getPeriode(date),
            charge_fixe_id: chargeFixeId,
            hash_doublon: hash,
          }),
        });
        importees++;
      }
    }

    res.json({ ok: true, importees, doublons, reconciliees });

  } catch (e) {
    console.error('[EnableBanking] sync error:', e);
    res.status(500).json({ error: e.message });
  }
};
