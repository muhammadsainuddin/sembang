import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import multer from 'multer';
import webpush from 'web-push';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash, createPublicKey, createHmac, randomInt, sign as signData } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, unlinkSync, chmodSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, domainToASCII } from 'node:url';
import proxyaddr from 'proxy-addr';
import { ipKeyGenerator } from 'express-rate-limit';
import { loadConfig } from './lib/config.js';
import { verificationMailer } from './lib/mailer.js';
import { mediaStorage, MAX_UPLOAD_BYTES } from './lib/storage.js';

const scrypt = promisify(scryptCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.11.0';
const colors = ['#dacaf0', '#d5c9f2', '#e5c9ed', '#f1cee3', '#cbd6f3', '#e4d1ec'];
const publicUser = u => ({ id: u.id, name: u.name, username: u.username, color: u.color, avatar: u.avatar ? `/avatars/${u.id}?v=${encodeURIComponent(u.avatar)}` : null, lastSeen: u.last_seen || null });
const userProfile = u => { try { const value = JSON.parse(u.profile || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } };
const profileUser = u => ({ ...publicUser(u), profile: userProfile(u) });
const accountUser = u => ({ ...profileUser(u), email: u.email ?? null, role: u.role || 'member', activated: !!u.activated });
function normalizeEmail(value) {
  if (typeof value !== 'string') throw fail('Email is required for registration.');
  const raw = value.trim();
  if (raw.length > 254) throw fail('Email addresses can be at most 254 characters.');
  const parts = raw.split('@');
  if (parts.length !== 2) throw fail('Enter a valid email address.');
  const local = parts[0], domain = domainToASCII(parts[1].toLowerCase());
  const labels = domain.split('.');
  if (!local || local.length > 64 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) || !/^[a-z][a-z0-9-]{1,62}$/i.test(labels.at(-1))) throw fail('Enter a valid email address.');
  const email = local.toLowerCase() + '@' + domain.toLowerCase();
  if (email.length > 254) throw fail('Email addresses can be at most 254 characters.');
  return email;
}
const tokenHash = t => createHash('sha256').update(t).digest('hex');
const cookieToken = req => /(?:^|;\s*)sembang=([^;]+)/.exec(req.headers.cookie || '')?.[1];
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const base64url = value => Buffer.from(value).toString('base64url');
function firebaseSender(serviceAccount) {
  if (!serviceAccount || typeof serviceAccount.project_id !== 'string' || typeof serviceAccount.client_email !== 'string' || typeof serviceAccount.private_key !== 'string') throw new Error('The Firebase service account is invalid.');
  let accessToken = '', tokenExpires = 0;
  return async message => {
    if (!accessToken || tokenExpires < Date.now() + 60000) {
      const now = Math.floor(Date.now() / 1000);
      const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iss: serviceAccount.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))}`;
      const assertion = `${unsigned}.${signData('RSA-SHA256', Buffer.from(unsigned), serviceAccount.private_key).toString('base64url')}`;
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), signal: AbortSignal.timeout(10000) });
      const tokenBody = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || typeof tokenBody.access_token !== 'string') throw Object.assign(new Error('Firebase authentication failed.'), { code: `firebase/auth-${tokenResponse.status}` });
      accessToken = tokenBody.access_token; tokenExpires = Date.now() + Math.max(60, Number(tokenBody.expires_in) || 3600) * 1000;
    }
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(serviceAccount.project_id)}/messages:send`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message }), signal: AbortSignal.timeout(10000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const fcmCode = body?.error?.details?.find(detail => detail.errorCode)?.errorCode;
      const code = fcmCode === 'UNREGISTERED' ? 'messaging/registration-token-not-registered' : fcmCode === 'INVALID_ARGUMENT' ? 'messaging/invalid-registration-token' : `firebase/send-${response.status}`;
      throw Object.assign(new Error('Firebase delivery failed.'), { code });
    }
    return body.name;
  };
}

