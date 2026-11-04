import { createIdentity, recoverIdentity, fingerprint } from './crypto.js';
const database = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('sembang-e2ee-v1', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('keys');
  req.onerror = () => reject(new Error('Browser key storage is unavailable. Use a regular browser window and allow site storage.'));
  req.onsuccess = () => resolve(req.result);
});
export async function stored(key, value) {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction('keys', value === undefined ? 'readonly' : 'readwrite');
    const req = value === undefined ? tx.objectStore('keys').get(key) : tx.objectStore('keys').put(value, key);
    let result; req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(tx.error || new Error('The key could not be saved.'));
  }); } finally { db.close(); }
}
export async function unlockIdentity(user, password, api) {
  if (!crypto.subtle || !window.isSecureContext) throw new Error('Encryption requires HTTPS or localhost.');
  const storageKey = `identity:${user.id}`;
  const remote = await api('/identity');
  const local = await stored(storageKey);
  if (local && remote) {
    if (local.record.fingerprint !== remote.fingerprint || await fingerprint(remote.publicKey) !== remote.fingerprint) throw new Error('The account key changed. Access is blocked to protect your chat.');
    return local;
  }
  if (remote) {
    if (!password) throw new Error('Sign in again to unlock chat on this device.');
    const identity = await recoverIdentity(remote, password);
    await stored(storageKey, identity); return identity;
  }
  if (!password) throw new Error('Sign in again to create the chat key on this device.');
  const generated = await createIdentity(password);
  try { await api('/identity', { method: 'POST', body: generated.record }); }
  catch (e) { if (e.status !== 409) throw e; return unlockIdentity(user, password, api); }
  const identity = { privateKey: generated.privateKey, record: generated.record };
  await stored(storageKey, identity);
  return identity;
}
export async function pinPeer(myId, peerId, record) {
  if (!record || await fingerprint(record.publicKey) !== record.fingerprint) throw new Error('The contact encryption key is invalid.');
  const key = `pin:${myId}:${peerId}`;
  const db = await database();
  try { await new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite'), store = tx.objectStore('keys');
    const req = store.get(key);
    let changed = false;
    req.onsuccess = () => {
      if (req.result && req.result !== record.fingerprint) { changed = true; tx.abort(); }
      else if (!req.result) store.put(record.fingerprint, key);
    };
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(new Error(changed ? 'The contact key changed. Sending is blocked; check the safety number.' : 'The contact key could not be saved.'));
  }); } finally { db.close(); }
}
export async function forgetPeer(myId, peerId) {
  const db = await database();
  try { await new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').delete(`pin:${myId}:${peerId}`);
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('The contact key could not be updated.'));
  }); } finally { db.close(); }
}
