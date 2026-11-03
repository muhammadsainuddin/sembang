import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { io } from 'socket.io-client';
import { createApp } from '../server.js';
import { loadConfig } from '../lib/config.js';
import { MAX_UPLOAD_BYTES } from '../lib/storage.js';
import { createIdentity, encryptPayload } from '../public/crypto.js';

async function setup(t, config = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sembang-hardening-'));
  const mail = [], sockets = [];
  const f = { dir, config, instance: null, base: '' };
  f.start = async () => {
    f.instance = createApp({ dataDir: dir, config: f.config, sendVerification: async message => { mail.push(message); } });
    await new Promise(resolve => f.instance.http.listen(0, '127.0.0.1', resolve));
    f.base = `http://127.0.0.1:${f.instance.http.address().port}`;
  };
  await f.start();
  t.after(async () => { sockets.forEach(s => s.disconnect()); await f.instance.close(); rmSync(dir, { recursive: true, force: true }); });
  f.req = async (route, { body, cookie, headers = {} } = {}) => {
    const res = await fetch(f.base + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
    const json = res.headers.get('content-type')?.includes('application/json');
    return { status: res.status, data: json ? await res.json() : await res.arrayBuffer(), cookie: res.headers.get('set-cookie')?.split(';')[0], headers: res.headers };
  };
  f.register = name => f.req('/api/register', { body: { name, email: `${name}@example.com`, password: 'backend-test-password-123' } });
  f.user = async name => {
    const user = await f.register(name); assert.equal(user.status, 201);
    const identity = await createIdentity();
    assert.equal((await f.req('/api/identity', { cookie: user.cookie, body: identity.record })).status, 201);
    return { ...user.data, cookie: user.cookie, identity };
  };
  f.connect = async user => {
    const socket = io(f.base, { transports: ['websocket'], extraHeaders: { Cookie: user.cookie }, reconnection: false, autoConnect: false }); sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    return socket;
  };
  f.emit = (socket, event, data) => new Promise((resolve, reject) => socket.timeout(2000).emit(event, data, (error, result) => error ? reject(error) : resolve(result)));
  f.mail = mail;
  return f;
}

test('production configuration refuses unsafe origin, cookies, proxy and missing email settings', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /Production/);
  assert.throws(() => loadConfig({ TRUST_PROXY: 'true' }), /TRUST_PROXY/);
  const base = { NODE_ENV: 'production', APP_ORIGIN: 'https://chat.example.com', COOKIE_SECURE: 'true', AUTH_SECRET: 'a'.repeat(64), SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'chat@example.com' };
  assert.equal(loadConfig(base).requireEmailVerification, true);
  assert.throws(() => loadConfig({ ...base, EMAIL_VERIFICATION_REQUIRED: 'false' }), /Pengesahan/);
  assert.throws(() => loadConfig({ ...base, SMTP_HOST: '' }), /SMTP/);
  assert.throws(() => loadConfig({ ...base, APP_ORIGIN: 'https://chat.example.com/path' }), /origin/);
});

test('proxy clients have separate persistent auth buckets; untrusted forwarded headers cannot bypass limits', async t => {
  const f = await setup(t, { trustProxy: ['loopback'] });
  for (let i = 0; i < 30; i++) assert.equal((await f.req('/api/login', { body: { email: 'missing@example.com', password: 'wrong' }, headers: { 'X-Forwarded-For': '198.51.100.10' } })).status, 401);
  const blocked = await f.req('/api/login', { body: { email: 'missing@example.com', password: 'wrong' }, headers: { 'X-Forwarded-For': '198.51.100.10' } });
  assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await f.req('/api/register', { body: { name: 'Other Client', email: 'other@example.com', password: 'backend-test-password-123' }, headers: { 'X-Forwarded-For': '203.0.113.20' } })).status, 201);
  await f.instance.close(); await f.start();
  assert.equal((await f.req('/api/login', { body: { email: 'missing@example.com', password: 'wrong' }, headers: { 'X-Forwarded-For': '198.51.100.10' } })).status, 429);
  const g = await setup(t);
  for (let i = 0; i < 30; i++) assert.equal((await g.req('/api/login', { body: { email: 'missing@example.com', password: 'wrong' }, headers: { 'X-Forwarded-For': `198.51.100.${i+1}` } })).status, 401);
  assert.equal((await g.register('blocked_spoof')).status, 429);
});

test('origin comparison checks scheme and exact origin even when Host matches an attacker origin', async t => {
  const f = await setup(t, { origin: 'https://chat.example.com' });
  const body = { email: 'missing@example.com', password: 'wrong' };
  assert.equal((await f.req('/api/login', { body, headers: { Origin: 'http://chat.example.com', Host: 'chat.example.com' } })).status, 403);
  assert.equal((await f.req('/api/login', { body, headers: { Origin: 'https://chat.example.com.evil.test' } })).status, 403);
  assert.equal((await f.req('/api/login', { body, headers: { Origin: 'https://chat.example.com' } })).status, 401);
});

