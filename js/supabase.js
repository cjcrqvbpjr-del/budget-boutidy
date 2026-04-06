// ── COUCHE SUPABASE ───────────────────────────────────────────
import { CONFIG } from './config.js';

const URL = CONFIG.SUPABASE_URL;
const KEY = CONFIG.SUPABASE_ANON_KEY;

const headers = {
  'apikey': KEY,
  'Authorization': `Bearer ${KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation',
};

// ── CRUD GÉNÉRIQUE ────────────────────────────────────────────
export async function dbSelect(table, params = '') {
  const r = await fetch(`${URL}/rest/v1/${table}?${params}`, { headers });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function dbInsert(table, data) {
  const r = await fetch(`${URL}/rest/v1/${table}`, {
    method: 'POST', headers,
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function dbUpdate(table, id, data) {
  const r = await fetch(`${URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function dbDelete(table, id) {
  const r = await fetch(`${URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'DELETE', headers,
  });
  if (!r.ok) throw new Error(await r.text());
}

export async function dbUpsert(table, data, onConflict) {
  const url = `${URL}/rest/v1/${table}${onConflict ? `?on_conflict=${onConflict}` : ''}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ── REALTIME ──────────────────────────────────────────────────
let realtimeWs = null;
let heartbeatTimer = null;
let realtimeStarted = false;
const subscribers = {};

// Enregistre un callback pour une table — la connexion WS est unique
export function subscribeRealtime(table, callback) {
  if (!subscribers[table]) subscribers[table] = [];
  subscribers[table].push(callback);
}

// Démarre UNE SEULE connexion WebSocket pour toutes les tables
export function startRealtimeConnection() {
  if (realtimeStarted) return;
  realtimeStarted = true;
  connectRealtime();
}

function connectRealtime() {
  // Sécurité : ne pas créer de nouvelle connexion si déjà en cours
  if (realtimeWs && (realtimeWs.readyState === WebSocket.CONNECTING || realtimeWs.readyState === WebSocket.OPEN)) return;

  const wsUrl = URL.replace('https://', 'wss://') + '/realtime/v1/websocket?apikey=' + KEY + '&vsn=1.0.0';
  realtimeWs = new WebSocket(wsUrl);

  realtimeWs.onopen = () => {
    console.log('[Realtime] Connecté');
    // S'abonner à toutes les tables en une seule connexion
    const tables = ['transactions', 'parametres', 'charges_fixes', 'comptes_epargne', 'categories'];
    tables.forEach(table => {
      realtimeWs.send(JSON.stringify({
        topic: `realtime:public:${table}`,
        event: 'phx_join',
        payload: { config: { broadcast: { self: false }, presence: { key: '' } } },
        ref: null,
      }));
    });
    // Heartbeat toutes les 25s
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (realtimeWs.readyState === WebSocket.OPEN) {
        realtimeWs.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: null }));
      }
    }, 25000);
  };

  realtimeWs.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.event === 'INSERT' || msg.event === 'UPDATE' || msg.event === 'DELETE') {
        const table = msg.topic.replace('realtime:public:', '');
        (subscribers[table] || []).forEach(cb => cb({
          event: msg.event,
          record: msg.payload?.record,
          old: msg.payload?.old_record,
        }));
      }
    } catch {}
  };

  realtimeWs.onclose = () => {
    console.log('[Realtime] Déconnecté — reconnexion dans 5s');
    clearInterval(heartbeatTimer);
    setTimeout(connectRealtime, 5000);
  };

  realtimeWs.onerror = () => {}; // silencieux, onclose gère
}
