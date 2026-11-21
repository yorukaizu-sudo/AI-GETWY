'use strict';
const C = require('../lib/core');

const ATTEMPT_MS = 25000;   // batas per percobaan untuk model biasa (auto)
const PICKED_MS = 50000;    // model yang DIPILIH MANUAL lebih sabar (model reasoning/ultra sering lambat)
const BUDGET_MS = 52000;    // total waktu 1 request (Vercel maxDuration 60s)
const MAX_ATTEMPTS = 14;
// model pilihan gagal -> otomatis pakai model aktif lain. Matikan dgn env FALLBACK_SPECIFIC=0
const FALLBACK_PICKED = process.env.FALLBACK_SPECIFIC !== '0';
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

/* cocokkan nama model dari klien: "provider/model", "model", atau dgn awalan nomor ("1/nvidia/...") */
function findPicked(requested, models) {
  const n = (s) => String(s || '').toLowerCase();
  const r = n(requested), r2 = r.replace(/^\d+\//, '');
  return models.filter((m) => {
    if (m.enabled === false) return false;
    const id = n(m.id), mo = n(m.model);
    return id === r || mo === r || id === r2 || mo === r2 || id.endsWith('/' + r2);
  });
}

/* Kandidat model. Model pilihan user SELALU dicoba paling dulu; kalau gagal baru model aktif lain. */
async function buildCandidates(requested, providers, models, hasTools) {
  const usable = (m) => {
    const p = providers[m.provider];
    return m.enabled !== false && p && p.enabled && C.usableKeys(p).length > 0;
  };
  const autoList = async (exclude) => {
    const list = models.filter((m) => usable(m) && !exclude.has(m.id)).sort((a, b) => (b.score || 0) - (a.score || 0));
    if (!list.length) return list;
    let cd = [], health = {}, nt = [];
    try {
      [cd, health, nt] = await Promise.all([
        C.redis(['MGET', ...list.map((m) => 'cd:' + m.id)]),
        C.getHealth(),
        hasTools ? C.redis(['MGET', ...list.map((m) => 'nt:' + m.id)]) : Promise.resolve([]),
      ]);
    } catch (_) {}
    // sehat & tidak cooldown dulu; model yg diketahui tak mendukung tools diturunkan saat request memakai tools
    const tier = (m, i) => (health[m.id] && health[m.id].ok === false ? 4 : 0) + (nt[i] ? 2 : 0) + (cd[i] ? 1 : 0);
    return list.map((m, i) => ({ m, t: tier(m, i), s: m.score || 0 })).sort((a, b) => a.t - b.t || b.s - a.s).map((x) => x.m);
  };

  if (requested && requested !== 'auto') {
    let first = findPicked(requested, models);
    if (!first.length) {   // di luar daftar: coba "provider/model" langsung
      const i = requested.indexOf('/');
      if (i > 0) {
        const pid = requested.slice(0, i), p = providers[pid];
        if (p && p.enabled && C.usableKeys(p).length) first = [{ id: requested, provider: pid, model: requested.slice(i + 1), score: 0, onTheFly: true }];
      }
    }
    const firstUsable = first.filter(usable);
    const picked = new Set(firstUsable.map((m) => m.id));
    if (!FALLBACK_PICKED) return { list: firstUsable.length ? firstUsable : first, picked };
    const rest = await autoList(new Set(first.map((m) => m.id)));
    return { list: firstUsable.concat(rest), picked, firstFound: first.length };
  }
  return { list: await autoList(new Set()), picked: new Set() };
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

  const [providers, models] = await Promise.all([C.loadProviders(), C.loadModels()]);
  const { list: cands, picked } = await buildCandidates(requested, providers, models, hasTools);
  if (!cands.length) {
    const anyKey = Object.values(providers).some((p) => p.enabled && C.usableKeys(p).length);
    return C.sendErr(res, 400, requested === 'auto' || FALLBACK_PICKED
      ? (anyKey ? 'Belum ada model aktif. Tambahkan model di dashboard.' : 'Belum ada API key provider yang aktif (bisa jadi semua expired / kena limit). Atur di dashboard → Providers.')
      : `Model "${requested}" tidak ditemukan atau provider-nya belum punya API key aktif.`);
  }

  const fails = [];
  let attempts = 0, healTries = 0;
  const fixes = {};
  const fixOf = (pid) => fixes[pid] || (fixes[pid] = { strip: new Set(), caps: {}, rename: {} });
  const cd = (id, sec) => C.redis(['SET', 'cd:' + id, '1', 'EX', sec]).catch(() => {});

  outer:
  for (const m of cands) {
    if (Date.now() - t0 > BUDGET_MS) break;
    const prov = providers[m.provider];
    if (!prov) continue;
    // rotasi semua key yang masih aktif untuk provider ini (akun 1 habis -> akun 2, dst)
    let keys = C.usableKeys(prov);
    if (!keys.length) {
      // semua key cooldown -> tetap coba 1 key sebagai upaya terakhir (kecuali expired total)
      keys = (prov.keys || []).filter((k) => k.key && k.enabled !== false && !(k.expiresAt && Date.now() > k.expiresAt)).slice(0, 1);
      if (!keys.length) { fails.push({ model: m.id, error: 'semua API key provider habis/expired' }); continue; }
    }
    for (let ki = 0; ki < keys.length; ki++) {
      const pk = keys[ki];
      if (attempts >= MAX_ATTEMPTS || Date.now() - t0 > BUDGET_MS) break outer;
      attempts++;
      const left = BUDGET_MS - (Date.now() - t0);
      const ms = Math.max(5000, Math.min(picked.has(m.id) ? PICKED_MS : ATTEMPT_MS, left));

      let up;
      try {
        up = await callUpstream(prov, pk, applyFix(body, fixOf(prov.id)), m.model, ms);
      } catch (e) {
        const msg = e.name === 'AbortError' ? 'timeout' : String(e.message).slice(0, 120);
        fails.push({ model: m.id, key: pk.label, error: msg });
        cd(m.id, 45);
        break; // jaringan/timeout: pindah model, key belum tentu salah
      }
      const { r: ur, done } = up;

      /* ---------- gagal ---------- */
      if (!ur.ok) {
        let txt = '';
        try { txt = (await ur.text()).slice(0, 600); } catch (_) {}
        done();
        const code = ur.status;
        fails.push({ model: m.id, key: pk.label, status: code, error: txt.slice(0, 300) });
        if ([401, 402, 403].includes(code)) {
          await C.markKeyBad(prov.id, pk.id, code, txt, 30 * 60000); // akun ini mati / kredit habis -> akun berikutnya
          continue;
        }
        if (code === 429) {
          await C.markKeyBad(prov.id, pk.id, 429, txt, cooldownMs(ur.headers, txt)); // ikuti retry-after provider
          continue; // akun lain utk model yang sama
        }
        if (code === 400 || code === 413 || code === 422) {
          // parameter ditolak -> buang/kecilkan lalu coba LAGI pada model & akun yang sama
          if (code !== 413 && healTries < 4 && heal(body, fixOf(prov.id), txt)) { healTries++; ki--; continue; }
          // model tidak mendukung tools -> ingat 6 jam, turunkan prioritasnya utk request bertools (TIDAK mematikan model)
          if (hasTools && TOOL_RE.test(txt)) C.redis(['SET', 'nt:' + m.id, '1', 'EX', 6 * 3600]).catch(() => {});
          break; // salah parameter bukan salah model: tanpa cooldown, lanjut model berikutnya
        }
        // 404 / 5xx / lainnya: cooldown sementara saja. (Dulu 404 MEMATIKAN model permanen — itu sebabnya model bisa "hilang".)
        cd(m.id, code === 404 ? 600 : 45);
        break;
      }

      /* ---------- sukses ---------- */
      const rl = pickRL(ur.headers);
      const okHeaders = () => {
        res.setHeader('x-gateway-model', m.id);
        res.setHeader('x-gateway-provider', m.provider);
        res.setHeader('x-gateway-provider-key', pk.label || '');
        res.setHeader('x-gateway-attempts', String(attempts));
      };
      const rec = (tok) => C.record({ key, provider: m.provider, provKeyId: pk.id, model: m.id, tok, ok: true, ms: Date.now() - t0, requested, status: 200, fails, rl });

      if (!stream) {
        let j;
        try { j = JSON.parse(await ur.text()); } catch (e) {
          done(); fails.push({ model: m.id, key: pk.label, error: e.name === 'AbortError' ? 'timeout' : 'respons bukan JSON' }); cd(m.id, 45);
          break;
        }
        done();
        if (!j || !Array.isArray(j.choices) || !j.choices.length) {
          fails.push({ model: m.id, key: pk.label, status: 200, error: j && j.error ? JSON.stringify(j.error).slice(0, 200) : 'choices kosong' }); cd(m.id, 45);
          break;
        }
        await C.markKeyGood(prov.id, pk.id);
        okHeaders();
        const tok = (j.usage && j.usage.total_tokens) || (C.est(reqChars) + C.est(JSON.stringify(j.choices).length));
        j._gateway = { model: m.id, provider: m.provider, providerKey: pk.label, attempts, fallbacks: fails.length };
        await rec(tok);
        return res.status(200).json(j);
      }

      // streaming: cek chunk pertama dulu. Kalau kosong / berisi error -> pindah, jangan kirim stream kosong ke klien.
      const reader = ur.body.getReader();
      const dec = new TextDecoder();
      let first;
      try { first = await reader.read(); } catch (e) {
        done(); fails.push({ model: m.id, key: pk.label, error: e.name === 'AbortError' ? 'timeout (stream)' : String(e.message).slice(0, 100) }); cd(m.id, 45);
        break;
      }
      done();
      const firstTxt = first.value ? dec.decode(first.value, { stream: true }) : '';
      if (first.done || !firstTxt || /^\s*(data:\s*)?\{\s*"error"/.test(firstTxt)) {
        fails.push({ model: m.id, key: pk.label, status: 200, error: first.done || !firstTxt ? 'stream kosong' : firstTxt.slice(0, 200) }); cd(m.id, 45);
        try { await reader.cancel(); } catch (_) {}
        break;
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

  await C.record({ key, ok: false, ms: Date.now() - t0, requested, status: 502, fails });
  // semua penolakan berupa 400/422 = permintaan memang tidak diterima provider -> tampilkan alasan aslinya
  const bad = fails.filter((f) => f.status);
  if (bad.length && bad.every((f) => f.status === 400 || f.status === 422)) {
    return C.sendErr(res, 400, 'Permintaan ditolak provider: ' + explain(bad), { attempts: fails.slice(-8) });
  }
  return C.sendErr(res, 502, 'Semua model & API key aktif sedang gagal. Coba lagi sebentar atau tambah key/provider di dashboard. Detail: ' + (explain(fails) || 'tidak ada akun yang bisa dipakai'), { attempts: fails.slice(-8) });
}

module.exports = async (req, res) => {
  C.cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const p = C.getPath(req, '/v1/');
    if (p === '' && req.method === 'GET') {
      return res.status(200).json({ name: 'Yoru Gateway', status: 'ok', endpoints: ['/v1/models', '/v1/chat/completions'], model: 'auto' });
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