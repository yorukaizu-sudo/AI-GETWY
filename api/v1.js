const { crypto, now, sha, fail, send, load, tx, http, hd } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  try { await gw(req, res); }
  catch (e) { send(res, e.code || 500, { error: { message: e.message, code: e.code || 500, ...(e.x || {}) } }); }
};

async function gw(req, res) {
  const hs = sha((req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim());
  const d = await load();
  const kn = d.keys.find(k => k.hash.length === hs.length && crypto.timingSafeEqual(Buffer.from(k.hash), Buffer.from(hs)));
  if (!kn) fail(401, 'API key tidak valid');

  let path = req.query && req.query.path; if (Array.isArray(path)) path = path.join('/');
  if (!path) path = (req.url || '').split('?')[0].replace(/^\/(api\/)?v1\/?/, '');
  path = String(path).replace(/^\/+|\/+$/g, '');

  const t = now();
  let ms = Object.entries(d.models).filter(([, m]) => m.on && d.providers[m.p] && d.providers[m.p].on);
  if (path === 'models' && req.method === 'GET')
    return send(res, 200, { object: 'list', data: [{ id: 'auto', object: 'model', owned_by: 'gateway' }, ...ms.map(([, m]) => ({ id: m.p + '/' + m.id, object: 'model', owned_by: m.p }))] });
  if (path !== 'chat/completions' || req.method !== 'POST') fail(404, 'Endpoint tidak ada');

  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b || !Array.isArray(b.messages) || !b.messages.length) fail(400, 'Body JSON harus berisi messages');

  const want = b.model || 'auto';
  if (want === 'auto') ms.sort((a, c) => ((a[1].cool > t) - (c[1].cool > t)) || (c[1].score - a[1].score));
  else { ms = ms.filter(([, m]) => m.p + '/' + m.id === want || m.id === want); if (!ms.length) fail(404, `Model '${want}' tidak ditemukan`); }
  if (!ms.length) fail(503, 'Belum ada model aktif. Tambah provider di dashboard.');

  const t0 = Date.now(), log = []; let ok = null;
  for (const [k, m] of ms) {
    const left = 50000 - (Date.now() - t0);
    if (left < 6000 || log.length >= 8) break;
    const p = d.providers[m.p];
    const body = { ...b, model: m.id, stream: false }; delete body.stream_options;
    const t1 = Date.now();
    const r = await http('POST', p.url.replace(/\/+$/, '') + '/chat/completions', hd(p), JSON.stringify(body), Math.min(30000, left));
    let j = null; try { j = JSON.parse(r.r); } catch {}
    const good = r.c === 200 && j && Array.isArray(j.choices) && j.choices.length > 0;
    const l = { k, c: r.c, ok: good, h: r.h, j: good ? j : null, lat: Date.now() - t1 };
    log.push(l);
    if (good) { ok = l; break; }
  }

  const last = log[log.length - 1], tk = ok ? ((ok.j.usage && ok.j.usage.total_tokens) | 0) : 0;
  await tx(d => {
    for (const l of log) {
      const m = d.models[l.k]; if (!m) continue;
      if (l.ok) { m.ok++; m.cool = 0; }
      else { m.fail++; const ra = parseInt(l.h['retry-after']) || 0; m.cool = l.c === 400 ? 0 : t + (l.c === 429 ? Math.max(60, Math.min(ra, 900)) : [401, 402, 403, 404].includes(l.c) ? 3600 : 90); }
    }
    if (ok) {
      const p = d.providers[ok.k.split('|')[0]];
      if (p) {
        p.used = (p.used || 0) + tk; p.reqs = (p.reqs || 0) + 1;
        for (const [f, h] of [['rem_tokens', 'x-ratelimit-remaining-tokens'], ['lim_tokens', 'x-ratelimit-limit-tokens'], ['rem_req', 'x-ratelimit-remaining-requests']])
          if (ok.h[h] != null && !isNaN(parseInt(ok.h[h]))) p[f] = parseInt(ok.h[h]);
      }
    }
    const kk = d.keys.find(x => x.id === kn.id); if (kk) { kk.use++; kk.tok += tk; }
    d.stats.req++; d.stats.tok += tk;
    d.logs.unshift({ t, key: kn.name, m: last.k.replace('|', '/'), c: last.c, tok: tk, ms: last.lat, n: log.length });
    d.logs = d.logs.slice(0, 200);
  });

  if (!ok) fail(502, 'Semua model yang dicoba gagal', { tries: log.map(l => ({ model: l.k.replace('|', '/'), status: l.c })) });
  const j = ok.j, mid = ok.k.replace('|', '/');
  res.setHeader('X-Gateway-Model', mid); res.setHeader('X-Gateway-Tries', String(log.length));
  if (!b.stream) return send(res, 200, j);

  // stream: hasil upstream dikirim sebagai SSE (tool_calls ikut diteruskan)
  res.statusCode = 200; res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache');
  const c0 = j.choices[0], msg = c0.message || {};
  const base = { id: j.id || 'chatcmpl-' + crypto.randomBytes(6).toString('hex'), object: 'chat.completion.chunk', created: t, model: j.model || mid };
  const delta = { role: 'assistant', content: msg.content ?? '' };
  if (msg.tool_calls) delta.tool_calls = msg.tool_calls.map((x, i) => ({ index: i, ...x }));
  res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: c0.finish_reason || 'stop' }], usage: j.usage || null }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
