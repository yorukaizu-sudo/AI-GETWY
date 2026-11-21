'use strict';
const crypto = require('crypto');

/* ---------- Provider bawaan (semua OpenAI-compatible) ---------- */
const BUILTIN = {
  openrouter: { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY' },
  groq: { name: 'Groq', base: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY' },
  google: { name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', env: 'GEMINI_API_KEY' },
  cerebras: { name: 'Cerebras', base: 'https://api.cerebras.ai/v1', env: 'CEREBRAS_API_KEY' },
  mistral: { name: 'Mistral', base: 'https://api.mistral.ai/v1', env: 'MISTRAL_API_KEY' },
  deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', env: 'DEEPSEEK_API_KEY' },
  together: { name: 'Together AI', base: 'https://api.together.xyz/v1', env: 'TOGETHER_API_KEY' },
  nvidia: { name: 'NVIDIA NIM', base: 'https://integrate.api.nvidia.com/v1', env: 'NVIDIA_API_KEY' },
  sambanova: { name: 'SambaNova', base: 'https://api.sambanova.ai/v1', env: 'SAMBANOVA_API_KEY' },
};

/* Model awal (starter). Tekan "Detect semua model" di dashboard untuk daftar asli. */
const SEED_MODELS = [
  ['google', 'gemini-2.5-pro', 95],
  ['groq', 'openai/gpt-oss-120b', 88],
  ['google', 'gemini-2.5-flash', 84],
  ['groq', 'llama-3.3-70b-versatile', 80],
  ['cerebras', 'llama-3.3-70b', 78],
  ['openrouter', 'openrouter/auto', 70],
  ['groq', 'llama-3.1-8b-instant', 45],
].map(([provider, model, score]) => ({ id: `${provider}/${model}`, provider, model, score, enabled: true, manual: false }));

/* selectFallback: false = MODE SELECT STRICT (model pilihan gagal -> error jelas, TIDAK pindah model).
   true = model pilihan gagal -> otomatis pakai model aktif lain. Mode AUTO (model:"auto") selalu fallback. */
const DEFAULT_SETTINGS = { refreshSec: 5, autoScan: true, scanEveryMin: 5, selectFallback: process.env.FALLBACK_SPECIFIC === '1' };

const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const TZ = Number(process.env.TZ_OFFSET || 7); // WIB
const ALLOWED_EMAIL = (process.env.ALLOWED_EMAIL || 'yorukaizu@gmail.com').toLowerCase();

/* ---------- Redis (Upstash REST) ---------- */
async function redis(cmd) {
  if (!R_URL || !R_TOK) throw new Error('Redis belum dikonfigurasi (UPSTASH_REDIS_REST_URL / TOKEN)');
  const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}` }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error('Redis: ' + j.error);
  return j.result;
}
async function pipeline(cmds) {
  if (!cmds.length) return [];
  if (!R_URL || !R_TOK) throw new Error('Redis belum dikonfigurasi');
  const r = await fetch(R_URL + '/pipeline', { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}` }, body: JSON.stringify(cmds) });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('Redis pipeline error');
  return j.map((x) => { if (x.error) throw new Error('Redis: ' + x.error); return x.result; });
}
async function getJSON(k, def) {
  const v = await redis(['GET', k]);
  if (!v) return def;
  try { return JSON.parse(v); } catch { return def; }
}
const setJSON = (k, v) => redis(['SET', k, JSON.stringify(v)]);

/* ---------- Util ---------- */
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const dayStr = (offset = 0) => new Date(Date.now() + TZ * 3600e3 + offset * 864e5).toISOString().slice(0, 10);
const est = (chars) => Math.ceil((chars || 0) / 4);
function hgetallObj(arr) {
  const o = {};
  if (!Array.isArray(arr)) return o;
  for (let i = 0; i < arr.length; i += 2) o[arr[i]] = Number(arr[i + 1]);
  return o;
}
function getPath(req, prefix) {
  let p = req.query && req.query.p;
  if (Array.isArray(p)) p = p.join('/');
  if (p == null || p === '') {
    const u = (req.url || '').split('?')[0];
    const i = u.indexOf(prefix);
    if (i >= 0) p = u.slice(i + prefix.length);
  }
  return (p || '').replace(/^\/+|\/+$/g, '');
}
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.DASHBOARD_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'x-gateway-model, x-gateway-provider, x-gateway-provider-key, x-gateway-attempts, x-gateway-mode');
}
const sendErr = (res, code, msg, extra) => res.status(code).json({ error: { message: msg, type: 'gateway_error', ...(extra || {}) } });
const maskKey = (k) => (!k ? '' : k.length <= 10 ? '••••' : k.slice(0, 4) + '••••' + k.slice(-4));

