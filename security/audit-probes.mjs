// Audit probes run exclusively against fresh databases on ephemeral loopback ports.
// Never import real users, keys, cookies or uploaded files into this workflow.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { createApp } from '../server.js';
import { createIdentity, encryptPayload, decryptPayload } from '../public/crypto.js';

const result = { date: '2026-10-28', serverVersion: '1.2.2', isolation: 'Temporary databases; loopback only; no user data accessed', probes: {} };
async function fixture(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sembang-security-'));
  const instance = createApp({ dataDir: dir });
  const sockets = [];
  try {
    await new Promise(resolve => instance.http.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${instance.http.address().port}`;
    async function request(route, { body, cookie, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) {
      const response = await fetch(base + route, { method, headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
      const data = await response.json();
      return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], data };
    }
    async function register(name) {
      const signup = await request('/api/register', { body: { name, email: `${name}@example.invalid`, password: 'local-audit-password-123' } });
      assert.equal(signup.status, 201);
      const identity = await createIdentity('local-audit-password-123');
      assert.equal((await request('/api/identity', { cookie: signup.cookie, body: identity.record })).status, 201);
      return { ...signup.data, cookie: signup.cookie, identity };
    }
    async function connect(user) {
      const socket = io(base, { transports: ['websocket'], extraHeaders: { Cookie: user.cookie }, reconnection: false, autoConnect: false });
      sockets.push(socket);
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
      return socket;
    }
    await run({ instance, request, register, connect });
  } finally {
    sockets.forEach(socket => socket.disconnect());
    await instance.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

await fixture(async ({ request }) => {
  const statuses = [];
  for (let n = 0; n < 30; n++) {
    statuses.push((await request('/api/login', { body: { email: 'missing@example.invalid', password: 'wrong' }, headers: { 'X-Forwarded-For': '198.51.100.10' } })).status);
  }
  assert.ok(statuses.every(status => status === 401));
  const otherClient = await request('/api/register', { body: { name: 'Other Client', email: 'other@example.invalid', password: 'local-audit-password-123' }, headers: { 'X-Forwarded-For': '203.0.113.20' } });
  assert.equal(otherClient.status, 429);
  result.probes.sharedProxyAuthLimit = { failedAttempts: 30, otherForwardedClientStatus: otherClient.status, confirmed: true, note: 'Simulates two clients sharing the reverse proxy TCP peer. Not a load test of a deployed proxy.' };
});

await fixture(async ({ instance, request, register, connect }) => {
  const alice = await register('audit_alice'), bob = await register('audit_bob');
  const conversation = await request('/api/conversations', { cookie: alice.cookie, body: { userId: bob.id } });
  const conversationId = conversation.data.id;
  const sender = await connect(alice), recipient = await connect(bob);
  instance.db.prepare('UPDATE sessions SET expires=? WHERE user_id=?').run(Date.now() - 1000, bob.id);
  const rejectedRest = await request('/api/me', { cookie: bob.cookie });
  assert.equal(rejectedRest.status, 401);
  const receive = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Recipient did not receive the probe message')), 2000);
    recipient.once('message', message => { clearTimeout(timer); resolve(message); });
  });
  const clientId = 'audit-expired-session-message';
  const envelope = await encryptPayload(alice.identity, bob.identity.record, conversationId, alice.id, clientId, { kind: 'text', text: 'Synthetic expiry test' });
  const sent = await new Promise((resolve, reject) => sender.timeout(2000).emit('message:send', { conversationId, clientId, envelope }, (error, data) => error ? reject(error) : resolve(data)));
  assert.equal(sent.ok, true);
  const message = await receive;
  const plain = await decryptPayload(bob.identity, alice.identity.record, message, bob.id);
  assert.equal(plain.text, 'Synthetic expiry test');
  result.probes.expiredSocketStillReceives = { restStatusAfterExpiry: rejectedRest.status, socketConnected: recipient.connected, newCiphertextReceivedAndDecrypted: true, confirmed: true };

  // Two tiny orphan uploads establish retention without filling the disk.
  for (let n = 0; n < 2; n++) {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(17)], { type: 'application/octet-stream' }), 'encrypted.bin');
    assert.equal((await request(`/api/conversations/${conversationId}/images`, { cookie: alice.cookie, body: form })).status, 201);
  }
  assert.equal(instance.db.prepare('SELECT count(*) AS n FROM media').get().n, 2);
  result.probes.orphanMediaRetention = { unusedUploadsAcceptedAndRetained: 2, uploadedBytes: 34, configuredLimitPerAccountPerMinute: 30, perFileByteLimit: 2097168, lifetimeQuotaOrExpiry: false, confirmedBy: 'Two uploads plus server code review; no disk exhaustion attempted' };
});

writeFileSync(new URL('./audit-probe-results.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
