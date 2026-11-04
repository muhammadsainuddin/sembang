import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as client } from 'socket.io-client';
import { createApp } from '../server.js';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync } from 'node:crypto';
import { createIdentity, recoverIdentity, encryptPayload, decryptPayload, encryptAttachment, decryptAttachment, safetyNumber } from '../public/crypto.js';
function once(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, done); reject(new Error(`Timeout: ${event}`)); }, 5000);
    function done(data) { clearTimeout(timer); resolve(data); }
    socket.once(event, done);
  });
}
function emit(socket, event, data) { return new Promise((resolve, reject) => socket.timeout(5000).emit(event, data, (error, result) => error ? reject(error) : resolve(result))); }

test('Cryptography: two endpoints, tampering, context binding and password recovery', async () => {
  const aPassword = 'aina-password-123', bPassword = 'badrul-password-123';
  const a = await createIdentity(aPassword), b = await createIdentity(bPassword), x = await createIdentity('citra-password-123');
  assert.equal(a.record.backup.v, 2);
  assert.equal(a.record.backup.kdf, 'PBKDF2-SHA-256');
  assert.equal(a.record.backup.iterations, 600000);
  await assert.rejects(createIdentity());
  const body = await encryptPayload(a, b.record, 'conversation-a', 'user-a', 'client-a', { kind: 'text', text: 'Rahsia kita 💜' });
  const message = { body, senderId: 'user-a', conversationId: 'conversation-a', clientId: 'client-a' };
  assert.equal((await decryptPayload(b, a.record, message, 'user-b')).text, 'Rahsia kita 💜');
  assert.equal((await decryptPayload(a, b.record, message, 'user-a')).text, 'Rahsia kita 💜');
  assert.equal(JSON.stringify(body).includes('Rahsia'), false);
  await assert.rejects(decryptPayload(x, a.record, message, 'user-x'));
  await assert.rejects(decryptPayload(b, a.record, { ...message, conversationId: 'other-conversation' }, 'user-b'));
  await assert.rejects(decryptPayload(b, a.record, { ...message, clientId: 'different-client' }, 'user-b'));
  const bytes = Buffer.from(body.data, 'base64'); bytes[0] ^= 1;
  await assert.rejects(decryptPayload(b, a.record, { ...message, body: { ...body, data: bytes.toString('base64') } }, 'user-b'));
  const recovered = await recoverIdentity(a.record, aPassword);
  assert.equal(recovered.privateKey.extractable, false);
  assert.equal((await decryptPayload(recovered, b.record, message, 'user-a')).text, 'Rahsia kita 💜');
  await assert.rejects(recoverIdentity(a.record, bPassword));
  await assert.rejects(recoverIdentity({ ...a.record, fingerprint: b.record.fingerprint }, aPassword));
  assert.equal(await safetyNumber(a.record.fingerprint, b.record.fingerprint, 'c'), await safetyNumber(b.record.fingerprint, a.record.fingerprint, 'c'));
});

