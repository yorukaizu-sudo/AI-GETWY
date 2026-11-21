const L = require('./_lib');
const { crypto, CID, SECRET, OWNER, RU, RT, now, fail, send, mask, load, tx, http, mkSession, okSession, score, fetchModels, applySync } = L;

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST' || !req.headers['x-req']) fail(400, 'Bad request');
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    await act((b || {}).a, b || {}, req, res);
  } catch (e) { send(res, e.code || 500, { error: { message: e.message, code: e.code || 500 } }); }
};

async function act(a, b, req, res) {
  if (a === 'cfg') return send(res, 200, { cid: CID, secret: !!SECRET, db: !!(RU && RT) });
  if (a === 'login') {
    if (!CID || !SECRET) fail(500, 'GOOGLE_CLIENT_ID / SESSION_SECRET belum diatur di Vercel');
    const r = await http('GET', 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(b.credential || ''));
    let j = {}; try { j = JSON.parse(r.r); } catch {}
    if (r.c !== 200 || j.aud !== CID || String(j.email || '').toLowerCase() !== OWNER || String(j.email_verified) !== 'true') fail(403, 'Akun ini tidak diizinkan');
    res.setHeader('Set-Cookie', `yg_s=${mkSession()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);
    return send(res, 200, { ok: 1 });
  }
  if (!okSession(req)) fail(401, 'Belum login');
  const ok = () => send(res, 200, { ok: 1 });

  switch (a) {
    case 'state': {
      const d = await load();
      for (const p of Object.values(d.providers)) p.key = mask(p.key);
      for (const k of d.keys) delete k.hash;
      d.logs = d.logs.slice(0, 40); d.now = now();
      return send(res, 200, { d });
    }
    case 'prov_save': {
      const n = String(b.name || '').trim(), u = String(b.url || '').trim().replace(/\/+$/, '');
      const id = n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!id || !u.startsWith('https://')) fail(400, 'Nama dan Base URL (https://) wajib diisi');
      const o = (await load()).providers[id] || { used: 0, reqs: 0 };
      const key = String(b.key || '').trim() || o.key || '';
      if (!key) fail(400, 'API key provider wajib diisi');
      const nu = { name: n, url: u, key, free: !!b.free, on: true };
      const res2 = await fetchModels({ ...o, ...nu });
      await tx(d => { d.providers[id] = { ...(d.providers[id] || o), ...nu }; applySync(d, id, res2); });
      return ok();
    }
    case 'prov_set': await tx(d => { if (d.providers[b.id]) d.providers[b.id].on = !!b.on; }); return ok();
    case 'prov_del': await tx(d => { delete d.providers[b.id]; for (const k of Object.keys(d.models)) if (d.models[k].p === b.id) delete d.models[k]; }); return ok();
    case 'sync': {
      const d0 = await load();
      const ids = Object.keys(d0.providers).filter(i => !b.id || i === b.id);
      const rs = await Promise.all(ids.map(i => fetchModels(d0.providers[i])));
      await tx(d => ids.forEach((i, x) => applySync(d, i, rs[x])));
      return ok();
    }
    case 'model_add': {
      const mid = String(b.id || '').trim();
      await tx(d => {
        if (!mid || !d.providers[b.p]) fail(400, 'Pilih provider dan isi ID model');
        d.models[b.p + '|' + mid] = { p: b.p, id: mid, score: Math.max(1, Math.min(100, parseInt(b.score) || 70)), on: true, custom: true, cool: 0, ok: 0, fail: 0 };
      });
      return ok();
    }
    case 'model_set':
      await tx(d => {
        const m = d.models[b.k]; if (!m) return;
        if (b.score != null) m.score = Math.max(1, Math.min(100, parseInt(b.score) || 1));
        if (b.on != null) m.on = !!b.on;
      });
      return ok();
    case 'model_del': await tx(d => { delete d.models[b.k]; }); return ok();
    case 'key_new': {
      const raw = 'sk-yg-' + crypto.randomBytes(20).toString('hex');
      await tx(d => { d.keys.push({ id: crypto.randomBytes(4).toString('hex'), name: String(b.name || 'key').slice(0, 40), hash: L.sha(raw), pre: raw.slice(0, 12) + '…', t: now(), use: 0, tok: 0 }); });
      return send(res, 200, { key: raw });
    }
    case 'key_del': await tx(d => { d.keys = d.keys.filter(k => k.id !== b.id); }); return ok();
    case 'logout': res.setHeader('Set-Cookie', 'yg_s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'); return ok();
    default: fail(400, 'Aksi tidak dikenal');
  }
}
