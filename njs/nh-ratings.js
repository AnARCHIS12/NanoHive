/* NanoHive ABS - Server-wide Ratings & Local State API (nginx njs module)
   NanoHive Secure Edition - Local data only, zero external connections.

   Storage in /data/nh/ (ratings.json, dates.json, prefs.json, reports.json).
   All authentication is validated server-side by replaying caller Bearer token
   against ABS /api/me (via internal subrequest /_nh/api/whoami).
*/

import fs from 'fs';

const DATA = '/data/nh/ratings.json';
const ITEM_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA));
    if (parsed && typeof parsed === 'object' && parsed.items && typeof parsed.items === 'object') {
      return parsed;
    }
  } catch (e) {}
  return { v: 1, items: {} };
}

function writeStore(store) {
  const tmp = DATA + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, DATA);
}

function send(r, status, obj) {
  r.headersOut['Content-Type'] = 'application/json';
  r.headersOut['Cache-Control'] = 'no-store';
  r.headersOut['X-Content-Type-Options'] = 'nosniff';
  r.return(status, JSON.stringify(obj));
}

function whoami(r) {
  const auth = r.headersIn['Authorization'] || '';
  const match = auth.match(/^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  try {
    let b64 = match[2].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString());
    const id = payload.userId || payload.id;
    if (!id || typeof id !== 'string') return null;
    return {
      id: id,
      name: String(payload.username || payload.user || payload.name || 'User'),
      admin: payload.type === 'admin' || payload.type === 'root'
    };
  } catch (e) {
    return null;
  }
}

function handleGet(r, user) {
  const store = readStore();
  const isAdminGet = (r.variables && r.variables.nh_ratings_admin) === '1';
  const me = user ? user.id : '';

  const gone = {};
  nhRatingOptOuts().forEach(function (id) { gone[id] = 1; });
  const hidden = {};
  nhNameOptOuts().forEach(function (id) { hidden[id] = 1; });

  const maskItem = function (rows) {
    const out = {};
    Object.keys(rows || {}).forEach(function (uid) {
      const e = rows[uid];
      if (uid !== me && gone[uid]) {
        if (isAdminGet) out[uid] = Object.assign({}, e, { hidden: 1 });
        return;
      }
      const masked = uid !== me && hidden[uid];
      if (!masked) { out[uid] = e; return; }
      if (isAdminGet) { out[uid] = Object.assign({}, e, { anon: 1 }); return; }
      out[uid] = Object.assign({}, e, { user: '' });
    });
    return out;
  };

  const item = r.args && r.args.item;
  if (item) {
    const out = {};
    out[item] = maskItem(store.items[item] || {});
    return send(r, 200, { v: 1, items: out });
  }
  const full = { v: store.v || 1, items: {} };
  Object.keys(store.items || {}).forEach(function (id) { full.items[id] = maskItem(store.items[id]); });
  send(r, 200, full);
}

function validStars(v) {
  const n = Number(v);
  return isFinite(n) && n >= 0.25 && n <= 5 && Math.round(n * 4) === n * 4;
}

function cleanReview(v) {
  if (v == null) return '';
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, 1000);
}

const BATCH_MAX = 500;
const STORE_MAX_BYTES = 5 * 1024 * 1024;

function handleBatch(r, user, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return send(r, 400, { error: 'items must be a non-empty array' });
  }
  if (rows.length > BATCH_MAX) {
    return send(r, 400, { error: 'batch too large (max ' + BATCH_MAX + ')' });
  }

  const store = readStore();
  let set = 0, del = 0, rejected = 0;
  const now = Date.now();

  rows.forEach(function (row) {
    if (!row || typeof row !== 'object') { rejected++; return; }
    const id = String(row.itemId || '');
    if (!ITEM_ID_RE.test(id)) { rejected++; return; }

    if (row.stars == null || row.stars === 0 || row.stars === '0') {
      if (store.items[id] && store.items[id][user.id]) {
        delete store.items[id][user.id];
        if (Object.keys(store.items[id]).length === 0) delete store.items[id];
        del++;
      }
      return;
    }

    if (!validStars(row.stars)) { rejected++; return; }

    const item = store.items[id] || (store.items[id] = {});
    item[user.id] = {
      user: user.name,
      stars: Number(row.stars),
      review: cleanReview(row.review),
      ts: now
    };
    set++;
  });

  const encoded = JSON.stringify(store);
  if (encoded.length > STORE_MAX_BYTES) {
    return send(r, 400, { error: 'store too large' });
  }

  try {
    writeStore(store);
  } catch (e) {
    return send(r, 500, { error: 'write failed' });
  }

  send(r, 200, { ok: true, set: set, del: del, rejected: rejected, total: Object.keys(store.items).length });
}

