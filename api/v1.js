'use strict';
const C = require('../lib/core');

const ATTEMPT_MS = 25000;
const BUDGET_MS = 52000;
const MAX_ATTEMPTS = 14;

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

/* Kandidat model: hanya yang providernya punya minimal 1 key yang masih aktif */
async function buildCandidates(requested, providers, models) {
  const usable = (m) => {
    const p = providers[m.provider];
    return m.enabled !== false && p && p.enabled && C.usableKeys(p).length > 0;
  };
  if (requested && requested !== 'auto') {
    const hit = models.filter((m) => m.enabled !== false && (m.id === requested || m.model === requested));
    if (hit.length) {
      const withKey = hit.filter(usable);
      if (withKey.length) return withKey;
      // model ada tapi tidak ada key aktif -> tetap kembalikan agar error-nya jelas
      return hit;
    }
    // model di luar daftar: coba "provider/model" langsung
    const i = requested.indexOf('/');
    if (i > 0) {
      const pid = requested.slice(0, i);
      const p = providers[pid];
      if (p && p.enabled && C.usableKeys(p).length) return [{ id: requested, provider: pid, model: requested.slice(i + 1), score: 0, onTheFly: true }];
    }
    return [];
  }
  const list = models.filter(usable).sort((a, b) => (b.score || 0) - (a.score || 0));
  if (!list.length) return list;
  let cd = [], health = {};
  try {
    [cd, health] = await Promise.all([
      C.redis(['MGET', ...list.map((m) => 'cd:' + m.id)]),
      C.getHealth(),
    ]);
  } catch (_) {}
  // urutkan: sehat & tidak cooldown dulu, lalu cooldown, terakhir yang terdeteksi mati
  const tier = (m, i) => (health[m.id] && health[m.id].ok === false ? 2 : 0) + (cd[i] ? 1 : 0);
  return list.map((m, i) => ({ m, t: tier(m, i), s: m.score || 0 }))
    .sort((a, b) => a.t - b.t || b.s - a.s).map((x) => x.m);
}

async function callUpstream(prov, provKey, body, model) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ATTEMPT_MS);
  try {
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + provKey.key };
    if (prov.id === 'openrouter') { headers['HTTP-Referer'] = process.env.SITE_URL || 'https://vercel.app'; headers['X-Title'] = 'Yoru Gateway'; }
    const r = await fetch(prov.base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...body, model }), signal: ctl.signal });
    return r;
  } finally { clearTimeout(t); }
}