test('expired passive sockets cannot receive new chat; timer disconnects without an application packet', async t => {
  const f = await setup(t);
  const alice = await f.user('expire_alice'), bob = await f.user('expire_bob');
  const c = (await f.req('/api/conversations', { cookie: alice.cookie, body: { userId: bob.id } })).data.id;
  const sender = await f.connect(alice), receiver = await f.connect(bob);
  let received = false; receiver.on('message', () => { received = true; });
  f.instance.db.prepare('UPDATE sessions SET expires=? WHERE user_id=?').run(Date.now()-1, bob.id);
  const disconnected = new Promise(resolve => receiver.once('disconnect', resolve));
  const envelope = await encryptPayload(alice.identity, bob.identity.record, c, alice.id, 'expiry-test', { kind: 'text', text: 'private' });
  assert.equal((await f.emit(sender, 'message:send', { conversationId: c, clientId: 'expiry-test', envelope })).ok, true);
  await disconnected;
  assert.equal(received, false); assert.equal((await f.req('/api/me', { cookie: bob.cookie })).status, 401);
  const g = await setup(t, { sessionMs: 1200 });
  const short = await g.user('short_timer'); const sock = await g.connect(short);
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Expiry timer did not disconnect')), 2500); sock.once('disconnect', () => { clearTimeout(timer); resolve(); }); });
  assert.equal(sock.connected, false);
});