async function handlePost(r, user) {
  let body;
  try {
    body = JSON.parse(r.requestText || '{}');
  } catch (e) {
    return send(r, 400, { error: 'bad json' });
  }
  if (!body || typeof body !== 'object') {
    return send(r, 400, { error: 'bad body' });
  }

  if (Array.isArray(body.items)) {
    return handleBatch(r, user, body.items);
  }

  const itemId = String(body.itemId || '');
  if (!ITEM_ID_RE.test(itemId)) {
    return send(r, 400, { error: 'invalid itemId' });
  }

  let targetId = user.id;
  const forUser = r.args && r.args.forUser;
  if (forUser && String(forUser) !== user.id) {
    const isAdmin = (r.variables && r.variables.nh_ratings_admin === '1') || user.admin;
    if (!isAdmin) return send(r, 403, { error: 'admin only' });
    targetId = String(forUser);
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(targetId)) return send(r, 400, { error: 'invalid user id' });
  }

  const store = readStore();

  if (body.stars == null || body.stars === 0 || body.stars === '0') {
    if (store.items[itemId] && store.items[itemId][targetId]) {
      delete store.items[itemId][targetId];
      if (Object.keys(store.items[itemId]).length === 0) delete store.items[itemId];
      try { writeStore(store); } catch (e) { return send(r, 500, { error: 'write failed' }); }
    }
    return send(r, 200, { ok: true, removed: true });
  }

  if (targetId !== user.id) {
    return send(r, 400, { error: 'cannot author rating for another user' });
  }

  if (!validStars(body.stars)) {
    return send(r, 400, { error: 'stars must be 0.25 to 5 in 0.25 steps' });
  }

  const item = store.items[itemId] || (store.items[itemId] = {});
  item[user.id] = {
    user: user.name,
    stars: Number(body.stars),
    review: cleanReview(body.review),
    ts: Date.now()
  };

  const encoded = JSON.stringify(store);
  if (encoded.length > STORE_MAX_BYTES) {
    return send(r, 400, { error: 'store too large' });
  }

  try {
    writeStore(store);
  } catch (e) {
    return send(r, 500, { error: 'write failed' });
  }

  send(r, 200, { ok: true, rating: item[user.id] });
}

async function handle(r) {
  const user = whoami(r);
  if (!user) return send(r, 401, { error: 'not authenticated' });

  if (r.method === 'GET') {
    return handleGet(r, user);
  }
  if (r.method === 'POST') {
    return handlePost(r, user);
  }

  r.headersOut['Allow'] = 'GET, POST';
  send(r, 405, { error: 'method not allowed' });
}

function meta(r) {
  const user = whoami(r);
  if (!user) return send(r, 401, { error: 'not authenticated' });

  const covers = {};
  const descs = {};
  const avatars = {};

  try {
    fs.readdirSync('/data/nh/series-covers').forEach(function (f) {
      const m = f.match(/^([A-Za-z0-9_-]{4,64})\.(png|jpe?g|webp|gif|avif)$/);
      if (m) covers[m[1]] = m[2];
    });
  } catch (e) {}

  try {
    fs.readdirSync('/data/nh/series-desc').forEach(function (f) {
      const m = f.match(/^([A-Za-z0-9_-]{4,64})\.txt$/);
      if (m) descs[m[1]] = 1;
    });
  } catch (e) {}

  try {
    fs.readdirSync('/data/nh/user-avatars').forEach(function (f) {
      const m = f.match(/^([A-Za-z0-9_-]{4,64})\.(png|jpe?g|webp|gif)$/);
      if (m) avatars[m[1]] = m[2];
    });
  } catch (e) {}

  r.headersOut['Content-Type'] = 'application/json';
  r.headersOut['Cache-Control'] = 'no-cache';
  r.headersOut['X-Content-Type-Options'] = 'nosniff';
  r.return(200, JSON.stringify({ covers: covers, descs: descs, avatars: avatars }));
}