/* ---------- Pool API key per provider (multi-key + rotasi) ----------
   Format tersimpan (Redis key "providers"):
   { openrouter: { enabled:true, keys:[{id,label,key,enabled,expiresAt,limit,limitType,cooldownUntil,fails,lastError,createdAt}] } }
   Pemakaian token per key disimpan di hash "pku" (field "providerId:keyId").
   Format lama { apiKey:"..." } otomatis dimigrasi jadi keys[0]. */
function normalizeKeys(s, envKey) {
  s = s || {};
  let keys = Array.isArray(s.keys) ? s.keys.slice() : [];
  if (s.apiKey && !keys.some((k) => k.key === s.apiKey)) {
    keys.unshift({ id: 'k_' + sha(s.apiKey).slice(0, 8), label: 'Key 1', key: s.apiKey, enabled: true, createdAt: Date.now() });
  }
  if (envKey && s.disableEnv !== true && !keys.some((k) => k.key === envKey)) {
    keys.push({ id: 'env', label: 'ENV', key: envKey, source: 'env', enabled: true, createdAt: 0 });
  }
  return keys.map((k, i) => ({
    id: k.id || ('k' + i),
    label: k.label || ('Key ' + (i + 1)),
    key: k.key || '',
    source: k.source || 'dashboard',
    enabled: k.enabled !== false,
    expiresAt: k.expiresAt || null,
    limit: k.limit || null,
    limitType: k.limitType || 'token',
    cooldownUntil: k.cooldownUntil || 0,
    fails: k.fails || 0,
    lastError: k.lastError || null,
    lastStatus: k.lastStatus || null,
    createdAt: k.createdAt || 0,
  }));
}
function keyStatus(k, now) {
  now = now || Date.now();
  if (k.enabled === false) return 'off';
  if (k.expiresAt && now > k.expiresAt) return 'expired';
  if (k.cooldownUntil && now < k.cooldownUntil) return 'cooldown';
  if (k.limit && (k.used || 0) >= k.limit) return 'exhausted';
  return 'active';
}
function keyPct(k) { if (!k.limit) return null; return Math.round(100 * (k.used || 0) / k.limit); }
function usableKeys(prov, now) { return (prov.keys || []).filter((k) => k.key && keyStatus(k, now) === 'active'); }

async function loadProviders() {
  const stored = await getJSON('providers', {});
  let pku = {}, pklast = {};
  try {
    const [a, b] = await pipeline([['HGETALL', 'pku'], ['HGETALL', 'pklast']]);
    pku = hgetallObj(a); pklast = hgetallObj(b);
  } catch (_) {}
  const merge = (id, keys) => keys.forEach((k) => { k.used = pku[id + ':' + k.id] || 0; k.lastUsedAt = pklast[id + ':' + k.id] || null; });
  const out = {};
  for (const [id, d] of Object.entries(BUILTIN)) {
    const s = stored[id] || {};
    const keys = normalizeKeys(s, process.env[d.env] || '');
    merge(id, keys);
    out[id] = { id, name: s.name || d.name, base: (s.base || d.base).replace(/\/+$/, ''), keys, source: keys.length ? (keys.some((k) => k.source === 'env') ? 'env+dashboard' : 'dashboard') : 'none', enabled: s.enabled !== false, custom: false };
  }
  for (const [id, s] of Object.entries(stored)) {
    if (s.custom && s.base) {
      const keys = normalizeKeys(s, '');
      merge(id, keys);
      out[id] = { id, name: s.name || id, base: s.base.replace(/\/+$/, ''), keys, source: keys.length ? 'dashboard' : 'none', enabled: s.enabled !== false, custom: true };
    }
  }
  return out;
}
async function loadModels() {
  let m = await getJSON('models', null);
  if (!Array.isArray(m)) { m = SEED_MODELS; await setJSON('models', m); }
  return m;
}

