'use strict';
const C = require('../lib/core');

const mask = (k) => (!k ? '' : k.length <= 10 ? '••••' : k.slice(0, 4) + '••••' + k.slice(-4));
const body = (req) => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {});
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

async function overview() {
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(C.dayStr(-i));
  const [rows, kt, providers, models, keys] = await Promise.all([
    C.pipeline(days.map((d) => ['HGETALL', 'u:' + d])),
    C.redis(['HGETALL', 'ktotal']),
    C.loadProviders(), C.loadModels(), C.redis(['HGETALL', 'apikeys']),
  ]);
  const per = rows.map(C.hgetallObj);
  const today = per[per.length - 1] || {};
  const pick = (o, pre) => Object.entries(o).filter(([k]) => k.startsWith(pre)).map(([k, v]) => [k.slice(pre.length), v]);
  const rlKeys = Object.keys(providers);
  const rls = await C.pipeline(rlKeys.map((p) => ['GET', 'rl:' + p]));
  const cds = await C.pipeline(models.map((m) => ['EXISTS', 'cd:' + m.id]));
  const ktot = C.hgetallObj(kt);
  const keyCount = Array.isArray(keys) ? keys.length / 2 : 0;

  return {
    today: { req: today.req || 0, err: today.err || 0, tok: today.tok || 0 },
    week: days.map((d, i) => ({ day: d, req: per[i].req || 0, tok: per[i].tok || 0, err: per[i].err || 0 })),
    byProvider: pick(today, 'p:').map(([id, tok]) => ({ id, tok, req: today['pr:' + id] || 0 })).sort((a, b) => b.tok - a.tok),
    byModel: pick(today, 'm:').map(([id, tok]) => ({ id, tok })).sort((a, b) => b.tok - a.tok).slice(0, 8),
    providers: rlKeys.map((id, i) => {
      const p = providers[id]; let rl = null; try { rl = rls[i] ? JSON.parse(rls[i]) : null; } catch (_) {}
      return { id, name: p.name, base: p.base, hasKey: !!p.key, keyMasked: mask(p.key), source: p.source, enabled: p.enabled, custom: p.custom, rl,
        modelCount: models.filter((m) => m.provider === id).length, tokToday: today['p:' + id] || 0, reqToday: today['pr:' + id] || 0 };
    }),
    models: models.map((m, i) => ({ ...m, cooldown: !!cds[i] })),
    keyCount, keyTotals: ktot,
  };
}