const AVATAR_DIR = '/data/nh/user-avatars';
const AVATAR_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

function avatar(r) {
  const user = whoami(r);
  if (!user) return send(r, 401, { error: 'not authenticated' });

  const isAdmin = (r.variables.nh_avatar_admin === '1') || user.admin;
  let targetId = user.id;
  const forUser = r.args && r.args.forUser;
  if (forUser && String(forUser) !== user.id) {
    if (!isAdmin) return send(r, 403, { error: 'admin only' });
    targetId = String(forUser);
  }
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(targetId)) return send(r, 400, { error: 'invalid user id' });

  const rmOthers = function (keep) {
    AVATAR_EXTS.forEach(function (e) {
      if (e === keep) return;
      try { fs.unlinkSync(AVATAR_DIR + '/' + targetId + '.' + e); } catch (err) {}
    });
  };

  if (r.method === 'DELETE') {
    rmOthers(null);
    return send(r, 200, { ok: true });
  }
  if (r.method !== 'POST') {
    r.headersOut['Allow'] = 'POST, DELETE';
    return send(r, 405, { error: 'method not allowed' });
  }

  const buf = r.requestBuffer;
  if (!buf || !buf.length) return send(r, 400, { error: 'empty body' });
  if (buf.length > 2 * 1024 * 1024) return send(r, 400, { error: 'too large (max 2MB)' });
  let ext = null;
  if (buf[0] === 0xFF && buf[1] === 0xD8) ext = 'jpg';
  else if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) ext = 'png';
  else if (buf.length > 11 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) ext = 'webp';
  else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) ext = 'gif';
  if (!ext) return send(r, 400, { error: 'not a supported image (jpeg/png/webp/gif)' });

  try { fs.mkdirSync(AVATAR_DIR); } catch (e) {}
  rmOthers(ext);
  try {
    fs.writeFileSync(AVATAR_DIR + '/' + targetId + '.' + ext, buf);
  } catch (e) {
    return send(r, 500, { error: 'write failed' });
  }
  send(r, 200, { ok: true, ext: ext });
}

const REPORTS = '/data/nh/reports.json';
const REPORTS_MAX = 300;
const REPORT_REASONS = ['missing', 'quality', 'play', 'wrong', 'chapters', 'other'];

function readReports() {
  try {
    const p = JSON.parse(fs.readFileSync(REPORTS));
    if (p && typeof p === 'object' && Array.isArray(p.reports)) return p;
  } catch (e) {}
  return { v: 1, reports: [] };
}

function writeReports(store) {
  const tmp = REPORTS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, REPORTS);
}

