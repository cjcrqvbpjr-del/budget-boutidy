// ── LOGIQUE BUDGET ────────────────────────────────────────────
import { CONFIG } from './config.js';

// Calcule la période budgétaire (YYYY-MM) pour une date donnée
// Le budget démarre le 28 de chaque mois
// Ex : 5 avril → période "2026-03" (démarré le 28 mars)
//      28 avril → période "2026-04" (démarré le 28 avril)
export function getPeriode(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date + 'T12:00:00');
  const jour = d.getDate();
  const annee = d.getFullYear();
  const mois = d.getMonth(); // 0-11

  if (jour >= CONFIG.JOUR_DEBUT_PERIODE) {
    return `${annee}-${String(mois + 1).padStart(2, '0')}`;
  } else {
    // Période du mois précédent
    const prev = new Date(annee, mois - 1, 1);
    return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  }
}

// Retourne la période courante
export function getPeriodeCourante() {
  return getPeriode(new Date());
}

// Retourne les bornes de dates d'une période
// periode '2026-03' → { debut: '2026-03-28', fin: '2026-04-27' }
export function getBornesPeriode(periode) {
  const [annee, mois] = periode.split('-').map(Number);
  const debut = new Date(annee, mois - 1, CONFIG.JOUR_DEBUT_PERIODE);
  const fin = new Date(annee, mois, CONFIG.JOUR_DEBUT_PERIODE - 1); // 27 du mois suivant
  return {
    debut: debut.toISOString().split('T')[0],
    fin: fin.toISOString().split('T')[0],
  };
}

// Navigue vers la période précédente ou suivante
export function periodeVoisine(periode, direction) {
  const [annee, mois] = periode.split('-').map(Number);
  const d = new Date(annee, mois - 1 + direction, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Libellé lisible d'une période
const MOIS_FR = ['Janvier','Février','Mars','Avril','Mai','Juin',
                 'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
export function labelPeriode(periode) {
  const [annee, mois] = periode.split('-').map(Number);
  const debut = new Date(annee, mois - 1, CONFIG.JOUR_DEBUT_PERIODE);
  const fin = new Date(annee, mois, CONFIG.JOUR_DEBUT_PERIODE - 1);
  return `${debut.getDate()} ${MOIS_FR[debut.getMonth()]} → ${fin.getDate()} ${MOIS_FR[fin.getMonth()]} ${fin.getFullYear()}`;
}

// Calcule le report (solde) d'une période passée
// Formule : salaires configurés − charges fixes configurées − épargne − dépenses variables réelles
// On utilise les paramètres configurés pour les revenus et charges (stables, pas pollués par
// des crédits mal classés), et uniquement les dépenses variables réelles depuis les transactions.
export function calculerReport(prevTransactions, parametres, chargesFixes, comptesEpargne) {
  const salaireG = Number(parametres.salaire_g || 0);
  const salaireA = Number(parametres.salaire_a || 0);
  const foncier  = Number(parametres.foncier   || 0);
  const revenus  = salaireG + salaireA + foncier;

  // Charges fixes : utilise montant_reel si disponible, sinon montant_prevu
  const totalChargesFixes = chargesFixes
    .filter(c => c.actif)
    .reduce((s, c) => s + Math.abs(Number(c.montant_reel ?? c.montant_prevu ?? 0)), 0);

  const epargne = comptesEpargne
    .reduce((s, c) => s + Number(c.versement_mensuel || 0), 0);

  // Dépenses variables de la période précédente (remboursements déduits)
  const depensesPrev = Math.max(0, prevTransactions
    .filter(t => t.type === 'depense')
    .reduce((s, t) => s - Number(t.montant), 0));

  return revenus - totalChargesFixes - epargne - depensesPrev;
}

// Calcule le bilan budgétaire à partir des données
// report : solde reporté de la période précédente (peut être négatif)
export function calculerBilan(transactions, parametres, chargesFixes, comptesEpargne, report = 0) {
  const salaireG   = Number(parametres.salaire_g   || 0);
  const salaireA   = Number(parametres.salaire_a   || 0);
  const foncier    = Number(parametres.foncier      || 0);
  const revenus    = salaireG + salaireA + foncier;

  // Charges fixes : utilise montant_reel si disponible (import bancaire), sinon montant_prevu
  const totalChargesFixes = chargesFixes
    .filter(c => c.actif)
    .reduce((s, c) => s + Math.abs(Number(c.montant_reel ?? c.montant_prevu ?? 0)), 0);

  const totalEpargne = comptesEpargne
    .reduce((s, c) => s + Number(c.versement_mensuel || 0), 0);

  // Budget = report du mois précédent + revenus − charges − épargne
  const budgetBrut    = report + revenus - totalChargesFixes - totalEpargne;
  const budgetVariable = budgetBrut; // Peut être négatif si report très négatif

  // Dépenses variables (montant négatif = dépense, positif = remboursement)
  const depenses = Math.max(0, transactions
    .filter(t => t.type === 'depense')
    .reduce((s, t) => s - Number(t.montant), 0)); // -(-337) = +337, -(+283) = -283

  const reste = budgetVariable - depenses;

  // Pourcentage basé sur le budget mensuel hors report
  const budgetRef = Math.max(1, revenus - totalChargesFixes - totalEpargne);
  const pct = Math.min(100, Math.round(depenses / budgetRef * 100));

  // Reste par jour jusqu'à la fin de période
  const today = new Date();
  const periodeActuelle = getPeriodeCourante();
  const bornes = getBornesPeriode(periodeActuelle);
  const finPeriode = new Date(bornes.fin + 'T23:59:59');
  const joursRestants = Math.max(1, Math.ceil((finPeriode - today) / 86400000));
  const resteParJour = reste / joursRestants;

  return {
    revenus,
    salaireG,
    salaireA,
    foncier,
    report,
    totalChargesFixes,
    totalEpargne,
    budgetVariable,
    depenses,
    reste,
    pct,
    joursRestants,
    resteParJour,
    statut: reste < 0 ? 'BLOQUÉ' : pct >= 80 ? 'ALERTE' : 'OK',
  };
}

// Formate un montant en €
export function fmt(n, decimales = 2) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  }).format(n) + '\u202f€';
}

// Formate avec centimes (2 décimales)
export function fmtCourt(n) {
  return fmt(n, 2);
}

// Formate une date en français
export function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const today = new Date();
  const hier = new Date(today); hier.setDate(hier.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Aujourd'hui";
  if (d.toDateString() === hier.toDateString()) return 'Hier';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
