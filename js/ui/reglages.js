// ── ÉCRAN RÉGLAGES ────────────────────────────────────────────
import { state, sauvegarderParametre, modifierCharge, supprimerCharge, ajouterCharge,
         modifierCompteEpargne, supprimerCompteEpargne, ajouterCompteEpargne,
         ajouterCategorie, supprimerCategorie, setActiveUser, setTheme } from '../state.js';
import { calculerBilan, fmt, fmtCourt } from '../budget.js';

export function renderReglages() {
  // Statut banque
  if (typeof updateBankUI === 'function') updateBankUI();

  // Utilisateur actif
  qs('#regl-user-g').className = 'who-btn g' + (state.activeUser === 'G' ? ' active' : '');
  qs('#regl-user-a').className = 'who-btn a' + (state.activeUser === 'A' ? ' active' : '');

  // Thème
  qs('#toggle-theme').checked = state.theme === 'light';

  // Revenus
  qs('#input-salaire-g').value = state.parametres.salaire_g || '';
  qs('#input-salaire-a').value = state.parametres.salaire_a || '';
  qs('#input-foncier').value   = state.parametres.foncier   || '';

  // Budget calculé
  const bilan = calculerBilan(state.transactions, state.parametres, state.chargesFixes, state.comptesEpargne);
  qs('#budget-auto').textContent = fmt(bilan.budgetVariable);

  // Charges fixes
  renderChargesList();

  // Épargne
  renderEpargneList();

  // Catégories
  renderCategoriesList();
}

function renderChargesList() {
  const el = qs('#charges-list');
  const bilan = calculerBilan([], state.parametres, state.chargesFixes, state.comptesEpargne);
  qs('#charges-total').textContent = fmtCourt(bilan.totalChargesPrevues);

  el.innerHTML = state.chargesFixes.map(c => `
    <div class="setting-item">
      <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
        <span style="font-size:18px">${c.emoji}</span>
        <div style="min-width:0">
          <div class="setting-label">${c.nom}</div>
          <div class="setting-sub">${c.type}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <input type="number" value="${c.montant_prevu}" min="0" step="1"
          class="input-field" style="width:90px;padding:8px;text-align:right"
          onchange="updateCharge('${c.id}', this.value)">
        <button onclick="deleteCharge('${c.id}')"
          style="background:none;border:none;color:var(--red);font-size:16px;cursor:pointer;padding:4px">🗑</button>
      </div>
    </div>`).join('');
}

function renderEpargneList() {
  const el = qs('#epargne-list');
  const total = state.comptesEpargne.reduce((s, c) => s + Number(c.versement_mensuel || 0), 0);
  qs('#epargne-total-regl').textContent = fmtCourt(total) + '/mois';

  el.innerHTML = state.comptesEpargne.map(c => `
    <div class="setting-item">
      <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
        <span style="font-size:18px">${c.emoji}</span>
        <div style="min-width:0">
          <div class="setting-label">${c.nom}</div>
          <div class="setting-sub">
            Solde : <input type="number" value="${c.solde}" min="0"
              style="background:none;border:none;border-bottom:1px solid var(--border2);color:var(--text);font-size:11px;width:70px"
              onchange="updateEpargne('${c.id}','solde',this.value)">€
            — Versement : <input type="number" value="${c.versement_mensuel}" min="0"
              style="background:none;border:none;border-bottom:1px solid var(--border2);color:var(--accent);font-size:11px;width:60px"
              onchange="updateEpargne('${c.id}','versement_mensuel',this.value)">€/mois
          </div>
        </div>
      </div>
      <button onclick="deleteEpargne('${c.id}')"
        style="background:none;border:none;color:var(--red);font-size:16px;cursor:pointer;padding:4px">🗑</button>
    </div>`).join('');
}

function renderCategoriesList() {
  const el = qs('#categories-list');
  el.innerHTML = state.categories.map(c => `
    <div style="display:inline-flex;align-items:center;gap:4px;background:var(--bg3);border:1px solid var(--border2);border-radius:20px;padding:4px 10px;margin:4px">
      <span>${c.emoji}</span>
      <span style="font-size:12px">${c.nom}</span>
      <button onclick="deleteCategorie('${c.id}')"
        style="background:none;border:none;color:var(--text3);font-size:11px;cursor:pointer;margin-left:2px">✕</button>
    </div>`).join('');
}

