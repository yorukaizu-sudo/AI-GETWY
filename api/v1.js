'use strict';
const C = require('../lib/core');

const ATTEMPT_MS = Number(process.env.ATTEMPT_MS) || 25000;   // batas per percobaan untuk model biasa (auto)
const PICKED_MS = Number(process.env.PICKED_MS) || 50000;    // model yang DIPILIH MANUAL lebih sabar (model reasoning/ultra sering lambat)
const BUDGET_MS = Number(process.env.BUDGET_MS) || 52000;    // total waktu 1 request (Vercel maxDuration 60s)
const FAIL_NEW = Number(process.env.FAIL_NEW) || 2;        // model yang BELUM PERNAH berhasil: nonaktif otomatis setelah gagal sebanyak ini
const FAIL_PROVEN = Number(process.env.FAIL_PROVEN) || 5;  // model yang PERNAH berhasil: nonaktif hanya setelah gagal beruntun sebanyak ini (1 hitungan per request)
const MAX_ATTEMPTS = 40;   // cukup untuk memutar belasan akun + beberapa model
// Mode: model "auto" = pilih model terbaik + fallback (model yang gagal dinonaktifkan sampai pulih).
// Model spesifik = MODE SELECT: SELALU strict, tidak pernah pindah model, dicoba terus sampai berhasil / waktu request habis.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* Batas input model yang "dipelajari" dari error 413 / context-length. Model yang pasti tidak muat dilewati
   (tidak buang percobaan & waktu) untuk request besar berikutnya. Disimpan 6 jam. */
function parseLimit(t) {
  t = String(t || '');
  const m = /limit\s*(?:of\s*)?[:=]?\s*(\d{3,7})/i.exec(t) || /maximum context length (?:is|of) (\d{3,7})/i.exec(t)
    || /context (?:length|window|size)[^0-9]{0,40}(\d{3,7})/i.exec(t) || /(?:max(?:imum)?|up to|supports?)[^0-9]{0,30}(\d{4,7})\s*(?:input\s*)?tokens/i.exec(t);
  return m ? Number(m[1]) : 0;
}
const TOOL_RE = /\btools?\b|function[ _-]?call|tool[ _-]?choice/i;

/* ---------- nonaktif otomatis ----------
   Kesalahan AKUN (429 / 401 / 402 / 403 / pesan rate-limit) TIDAK PERNAH dihitung sebagai kesalahan model: akun diistirahatkan,
   model tetap aktif, lalu dicoba dengan API key lain. Yang dihitung hanya kegagalan milik model itu sendiri
   (404, model ditolak, timeout, 5xx, respons kosong). */