/* Tandai key bermasalah (habis/ditolak/rate-limit) supaya dilewati sementara */
async function markKeyBad(provId, keyId, status, error, ttlMs) {
  try {
    const stored = await getJSON('providers', {});
    const s = stored[provId];
    if (!s || !Array.isArray(s.keys)) return;
    const k = s.keys.find((x) => x.id === keyId);
    if (!k) return;
    k.cooldownUntil = Date.now() + (ttlMs || 60000);
    k.fails = (k.fails || 0) + 1;
    k.lastError = String(error || ('HTTP ' + status)).slice(0, 160);
    k.lastStatus = status || null;
    await setJSON('providers', stored);
  } catch (_) {}
}
async function markKeyGood(provId, keyId) {
  try {
    const stored = await getJSON('providers', {});
    const s = stored[provId];
    if (!s || !Array.isArray(s.keys)) return;
    const k = s.keys.find((x) => x.id === keyId);
    if (!k || (!k.fails && !k.cooldownUntil)) return;
    k.fails = 0; k.cooldownUntil = 0; k.lastError = null; k.lastStatus = null;
    await setJSON('providers', stored);
  } catch (_) {}
}

/* ---------- Kredit OpenRouter (cek % pemakaian per key) ---------- */
async function orCredit(rawKey, force) {
  const ck = 'orc:' + sha(rawKey).slice(0, 16);
  if (!force) {
    try { const c = await getJSON(ck, null); if (c && Date.now() - c.at < 300000) return c; } catch (_) {}
  }
  try {
    const r = await fetch('https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: 'Bearer ' + rawKey } });
    if (!r.ok) return null;
    const j = await r.json(); const d = j.data || {};
    const out = { used: d.usage != null ? Number(d.usage) : null, limit: d.limit != null ? Number(d.limit) : null, remaining: d.limit_remaining != null ? Number(d.limit_remaining) : null, free: !!d.is_free_tier, at: Date.now() };
    try { await redis(['SET', ck, JSON.stringify(out), 'EX', 600]); } catch (_) {}
    return out;
  } catch (_) { return null; }
}

/* ---------- Scan otomatis: cari model baru + cek model mana yang aktif ---------- */
const NON_CHAT = /embed|whisper|tts|guard|moderation|rerank|dall|image|audio|speech|transcribe|stable-diffusion|flux|veo|imagen|sora|ocr|safety/i;
function guessScore(id) {
  const s0 = String(id).toLowerCase();
  let s = 40;
  const m = s0.match(/(\d{1,4})b(?![a-z])/);
  if (m) s += Math.min(35, Math.log2(Number(m[1]) + 1) * 4.2);
  if (/gpt-5|opus|o3|o4|gemini-(2\.5|3)[^/]*pro|claude|grok-4|kimi-k2|qwen3-235|deepseek-(r1|v3)|gpt-oss-120|sonnet|command-a/.test(s0)) s += 20;
  if (/pro|large|ultra|max|405b/.test(s0)) s += 6;
  if (/flash|mini|lite|small|instant|nano|haiku|tiny|1b|3b/.test(s0)) s -= 8;
  return Math.max(1, Math.min(100, Math.round(s * 2) / 2));
}

async function detectModels(providers, models) {
  const have = new Set(models.map((m) => m.id));
  const added = [], errors = [], seen = {};
  await Promise.all(Object.values(providers).filter((p) => p.enabled && usableKeys(p).length).map(async (p) => {
    let list = null, lastErr = '';
    for (const k of usableKeys(p)) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
        const r = await fetch(p.base + '/models', { headers: { Authorization: 'Bearer ' + k.key }, signal: ctl.signal });
        clearTimeout(t);
        if (!r.ok) { lastErr = 'HTTP ' + r.status; if ([401, 403].includes(r.status)) continue; break; }
        const j = await r.json();
        list = (j.data || j.models || []).map((x) => String(x.id || x.name || '').replace(/^models\//, '')).filter(Boolean);
        break;
      } catch (e) { lastErr = e.name === 'AbortError' ? 'timeout' : String(e.message).slice(0, 80); }
    }
    if (!list) { errors.push({ provider: p.id, error: lastErr || 'gagal' }); return; }
    seen[p.id] = new Set(list);
    for (const id of list) {
      if (NON_CHAT.test(id)) continue;
      const full = p.id + '/' + id;
      if (have.has(full)) continue;
      have.add(full);
      added.push({ id: full, provider: p.id, model: id, score: guessScore(id), enabled: true, manual: false });
    }
  }));
  let stale = 0;
  for (const m of models) {
    if (m.manual) continue;
    const s = seen[m.provider];
    if (s && !s.has(m.model)) { if (!m.stale) { m.stale = true; stale++; } }
    else if (m.stale) m.stale = false;
  }
  const all = models.concat(added);
  await setJSON('models', all);
  return { added: added.length, stale, errors, total: all.length };
}

async function getHealth() { return await getJSON('health', {}); }

/* Probe ringan tiap model (max_tokens:1) untuk tahu mana yang benar-benar aktif */
async function healthScan(providers, models) {
  const health = await getHealth();
  const targets = models.filter((m) => m.enabled !== false && providers[m.provider] && providers[m.provider].enabled && usableKeys(providers[m.provider]).length)
    .sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 40);
  let ok = 0, dead = 0;
  const probe = async (m) => {
    const prov = providers[m.provider];
    const t0 = Date.now();
    let res = null;
    for (const k of usableKeys(prov)) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
        const r = await fetch(prov.base + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k.key },
          body: JSON.stringify({ model: m.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
          signal: ctl.signal,
        });
        clearTimeout(t);
        res = { status: r.status, ok: r.ok };
        try { await r.text(); } catch (_) {}
        if (r.ok) { await markKeyGood(prov.id, k.id); break; }
        if ([401, 429].includes(r.status)) { await markKeyBad(prov.id, k.id, r.status, 'health probe', r.status === 429 ? 90000 : 3600000); continue; }
        if ([402, 403].includes(r.status)) continue; // biasanya "model ini tak boleh dipakai key ini", bukan key mati -> jangan matikan akun
        break;
      } catch (e) { res = { status: 0, ok: false, error: e.name === 'AbortError' ? 'timeout' : String(e.message).slice(0, 80) }; }
    }
    const good = !!(res && res.ok);
    health[m.id] = { ok: good, at: Date.now(), ms: Date.now() - t0, status: res ? res.status : 0 };
    if (good) ok++; else dead++;
    if (res && res.status === 404 && !m.manual) {
      const i = models.findIndex((x) => x.id === m.id);
      if (i >= 0 && models[i].enabled !== false) models[i].enabled = false;
    }
  };
  const queue = targets.slice();
  await Promise.all(Array.from({ length: Math.min(5, queue.length) }, async () => {
    while (queue.length) { const m = queue.shift(); if (m) await probe(m); }
  }));
  await setJSON('health', health);
  await setJSON('models', models);
  try { await redis(['SET', 'lastscan', String(Date.now())]); } catch (_) {}
  return { checked: targets.length, ok, dead, at: Date.now() };
}

