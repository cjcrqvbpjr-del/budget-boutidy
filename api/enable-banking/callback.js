// ── API: /api/enable-banking/callback ─────────────────────────
// Reçoit le code OAuth après autorisation bancaire
// 1. Échange le code contre un session_id
// 2. Récupère les comptes + transactions
// 3. Importe dans Supabase (avec déduplication)
// 4. Redirige vers l'app

const crypto = require('crypto');

const APP_ID       = process.env.ENABLEBANKING_APP_ID;
const PRIVATE_KEY  = process.env.ENABLEBANKING_PRIVATE_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qvyxdpplabsbvjvpoubf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_URL      = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3001';

function makeJWT() {
  const header  = b64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: APP_ID }));
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

function b64url(str) { return Buffer.from(str).toString('base64url'); }

function ebHeaders() {
  return {
    'Authorization': `Bearer ${makeJWT()}`,
    'Content-Type': 'application/json',
  };
}

function sbHeaders() {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Calcule la période budgétaire (commence le 28)
function getPeriode(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const jour = d.getUTCDate();
  const annee = d.getUTCFullYear();
  const mois = d.getUTCMonth(); // 0-11
  if (jour >= 28) {
    return `${annee}-${String(mois + 1).padStart(2, '0')}`;
  } else {
    const prev = new Date(Date.UTC(annee, mois - 1, 1));
    return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  }
}

// Hash unique pour déduplication
function makeHash(date, montant, libelle) {
  const str = `${date}|${Math.round(montant * 100)}|${(libelle || '').trim().toLowerCase().slice(0, 50)}`;
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 32);
}

// Auto-détection catégorie basique
function detectCategorie(libelle) {
  const l = (libelle || '').toLowerCase();
  if (/lidl|aldi|leclerc|carrefour|intermarché|monoprix|casino|super u|franprix/.test(l)) return '🛒';
  if (/restau|restaurant|brasserie|café|mcdonald|burger|sushi|pizza/.test(l)) return '🍽️';
  if (/total|bp|esso|shell|pétrole|carburant/.test(l)) return '⛽';
  if (/pharmacie|médecin|docteur|hôpital|clinique|soin/.test(l)) return '💊';
  if (/amazon|amzn/.test(l)) return '📦';
  if (/fnac|darty|ikea|leroy|bricomarché/.test(l)) return '🏠';
  if (/zara|h&m|primark|kiabi|vetement/.test(l)) return '👗';
  if (/netflix|spotify|disney|canal|abonnement/.test(l)) return '🎮';
  return '📌';
}