const RATE_RE = /rate.?limit|too many requests|quota|\b429\b|insufficient|credit|exhausted/i;
const MODEL_GONE_RE = /model[^.]{0,60}(not found|does not exist|doesn't exist|unknown|invalid|unsupported|not supported|not available|no longer)|(?:not found|does not exist|unknown|invalid)[^.]{0,30}model/i;
const PROVEN = new Set();   // cache per instance: model yang pernah berhasil
async function isProven(id) {
  if (PROVEN.has(id)) return true;
  try {
    const [h, hs] = await Promise.all([C.redis(['HEXISTS', 'mok', id]), C.getHealth()]);
    if (Number(h) === 1 || (hs && hs[id] && hs[id].ok === true)) { PROVEN.add(id); return true; }
  } catch (_) {}
  return false;
}
async function autoDisable(id, why) {
  try {
    const models = await C.loadModels(true);
    const i = models.findIndex((x) => x.id === id);
    if (i < 0 || models[i].enabled === false) return;
    models[i].enabled = false;
    models[i].autoOff = { at: Date.now(), why: String(why).slice(0, 160) };
    await C.setJSON('models', models);
  } catch (_) {}
}

function pickRL(h) {
  const g = (n) => h.get(n);
  const o = {
    remTok: g('x-ratelimit-remaining-tokens'), limTok: g('x-ratelimit-limit-tokens'),
    remReq: g('x-ratelimit-remaining-requests'), limReq: g('x-ratelimit-limit-requests'),
    resetTok: g('x-ratelimit-reset-tokens'),
  };
  Object.keys(o).forEach((k) => (o[k] == null || o[k] === '') && delete o[k]);
  return o;
}

/* "1m30s" | "7.66s" | "45" -> detik */
function parseDur(s) {
  if (s == null) return 0; s = String(s).trim(); if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  let t = 0, m; const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  while ((m = re.exec(s))) t += Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
  return t;
}
/* lama cooldown akun saat 429: ikuti retry-after / header reset dari provider (10 dtk .. 1 jam) */
function cooldownMs(h, txt) {
  let s = 0;
  const ra = h.get('retry-after');
  if (ra) s = /^\d+(\.\d+)?$/.test(ra) ? Number(ra) : Math.max(0, (Date.parse(ra) - Date.now()) / 1000) || 0;
  if (!s) s = parseDur(h.get('x-ratelimit-reset-requests')) || parseDur(h.get('x-ratelimit-reset-tokens'));
  const rd = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(txt || '');
  if (!s && rd) s = Number(rd[1]);
  if (!s) s = 60;
  return Math.max(10, Math.min(3600, Math.round(s))) * 1000;
}

/* ---------- "penyembuh" parameter ----------
   Klien agent (mis. plugin Roblox) mengirim parameter opsional (reasoning_effort, stream_options,
   max_tokens besar, ...). Provider tertentu menolak dgn 400. Daripada gagal, parameter yg ditolak
   dibuang / dikecilkan lalu dicoba lagi pada model & akun yang sama. */
const OPTIONAL = ['reasoning_effort', 'reasoning', 'stream_options', 'parallel_tool_calls', 'logprobs', 'top_logprobs', 'store', 'metadata',
  'service_tier', 'user', 'seed', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'n', 'response_format', 'verbosity', 'prediction', 'modalities', 'audio', 'web_search_options', 'chat_template_kwargs', 'thinking'];
function heal(body, fix, txt) {
  const t = String(txt || ''), low = t.toLowerCase();
  let changed = false;
  const quoted = new Set(); const re = /['"`]([a-z_]{1,40})['"`]/gi; let mm;
  while ((mm = re.exec(t))) quoted.add(mm[1].toLowerCase());
  OPTIONAL.forEach((p) => {
    if (body[p] === undefined || fix.strip.has(p)) return;
    if (quoted.has(p) || (p.length > 6 && low.includes(p))) { fix.strip.add(p); changed = true; }
  });
  // batas max_tokens: "... must be <= 8192", "maximum value for max_tokens is 4096"
  if (/max[_ ]?(completion[_ ])?tokens|output tokens|context/i.test(t)) {
    const cap = /(?:<=|≤|less than or equal to|at most|maximum(?: allowed)?(?: value)?(?: for [a-z_ ]+?)?(?: is| of| to)?|supports? (?:up to|at most)|limit(?:ed)? (?:is|to))\s*(\d{3,7})/i.exec(t);
    if (cap) {
      const n = Number(cap[1]);
      ['max_tokens', 'max_completion_tokens'].forEach((f) => { if (body[f] != null && Number(body[f]) > n && fix.caps[f] !== n) { fix.caps[f] = n; changed = true; } });
    }
  }
  // max_tokens <-> max_completion_tokens
  if (/unsupported|not supported|unrecognized|unknown|extra|invalid/i.test(t)) {
    if (low.includes('max_completion_tokens') && body.max_completion_tokens != null && !fix.rename.max_completion_tokens) { fix.rename.max_completion_tokens = 'max_tokens'; changed = true; }
    else if (low.includes('max_tokens') && body.max_tokens != null && !fix.rename.max_tokens && !fix.rename.max_completion_tokens) { fix.rename.max_tokens = 'max_completion_tokens'; changed = true; }
  }
  // riwayat tool-call tidak cocok -> ubah tool_call/hasil tool jadi teks biasa lalu coba lagi pada model & akun yang sama
  if (!fix.flat && TOOLMATCH_RE.test(t) && Array.isArray(body.messages) && body.messages.some((m) => m && (m.role === 'tool' || m.tool_calls))) { fix.flat = true; changed = true; }
  return changed;
}
/* ---------- perbaikan riwayat tool-call ----------
   Klien agent kadang mengirim riwayat yang rusak (assistant minta tool tapi hasilnya tak ada, atau hasil tool yatim) setelah
   giliran yang terputus. Provider ketat (GLM, Claude, OpenAI) menolak dgn 400 "tool calls and tool results do not match".
   Di sini riwayat dirapikan: tool_call tanpa hasil diberi hasil kosong, hasil tool yatim dibuang. Riwayat yang sudah benar TIDAK diubah. */
function sanitizeMessages(msgs) {
  if (!Array.isArray(msgs)) return { messages: msgs, changed: false };
  const out = []; let changed = false;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const follow = []; let j = i + 1;
      while (j < msgs.length && msgs[j] && msgs[j].role === 'tool') { follow.push(msgs[j]); j++; }
      const ids = m.tool_calls.map((t) => t && t.id).filter(Boolean);
      out.push(m);
      if (ids.length !== m.tool_calls.length) { out.push(...follow); i = j - 1; continue; }   // tool_call tanpa id: jangan disentuh
      for (const id of ids) {
        const f = follow.find((t) => t.tool_call_id === id);
        if (f) out.push(f); else { out.push({ role: 'tool', tool_call_id: id, content: '(hasil tool tidak tersedia)' }); changed = true; }
      }
      if (follow.length !== ids.length || follow.some((t) => !ids.includes(t.tool_call_id))) changed = true;
      i = j - 1; continue;
    }
    if (m && m.role === 'tool') { changed = true; continue; }   // hasil tool tanpa assistant tool_calls di depannya
    out.push(m);
  }
  return { messages: out, changed };
}
/* Cadangan terakhir bila provider tetap menolak: ubah semua tool_call/hasil tool jadi teks biasa (semua provider menerimanya) */
function flattenTools(msgs) {
  return (msgs || []).map((m) => {
    if (!m) return m;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map((t) => '[memanggil tool ' + ((t && t.function && t.function.name) || '?') + '(' + String((t && t.function && t.function.arguments) || '').slice(0, 2000) + ')]').join('\n');
      const { tool_calls, ...rest } = m;
      return { ...rest, content: (typeof m.content === 'string' && m.content ? m.content + '\n' : '') + calls };
    }
    if (m.role === 'tool') return { role: 'user', content: '[hasil tool' + (m.name ? ' ' + m.name : '') + ']\n' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) };
    return m;
  });
}
const TOOLMATCH_RE = /tool[ _-]?(calls?|results?|use|call_id)[^.]{0,80}(match|mismatch|missing|must|follow|correspond|without|not found)|tool_call_id|tool_use_id/i;
function applyFix(body, fix) {
  if (!fix.strip.size && !Object.keys(fix.caps).length && !Object.keys(fix.rename).length && !fix.flat) return body;
  const b = { ...body };
  if (fix.flat) b.messages = flattenTools(b.messages);
  fix.strip.forEach((p) => delete b[p]);
  for (const [f, n] of Object.entries(fix.caps)) if (b[f] != null && Number(b[f]) > n) b[f] = n;
  for (const [from, to] of Object.entries(fix.rename)) if (b[from] != null) { if (b[to] == null) b[to] = b[from]; delete b[from]; }
  return b;
}