async function chat(req, res, key) {
  const t0 = Date.now();
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  if (!Array.isArray(body.messages)) return C.sendErr(res, 400, 'messages wajib berupa array');
  const requested = body.model || 'auto';
  const stream = !!body.stream;
  const reqChars = JSON.stringify(body.messages).length;

  const [providers, models] = await Promise.all([C.loadProviders(), C.loadModels()]);
  const cands = await buildCandidates(requested, providers, models);
  if (!cands.length) {
    const anyKey = Object.values(providers).some((p) => p.enabled && C.usableKeys(p).length);
    return C.sendErr(res, 400, requested === 'auto'
      ? (anyKey ? 'Belum ada model aktif. Tambahkan model di dashboard.' : 'Belum ada API key provider yang aktif (bisa jadi semua expired / kena limit). Atur di dashboard → Providers.')
      : `Model "${requested}" tidak ditemukan atau provider-nya belum punya API key aktif.`);
  }

  const fails = [];
  let attempts = 0; const usedKeyId = { v: null };

  outer:
  for (const m of cands) {
    if (Date.now() - t0 > BUDGET_MS) break;
    const prov = providers[m.provider];
    if (!prov) continue;
    // rotasi semua key yang masih aktif untuk provider ini (akun 1 habis -> akun 2, dst)
    let keys = C.usableKeys(prov);
    if (!keys.length) {
      // semua key cooldown/expired -> tetap coba 1 key terakhir sebagai upaya terakhir (kecuali expired total)
      keys = (prov.keys || []).filter((k) => k.key && k.enabled !== false && !(k.expiresAt && Date.now() > k.expiresAt)).slice(0, 1);
      if (!keys.length) { fails.push({ model: m.id, error: 'semua API key provider habis/expired' }); continue; }
    }
    for (const pk of keys) {
      if (attempts >= MAX_ATTEMPTS || Date.now() - t0 > BUDGET_MS) break outer;
      attempts++;
      let up;
      try {
        up = await callUpstream(prov, pk, body, m.model);
      } catch (e) {
        const msg = e.name === 'AbortError' ? 'timeout' : String(e.message).slice(0, 120);
        fails.push({ model: m.id, key: pk.label, error: msg });
        C.redis(['SET', 'cd:' + m.id, '1', 'EX', 45]).catch(() => {});
        break; // jaringan/timeout: pindah model, key belum tentu salah
      }

      if (!up.ok) {
        let txt = '';
        try { txt = (await up.text()).slice(0, 200); } catch (_) {}
        fails.push({ model: m.id, key: pk.label, status: up.status, error: txt });
        if ([401, 402, 403].includes(up.status)) {
          // key akun ini mati / kredit habis -> cooldown panjang, langsung coba key berikutnya
          await C.markKeyBad(prov.id, pk.id, up.status, txt, 30 * 60000);
          continue;
        }
        if (up.status === 429) {
          await C.markKeyBad(prov.id, pk.id, 429, txt, 60000);
          continue; // coba key akun lain pada model yang sama
        }
        if ([404, 400, 422].includes(up.status)) {
          // model tidak tersedia untuk key ini -> matikan model, lanjut model lain
          if (up.status === 404) {
            try {
              const all = await C.loadModels();
              const i = all.findIndex((x) => x.id === m.id);
              if (i >= 0 && !all[i].manual) { all[i].enabled = false; await C.setJSON('models', all); }
            } catch (_) {}
          }
          C.redis(['SET', 'cd:' + m.id, '1', 'EX', up.status === 404 ? 1800 : 120]).catch(() => {});
          break;
        }
        // 5xx provider down -> cooldown singkat, coba model lain
        C.redis(['SET', 'cd:' + m.id, '1', 'EX', 45]).catch(() => {});
        break;
      }

      /* ---------- sukses ---------- */
      const rl = pickRL(up.headers);
      usedKeyId.v = pk.id;
      await C.markKeyGood(prov.id, pk.id);
      res.setHeader('x-gateway-model', m.id);
      res.setHeader('x-gateway-provider', m.provider);
      res.setHeader('x-gateway-provider-key', pk.label);
      res.setHeader('x-gateway-attempts', String(attempts));

      if (!stream) {
        let j;
        try { j = await up.json(); } catch (e) {
          fails.push({ model: m.id, key: pk.label, error: 'respons bukan JSON' });
          break;
        }
        const tok = (j.usage && j.usage.total_tokens) || (C.est(reqChars) + C.est(JSON.stringify(j.choices || '').length));
        j._gateway = { model: m.id, provider: m.provider, providerKey: pk.label, attempts, fallbacks: fails.length };
        await C.record({ key, provider: m.provider, provKeyId: usedKeyId.v, model: m.id, tok, ok: true, ms: Date.now() - t0, requested, status: 200, fails, rl });
        return res.status(200).json(j);
      }

      // streaming
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      const reader = up.body.getReader();
      const dec = new TextDecoder();
      let buf = '', outChars = 0, usageTok = 0;
      const scan = (final) => {
        const lines = buf.split('\n');
        buf = final ? '' : lines.pop();
        for (const ln of lines) {
          if (!ln.startsWith('data:')) continue;
          const d = ln.slice(5).trim();
          if (!d || d === '[DONE]') continue;
          try {
            const o = JSON.parse(d);
            if (o.usage && o.usage.total_tokens) usageTok = o.usage.total_tokens;
            const ch = o.choices && o.choices[0];
            if (ch && ch.delta && typeof ch.delta.content === 'string') outChars += ch.delta.content.length;
          } catch (_) {}
        }
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
          buf += dec.decode(value, { stream: true });
          scan(false);
        }
      } catch (_) { /* klien putus / upstream putus */ }
      scan(true);
      res.end();
      const tok = usageTok || C.est(reqChars) + C.est(outChars);
      await C.record({ key, provider: m.provider, provKeyId: usedKeyId.v, model: m.id, tok, ok: true, ms: Date.now() - t0, requested, status: 200, fails, rl });
      return;
    }
    // kalau sampai di sini: semua key untuk model ini gagal -> lanjut model berikutnya
  }

  await C.record({ key, ok: false, ms: Date.now() - t0, requested, status: 502, fails });
  return C.sendErr(res, 502, 'Semua model & API key aktif sedang gagal. Coba lagi sebentar atau tambah key/provider di dashboard.', { attempts: fails.slice(-8) });
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
    if ((p === 'chat/completions' || p === 'completions') && req.method === 'POST') return await chat(req, res, key);
    return C.sendErr(res, 404, 'Endpoint tidak ditemukan: /' + p);
  } catch (e) {
    if (!res.headersSent) return C.sendErr(res, 500, String(e.message || e));
    try { res.end(); } catch (_) {}
  }
};
