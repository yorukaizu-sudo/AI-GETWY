'use strict';
const C = require('../lib/core');
const crypto = require('crypto');

const mask = C.maskKey;
const body = (req) => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {});
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
const num = (v) => (v === '' || v == null ? null : Number(v) || 0);

/* Tampilan key provider + status + % pemakaian */
function pubKeys(prov) {
  const now = Date.now();
  return (prov.keys || []).map((k) => {
    const st = C.keyStatus(k, now);
    const pct = C.keyPct(k);
    return {
      id: k.id, label: k.label, source: k.source, enabled: k.enabled !== false,
      masked: mask(k.key), status: st,
      expiresAt: k.expiresAt || null,
      limit: k.limit || null, limitType: k.limitType || 'token',
      used: k.used || 0, pct, remaining: k.limit ? Math.max(0, k.limit - (k.used || 0)) : null,
      cooldownUntil: k.cooldownUntil || 0, fails: k.fails || 0, lastError: k.lastError || null, lastStatus: k.lastStatus || null,
      lastUsedAt: k.lastUsedAt || null,
    };
  });
}

/* Auto-scan: kalau pengaturan autoScan aktif dan scan terakhir sudah lewat,
   jalankan pencarian model baru + cek model aktif di belakang layar (tanpa menahan request). */
let scanning = false;
async function maybeAutoScan(settings, lastScan) {
  if (!settings.autoScan || scanning) return;
  const every = (settings.scanEveryMin || 5) * 60000;
  if (lastScan && Date.now() - lastScan < every) return;
  scanning = true;
  try {
    const provs = await C.loadProviders();
    await C.detectModels(provs, await C.loadModels());
    await C.healthScan(await C.loadProviders(), await C.loadModels());
  } catch (_) { /* diamkan */ }
  finally { scanning = false; }
}

async function overview() {
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(C.dayStr(-i));
  const [rows, providers, models, keysRaw, health, settings, lastscan, pku] = await Promise.all([
    C.pipeline(days.map((d) => ['HGETALL', 'u:' + d])),
    C.loadProviders(), C.loadModels(),
    C.redis(['HGETALL', 'apikeys']),
    C.getHealth(), C.getSettings(),
    C.redis(['GET', 'lastscan']),
    C.redis(['HGETALL', 'pku']),
  ]);
  const per = rows.map(C.hgetallObj);
  const today = per[per.length - 1] || {};
  const pick = (o, pre) => Object.entries(o).filter(([k]) => k.startsWith(pre)).map(([k, v]) => [k.slice(pre.length), v]);
  const cds = await C.pipeline(models.map((m) => ['EXISTS', 'cd:' + m.id]));
  const rlKeys = Object.keys(providers);
  const rls = await C.pipeline(rlKeys.map((p) => ['GET', 'rl:' + p]));
  const ktot = C.hgetallObj(await C.redis(['HGETALL', 'ktotal']));
  const kreq = C.hgetallObj(await C.redis(['HGETALL', 'kreq']));

  const keys = [];
  const now = Date.now();
  if (Array.isArray(keysRaw)) {
    for (let i = 0; i < keysRaw.length; i += 2) {
      try {
        const k = JSON.parse(keysRaw[i + 1]);
        const tok = ktot[k.id] || 0, req = kreq[k.id] || 0;
        let blocked = null;
        if (k.enabled === false) blocked = 'disabled';
        else if (k.expiresAt && now > k.expiresAt) blocked = 'expired';
        else if (k.limit && tok >= k.limit) blocked = 'quota';
        keys.push({ ...k, tok, req, pct: k.limit ? Math.round(100 * tok / k.limit) : null, remaining: k.limit ? Math.max(0, k.limit - tok) : null, blocked });
      } catch (_) {}
    }
  }

  const out = {
    today: { req: today.req || 0, err: today.err || 0, tok: today.tok || 0 },
    week: days.map((d, i) => ({ day: d, req: per[i].req || 0, tok: per[i].tok || 0, err: per[i].err || 0 })),
    byProvider: pick(today, 'p:').map(([id, tok]) => ({ id, tok, req: today['pr:' + id] || 0 })).sort((a, b) => b.tok - a.tok),
    byModel: pick(today, 'm:').map(([id, tok]) => ({ id, tok })).sort((a, b) => b.tok - a.tok).slice(0, 8),
    providers: rlKeys.map((id, i) => {
      const p = providers[id]; let rl = null; try { rl = rls[i] ? JSON.parse(rls[i]) : null; } catch (_) {}
      const ks = pubKeys(p);
      const usable = ks.filter((k) => k.status === 'active').length;
      return {
        id, name: p.name, base: p.base, custom: p.custom, enabled: p.enabled,
        keys: ks, keyCount: ks.length, usableKeys: usable,
        hasKey: ks.length > 0, keyMasked: ks.length ? ks[0].masked : '', source: p.source, rl,
        modelCount: models.filter((m) => m.provider === id).length,
        tokToday: today['p:' + id] || 0, reqToday: today['pr:' + id] || 0,
        enabledModels: models.filter((m) => m.provider === id && m.enabled !== false).length,
      };
    }),
    models: models.map((m, i) => ({ ...m, cooldown: !!cds[i], health: health[m.id] || null })),
    keyCount: keys.length, keys: keys.sort((a, b) => b.created - a.created),
    keyTotals: ktot, keyReqs: kreq,
    settings, lastScan: Number(lastscan) || null,
    healthSummary: {
      checked: Object.keys(health).length,
      ok: Object.values(health).filter((h) => h.ok).length,
      dead: Object.values(health).filter((h) => h.ok === false).length,
    },
    serverTime: Date.now(),
  };
  maybeAutoScan(settings, out.lastScan).catch(() => {});
  return out;
}