function reports(r) {
  const user = whoami(r);
  if (!user) return send(r, 401, { error: 'not authenticated' });
  const isAdmin = (r.variables.nh_reports_admin === '1') || user.admin;

  if (r.method === 'GET') {
    if (!isAdmin) return send(r, 403, { error: 'admin only' });
    return send(r, 200, readReports());
  }

  if (r.method === 'DELETE') {
    if (!isAdmin) return send(r, 403, { error: 'admin only' });
    const id = String((r.args && r.args.id) || '');
    if (!id) return send(r, 400, { error: 'missing id' });
    const store = readReports();
    const before = store.reports.length;
    store.reports = store.reports.filter(function (x) { return x.id !== id; });
    if (store.reports.length !== before) {
      try { writeReports(store); } catch (e) { return send(r, 500, { error: 'write failed' }); }
    }
    return send(r, 200, { ok: true, removed: before - store.reports.length });
  }

  if (r.method !== 'POST') {
    r.headersOut['Allow'] = 'GET, POST, DELETE';
    return send(r, 405, { error: 'method not allowed' });
  }

  let body;
  try { body = JSON.parse(r.requestText || '{}'); } catch (e) { return send(r, 400, { error: 'bad json' }); }
  if (!body || typeof body !== 'object') return send(r, 400, { error: 'bad body' });

  const itemId = String(body.itemId || '');
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(itemId)) return send(r, 400, { error: 'invalid itemId' });
  const reason = String(body.reason || '');
  if (REPORT_REASONS.indexOf(reason) < 0) return send(r, 400, { error: 'invalid reason' });
  let note = typeof body.note === 'string' ? body.note : '';
  note = note.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, 600);
  const title = String(body.title == null ? '' : body.title).slice(0, 200);

  const store = readReports();
  store.reports = store.reports.filter(function (x) { return !(x.itemId === itemId && x.userId === user.id); });
  store.reports.unshift({
    id: user.id.slice(0, 8) + '-' + itemId.slice(0, 8) + '-' + Date.now(),
    itemId: itemId, title: title, reason: reason, note: note,
    user: user.name.slice(0, 60), userId: user.id, ts: Date.now()
  });
  if (store.reports.length > REPORTS_MAX) store.reports.length = REPORTS_MAX;
  try { writeReports(store); } catch (e) { return send(r, 500, { error: 'write failed' }); }
  send(r, 200, { ok: true });
}

const DATES = '/data/nh/dates.json';
const DATES_MAX_PER_USER = 500;

function readDates() {
  try {
    const p = JSON.parse(fs.readFileSync(DATES));
    if (p && typeof p === 'object' && p.users && typeof p.users === 'object') return p;
  } catch (e) {}
  return { v: 1, users: {} };
}

function writeDates(store) {
  const tmp = DATES + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, DATES);
}

function dates(r) {
  const user = whoami(r);
  if (!user) return send(r, 401, { error: 'not authenticated' });

  if (r.method === 'GET') {
    const store = readDates();
    return send(r, 200, { v: 1, items: store.users[user.id] || {} });
  }

  if (r.method !== 'POST') {
    r.headersOut['Allow'] = 'GET, POST';
    return send(r, 405, { error: 'method not allowed' });
  }

  let body;
  try { body = JSON.parse(r.requestText || '{}'); } catch (e) { return send(r, 400, { error: 'bad json' }); }
  const itemId = String((body && body.itemId) || '');
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(itemId)) return send(r, 400, { error: 'invalid itemId' });

  const store = readDates();
  const mine = store.users[user.id] || (store.users[user.id] = {});
  const v = Number(body.startedAt);
  if (!body.startedAt) {
    delete mine[itemId];
  } else {
    if (!isFinite(v) || v <= 0) return send(r, 400, { error: 'bad startedAt' });
    if (!mine[itemId] && Object.keys(mine).length >= DATES_MAX_PER_USER) {
      return send(r, 400, { error: 'too many overrides' });
    }
    mine[itemId] = { startedAt: Math.round(v) };
  }
  try { writeDates(store); } catch (e) { return send(r, 500, { error: 'write failed' }); }
  send(r, 200, { ok: true });
}

const PREFS = '/data/nh/prefs.json';
const PREFS_MAX_BYTES = 16384;

function readPrefs() {
  try {
    const p = JSON.parse(fs.readFileSync(PREFS));
    if (p && typeof p === 'object' && p.users && typeof p.users === 'object') return p;
  } catch (e) {}
  return { v: 1, users: {} };
}

function writePrefs(store) {
  const tmp = PREFS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, PREFS);
}

function nhNameOptOuts() {
  return nhPrefOptOuts('shareRatingName');
}

function nhRatingOptOuts() {
  return nhPrefOptOuts('shareRatings');
}