async function detect(providers, models) {
  const have = new Set(models.map((m) => m.id));
  const added = [], errors = [];
  await Promise.all(Object.values(providers).filter((p) => p.key && p.enabled).map(async (p) => {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(p.base + '/models', { headers: { Authorization: 'Bearer ' + p.key }, signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const list = (j.data || j.models || []).map((x) => String(x.id || x.name || '').replace(/^models\//, '')).filter(Boolean);
      for (const id of list) {
        if (C.NON_CHAT.test(id)) continue;
        const full = p.id + '/' + id;
        if (have.has(full)) continue;
        have.add(full);
        added.push({ id: full, provider: p.id, model: id, score: C.guessScore(id), enabled: true, manual: false });
      }
    } catch (e) { errors.push({ provider: p.id, error: String(e.message).slice(0, 100) }); }
  }));
  return { added, errors };
}

async function testProvider(p) {
  const t0 = Date.now();
  const out = { id: p.id, ok: false, ms: 0 };
  if (!p.key) { out.error = 'Belum ada API key'; return out; }
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(p.base + '/models', { headers: { Authorization: 'Bearer ' + p.key }, signal: ctl.signal });
    clearTimeout(t);
    out.ms = Date.now() - t0; out.status = r.status; out.ok = r.ok;
    if (!r.ok) out.error = (await r.text()).slice(0, 150);
    else { const j = await r.json(); out.models = (j.data || j.models || []).length; }
    if (p.id === 'openrouter') {
      const k = await fetch('https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: 'Bearer ' + p.key } });
      if (k.ok) { const kj = (await k.json()).data || {}; out.credit = { used: kj.usage, limit: kj.limit, remaining: kj.limit_remaining, free: kj.is_free_tier }; }
    }
  } catch (e) { out.ms = Date.now() - t0; out.error = e.name === 'AbortError' ? 'timeout' : String(e.message).slice(0, 120); }
  return out;
}

module.exports = async (req, res) => {
  C.cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const p = C.getPath(req, '/admin/');
    const seg = p.split('/');
    const m = req.method;

    if (p === 'auth/google' && m === 'POST') {
      const u = await C.verifyGoogle(body(req).credential);
      if (!u) return C.sendErr(res, 403, 'Akun ditolak. Hanya ' + C.ALLOWED_EMAIL + ' yang boleh masuk.');
      return res.status(200).json({ token: C.signSession(u.email), user: u });
    }

    const sess = C.verifySession((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!sess) return C.sendErr(res, 401, 'Sesi tidak valid. Login ulang.');

    if (p === 'me') return res.status(200).json({ email: sess.email });
    if (p === 'overview' && m === 'GET') return res.status(200).json(await overview());

    if (p === 'logs' && m === 'GET') {
      const l = await C.redis(['LRANGE', 'logs', 0, 99]);
      return res.status(200).json({ logs: (l || []).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean) });
    }

    /* ----- providers ----- */
    if (seg[0] === 'providers') {
      const stored = await C.getJSON('providers', {});
      if (seg.length === 1 && m === 'POST') {
        const b = body(req);
        const id = slug(b.id || b.name);
        if (!id) return C.sendErr(res, 400, 'id/nama provider wajib');
        const isBuiltin = !!C.BUILTIN[id];
        const cur = stored[id] || {};
        if (!isBuiltin) { if (!b.base && !cur.base) return C.sendErr(res, 400, 'base URL wajib untuk provider custom'); cur.custom = true; cur.name = b.name || cur.name || id; cur.base = (b.base || cur.base).replace(/\/+$/, ''); }
        if (typeof b.apiKey === 'string') cur.apiKey = b.apiKey.trim();
        if (typeof b.enabled === 'boolean') cur.enabled = b.enabled;
        stored[id] = cur;
        await C.setJSON('providers', stored);
        return res.status(200).json({ ok: true, id });
      }
      if (seg.length === 2 && m === 'DELETE') {
        if (C.BUILTIN[seg[1]]) { if (stored[seg[1]]) delete stored[seg[1]].apiKey; } else delete stored[seg[1]];
        await C.setJSON('providers', stored);
        return res.status(200).json({ ok: true });
      }
      if (seg.length === 3 && seg[2] === 'test' && m === 'POST') {
        const provs = await C.loadProviders();
        if (!provs[seg[1]]) return C.sendErr(res, 404, 'provider tidak ada');
        return res.status(200).json(await testProvider(provs[seg[1]]));
      }
    }

    /* ----- models ----- */
    if (seg[0] === 'models') {
      let models = await C.loadModels();
      if (seg[1] === 'detect' && m === 'POST') {
        const provs = await C.loadProviders();
        const r = await detect(provs, models);
        models = models.concat(r.added);
        await C.setJSON('models', models);
        return res.status(200).json({ added: r.added.length, errors: r.errors, total: models.length });
      }
      if (seg[1] === 'reset' && m === 'POST') { await C.setJSON('models', C.SEED_MODELS); return res.status(200).json({ ok: true }); }
      if (seg.length === 1 && m === 'POST') {
        const b = body(req);
        const provs = await C.loadProviders();
        if (!provs[b.provider]) return C.sendErr(res, 400, 'provider tidak dikenal');
        if (!b.model) return C.sendErr(res, 400, 'nama model wajib');
        const id = b.provider + '/' + b.model;
        const score = Math.max(1, Math.min(100, Number(b.score) || C.guessScore(b.model)));
        const i = models.findIndex((x) => x.id === id);
        const row = { id, provider: b.provider, model: b.model, score, enabled: true, manual: true };
        if (i >= 0) models[i] = { ...models[i], ...row }; else models.push(row);
        await C.setJSON('models', models);
        return res.status(200).json({ ok: true, id });
      }
      if (seg.length >= 2) {
        const id = decodeURIComponent(seg.slice(1).join('/'));
        const i = models.findIndex((x) => x.id === id);
        if (i < 0) return C.sendErr(res, 404, 'model tidak ada');
        if (m === 'PUT') {
          const b = body(req);
          if (b.score != null) models[i].score = Math.max(1, Math.min(100, Number(b.score) || models[i].score));
          if (typeof b.enabled === 'boolean') models[i].enabled = b.enabled;
          await C.setJSON('models', models);
          if (b.clearCooldown) await C.redis(['DEL', 'cd:' + id]);
          return res.status(200).json({ ok: true });
        }
        if (m === 'DELETE') { models.splice(i, 1); await C.setJSON('models', models); return res.status(200).json({ ok: true }); }
      }
    }

    /* ----- gateway keys ----- */
    if (seg[0] === 'keys') {
      if (seg.length === 1 && m === 'GET') {
        const [raw, tot] = await Promise.all([C.redis(['HGETALL', 'apikeys']), C.redis(['HGETALL', 'ktotal'])]);
        const t = C.hgetallObj(tot); const out = [];
        for (let i = 0; i < raw.length; i += 2) { try { const k = JSON.parse(raw[i + 1]); out.push({ ...k, tok: t[k.id] || 0 }); } catch (_) {} }
        return res.status(200).json({ keys: out.sort((a, b) => b.created - a.created) });
      }
      if (seg.length === 1 && m === 'POST') {
        const name = String(body(req).name || 'key').slice(0, 40);
        const raw = 'sk-yoru-' + require('crypto').randomBytes(24).toString('hex');
        const id = C.sha(raw).slice(0, 10);
        await C.redis(['HSET', 'apikeys', C.sha(raw), JSON.stringify({ id, name, created: Date.now(), preview: raw.slice(0, 11) + '…' + raw.slice(-4) })]);
        return res.status(200).json({ key: raw, id, name });
      }
      if (seg.length === 2 && m === 'DELETE') {
        const raw = await C.redis(['HGETALL', 'apikeys']);
        for (let i = 0; i < raw.length; i += 2) { try { if (JSON.parse(raw[i + 1]).id === seg[1]) { await C.redis(['HDEL', 'apikeys', raw[i]]); break; } } catch (_) {} }
        return res.status(200).json({ ok: true });
      }
    }

    return C.sendErr(res, 404, 'Endpoint admin tidak ditemukan: /' + p);
  } catch (e) {
    return C.sendErr(res, 500, String(e.message || e));
  }
};
