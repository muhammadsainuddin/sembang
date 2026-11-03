import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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

test('Cryptography: two endpoints, tampering, context binding and recovery', async () => {
  const a = await createIdentity(), b = await createIdentity(), x = await createIdentity();
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
  const recovered = await recoverIdentity(a.record, a.recoveryCode);
  assert.equal(recovered.privateKey.extractable, false);
  assert.equal((await decryptPayload(recovered, b.record, message, 'user-a')).text, 'Rahsia kita 💜');
  await assert.rejects(recoverIdentity(a.record, b.recoveryCode));
  await assert.rejects(recoverIdentity({ ...a.record, fingerprint: b.record.fingerprint }, a.recoveryCode));
  assert.equal(await safetyNumber(a.record.fingerprint, b.record.fingerprint, 'c'), await safetyNumber(b.record.fingerprint, a.record.fingerprint, 'c'));
});

test('Sembang E2EE: authentication, encrypted storage, files, location, calls and persistence', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sembang-test-'));
  let instance = createApp({ dataDir: dir });
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
    const identity = await createIdentity();
    assert.equal((await req('/api/identity', { cookie: r.cookie, body: identity.record })).status, 201);
    return { ...r.data, cookie: r.cookie, identity };
  }
  const alice = await register('Aina Ujian', 'aina_test'), bob = await register('Badrul Ujian', 'badrul_test'), outsider = await register('Citra Ujian', 'citra_test');
  let conversationId, imageUrl, imageDescriptor, location;
  async function seal(user, payload, clientId) { const peer = user.id === alice.id ? bob : alice; return encryptPayload(user.identity, peer.identity.record, conversationId, user.id, clientId, payload); }
  const plain = (user, raw) => decryptPayload(user.identity, (user.id === alice.id ? bob : alice).identity.record, raw, user.id);
  async function send(socket, user, payload, clientId) { return emit(socket, 'message:send', { conversationId, clientId, envelope: await seal(user, payload, clientId), ...(payload.kind === 'image' ? { mediaId: payload.url.split('/').pop() } : {}) }); }
  await t.test('Android can discover the Node server without authentication', async () => {
    const response = await req('/api/health');
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { service: 'sembang', version: '1.4.0', status: 'ok' });
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
  await t.test('public key directory, encrypted vault and immutable keys', async () => {
    const keys = await req(`/api/conversations/${conversationId}/keys`, { cookie: alice.cookie });
    assert.equal(keys.data.peer.fingerprint, bob.identity.record.fingerprint); assert.equal(keys.data.peer.backup, undefined);
    assert.equal((await req(`/api/conversations/${conversationId}/keys`, { cookie: outsider.cookie })).status, 404);
    assert.equal((await req('/api/identity', { cookie: alice.cookie, body: outsider.identity.record })).status, 409);
    const backup = (await req('/api/identity', { cookie: alice.cookie })).data;
    const restored = await recoverIdentity(backup, alice.identity.recoveryCode);
    assert.equal(restored.record.fingerprint, alice.identity.record.fingerprint);
    const saved = instance.db.prepare('SELECT * FROM identities WHERE user_id=?').get(alice.id);
    assert.equal(JSON.stringify(saved).includes(alice.identity.recoveryCode), false);
    assert.equal(JSON.stringify(saved).includes('"d"'), false);
  });
  async function connect(user) {
    const s = client(base, { extraHeaders: { Cookie: user.cookie }, transports: ['websocket'], reconnection: false }); sockets.push(s); await once(s, 'connect'); return s;
  }
  const a = await connect(alice), b = await connect(bob), x = await connect(outsider);
  await t.test('unauthenticated sockets and plaintext downgrade are rejected', async () => {
    const noAuth = client(base, { transports: ['websocket'], reconnection: false }); sockets.push(noAuth); assert.match((await once(noAuth, 'connect_error')).message, /log masuk/);
    assert.equal((await emit(a, 'message:send', { conversationId, text: 'Plaintext must not be stored', clientId: 'plain' })).ok, false);
    const envelope = await seal(alice, { kind: 'text', text: 'x' }, 'forged');
    assert.equal((await emit(a, 'message:send', { conversationId, envelope: { ...envelope, recipientKey: outsider.identity.record.fingerprint }, clientId: 'forged' })).ok, false);
    assert.equal((await emit(x, 'message:send', { conversationId, envelope, clientId: 'x' })).ok, false);
  });
  await t.test('two-user encrypted chat, retries, unread and read receipts', async () => {
    const incoming = once(b, 'message');
    const result = await send(a, alice, { kind: 'text', text: 'Hai! Ini rahsia kita 💜' }, 'retry-1'); assert.equal(result.ok, true);
    const wire = await incoming; assert.equal(wire.kind, 'encrypted'); assert.equal((await plain(bob, wire)).text, 'Hai! Ini rahsia kita 💜');
    assert.equal((await send(a, alice, { kind: 'text', text: 'Hai! Ini rahsia kita 💜' }, 'retry-1')).message.id, result.message.id);
    assert.equal((await req('/api/conversations', { cookie: bob.cookie })).data[0].unread, 1);
    const read = once(a, 'messages:read'); await req(`/api/conversations/${conversationId}/read`, { cookie: bob.cookie, body: {} }); assert.equal((await read).userId, bob.id);
    const stored = instance.db.prepare('SELECT body FROM messages WHERE id=?').get(wire.id).body;
    assert.equal(stored.includes('rahsia kita'), false); assert.equal(JSON.stringify((await req(`/api/conversations/${conversationId}/messages`, { cookie: bob.cookie })).data).includes('rahsia kita'), false);
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
    assert.equal(new Set(all.map(m => m.id)).size, 63);
    const disconnected = once(x, 'disconnect'); await req('/api/logout', { cookie: outsider.cookie, body: {} }); await disconnected; assert.equal((await req('/api/me', { cookie: outsider.cookie })).status, 401);
  });
  await t.test('ciphertext, keys and attachments survive restart', async () => {
    sockets.forEach(s => s.disconnect()); await instance.close(); instance = createApp({ dataDir: dir }); await new Promise(r => instance.http.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${instance.http.address().port}`;
    assert.equal((await req('/api/me', { cookie: alice.cookie })).data.id, alice.id);
    const history = (await req(`/api/conversations/${conversationId}/messages`, { cookie: bob.cookie })).data;
    assert.equal(history.messages.length, 50); assert.equal((await plain(bob, history.messages.at(-1))).text, 'History 59');
    const backup = (await req('/api/identity', { cookie: alice.cookie })).data; assert.equal((await recoverIdentity(backup, alice.identity.recoveryCode)).record.fingerprint, alice.identity.record.fingerprint);
    assert.equal((await req(imageUrl, { cookie: bob.cookie })).status, 200);
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
