import { nativeAvailable, nativeRecovery } from './android.js';
import { createIdentity, recoverIdentity, fingerprint } from './crypto.js';
const $ = id => document.getElementById(id);
const database = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('sembang-e2ee-v1', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('keys');
  req.onerror = () => reject(new Error('Storan kunci pelayar tidak tersedia. Gunakan pelayar biasa dan benarkan storan laman.'));
  req.onsuccess = () => resolve(req.result);
});
export async function stored(key, value) {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction('keys', value === undefined ? 'readonly' : 'readwrite');
    const req = value === undefined ? tx.objectStore('keys').get(key) : tx.objectStore('keys').put(value, key);
    let result; req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(tx.error || new Error('Kunci gagal disimpan.'));
  }); } finally { db.close(); }
}
function showRecovery(code, username) {
  return new Promise(resolve => {
    const dialog = $('recoveryDialog');
    $('recoveryCode').value = code;
    $('copyRecovery').innerHTML = '<svg aria-hidden="true"><use href="#i-copy"/></svg>Salin kod';
    $('recoveryNativeStatus').hidden = true;
    $('copyRecovery').onclick = async () => {
      try {
        if (nativeAvailable()) await nativeRecovery('copyRecovery', code, username);
        else await navigator.clipboard.writeText(code);
        $('copyRecovery').innerHTML = '<svg aria-hidden="true"><use href="#i-check"/></svg>Kod disalin';
      } catch { $('recoveryCode').select(); }
    };
    $('downloadRecovery').onclick = async () => {
      if (nativeAvailable()) {
        $('downloadRecovery').disabled = true;
        try {
          const result = await nativeRecovery('saveRecovery', code, username);
          $('recoveryNativeStatus').textContent = result.message;
        } catch (e) { $('recoveryNativeStatus').textContent = e.message; }
        finally { $('recoveryNativeStatus').hidden = false; $('downloadRecovery').disabled = false; }
        return;
      }
      const blob = new Blob([`Sembang — kod pemulihan @${username}\n\n${code}\n\nSimpan secara peribadi. Kod ini membuka kunci chat pada pelayar/peranti baharu. Jangan hantar kod ini kepada sesiapa.\n`], { type: 'text/plain' });
      const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `sembang-${username}-recovery.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    };
    dialog.oncancel = e => e.preventDefault();
    $('confirmRecovery').onclick = () => { $('recoveryCode').value = ''; dialog.close(); resolve(); };
    dialog.showModal();
  });
}
async function restore(record, api) {
  return new Promise((resolve, reject) => {
    const dialog = $('unlockDialog'); $('unlockCode').value = ''; $('unlockError').hidden = true;
    dialog.oncancel = e => e.preventDefault();
    $('unlockForm').onsubmit = async e => {
      e.preventDefault(); $('unlockSubmit').disabled = true;
      try { const identity = await recoverIdentity(record, $('unlockCode').value); $('unlockCode').value = ''; dialog.close(); resolve(identity); }
      catch (e) { $('unlockError').textContent = e.message; $('unlockError').hidden = false; }
      finally { $('unlockSubmit').disabled = false; }
    };
    $('unlockLogout').onclick = async () => {
      try { await api('/logout', { method: 'POST', body: {} }); dialog.close(); reject(new Error('Log masuk pada pelayar asal atau gunakan kod pemulihan untuk membuka chat.')); }
      catch (e) { $('unlockError').textContent = e.message; $('unlockError').hidden = false; }
    };
    dialog.showModal();
  });
}
export async function unlockIdentity(user, api) {
  if (!crypto.subtle || !window.isSecureContext) throw new Error('Penyulitan memerlukan HTTPS atau localhost.');
  const storageKey = `identity:${user.id}`;
  const remote = await api('/identity');
  const local = await stored(storageKey);
  if (local && remote) {
    if (local.record.fingerprint !== remote.fingerprint || await fingerprint(remote.publicKey) !== remote.fingerprint) throw new Error('Kunci akaun berubah. Akses disekat untuk melindungi chat.');
    if (local.pendingRecovery) {
      await showRecovery(local.pendingRecovery, user.username);
      delete local.pendingRecovery; await stored(storageKey, local);
    }
    return local;
  }
  if (remote) {
    const identity = await restore(remote, api);
    await stored(storageKey, identity); return identity;
  }
  const generated = await createIdentity();
  try { await api('/identity', { method: 'POST', body: generated.record }); }
  catch (e) { if (e.status !== 409) throw e; return unlockIdentity(user, api); }
  const identity = { privateKey: generated.privateKey, record: generated.record, pendingRecovery: generated.recoveryCode };
  // Keep the new key locally before showing the code, so reloading this dialog is recoverable.
  try { await stored(storageKey, identity); }
  catch (e) { await showRecovery(generated.recoveryCode, user.username); throw e; }
  await showRecovery(generated.recoveryCode, user.username);
  delete identity.pendingRecovery;
  await stored(storageKey, identity);
  return identity;
}
export async function pinPeer(myId, peerId, record) {
  if (!record || await fingerprint(record.publicKey) !== record.fingerprint) throw new Error('Kunci penyulitan kenalan tidak sah.');
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
    tx.onabort = tx.onerror = () => reject(new Error(changed ? 'Kunci kenalan berubah. Penghantaran disekat; semak nombor keselamatan.' : 'Kunci kenalan gagal disimpan.'));
  }); } finally { db.close(); }
}