/* ---------- Pengaturan dashboard (live refresh, auto-scan) ---------- */
async function getSettings() {
  const s = await getJSON('settings', null);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

/* ---------- Auth ---------- */
async function authKey(req) {
  const h = req.headers.authorization || '';
  const k = h.replace(/^Bearer\s+/i, '').trim() || req.headers['x-api-key'];
  if (!k) return null;
  const v = await redis(['HGET', 'apikeys', sha(k)]);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
/* Status API key gateway: expired / nonaktif / kuota habis + % pemakaian */
async function gatewayKeyState(key) {
  let tok = 0, req = 0;
  try {
    const [t, r] = await pipeline([['HGET', 'ktotal', key.id], ['HGET', 'kreq', key.id]]);
    tok = Number(t) || 0; req = Number(r) || 0;
  } catch (_) {}
  const now = Date.now();
  let blocked = null;
  if (key.enabled === false) blocked = 'disabled';
  else if (key.expiresAt && now > key.expiresAt) blocked = 'expired';
  else if (key.limit && tok >= key.limit) blocked = 'quota';
  return { blocked, tok, req, pct: key.limit ? Math.round(100 * tok / key.limit) : null, remaining: key.limit ? Math.max(0, key.limit - tok) : null };
}
const SECRET = () => { if (!process.env.ADMIN_SECRET) throw new Error('ADMIN_SECRET belum di-set'); return process.env.ADMIN_SECRET; };
function signSession(email) {
  const p = Buffer.from(JSON.stringify({ email, exp: Date.now() + 7 * 864e5 })).toString('base64url');
  const s = crypto.createHmac('sha256', SECRET()).update(p).digest('base64url');
  return p + '.' + s;
}
function verifySession(t) {
  try {
    const [p, s] = String(t).split('.');
    const e = crypto.createHmac('sha256', SECRET()).update(p).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (d.exp < Date.now() || d.email !== ALLOWED_EMAIL) return null;
    return d;
  } catch { return null; }
}
async function verifyGoogle(cred) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred));
  if (!r.ok) return null;
  const j = await r.json();
  if (!process.env.GOOGLE_CLIENT_ID || j.aud !== process.env.GOOGLE_CLIENT_ID) return null;
  if (String(j.email_verified) !== 'true') return null;
  const email = String(j.email || '').toLowerCase();
  if (email !== ALLOWED_EMAIL) return null;
  return { email, name: j.name, picture: j.picture };
}