/* "kenapa gagal" dalam 1 kalimat, supaya terbaca langsung di aplikasi klien */
function explain(fails) {
  const seen = new Set(), out = [];
  for (let i = fails.length - 1; i >= 0 && out.length < 4; i--) {
    const f = fails[i];
    let why = f.error || '';
    try { const j = JSON.parse(why); why = (j.error && (j.error.message || j.error)) || j.message || j.detail || why; } catch (_) {}
    why = String(typeof why === 'string' ? why : JSON.stringify(why)).replace(/\s+/g, ' ').slice(0, 110);
    const line = f.model + (f.key ? ' [' + f.key + ']' : '') + ' → ' + (f.status || 'jaringan') + (why ? ' ' + why : '');
    if (!seen.has(line)) { seen.add(line); out.push(line); }
  }
  return out.reverse().join(' | ');
}

/* buang awalan nomor dari klien: "1/nvidia/x" -> "nvidia/x" */
const stripNum = (s) => String(s || '').trim().replace(/^\d+\//, '');
const isAuto = (s) => { const r = stripNum(s).toLowerCase(); return !r || r === 'auto' || r === 'gateway/auto'; };
const mode0 = (s) => (isAuto(s) ? 'auto' : 'select');
/* 429 yang dibawa model/upstream-nya (mis. model :free OpenRouter "temporarily rate-limited upstream") BUKAN salah akun:
   jangan istirahatkan API key, karena key yang sama masih sehat untuk model lain. */
const UPSTREAM_RE = /upstream|temporarily rate.?limited|provider returned error|no endpoints|overloaded|capacity/i;

/* cocokkan nama model dari klien: "provider/model", "model", atau dgn awalan nomor ("1/nvidia/...") */
function findPicked(requested, models, includeOff) {
  const n = (s) => String(s || '').toLowerCase();
  const r = n(requested).trim(), r2 = n(stripNum(requested));
  const rank = (m) => (n(m.id) === r || n(m.id) === r2 ? 0 : 1);
  return models.filter((m) => {
    if (!includeOff && m.enabled === false) return false;
    const id = n(m.id), mo = n(m.model);
    return id === r || mo === r || id === r2 || mo === r2 || id.endsWith('/' + r2);
  }).sort((a, b) => rank(a) - rank(b) || (b.score || 0) - (a.score || 0));
}
function similar(requested, models) {
  const t = stripNum(requested).toLowerCase().split('/').pop();
  const key = t.slice(0, Math.max(4, Math.min(8, t.length)));
  return models.filter((m) => m.enabled !== false && m.id.toLowerCase().includes(key)).slice(0, 5).map((m) => m.id);
}

/* Kandidat model.
   AUTO  : semua model aktif, urut skor (sehat dulu) + fallback.
   SELECT: HANYA model pilihan user. Fallback ke model lain hanya kalau `fallback` (setting dashboard) menyala. */
async function buildCandidates(requested, providers, models, hasTools, fallback, promptTok) {
  const provOn = (m) => { const p = providers[m.provider]; return m.enabled !== false && p && p.enabled; };
  const usable = (m) => provOn(m) && C.usableKeys(providers[m.provider]).length > 0;
  // model pilihan: akun yang sedang cooldown tetap boleh dicoba (user memilih eksplisit, jangan diam-diam dilewati).
  // Model yang dinonaktifkan OTOMATIS (autoOff) tetap dipakai kalau user memilihnya; hanya yang dimatikan manual yang ditolak.
  const reachable = (m) => { const p = providers[m.provider]; return (m.enabled !== false || !!m.autoOff) && p && p.enabled && (p.keys || []).some((k) => k.key && ['active', 'cooldown'].includes(C.keyStatus(k))); };
  let stickyId = null;
  const autoList = async (exclude, useSticky) => {
    const list = models.filter((m) => usable(m) && !exclude.has(m.id)).sort((a, b) => (b.score || 0) - (a.score || 0));
    if (!list.length) return list;
    let cd = [], health = {}, nt = [], ml = [], lastok = null, pcdv = [];
    const pids = [...new Set(list.map((m) => m.provider))];
    try {
      // SATU perintah MGET untuk semua status (cooldown, no-tools, batas ukuran, provider bermasalah, model lengket)
      const n = list.length;
      const ks = [...list.map((m) => 'cd:' + m.id), ...(hasTools ? list.map((m) => 'nt:' + m.id) : []), ...list.map((m) => 'ml:' + m.id), ...pids.map((p) => 'pcd:' + p), ...(useSticky ? ['lastok'] : [])];
      const [vals, h] = await Promise.all([C.redis(['MGET', ...ks]), C.getHealth()]);
      let o = 0;
      cd = vals.slice(o, o += n); if (hasTools) nt = vals.slice(o, o += n); ml = vals.slice(o, o += n); pcdv = vals.slice(o, o += pids.length);
      lastok = useSticky ? vals[o] : null; health = h;
    } catch (_) {}
    // sehat & tidak cooldown dulu; model yg diketahui tak mendukung tools diturunkan saat request memakai tools
    const pbad = new Set(pids.filter((p, i) => pcdv[i]));   // provider yang barusan banyak gagal
    const tier = (m, i) => (health[m.id] && health[m.id].ok === false ? 4 : 0) + (nt[i] ? 2 : 0) + (cd[i] ? 1 : 0) + (pbad.has(m.provider) ? 1 : 0);
    const ranked = list.map((m, i) => ({ m, i, t: tier(m, i), s: m.score || 0 })).sort((a, b) => a.t - b.t || b.s - a.s);
    const fit = ranked.filter((x) => !(ml[x.i] && promptTok > Number(ml[x.i])));   // buang model yang sudah terbukti tak muat prompt sebesar ini
    const out = (fit.length ? fit : ranked).map((x) => x.m);
    // AUTO "lengket": model yang terakhir berhasil dipakai paling depan, sampai dia gagal
    const si = lastok ? out.findIndex((m) => m.id === lastok) : -1;
    if (si >= 0) { stickyId = lastok; if (si > 0) out.unshift(out.splice(si, 1)[0]); }
    return out;
  };

  if (isAuto(requested)) { const list = await autoList(new Set(), true); return { list, picked: new Set(), mode: 'auto', info: {}, sticky: stickyId }; }

  const r2 = stripNum(requested);
  const all = findPicked(requested, models, true);
  let first = all.filter((m) => m.enabled !== false || m.autoOff);
  if (!first.length && !all.length) {   // di luar daftar (BUKAN model yang sengaja dimatikan di dashboard): coba "provider/model" langsung (dua kemungkinan penulisan id, mis. NVIDIA "nvidia/nemotron-...")
    const i = r2.indexOf('/');
    if (i > 0) {
      const pid = r2.slice(0, i), p = providers[pid];
      if (p && p.enabled) {
        first = [...new Set([r2.slice(i + 1), r2])].map((mn) => ({ id: pid + '/' + mn, provider: pid, model: mn, score: 0, onTheFly: true }));
      }
    }
  }
  const firstOk = first.filter(reachable);
  const picked = new Set(firstOk.map((m) => m.id));
  const info = { found: first.length, disabled: all.filter((m) => m.enabled === false).length, noKey: first.length - firstOk.length, autoOff: (all.find((m) => m.enabled === false && m.autoOff) || {}).autoOff };
  if (!fallback) return { list: firstOk, picked, mode: 'select', info };
  const rest = await autoList(new Set(first.map((m) => m.id)));
  return { list: firstOk.concat(rest), picked, mode: 'select', info };
}

/* timeout tetap berlaku sampai body selesai dibaca (panggil done() setelahnya) */
async function callUpstream(prov, provKey, body, model, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const done = () => clearTimeout(timer);
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + provKey.key };
  if (prov.id === 'openrouter') { headers['HTTP-Referer'] = process.env.SITE_URL || 'https://vercel.app'; headers['X-Title'] = 'Yoru Gateway'; }
  try {
    const r = await fetch(prov.base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...body, model }), signal: ctl.signal });
    return { r, done };
  } catch (e) { done(); throw e; }
}

