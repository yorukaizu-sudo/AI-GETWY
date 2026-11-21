'use strict';
const C = require('../lib/core');

const ATTEMPT_MS = Number(process.env.ATTEMPT_MS) || 25000;   // batas per percobaan untuk model biasa (auto)
const PICKED_MS = Number(process.env.PICKED_MS) || 50000;    // model yang DIPILIH MANUAL lebih sabar (model reasoning/ultra sering lambat)
const BUDGET_MS = Number(process.env.BUDGET_MS) || 52000;    // total waktu 1 request (Vercel maxDuration 60s)
const MAX_ATTEMPTS = 40;   // cukup untuk memutar belasan akun + beberapa model
// Mode: model "auto" = pilih model terbaik + fallback. Model spesifik = MODE SELECT (strict: tidak pindah model,
// kecuali "fallback model pilihan" dinyalakan di dashboard -> Model Atlas, atau env FALLBACK_SPECIFIC=1).
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
  return changed;
}
function applyFix(body, fix) {
  if (!fix.strip.size && !Object.keys(fix.caps).length && !Object.keys(fix.rename).length) return body;
  const b = { ...body };
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
  // model pilihan: akun yang sedang cooldown tetap boleh dicoba (user memilih eksplisit, jangan diam-diam dilewati)
  const reachable = (m) => provOn(m) && (providers[m.provider].keys || []).some((k) => k.key && ['active', 'cooldown'].includes(C.keyStatus(k)));
  let stickyId = null;
  const autoList = async (exclude, useSticky) => {
    const list = models.filter((m) => usable(m) && !exclude.has(m.id)).sort((a, b) => (b.score || 0) - (a.score || 0));
    if (!list.length) return list;
    let cd = [], health = {}, nt = [], ml = [], lastok = null, pcdv = [];
    const pids = [...new Set(list.map((m) => m.provider))];
    try {
      [cd, health, nt, ml, lastok, pcdv] = await Promise.all([
        C.redis(['MGET', ...list.map((m) => 'cd:' + m.id)]),
        C.getHealth(),
        hasTools ? C.redis(['MGET', ...list.map((m) => 'nt:' + m.id)]) : Promise.resolve([]),
        C.redis(['MGET', ...list.map((m) => 'ml:' + m.id)]),
        useSticky ? C.redis(['GET', 'lastok']) : Promise.resolve(null),
        C.redis(['MGET', ...pids.map((p) => 'pcd:' + p)]),
      ]);
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
  let first = all.filter((m) => m.enabled !== false);
  if (!first.length) {   // di luar daftar: coba "provider/model" langsung (dua kemungkinan penulisan id, mis. NVIDIA "nvidia/nemotron-...")
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
  const info = { found: first.length, disabled: all.filter((m) => m.enabled === false).length, noKey: first.length - firstOk.length };
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
  const fallback = settings.selectFallback === true;
  const { list: cands, picked, mode, info, sticky } = await buildCandidates(requested, providers, models, hasTools, fallback, C.est(reqChars));
  if (!cands.length) {
    if (mode === 'select') {
      let msg;
      if (!info.found && info.disabled) msg = `Model "${requested}" dinonaktifkan di dashboard → Model Atlas.`;
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

  for (let pass = 0; pass < 2; pass++) {
  let list2 = cands;
  if (pass) {
    if (BUDGET_MS - (Date.now() - t0) < 12000 || attempts >= MAX_ATTEMPTS - 3 || !fails.length) break;
    list2 = cands.filter((m) => !dead.has(m.id)).slice(0, 6);
    if (!list2.length) break;
    await sleep(1500);
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
      if (!keys.length) { fails.push({ model: m.id, error: 'semua API key provider habis/expired' }); continue; }
    }
    let badReq = 0, soft = 0;
    for (let ki = 0; ki < keys.length; ki++) {
      const pk = keys[ki];
      if (attempts >= MAX_ATTEMPTS || Date.now() - t0 > BUDGET_MS) break outer;
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
        if (e.name !== 'AbortError' && picked.has(m.id) && keys.length === 1 && !retried[m.id + pk.id]) { retried[m.id + pk.id] = 1; await sleep(800); ki--; continue; } // select: 1x coba ulang
        if (e.name === 'AbortError' && !picked.has(m.id)) break; if (!picked.has(m.id) && ++soft >= 2) break; continue; // auto: timeout -> model lain. select/jaringan: coba akun berikutnya
      }
      const { r: ur, done } = up;

      /* ---------- gagal ---------- */
      if (!ur.ok) {
        let txt = '';
        try { txt = (await ur.text()).slice(0, 600); } catch (_) {}
        done();
        const code = ur.status;
        fails.push({ model: m.id, key: pk.label, status: code, error: txt.slice(0, 300) });
        if (code === 403 && /model/i.test(txt)) { dead.add(m.id); cd(m.id, 600); break; } // key sah, hanya model ini yang tak boleh dipakai
        if ([401, 402, 403].includes(code)) {
          await C.markKeyBad(prov.id, pk.id, code, txt, 30 * 60000); // akun ini mati / kredit habis -> akun berikutnya
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
          if (code === 413) { dead.add(m.id); if (!picked.has(m.id) && ++soft >= 2) break; continue; }   // batas ukuran beda tiap akun/org: select = coba semua akun, auto = 2 akun lalu pindah model
          if (++badReq >= 2) { dead.add(m.id); break; }     // 400/422 sama di 2 akun = memang request-nya yang ditolak, bukan salah akun
          continue;
        }
        // 404 / 5xx / lainnya: cooldown sementara saja. (Dulu 404 MEMATIKAN model permanen — itu sebabnya model bisa "hilang".)
        if (code >= 500 && picked.has(m.id) && keys.length === 1 && !retried[m.id + pk.id]) { retried[m.id + pk.id] = 1; await sleep(800); ki--; continue; } // select: 1x coba ulang
        cd(m.id, code === 404 ? 600 : 45);
        if (code === 404) { dead.add(m.id); break; }     // model tidak ada: semua akun sama -> pindah model
        if (!picked.has(m.id) && ++soft >= 2) break;
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
      const stick = () => Promise.all([mode === 'auto' ? C.redis(['SET', 'lastok', m.id, 'EX', 86400]) : null, C.redis(['DEL', 'cf:' + m.id, 'cd:' + m.id])].filter(Boolean)).catch(() => {});
      const rec = (tok) => Promise.all([C.record({ key, provider: m.provider, provKeyId: pk.id, model: m.id, tok, ok: true, ms: Date.now() - t0, requested, status: 200, fails, rl }), stick()]);

      if (!stream) {
        let j;
        try { j = JSON.parse(await ur.text()); } catch (e) {
          done(); fails.push({ model: m.id, key: pk.label, error: e.name === 'AbortError' ? 'timeout' : 'respons bukan JSON' }); cd(m.id, 45);
          if (!picked.has(m.id) && ++soft >= 2) break; continue; // akun berikutnya
        }
        done();
        if (!j || !Array.isArray(j.choices) || !j.choices.length) {
          fails.push({ model: m.id, key: pk.label, status: 200, error: j && j.error ? JSON.stringify(j.error).slice(0, 200) : 'choices kosong' }); cd(m.id, 45);
          if (!picked.has(m.id) && ++soft >= 2) break; continue; // akun berikutnya
        }
        await C.markKeyGood(prov.id, pk.id);
        okHeaders();
        const tok = (j.usage && j.usage.total_tokens) || (C.est(reqChars) + C.est(JSON.stringify(j.choices).length));
        j._gateway = { model: m.id, provider: m.provider, providerKey: pk.label, attempts, fallbacks: fails.length, mode, fallback: mode === 'select' && !picked.has(m.id) };
        await rec(tok);
        return res.status(200).json(j);
      }

      // streaming: cek chunk pertama dulu. Kalau kosong / berisi error -> pindah, jangan kirim stream kosong ke klien.
      const reader = ur.body.getReader();
      const dec = new TextDecoder();
      let first;
      try { first = await reader.read(); } catch (e) {
        done(); fails.push({ model: m.id, key: pk.label, error: e.name === 'AbortError' ? 'timeout (stream)' : String(e.message).slice(0, 100) }); cd(m.id, 45);
        if (!picked.has(m.id) && ++soft >= 2) break; continue; // akun berikutnya
      }
      done();
      const firstTxt = first.value ? dec.decode(first.value, { stream: true }) : '';
      if (first.done || !firstTxt || /^\s*(data:\s*)?\{\s*"error"/.test(firstTxt)) {
        fails.push({ model: m.id, key: pk.label, status: 200, error: first.done || !firstTxt ? 'stream kosong' : firstTxt.slice(0, 200) }); cd(m.id, 45);
        try { await reader.cancel(); } catch (_) {}
        if (!picked.has(m.id) && ++soft >= 2) break; continue; // akun berikutnya
      }
      await C.markKeyGood(prov.id, pk.id);
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
  // semua penolakan berupa 400/422 = permintaan memang tidak diterima provider -> tampilkan alasan aslinya
  const bad = fails.filter((f) => f.status);
  if (mode === 'select' && !fallback) {
    const all4 = bad.length > 0 && bad.every((f) => f.status === 400 || f.status === 422);
    return C.sendErr(res, all4 ? 400 : 502, `Model "${requested}" gagal (mode select: tidak pindah ke model lain). ` + (explain(fails) || 'tidak ada respons') + ` [${tried.size} akun/key sudah dicoba]` + ' — Pilih "auto" atau nyalakan fallback di dashboard → Model Atlas.', { attempts: fails.slice(-8) });
  }
  if (bad.length && bad.every((f) => f.status === 400 || f.status === 422)) {
    return C.sendErr(res, 400, 'Permintaan ditolak provider: ' + explain(bad), { attempts: fails.slice(-8) });
  }
  return C.sendErr(res, 502, 'Semua model & API key aktif sedang gagal. Coba lagi sebentar atau tambah key/provider di dashboard. Detail: [' + tried.size + ' akun/key sudah dicoba] ' + (explain(fails) || 'tidak ada akun yang bisa dipakai'), { attempts: fails.slice(-8) });
}

module.exports = async (req, res) => {
  C.cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const p = C.getPath(req, '/v1/');
    if (p === '' && req.method === 'GET') {
      return res.status(200).json({ name: 'Yoru Gateway', status: 'ok', endpoints: ['/v1/models', '/v1/chat/completions'], model: 'auto', modes: { auto: 'model=auto -> model terbaik + fallback otomatis', select: 'model=<id dari /v1/models> -> hanya model itu' } });
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