// ── HANDLERS GLOBAUX (appelés depuis le HTML) ─────────────────
window.updateCharge = async (id, val) => {
  await modifierCharge(id, { montant_prevu: parseFloat(val) || 0 });
  renderReglages();
};

window.deleteCharge = async (id) => {
  if (!confirm('Supprimer cette charge ?')) return;
  await supprimerCharge(id);
  renderReglages();
};

window.updateEpargne = async (id, field, val) => {
  await modifierCompteEpargne(id, { [field]: parseFloat(val) || 0 });
  renderReglages();
};

window.deleteEpargne = async (id) => {
  if (!confirm('Supprimer ce compte ?')) return;
  await supprimerCompteEpargne(id);
  renderReglages();
};

window.deleteCategorie = async (id) => {
  if (!confirm('Supprimer cette catégorie ?')) return;
  await supprimerCategorie(id);
  renderReglages();
};

window.saveRevenu = async (cle, val) => {
  await sauvegarderParametre(cle, parseFloat(val) || 0);
  renderReglages();
};

window.switchUser = (user) => {
  setActiveUser(user);
  renderReglages();
};

window.switchTheme = (on) => {
  setTheme(on ? 'light' : 'dark');
};

// Modal ajout charge
window.openAddCharge = () => {
  qs('#modal-add-charge').classList.add('open');
  qs('#add-charge-nom').value = '';
  qs('#add-charge-montant').value = '';
  qs('#add-charge-emoji').value = '📌';
  qs('#add-charge-type').value = 'Autre';
};

window.confirmAddCharge = async () => {
  const nom     = qs('#add-charge-nom').value.trim();
  const montant = parseFloat(qs('#add-charge-montant').value) || 0;
  const emoji   = qs('#add-charge-emoji').value.trim() || '📌';
  const type    = qs('#add-charge-type').value;
  if (!nom) { showToast('Entrez un nom'); return; }
  await ajouterCharge({ nom, montant_prevu: montant, emoji, type, ordre: 99 });
  closeModal('modal-add-charge');
  renderReglages();
  showToast('✓ Charge ajoutée');
};

// Modal ajout épargne
window.openAddEpargne = () => {
  qs('#modal-add-epargne').classList.add('open');
  qs('#add-epargne-nom').value = '';
  qs('#add-epargne-emoji').value = '💰';
  qs('#add-epargne-solde').value = '';
  qs('#add-epargne-versement').value = '';
};

window.confirmAddEpargne = async () => {
  const nom       = qs('#add-epargne-nom').value.trim();
  const emoji     = qs('#add-epargne-emoji').value.trim() || '💰';
  const solde     = parseFloat(qs('#add-epargne-solde').value) || 0;
  const versement = parseFloat(qs('#add-epargne-versement').value) || 0;
  if (!nom) { showToast('Entrez un nom'); return; }
  await ajouterCompteEpargne({ nom, emoji, solde, versement_mensuel: versement });
  closeModal('modal-add-epargne');
  renderReglages();
  showToast('✓ Compte ajouté');
};

// Modal ajout catégorie
window.openAddCategorie = () => {
  qs('#modal-add-cat').classList.add('open');
  qs('#add-cat-emoji').value = '';
  qs('#add-cat-nom').value = '';
};

window.confirmAddCategorie = async () => {
  const emoji = qs('#add-cat-emoji').value.trim();
  const nom   = qs('#add-cat-nom').value.trim();
  if (!emoji || !nom) { showToast('Emoji et nom requis'); return; }
  await ajouterCategorie({ emoji, nom, couleur: 'rgba(150,150,150,.12)', ordre: 99 });
  closeModal('modal-add-cat');
  renderReglages();
  showToast('✓ Catégorie ajoutée');
};

function qs(sel) { return document.querySelector(sel); }