// Charge les charges fixes depuis Supabase pour la déduplication
async function loadChargesFixes() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/charges_fixes?actif=eq.true`, { headers: sbHeaders() });
  return r.ok ? await r.json() : [];
}

// Vérifie si une transaction correspond à une charge fixe (doublon potentiel)
function matchChargeFixe(tx, chargesFixes, periode) {
  const montantAbs = Math.abs(tx.montant);
  for (const charge of chargesFixes) {
    const montantPrevu = Number(charge.montant_prevu || 0);
    if (montantPrevu === 0) continue;
    // Écart de montant < 5%
    const ecart = Math.abs(montantAbs - montantPrevu) / montantPrevu;
    if (ecart <= 0.05) {
      // Vérifier qu'il n'y a pas déjà une transaction charge_fixe pour cette charge dans cette période
      return charge;
    }
  }
  return null;
}

// Insère les transactions dans Supabase avec gestion des doublons
async function importTransactions(transactions, chargesFixes) {
  let importees = 0;
  let doublons = 0;
  let reconciliees = 0;

  for (const tx of transactions) {
    const hash = makeHash(tx.date, tx.montant, tx.libelle);
    const periode = getPeriode(tx.date);
    const montantNum = Number(tx.montant);

    // 1. Vérifier doublon par hash
    const existing = await fetch(
      `${SUPABASE_URL}/rest/v1/transactions?hash_doublon=eq.${hash}&limit=1`,
      { headers: sbHeaders() }
    );
    const existingData = await existing.json();
    if (existingData.length > 0) {
      doublons++;
      continue;
    }

    // 2. Si c'est une dépense, vérifier si elle correspond à une charge fixe
    let chargeFixeId = null;
    if (montantNum < 0) {
      const chargeMatch = matchChargeFixe(tx, chargesFixes, periode);
      if (chargeMatch) {
        // Mettre à jour le montant réel de la charge fixe
        await fetch(`${SUPABASE_URL}/rest/v1/charges_fixes?id=eq.${chargeMatch.id}`, {
          method: 'PATCH',
          headers: sbHeaders(),
          body: JSON.stringify({ montant_reel: montantNum }),
        });

        // Supprimer l'éventuelle transaction charge_fixe auto-générée pour cette charge + période
        await fetch(
          `${SUPABASE_URL}/rest/v1/transactions?charge_fixe_id=eq.${chargeMatch.id}&periode=eq.${periode}&source=eq.auto`,
          { method: 'DELETE', headers: sbHeaders() }
        );

        chargeFixeId = chargeMatch.id;
        reconciliees++;
      }
    }

    // 3. Insérer la transaction
    await fetch(`${SUPABASE_URL}/rest/v1/transactions`, {
      method: 'POST',
      headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        date: tx.date,
        libelle: tx.libelle,
        montant: montantNum,
        categorie_emoji: detectCategorie(tx.libelle),
        personne: 'commun',
        type: montantNum < 0 ? (chargeFixeId ? 'charge_fixe' : 'depense') : 'revenu',
        source: 'bancaire',
        periode,
        charge_fixe_id: chargeFixeId,
        hash_doublon: hash,
      }),
    });
    importees++;
  }

  return { importees, doublons, reconciliees };
}

module.exports = async function handler(req, res) {
  const { code, error } = req.query;

  if (error) {
    console.error('[EnableBanking] OAuth error:', error);
    return res.redirect(`${APP_URL}?bank_error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.redirect(`${APP_URL}?bank_error=no_code`);
  }

  try {
    // 1. Échanger le code contre une session
    const sessionRes = await fetch('https://api.enablebanking.com/sessions', {
      method: 'POST',
      headers: ebHeaders(),
      body: JSON.stringify({ code }),
    });

    if (!sessionRes.ok) {
      const err = await sessionRes.text();
      console.error('[EnableBanking] /sessions error:', sessionRes.status, err);
      return res.redirect(`${APP_URL}?bank_error=session_failed`);
    }

    const session = await sessionRes.json();
    const sessionId = session.session_id;
    const accounts = session.accounts || [];

    console.log(`[EnableBanking] Session créée: ${sessionId}, ${accounts.length} compte(s)`);

    // 2. Sauvegarder le session_id dans Supabase pour les syncs futures
    await fetch(`${SUPABASE_URL}/rest/v1/parametres`, {
      method: 'POST',
      headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ cle: 'eb_session_id', valeur: JSON.stringify(sessionId) }),
    });

    // 3. Charger les charges fixes pour la déduplication
    const chargesFixes = await loadChargesFixes();

    // 4. Récupérer les transactions des 90 derniers jours
    const dateFin = new Date().toISOString().split('T')[0];
    const dateDebut = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().split('T')[0];

    let totalImportees = 0;
    let totalDoublons = 0;
    let totalReconciliees = 0;

    for (const accountId of accounts) {
      const txRes = await fetch(
        `https://api.enablebanking.com/accounts/${accountId}/transactions?date_from=${dateDebut}&date_to=${dateFin}`,
        { headers: ebHeaders() }
      );

      if (!txRes.ok) {
        console.error(`[EnableBanking] transactions error pour ${accountId}:`, txRes.status);
        continue;
      }

      const txData = await txRes.json();
      const transactions = (txData.transactions || []).map(t => ({
        date: t.booking_date || t.value_date,
        libelle: t.remittance_information?.[0] || t.creditor_name || t.debtor_name || '',
        montant: t.transaction_amount?.amount,
      })).filter(t => t.date && t.montant !== undefined);

      const result = await importTransactions(transactions, chargesFixes);
      totalImportees   += result.importees;
      totalDoublons    += result.doublons;
      totalReconciliees += result.reconciliees;
    }

    console.log(`[EnableBanking] Import: ${totalImportees} importées, ${totalDoublons} doublons, ${totalReconciliees} réconciliées`);

    // 5. Rediriger vers l'app avec le statut
    res.redirect(
      `${APP_URL}?bank_connected=1&importees=${totalImportees}&doublons=${totalDoublons}&reconciliees=${totalReconciliees}`
    );

  } catch (e) {
    console.error('[EnableBanking] callback error:', e);
    res.redirect(`${APP_URL}?bank_error=${encodeURIComponent(e.message)}`);
  }
};