test('email ownership is required before account/session creation and codes are single-use', async t => {
  const f = await setup(t, { requireEmailVerification: true });
  const pending = await f.register('verified_user'); assert.equal(pending.status, 202); assert.equal(pending.cookie, undefined);
  assert.equal(f.instance.db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
  assert.equal((await f.req('/api/me')).status, 401);
  const stored = f.instance.db.prepare('SELECT code_hash FROM email_verifications WHERE id=?').get(pending.data.requestId);
  assert.equal(stored.code_hash.includes(f.mail[0].code), false);
  assert.equal((await f.req('/api/verify-email', { body: { requestId: pending.data.requestId, code: '000000' } })).status, 400);
  const verified = await f.req('/api/verify-email', { body: { requestId: pending.data.requestId, code: f.mail[0].code } });
  assert.equal(verified.status, 201); assert.ok(verified.cookie);
  assert.equal((await f.req('/api/me', { cookie: verified.cookie })).status, 200);
  assert.equal((await f.req('/api/verify-email', { body: { requestId: pending.data.requestId, code: f.mail[0].code } })).status, 400);
  const login = await f.req('/api/login', { body: { email: 'verified_user@example.com', password: 'backend-test-password-123' } });
  assert.equal(login.status, 200); assert.equal(f.mail.length, 1);
});

test('unverified requests cannot reserve an email, and expired/exhausted codes are rejected', async t => {
  const f = await setup(t, { requireEmailVerification: true });
  const pending = await f.register('same_email'); assert.equal(pending.status, 202);
  for (let i = 0; i < 5; i++) assert.equal((await f.req('/api/verify-email', { body: { requestId: pending.data.requestId, code: '000000' } })).status, 400);
  assert.equal((await f.req('/api/verify-email', { body: { requestId: pending.data.requestId, code: f.mail[0].code } })).status, 400);
  const replacement = await f.register('same_email'); assert.equal(replacement.status, 202);
  const success = await f.req('/api/verify-email', { body: { requestId: replacement.data.requestId, code: f.mail[1].code } }); assert.equal(success.status, 201);
  const expired = await f.register('expired_email'); f.instance.db.prepare('UPDATE email_verifications SET expires=? WHERE id=?').run(Date.now()-1, expired.data.requestId);
  assert.equal((await f.req('/api/verify-email', { body: { requestId: expired.data.requestId, code: f.mail[2].code } })).status, 400);
});

test('legacy email accounts verify without losing identity, chat or user ID; SMTP errors create no account', async t => {
  const f = await setup(t); const old = await f.user('legacy_email');
  await f.instance.close(); f.config.requireEmailVerification = true; await f.start();
  assert.equal((await f.req('/api/me', { cookie: old.cookie })).status, 401);
  const login = await f.req('/api/login', { body: { email: 'legacy_email@example.com', password: 'backend-test-password-123' } }); assert.equal(login.status, 202);
  const verified = await f.req('/api/verify-email', { body: { requestId: login.data.requestId, code: f.mail[0].code } });
  assert.equal(verified.data.id, old.id);
  assert.equal((await f.req('/api/identity', { cookie: verified.cookie })).data.fingerprint, old.identity.record.fingerprint);
  const dir = mkdtempSync(path.join(tmpdir(), 'sembang-mail-fail-'));
  const broken = createApp({ dataDir: dir, config: { requireEmailVerification: true }, sendVerification: async () => { throw new Error('SMTP failed'); } });
  await new Promise(resolve => broken.http.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${broken.http.address().port}/api/register`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ name:'Mail Failure', email:'mail-fail@example.com', password:'backend-test-password-123' }) });
    assert.equal(res.status,503); assert.equal(broken.db.prepare('SELECT count(*) AS n FROM users').get().n,0); assert.equal(broken.db.prepare('SELECT count(*) AS n FROM email_verifications').get().n,0);
  } finally { await broken.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('media quota admission, owner/client binding, commit and cleanup preserve referenced ciphertext', async t => {
  const f = await setup(t, { userStorageBytes: MAX_UPLOAD_BYTES + 100 });
  const alice = await f.user('quota_alice'), bob = await f.user('quota_bob');
  const c = (await f.req('/api/conversations', { cookie:alice.cookie, body:{userId:bob.id} })).data.id;
  const socket = await f.connect(alice);
  async function upload(clientId, size = 200) { const form=new FormData(); form.append('image',new Blob([new Uint8Array(size)],{type:'application/octet-stream'}),'encrypted.bin'); return f.req(`/api/conversations/${c}/images`,{cookie:alice.cookie,body:form,headers:{'X-Message-Id':clientId}}); }
  const uploaded = await upload('commit-image'); assert.equal(uploaded.status,201); const id=uploaded.data.url.split('/').pop();
  assert.equal((await f.req(uploaded.data.url,{cookie:bob.cookie})).status,404);
  assert.equal((await upload('quota-rejected')).status,413);
  const envelope=await encryptPayload(alice.identity,bob.identity.record,c,alice.id,'wrong-id',{kind:'text',text:'bind'});
  assert.equal((await f.emit(socket,'message:send',{conversationId:c,clientId:'wrong-id',envelope,mediaId:id})).ok,false);
  const correct=await encryptPayload(alice.identity,bob.identity.record,c,alice.id,'commit-image',{kind:'text',text:'opaque image descriptor'});
  assert.equal((await f.emit(socket,'message:send',{conversationId:c,clientId:'commit-image',envelope:correct,mediaId:id})).ok,true);
  assert.equal((await f.req(uploaded.data.url,{cookie:bob.cookie})).status,200);
  f.instance.db.prepare('UPDATE media SET created_at=0 WHERE id=?').run(id); f.instance.maintenance();
  assert.equal((await f.req(uploaded.data.url,{cookie:bob.cookie})).status,200);
  // Increase only the test quota, admit another pending object and age it beyond TTL.
  f.instance.settings.userStorageBytes += MAX_UPLOAD_BYTES;
  const pending=await upload('orphan');assert.equal(pending.status,201); const pendingId=pending.data.url.split('/').pop();
  const file=f.instance.db.prepare('SELECT filename FROM media WHERE id=?').get(pendingId).filename;
  f.instance.db.prepare('UPDATE media SET created_at=0 WHERE id=?').run(pendingId); f.instance.maintenance();
  assert.equal(f.instance.db.prepare('SELECT id FROM media WHERE id=?').get(pendingId),undefined);
  assert.equal(existsSync(path.join(f.dir,'uploads',file)),false);
  assert.equal((await upload('space-reclaimed')).status,201);
});

test('TURN REST credentials expire and shared secret is not returned', async t => {
  const f = await setup(t,{turnUrls:['turn:turn.example.com:3478'],turnSecret:'test-only-turn-shared-secret'});
  const user=await f.user('turn_user'); const response=await f.req('/api/config',{cookie:user.cookie});
  const turn=response.data.iceServers[1];const expires=Number(turn.username.split(':')[0]);
  assert.ok(expires>Date.now()/1000&&expires<Date.now()/1000+14401);
  assert.equal(turn.credential,createHmac('sha1',f.config.turnSecret).update(turn.username).digest('base64'));
  assert.equal(JSON.stringify(response.data).includes(f.config.turnSecret),false);
});

test('online backup restores committed media and SQLite while excluding only pending uploads', async t => {
  const { createBackup } = await import('../scripts/backup.mjs');
  const { spawnSync } = await import('node:child_process');
  const { mkdirSync, readFileSync } = await import('node:fs');
  const f=await setup(t);const alice=await f.user('backup_alice'),bob=await f.user('backup_bob');
  const c=(await f.req('/api/conversations',{cookie:alice.cookie,body:{userId:bob.id}})).data.id;
  const sock=await f.connect(alice);
  async function upload(id) {const form=new FormData();form.append('image',new Blob([new Uint8Array(40)],{type:'application/octet-stream'}),'encrypted.bin');return f.req(`/api/conversations/${c}/images`,{cookie:alice.cookie,body:form,headers:{'X-Message-Id':id}});}
  const saved=await upload('saved');const mediaId=saved.data.url.split('/').pop();const pending=await upload('pending');
  const envelope=await encryptPayload(alice.identity,bob.identity.record,c,alice.id,'saved',{kind:'text',text:'backup ciphertext'});
  assert.equal((await f.emit(sock,'message:send',{conversationId:c,clientId:'saved',envelope,mediaId})).ok,true);
  const archive=await createBackup(f.dir,path.join(f.dir,'backups'));
  assert.ok(existsSync(archive+'.sha256'));
  const restoreDir=path.join(f.dir,'restore');mkdirSync(restoreDir);
  assert.equal(spawnSync('tar',['-xzf',archive,'-C',restoreDir]).status,0);
  const restored=createApp({dataDir:restoreDir});
  try {
    assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(restored.db.prepare('SELECT count(*) AS n FROM users').get().n,2);
    assert.equal(restored.db.prepare('SELECT body FROM messages WHERE client_id=?').get('saved').body,JSON.stringify(envelope));
    assert.equal(restored.db.prepare('SELECT count(*) AS n FROM media').get().n,1);
    assert.equal(restored.db.prepare('SELECT id FROM media WHERE id=?').get(pending.data.url.split('/').pop()),undefined);
    const filename=restored.db.prepare('SELECT filename FROM media WHERE id=?').get(mediaId).filename;
    assert.equal(readFileSync(path.join(restoreDir,'uploads',filename)).length,40);
    assert.equal(f.instance.db.prepare('SELECT count(*) AS n FROM media').get().n,2);
  } finally {await restored.close();}
});

test('global media quota applies across owners and low disk reports not-ready without accepting writes', async t => {
  const f=await setup(t,{totalStorageBytes:MAX_UPLOAD_BYTES+100});const alice=await f.user('global_alice'),bob=await f.user('global_bob');
  const c=(await f.req('/api/conversations',{cookie:alice.cookie,body:{userId:bob.id}})).data.id;
  async function upload(user,id) {const form=new FormData();form.append('image',new Blob([new Uint8Array(200)],{type:'application/octet-stream'}),'encrypted.bin');return f.req(`/api/conversations/${c}/images`,{cookie:user.cookie,body:form,headers:{'X-Message-Id':id}});}
  assert.equal((await upload(alice,'global-first')).status,201);
  assert.equal((await upload(bob,'global-second')).status,507);
  const g=await setup(t,{minFreeBytes:Number.MAX_SAFE_INTEGER});
  assert.equal((await g.req('/api/health')).status,200);assert.equal((await g.req('/api/ready')).status,503);assert.equal((await g.register('disk_full')).status,507);
});

test('upload reservations bound concurrent admission and release exactly once after abort/finish', async t => {
  const {mediaStorage}=await import('../lib/storage.js');const f=await setup(t);const user=await f.user('reserved_user');
  const store=mediaStorage(f.instance.db,f.dir,f.instance.settings);
  const first=store.reserve(user.id),second=store.reserve(user.id);
  assert.throws(()=>store.reserve(user.id),error=>error.status===503);
  first();first();const third=store.reserve(user.id);
  assert.throws(()=>store.reserve(user.id),error=>error.status===503);
  second();third();const after=store.reserve(user.id);after();
});

test('Engine.IO rejects HTTP spoofing and foreign origins before allocating production connections', async t => {
  const f=await setup(t,{production:true,origin:'https://chat.example.com'});
  assert.equal((await f.req('/socket.io/?EIO=4&transport=polling',{headers:{'X-Forwarded-Proto':'https'}})).status,400);
  const g=await setup(t,{production:true,origin:'https://chat.example.com',trustProxy:['loopback']});
  const headers={'X-Forwarded-Proto':'https',Origin:'https://chat.example.com'};
  assert.equal((await g.req('/socket.io/?EIO=4&transport=polling',{headers})).status,200);
  assert.equal((await g.req('/socket.io/?EIO=4&transport=polling',{headers:{...headers,Origin:'https://evil.example'}})).status,400);
});

test('active sessions are bounded and older cookies are revoked when the limit is reached', async t => {
  const f=await setup(t);const first=await f.register('session_limit');assert.equal(first.status,201);
  let last;
  for(let i=0;i<21;i++){last=await f.req('/api/login',{body:{email:'session_limit@example.com',password:'backend-test-password-123'}});assert.equal(last.status,200);}
  assert.equal(f.instance.db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(first.data.id).n,20);
  assert.equal((await f.req('/api/me',{cookie:first.cookie})).status,401);
  assert.equal((await f.req('/api/me',{cookie:last.cookie})).status,200);
});