async function chat(req, res, key, st) {
  const t0 = Date.now();
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}; } catch (_) { return C.sendErr(res, 400, 'Body bukan JSON yang valid'); }
  if (!Array.isArray(body.messages)) return C.sendErr(res, 400, 'messages wajib berupa array');
  const sm = sanitizeMessages(body.messages);
  if (sm.changed) body.messages = sm.messages;
  const requested = body.model || 'auto';
  const stream = !!body.stream;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const reqChars = JSON.stringify(body.messages).length;

  /* Batas keras kuota token. PENTING: max_tokens TIDAK boleh disuntikkan raksasa — banyak provider
     (NVIDIA, Groq, dll) menjawab 400 kalau max_tokens melebihi batas model, dan itu membuat SEMUA model gagal.
     Dipasang hanya bila klien sendiri yang minta, atau sisa kuota memang kecil. Limit berbasis request tidak ikut dihitung. */
  if (key.limit && key.limitType !== 'request') {
    const left = key.limit - ((st && st.tok) || 0);
    const promptTok = C.est(reqChars);
    if (promptTok >= left) return C.sendErr(res, 429, `Sisa kuota ${Math.max(0, left)} token tidak cukup untuk request ini (perkiraan prompt ${promptTok} token).`);
    const cap = left - promptTok;
    if (body.max_tokens != null || body.max_completion_tokens != null) {
      if (body.max_tokens != null) body.max_tokens = Math.min(Number(body.max_tokens) || cap, cap);
      if (body.max_completion_tokens != null) body.max_completion_tokens = Math.min(Number(body.max_completion_tokens) || cap, cap);
    } else if (cap < 16384) body.max_tokens = cap;
  }

  const [providers, models, settings] = await Promise.all([C.loadProviders(), C.loadModels(), C.getSettings().catch(() => C.DEFAULT_SETTINGS)]);
  const fallback = false;   // model yang DIPILIH user selalu strict: tidak pernah pindah ke model lain (pengaturan selectFallback diabaikan)
  if (mode0(requested) === 'auto') C.reviveOff().catch(() => {});   // model yang dinonaktifkan otomatis dicek ulang di belakang layar; aktif lagi begitu sudah bisa dipakai
  const { list: cands, picked, mode, info, sticky } = await buildCandidates(requested, providers, models, hasTools, fallback, C.est(reqChars));
  if (!cands.length) {
    if (mode === 'select') {
      let msg;
      if (!info.found && info.disabled) msg = `Model "${requested}" ` + 'dinonaktifkan manual di dashboard → Model Atlas. Aktifkan lagi di sana.';
      else if (info.found && info.noKey) msg = `Model "${requested}" ada, tapi provider-nya tidak punya API key yang bisa dipakai (nonaktif / expired / limit habis).`;
      else {
        const sim = similar(requested, models);
        msg = `Model "${requested}" tidak ditemukan di gateway.` + (sim.length ? ' Mirip: ' + sim.join(', ') + '.' : '') + ' Pakai "auto" atau pilih dari /v1/models.';
      }
      return C.sendErr(res, 404, msg);
    }
    const anyKey = Object.values(providers).some((p) => p.enabled && C.usableKeys(p).length);
    return C.sendErr(res, 400, anyKey ? 'Belum ada model aktif. Tambahkan model di dashboard.' : 'Belum ada API key provider yang aktif (bisa jadi semua expired / kena limit). Atur di dashboard → Providers.');
  }

  const fails = [];
  let attempts = 0, healTries = 0;
  const fixes = {};
  const retried = {};
  const tried = new Set(); // akun (provider:key) yang benar-benar sudah dicoba
  const dead = new Set();  // model yang gagalnya pasti permanen utk request ini (404 / terlalu besar / ditolak) -> tidak diulang di putaran ke-2
  const learn = (m, code, txt) => {
    const ptok = C.est(reqChars);
    const big = code === 413 || ((code === 400 || code === 422) && /context|too long|too large|reduce (?:your|the)|exceed/i.test(txt) && !/max[_ ]?(completion[_ ])?tokens/i.test(txt));
    if (!big || ptok < 2000) return;
    let L = parseLimit(txt);
    if (!(L >= 1000 && L < ptok)) L = Math.floor(ptok * 0.85);
    C.redis(['SET', 'ml:' + m.id, String(L), 'EX', 6 * 3600]).catch(() => {});
  };
  const fixOf = (pid) => fixes[pid] || (fixes[pid] = { strip: new Set(), caps: {}, rename: {} });
  const pfail = {};   // provider -> jumlah model yang gagal "lunak" (5xx/timeout/jaringan/kosong) di request ini
  const cd = (id, sec) => {
    const pid = id.split('/')[0];
    if (sec < 100) {   // kegagalan lunak (bukan 404 / izin model)
      pfail[pid] = (pfail[pid] || 0) + 1;
      if (pfail[pid] >= 2) C.redis(['SET', 'pcd:' + pid, '1', 'EX', 90]).catch(() => {});
    }
    if (sticky && id === sticky) C.redis(['DEL', 'lastok']).catch(() => {});   // model lengket gagal -> lupakan, cari yang respon
    return C.redis(['INCR', 'cf:' + id]).then((n) => {
      C.redis(['EXPIRE', 'cf:' + id, 1800]).catch(() => {});
      const s2 = Math.min(1200, sec * 2 ** Math.min(5, (Number(n) || 1) - 1));   // 45s, 90s, 3m, 6m ... maks 20 mnt
      return C.redis(['SET', 'cd:' + id, '1', 'EX', s2]);
    }).catch(() => {});
  };

  const provenMap = {}, struck = new Set(), offNow = new Set();
  const softMax = (m) => (provenMap[m.id] ? 3 : 2);   // model yang pernah berhasil: coba sampai 3 API key sebelum pindah model
  /* Catat 1 kegagalan MILIK MODEL. Return true bila model barusan dinonaktifkan (pemanggil langsung pindah model). */
  const strike = async (m, why, certain) => {
    why = String(why || '');
    if (m.onTheFly || offNow.has(m.id) || RATE_RE.test(why)) return false;
    if (picked.has(m.id)) return false;   // model PILIHAN user tidak pernah dinonaktifkan otomatis: terus dicoba sampai berhasil
    const proven = provenMap[m.id] = await isProven(m.id);
    if (proven) { if (struck.has(m.id)) return false; struck.add(m.id); }   // model terbukti: maks 1 hitungan per request
    const limit = proven ? FAIL_PROVEN : (certain ? 1 : FAIL_NEW);
    let n = 0;
    try { n = Number(await C.redis(['INCR', 'mf:' + m.id])) || 0; C.redis(['EXPIRE', 'mf:' + m.id, 1800]).catch(() => {}); } catch (_) { return false; }
    if (n < limit) return false;
    offNow.add(m.id); dead.add(m.id);
    await autoDisable(m.id, why.replace(/\s+/g, ' ').slice(0, 90) + (proven ? ' · gagal ' + n + 'x beruntun' : ' · belum pernah berhasil'));
    return true;
  };

  /* AUTO: 2 putaran lalu pindah model. SELECT: model pilihan dicoba terus (semua akun, berulang dengan jeda) sampai berhasil
     atau waktu request habis. Tidak pernah pindah ke model lain. */
  const SEL = mode === 'select';
  const MAXA = SEL ? 150 : MAX_ATTEMPTS;
  for (let pass = 0; pass < (SEL ? 40 : 2); pass++) {
  let list2 = cands;
  if (pass) {
    if (BUDGET_MS - (Date.now() - t0) < (SEL ? 7000 : 12000) || attempts >= MAXA - 3 || !fails.length) break;
    list2 = SEL ? cands.filter((m) => !dead.has(m.id)) : cands.filter((m) => !dead.has(m.id)).slice(0, 6);
    if (!list2.length) break;
    await sleep(SEL ? Math.min(5000, 1500 * pass) : 1500);
  }
  outer:
  for (const m of list2) {
    if (Date.now() - t0 > BUDGET_MS) break;
    const prov = providers[m.provider];
    if (!prov) continue;
    if ((pfail[m.provider] || 0) >= 2 && !picked.has(m.id)) continue;   // provider ini sudah 2 model gagal di request ini -> langsung ke provider lain
    // rotasi semua key yang masih aktif untuk provider ini (akun 1 habis -> akun 2, dst)
    // akun yang paling lama tidak dipakai maju duluan -> beban merata ke semua akun, jarang kena limit
    let keys = C.usableKeys(prov).sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
    if (picked.has(m.id)) {   // model pilihan: akun cooldown dicoba juga (yang paling cepat pulih dulu)
      const cool = (prov.keys || []).filter((k) => k.key && C.keyStatus(k) === 'cooldown').sort((a, b) => (a.cooldownUntil || 0) - (b.cooldownUntil || 0));
      keys = keys.concat(cool);
    }
    if (!keys.length) {
      // semua key cooldown -> tetap coba 1 key sebagai upaya terakhir (kecuali expired total)
      keys = (prov.keys || []).filter((k) => k.key && k.enabled !== false && !(k.expiresAt && Date.now() > k.expiresAt)).slice(0, 1);
      if (!keys.length) { fails.push({ model: m.id, error: 'semua API key provider habis/expired' }); dead.add(m.id); continue; }
    }
    let badReq = 0, soft = 0;
    for (let ki = 0; ki < keys.length; ki++) {
      const pk = keys[ki];
      if (attempts >= MAXA || Date.now() - t0 > BUDGET_MS) break outer;
      attempts++; tried.add(prov.id + ':' + pk.id);
      const left = BUDGET_MS - (Date.now() - t0);
      const ms = Math.max(5000, Math.min(picked.has(m.id) ? PICKED_MS : ATTEMPT_MS, left));

      let up;
      try {
        up = await callUpstream(prov, pk, applyFix(body, fixOf(prov.id)), m.model, ms);
      } catch (e) {
        const msg = e.name === 'AbortError' ? 'timeout' : String(e.message).slice(0, 120);
        fails.push({ model: m.id, key: pk.label, error: msg });
        cd(m.id, 45);
        if (e.name === 'AbortError' && await strike(m, 'timeout')) break;
        if (e.name !== 'AbortError' && picked.has(m.id) && keys.length === 1 && !retried[m.id + pk.id]) { retried[m.id + pk.id] = 1; await sleep(800); ki--; continue; } // select: 1x coba ulang
        if (e.name === 'AbortError' && !picked.has(m.id)) break; if (!picked.has(m.id) && ++soft >= softMax(m)) break; continue; // auto: timeout -> model lain. select/jaringan: coba akun berikutnya
      }
      const { r: ur, done } = up;

      /* ---------- gagal ---------- */
      if (!ur.ok) {
        let txt = '';
        try { txt = (await ur.text()).slice(0, 600); } catch (_) {}
        done();
        const code = ur.status;
        fails.push({ model: m.id, key: pk.label, status: code, error: txt.slice(0, 300) });
        if (code === 403 && /model/i.test(txt)) { dead.add(m.id); cd(m.id, 600); await strike(m, '403 model tidak diizinkan', true); break; } // key sah, hanya model ini yang tak boleh dipakai
        if ([401, 402, 403].includes(code)) {
          await C.markKeyBad(prov.id, pk.id, code, txt, 30 * 60000); // akun ini mati / kredit habis -> akun berikutnya
          continue;
        }
        if (code === 429 && UPSTREAM_RE.test(txt)) {   // model-nya yang sedang dibatasi upstream, bukan akun
          cd(m.id, 45);
          if (picked.has(m.id)) break;   // select: tunggu sebentar lalu coba lagi model yang sama di putaran berikutnya
          if (++soft >= softMax(m)) break;
          continue;
        }
        if (code === 429) {
          await C.markKeyBad(prov.id, pk.id, 429, txt, cooldownMs(ur.headers, txt)); // ikuti retry-after provider
          continue; // akun lain utk model yang sama
        }
        if (code === 400 || code === 413 || code === 422) {
          learn(m, code, txt);
          // parameter ditolak -> buang/kecilkan lalu coba LAGI pada model & akun yang sama
          if (code !== 413 && healTries < 4 && heal(body, fixOf(prov.id), txt)) { healTries++; ki--; continue; }
          // model tidak mendukung tools -> ingat 6 jam, turunkan prioritasnya utk request bertools (TIDAK mematikan model)
          if (hasTools && TOOL_RE.test(txt)) C.redis(['SET', 'nt:' + m.id, '1', 'EX', 6 * 3600]).catch(() => {});
          if (code !== 413 && !TOOL_RE.test(txt) && MODEL_GONE_RE.test(txt) && await strike(m, code + ' ' + txt, true)) break;   // provider bilang model ini tidak ada
          if (code === 413) { dead.add(m.id); if (!picked.has(m.id) && ++soft >= softMax(m)) break; continue; }   // batas ukuran beda tiap akun/org: select = coba semua akun, auto = 2 akun lalu pindah model
          if (++badReq >= 2) { dead.add(m.id); break; }     // 400/422 sama di 2 akun = memang request-nya yang ditolak, bukan salah akun
          continue;
        }
        if (code !== 404 && RATE_RE.test(txt)) { await C.markKeyBad(prov.id, pk.id, 429, txt, cooldownMs(ur.headers, txt)); continue; }   // proxy membungkus rate limit sebagai 5xx = salah AKUN, bukan model -> ganti key
        // 404 / 5xx / lainnya: cooldown sementara saja. (Dulu 404 MEMATIKAN model permanen — itu sebabnya model bisa "hilang".)
        if (code >= 500 && picked.has(m.id) && keys.length === 1 && !retried[m.id + pk.id]) { retried[m.id + pk.id] = 1; await sleep(800); ki--; continue; } // select: 1x coba ulang
        cd(m.id, code === 404 ? 600 : 45);
        if (await strike(m, code + ' ' + txt, code === 404)) break;
        if (code === 404) { if (!picked.has(m.id)) dead.add(m.id); break; }     // auto: model tidak ada -> pindah model. select: 404 provider (mis. "No endpoints found") sering sementara -> coba lagi di putaran berikutnya
        if (!picked.has(m.id) && ++soft >= softMax(m)) break;
        continue;                     // 5xx / lainnya: coba akun berikutnya
      }

      /* ---------- sukses ---------- */
      const rl = pickRL(ur.headers);
      const okHeaders = () => {
        res.setHeader('x-gateway-model', m.id);
        res.setHeader('x-gateway-provider', m.provider);
        res.setHeader('x-gateway-provider-key', pk.label || '');
        res.setHeader('x-gateway-attempts', String(attempts));
        res.setHeader('x-gateway-mode', mode);
      };
      const stick = () => {   // hemat Redis: tulis hanya bila ada yang berubah
        const w = [];
        if (mode === 'auto' && sticky !== m.id) w.push(C.redis(['SET', 'lastok', m.id, 'EX', 86400]));
        w.push(C.redis(fails.length ? ['DEL', 'cf:' + m.id, 'cd:' + m.id, 'mf:' + m.id] : ['DEL', 'mf:' + m.id]));   // sukses = hitungan gagal beruntun kembali 0
        if (!PROVEN.has(m.id)) { PROVEN.add(m.id); w.push(C.redis(['HSETNX', 'mok', m.id, String(Date.now())])); }   // tandai: model ini terbukti bisa dipakai
        return Promise.all(w).catch(() => {});
      };
      const rec = (tok) => Promise.all([C.record({ key, provider: m.provider, provKeyId: pk.id, model: m.id, tok, ok: true, ms: Date.now() - t0, requested, status: 200, fails, rl }), stick()]);

      if (!stream) {
        let j;
        try { j = JSON.parse(await ur.text()); } catch (e) {
          done(); fails.push({ model: m.id, key: pk.label, error: e.name === 'AbortError' ? 'timeout' : 'respons bukan JSON' }); cd(m.id, 45);
          if (await strike(m, 'respons bukan JSON')) break;
          if (!picked.has(m.id) && ++soft >= softMax(m)) break; continue; // akun berikutnya
        }
        done();
        if (!j || !Array.isArray(j.choices) || !j.choices.length) {
          fails.push({ model: m.id, key: pk.label, status: 200, error: j && j.error ? JSON.stringify(j.error).slice(0, 200) : 'choices kosong' }); cd(m.id, 45);
          if (await strike(m, 'choices kosong ' + (j && j.error ? JSON.stringify(j.error) : ''))) break;
          if (!picked.has(m.id) && ++soft >= softMax(m)) break; continue; // akun berikutnya
        }
        if (pk.fails || pk.cooldownUntil) await C.markKeyGood(prov.id, pk.id);
        okHeaders();
        const tok = (j.usage && j.usage.total_tokens) || (C.est(reqChars) + C.est(JSON.stringify(j.choices).length));
        j._gateway = { model: m.id, provider: m.provider, providerKey: pk.label, attempts, fallbacks: fails.length, healed: sm.changed || !!(fixes[prov.id] && fixes[prov.id].flat), mode, fallback: mode === 'select' && !picked.has(m.id) };
        await rec(tok);
        return res.status(200).json(j);
      }

      // streaming: cek chunk pertama dulu. Kalau kosong / berisi error -> pindah, jangan kirim stream kosong ke klien.
      const reader = ur.body.getReader();
      const dec = new TextDecoder();
      let first;
      try { first = await reader.read(); } catch (e) {
        done(); fails.push({ model: m.id, key: pk.label, error: e.name === 'AbortError' ? 'timeout (stream)' : String(e.message).slice(0, 100) }); cd(m.id, 45);
        if (e.name === 'AbortError' && await strike(m, 'timeout (stream)')) break;
        if (!picked.has(m.id) && ++soft >= softMax(m)) break; continue; // akun berikutnya
      }
      done();
      const firstTxt = first.value ? dec.decode(first.value, { stream: true }) : '';
      if (first.done || !firstTxt || /^\s*(data:\s*)?\{\s*"error"/.test(firstTxt)) {
        fails.push({ model: m.id, key: pk.label, status: 200, error: first.done || !firstTxt ? 'stream kosong' : firstTxt.slice(0, 200) }); cd(m.id, 45);
        if (await strike(m, first.done || !firstTxt ? 'stream kosong' : firstTxt)) { try { await reader.cancel(); } catch (_) {} break; }
        try { await reader.cancel(); } catch (_) {}
        if (!picked.has(m.id) && ++soft >= softMax(m)) break; continue; // akun berikutnya
      }
      if (pk.fails || pk.cooldownUntil) await C.markKeyGood(prov.id, pk.id);
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      okHeaders();
      let finished = false;
      res.on('close', () => { if (!finished) reader.cancel().catch(() => {}); }); // klien putus -> hentikan upstream

      let buf = '', outChars = 0, usageTok = 0, sawDone = false;
      const scan = (final) => {
        const lines = buf.split('\n');
        buf = final ? '' : lines.pop();
        for (const ln of lines) {
          if (!ln.startsWith('data:')) continue;
          const d = ln.slice(5).trim();
          if (d === '[DONE]') { sawDone = true; continue; }
          if (!d) continue;
          try {
            const o = JSON.parse(d);
            if (o.usage && o.usage.total_tokens) usageTok = o.usage.total_tokens;
            const ch = o.choices && o.choices[0];
            if (ch && ch.delta) {
              if (typeof ch.delta.content === 'string') outChars += ch.delta.content.length;
              if (typeof ch.delta.reasoning_content === 'string') outChars += ch.delta.reasoning_content.length;
            }
          } catch (_) {}
        }
      };
      res.write(Buffer.from(first.value)); buf += firstTxt; scan(false);
      try {
        while (true) {
          const { done: end, value } = await reader.read();
          if (end) break;
          res.write(Buffer.from(value));
          buf += dec.decode(value, { stream: true });
          scan(false);
        }
      } catch (_) { /* klien putus / upstream putus */ }
      scan(true);
      if (!sawDone) { try { res.write('data: [DONE]\n\n'); } catch (_) {} }
      finished = true;
      await rec(usageTok || C.est(reqChars) + C.est(outChars)); // catat DULU, baru tutup (di Vercel proses bisa dibekukan setelah res.end)
      res.end();
      return;
    }
    // semua key untuk model ini gagal -> lanjut model berikutnya
  }
  }

  await C.record({ key, ok: false, ms: Date.now() - t0, requested, status: 502, fails });
  const offMsg = offNow.size ? ' [dinonaktifkan otomatis: ' + [...offNow].join(', ') + ']' : '';
  // semua penolakan berupa 400/422 = permintaan memang tidak diterima provider -> tampilkan alasan aslinya
  const bad = fails.filter((f) => f.status);
  if (mode === 'select' && !fallback) {
    const all4 = bad.length > 0 && bad.every((f) => f.status === 400 || f.status === 422);
    return C.sendErr(res, all4 ? 400 : 502, `Model "${requested}" gagal (mode select: tidak pindah ke model lain). ` + (explain(fails) || 'tidak ada respons') + ` [${tried.size} akun/key sudah dicoba]` + ' — Model pilihan terus dicoba sampai waktu request habis (' + Math.round((Date.now() - t0) / 1000) + ' dtk). Coba lagi, atau pilih "auto" bila ingin pindah model otomatis.' + offMsg, { attempts: fails.slice(-8) });
  }
  if (bad.length && bad.every((f) => f.status === 400 || f.status === 422)) {
    return C.sendErr(res, 400, 'Permintaan ditolak provider: ' + explain(bad), { attempts: fails.slice(-8) });
  }
  return C.sendErr(res, 502, 'Semua model & API key aktif sedang gagal. Coba lagi sebentar atau tambah key/provider di dashboard. Detail: [' + tried.size + ' akun/key sudah dicoba] ' + (explain(fails) || 'tidak ada akun yang bisa dipakai') + offMsg, { attempts: fails.slice(-8) });
}

