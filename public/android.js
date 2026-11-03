// Android exposes only recovery-code actions, scoped to the configured main-frame origin.
const pending = new Map();
let installed = false;
export function nativeAvailable() { return typeof window.SembangAndroid?.postMessage === 'function'; }
export function nativeRecovery(action, code, username) {
  if (!nativeAvailable()) return Promise.reject(new Error('Sokongan Android tidak tersedia.'));
  if (!installed) {
    window.SembangAndroid.onmessage = event => {
      try {
        const result = JSON.parse(event.data), entry = pending.get(result.requestId);
        if (!entry) return;
        pending.delete(result.requestId); clearTimeout(entry.timer);
        if (result.ok) entry.resolve(result); else entry.reject(new Error(result.message || 'Tindakan dibatalkan.'));
      } catch { /* Ignore unrelated or malformed native replies. */ }
    };
    installed = true;
  }
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Belum menerima pengesahan Android. Semak simpanan fail atau cuba semula.')); }, 180000);
    pending.set(requestId, { resolve, reject, timer });
    try { window.SembangAndroid.postMessage(JSON.stringify({ action, code, username, requestId })); }
    catch (e) { pending.delete(requestId); clearTimeout(timer); reject(e); }
  });
}