test('Zbuddy E2EE: authentication, encrypted storage, files, location, calls and persistence', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sembang-test-'));
  const pushed = [], nativePushed = [];
  let instance = createApp({ dataDir: dir, config: { maxUsers: 100 }, sendPush: async (subscription, payload) => { pushed.push({ subscription, payload: JSON.parse(payload) }); }, sendNativePush: async message => { nativePushed.push(message); } });
  await new Promise(r => instance.http.listen(0, '127.0.0.1', r));
  let base = `http://127.0.0.1:${instance.http.address().port}`;
  const sockets = [];
  t.after(async () => { sockets.forEach(s => s.disconnect()); await instance.close(); rmSync(dir, { recursive: true, force: true }); });
  async function req(route, { cookie, body, method = body ? 'POST' : 'GET', headers = {} } = {}) {
    const res = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined });
    const content = res.headers.get('content-type') || '';
    return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0], data: content.includes('application/json') ? await res.json() : await res.arrayBuffer() };
  }
  async function register(name, username) {
    const r = await req('/api/register', { body: { name, username, email: `${username}@example.com`, password: 'test-password-123' } }); assert.equal(r.status, 201);
    const identity = await createIdentity('test-password-123');
    assert.equal((await req('/api/identity', { cookie: r.cookie, body: identity.record })).status, 201);
    return { ...r.data, cookie: r.cookie, identity };
  }
  const alice = await register('Aina Ujian', 'aina_test'), bob = await register('Badrul Ujian', 'badrul_test'), outsider = await register('Citra Ujian', 'citra_test');
  let conversationId, imageUrl, imageDescriptor, location, pushEndpoint;
  async function seal(user, payload, clientId) { const peer = user.id === alice.id ? bob : alice; return encryptPayload(user.identity, peer.identity.record, conversationId, user.id, clientId, payload); }
  const plain = (user, raw) => decryptPayload(user.identity, (user.id === alice.id ? bob : alice).identity.record, raw, user.id);
  async function send(socket, user, payload, clientId) { return emit(socket, 'message:send', { conversationId, clientId, envelope: await seal(user, payload, clientId), ...(payload.kind === 'image' ? { mediaId: payload.url.split('/').pop() } : {}) }); }
  await t.test('Android can discover the Node server without authentication', async () => {
    const response = await req('/api/health');
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { service: 'sembang', version: '1.11.0', status: 'ok' });
    assert.equal(response.cookie, undefined);
  });
  await t.test('auth, origin and conversation authorization', async () => {
    assert.equal((await req('/api/users')).status, 401);
    assert.equal((await req('/api/login', { body: { username: alice.username, password: 'wrong' } })).status, 401);
    assert.equal((await req('/api/conversations', { cookie: alice.cookie, body: { userId: bob.id }, headers: { Origin: 'https://attacker.example' } })).status, 403);
    const c = await req('/api/conversations', { cookie: alice.cookie, body: { userId: bob.id } }); conversationId = c.data.id;
    assert.equal((await req('/api/conversations', { cookie: bob.cookie, body: { userId: alice.id } })).data.id, conversationId);
    assert.equal((await req(`/api/conversations/${conversationId}/messages`, { cookie: outsider.cookie })).status, 404);
  });
  await t.test('email is required, validated, unique and accepted for login', async () => {
    const base = { name: 'Ujian Emel', password: 'mail-password-123' };
    assert.equal((await req('/api/register', { body: base })).status, 400);
    for (const email of ['bukan-emel', 'a@', 'a@-contoh.com', '.a@example.com', 'a..b@example.com', 'a@example..com']) {
      assert.equal((await req('/api/register', { body: { ...base, email } })).status, 400);
    }
    const signup = await req('/api/register', { body: { ...base, email: '  Mail.Test+Sembang@EXAMPLE.COM  ' } });
    assert.equal(signup.status, 201);
    assert.equal(signup.data.email, 'mail.test+sembang@example.com');
    assert.match(signup.data.username, /^u_[a-f0-9]{20}$/);
    assert.equal((await req('/api/register', { body: { ...base, username: 'different_user', email: 'MAIL.TEST+SEMBANG@example.com' } })).status, 409);
    const login = await req('/api/login', { body: { email: '  MAIL.TEST+SEMBANG@EXAMPLE.COM ', password: base.password } });
    assert.equal(login.status, 200); assert.equal(login.data.id, signup.data.id);
    assert.equal((await req('/api/login', { body: { username: signup.data.username, password: base.password } })).status, 200);
    const own = await req('/api/me', { cookie: signup.cookie }); assert.equal(own.data.email, signup.data.email);
  });
  await t.test('email is private to the account, not exposed through contacts or conversations', async () => {
    const users = (await req('/api/users', { cookie: alice.cookie })).data;
    assert.ok(users.length >= 2); assert.ok(users.every(u => !('email' in u)));
    const conversations = (await req('/api/conversations', { cookie: bob.cookie })).data;
    assert.equal('email' in conversations[0].peer, false);
    assert.equal((await req('/api/me', { cookie: alice.cookie })).data.email, 'aina_test@example.com');
  });
  await t.test('Web Push subscriptions are authenticated and expose no private VAPID key', async () => {
    const config = await req('/api/config', { cookie: bob.cookie });
    assert.match(config.data.vapidPublicKey, /^[A-Za-z0-9_-]{80,100}$/); assert.equal('vapidPrivateKey' in config.data, false);
    pushEndpoint = 'https://fcm.googleapis.com/fcm/send/snd-chat-test';
    const body = { endpoint: pushEndpoint, keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } };
    assert.equal((await req('/api/push/subscriptions', { body })).status, 401);
    assert.equal((await req('/api/push/subscriptions', { cookie: bob.cookie, body: { ...body, endpoint: 'https://127.0.0.1/push' } })).status, 400);
    assert.equal((await req('/api/push/subscriptions', { cookie: bob.cookie, body })).status, 201);
    const token = `fcm:${'A'.repeat(80)}`;
    assert.equal((await req('/api/push/devices', { body: { token, platform: 'android' } })).status, 401);
    const native = await req('/api/push/devices', { cookie: bob.cookie, body: { token, platform: 'android' } });
    assert.equal(native.status, 201); assert.equal(native.data.configured, true);
  });
  await t.test('profile photos are authenticated, validated, replaceable and removable', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
    const upload = async bytes => { const form = new FormData(); form.append('avatar', new Blob([bytes], { type: 'image/png' }), 'avatar.png'); return req('/api/me/avatar', { cookie: alice.cookie, body: form }); };
    assert.equal((await upload(Buffer.from('not-an-image'))).status, 400);
    const first = await upload(png); assert.equal(first.status, 200); assert.match(first.data.avatar, new RegExp(`^/avatars/${alice.id}\\?v=`));
    const firstFile = instance.db.prepare('SELECT avatar FROM users WHERE id=?').get(alice.id).avatar;
    assert.equal(existsSync(path.join(dir, 'avatars', firstFile)), true);
    assert.equal((await req(first.data.avatar)).status, 401);
    const fetched = await req(first.data.avatar, { cookie: bob.cookie }); assert.equal(fetched.status, 200); assert.deepEqual(Buffer.from(fetched.data), png);
    const contact = (await req('/api/users', { cookie: bob.cookie })).data.find(user => user.id === alice.id); assert.equal(contact.avatar, first.data.avatar); assert.equal('email' in contact, false);
    const second = await upload(png); assert.equal(second.status, 200); assert.notEqual(second.data.avatar, first.data.avatar); assert.equal(existsSync(path.join(dir, 'avatars', firstFile)), false);
    const removed = await req('/api/me/avatar', { cookie: alice.cookie, method: 'DELETE' }); assert.equal(removed.status, 200); assert.equal(removed.data.avatar, null);
    assert.equal((await req(second.data.avatar, { cookie: bob.cookie })).status, 404);
    assert.equal((await upload(png)).status, 200);
  });
  await t.test('public key directory, encrypted vault and immutable keys', async () => {
    const keys = await req(`/api/conversations/${conversationId}/keys`, { cookie: alice.cookie });
    assert.equal(keys.data.peer.fingerprint, bob.identity.record.fingerprint); assert.equal(keys.data.peer.backup, undefined);
    assert.equal((await req(`/api/conversations/${conversationId}/keys`, { cookie: outsider.cookie })).status, 404);
    assert.equal((await req('/api/identity', { cookie: alice.cookie, body: outsider.identity.record })).status, 409);
    const backup = (await req('/api/identity', { cookie: alice.cookie })).data;
    assert.equal(backup.backup.v, 2);
    const restored = await recoverIdentity(backup, 'test-password-123');
    assert.equal(restored.record.fingerprint, alice.identity.record.fingerprint);
    const saved = instance.db.prepare('SELECT * FROM identities WHERE user_id=?').get(alice.id);
    assert.equal(JSON.stringify(saved).includes('test-password-123'), false);
    assert.equal(JSON.stringify(saved).includes('"d"'), false);
  });
  async function connect(user) {
    const s = client(base, { extraHeaders: { Cookie: user.cookie }, transports: ['websocket'], reconnection: false }); sockets.push(s); await once(s, 'connect'); return s;
  }
  const a = await connect(alice), b = await connect(bob), x = await connect(outsider);
  await t.test('unauthenticated sockets and plaintext downgrade are rejected', async () => {
    const noAuth = client(base, { transports: ['websocket'], reconnection: false }); sockets.push(noAuth); assert.match((await once(noAuth, 'connect_error')).message, /sign in/);
    assert.equal((await emit(a, 'message:send', { conversationId, text: 'Plaintext must not be stored', clientId: 'plain' })).ok, false);
    const envelope = await seal(alice, { kind: 'text', text: 'x' }, 'forged');
    assert.equal((await emit(a, 'message:send', { conversationId, envelope: { ...envelope, recipientKey: outsider.identity.record.fingerprint }, clientId: 'forged' })).ok, false);
    assert.equal((await emit(x, 'message:send', { conversationId, envelope, clientId: 'x' })).ok, false);
  });
  await t.test('two-user encrypted chat, push, delivered and read receipts', async () => {
    const incoming = once(b, 'message');
    const result = await send(a, alice, { kind: 'text', text: 'Hai! Ini rahsia kita 💜' }, 'retry-1'); assert.equal(result.ok, true);
    const wire = await incoming; assert.equal(wire.kind, 'encrypted'); assert.equal((await plain(bob, wire)).text, 'Hai! Ini rahsia kita 💜');
    assert.equal(pushed.length, 1); assert.equal(pushed[0].payload.title, 'Aina Ujian · Zbuddy'); assert.equal(pushed[0].payload.body, 'New message'); assert.equal(JSON.stringify(pushed[0]).includes('rahsia kita'), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nativePushed.length, 1); assert.equal(nativePushed[0].data.body, 'New message'); assert.equal(nativePushed[0].android.priority, 'high'); assert.equal(JSON.stringify(nativePushed[0]).includes('rahsia kita'), false);
    assert.equal((await send(a, alice, { kind: 'text', text: 'Hai! Ini rahsia kita 💜' }, 'retry-1')).message.id, result.message.id);
    assert.equal(pushed.length, 1);
    const delivered = once(a, 'messages:delivered');
    assert.equal((await emit(b, 'messages:delivered', { conversationId, messageIds: [wire.id] })).ok, true);
    const delivery = await delivered; assert.deepEqual(delivery.messageIds, [wire.id]);
    assert.equal((await emit(a, 'messages:delivered', { conversationId, messageIds: [wire.id] })).ok, false);
    assert.ok(instance.db.prepare('SELECT delivered_at FROM messages WHERE id=?').get(wire.id).delivered_at);
    assert.equal((await req('/api/conversations', { cookie: bob.cookie })).data[0].unread, 1);
    const read = once(a, 'messages:read'); await req(`/api/conversations/${conversationId}/read`, { cookie: bob.cookie, body: {} }); assert.equal((await read).userId, bob.id);
    const stored = instance.db.prepare('SELECT body FROM messages WHERE id=?').get(wire.id).body;
    assert.equal(stored.includes('rahsia kita'), false); assert.equal(JSON.stringify((await req(`/api/conversations/${conversationId}/messages`, { cookie: bob.cookie })).data).includes('rahsia kita'), false);
    assert.equal((await req('/api/push/subscriptions', { cookie: bob.cookie, method: 'DELETE', body: { endpoint: pushEndpoint } })).status, 200);
    assert.equal((await send(a, alice, { kind: 'text', text: 'Android-only notification' }, 'android-only')).ok, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pushed.length, 1); assert.equal(nativePushed.length, 2);
    assert.equal((await req('/api/push/devices', { cookie: bob.cookie, method: 'DELETE', body: { token: `fcm:${'A'.repeat(80)}` } })).status, 200);
  });
  await t.test('encrypted images: bytes and captions are unreadable to server', async () => {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
    const encrypted = await encryptAttachment(new Blob([bytes], { type: 'image/png' }), `Sembang/v1/image|${conversationId}|image-1`);
    const form = new FormData(); form.append('image', encrypted.blob, 'encrypted.bin');
    const r = await req(`/api/conversations/${conversationId}/images`, { cookie: alice.cookie, body: form, headers: { 'X-Message-Id': 'image-1' } }); assert.equal(r.status, 201); imageUrl = r.data.url;
    imageDescriptor = { kind: 'image', url: imageUrl, key: encrypted.key, iv: encrypted.iv, mime: 'image/png', caption: 'Kapsyen rahsia' };
    const msg = await send(a, alice, imageDescriptor, 'image-1'); assert.equal(msg.ok, true);
    const payload = await plain(bob, msg.message); assert.equal(payload.caption, 'Kapsyen rahsia');
    const fetched = await req(imageUrl, { cookie: bob.cookie });
    assert.notDeepEqual(Buffer.from(fetched.data), bytes);
    const restored = await decryptAttachment(fetched.data, payload, `Sembang/v1/image|${conversationId}|image-1`);
    assert.deepEqual(Buffer.from(await restored.arrayBuffer()), bytes);
    await assert.rejects(decryptAttachment(fetched.data, payload, 'wrong-context'));
    assert.equal((await req(imageUrl, { cookie: outsider.cookie })).status, 404); assert.equal((await req(imageUrl)).status, 401);
    const raw = new FormData(); raw.append('image', new Blob([bytes], { type: 'image/png' }), 'plain.png');
    assert.equal((await req(`/api/conversations/${conversationId}/images`, { cookie: alice.cookie, body: raw })).status, 400);
    const media = instance.db.prepare('SELECT filename FROM media WHERE id=?').get(imageUrl.split('/').pop()); assert.notDeepEqual(readFileSync(path.join(dir, 'uploads', media.filename)), bytes);
  });
  await t.test('encrypted live location updates and owner-only stopping', async () => {
    const payload = { kind: 'location', latitude: 3.14159, longitude: 101.6869, accuracy: 8, updated: Date.now(), active: true, expires: Date.now() + 900000 };
    location = (await send(a, alice, payload, 'location-1')).message;
    const event = once(b, 'message:updated');
    const moved = { ...payload, latitude: 3.14259 };
    assert.equal((await emit(a, 'message:update', { messageId: location.id, envelope: await seal(alice, moved, location.clientId) })).ok, true);
    const raw = await event; assert.equal((await plain(bob, raw)).latitude, 3.14259); assert.equal(JSON.stringify(raw).includes('101.6869'), false);
    const stopped = await seal(alice, { ...moved, active: false }, location.clientId);
    assert.equal((await emit(b, 'message:update', { messageId: location.id, envelope: stopped })).ok, false);
    assert.equal((await req('/api/locations/stop', { cookie: alice.cookie, body: { updates: [{ id: location.id, envelope: stopped }] } })).status, 200);
    const rows = (await req(`/api/conversations/${conversationId}/messages`, { cookie: bob.cookie })).data.messages;
    assert.equal((await plain(bob, rows.find(m => m.id === location.id))).active, false);
  });
  await t.test('interesting places stay encrypted, shared and creator-controlled', async () => {
    const payload = { kind: 'place', name: 'Kedai makan rahsia', note: 'Cuba nasi lemak', latitude: 3.14259, longitude: 101.6869, sourceMessageId: location.id, savedAt: Date.now() };
    const clientId = 'place-1', envelope = await seal(alice, payload, clientId);
    const saved = await req('/api/places', { cookie: alice.cookie, body: { conversationId, clientId, envelope } });
    assert.equal(saved.status, 201); assert.equal(saved.data.kind, 'encrypted');
    const stored = instance.db.prepare('SELECT body FROM saved_places WHERE id=?').get(saved.data.id).body;
    assert.equal(stored.includes('Kedai makan rahsia'), false); assert.equal(stored.includes('101.6869'), false);
    const shared = (await req('/api/places', { cookie: bob.cookie })).data.find(place => place.id === saved.data.id);
    assert.equal((await plain(bob, shared)).name, 'Kedai makan rahsia');
    assert.equal((await req(`/api/places/${saved.data.id}`, { cookie: outsider.cookie, method: 'DELETE' })).status, 404);
    assert.equal((await req(`/api/places/${saved.data.id}`, { cookie: bob.cookie, method: 'DELETE' })).status, 403);
    assert.equal((await req(`/api/places/${saved.data.id}`, { cookie: alice.cookie, method: 'DELETE' })).status, 200);
    const keepId = 'place-persist';
    assert.equal((await req('/api/places', { cookie: alice.cookie, body: { conversationId, clientId: keepId, envelope: await seal(alice, payload, keepId) } })).status, 201);
  });
  await t.test('call setup with encrypted SDP and ICE signaling', async () => {
    const incoming = once(b, 'call:incoming'); assert.equal((await emit(a, 'call:start', { conversationId, video: true })).ok, true); const call = await incoming;
    assert.equal((await emit(a, 'call:start', { conversationId, video: false })).ok, false); assert.equal((await emit(x, 'call:accept', { id: call.id })).ok, false);
    const accepted = once(a, 'call:accepted'); assert.equal((await emit(b, 'call:accept', { id: call.id })).ok, true); await accepted;
    assert.equal((await emit(a, 'call:signal', { id: call.id, signal: { description: 'plaintext' } })).ok, false);
    for (const signal of [{ description: { type: 'offer', sdp: 'private-dtls-fingerprint' } }, { candidate: { candidate: 'private-ip-candidate' } }]) {
      const clientId = `${call.id}:${crypto.randomUUID()}`;
      const event = once(b, 'call:signal'); const envelope = await seal(alice, { kind: 'signal', signal }, clientId);
      assert.equal((await emit(a, 'call:signal', { id: call.id, clientId, envelope })).ok, true);
      const received = await event; assert.equal(JSON.stringify(received).includes('private-'), false);
      const payload = await decryptPayload(bob.identity, alice.identity.record, { conversationId, senderId: received.senderId, clientId, body: received.envelope }, bob.id);
      assert.deepEqual(payload.signal, signal);
    }
    const ended = once(b, 'call:ended'); await emit(a, 'call:end', { id: call.id }); assert.equal((await ended).id, call.id);
  });
  await t.test('pagination and logout', async () => {
    for (let i = 0; i < 60; i++) assert.equal((await send(a, alice, { kind: 'text', text: `History ${i}` }, `history-${i}`)).ok, true);
    let before, all = []; do { const r = await req(`/api/conversations/${conversationId}/messages${before ? `?before=${before}` : ''}`, { cookie: alice.cookie }); all.push(...r.data.messages); before = r.data.next; } while (before);
    assert.equal(new Set(all.map(m => m.id)).size, 64);
    const disconnected = once(x, 'disconnect'); await req('/api/logout', { cookie: outsider.cookie, body: {} }); await disconnected; assert.equal((await req('/api/me', { cookie: outsider.cookie })).status, 401);
  });
  await t.test('ciphertext, keys and attachments survive restart', async () => {
    sockets.forEach(s => s.disconnect()); await instance.close(); instance = createApp({ dataDir: dir, config: { maxUsers: 100 } }); await new Promise(r => instance.http.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${instance.http.address().port}`;
    const restoredMe = (await req('/api/me', { cookie: alice.cookie })).data; assert.equal(restoredMe.id, alice.id); assert.match(restoredMe.avatar, /^\/avatars\//);
    assert.equal((await req(restoredMe.avatar, { cookie: bob.cookie })).status, 200);
    const history = (await req(`/api/conversations/${conversationId}/messages`, { cookie: bob.cookie })).data;
    assert.equal(history.messages.length, 50); assert.equal((await plain(bob, history.messages.at(-1))).text, 'History 59');
    const backup = (await req('/api/identity', { cookie: alice.cookie })).data; assert.equal((await recoverIdentity(backup, 'test-password-123')).record.fingerprint, alice.identity.record.fingerprint);
    assert.equal((await req(imageUrl, { cookie: bob.cookie })).status, 200);
    const places = (await req('/api/places', { cookie: bob.cookie })).data; assert.equal((await plain(bob, places[0])).name, 'Kedai makan rahsia');
  });
});


test('Existing databases upgrade without losing accounts or chat', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sembang-legacy-'));
  const legacy = new DatabaseSync(path.join(dir, 'sembang.sqlite'));
  legacy.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,salt TEXT NOT NULL,password TEXT NOT NULL,color TEXT NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY,a TEXT REFERENCES users(id),b TEXT REFERENCES users(id),created INTEGER NOT NULL,UNIQUE(a,b));
    CREATE TABLE messages (id TEXT PRIMARY KEY,conversation_id TEXT REFERENCES conversations(id),sender_id TEXT REFERENCES users(id),kind TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL,read_at INTEGER,client_id TEXT);
  `);
  const salt = 'legacy-test-salt', hash = scryptSync('legacy-password-123', salt, 64).toString('hex');
  for (const [id, username] of [['old-a','legacy_a'],['old-b','legacy_b']]) legacy.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id,username,username,salt,hash,'#dacaf0');
  legacy.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run('old-chat','old-a','old-b',1000);
  legacy.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)').run('old-message','old-chat','old-b','text',JSON.stringify({text:'Cerita lama kekal.'}),1001,null,null);
  legacy.close();
  let instance = createApp({ dataDir: dir });
  t.after(async () => { await instance.close(); rmSync(dir, { recursive: true, force: true }); });
  await new Promise(r => instance.http.listen(0,'127.0.0.1',r));
  const base = `http://127.0.0.1:${instance.http.address().port}`;
  const login = await fetch(base+'/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:'legacy_a',password:'legacy-password-123'}) });
  assert.equal(login.status,200); const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await login.json()).email,null);
  const history = await fetch(base+'/api/conversations/old-chat/messages',{headers:{Cookie:cookie}});
  assert.equal((await history.json()).messages[0].body.text,'Cerita lama kekal.');
  assert.equal(instance.db.prepare('SELECT count(*) AS n FROM users').get().n,2);
  await instance.close(); instance = createApp({dataDir:dir});
  assert.equal(instance.db.prepare('PRAGMA table_info(users)').all().filter(c=>c.name==='email').length,1);
  assert.equal(instance.db.prepare('SELECT id FROM messages WHERE id=?').get('old-message').id,'old-message');
});