module.exports = async (req, res) => {
  C.cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const p = C.getPath(req, '/v1/');
    if (p === '' && req.method === 'GET') {
      return res.status(200).json({ name: 'Yoru Gateway', build: 'redis-cloud-v2', storage: C.backend, status: 'ok', endpoints: ['/v1/models', '/v1/chat/completions'], model: 'auto', modes: { auto: 'model=auto -> model terbaik + fallback otomatis', select: 'model=<id dari /v1/models> -> hanya model itu' } });
    }
    const key = await C.authKey(req);
    if (!key) return C.sendErr(res, 401, 'API key tidak valid. Pakai header Authorization: Bearer <key>.');
    const st = await C.gatewayKeyState(key);
    if (st.blocked === 'expired') return C.sendErr(res, 403, 'API key gateway sudah expired. Perbarui di dashboard → API Keys.');
    if (st.blocked === 'disabled') return C.sendErr(res, 403, 'API key gateway dinonaktifkan.');
    if (st.blocked === 'quota') return C.sendErr(res, 429, `Kuota API key gateway habis (${st.tok}/${key.limit} token).`);

    if (p === 'models' && req.method === 'GET') {
      const [providers, models] = await Promise.all([C.loadProviders(), C.loadModels()]);
      const health = await C.getHealth();
      const data = [{ id: 'auto', object: 'model', owned_by: 'gateway' }].concat(
        models.filter((m) => m.enabled !== false && providers[m.provider] && providers[m.provider].enabled && C.usableKeys(providers[m.provider]).length)
          .sort((a, b) => b.score - a.score)
          .map((m) => ({ id: m.id, object: 'model', owned_by: m.provider, x_healthy: !(health[m.id] && health[m.id].ok === false) })));
      return res.status(200).json({ object: 'list', data });
    }
    if ((p === 'chat/completions' || p === 'completions') && req.method === 'POST') return await chat(req, res, key, st);
    return C.sendErr(res, 404, 'Endpoint tidak ditemukan: /' + p);
  } catch (e) {
    if (!res.headersSent) return C.sendErr(res, 500, String(e.message || e));
    try { res.end(); } catch (_) {}
  }
};