async function testProviderKey(p, k) {
  const t0 = Date.now();
  const out = { id: p.id, keyId: k.id, label: k.label, masked: mask(k.key), ok: false, ms: 0 };
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(p.base + '/models', { headers: { Authorization: 'Bearer ' + k.key }, signal: ctl.signal });
    clearTimeout(t);
    out.ms = Date.now() - t0; out.status = r.status; out.ok = r.ok;
    if (!r.ok) out.error = (await r.text()).slice(0, 200);
    else { const j = await r.json(); out.models = (j.data || j.models || []).length; }
  } catch (e) { out.ms = Date.now() - t0; out.error = e.name === 'AbortError' ? 'timeout' : String(e.message).slice(0, 150); }
  if (p.id === 'openrouter') {
    const c = await C.orCredit(k.key, true);
    if (c) {
      out.credit = c;
      out.pct = c.limit ? Math.round(100 * (c.used || 0) / c.limit) : null;
      if (c.limit && c.used >= c.limit) { out.ok = false; out.error = 'Kredit/limit key ini sudah habis'; }
    }
  }
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

    /* ----- settings (live refresh & auto scan) ----- */
    if (seg[0] === 'settings') {
      if (m === 'GET') return res.status(200).json(await C.getSettings());
      if (m === 'PUT' || m === 'POST') {
        const b = body(req);
        const cur = await C.getSettings();
        const next = { ...cur };
        if (b.refreshSec != null) next.refreshSec = Math.max(2, Math.min(120, Number(b.refreshSec) || 5));
        if (typeof b.autoScan === 'boolean') next.autoScan = b.autoScan;
        if (typeof b.selectFallback === 'boolean') next.selectFallback = b.selectFallback;
        if (b.scanEveryMin != null) next.scanEveryMin = Math.max(1, Math.min(180, Number(b.scanEveryMin) || 5));
        await C.setJSON('settings', next);
        return res.status(200).json(next);
      }
    }

    if (p === 'logs' && m === 'GET') {
      const l = await C.redis(['LRANGE', 'logs', 0, 199]);
      return res.status(200).json({ logs: (l || []).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean) });
    }

    /* ----- scan: cari model aktif & model baru ----- */
    if (seg[0] === 'scan' && m === 'POST') {
      const [provs, models] = await Promise.all([C.loadProviders(), C.loadModels()]);
      const mode = body(req).mode || 'all';
      const out = {};
      if (mode === 'models' || mode === 'all') out.detect = await C.detectModels(provs, models);
      if (mode === 'health' || mode === 'all') {
        const fresh = await C.loadModels();
        out.health = await C.healthScan(await C.loadProviders(), fresh);
      }
      return res.status(200).json(out);
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
        if (!isBuiltin) {
          if (!b.base && !cur.base) return C.sendErr(res, 400, 'base URL wajib untuk provider custom');
          cur.custom = true; cur.name = b.name || cur.name || id; cur.base = (b.base || cur.base).replace(/\/+$/, '');
        }
        if (typeof b.base === 'string' && b.base.trim()) cur.base = b.base.trim().replace(/\/+$/, '');
        if (typeof b.enabled === 'boolean') cur.enabled = b.enabled;
        // kompatibilitas format lama: apiKey tunggal -> masuk ke keys[]
        if (typeof b.apiKey === 'string' && b.apiKey.trim()) {
          cur.keys = Array.isArray(cur.keys) ? cur.keys : [];
          const raw = b.apiKey.trim();
          if (!cur.keys.some((k) => k.key === raw)) {
            cur.keys.push({ id: 'k' + crypto.randomBytes(4).toString('hex'), label: b.label || ('Akun ' + (cur.keys.length + 1)), key: raw, enabled: true, expiresAt: num(b.expiresAt), limit: num(b.limit), limitType: b.limitType === 'request' ? 'request' : 'token', createdAt: Date.now() });
          }
          delete cur.apiKey;
        }
        stored[id] = cur;
        await C.setJSON('providers', stored);
        return res.status(200).json({ ok: true, id });
      }

      /* --- tambah banyak key sekaligus (multi-akun OpenRouter dll) --- */
      if (seg.length === 3 && seg[2] === 'keys' && m === 'POST') {
        const id = seg[1];
        const provs = await C.loadProviders();
        if (!provs[id]) return C.sendErr(res, 404, 'provider tidak ada');
        const b = body(req);
        const list = Array.isArray(b.keys) ? b.keys : [b];
        const cur = stored[id] || {};
        cur.keys = Array.isArray(cur.keys) ? cur.keys : (cur.apiKey ? [{ id: 'k0', label: 'Key 1', key: cur.apiKey }] : []);
        delete cur.apiKey;
        const added = [];
        for (const it of list) {
          const raw = String(it.key || it.apiKey || '').trim();
          if (!raw) continue;
          const exists = cur.keys.find((k) => k.key === raw);
          if (exists) {
            if (it.label) exists.label = it.label;
            if (it.expiresAt !== undefined) exists.expiresAt = num(it.expiresAt);
            if (it.limit !== undefined) exists.limit = num(it.limit);
            if (it.limitType) exists.limitType = it.limitType;
            continue;
          }
          const k = {
            id: 'k' + crypto.randomBytes(4).toString('hex'),
            label: it.label || ('Akun ' + (cur.keys.length + 1)),
            key: raw, enabled: true,
            expiresAt: num(it.expiresAt), limit: num(it.limit), limitType: it.limitType === 'request' ? 'request' : 'token',
            createdAt: Date.now(),
          };
          cur.keys.push(k); added.push(k.id);
        }
        stored[id] = cur;
        await C.setJSON('providers', stored);
        return res.status(200).json({ ok: true, added: added.length, keyIds: added, total: cur.keys.length });
      }

      /* --- ubah satu key (label / expired / limit / enable) --- */
      if (seg.length === 4 && seg[2] === 'keys' && (m === 'PUT' || m === 'POST' || m === 'PATCH')) {
        const [, id, , kid] = seg;
        const cur = stored[id];
        if (!cur || !Array.isArray(cur.keys)) return C.sendErr(res, 404, 'key tidak ada');
        const k = cur.keys.find((x) => x.id === kid);
        if (!k) return C.sendErr(res, 404, 'key tidak ada');
        const b = body(req);
        if (b.label != null) k.label = String(b.label).slice(0, 40);
        if (b.expiresAt !== undefined) k.expiresAt = num(b.expiresAt);
        if (b.limit !== undefined) k.limit = num(b.limit);
        if (b.limitType) k.limitType = b.limitType;
        if (typeof b.enabled === 'boolean') k.enabled = b.enabled;
        if (b.resetCooldown) { k.cooldownUntil = 0; k.fails = 0; k.lastError = null; }
        if (typeof b.key === 'string' && b.key.trim()) k.key = b.key.trim();
        await C.setJSON('providers', stored);
        return res.status(200).json({ ok: true });
      }

      if (seg.length === 4 && seg[2] === 'keys' && m === 'DELETE') {
        const [, id, , kid] = seg;
        const cur = stored[id];
        if (cur && Array.isArray(cur.keys)) {
          cur.keys = cur.keys.filter((x) => x.id !== kid);
          stored[id] = cur;
          await C.setJSON('providers', stored);
          try { await C.redis(['HDEL', 'pku', id + ':' + kid]); } catch (_) {}
        }
        return res.status(200).json({ ok: true });
      }

      if (seg.length === 3 && seg[2] === 'test' && m === 'POST') {
        const provs = await C.loadProviders();
        const prov = provs[seg[1]];
        if (!prov) return C.sendErr(res, 404, 'provider tidak ada');
        const b = body(req);
        let keys = prov.keys || [];
        if (b.keyId) keys = keys.filter((k) => k.id === b.keyId);
        keys = keys.filter((k) => k.key);
        if (!keys.length) return res.status(200).json({ id: seg[1], ok: false, error: 'Belum ada API key', keys: [] });
        const results = [];
        for (const k of keys) results.push(await testProviderKey(prov, k));
        const first = results[0] || {};
        return res.status(200).json({ id: seg[1], ok: results.some((r) => r.ok), ms: first.ms, models: first.models, error: first.error, keys: results });
      }

      if (seg.length === 2 && m === 'DELETE') {
        if (C.BUILTIN[seg[1]]) {
          if (stored[seg[1]]) { delete stored[seg[1]].apiKey; delete stored[seg[1]].keys; delete stored[seg[1]].disableEnv; }
          if (!stored[seg[1]] || !Object.keys(stored[seg[1]]).length) delete stored[seg[1]];
        } else delete stored[seg[1]];
        await C.setJSON('providers', stored);
        return res.status(200).json({ ok: true });
      }
    }

    /* ----- models ----- */
    if (seg[0] === 'models') {
      let models = await C.loadModels();
      if (seg[1] === 'detect' && m === 'POST') {
        const provs = await C.loadProviders();
        const r = await C.detectModels(provs, models);
        return res.status(200).json({ added: r.added, stale: r.stale, errors: r.errors, total: r.total });
      }
      if (seg[1] === 'reset' && m === 'POST') { await C.setJSON('models', C.SEED_MODELS); return res.status(200).json({ ok: true }); }
      if (seg[1] === 'clear-cooldown' && m === 'POST') {
        const keys = models.map((x) => 'cd:' + x.id);
        if (keys.length) await C.redis(['DEL', ...keys]);
        return res.status(200).json({ ok: true, cleared: keys.length });
      }
      if (seg.length === 1 && m === 'POST') {
        const b = body(req);
        const provs = await C.loadProviders();
        if (!provs[b.provider]) return C.sendErr(res, 400, 'provider tidak dikenal');
        if (!b.model) return C.sendErr(res, 400, 'nama model wajib');
        const id = b.provider + '/' + b.model;
        const score = Math.max(1, Math.min(100, Number(b.score) || C.guessScore(b.model)));
        const i = models.findIndex((x) => x.id === id);
        const row = { id, provider: b.provider, model: b.model, score, enabled: true, manual: true, stale: false };
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
          if (b.clearCooldown) { await C.redis(['DEL', 'cd:' + id]); const h = await C.getHealth(); delete h[id]; await C.setJSON('health', h); }
          await C.setJSON('models', models);
          return res.status(200).json({ ok: true });
        }
        if (m === 'DELETE') { models.splice(i, 1); await C.setJSON('models', models); return res.status(200).json({ ok: true }); }
      }
    }

    /* ----- gateway keys (API key untuk klien) ----- */
    if (seg[0] === 'keys') {
      if (seg.length === 1 && m === 'GET') {
        const [raw, tot, reqs] = await Promise.all([C.redis(['HGETALL', 'apikeys']), C.redis(['HGETALL', 'ktotal']), C.redis(['HGETALL', 'kreq'])]);
        const t = C.hgetallObj(tot), rq = C.hgetallObj(reqs); const out = []; const n0 = Date.now();
        for (let i = 0; i < raw.length; i += 2) {
          try {
            const k = JSON.parse(raw[i + 1]);
            const tok = t[k.id] || 0, req = rq[k.id] || 0;
            let blocked = null;
            if (k.enabled === false) blocked = 'disabled';
            else if (k.expiresAt && n0 > k.expiresAt) blocked = 'expired';
            else if (k.limit && tok >= k.limit) blocked = 'quota';
            out.push({ ...k, tok, req, pct: k.limit ? Math.round(100 * tok / k.limit) : null, remaining: k.limit ? Math.max(0, k.limit - tok) : null, blocked });
          } catch (_) {}
        }
        return res.status(200).json({ keys: out.sort((a, b) => b.created - a.created) });
      }
      if (seg.length === 1 && m === 'POST') {
        const b = body(req);
        const name = String(b.name || 'key').slice(0, 40);
        const raw = 'sk-yoru-' + crypto.randomBytes(24).toString('hex');
        const id = C.sha(raw).slice(0, 10);
        const rec = {
          id, name, created: Date.now(), preview: raw.slice(0, 11) + '…' + raw.slice(-4),
          expiresAt: num(b.expiresAt) || (b.expiresDays ? Date.now() + Number(b.expiresDays) * 864e5 : null),
          limit: num(b.limit), limitType: b.limitType === 'request' ? 'request' : 'token',
          enabled: true,
        };
        await C.redis(['HSET', 'apikeys', C.sha(raw), JSON.stringify(rec)]);
        return res.status(200).json({ key: raw, id, name, expiresAt: rec.expiresAt, limit: rec.limit, limitType: rec.limitType });
      }
      if (seg.length === 2 && (m === 'PUT' || m === 'PATCH')) {
        const b = body(req);
        const raw = await C.redis(['HGETALL', 'apikeys']);
        for (let i = 0; i < raw.length; i += 2) {
          try {
            const k = JSON.parse(raw[i + 1]);
            if (k.id !== seg[1]) continue;
            if (b.name != null) k.name = String(b.name).slice(0, 40);
            if (b.expiresAt !== undefined) k.expiresAt = num(b.expiresAt);
            if (b.expiresDays !== undefined) k.expiresAt = b.expiresDays ? Date.now() + Number(b.expiresDays) * 864e5 : null;
            if (b.limit !== undefined) k.limit = num(b.limit);
            if (b.limitType) k.limitType = b.limitType;
            if (typeof b.enabled === 'boolean') k.enabled = b.enabled;
            if (b.resetUsage) { await C.redis(['HDEL', 'ktotal', k.id]); await C.redis(['HDEL', 'kreq', k.id]); }
            await C.redis(['HSET', 'apikeys', raw[i], JSON.stringify(k)]);
            return res.status(200).json({ ok: true });
          } catch (_) {}
        }
        return C.sendErr(res, 404, 'key tidak ada');
      }
      if (seg.length === 2 && m === 'DELETE') {
        const raw = await C.redis(['HGETALL', 'apikeys']);
        for (let i = 0; i < raw.length; i += 2) {
          try { if (JSON.parse(raw[i + 1]).id === seg[1]) { await C.redis(['HDEL', 'apikeys', raw[i]]); break; } } catch (_) {}
        }
        return res.status(200).json({ ok: true });
      }
    }

    return C.sendErr(res, 404, 'Endpoint admin tidak ditemukan: /' + p);
  } catch (e) {
    return C.sendErr(res, 500, String(e.message || e));
  }
};