export function createApp({ dataDir = process.env.DATA_DIR || path.join(root, 'data'), config = {}, sendVerification, sendPush, sendNativePush } = {}) {
  dataDir = path.resolve(dataDir);
  if (dataDir === path.parse(dataDir).root) throw new Error('DATA_DIR cannot be the filesystem root.');
  const settings = { ...loadConfig(), ...config };
  let nativePush = sendNativePush || null;
  if (!nativePush && (settings.firebaseServiceAccountFile || settings.firebaseServiceAccountBase64)) {
    const source = settings.firebaseServiceAccountBase64
      ? Buffer.from(settings.firebaseServiceAccountBase64, 'base64').toString('utf8')
      : readFileSync(path.resolve(settings.firebaseServiceAccountFile), 'utf8');
    nativePush = firebaseSender(JSON.parse(source));
  }
  const mailer = verificationMailer(settings);
  let closing = false, closePromise;
  let authJobs = 0, verificationJobs = 0;
  async function passwordHash(password, salt) {
    if (authJobs >= 4) throw Object.assign(fail('The server is busy. Try again shortly.', 503), { retryAfter: 2 });
    authJobs++;
    try { return await scrypt(password, salt, 64); } finally { authJobs--; }
  }
  mkdirSync(path.join(dataDir, 'uploads'), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, 'avatars'), { recursive: true, mode: 0o700 });
  if (settings.production) { chmodSync(dataDir, 0o700); chmodSync(path.join(dataDir, 'uploads'), 0o700); chmodSync(path.join(dataDir, 'avatars'), 0o700); }
  const vapidFile = path.join(dataDir, 'push-vapid.json');
  let vapidKeys;
  try { vapidKeys = JSON.parse(readFileSync(vapidFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    vapidKeys = webpush.generateVAPIDKeys();
    writeFileSync(vapidFile, JSON.stringify(vapidKeys), { flag: 'wx', mode: 0o600 });
  }
  if (!vapidKeys || !/^[A-Za-z0-9_-]{80,100}$/.test(vapidKeys.publicKey || '') || !/^[A-Za-z0-9_-]{40,60}$/.test(vapidKeys.privateKey || '')) throw new Error('The Web Push keys in data/push-vapid.json are invalid.');
  if (settings.production) chmodSync(vapidFile, 0o600);
  const db = new DatabaseSync(path.join(dataDir, 'sembang.sqlite'));
  if (settings.production) chmodSync(path.join(dataDir, 'sembang.sqlite'), 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL, color TEXT NOT NULL, email TEXT,
      role TEXT NOT NULL DEFAULT 'member', activated INTEGER NOT NULL DEFAULT 0, activated_at INTEGER, activated_by TEXT, profile TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, a TEXT REFERENCES users(id), b TEXT REFERENCES users(id), created INTEGER NOT NULL, UNIQUE(a,b));
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id), sender_id TEXT REFERENCES users(id), kind TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, read_at INTEGER, client_id TEXT, delivered_at INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS message_retry ON messages(sender_id,client_id) WHERE client_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS message_history ON messages(conversation_id,created);
    CREATE TABLE IF NOT EXISTS identities (user_id TEXT PRIMARY KEY REFERENCES users(id), public_key TEXT NOT NULL, fingerprint TEXT NOT NULL, backup TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id), filename TEXT NOT NULL, mime TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS saved_places (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), creator_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, client_id TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(creator_id,client_id));
    CREATE INDEX IF NOT EXISTS saved_places_conversation ON saved_places(conversation_id,created);
  `);
  // Additive migration preserves accounts, sessions, keys and chat from older installations.
  const originalUserColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  if (!originalUserColumns.has('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  if (!originalUserColumns.has('avatar')) db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
  if (!originalUserColumns.has('last_seen')) db.exec('ALTER TABLE users ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0');
  if (!originalUserColumns.has('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
  const addedActivation = !originalUserColumns.has('activated');
  if (addedActivation) db.exec('ALTER TABLE users ADD COLUMN activated INTEGER NOT NULL DEFAULT 0');
  if (!originalUserColumns.has('activated_at')) db.exec('ALTER TABLE users ADD COLUMN activated_at INTEGER');
  if (!originalUserColumns.has('activated_by')) db.exec('ALTER TABLE users ADD COLUMN activated_by TEXT');
  if (!originalUserColumns.has('profile')) db.exec("ALTER TABLE users ADD COLUMN profile TEXT NOT NULL DEFAULT '{}'");
  if (addedActivation) db.exec('UPDATE users SET activated=1,activated_at=coalesce(activated_at,0)');
  if (db.prepare('SELECT count(*) AS n FROM users').get().n && !db.prepare("SELECT 1 FROM users WHERE role='owner'").get()) {
    const first = db.prepare('SELECT id FROM users ORDER BY rowid LIMIT 1').get();
    db.prepare("UPDATE users SET role='owner',activated=1 WHERE id=?").run(first.id);
  }
  if (!db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'delivered_at')) db.exec('ALTER TABLE messages ADD COLUMN delivered_at INTEGER');
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
    CREATE INDEX IF NOT EXISTS verification_expiry ON email_verifications(expires);
    CREATE TABLE IF NOT EXISTS password_resets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), email TEXT NOT NULL,
      code_hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS password_reset_expiry ON password_resets(expires);
    CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions(user_id);
    CREATE TABLE IF NOT EXISTS push_devices (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), platform TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS push_device_user ON push_devices(user_id);`);
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
    const mapOrigin = new URL(settings.mapStyleUrl).origin;
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: ${mapOrigin}; media-src 'self' blob:; connect-src 'self' ${socketOrigin} ${mapOrigin}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`);
    if (settings.production) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      const start = Date.now();
      res.on('finish', () => {
        if (req.path === '/api/health' || req.path === '/api/ready') return;
        console.log(JSON.stringify({ event: 'http', id: req.requestId, method: req.method, route: req.route?.path || '/asset', status: res.statusCode, ms: Date.now() - start }));
      });
      if (!req.secure && !['/api/health', '/api/ready'].includes(req.path)) return res.status(426).json({ error: 'An HTTPS connection is required.' });
    }
    if (req.path.startsWith('/api') || req.path.startsWith('/media') || req.path.startsWith('/avatars')) res.setHeader('Cache-Control', 'no-store');
    if (closing) return res.status(503).json({ error: 'The server is restarting.' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !allowedOrigin(req)) return res.status(403).json({ error: 'The request origin is not allowed.' });
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
    return user && user.activated && (!settings.requireEmailVerification || user.email_verified) ? user : null;
  };
  const auth = (req, res, next) => {
    req.user = sessionUser(req);
    if (!req.user) return res.status(401).json({ error: 'Please sign in again.' });
    next();
  };
  const ownerOnly = (req, res, next) => req.user.role === 'owner' ? next() : res.status(403).json({ error: 'Owner access is required.' });
  const io = new Server(http, { maxHttpBufferSize: 64000, allowRequest: (req, cb) => cb(null, allowedOrigin(req)) });
  io.engine.use((req, res, next) => {
    try {
      if (closing || !allowedOrigin(req)) throw fail('The connection is not allowed.', 403);
      const secure = req.socket.encrypted || (trustProxy(req.socket.remoteAddress, 0) && req.headers['x-forwarded-proto'] === 'https');
      if (settings.production && !secure) throw fail('HTTPS is required.', 403);
      if (!req._query?.sid) {
        limited(`connection:${ipKeyGenerator(proxyaddr(req, trustProxy))}`, 30, 60000);
        if (io.engine.clientsCount >= 1000) throw fail('The connection limit has been reached.', 503);
      }
      next();
    } catch (error) { next(error); }
  });
  const presence = new Map();
  const calls = new Map();
  function limited(key, count, windowMs) {
    const now = Date.now(), hashed = tokenHash(key);
    if (db.prepare('SELECT count(*) AS n FROM rate_limits').get().n > 100000) throw fail('The server is busy. Try again shortly.', 503);
    const row = db.prepare(`INSERT INTO rate_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET
      n=CASE WHEN expires<=? THEN 1 ELSE n+1 END, expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END
      RETURNING n,expires`).get(hashed, now + windowMs, now, now);
    if (row.n > count) throw Object.assign(fail('Too many requests. Try again shortly.', 429), { retryAfter: Math.max(1, Math.ceil((row.expires-now)/1000)) });
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
    db.prepare('DELETE FROM password_resets WHERE expires<=?').run(now);
    storage.cleanup(now);
    for (const socket of [...io.sockets.sockets.values()]) validSocket(socket);
  };
  const cleanup = setInterval(() => { try { maintenance(); } catch (error) { console.error(JSON.stringify({ event: 'maintenance_error', code: error.code || error.name })); } }, 60000);
  cleanup.unref();
  function conversation(id, userId) {
    const c = db.prepare('SELECT * FROM conversations WHERE id=? AND (a=? OR b=?)').get(id, userId, userId);
    if (!c) throw fail('Chat not found.', 404);
    return c;
  }
  const peerId = (c, id) => c.a === id ? c.b : c.a;
  const emitBoth = (c, event, payload) => { emitUser(c.a, event, payload); emitUser(c.b, event, payload); };
  const decodeMessage = m => ({ id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, kind: m.kind, body: JSON.parse(m.body), created: m.created, deliveredAt: m.delivered_at, readAt: m.read_at, clientId: m.client_id });
  const sendPushNotification = sendPush || ((subscription, payload) => webpush.sendNotification(subscription, payload, {
    vapidDetails: { subject: settings.vapidSubject, publicKey: vapidKeys.publicKey, privateKey: vapidKeys.privateKey },
    TTL: 86400, urgency: 'high', timeout: 10000,
  }));
  function notifyMessage(userId, sender, conversationId) {
    const rows = db.prepare('SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=? LIMIT 10').all(userId);
    const created = Date.now(), data = { title: `${sender.name} · Zbuddy`, body: 'New message', conversationId, url: `/?conversation=${encodeURIComponent(conversationId)}`, created };
    const payload = JSON.stringify(data);
    for (const row of rows) Promise.resolve().then(() => sendPushNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload))
      .catch(error => {
        if ([404, 410].includes(error?.statusCode) && !closing) db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(row.endpoint);
        else console.error(JSON.stringify({ event: 'push_error', code: error?.statusCode || error?.code || error?.name }));
      });
    if (nativePush) for (const row of db.prepare("SELECT token FROM push_devices WHERE user_id=? AND platform='android' LIMIT 10").all(userId)) {
      Promise.resolve().then(() => nativePush({ token: row.token, data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)])), android: { priority: 'high' } }))
        .catch(error => {
          if (['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(error?.code) && !closing) db.prepare('DELETE FROM push_devices WHERE token=?').run(row.token);
          else console.error(JSON.stringify({ event: 'native_push_error', code: error?.code || error?.name }));
        });
    }
  }
  function insertMessage(c, sender, kind, body, clientId = null, mediaId) {
    if (clientId) {
      const old = db.prepare('SELECT * FROM messages WHERE sender_id=? AND client_id=?').get(sender, clientId);
      if (old) {
        if (old.conversation_id !== c.id) throw fail('This message ID has already been used.');
        return decodeMessage(old);
      }
    }
    storage.freeSpace();
    if (db.prepare('SELECT count(*) AS n FROM messages WHERE sender_id=?').get(sender).n >= settings.maxUserMessages || db.prepare('SELECT count(*) AS n FROM messages').get().n >= settings.maxTotalMessages) throw fail('The message quota is full.', 507);
    let media;
    if (mediaId !== undefined) {
      if (typeof mediaId !== 'string') throw fail('Invalid image ID.');
      media = db.prepare('SELECT * FROM media WHERE id=? AND owner_id=? AND conversation_id=? AND client_id=? AND committed=0 AND created_at>?').get(mediaId, sender, c.id, clientId, Date.now()-settings.pendingUploadMs);
      if (!media) throw fail('The image upload does not match or has expired.');
    }
    const m = { id: randomUUID(), conversationId: c.id, senderId: sender, kind, body, created: Date.now(), deliveredAt: null, readAt: null, clientId };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO messages (id,conversation_id,sender_id,kind,body,created,read_at,client_id,delivered_at) VALUES (?,?,?,?,?,?,?,?,?)').run(m.id, c.id, sender, kind, JSON.stringify(body), m.created, null, clientId, null);
      if (media) db.prepare('UPDATE media SET committed=1 WHERE id=?').run(media.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    emitBoth(c, 'message', m);
    notifyMessage(peerId(c, sender), publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(sender)), c.id);
    return m;
  }
  const identity = id => db.prepare('SELECT * FROM identities WHERE user_id=?').get(id);
  const publicIdentity = row => row ? { publicKey: JSON.parse(row.public_key), fingerprint: row.fingerprint } : null;
  const base64 = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
  function vaultBackup(value) {
    if (!value || value.v !== 2 || value.kdf !== 'PBKDF2-SHA-256' || value.iterations !== 600000 || !base64(value.salt, 24, 24) || !base64(value.iv, 16, 16) || !base64(value.data, 24, 4000)) throw fail('Invalid key backup.');
    return { v: 2, kdf: value.kdf, iterations: value.iterations, salt: value.salt, iv: value.iv, data: value.data };
  }
  function envelope(body, c, senderId) {
    const sender = identity(senderId), recipient = identity(peerId(c, senderId));
    if (!sender || !recipient) throw fail('Both users must create their encryption keys first.', 409);
    if (!body || body.v !== 1 || body.senderKey !== sender.fingerprint || body.recipientKey !== recipient.fingerprint || !base64(body.iv, 16, 16) || !base64(body.data, 24, 50000)) throw fail('Messages must be end-to-end encrypted.');
    return { v: 1, senderKey: body.senderKey, recipientKey: body.recipientKey, iv: body.iv, data: body.data };
  }
  function updateEncrypted(id, userId, sealed) {
    if (typeof id !== 'string') throw fail('Invalid message ID.');
    const row = db.prepare("SELECT * FROM messages WHERE id=? AND sender_id=? AND kind='encrypted'").get(id, userId);
    if (!row) throw fail('Message not found.', 404);
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
    db.prepare(`DELETE FROM sessions WHERE user_id=? AND token NOT IN
      (SELECT token FROM sessions WHERE user_id=? ORDER BY expires DESC,rowid DESC LIMIT ?)`)
      .run(userId, userId, settings.maxActiveSessions);
    for (const id of [...(io.sockets.adapter.rooms.get(`user:${userId}`) || [])]) { const socket = io.sockets.sockets.get(id); if (socket) validSocket(socket); }
    res.cookie('sembang', token, { httpOnly: true, sameSite: 'strict', secure: settings.cookieSecure, maxAge: settings.sessionMs, path: '/' });
  }
  const codeHash = (id, code) => createHmac('sha256', settings.authSecret).update(`${id}:${code}`).digest('hex');
  async function issueVerification(user) {
    if (verificationJobs >= 4) throw fail('Email delivery is busy. Try again shortly.', 503);
    limited(`email:${user.email}`, 6, 3600000);
    const id = randomUUID(), code = String(randomInt(100000, 1000000)), expires = Date.now() + 600000;
    db.prepare('INSERT INTO email_verifications (id,email,name,username,salt,password,color,code_hash,expires,existing_user_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, user.email, user.name, user.username, user.salt, user.password, user.color, codeHash(id, code), expires, user.existing_user_id || null);
    verificationJobs++;
    try { await (sendVerification || mailer.send)({ email: user.email, code, purpose: 'verify' }); }
    catch {
      db.prepare('DELETE FROM email_verifications WHERE id=?').run(id);
      throw fail('The verification email could not be sent. Try again shortly.', 503);
    } finally { verificationJobs--; }
    return { verificationRequired: true, requestId: id, expiresIn: 600 };
  }
  app.post('/api/verify-email', (req, res, next) => {
    try {
      limited(`verify:${ipKeyGenerator(req.ip)}`, 30, 15 * 60000);
      const { requestId, code } = req.body || {};
      if (typeof requestId !== 'string' || requestId.length > 50 || typeof code !== 'string' || !/^\d{6}$/.test(code)) throw fail('Enter the six-digit verification code.');
      const pending = db.prepare('SELECT * FROM email_verifications WHERE id=?').get(requestId);
      if (!pending || pending.expires <= Date.now() || pending.attempts >= 5) throw fail('The code expired or had too many attempts. Register or sign in again.', 400);
      db.prepare('UPDATE email_verifications SET attempts=attempts+1 WHERE id=?').run(requestId);
      if (!timingSafeEqual(Buffer.from(pending.code_hash, 'hex'), Buffer.from(codeHash(requestId, code), 'hex'))) throw fail('The verification code does not match.');
      storage.freeSpace();
      let user;
      db.exec('BEGIN IMMEDIATE');
      try {
        if (pending.existing_user_id) {
          user = db.prepare('SELECT * FROM users WHERE id=? AND email=? AND password=?').get(pending.existing_user_id, pending.email, pending.password);
          if (!user) throw fail('The account changed. Sign in again.', 409);
          db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(user.id);
        } else {
          if (db.prepare('SELECT id FROM users WHERE lower(email)=? OR username=?').get(pending.email, pending.username)) throw fail('The email or username is already in use. Sign in again.', 409);
          const userCount = db.prepare('SELECT count(*) AS n FROM users').get().n;
          if (userCount >= settings.maxUsers) throw fail('This Zbuddy server has reached its account limit.', 403);
          const firstOwner = userCount === 0, activated = firstOwner || !settings.accountApprovalRequired;
          user = { ...pending, id: randomUUID(), role: firstOwner ? 'owner' : 'member', activated: activated ? 1 : 0 };
          db.prepare(`INSERT INTO users (id,username,name,salt,password,color,email,email_verified,role,activated,activated_at)
            VALUES (?,?,?,?,?,?,?,1,?,?,?)`)
            .run(user.id, user.username, user.name, user.salt, user.password, user.color, user.email, user.role, user.activated, activated ? Date.now() : null);
        }
        db.prepare('DELETE FROM email_verifications WHERE email=?').run(user.email);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
      emitAll('users:changed');
      if (!user.activated) return res.status(202).json({ activationRequired: true, message: 'Email verified. Your account is waiting for Owner approval.' });
      setSession(res, user.id); res.status(201).json(accountUser(user));
    } catch (error) { next(error); }
  });
  app.post('/api/register', async (req, res, next) => {
    try {
      limited(`auth:${ipKeyGenerator(req.ip)}`, 30, 15 * 60000);
      if (!settings.registrationEnabled) throw fail('New registration is currently closed.', 403);
      if (db.prepare('SELECT count(*) AS n FROM users').get().n >= settings.maxUsers) throw fail('This Zbuddy server has reached its account limit.', 403);
      storage.freeSpace();
      const { name, password, email: suppliedEmail } = req.body || {};
      const username = req.body?.username ?? `u_${randomBytes(10).toString('hex')}`;
      const email = normalizeEmail(suppliedEmail);
      if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 40) throw fail('Name must be 2–40 characters.');
      if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,24}$/.test(username)) throw fail('Username must be 3–24 letters, numbers, or underscores.');
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw fail('Password must be 8–128 characters.');
      const normalized = username.toLowerCase();
      if (db.prepare('SELECT id FROM users WHERE username=?').get(normalized)) throw fail('This username is already in use.', 409);
      if (db.prepare('SELECT id FROM users WHERE lower(email)=?').get(email)) throw fail('This email is already in use.', 409);
      const salt = randomBytes(16).toString('hex');
      const hash = (await passwordHash(password, salt)).toString('hex');
      const user = { id: randomUUID(), name: name.trim(), username: normalized, email, color: colors[Math.floor(Math.random() * colors.length)] };
      if (settings.requireEmailVerification) {
        return res.status(202).json(await issueVerification({ ...user, salt, password: hash }));
      }
      try {
        db.exec('BEGIN IMMEDIATE');
        const userCount = db.prepare('SELECT count(*) AS n FROM users').get().n;
        if (userCount >= settings.maxUsers) throw fail('This Zbuddy server has reached its account limit.', 403);
        const firstOwner = userCount === 0, activated = firstOwner || !settings.accountApprovalRequired;
        user.role = firstOwner ? 'owner' : 'member'; user.activated = activated ? 1 : 0;
        db.prepare(`INSERT INTO users (id,username,name,salt,password,color,email,role,activated,activated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(user.id, user.username, user.name, salt, hash, user.color, user.email, user.role, user.activated, activated ? Date.now() : null);
        db.exec('COMMIT');
      }
      catch (e) {
        db.exec('ROLLBACK');
        if (e.code?.includes('SQLITE') && /UNIQUE constraint failed/i.test(e.message)) {
          if (db.prepare('SELECT id FROM users WHERE lower(email)=?').get(email)) throw fail('This email is already in use.', 409);
          throw fail('This username is already in use.', 409);
        }
        throw e;
      }
      emitAll('users:changed');
      if (!user.activated) return res.status(202).json({ activationRequired: true, message: 'Registration complete. Your account is waiting for Owner approval.' });
      setSession(res, user.id);
      res.status(201).json(accountUser(user));
    } catch (e) { next(e); }
  });
  app.post('/api/login', async (req, res, next) => {
    try {
      limited(`auth:${ipKeyGenerator(req.ip)}`, 30, 15 * 60000);
      const { email, password } = req.body || {};
      const username = email !== undefined ? normalizeEmail(email) : req.body?.username;
      if (typeof username !== 'string' || !username.trim() || username.length > 254 || typeof password !== 'string' || password.length > 128) throw fail('Invalid sign-in details.');
      const identifier = username.includes('@') ? normalizeEmail(username) : username.trim().toLowerCase();
      const user = db.prepare('SELECT * FROM users WHERE username=? OR lower(email)=?').get(identifier, identifier);
      const hash = await passwordHash(password, user?.salt || 'dummy-salt');
      if (!user || !timingSafeEqual(Buffer.from(user.password, 'hex'), hash)) throw fail('Incorrect email or password.', 401);
      if (settings.requireEmailVerification && !user.email_verified) {
        if (!user.email) throw fail('This legacy account has no email. Ask the administrator to add one.', 403);
        return res.status(202).json(await issueVerification({ ...user, existing_user_id: user.id }));
      }
      if (!user.activated) throw fail('Your account is waiting for Owner approval.', 403);
      setSession(res, user.id);
      res.json(accountUser(user));
    } catch (e) { next(e); }
  });
  app.get('/api/auth/config', (req, res) => {
    const users = db.prepare('SELECT count(*) AS n FROM users').get().n;
    res.json({ registrationOpen: settings.registrationEnabled && users < settings.maxUsers, maxUsers: settings.maxUsers, approvalRequired: settings.accountApprovalRequired });
  });
  app.post('/api/password/reset/request', async (req, res, next) => {
    try {
      limited(`reset:${ipKeyGenerator(req.ip)}`, 10, 3600000);
      const email = normalizeEmail(req.body?.email);
      limited(`reset-email:${email}`, 4, 3600000);
      const id = randomUUID(), user = settings.requireEmailVerification
        ? db.prepare('SELECT * FROM users WHERE lower(email)=? AND email_verified=1').get(email)
        : db.prepare('SELECT * FROM users WHERE lower(email)=?').get(email);
      if (user) {
        const code = String(randomInt(100000, 1000000)), expires = Date.now() + 600000;
        db.prepare('DELETE FROM password_resets WHERE user_id=? OR email=?').run(user.id, email);
        db.prepare('INSERT INTO password_resets (id,user_id,email,code_hash,expires) VALUES (?,?,?,?,?)').run(id, user.id, email, codeHash(id, code), expires);
        try { await (sendVerification || mailer.send)({ email, code, purpose: 'reset' }); }
        catch { db.prepare('DELETE FROM password_resets WHERE id=?').run(id); }
      }
      res.status(202).json({ ok: true, requestId: id, expiresIn: 600 });
    } catch (e) { next(e); }
  });
  app.post('/api/password/reset/confirm', async (req, res, next) => {
    try {
      limited(`reset-confirm:${ipKeyGenerator(req.ip)}`, 20, 15 * 60000);
      const { requestId, code, password, confirmErase } = req.body || {};
      if (typeof requestId !== 'string' || requestId.length > 50 || typeof code !== 'string' || !/^\d{6}$/.test(code)) throw fail('Enter the six-digit reset code.');
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw fail('The new password must be 8–128 characters.');
      if (confirmErase !== true) throw fail('Confirm that the old encrypted chat history will be removed.');
      const pending = db.prepare('SELECT * FROM password_resets WHERE id=?').get(requestId);
      if (!pending || pending.expires <= Date.now() || pending.attempts >= 5) throw fail('The code expired or had too many attempts. Request a new code.');
      db.prepare('UPDATE password_resets SET attempts=attempts+1 WHERE id=?').run(requestId);
      if (!timingSafeEqual(Buffer.from(pending.code_hash, 'hex'), Buffer.from(codeHash(requestId, code), 'hex'))) throw fail('The reset code does not match.');
      const user = db.prepare('SELECT * FROM users WHERE id=? AND lower(email)=?').get(pending.user_id, pending.email);
      if (!user) throw fail('The reset request is no longer valid. Request a new code.', 409);
      const salt = randomBytes(16).toString('hex'), hash = (await passwordHash(password, salt)).toString('hex');
      const conversations = db.prepare('SELECT * FROM conversations WHERE a=? OR b=?').all(user.id, user.id);
      const conversationIds = conversations.map(c => c.id);
      const media = conversationIds.flatMap(id => db.prepare('SELECT filename,bytes FROM media WHERE conversation_id=?').all(id));
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const id of conversationIds) {
          db.prepare('DELETE FROM saved_places WHERE conversation_id=?').run(id);
          db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id);
          db.prepare('DELETE FROM media WHERE conversation_id=?').run(id);
          db.prepare('DELETE FROM conversations WHERE id=?').run(id);
        }
        db.prepare('DELETE FROM identities WHERE user_id=?').run(user.id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
        db.prepare('DELETE FROM push_subscriptions WHERE user_id=?').run(user.id);
        db.prepare('DELETE FROM push_devices WHERE user_id=?').run(user.id);
        db.prepare('DELETE FROM email_verifications WHERE email=? OR existing_user_id=?').run(user.email, user.id);
        db.prepare('DELETE FROM password_resets WHERE user_id=?').run(user.id);
        db.prepare('UPDATE users SET salt=?,password=? WHERE id=?').run(salt, hash, user.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      for (const row of media) {
        try { unlinkSync(path.join(dataDir, 'uploads', row.filename)); } catch (error) { if (error.code !== 'ENOENT') console.error(JSON.stringify({ event: 'reset_media_cleanup_error', code: error.code || error.name })); }
        storage.removed(row.bytes || 0);
      }
      for (const call of [...calls.values()]) if (call.from === user.id || call.to === user.id) endCall(call, 'The account reset its password');
      const peers = new Set(conversations.map(c => peerId(c, user.id)));
      for (const peer of peers) { emitUser(peer, 'identity:reset', { userId: user.id }); emitUser(peer, 'conversations:changed'); }
      emitAll('identities:changed');
      const updated = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
      if (!updated.activated) return res.status(202).json({ activationRequired: true, message: 'Password reset complete. Your account is still waiting for Owner approval.' });
      setSession(res, user.id);
      res.json(accountUser(updated));
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
  const profileText = (value, field, max) => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw fail(`${field} must be text.`);
    const text = value.trim();
    if (text.length > max) throw fail(`${field} is too long.`);
    return text;
  };
  function cleanProfile(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Invalid profile.');
    const profile = {
      bio: profileText(value.bio, 'Bio', 300), occupation: profileText(value.occupation, 'Occupation', 100),
      phone: profileText(value.phone, 'Phone number', 40), address: profileText(value.address, 'Home address', 500),
      birthday: profileText(value.birthday, 'Birthday', 10), tiktok: profileText(value.tiktok, 'TikTok account', 64),
      instagram: profileText(value.instagram, 'Instagram account', 64), facebook: profileText(value.facebook, 'Facebook account', 100),
      website: profileText(value.website, 'Website', 240),
    };
    if (profile.phone && !/^[+0-9().\-\s]{3,40}$/.test(profile.phone)) throw fail('Enter a valid phone number.');
    for (const key of ['tiktok','instagram']) {
      profile[key] = profile[key].replace(/^@/, '');
      if (profile[key] && !/^[A-Za-z0-9._-]{1,64}$/.test(profile[key])) throw fail(`Enter a valid ${key === 'tiktok' ? 'TikTok' : 'Instagram'} username.`);
    }
    if (profile.birthday) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(profile.birthday) || Number.isNaN(Date.parse(`${profile.birthday}T00:00:00Z`)) || profile.birthday > new Date().toISOString().slice(0, 10)) throw fail('Enter a valid birthday.');
    }
    if (profile.website) {
      let url; try { url = new URL(profile.website); } catch { throw fail('Enter a valid website URL.'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 240) throw fail('Website must be a valid HTTPS URL.');
      profile.website = url.href;
    }
    return profile;
  }
  app.patch('/api/me/profile', auth, (req, res, next) => {
    try {
      limited(`profile:${req.user.id}`, 20, 60000);
      const profile = cleanProfile(req.body);
      db.prepare('UPDATE users SET profile=? WHERE id=?').run(JSON.stringify(profile), req.user.id);
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      for (const socket of io.sockets.sockets.values()) if (socket.data.user?.id === user.id) socket.data.user = publicUser(user);
      emitAll('users:changed'); res.json(accountUser(user));
    } catch (error) { next(error); }
  });
  app.get('/api/users/:id/profile', auth, (req, res, next) => {
    try {
      const user = db.prepare('SELECT * FROM users WHERE id=? AND activated=1').get(req.params.id);
      if (!user) throw fail('Profile not found.', 404);
      res.json(profileUser(user));
    } catch (error) { next(error); }
  });
  app.get('/api/admin/users', auth, ownerOnly, (req, res) => {
    const users = db.prepare(`SELECT u.*,(SELECT count(*) FROM sessions s WHERE s.user_id=u.id AND s.expires>?) AS active_sessions
      FROM users u ORDER BY u.activated ASC,u.rowid ASC`).all(Date.now());
    res.json(users.map(user => ({ ...accountUser(user), emailVerified: !!user.email_verified, activatedAt: user.activated_at || null, activeSessions: user.active_sessions })));
  });
  app.patch('/api/admin/users/:id/activation', auth, ownerOnly, (req, res, next) => {
    try {
      limited(`activation:${req.user.id}`, 30, 60000);
      if (typeof req.body?.activated !== 'boolean') throw fail('Activation status is required.');
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
      if (!user) throw fail('Account not found.', 404);
      if (user.role === 'owner' && !req.body.activated) throw fail('The Owner account cannot be deactivated.', 409);
      if (req.body.activated && settings.requireEmailVerification && !user.email_verified) throw fail('Verify this email before activating the account.', 409);
      const activated = req.body.activated ? 1 : 0;
      db.prepare('UPDATE users SET activated=?,activated_at=?,activated_by=? WHERE id=?')
        .run(activated, activated ? Date.now() : null, activated ? req.user.id : null, user.id);
      if (!activated) {
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
        db.prepare('DELETE FROM push_subscriptions WHERE user_id=?').run(user.id);
        db.prepare('DELETE FROM push_devices WHERE user_id=?').run(user.id);
        for (const socket of [...io.sockets.sockets.values()]) if (socket.data.user?.id === user.id) socket.disconnect(true);
      }
      emitAll('users:changed');
      const updated = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
      res.json({ ...accountUser(updated), emailVerified: !!updated.email_verified });
    } catch (error) { next(error); }
  });
  app.get('/api/identity', auth, (req, res) => {
    const row = identity(req.user.id);
    res.json(row ? { ...publicIdentity(row), backup: JSON.parse(row.backup) } : null);
  });
  app.post('/api/identity', auth, (req, res, next) => {
    try {
      const { publicKey, fingerprint, backup } = req.body || {};
      if (identity(req.user.id)) throw fail('The account key is already set. Sign in again to recover it.', 409);
      if (!publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256' || publicKey.d || typeof publicKey.x !== 'string' || typeof publicKey.y !== 'string' || publicKey.x.length !== 43 || publicKey.y.length !== 43) throw fail('Invalid public key.');
      const canonical = { kty: 'EC', crv: 'P-256', x: publicKey.x, y: publicKey.y };
      try { createPublicKey({ key: canonical, format: 'jwk' }); } catch { throw fail('Invalid public key.'); }
      const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
      if (fingerprint !== hash) throw fail('Invalid key backup.');
      db.prepare('INSERT INTO identities VALUES (?,?,?,?)').run(req.user.id, JSON.stringify(canonical), hash, JSON.stringify(vaultBackup(backup)));
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
    res.json({ iceServers, mapStyleUrl: settings.mapStyleUrl, vapidPublicKey: vapidKeys.publicKey, nativePushConfigured: !!nativePush });
  });
  const pushEndpoint = value => {
    if (typeof value !== 'string' || value.length > 2048) throw fail('Invalid notification subscription.');
    let url; try { url = new URL(value); } catch { throw fail('Invalid notification subscription.'); }
    const host = url.hostname.toLowerCase();
    const allowed = host === 'fcm.googleapis.com' || host.endsWith('.push.services.mozilla.com') || host === 'web.push.apple.com' || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com');
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !allowed) throw fail('Unsupported Web Push provider.');
    return url.href;
  };
  app.post('/api/push/subscriptions', auth, (req, res, next) => {
    try {
      limited(`push-subscribe:${req.user.id}`, 20, 60000);
      const endpoint = pushEndpoint(req.body?.endpoint), keys = req.body?.keys;
      if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || !/^[A-Za-z0-9_-]{40,200}$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]{10,100}$/.test(keys.auth)) throw fail('Invalid notification subscription keys.');
      db.prepare(`INSERT INTO push_subscriptions VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET
        user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,created=excluded.created`).run(endpoint, req.user.id, keys.p256dh, keys.auth, Date.now());
      const extras = db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id=? ORDER BY created DESC LIMIT -1 OFFSET 10').all(req.user.id);
      for (const row of extras) db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(row.endpoint);
      res.status(201).json({ ok: true });
    } catch (error) { next(error); }
  });
  app.delete('/api/push/subscriptions', auth, (req, res, next) => {
    try { db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').run(pushEndpoint(req.body?.endpoint), req.user.id); res.json({ ok: true }); }
    catch (error) { next(error); }
  });
  const deviceToken = value => {
    if (typeof value !== 'string' || value.length < 20 || value.length > 4096 || !/^[A-Za-z0-9:_-]+$/.test(value)) throw fail('Invalid device notification token.');
    return value;
  };
  app.post('/api/push/devices', auth, (req, res, next) => {
    try {
      limited(`push-device:${req.user.id}`, 20, 60000);
      if (req.body?.platform !== 'android') throw fail('Unsupported notification platform.');
      const token = deviceToken(req.body?.token);
      db.prepare(`INSERT INTO push_devices VALUES (?,?,?,?) ON CONFLICT(token) DO UPDATE SET
        user_id=excluded.user_id,platform=excluded.platform,created=excluded.created`).run(token, req.user.id, 'android', Date.now());
      const extras = db.prepare("SELECT token FROM push_devices WHERE user_id=? AND platform='android' ORDER BY created DESC LIMIT -1 OFFSET 10").all(req.user.id);
      for (const row of extras) db.prepare('DELETE FROM push_devices WHERE token=?').run(row.token);
      res.status(201).json({ ok: true, configured: !!nativePush });
    } catch (error) { next(error); }
  });
  app.delete('/api/push/devices', auth, (req, res, next) => {
    try { db.prepare('DELETE FROM push_devices WHERE token=? AND user_id=?').run(deviceToken(req.body?.token), req.user.id); res.json({ ok: true }); }
    catch (error) { next(error); }
  });
  const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024, files: 1, fields: 0, parts: 1, fieldNameSize: 32 } });
  const avatarType = buffer => {
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { ext: 'png', mime: 'image/png' };
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
    return null;
  };
  app.post('/api/me/avatar', auth, (req, res, next) => {
    try { limited(`avatar:${req.user.id}`, 10, 60000); next(); } catch (error) { next(error); }
  }, avatarUpload.single('avatar'), (req, res, next) => {
    let filename, saved = false;
    try {
      const type = req.file && avatarType(req.file.buffer);
      if (!type) throw fail('The profile photo must be a valid JPG, PNG, or WebP file.');
      storage.freeSpace(req.file.buffer.length);
      filename = `${randomUUID()}.${type.ext}`;
      writeFileSync(path.join(dataDir, 'avatars', filename), req.file.buffer, { flag: 'wx', mode: 0o600 });
      const old = db.prepare('SELECT avatar FROM users WHERE id=?').get(req.user.id)?.avatar;
      db.prepare('UPDATE users SET avatar=? WHERE id=?').run(filename, req.user.id);
      saved = true;
      if (old && path.basename(old) === old) { try { unlinkSync(path.join(dataDir, 'avatars', old)); } catch {} }
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      for (const socket of io.sockets.sockets.values()) if (socket.data.user?.id === user.id) socket.data.user = publicUser(user);
      emitAll('users:changed');
      res.json(accountUser(user));
    } catch (error) { if (filename && !saved) { try { unlinkSync(path.join(dataDir, 'avatars', filename)); } catch {} } next(error); }
  });
  app.delete('/api/me/avatar', auth, (req, res, next) => {
    try {
      const old = db.prepare('SELECT avatar FROM users WHERE id=?').get(req.user.id)?.avatar;
      db.prepare('UPDATE users SET avatar=NULL WHERE id=?').run(req.user.id);
      if (old && path.basename(old) === old) { try { unlinkSync(path.join(dataDir, 'avatars', old)); } catch {} }
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
      for (const socket of io.sockets.sockets.values()) if (socket.data.user?.id === user.id) socket.data.user = publicUser(user);
      emitAll('users:changed'); res.json(accountUser(user));
    } catch (error) { next(error); }
  });
  app.get('/avatars/:id', auth, (req, res, next) => {
    try {
      const row = db.prepare('SELECT avatar FROM users WHERE id=?').get(req.params.id);
      if (!row?.avatar || path.basename(row.avatar) !== row.avatar) throw fail('Profile photo not found.', 404);
      const ext = path.extname(row.avatar).toLowerCase();
      res.type(ext === '.png' ? 'image/png' : ext === '.jpg' ? 'image/jpeg' : 'image/webp').sendFile(path.join(dataDir, 'avatars', row.avatar));
    } catch (error) { next(error); }
  });
  app.get('/api/users', auth, (req, res) => {
    const q = String(req.query.q || '').slice(0, 40).toLowerCase();
    res.json(db.prepare('SELECT id,name,username,color,avatar,last_seen FROM users WHERE id!=? AND activated=1 AND (instr(lower(name),?)>0 OR instr(username,?)>0) ORDER BY name LIMIT 50').all(req.user.id, q, q).map(u => ({ ...publicUser(u), online: presence.has(u.id) })));
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
      if (typeof id !== 'string' || id === req.user.id || !db.prepare('SELECT id FROM users WHERE id=? AND activated=1').get(id)) throw fail('User not found.', 404);
      const [a, b] = [req.user.id, id].sort();
      let c = db.prepare('SELECT * FROM conversations WHERE a=? AND b=?').get(a, b);
      if (!c) {
        limited(`new-conversation:${req.user.id}`, 20, 60000);
        storage.freeSpace();
        if (db.prepare('SELECT count(*) AS n FROM conversations WHERE a=? OR b=?').get(req.user.id, req.user.id).n >= settings.maxConversations) throw fail('The account chat limit has been reached.', 429);
        c = { id: randomUUID(), a, b, created: Date.now() }; db.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run(c.id, a, b, c.created); emitBoth(c, 'conversations:changed'); }
      res.json({ id: c.id });
    } catch (e) { next(e); }
  });
  const decodePlace = row => ({ id: row.id, conversationId: row.conversation_id, senderId: row.creator_id, kind: 'encrypted', body: JSON.parse(row.body), clientId: row.client_id, created: row.created });
  app.get('/api/places', auth, (req, res, next) => {
    try {
      const rows = db.prepare(`SELECT p.* FROM saved_places p JOIN conversations c ON c.id=p.conversation_id
        WHERE c.a=? OR c.b=? ORDER BY p.created DESC LIMIT 500`).all(req.user.id, req.user.id);
      res.json(rows.map(decodePlace));
    } catch (error) { next(error); }
  });
  app.post('/api/places', auth, (req, res, next) => {
    try {
      const c = conversation(req.body?.conversationId, req.user.id), clientId = req.body?.clientId;
      if (typeof clientId !== 'string' || !/^[A-Za-z0-9:_-]{1,100}$/.test(clientId)) throw fail('Invalid place ID.');
      let row = db.prepare('SELECT * FROM saved_places WHERE creator_id=? AND client_id=?').get(req.user.id, clientId);
      if (row) {
        if (row.conversation_id !== c.id) throw fail('This place ID has already been used.');
        return res.json(decodePlace(row));
      }
      if (db.prepare('SELECT count(*) AS n FROM saved_places WHERE creator_id=?').get(req.user.id).n >= 500) throw fail('The saved places limit has been reached.', 429);
      row = { id: randomUUID(), conversation_id: c.id, creator_id: req.user.id, body: JSON.stringify(envelope(req.body?.envelope, c, req.user.id)), client_id: clientId, created: Date.now() };
      db.prepare('INSERT INTO saved_places (id,conversation_id,creator_id,body,client_id,created) VALUES (?,?,?,?,?,?)').run(row.id, row.conversation_id, row.creator_id, row.body, row.client_id, row.created);
      emitBoth(c, 'places:changed');
      res.status(201).json(decodePlace(row));
    } catch (error) { next(error); }
  });
  app.delete('/api/places/:id', auth, (req, res, next) => {
    try {
      const row = db.prepare('SELECT * FROM saved_places WHERE id=?').get(req.params.id);
      if (!row) throw fail('Place not found.', 404);
      const c = conversation(row.conversation_id, req.user.id);
      if (row.creator_id !== req.user.id) throw fail('Only the original saver can remove this place.', 403);
      db.prepare('DELETE FROM saved_places WHERE id=?').run(row.id); emitBoth(c, 'places:changed'); res.json({ ok: true });
    } catch (error) { next(error); }
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
      db.prepare('UPDATE messages SET delivered_at=coalesce(delivered_at,?),read_at=? WHERE conversation_id=? AND sender_id!=? AND read_at IS NULL').run(at, at, c.id, req.user.id);
      emitBoth(c, 'messages:read', { conversationId: c.id, userId: req.user.id, at });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1, fieldNameSize: 32 } });
  app.post('/api/conversations/:id/images', auth, (req, res, next) => {
    try {
      req.conversation = conversation(req.params.id, req.user.id);
      limited(`upload:${req.user.id}`, 30, 60000);
      if (!identity(req.user.id) || !identity(peerId(req.conversation, req.user.id))) throw fail('Encryption keys are not available yet.', 409);
      const clientId = req.headers['x-message-id'];
      if (typeof clientId !== 'string' || !/^[A-Za-z0-9:_-]{1,100}$/.test(clientId)) throw fail('An image message ID is required. Reload the app.');
      req.uploadClientId = clientId;
      const release = storage.reserve(req.user.id);
      res.once('finish', release); res.once('close', release);
      next();
    } catch (error) { next(error); }
  }, upload.single('image'), (req, res, next) => {
    let filename;
    try {
      if (!req.file || req.file.mimetype !== 'application/octet-stream' || req.file.buffer.length < 17) throw fail('Images must be compressed and encrypted before sending.');
      if (req.aborted || res.destroyed) throw fail('The upload was cancelled.');
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
      if (!Array.isArray(updates) || updates.length > 50) throw fail('Invalid update list.');
      // Validate the whole batch before changing anything; the server cannot read coordinates.
      for (const u of updates) {
        if (!u || typeof u.id !== 'string') throw fail('Invalid message ID.');
        const row = db.prepare("SELECT * FROM messages WHERE id=? AND sender_id=? AND kind='encrypted'").get(u.id, req.user.id);
        if (!row) throw fail('Message not found.', 404);
        envelope(u.envelope, conversation(row.conversation_id, req.user.id), req.user.id);
      }
      for (const u of updates) updateEncrypted(u.id, req.user.id, u.envelope);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  app.get('/media/:id', auth, (req, res, next) => {
    try {
      const media = db.prepare('SELECT * FROM media WHERE id=? AND committed=1').get(req.params.id);
      if (!media) throw fail('Image not found.', 404);
      conversation(media.conversation_id, req.user.id);
      res.type(media.mime).sendFile(path.join(dataDir, 'uploads', media.filename));
    } catch (e) { next(e); }
  });
  io.use((socket, next) => {
    const u = sessionUser(socket.request);
    if (!u) return next(new Error('Please sign in.'));
    socket.data.user = publicUser(u);
    socket.data.sessionHash = tokenHash(cookieToken(socket.request));
    socket.data.sessionExpires = u.session_expires;
    const userSockets = io.sockets.adapter.rooms.get(`user:${u.id}`)?.size || 0;
    if (userSockets >= 5 || io.sockets.sockets.size >= 1000) return next(new Error('The connection limit has been reached.'));
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
    db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(Date.now(), u.id);
    const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.sessionExpires-Date.now()));
    expiryTimer.unref();
    emitAll('presence', { userId: u.id, online: true });
    socket.use((packet, next) => {
      const valid = db.prepare('SELECT 1 FROM sessions WHERE token=? AND expires>?').get(socket.data.sessionHash, Date.now());
      if (!valid) { next(new Error('Session expired.')); socket.disconnect(true); } else next();
    });
    const handle = (name, fn) => socket.on(name, async (data, ack) => {
      try {
        limited(`socket:${u.id}`, 240, 60000);
        if (!data || typeof data !== 'object') throw fail('Invalid request.');
        const result = await fn(data);
        if (typeof ack === 'function') ack({ ok: true, ...result });
      } catch (e) { if (typeof ack === 'function') ack({ ok: false, error: e.status ? e.message : 'The request failed. Try again.' }); }
    });
    handle('message:send', d => {
      const c = conversation(d.conversationId, u.id);
      if (typeof d.clientId !== 'string' || d.clientId.length > 100 || !d.clientId) throw fail('Invalid message ID.');
      return { message: insertMessage(c, u.id, 'encrypted', envelope(d.envelope, c, u.id), d.clientId, d.mediaId) };
    });
    handle('messages:delivered', d => {
      const c = conversation(d.conversationId, u.id);
      if (!Array.isArray(d.messageIds) || !d.messageIds.length || d.messageIds.length > 100) throw fail('Invalid message list.');
      const ids = [...new Set(d.messageIds)];
      if (ids.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) throw fail('Invalid message ID.');
      const rows = ids.map(id => db.prepare('SELECT id,sender_id,delivered_at FROM messages WHERE id=? AND conversation_id=? AND sender_id!=?').get(id, c.id, u.id));
      if (rows.some(row => !row)) throw fail('Message not found.', 404);
      const changed = rows.filter(row => !row.delivered_at), at = Date.now();
      if (changed.length) {
        db.exec('BEGIN IMMEDIATE');
        try { for (const row of changed) db.prepare('UPDATE messages SET delivered_at=? WHERE id=? AND delivered_at IS NULL').run(at, row.id); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
        for (const senderId of new Set(changed.map(row => row.sender_id))) emitUser(senderId, 'messages:delivered', { conversationId: c.id, messageIds: changed.filter(row => row.sender_id === senderId).map(row => row.id), at });
      }
      return { at };
    });
    handle('message:update', d => ({ message: updateEncrypted(d.messageId, u.id, d.envelope) }));
    handle('typing', d => {
      const c = conversation(d.conversationId, u.id);
      emitUser(peerId(c, u.id), 'typing', { conversationId: c.id, userId: u.id, active: !!d.active });
    });
    handle('call:start', d => {
      const c = conversation(d.conversationId, u.id);
      const to = peerId(c, u.id);
      if (!identity(u.id) || !identity(to)) throw fail('Call encryption keys are not available yet.');
      if (!presence.has(to)) throw fail('The user is offline.');
      if ([...calls.values()].some(x => [x.from, x.to].some(id => id === u.id || id === to))) throw fail('The user is already in a call.');
      const call = { id: randomUUID(), conversationId: c.id, from: u.id, to, fromSocket: socket.id, toSocket: null, video: !!d.video, state: 'ringing' };
      call.timer = setTimeout(() => { if (calls.has(call.id)) endCall(call, 'No answer'); }, 30000);
      calls.set(call.id, call);
      emitUser(to, 'call:incoming', { id: call.id, conversationId: c.id, from: u, video: call.video });
      return { id: call.id };
    });
    handle('call:accept', d => {
      const call = calls.get(d.id);
      if (!call || call.to !== u.id || call.state !== 'ringing') throw fail('The call has ended.');
      clearTimeout(call.timer);
      call.state = 'active'; call.toSocket = socket.id;
      call.timer = setTimeout(() => endCall(call, 'Call ended'), 4 * 60 * 60 * 1000);
      emitUser(u.id, 'call:handled', { id: call.id }, socket.id);
      emitSocket(call.fromSocket, 'call:accepted', { id: call.id });
    });
    handle('call:signal', d => {
      const call = calls.get(d.id);
      if (!call || call.state !== 'active' || ![call.fromSocket, call.toSocket].includes(socket.id)) throw fail('Invalid call.');
      if (typeof d.clientId !== 'string' || !d.clientId.startsWith(`${call.id}:`) || d.clientId.length > 100) throw fail('Invalid call signal.');
      const body = envelope(d.envelope, conversation(call.conversationId, u.id), u.id);
      emitSocket(socket.id === call.fromSocket ? call.toSocket : call.fromSocket, 'call:signal', { id: call.id, clientId: d.clientId, senderId: u.id, envelope: body });
    });
    handle('call:end', d => {
      const call = calls.get(d.id);
      if (call && [call.from, call.to].includes(u.id)) endCall(call, call.state === 'ringing' ? (call.to === u.id ? 'Call declined' : 'Call cancelled') : 'Call ended');
    });
    socket.on('disconnect', () => {
      clearTimeout(expiryTimer);
      presence.get(u.id)?.delete(socket.id);
      if (!presence.get(u.id)?.size) {
        const lastSeen = Date.now();
        presence.delete(u.id); db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(lastSeen, u.id);
        emitAll('presence', { userId: u.id, online: false, lastSeen });
      }
      for (const c of calls.values()) if (c.fromSocket === socket.id || c.toSocket === socket.id || (c.to === u.id && !presence.has(u.id))) endCall(c, 'Connection lost');
    });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use('/vendor/maplibre', express.static(path.join(root, 'node_modules', 'maplibre-gl', 'dist'), { fallthrough: false, maxAge: settings.production ? '30d' : 0 }));
  app.use(express.static(path.join(root, 'public')));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: req.path === '/api/me/avatar' ? 'Profile photos can be at most 512 KB after compression.' : 'Compressed images can be at most 2 MB.' });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Invalid upload.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
    if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'Invalid request format.' });
    if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    if (!err.status) console.error(JSON.stringify({ event: 'request_error', id: req.requestId, code: err.code || err.name }));
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error. Try again.' });
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