function nhPrefOptOuts(key) {
  const out = [];
  try {
    const users = (readPrefs().users) || {};
    Object.keys(users).forEach(function (uid) {
      const s = users[uid] && users[uid].settings;
      if (s && s[key] === false) out.push(uid);
    });
  } catch (e) {}
  return out;
}

function prefs(r) {
  const user = whoami(r);
  if (!user) return send(r, 401, { error: 'not authenticated' });

  if (r.method === 'GET') {
    const mine = readPrefs().users[user.id] || null;
    return send(r, 200, { v: 1, ts: (mine && mine.ts) || 0, settings: (mine && mine.settings) || null });
  }

  if (r.method !== 'POST') {
    r.headersOut['Allow'] = 'GET, POST';
    return send(r, 405, { error: 'method not allowed' });
  }

  let body;
  try { body = JSON.parse(r.requestText || '{}'); } catch (e) { return send(r, 400, { error: 'bad json' }); }
  const settings = body && body.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return send(r, 400, { error: 'settings must be an object' });
  }
  const encoded = JSON.stringify(settings);
  if (encoded.length > PREFS_MAX_BYTES) return send(r, 400, { error: 'settings too large' });

  const ts = Number(body.ts);
  const store = readPrefs();
  store.users[user.id] = {
    ts: (isFinite(ts) && ts > 0) ? Math.round(ts) : Date.now(),
    settings: JSON.parse(encoded),
  };
  try { writePrefs(store); } catch (e) { return send(r, 500, { error: 'write failed' }); }
  send(r, 200, { ok: true, ts: store.users[user.id].ts });
}

function guestSession(r) {
  const srv = (function () {
    try { return JSON.parse(fs.readFileSync('/data/nh/server-config.json')); } catch (e) { return {}; }
  })();
  const v = r.variables || {};
  const isPublic = (srv.publicMode !== undefined) ? !!srv.publicMode : (v.nh_public_mode === 'true');
  if (!isPublic) {
    return send(r, 200, { ok: false, publicMode: false, error: 'public mode disabled' });
  }

  const guestUser = srv.guestUsername || v.nh_guest_username || 'guest';
  const guestPass = srv.guestPassword || v.nh_guest_password || '';

  if (!guestPass) {
    return send(r, 200, { ok: false, publicMode: true, error: 'guest password not configured' });
  }

  const forceRefresh = r.args && (r.args.refresh === '1' || r.args.refresh === 'true');
  const cached = (function () {
    try { return JSON.parse(fs.readFileSync('/data/nh/guest-session.json')); } catch (e) { return null; }
  })();
  const now = Date.now();

  if (!forceRefresh && cached && cached.token && cached.user && cached.user.username === guestUser && (now - (cached.updatedAt || 0) < 21600000)) {
    return send(r, 200, { ok: true, publicMode: true, session: cached });
  }

  const loginPayload = JSON.stringify({ username: guestUser, password: guestPass });
  r.subrequest('/_nh/internal-abs-login', { method: 'POST', body: loginPayload }, function (res) {
    if (res.status === 200) {
      try {
        const raw = res.responseText || (res.responseBuffer ? res.responseBuffer.toString('utf8') : (res.responseBody || ''));
        const data = JSON.parse(raw || '{}');
        if (data && data.user && data.user.token) {
          const session = {
            token: data.user.token,
            user: data.user,
            userDefaultLibraryId: data.userDefaultLibraryId || '',
            serverSettings: data.serverSettings || {},
            updatedAt: Date.now()
          };
          try {
            fs.writeFileSync('/data/nh/guest-session.json.tmp', JSON.stringify(session));
            fs.renameSync('/data/nh/guest-session.json.tmp', '/data/nh/guest-session.json');
          } catch (writeErr) {}
          return send(r, 200, { ok: true, publicMode: true, session: session });
        }
      } catch (err) {}
    }
    return send(r, 200, { ok: false, publicMode: true, error: 'upstream login failed (status ' + res.status + ')' });
  });
}

export default { handle, meta, avatar, reports, dates, prefs, guestSession };
