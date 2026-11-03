// Isolated encrypted sample accounts for browser QA. Never touches the normal data/ folder.
import { createApp } from '../server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIdentity, encryptPayload } from '../public/crypto.js';
const dir = mkdtempSync(path.join(tmpdir(), 'sembang-browser-'));
const instance = createApp({ dataDir: dir });
await new Promise(r => instance.http.listen(3001, '127.0.0.1', r));
const base = 'http://localhost:3001';
async function account(name, username) {
  const r = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, username, email: `${username}@example.com`, password: 'ujian-sembang-123' }) });
  const user = await r.json(), cookie = r.headers.get('set-cookie').split(';')[0], identity = await createIdentity();
  await fetch(`${base}/api/identity`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(identity.record) });
  return { user, cookie, identity };
}
const aina = await account('Aina (Ujian)', 'aina_qa'), danial = await account('Danial (Ujian)', 'danial_qa');
await account('Sara (Ujian)', 'sara_qa');
const r = await fetch(`${base}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: aina.cookie }, body: JSON.stringify({ userId: danial.user.id }) });
const c = await r.json(), now = Date.now();
const insert = instance.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)');
for (const [sender, receiver, text, ago] of [
  [danial, aina, 'Hai Aina! Tema baru ni comel sangat 💜', -240000],
  [aina, danial, 'Kan! Stitch dengan Angel, warna purple soft ✨', -180000],
  [danial, aina, 'Chat kita pun dah end-to-end encrypted sekarang 🔒', -120000],
  [aina, danial, 'Gambar pun auto compress sebelum hantar. Lagi ringan 😊', -60000],
  [danial, aina, 'Jom share gambar petang nanti! 💗', -30000]
]) {
  const clientId = crypto.randomUUID();
  const body = await encryptPayload(sender.identity, receiver.identity.record, c.id, sender.user.id, clientId, { kind: 'text', text });
  insert.run(crypto.randomUUID(), c.id, sender.user.id, 'encrypted', JSON.stringify(body), now + ago, now, clientId);
}
console.log('Browser QA ready: http://localhost:3001 — aina_qa@example.com / ujian-sembang-123');
console.log('Aina QA recovery:', aina.identity.recoveryCode);
console.log('Danial QA recovery:', danial.identity.recoveryCode);
for (const s of ['SIGINT','SIGTERM']) process.once(s, async () => { await instance.close(); rmSync(dir, { recursive: true, force: true }); process.exit(0); });
