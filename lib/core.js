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
  res.setHeader('Access-Control-Expose-Headers', 'x-gateway-model, x-gateway-provider, x-gateway-attempts');
}
const sendErr = (res, code, msg, extra) => res.status(code).json({ error: { message: msg, type: 'gateway_error', ...(extra || {}) } });

/* ---------- Provider & model ---------- */
async function loadProviders() {
  const stored = await getJSON('providers', {});
  const out = {};
  for (const [id, d] of Object.entries(BUILTIN)) {
    const s = stored[id] || {};
    const envKey = process.env[d.env] || '';
    const key = s.apiKey || envKey;
    out[id] = { id, name: d.name, base: d.base, key, source: s.apiKey ? 'dashboard' : envKey ? 'env' : 'none', enabled: s.enabled !== false, custom: false };
  }
  for (const [id, s] of Object.entries(stored)) {
    if (s.custom && s.base) out[id] = { id, name: s.name || id, base: s.base.replace(/\/+$/, ''), key: s.apiKey || '', source: s.apiKey ? 'dashboard' : 'none', enabled: s.enabled !== false, custom: true };
  }
  return out;
}
async function loadModels() {
  let m = await getJSON('models', null);
  if (!Array.isArray(m)) { m = SEED_MODELS; await setJSON('models', m); }
  return m;
}

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

/* ---------- Auth ---------- */
async function authKey(req) {
  const h = req.headers.authorization || '';
  const k = h.replace(/^Bearer\s+/i, '').trim() || req.headers['x-api-key'];
  if (!k) return null;
  const v = await redis(['HGET', 'apikeys', sha(k)]);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
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
async function record({ key, provider, model, tok, ok, ms, requested, status, fails, rl }) {
  const day = dayStr(0), u = 'u:' + day;
  const cmds = [['HINCRBY', u, 'req', 1]];
  if (ok) {
    cmds.push(['HINCRBY', u, 'tok', tok], ['HINCRBY', u, 'p:' + provider, tok], ['HINCRBY', u, 'pr:' + provider, 1],
      ['HINCRBY', u, 'm:' + model, tok], ['HINCRBY', u, 'k:' + key.id, tok], ['HINCRBY', 'ktotal', key.id, tok]);
  } else cmds.push(['HINCRBY', u, 'err', 1]);
  cmds.push(['EXPIRE', u, 3456000]);
  cmds.push(['LPUSH', 'logs', JSON.stringify({ t: new Date().toISOString(), key: key.name, requested, model: model || null, provider: provider || null, status, ms, tok: tok || 0, fails: fails || [] })]);
  cmds.push(['LTRIM', 'logs', 0, 199]);
  if (rl && provider && Object.keys(rl).length) cmds.push(['SET', 'rl:' + provider, JSON.stringify({ ...rl, at: Date.now() }), 'EX', 86400]);
  try { await pipeline(cmds); } catch (_) { /* jangan gagalkan respons */ }
}

module.exports = { BUILTIN, SEED_MODELS, redis, pipeline, getJSON, setJSON, sha, dayStr, est, hgetallObj, getPath, cors, sendErr,
  loadProviders, loadModels, guessScore, NON_CHAT, authKey, signSession, verifySession, verifyGoogle, record, ALLOWED_EMAIL };