/* ---------- Pencatatan usage ---------- */
async function record({ key, provider, provKeyId, model, tok, ok, ms, requested, status, fails, rl }) {
  const day = dayStr(0), u = 'u:' + day;
  const cmds = [['HINCRBY', u, 'req', 1]];
  if (key && key.id) cmds.push(['HINCRBY', 'kreq', key.id, 1]);
  if (ok) {
    cmds.push(['HINCRBY', u, 'tok', tok], ['HINCRBY', u, 'p:' + provider, tok], ['HINCRBY', u, 'pr:' + provider, 1],
      ['HINCRBY', u, 'm:' + model, tok]);
    if (key && key.id) cmds.push(['HINCRBY', u, 'k:' + key.id, tok], ['HINCRBY', 'ktotal', key.id, tok]);
    if (provider && provKeyId) {
      cmds.push(['HINCRBY', 'pku', provider + ':' + provKeyId, tok]);
      cmds.push(['HSET', 'pklast', provider + ':' + provKeyId, String(Date.now())]);
    }
  } else cmds.push(['HINCRBY', u, 'err', 1]);
  cmds.push(['EXPIRE', u, 3456000]);
  cmds.push(['LPUSH', 'logs', JSON.stringify({ t: new Date().toISOString(), key: key ? key.name : null, requested, model: model || null, provider: provider || null, provKey: provKeyId || null, status, ms, tok: tok || 0, fails: fails || [] })]);
  cmds.push(['LTRIM', 'logs', 0, 199]);
  if (rl && provider && Object.keys(rl).length) cmds.push(['SET', 'rl:' + provider, JSON.stringify({ ...rl, at: Date.now() }), 'EX', 86400]);
  try { await pipeline(cmds); } catch (_) { /* jangan gagalkan respons */ }
}

module.exports = { BUILTIN, SEED_MODELS, DEFAULT_SETTINGS, redis, pipeline, getJSON, setJSON, sha, dayStr, est, hgetallObj, getPath, cors, sendErr, maskKey,
  normalizeKeys, keyStatus, keyPct, usableKeys, loadProviders, loadModels, markKeyBad, markKeyGood, orCredit,
  detectModels, healthScan, getHealth, getSettings, guessScore, NON_CHAT, authKey, gatewayKeyState, signSession, verifySession, verifyGoogle, record, ALLOWED_EMAIL };
