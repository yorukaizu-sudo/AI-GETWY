const crypto = require('crypto');
const RU = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const RT = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const OWNER = (process.env.OWNER_EMAIL || 'yorukaizu@gmail.com').toLowerCase();
const CID = process.env.GOOGLE_CLIENT_ID || '';
const SECRET = process.env.SESSION_SECRET || '';
const KEY = 'yg:db';
const NONCHAT = /whisper|embed|tts|guard|moderat|dall|imagen|rerank|speech|transcri|diffusion|flux|veo|lyria|audio|playai|orpheus|safeguard/i;

const now = () => Math.floor(Date.now() / 1000);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const fail = (c, m, x) => { const e = new Error(m); e.code = c; e.x = x; throw e; };
const send = (res, c, d) => { res.statusCode = c; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(d)); };
const mask = k => String(k).slice(0, 4) + '…' + String(k).slice(-3);

// ---- Database: satu key JSON di Upstash Redis ----
async function redis(cmd) {
  if (!RU || !RT) fail(500, 'Database belum terhubung (Upstash Redis)');
  const r = await fetch(RU, { method: 'POST', headers: { Authorization: 'Bearer ' + RT }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) fail(500, 'Redis: ' + j.error);
  return j.result;
}
const def = () => ({ providers: {}, models: {}, keys: [], logs: [], stats: { req: 0, tok: 0 } });
async function load() { const s = await redis(['GET', KEY]); return s ? { ...def(), ...JSON.parse(s) } : def(); }
async function tx(f) { const d = await load(); const r = await f(d); await redis(['SET', KEY, JSON.stringify(d)]); return r; }

// ---- HTTP keluar dengan timeout ----
async function http(method, url, headers = {}, body, timeout = 20000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { method, headers, body, signal: ac.signal });
    return { c: r.status, r: await r.text(), h: Object.fromEntries(r.headers), e: '' };
  } catch (e) { return { c: 0, r: '', h: {}, e: String(e.message || e) }; }
  finally { clearTimeout(t); }
}
const hd = p => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key, 'X-Title': 'Yoru Gateway' });

// ---- Session cookie bertanda tangan (stateless) ----
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const mkSession = () => { const e = String(now() + 604800); return e + '.' + sign(e); };
function okSession(req) {
  const m = /(?:^|;\s*)yg_s=([^;]+)/.exec(req.headers.cookie || '');
  if (!m || !SECRET) return false;
  const [e, s] = m[1].split('.'); if (!e || !s || +e < now()) return false;
  const g = sign(e); return s.length === g.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(g));
}

// ---- Skor kecerdasan otomatis (bisa diubah manual) ----
function score(id) {
  const s = id.toLowerCase();
  const tiers = [
    [96, /opus|mythos|fable|gpt-5(?!.*(mini|nano))|gemini-3(\.\d)?-pro|grok-4(?!.*fast)/],
    [92, /sonnet|gemini-2\.5-pro|\bo3(?!-mini)|kimi-k2|deepseek-(r1|v3\.[1-9])|qwen3-(max|coder|235)|glm-[45]\.\d|gpt-oss-120b|llama-4-maverick|minimax-m2/],
    [84, /gemini-(2\.5|3)-flash(?!-lite)|gpt-5|gpt-4\.1|gpt-4o(?!-mini)|llama-3\.(1-405|3-70)|mistral-(large|medium)|deepseek|qwen3|command-a|gpt-oss|llama-4/],
  ];
  for (const [v, re] of tiers) if (re.test(s)) return v;
  const m = /(\d+(?:\.\d+)?)b/.exec(s), n = m ? parseFloat(m[1]) : 20;
  return Math.floor(35 + Math.min(45, Math.sqrt(n) * 3.5)) - (/mini|lite|nano|small|tiny|haiku|instant|8b/.test(s) ? 8 : 0);
}

// ---- Detect model + cek kredit (fetch di luar tx, apply di dalam tx) ----
async function fetchModels(p) {
  const u = p.url.replace(/\/+$/, '');
  const r = await http('GET', u + '/models', hd(p));
  let j; try { j = JSON.parse(r.r); } catch {}
  if (r.c !== 200 || !j || !Array.isArray(j.data) || !j.data.length) return { err: 'Sync gagal (HTTP ' + r.c + '), cek URL atau key' };
  const list = [];
  for (const x of j.data) {
    const id = String(x.id || '').replace(/^models\//, '');
    if (!id || NONCHAT.test(id)) continue;
    if (p.free && x.pricing && (parseFloat(x.pricing.prompt ?? 1) > 0 || parseFloat(x.pricing.completion ?? 1) > 0)) continue;
    list.push(id);
  }
  let credit = null;
  if (u.includes('openrouter')) { const k = await http('GET', u + '/auth/key', hd(p), undefined, 15000); try { credit = JSON.parse(k.r).data; } catch {} }
  return { list, credit };
}
function applySync(d, id, res) {
  const p = d.providers[id]; if (!p) return;
  if (res.err) { p.msg = res.err; return; }
  let n = 0;
  for (const mid of res.list) { const k = id + '|' + mid; if (!d.models[k]) { d.models[k] = { p: id, id: mid, score: score(mid), on: true, custom: false, cool: 0, ok: 0, fail: 0 }; n++; } }
  if (res.credit) { p.credit_used = res.credit.usage ?? null; p.credit_left = res.credit.limit_remaining ?? null; }
  p.synced = now(); p.msg = 'Sync OK, ' + n + ' model baru';
}

module.exports = { crypto, CID, SECRET, OWNER, RU, RT, now, sha, fail, send, mask, load, tx, http, hd, mkSession, okSession, score, fetchModels, applySync };
