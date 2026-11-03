import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash, createPublicKey, createHmac, randomInt } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, unlinkSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, domainToASCII } from 'node:url';
import proxyaddr from 'proxy-addr';
import { ipKeyGenerator } from 'express-rate-limit';
import { loadConfig } from './lib/config.js';
import { verificationMailer } from './lib/mailer.js';
import { mediaStorage, MAX_UPLOAD_BYTES } from './lib/storage.js';

const scrypt = promisify(scryptCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.4.0';
const colors = ['#dacaf0', '#d5c9f2', '#e5c9ed', '#f1cee3', '#cbd6f3', '#e4d1ec'];
const publicUser = u => ({ id: u.id, name: u.name, username: u.username, color: u.color });
const accountUser = u => ({ ...publicUser(u), email: u.email ?? null });
function normalizeEmail(value) {
  if (typeof value !== 'string') throw fail('Emel diperlukan untuk pendaftaran.');
  const raw = value.trim();
  if (raw.length > 254) throw fail('Alamat emel maksimum 254 aksara.');
  const parts = raw.split('@');
  if (parts.length !== 2) throw fail('Masukkan alamat emel yang sah.');
  const local = parts[0], domain = domainToASCII(parts[1].toLowerCase());
  const labels = domain.split('.');
  if (!local || local.length > 64 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) || !/^[a-z][a-z0-9-]{1,62}$/i.test(labels.at(-1))) throw fail('Masukkan alamat emel yang sah.');
  const email = local.toLowerCase() + '@' + domain.toLowerCase();
  if (email.length > 254) throw fail('Alamat emel maksimum 254 aksara.');
  return email;
}
const tokenHash = t => createHash('sha256').update(t).digest('hex');
const cookieToken = req => /(?:^|;\s*)sembang=([^;]+)/.exec(req.headers.cookie || '')?.[1];
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function createApp({ dataDir = process.env.DATA_DIR || path.join(root, 'data'), config = {}, sendVerification } = {}) {
  dataDir = path.resolve(dataDir);
  if (dataDir === path.parse(dataDir).root) throw new Error('DATA_DIR tidak boleh menjadi root filesystem.');
  const settings = { ...loadConfig(), ...config };
  const mailer = verificationMailer(settings);
  let closing = false, closePromise;
  let authJobs = 0, verificationJobs = 0;
  async function passwordHash(password, salt) {
    if (authJobs >= 4) throw Object.assign(fail('Pelayan sibuk. Cuba semula sebentar.', 503), { retryAfter: 2 });
    authJobs++;
    try { return await scrypt(password, salt, 64); } finally { authJobs--; }
  }
  mkdirSync(path.join(dataDir, 'uploads'), { recursive: true, mode: 0o700 });
  if (settings.production) { chmodSync(dataDir, 0o700); chmodSync(path.join(dataDir, 'uploads'), 0o700); }
  const db = new DatabaseSync(path.join(dataDir, 'sembang.sqlite'));
  if (settings.production) chmodSync(path.join(dataDir, 'sembang.sqlite'), 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL, color TEXT NOT NULL, email TEXT);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, a TEXT REFERENCES users(id), b TEXT REFERENCES users(id), created INTEGER NOT NULL, UNIQUE(a,b));
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id), sender_id TEXT REFERENCES users(id), kind TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, read_at INTEGER, client_id TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS message_retry ON messages(sender_id,client_id) WHERE client_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS message_history ON messages(conversation_id,created);
    CREATE TABLE IF NOT EXISTS identities (user_id TEXT PRIMARY KEY REFERENCES users(id), public_key TEXT NOT NULL, fingerprint TEXT NOT NULL, backup TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id), filename TEXT NOT NULL, mime TEXT NOT NULL);
  `);
  // Additive migration preserves accounts, sessions, keys and chat from older installations.
  if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(lower(email)) WHERE email IS NOT NULL');
  for (const [column, definition] of [
    ['owner_id', 'TEXT REFERENCES users(id)'], ['bytes', 'INTEGER NOT NULL DEFAULT 0'],
    ['created_at', 'INTEGER NOT NULL DEFAULT 0'], ['committed', 'INTEGER NOT NULL DEFAULT 1'], ['client_id', 'TEXT'],
  ]) if (!db.prepare('PRAGMA table_info(media)').all().some(c => c.name === column)) db.exec(`ALTER TABLE media ADD COLUMN ${column} ${definition}`);
  if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, n INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS rate_limit_expiry ON rate_limits(expires);
    CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
    CREATE INDEX IF NOT EXISTS media_owner ON media(owner_id);
    CREATE INDEX IF NOT EXISTS media_pending ON media(committed,created_at);
    CREATE INDEX IF NOT EXISTS message_sender ON messages(sender_id);
    CREATE TABLE IF NOT EXISTS email_verifications (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, username TEXT NOT NULL,
      salt TEXT NOT NULL, password TEXT NOT NULL, color TEXT NOT NULL, code_hash TEXT NOT NULL, expires INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, existing_user_id TEXT REFERENCES users(id));
    CREATE INDEX IF NOT EXISTS verification_expiry ON email_verifications(expires);`);
  // Legacy media stays committed: encrypted history cannot be inspected for references.
  for (const row of db.prepare('SELECT id,filename FROM media WHERE bytes=0').all()) {
    try { db.prepare('UPDATE media SET bytes=? WHERE id=?').run(statSync(path.join(dataDir, 'uploads', row.filename)).size, row.id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  const storage = mediaStorage(db, dataDir, settings);
  storage.cleanup();
  const app = express();
  const http = createServer(app);
  app.disable('x-powered-by');
  const trustProxy = settings.trustProxy.length ? proxyaddr.compile(settings.trustProxy) : () => false;
  app.set('trust proxy', trustProxy);
  http.requestTimeout = 30000; http.headersTimeout = 15000; http.keepAliveTimeout = 5000;
  http.maxHeadersCount = 60;
  const allowedOrigin = req => {
    if (!req.headers.origin) return true;
    if (settings.origin) return req.headers.origin === settings.origin;
    try { return new URL(req.headers.origin).origin === `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`; } catch { return false; }
  };
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-ID', req.requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self)');
    let socketOrigin = '';
    try { const origin = new URL(settings.origin || `http://${req.headers.host}`); socketOrigin = `${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}`; } catch {}
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ${socketOrigin}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`);
    if (settings.production) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      const start = Date.now();
      res.on('finish', () => {
        if (req.path === '/api/health' || req.path === '/api/ready') return;
        console.log(JSON.stringify({ event: 'http', id: req.requestId, method: req.method, route: req.route?.path || '/asset', status: res.statusCode, ms: Date.now() - start }));
      });
      if (!req.secure && !['/api/health', '/api/ready'].includes(req.path)) return res.status(426).json({ error: 'Sambungan HTTPS diperlukan.' });
    }
    if (req.path.startsWith('/api') || req.path.startsWith('/media')) res.setHeader('Cache-Control', 'no-store');
    if (closing) return res.status(503).json({ error: 'Pelayan sedang dimulakan semula.' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !allowedOrigin(req)) return res.status(403).json({ error: 'Asal permintaan tidak dibenarkan.' });
    try {
      if (req.path.startsWith('/api') && !['/api/health', '/api/ready'].includes(req.path)) limited(`http:${ipKeyGenerator(req.ip)}`, 600, 60000);
      next();
    } catch (error) { next(error); }
  });
  app.use(express.json({ limit: '64kb', strict: true }));
  const sessionUser = req => {
    const token = cookieToken(req);
    if (!token) return null;
    const user = db.prepare('SELECT users.*, sessions.expires AS session_expires FROM users JOIN sessions ON sessions.user_id=users.id WHERE sessions.token=? AND sessions.expires>?').get(tokenHash(token), Date.now());
    return user && (!settings.requireEmailVerification || user.email_verified) ? user : null;
  };
  const auth = (req, res, next) => {
    req.user = sessionUser(req);
    if (!req.user) return res.status(401).json({ error: 'Sila log masuk semula.' });
    next();
  };
  const io = new Server(http, { maxHttpBufferSize: 64000, allowRequest: (req, cb) => cb(null, allowedOrigin(req)) });
  io.engine.use((req, res, next) => {
    try {
      if (closing || !allowedOrigin(req)) throw fail('Sambungan tidak dibenarkan.', 403);
      const secure = req.socket.encrypted || (trustProxy(req.socket.remoteAddress, 0) && req.headers['x-forwarded-proto'] === 'https');
      if (settings.production && !secure) throw fail('HTTPS diperlukan.', 403);
      if (!req._query?.sid) {
        limited(`connection:${ipKeyGenerator(proxyaddr(req, trustProxy))}`, 30, 60000);
        if (io.engine.clientsCount >= 1000) throw fail('Had sambungan telah dicapai.', 503);
      }
      next();
    } catch (error) { next(error); }
  });
  const presence = new Map();
  const calls = new Map();
  function limited(key, count, windowMs) {
    const now = Date.now(), hashed = tokenHash(key);
    if (db.prepare('SELECT count(*) AS n FROM rate_limits').get().n > 100000) throw fail('Pelayan sibuk. Cuba lagi sebentar.', 503);
    const row = db.prepare(`INSERT INTO rate_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET
      n=CASE WHEN expires<=? THEN 1 ELSE n+1 END, expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END
      RETURNING n,expires`).get(hashed, now + windowMs, now, now);
    if (row.n > count) throw Object.assign(fail('Terlalu banyak permintaan. Cuba lagi sebentar.', 429), { retryAfter: Math.max(1, Math.ceil((row.expires-now)/1000)) });
  }
  const validSocket = socket => {
    if (!socket.connected) return false;
    const session = db.prepare('SELECT 1 FROM sessions WHERE token=? AND expires>?').get(socket.data.sessionHash, Date.now());
    if (!session) { socket.disconnect(true); return false; }
    return true;
  };
  const emitUser = (userId, event, payload, except) => {
    for (const id of [...(io.sockets.adapter.rooms.get(`user:${userId}`) || [])]) {
      const socket = io.sockets.sockets.get(id);
      if (socket && id !== except && validSocket(socket)) socket.emit(event, payload);
    }
  };
  const emitAll = (event, payload) => { for (const socket of [...io.sockets.sockets.values()]) if (validSocket(socket)) socket.emit(event, payload); };
  const emitSocket = (id, event, payload) => { const socket = io.sockets.sockets.get(id); if (socket && validSocket(socket)) socket.emit(event, payload); };
  const maintenance = () => {
    const now = Date.now();
    db.prepare('DELETE FROM rate_limits WHERE expires<=?').run(now);
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
    db.prepare('DELETE FROM email_verifications WHERE expires<=?').run(now);
    storage.cleanup(now);
    for (const socket of [...io.sockets.sockets.values()]) validSocket(socket);
  };
  const cleanup = setInterval(() => { try { maintenance(); } catch (error) { console.error(JSON.stringify({ event: 'maintenance_error', code: error.code || error.name })); } }, 60000);
  cleanup.unref();
  function conversation(id, userId) {
    const c = db.prepare('SELECT * FROM conversations WHERE id=? AND (a=? OR b=?)').get(id, userId, userId);
    if (!c) throw fail('Perbualan tidak dijumpai.', 404);
    return c;
  }
  const peerId = (c, id) => c.a === id ? c.b : c.a;
  const emitBoth = (c, event, payload) => { emitUser(c.a, event, payload); emitUser(c.b, event, payload); };
  const decodeMessage = m => ({ id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, kind: m.kind, body: JSON.parse(m.body), created: m.created, readAt: m.read_at, clientId: m.client_id });
  function insertMessage(c, sender, kind, body, clientId = null, mediaId) {
    if (clientId) {
      const old = db.prepare('SELECT * FROM messages WHERE sender_id=? AND client_id=?').get(sender, clientId);
      if (old) {
        if (old.conversation_id !== c.id) throw fail('ID mesej telah digunakan.');
        return decodeMessage(old);
      }
    }
    storage.freeSpace();
    if (db.prepare('SELECT count(*) AS n FROM messages WHERE sender_id=?').get(sender).n >= settings.maxUserMessages || db.prepare('SELECT count(*) AS n FROM messages').get().n >= settings.maxTotalMessages) throw fail('Kuota mesej telah penuh.', 507);
    let media;
    if (mediaId !== undefined) {
      if (typeof mediaId !== 'string') throw fail('ID gambar tidak sah.');
      media = db.prepare('SELECT * FROM media WHERE id=? AND owner_id=? AND conversation_id=? AND client_id=? AND committed=0 AND created_at>?').get(mediaId, sender, c.id, clientId, Date.now()-settings.pendingUploadMs);
      if (!media) throw fail('Muat naik gambar tidak sepadan atau telah tamat tempoh.');
    }
    const m = { id: randomUUID(), conversationId: c.id, senderId: sender, kind, body, created: Date.now(), readAt: null, clientId };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)').run(m.id, c.id, sender, kind, JSON.stringify(body), m.created, null, clientId);
      if (media) db.prepare('UPDATE media SET committed=1 WHERE id=?').run(media.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    emitBoth(c, 'message', m);
    return m;
  }
  const identity = id => db.prepare('SELECT * FROM identities WHERE user_id=?').get(id);
  const publicIdentity = row => row ? { publicKey: JSON.parse(row.public_key), fingerprint: row.fingerprint } : null;
  const base64 = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
  function envelope(body, c, senderId) {
    const sender = identity(senderId), recipient = identity(peerId(c, senderId));
    if (!sender || !recipient) throw fail('Kedua-dua pengguna perlu menyediakan kunci penyulitan dahulu.', 409);
    if (!body || body.v !== 1 || body.senderKey !== sender.fingerprint || body.recipientKey !== recipient.fingerprint || !base64(body.iv, 16, 16) || !base64(body.data, 24, 50000)) throw fail('Mesej mesti disulitkan hujung ke hujung.');
    return { v: 1, senderKey: body.senderKey, recipientKey: body.recipientKey, iv: body.iv, data: body.data };
  }
  function updateEncrypted(id, userId, sealed) {
    if (typeof id !== 'string') throw fail('ID mesej tidak sah.');
    const row = db.prepare("SELECT * FROM messages WHERE id=? AND sender_id=? AND kind='encrypted'").get(id, userId);
    if (!row) throw fail('Mesej tidak dijumpai.', 404);
    const c = conversation(row.conversation_id, userId);
    const body = envelope(sealed, c, userId);
    db.prepare('UPDATE messages SET body=? WHERE id=?').run(JSON.stringify(body), id);
    const message = { ...decodeMessage(row), body };
    emitBoth(c, 'message:updated', message);
    return message;
  }
  function setSession(res, userId) {
    storage.freeSpace();
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(tokenHash(token), userId, Date.now() + settings.sessionMs);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token NOT IN (SELECT token FROM sessions WHERE user_id=? ORDER BY expires DESC,rowid DESC LIMIT 20)').run(userId, userId);
    for (const id of [...(io.sockets.adapter.rooms.get(`user:${userId}`) || [])]) { const socket = io.sockets.sockets.get(id); if (socket) validSocket(socket); }
    res.cookie('sembang', token, { httpOnly: true, sameSite: 'strict', secure: settings.cookieSecure, maxAge: settings.sessionMs, path: '/' });
  }
  const codeHash = (id, code) => createHmac('sha256', settings.authSecret).update(`${id}:${code}`).digest('hex');
  async function issueVerification(user) {
    if (verificationJobs >= 4) throw fail('Penghantaran emel sedang sibuk. Cuba sebentar lagi.', 503);
    limited(`email:${user.email}`, 6, 3600000);
    const id = randomUUID(), code = String(randomInt(100000, 1000000)), expires = Date.now() + 600000;
    db.prepare('INSERT INTO email_verifications (id,email,name,username,salt,password,color,code_hash,expires,existing_user_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, user.email, user.name, user.username, user.salt, user.password, user.color, codeHash(id, code), expires, user.existing_user_id || null);
    verificationJobs++;
    try { await (sendVerification || mailer.send)({ email: user.email, code }); }
    catch {
      db.prepare('DELETE FROM email_verifications WHERE id=?').run(id);
      throw fail('Emel pengesahan belum dapat dihantar. Cuba semula sebentar.', 503);
    } finally { verificationJobs--; }
    return { verificationRequired: true, requestId: id, expiresIn: 600 };
  }
  app.post('/api/verify-email', (req, res, next) => {
    try {
      limited(`verify:${ipKeyGenerator(req.ip)}`, 30, 15 * 60000);
      const { requestId, code } = req.body || {};
      if (typeof requestId !== 'string' || requestId.length > 50 || typeof code !== 'string' || !/^\d{6}$/.test(code)) throw fail('Masukkan kod pengesahan enam digit.');
      const pending = db.prepare('SELECT * FROM email_verifications WHERE id=?').get(requestId);
      if (!pending || pending.expires <= Date.now() || pending.attempts >= 5) throw fail('Kod sudah tamat atau terlalu banyak percubaan. Daftar atau log masuk semula.', 400);
      db.prepare('UPDATE email_verifications SET attempts=attempts+1 WHERE id=?').run(requestId);
      if (!timingSafeEqual(Buffer.from(pending.code_hash, 'hex'), Buffer.from(codeHash(requestId, code), 'hex'))) throw fail('Kod pengesahan tidak sepadan.');
      storage.freeSpace();
      let user;
      db.exec('BEGIN IMMEDIATE');
      try {
        if (pending.existing_user_id) {
          user = db.prepare('SELECT * FROM users WHERE id=? AND email=? AND password=?').get(pending.existing_user_id, pending.email, pending.password);
          if (!user) throw fail('Akaun telah berubah. Log masuk semula.', 409);
          db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(user.id);
        } else {
          if (db.prepare('SELECT id FROM users WHERE lower(email)=? OR username=?').get(pending.email, pending.username)) throw fail('Emel atau nama pengguna telah digunakan. Log masuk semula.', 409);
          user = { ...pending, id: randomUUID() };
          db.prepare('INSERT INTO users (id,username,name,salt,password,color,email,email_verified) VALUES (?,?,?,?,?,?,?,1)')
            .run(user.id, user.username, user.name, user.salt, user.password, user.color, user.email);
        }
        db.prepare('DELETE FROM email_verifications WHERE email=?').run(user.email);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      setSession(res, user.id); emitAll('users:changed'); res.status(201).json(accountUser(user));
    } catch (error) { next(error); }
  });
  app.post('/api/register', async (req, res, next) => {
    try {
      limited(`auth:${ipKeyGenerator(req.ip)}`, 30, 15 * 60000);
      if (!settings.registrationEnabled) throw fail('Pendaftaran baharu ditutup buat masa ini.', 403);
      storage.freeSpace();
      const { name, password, email: suppliedEmail } = req.body || {};
      const username = req.body?.username ?? `u_${randomBytes(10).toString('hex')}`;
      const email = normalizeEmail(suppliedEmail);
      if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 40) throw fail('Nama mesti 2–40 aksara.');
      if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,24}$/.test(username)) throw fail('Nama pengguna: 3–24 huruf, nombor atau _.');
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw fail('Kata laluan mesti 8–128 aksara.');
      const normalized = username.toLowerCase();
      if (db.prepare('SELECT id FROM users WHERE username=?').get(normalized)) throw fail('Nama pengguna ini telah digunakan.', 409);
      if (db.prepare('SELECT id FROM users WHERE lower(email)=?').get(email)) throw fail('Emel ini telah digunakan.', 409);
      const salt = randomBytes(16).toString('hex');
      const hash = (await passwordHash(password, salt)).toString('hex');
      const user = { id: randomUUID(), name: name.trim(), username: normalized, email, color: colors[Math.floor(Math.random() * colors.length)] };
      if (settings.requireEmailVerification) {
        return res.status(202).json(await issueVerification({ ...user, salt, password: hash }));
      }
      try { db.prepare('INSERT INTO users (id,username,name,salt,password,color,email) VALUES (?,?,?,?,?,?,?)').run(user.id, user.username, user.name, salt, hash, user.color, user.email); }
      catch (e) {
        if (e.code?.includes('SQLITE') && /UNIQUE constraint failed/i.test(e.message)) {
          if (db.prepare('SELECT id FROM users WHERE lower(email)=?').get(email)) throw fail('Emel ini telah digunakan.', 409);
          throw fail('Nama pengguna ini telah digunakan.', 409);
        }
        throw e;
      }
      setSession(res, user.id);
      emitAll('users:changed');
      res.status(201).json(accountUser(user));
    } catch (e) { next(e); }
  });
  app.post('/api/login', async (req, res, next) => {
    try {
      limited(`auth:${ipKeyGenerator(req.ip)}`, 30, 15 * 60000);
      const { email, password } = req.body || {};
      const username = email !== undefined ? normalizeEmail(email) : req.body?.username;
      if (typeof username !== 'string' || !username.trim() || username.length > 254 || typeof password !== 'string' || password.length > 128) throw fail('Butiran log masuk tidak sah.');
      const identifier = username.includes('@') ? normalizeEmail(username) : username.trim().toLowerCase();
      const user = db.prepare('SELECT * FROM users WHERE username=? OR lower(email)=?').get(identifier, identifier);
      const hash = await passwordHash(password, user?.salt || 'dummy-salt');
      if (!user || !timingSafeEqual(Buffer.from(user.password, 'hex'), hash)) throw fail('Emel atau kata laluan salah.', 401);
      if (settings.requireEmailVerification && !user.email_verified) {
        if (!user.email) throw fail('Akaun lama belum mempunyai emel. Hubungi pentadbir untuk menetapkan emel.', 403);
        return res.status(202).json(await issueVerification({ ...user, existing_user_id: user.id }));
      }
      setSession(res, user.id);
      res.json(accountUser(user));
    } catch (e) { next(e); }
  });
  app.post('/api/logout', auth, (req, res) => {
    const hash = tokenHash(cookieToken(req));
    db.prepare('DELETE FROM sessions WHERE token=?').run(hash);
    for (const s of io.sockets.sockets.values()) if (s.data.sessionHash === hash) s.disconnect(true);
    res.clearCookie('sembang', { path: '/' });
    res.json({ ok: true });
  });
  app.get('/api/health', (req, res) => res.json({ service: 'sembang', version: VERSION, status: 'ok' }));
  app.get('/api/ready', (req, res) => {
    try { db.prepare('SELECT 1').get(); storage.freeSpace(); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.get('/api/me', auth, (req, res) => res.json(accountUser(req.user)));
  app.get('/api/identity', auth, (req, res) => {
    const row = identity(req.user.id);
    res.json(row ? { ...publicIdentity(row), backup: JSON.parse(row.backup) } : null);
  });
  app.post('/api/identity', auth, (req, res, next) => {
    try {
      const { publicKey, fingerprint, backup } = req.body || {};
      if (identity(req.user.id)) throw fail('Kunci akaun telah ditetapkan. Gunakan kod pemulihan pada peranti baharu.', 409);
      if (!publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256' || publicKey.d || typeof publicKey.x !== 'string' || typeof publicKey.y !== 'string' || publicKey.x.length !== 43 || publicKey.y.length !== 43) throw fail('Kunci awam tidak sah.');
      const canonical = { kty: 'EC', crv: 'P-256', x: publicKey.x, y: publicKey.y };
      try { createPublicKey({ key: canonical, format: 'jwk' }); } catch { throw fail('Kunci awam tidak sah.'); }
      const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
      if (fingerprint !== hash || !backup || !base64(backup.iv, 16, 16) || !base64(backup.data, 24, 4000)) throw fail('Sandaran kunci tidak sah.');
      db.prepare('INSERT INTO identities VALUES (?,?,?,?)').run(req.user.id, JSON.stringify(canonical), hash, JSON.stringify({ iv: backup.iv, data: backup.data }));
      emitAll('identities:changed');
      res.status(201).json({ ok: true });
    } catch (e) { next(e); }
  });
  app.get('/api/conversations/:id/keys', auth, (req, res, next) => {
    try {
      const c = conversation(req.params.id, req.user.id);
      res.json({ peerId: peerId(c, req.user.id), self: publicIdentity(identity(req.user.id)), peer: publicIdentity(identity(peerId(c, req.user.id))) });
    } catch (e) { next(e); }
  });
  app.get('/api/config', auth, (req, res) => {
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    if (settings.turnUrls.length && settings.turnSecret) {
      const username = `${Math.floor(Date.now()/1000)+14400}:${req.user.id}`;
      const credential = createHmac('sha1', settings.turnSecret).update(username).digest('base64');
      iceServers.push({ urls: settings.turnUrls, username, credential });
    } else if (settings.turnUrls.length && settings.turnUsername && settings.turnCredential) {
      iceServers.push({ urls: settings.turnUrls, username: settings.turnUsername, credential: settings.turnCredential });
    }
    res.json({ iceServers });
  });
  app.get('/api/users', auth, (req, res) => {
    const q = String(req.query.q || '').slice(0, 40).toLowerCase();
    res.json(db.prepare('SELECT id,name,username,color FROM users WHERE id!=? AND (instr(lower(name),?)>0 OR instr(username,?)>0) ORDER BY name LIMIT 50').all(req.user.id, q, q).map(u => ({ ...u, online: presence.has(u.id) })));
  });
  app.get('/api/conversations', auth, (req, res) => {
    const cs = db.prepare('SELECT * FROM conversations WHERE a=? OR b=?').all(req.user.id, req.user.id);
    res.json(cs.map(c => {
      const peer = db.prepare('SELECT * FROM users WHERE id=?').get(peerId(c, req.user.id));
      const last = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created DESC,rowid DESC LIMIT 1').get(c.id);
      const unread = db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_id=? AND sender_id!=? AND read_at IS NULL').get(c.id, req.user.id).n;
      return { id: c.id, peer: { ...publicUser(peer), online: presence.has(peer.id) }, last: last ? decodeMessage(last) : null, unread, created: c.created };
    }).sort((a, b) => (b.last?.created || b.created) - (a.last?.created || a.created)));
  });
  app.post('/api/conversations', auth, (req, res, next) => {
    try {
      const id = req.body?.userId;
      if (typeof id !== 'string' || id === req.user.id || !db.prepare('SELECT id FROM users WHERE id=?').get(id)) throw fail('Pengguna tidak dijumpai.', 404);
      const [a, b] = [req.user.id, id].sort();
      let c = db.prepare('SELECT * FROM conversations WHERE a=? AND b=?').get(a, b);
      if (!c) {
        limited(`new-conversation:${req.user.id}`, 20, 60000);
        storage.freeSpace();
        if (db.prepare('SELECT count(*) AS n FROM conversations WHERE a=? OR b=?').get(req.user.id, req.user.id).n >= settings.maxConversations) throw fail('Had perbualan akaun telah dicapai.', 429);
        c = { id: randomUUID(), a, b, created: Date.now() }; db.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run(c.id, a, b, c.created); emitBoth(c, 'conversations:changed'); }
      res.json({ id: c.id });
    } catch (e) { next(e); }
  });
  app.get('/api/conversations/:id/messages', auth, (req, res, next) => {
    try {
      conversation(req.params.id, req.user.id);
      const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
      // A cursor is the last SQLite row id, not a timestamp: equal timestamps never skip messages.
      const rows = db.prepare('SELECT *,rowid AS cursor FROM messages WHERE conversation_id=? AND rowid<? ORDER BY rowid DESC LIMIT 51').all(req.params.id, before);
      const hasMore = rows.length > 50;
      const page = rows.slice(0, 50).reverse();
      res.json({ messages: page.map(decodeMessage), next: hasMore ? page[0].cursor : null });
    } catch (e) { next(e); }
  });
  app.post('/api/conversations/:id/read', auth, (req, res, next) => {
    try {
      const c = conversation(req.params.id, req.user.id);
      const at = Date.now();
      db.prepare('UPDATE messages SET read_at=? WHERE conversation_id=? AND sender_id!=? AND read_at IS NULL').run(at, c.id, req.user.id);
      emitBoth(c, 'messages:read', { conversationId: c.id, userId: req.user.id, at });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1, fieldNameSize: 32 } });
  app.post('/api/conversations/:id/images', auth, (req, res, next) => {
    try {
      req.conversation = conversation(req.params.id, req.user.id);
      limited(`upload:${req.user.id}`, 30, 60000);
      if (!identity(req.user.id) || !identity(peerId(req.conversation, req.user.id))) throw fail('Kunci penyulitan belum tersedia.', 409);
      const clientId = req.headers['x-message-id'];
      if (typeof clientId !== 'string' || !/^[A-Za-z0-9:_-]{1,100}$/.test(clientId)) throw fail('ID mesej gambar diperlukan. Muat semula aplikasi.');
      req.uploadClientId = clientId;
      const release = storage.reserve(req.user.id);
      res.once('finish', release); res.once('close', release);
      next();
    } catch (error) { next(error); }
  }, upload.single('image'), (req, res, next) => {
    let filename;
    try {
      if (!req.file || req.file.mimetype !== 'application/octet-stream' || req.file.buffer.length < 17) throw fail('Gambar mesti dimampatkan dan disulitkan sebelum dihantar.');
      if (req.aborted || res.destroyed) throw fail('Muat naik dibatalkan.');
      const id = randomUUID(); filename = `${id}.bin`;
      writeFileSync(path.join(dataDir, 'uploads', filename), req.file.buffer, { flag: 'wx', mode: 0o600 });
      db.prepare('INSERT INTO media (id,conversation_id,filename,mime,owner_id,bytes,created_at,committed,client_id) VALUES (?,?,?,?,?,?,?,0,?)')
        .run(id, req.conversation.id, filename, 'application/octet-stream', req.user.id, req.file.buffer.length, Date.now(), req.uploadClientId);
      storage.added(req.file.buffer.length);
      res.status(201).json({ url: `/media/${id}` });
    } catch (error) { if (filename) { try { unlinkSync(path.join(dataDir, 'uploads', filename)); } catch {} } next(error); }
  });
  app.post('/api/locations/stop', auth, (req, res, next) => {
    try {
      const updates = req.body?.updates;
      if (!Array.isArray(updates) || updates.length > 50) throw fail('Senarai kemas kini tidak sah.');
      // Validate the whole batch before changing anything; the server cannot read coordinates.
      for (const u of updates) {
        if (!u || typeof u.id !== 'string') throw fail('ID mesej tidak sah.');
        const row = db.prepare("SELECT * FROM messages WHERE id=? AND sender_id=? AND kind='encrypted'").get(u.id, req.user.id);
        if (!row) throw fail('Mesej tidak dijumpai.', 404);
        envelope(u.envelope, conversation(row.conversation_id, req.user.id), req.user.id);
      }
      for (const u of updates) updateEncrypted(u.id, req.user.id, u.envelope);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  app.get('/media/:id', auth, (req, res, next) => {
    try {
      const media = db.prepare('SELECT * FROM media WHERE id=? AND committed=1').get(req.params.id);
      if (!media) throw fail('Gambar tidak dijumpai.', 404);
      conversation(media.conversation_id, req.user.id);
      res.type(media.mime).sendFile(path.join(dataDir, 'uploads', media.filename));
    } catch (e) { next(e); }
  });
  io.use((socket, next) => {
    const u = sessionUser(socket.request);
    if (!u) return next(new Error('Sila log masuk.'));
    socket.data.user = publicUser(u);
    socket.data.sessionHash = tokenHash(cookieToken(socket.request));
    socket.data.sessionExpires = u.session_expires;
    const userSockets = io.sockets.adapter.rooms.get(`user:${u.id}`)?.size || 0;
    if (userSockets >= 5 || io.sockets.sockets.size >= 1000) return next(new Error('Had sambungan telah dicapai.'));
    next();
  });
  function endCall(call, reason) {
    clearTimeout(call.timer);
    calls.delete(call.id);
    emitUser(call.from, 'call:ended', { id: call.id, reason }); emitUser(call.to, 'call:ended', { id: call.id, reason });
  }
  io.on('connection', socket => {
    const u = socket.data.user;
    socket.join(`user:${u.id}`);
    if (!presence.has(u.id)) presence.set(u.id, new Set());
    presence.get(u.id).add(socket.id);
    const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.sessionExpires-Date.now()));
    expiryTimer.unref();
    emitAll('presence', { userId: u.id, online: true });
    socket.use((packet, next) => {
      const valid = db.prepare('SELECT 1 FROM sessions WHERE token=? AND expires>?').get(socket.data.sessionHash, Date.now());
      if (!valid) { next(new Error('Sesi tamat.')); socket.disconnect(true); } else next();
    });
    const handle = (name, fn) => socket.on(name, async (data, ack) => {
      try {
        limited(`socket:${u.id}`, 240, 60000);
        if (!data || typeof data !== 'object') throw fail('Permintaan tidak sah.');
        const result = await fn(data);
        if (typeof ack === 'function') ack({ ok: true, ...result });
      } catch (e) { if (typeof ack === 'function') ack({ ok: false, error: e.status ? e.message : 'Permintaan gagal. Cuba lagi.' }); }
    });
    handle('message:send', d => {
      const c = conversation(d.conversationId, u.id);
      if (typeof d.clientId !== 'string' || d.clientId.length > 100 || !d.clientId) throw fail('ID mesej tidak sah.');
      return { message: insertMessage(c, u.id, 'encrypted', envelope(d.envelope, c, u.id), d.clientId, d.mediaId) };
    });
    handle('message:update', d => ({ message: updateEncrypted(d.messageId, u.id, d.envelope) }));
    handle('typing', d => {
      const c = conversation(d.conversationId, u.id);
      emitUser(peerId(c, u.id), 'typing', { conversationId: c.id, userId: u.id, active: !!d.active });
    });
    handle('call:start', d => {
      const c = conversation(d.conversationId, u.id);
      const to = peerId(c, u.id);
      if (!identity(u.id) || !identity(to)) throw fail('Kunci penyulitan panggilan belum tersedia.');
      if (!presence.has(to)) throw fail('Pengguna sedang luar talian.');
      if ([...calls.values()].some(x => [x.from, x.to].some(id => id === u.id || id === to))) throw fail('Pengguna sedang dalam panggilan.');
      const call = { id: randomUUID(), conversationId: c.id, from: u.id, to, fromSocket: socket.id, toSocket: null, video: !!d.video, state: 'ringing' };
      call.timer = setTimeout(() => { if (calls.has(call.id)) endCall(call, 'Tiada jawapan'); }, 30000);
      calls.set(call.id, call);
      emitUser(to, 'call:incoming', { id: call.id, conversationId: c.id, from: u, video: call.video });
      return { id: call.id };
    });
    handle('call:accept', d => {
      const call = calls.get(d.id);
      if (!call || call.to !== u.id || call.state !== 'ringing') throw fail('Panggilan sudah tamat.');
      clearTimeout(call.timer);
      call.state = 'active'; call.toSocket = socket.id;
      call.timer = setTimeout(() => endCall(call, 'Panggilan tamat'), 4 * 60 * 60 * 1000);
      emitUser(u.id, 'call:handled', { id: call.id }, socket.id);
      emitSocket(call.fromSocket, 'call:accepted', { id: call.id });
    });
    handle('call:signal', d => {
      const call = calls.get(d.id);
      if (!call || call.state !== 'active' || ![call.fromSocket, call.toSocket].includes(socket.id)) throw fail('Panggilan tidak sah.');
      if (typeof d.clientId !== 'string' || !d.clientId.startsWith(`${call.id}:`) || d.clientId.length > 100) throw fail('Isyarat panggilan tidak sah.');
      const body = envelope(d.envelope, conversation(call.conversationId, u.id), u.id);
      emitSocket(socket.id === call.fromSocket ? call.toSocket : call.fromSocket, 'call:signal', { id: call.id, clientId: d.clientId, senderId: u.id, envelope: body });
    });
    handle('call:end', d => {
      const call = calls.get(d.id);
      if (call && [call.from, call.to].includes(u.id)) endCall(call, call.state === 'ringing' ? (call.to === u.id ? 'Panggilan ditolak' : 'Panggilan dibatalkan') : 'Panggilan tamat');
    });
    socket.on('disconnect', () => {
      clearTimeout(expiryTimer);
      presence.get(u.id)?.delete(socket.id);
      if (!presence.get(u.id)?.size) { presence.delete(u.id); emitAll('presence', { userId: u.id, online: false }); }
      for (const c of calls.values()) if (c.fromSocket === socket.id || c.toSocket === socket.id || (c.to === u.id && !presence.has(u.id))) endCall(c, 'Sambungan terputus');
    });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak dijumpai.' }));
  app.use(express.static(path.join(root, 'public')));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Gambar termampat maksimum ialah 2 MB.' });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Muat naik tidak sah.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Permintaan terlalu besar.' });
    if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'Format permintaan tidak sah.' });
    if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    if (!err.status) console.error(JSON.stringify({ event: 'request_error', id: req.requestId, code: err.code || err.name }));
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Ralat pelayan. Cuba lagi.' });
  });
  const close = () => closePromise ??= (async () => {
    closing = true; clearInterval(cleanup);
    for (const call of calls.values()) clearTimeout(call.timer);
    await new Promise(resolve => io.close(resolve));
    http.closeIdleConnections();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); mailer.close();
  })();
  return { app, http, io, db, close, maintenance, settings };

}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const instance = createApp();
  const { port, host } = instance.settings;
  instance.http.listen(port, host, () => console.log(JSON.stringify({ event: 'listening', version: VERSION, host, port })));
  instance.http.on('error', error => { console.error(JSON.stringify({ event: 'server_error', code: error.code })); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    const deadline = setTimeout(() => process.exit(1), 20000); deadline.unref();
    try { await instance.close(); clearTimeout(deadline); process.exit(0); }
    catch (error) { console.error(JSON.stringify({ event: 'shutdown_error', code: error.code || error.name })); process.exit(1); }
  });
}
