'use strict';
const C = require('../lib/core');

const ATTEMPT_MS = 25000;
const BUDGET_MS = 52000;
const MAX_ATTEMPTS = 8;

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

async function buildCandidates(requested, providers, models) {
  const usable = (m) => m.enabled !== false && providers[m.provider] && providers[m.provider].enabled && providers[m.provider].key;
  if (requested && requested !== 'auto') {
    const hit = models.filter((m) => usable(m) && (m.id === requested || m.model === requested));
    if (hit.length) return hit;
    // model tidak ada di daftar: coba "provider/model" langsung
    const i = requested.indexOf('/');
    if (i > 0) {
      const pid = requested.slice(0, i);
      if (providers[pid] && providers[pid].key && providers[pid].enabled) {
        return [{ id: requested, provider: pid, model: requested.slice(i + 1), score: 0 }];
      }
    }
    return [];
  }
  const list = models.filter(usable).sort((a, b) => (b.score || 0) - (a.score || 0));
  if (!list.length) return list;
  let cd = [];
  try { cd = await C.redis(['MGET', ...list.map((m) => 'cd:' + m.id)]); } catch (_) {}
  const hot = [], cold = [];
  list.forEach((m, i) => (cd[i] ? cold : hot).push(m));
  return hot.concat(cold);
}

async function callUpstream(prov, body, model, stream) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ATTEMPT_MS);
  try {
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + prov.key };
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
  if (!cands.length) return C.sendErr(res, 400, requested === 'auto' ? 'Belum ada model aktif / API key provider. Atur di dashboard.' : `Model "${requested}" tidak ditemukan atau provider belum punya API key.`);

  const fails = [];
  let attempts = 0;
  for (const m of cands) {
    if (attempts >= MAX_ATTEMPTS || Date.now() - t0 > BUDGET_MS) break;
    attempts++;
    const prov = providers[m.provider];
    let up;
    try {
      up = await callUpstream(prov, body, m.model, stream);
    } catch (e) {
      fails.push({ model: m.id, error: e.name === 'AbortError' ? 'timeout' : String(e.message).slice(0, 120) });
      C.redis(['SET', 'cd:' + m.id, '1', 'EX', 60]).catch(() => {});
      continue;
    }
    if (!up.ok) {
      let txt = '';
      try { txt = (await up.text()).slice(0, 200); } catch (_) {}
      fails.push({ model: m.id, status: up.status, error: txt });
      if ([429, 500, 502, 503, 504, 408, 401, 402, 403, 404].includes(up.status)) {
        const ttl = up.status === 429 ? 90 : up.status >= 500 ? 45 : 600;
        C.redis(['SET', 'cd:' + m.id, '1', 'EX', ttl]).catch(() => {});
      }
      // 400 = permintaan jelek; kalau mode spesifik jangan lanjut, kalau auto coba model lain (mungkin batas konteks)
      continue;
    }

    const rl = pickRL(up.headers);
    res.setHeader('x-gateway-model', m.id);
    res.setHeader('x-gateway-provider', m.provider);
    res.setHeader('x-gateway-attempts', String(attempts));

    if (!stream) {
      let j;
      try { j = await up.json(); } catch (e) {
        fails.push({ model: m.id, error: 'respons bukan JSON' });
        continue;
      }
      const tok = (j.usage && j.usage.total_tokens) || (C.est(reqChars) + C.est(JSON.stringify(j.choices || '').length));
      j._gateway = { model: m.id, provider: m.provider, attempts, fallbacks: fails.length };
      await C.record({ key, provider: m.provider, model: m.id, tok, ok: true, ms: Date.now() - t0, requested, status: 200, fails, rl });
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
    await C.record({ key, provider: m.provider, model: m.id, tok, ok: true, ms: Date.now() - t0, requested, status: 200, fails, rl });
    return;
  }

  await C.record({ key, ok: false, ms: Date.now() - t0, requested, status: 502, fails });
  return C.sendErr(res, 502, 'Semua model gagal.', { attempts: fails });
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

    if (p === 'models' && req.method === 'GET') {
      const [providers, models] = await Promise.all([C.loadProviders(), C.loadModels()]);
      const data = [{ id: 'auto', object: 'model', owned_by: 'gateway' }].concat(
        models.filter((m) => m.enabled !== false && providers[m.provider] && providers[m.provider].key)
          .sort((a, b) => b.score - a.score)
          .map((m) => ({ id: m.id, object: 'model', owned_by: m.provider })));
      return res.status(200).json({ object: 'list', data });
    }
    if ((p === 'chat/completions' || p === 'completions') && req.method === 'POST') return await chat(req, res, key);
    return C.sendErr(res, 404, 'Endpoint tidak ditemukan: /' + p);
  } catch (e) {
    if (!res.headersSent) return C.sendErr(res, 500, String(e.message || e));
    try { res.end(); } catch (_) {}
  }
};
