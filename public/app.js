import { encryptPayload, decryptPayload, encryptAttachment, decryptAttachment, safetyNumber } from './crypto.js';
import { unlockIdentity, pinPeer, forgetPeer } from './vault.js';
import { compressImage, compressAvatar, formatBytes } from './compress.js';
import * as maplibregl from '/vendor/maplibre/maplibre-gl.mjs';
maplibregl.setWorkerUrl('/vendor/maplibre/maplibre-gl-worker.mjs');
const $ = id => document.getElementById(id);
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = name => name.trim().split(/\s+/).filter(x => /^[\p{L}\p{N}]/u.test(x)).slice(0, 2).map(x => x[0]).join('').toUpperCase();
const time = at => new Date(at).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', hour12: false });
const day = at => new Date(at).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' });
const today = at => new Date(at).toDateString() === new Date().toDateString();
const state = { me: null, socket: null, conversations: [], active: null, messages: [], places: [], placeDraft: null, cursor: null, filter: 'all', attachment: null, sending: false, watches: new Map(), call: null, pushEnabled: false, config: { iceServers: [], mapStyleUrl: '', vapidPublicKey: '', nativePushConfigured: false } };
const peers = new Map(), imageCache = new Map(), stoppedEnvelopes = new Map(), locationMaps = new Map(), placeMaps = new Map();
let incomingQueue = Promise.resolve();
const enqueue = fn => { incomingQueue = incomingQueue.then(fn).catch(e => { if (state.me) toast(e.message); }); };
let emailVerificationRequest = null, pendingVaultPassword = null, passwordResetRequest = null, registrationOpen = true;
let authMode = 'register', toastTimer, typingTimer, typingSent = 0, peopleTimer, peopleRequest = 0, conversationRequest = 0, refreshVersion = 0;

const appearanceDefaults = { theme: 'system', background: 'flowers', font: 'system', textSize: 13, bold: false, italic: false };
function appearanceSettings() {
  try { return { ...appearanceDefaults, ...JSON.parse(localStorage.getItem('zbuddy-appearance') || '{}') }; }
  catch { return { ...appearanceDefaults }; }
}
function applyAppearance(settings = appearanceSettings()) {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.chatBackground = ['flowers','plain','dots','dream'].includes(settings.background) ? settings.background : 'flowers';
  document.documentElement.dataset.chatFont = ['system','rounded','serif','mono'].includes(settings.font) ? settings.font : 'system';
  const legacySize = { small: 11, normal: 13, large: 17 }[settings.size];
  document.documentElement.style.setProperty('--chat-text-size', `${Math.min(24, Math.max(11, Number(settings.textSize || legacySize || 13)))}px`);
  document.documentElement.dataset.chatBold = settings.bold ? 'true' : 'false';
  document.documentElement.dataset.chatItalic = settings.italic ? 'true' : 'false';
}
applyAppearance();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (appearanceSettings().theme === 'system') applyAppearance(); });

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4800);
}
async function api(url, options = {}) {
  const init = { credentials: 'same-origin', ...options };
  if (options.body && !(options.body instanceof FormData)) { init.body = JSON.stringify(options.body); init.headers = { 'Content-Type': 'application/json', ...options.headers }; }
  let res;
  try { res = await fetch(`/api${url}`, init); } catch { throw new Error('Could not reach the server. Check your connection.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'The request failed. Try again.'); e.status = res.status; throw e; }
  return data;
}
function emit(event, data) {
  return new Promise((resolve, reject) => {
    if (!state.socket?.connected) return reject(new Error('The connection is not ready. Try again shortly.'));
    state.socket.timeout(12000).emit(event, data, (err, result) => {
      if (err) return reject(new Error('The server did not respond. Try again.'));
      if (!result?.ok) return reject(new Error(result?.error || 'The request failed.'));
      resolve(result);
    });
  });
}
function acknowledgeDelivered(messages) {
  if (!state.socket?.connected || !state.me) return;
  const groups = new Map();
  for (const message of messages) if (message && message.senderId !== state.me.id && !message.deliveredAt) {
    if (!groups.has(message.conversationId)) groups.set(message.conversationId, []);
    groups.get(message.conversationId).push(message.id);
  }
  for (const [conversationId, ids] of groups) for (let i = 0; i < ids.length; i += 100) emit('messages:delivered', { conversationId, messageIds: ids.slice(i, i + 100) }).catch(() => {});
}
const nativePushToken = () => { try { return window.ZbuddyAndroid?.getFcmToken?.() || ''; } catch { return ''; } };
const nativeNotificationsAllowed = () => { try { return window.ZbuddyAndroid?.notificationsAllowed?.() !== false; } catch { return false; } };
const nativePushPreferenceKey = () => `zbuddy-native-push:${state.me?.id || 'signed-out'}`;
const nativePushWanted = () => localStorage.getItem(nativePushPreferenceKey()) !== 'false';
const webPushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pushSupported = () => !!window.ZbuddyAndroid || webPushSupported();
const pushKey = value => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const raw = atob(padded); return Uint8Array.from(raw, character => character.charCodeAt(0));
};
async function pushRegistration() { await navigator.serviceWorker.register('/sw.js', { scope: '/' }); return navigator.serviceWorker.ready; }
async function syncPushSubscription() {
  if (!pushSupported() || !state.me) { state.pushEnabled = false; return; }
  if (window.ZbuddyAndroid) {
    const token = nativePushToken();
    if (!token) { state.pushEnabled = false; return; }
    if (!nativePushWanted()) { await api('/push/devices', { method: 'DELETE', body: { token } }); state.pushEnabled = false; return; }
    await api('/push/devices', { method: 'POST', body: { token, platform: 'android' } });
    state.pushEnabled = state.config.nativePushConfigured && nativeNotificationsAllowed(); return;
  }
  const registration = await pushRegistration(), subscription = await registration.pushManager.getSubscription();
  state.pushEnabled = Notification.permission === 'granted' && !!subscription;
  if (state.pushEnabled) await api('/push/subscriptions', { method: 'POST', body: subscription.toJSON() });
}
async function enablePush() {
  if (window.ZbuddyAndroid) {
    if (!state.config.nativePushConfigured) throw new Error('Android push is not configured on the server yet.');
    if (!nativeNotificationsAllowed()) throw new Error('Enable notifications for Zbuddy in Android Settings.');
    const token = nativePushToken(); if (!token) throw new Error('Firebase is still preparing this device. Reopen Zbuddy and try again.');
    await api('/push/devices', { method: 'POST', body: { token, platform: 'android' } }); localStorage.setItem(nativePushPreferenceKey(), 'true'); state.pushEnabled = true; return;
  }
  if (!webPushSupported()) throw new Error('This browser does not support Web Push.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted. Change it in your browser settings.');
  if (!state.config.vapidPublicKey) throw new Error('Web Push is not available on the server.');
  const registration = await pushRegistration();
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKey(state.config.vapidPublicKey) });
  await api('/push/subscriptions', { method: 'POST', body: subscription.toJSON() }); state.pushEnabled = true;
}
async function disablePush() {
  if (window.ZbuddyAndroid) {
    const token = nativePushToken(); if (token) await api('/push/devices', { method: 'DELETE', body: { token } }); localStorage.setItem(nativePushPreferenceKey(), 'false'); state.pushEnabled = false; return;
  }
  if (!webPushSupported()) return;
  const registration = await navigator.serviceWorker.ready, subscription = await registration.pushManager.getSubscription();
  if (subscription) { await api('/push/subscriptions', { method: 'DELETE', body: { endpoint: subscription.endpoint } }); await subscription.unsubscribe(); }
  state.pushEnabled = false;
}
window.addEventListener('zbuddy:fcm-token', () => { if (state.me) syncPushSubscription().catch(() => { state.pushEnabled = false; }); });
function showDialog(id) { if (!$(id).open) $(id).showModal(); }
function avatarHTML(user, online = false) {
  const photo = user.avatar ? `<img src="${escapeHTML(user.avatar)}" alt="" loading="lazy">` : escapeHTML(initials(user.name));
  return `<span class="avatar" style="background:${escapeHTML(user.color)}">${photo}${online ? '<span class="online-dot"></span>' : ''}</span>`;
}
function avatar(el, user) {
  el.style.background = user.color; el.replaceChildren();
  if (user.avatar) { const img = document.createElement('img'); img.src = user.avatar; img.alt = ''; el.append(img); }
  else el.textContent = initials(user.name);
}
function destroyLocationMaps() { for (const entry of locationMaps.values()) entry.map.remove(); locationMaps.clear(); }
function destroyPlaceMaps() { for (const map of placeMaps.values()) map.remove(); placeMaps.clear(); }
function mountPlaceMaps() {
  if (!state.config.mapStyleUrl) return;
  document.querySelectorAll('[data-place-map]').forEach(container => {
    const place = state.places.find(item => item.id === container.dataset.placeMap);
    if (!place?.secure || placeMaps.has(place.id)) return;
    try {
      const center = [place.body.longitude, place.body.latitude];
      const map = new maplibregl.Map({ container, style: state.config.mapStyleUrl, center, zoom: 13.5, attributionControl: false, interactive: true });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
      new maplibregl.Marker({ color: '#8d67af' }).setLngLat(center).addTo(map); placeMaps.set(place.id, map);
    } catch { container.textContent = 'The map could not be loaded'; }
  });
}
function mountLocationMaps() {
  if (!state.config.mapStyleUrl) return;
  document.querySelectorAll('[data-location-map]').forEach(container => {
    const message = state.messages.find(item => item.id === container.dataset.locationMap);
    if (!message || locationMaps.has(message.id)) return;
    try {
      const center = [message.body.longitude, message.body.latitude];
      const map = new maplibregl.Map({ container, style: state.config.mapStyleUrl, center, zoom: 14.5, attributionControl: false });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
      const marker = new maplibregl.Marker({ color: '#175c46' }).setLngLat(center).addTo(map);
      locationMaps.set(message.id, { map, marker });
    } catch {
      container.classList.add('map-failed'); container.textContent = 'The map could not be loaded';
    }
  });
}
function refreshLocationMap(message) {
  const entry = locationMaps.get(message.id), row = document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
  if (!entry || !row || !message.body.active || message.body.expires <= Date.now()) return false;
  const center = [message.body.longitude, message.body.latitude];
  entry.marker.setLngLat(center); entry.map.easeTo({ center, duration: 600 });
  const coordinate = row.querySelector('.map-coordinate');
  if (coordinate) coordinate.textContent = `${message.body.latitude.toFixed(5)}, ${message.body.longitude.toFixed(5)}`;
  const details = row.querySelector('[data-location-details]');
  if (details) details.textContent = `Until ${time(message.body.expires)} · ${Date.now() - message.body.updated > 60000 ? 'Last location ' : 'Updated '}${time(message.body.updated)}${message.body.accuracy != null ? ` · ±${Math.round(message.body.accuracy)} m` : ''}`;
  return true;
}
function needAccount(fn) { if (!state.me) { showDialog('authDialog'); return; } fn(); }
function currentConversation() { return state.conversations.find(c => c.id === state.active); }
function setAuthMode(mode) {
  if (mode === 'register' && !registrationOpen) mode = 'login';
  authMode = mode;
  const register = mode === 'register';
  $('registerTab').classList.toggle('active', register);
  $('loginTab').classList.toggle('active', !register);
  $('nameLabel').hidden = !register;
  $('authName').required = register;
  $('emailHelp').hidden = !register;
  $('authTitle').textContent = register ? "Let's get to know you." : 'Welcome back.';
  $('authSubtitle').textContent = register ? 'Create an account and start your story.' : 'Your story is waiting. Pick up where you left off.';
  $('authPassword').autocomplete = register ? 'new-password' : 'current-password';
  $('authPassword').minLength = register ? 8 : 1;
  $('authSubmit').innerHTML = `${register ? 'Get started' : 'Sign in'} ${icon('arrow')}`;
  $('forgotPassword').hidden = register;
  $('authError').hidden = true;
}
$('registerTab').onclick = () => setAuthMode('register');
$('loginTab').onclick = () => setAuthMode('login');
function showActivationPending(message) {
  $('activationMessage').textContent = message || 'Your email is verified. The Zbuddy Owner must activate your account before you can sign in.';
  $('verifyDialog').close(); $('authDialog').close(); showDialog('activationDialog');
}
$('activationDone').onclick = () => { $('activationDialog').close(); setAuthMode('login'); showDialog('authDialog'); };
$('authForm').onsubmit = async e => {
  e.preventDefault();
  $('authSubmit').disabled = true;
  $('authError').hidden = true;
  try {
    const password = $('authPassword').value;
    const user = await api(`/${authMode}`, { method: 'POST', body: { name: $('authName').value, email: $('authEmail').value, password } });
    $('authPassword').value = '';
    if (user.verificationRequired) {
      pendingVaultPassword = password;
      emailVerificationRequest = user.requestId; $('verifyCode').value = ''; $('verifyError').hidden = true;
      $('verifyEmailAddress').textContent = $('authEmail').value.trim();
      showDialog('verifyDialog'); return;
    }
    if (user.activationRequired) { pendingVaultPassword = null; showActivationPending(user.message); return; }
    $('authDialog').close();
    await boot(user, password);
    pendingVaultPassword = null;
    toast(authMode === 'register' ? `Welcome, ${user.name}! Invite your friends to start chatting.` : `Welcome back, ${user.name}.`);
  } catch (err) { pendingVaultPassword = null; $('authError').textContent = err.message; $('authError').hidden = false; showDialog('authDialog'); }
  finally { $('authSubmit').disabled = false; }
};
$('verifyForm').onsubmit = async e => {
  e.preventDefault(); $('verifySubmit').disabled = true; $('verifyError').hidden = true;
  try {
    if (!pendingVaultPassword) throw new Error('The registration session expired. Go back and enter your password again.');
    const user = await api('/verify-email', { method: 'POST', body: { requestId: emailVerificationRequest, code: $('verifyCode').value.trim() } });
    emailVerificationRequest = null; $('verifyCode').value = ''; $('verifyDialog').close(); $('authDialog').close();
    if (user.activationRequired) { pendingVaultPassword = null; showActivationPending(user.message); return; }
    await boot(user, pendingVaultPassword); pendingVaultPassword = null; toast('Email verified. Welcome to Zbuddy.');
  } catch (error) { $('verifyError').textContent = error.message; $('verifyError').hidden = false; }
  finally { $('verifySubmit').disabled = false; }
};
$('verifyBack').onclick = () => { emailVerificationRequest = null; pendingVaultPassword = null; $('verifyCode').value = ''; $('verifyDialog').close(); };
$('forgotPassword').onclick = () => {
  passwordResetRequest = null;
  $('resetEmail').value = $('authEmail').value.trim(); $('resetCode').value = ''; $('resetPassword').value = ''; $('resetErase').checked = false;
  $('resetRequestForm').hidden = false; $('resetConfirmForm').hidden = true; $('resetTitle').textContent = 'Get an email code.';
  $('resetRequestError').hidden = true; $('resetConfirmError').hidden = true; showDialog('resetDialog');
};
$('resetRequestForm').onsubmit = async e => {
  e.preventDefault(); $('resetRequestSubmit').disabled = true; $('resetRequestError').hidden = true;
  try {
    const result = await api('/password/reset/request', { method: 'POST', body: { email: $('resetEmail').value } });
    passwordResetRequest = result.requestId; $('resetRequestForm').hidden = true; $('resetConfirmForm').hidden = false; $('resetTitle').textContent = 'Enter the reset code.'; $('resetCode').focus();
    toast('If that account exists, a reset code has been sent by email.');
  } catch (error) { $('resetRequestError').textContent = error.message; $('resetRequestError').hidden = false; }
  finally { $('resetRequestSubmit').disabled = false; }
};
$('resetConfirmForm').onsubmit = async e => {
  e.preventDefault(); $('resetConfirmSubmit').disabled = true; $('resetConfirmError').hidden = true;
  try {
    const password = $('resetPassword').value;
    const user = await api('/password/reset/confirm', { method: 'POST', body: { requestId: passwordResetRequest, code: $('resetCode').value.trim(), password, confirmErase: $('resetErase').checked } });
    if (user.activationRequired) { passwordResetRequest = null; $('resetDialog').close(); $('resetPassword').value = ''; showActivationPending(user.message); return; }
    passwordResetRequest = null; $('resetDialog').close(); $('authDialog').close(); await boot(user, password);
    $('resetPassword').value = ''; toast('Password reset complete. New chat keys have been created.');
  } catch (error) { $('resetConfirmError').textContent = error.message; $('resetConfirmError').hidden = false; }
  finally { $('resetConfirmSubmit').disabled = false; }
};
$('previewButton').onclick = () => { $('authDialog').close(); $('app').classList.add('preview'); };
for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => $(b.dataset.close).close();
for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', e => {
  if (e.target !== d || d.id === 'callDialog') return;
  const r = d.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
});
$('callDialog').addEventListener('cancel', e => { e.preventDefault(); hangup(); });

async function getPeer(conversationId) {
  if (!peers.has(conversationId)) {
    const me = state.me, identity = state.identity;
    const pending = (async () => {
      const keys = await api(`/conversations/${conversationId}/keys`);
      if (!keys.peer) throw new Error('Your friend must sign in and create their chat key first.');
      if (keys.self?.fingerprint !== identity?.record.fingerprint) throw new Error('Your account key does not match.');
      await pinPeer(me.id, keys.peerId, keys.peer);
      return keys.peer;
    })();
    peers.set(conversationId, pending);
    pending.catch(() => { if (peers.get(conversationId) === pending) peers.delete(conversationId); });
  }
  return peers.get(conversationId);
}
async function sealPayload(id, clientId, payload) {
  return encryptPayload(state.identity, await getPeer(id), id, state.me.id, clientId, payload);
}
async function decodeWire(m) {
  if (!m || m.kind !== 'encrypted') return m ? { ...m, legacy: !m.secure } : m;
  try {
    const payload = await decryptPayload(state.identity, await getPeer(m.conversationId), m, state.me.id);
    if (!['text', 'image', 'location'].includes(payload.kind)) throw new Error();
    const { kind, ...body } = payload;
    if (kind === 'text' && (typeof body.text !== 'string' || body.text.length > 4000)) throw new Error();
    if (kind === 'image' && (!/^\/media\/[a-f0-9-]{36}$/.test(body.url) || !['image/webp','image/png','image/jpeg'].includes(body.mime) || typeof body.key !== 'string' || typeof body.iv !== 'string')) throw new Error();
    if (kind === 'location' && (!Number.isFinite(body.latitude) || !Number.isFinite(body.longitude) || Math.abs(body.latitude) > 90 || Math.abs(body.longitude) > 180 || !Number.isFinite(body.updated) || !Number.isFinite(body.expires))) throw new Error();
    return { ...m, kind, body, secure: true };
  } catch { return { ...m, kind: 'text', body: { text: 'This message could not be opened. Sign in again and check your account key.' }, secure: false, locked: true }; }
}
async function decodePlace(place) {
  try {
    const body = await decryptPayload(state.identity, await getPeer(place.conversationId), place, state.me.id);
    if (body.kind !== 'place' || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80 || typeof body.note !== 'string' || body.note.length > 300 || !Number.isFinite(body.latitude) || !Number.isFinite(body.longitude) || Math.abs(body.latitude) > 90 || Math.abs(body.longitude) > 180) throw new Error();
    return { ...place, body, secure: true };
  } catch { return { ...place, body: { name: 'This encrypted place could not be opened', note: '', latitude: 0, longitude: 0 }, secure: false, locked: true }; }
}
async function imageSource(m) {
  if (!m.secure) return m.body.url;
  if (!imageCache.has(m.body.url)) imageCache.set(m.body.url, (async () => {
    const res = await fetch(m.body.url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('The image could not be loaded.');
    const blob = await decryptAttachment(await res.arrayBuffer(), m.body, `Sembang/v1/image|${m.conversationId}|${m.clientId}`);
    return URL.createObjectURL(blob);
  })().catch(e => { imageCache.delete(m.body.url); throw e; }));
  return imageCache.get(m.body.url);
}
async function sendSecure(id, payload, clientId = crypto.randomUUID()) {
  const envelope = await sealPayload(id, clientId, payload);
  const { message } = await emit('message:send', { conversationId: id, envelope, clientId, ...(payload.kind === 'image' ? { mediaId: payload.url.split('/').pop() } : {}) });
  return decodeWire(message);
}
async function boot(user, password) {
  state.me = user;
  $('app').classList.remove('preview');
  avatar($('profileButton'), user);
  $('profileButton').title = `${user.name} (@${user.username})`;
  state.socket?.disconnect();
  state.identity = await unlockIdentity(user, password, api);
  state.config = await api('/config');
  syncPushSubscription().catch(() => { state.pushEnabled = false; });
  const socket = state.socket = io({ autoConnect: false });
  socket.on('connect', async () => {
    $('connectionDot').classList.remove('offline');
    $('connectionText').textContent = 'Online';
    $('offlineBanner').hidden = true;
    try { await refreshConversations(); if (state.active) await reloadMessages(); } catch (e) { toast(e.message); }
    for (const w of state.watches.values()) if (w.latest) updateLocation(w, w.latest);
  });
  socket.on('disconnect', reason => {
    if (reason === 'io server disconnect') {
      if (state.call) cleanupCall();
      resetSession(); setAuthMode('login'); showDialog('authDialog'); return;
    }
    $('connectionDot').classList.add('offline');
    $('connectionText').textContent = 'Reconnecting…';
    $('offlineBanner').hidden = false;
    if (state.call) cleanupCall('Connection lost');
  });
  socket.on('connect_error', err => {
    if (/sign in/i.test(err.message)) {
      socket.disconnect(); resetSession(); setAuthMode('login'); showDialog('authDialog'); toast('Your session expired. Please sign in again.');
    }
  });
  socket.on('message', m => enqueue(() => onMessage(m)));
  socket.on('identities:changed', () => { peers.clear(); refreshConversations().catch(() => {}); });
  socket.on('identity:reset', ({ userId }) => enqueue(async () => {
    if (!state.me || userId === state.me.id) return;
    peers.clear(); await forgetPeer(state.me.id, userId); await refreshConversations();
    toast('Your friend reset their password. A new security key will be used.');
  }));
  socket.on('message:updated', raw => enqueue(async () => {
    const m = await decodeWire(raw); if (!state.me) return;
    const index = state.messages.findIndex(x => x.id === m.id);
    if (index !== -1) { state.messages[index] = m; if (m.kind !== 'location' || !refreshLocationMap(m)) renderMessages(false); }
    const c = state.conversations.find(x => x.id === m.conversationId);
    if (c?.last?.id === m.id) { c.last = m; renderConversations(); }
    if (m.kind === 'location' && !m.body.active && state.watches.has(m.id)) removeWatch(m.id);
  }));
  socket.on('conversations:changed', () => refreshConversations().catch(e => toast(e.message)));
  socket.on('places:changed', () => { if ($('placesDialog').open) loadPlaces().catch(e => toast(e.message)); });
  socket.on('users:changed', () => {
    refreshConversations().catch(() => {});
    if ($('peopleDialog').open) loadPeople();
    if ($('accountAdminDialog').open && state.me?.role === 'owner') loadAdminUsers().catch(() => {});
  });
  socket.on('presence', ({ userId, online, lastSeen }) => {
    state.conversations.forEach(c => { if (c.peer.id === userId) { c.peer.online = online; if (lastSeen) c.peer.lastSeen = lastSeen; } });
    renderConversations(); renderHeader();
  });
  socket.on('messages:read', ({ conversationId, userId, at }) => {
    if (conversationId === state.active) {
      state.messages.forEach(m => { if (m.senderId !== userId && !m.readAt) { m.deliveredAt ||= at; m.readAt = at; } }); renderMessages(false);
    }
    const c = state.conversations.find(c => c.id === conversationId);
    if (c) { if (userId === state.me.id) c.unread = 0; if (c.last && c.last.senderId !== userId) { c.last.deliveredAt ||= at; c.last.readAt ||= at; } renderConversations(); }
  });
  socket.on('messages:delivered', ({ conversationId, messageIds, at }) => {
    const ids = new Set(messageIds || []);
    if (conversationId === state.active) { state.messages.forEach(m => { if (ids.has(m.id)) m.deliveredAt ||= at; }); renderMessages(false); }
    const c = state.conversations.find(c => c.id === conversationId);
    if (c?.last && ids.has(c.last.id)) { c.last.deliveredAt ||= at; renderConversations(); }
  });
  socket.on('typing', d => {
    if (d.conversationId !== state.active) return;
    clearTimeout(typingTimer);
    $('typingIndicator').hidden = !d.active;
    if (d.active) { typingTimer = setTimeout(() => { $('typingIndicator').hidden = true; }, 3500); }
  });
  socket.on('call:incoming', incomingCall);
  socket.on('call:accepted', async d => {
    const call = state.call;
    if (!call || !call.outgoing) return;
    // Assign here as well: the receiver may answer before call:start's acknowledgement arrives.
    if (!call.id) call.id = d.id;
    if (call.id !== d.id) return;
    try { call.accepted = true; setCallStatus('Connecting call…'); await offerCall(); }
    catch (e) { toast(e.message); hangup(); }
  });
  socket.on('call:handled', d => { if (state.call?.id === d.id) cleanupCall(); });
  socket.on('call:signal', d => enqueue(async () => {
    const call = state.call;
    if (!call || call.id !== d.id || !d.clientId?.startsWith(`${call.id}:`) || d.senderId !== call.person.id) return;
    try {
      const plain = await decryptPayload(state.identity, await getPeer(call.conversationId), { conversationId: call.conversationId, senderId: d.senderId, clientId: d.clientId, body: d.envelope }, state.me.id);
      if (plain.kind !== 'signal') throw new Error();
      await handleSignal(plain.signal);
    } catch { toast('The call signal could not be verified. The call was stopped.'); hangup(); }
  }));
  socket.on('call:ended', d => { if (state.call?.id === d.id) cleanupCall(d.reason); });
  socket.connect();
  await refreshConversations();
  const notificationConversation = new URLSearchParams(location.search).get('conversation');
  if (notificationConversation && state.conversations.some(c => c.id === notificationConversation)) {
    history.replaceState(null, '', location.pathname); await openConversation(notificationConversation);
  }
}
function resetSession() {
  for (const id of [...state.watches.keys()]) removeWatch(id);
  state.identity = null; peers.clear(); stoppedEnvelopes.clear();
  destroyLocationMaps(); destroyPlaceMaps();
  for (const promise of imageCache.values()) promise.then(url => URL.revokeObjectURL(url)).catch(() => {});
  imageCache.clear(); $('fullImage').removeAttribute('src'); $('messages').innerHTML = '';
  state.me = null; state.active = null; state.messages = []; state.places = []; state.placeDraft = null; state.conversations = []; state.pushEnabled = false;
  conversationRequest++; refreshVersion++;
  $('app').classList.remove('chat-open');
  $('chatPanel').hidden = true; $('welcome').hidden = false;
  $('offlineBanner').hidden = true; $('connectionText').textContent = 'Secure connection';
  clearAttachment(); renderConversations();
  $('profileButton').replaceChildren(); $('profileButton').textContent = 'S';
}
async function refreshConversations() {
  const version = ++refreshVersion;
  const conversations = await api('/conversations');
  for (const c of conversations) if (c.last) c.last = await decodeWire(c.last);
  if (version !== refreshVersion || !state.me) return;
  state.conversations = conversations;
  renderConversations(); renderHeader();
  acknowledgeDelivered(conversations.map(c => c.last));
}
function preview(m) {
  if (!m) return 'Start your story…';
  const own = m.senderId === state.me?.id ? 'You: ' : '';
  if (m.kind === 'image') return `${own}Image${m.body.caption ? ' · ' + m.body.caption : ''}`;
  if (m.kind === 'location') return `${own}${m.body.active && m.body.expires > Date.now() ? 'Live location' : 'Last location'}`;
  return own + m.body.text;
}
function renderConversations() {
  $('chatCount').textContent = state.conversations.length;
  const unread = state.conversations.reduce((n, c) => n + c.unread, 0);
  $('unreadCount').textContent = unread;
  if (!state.call) document.title = `${unread ? `(${unread}) ` : ''}Zbuddy — Our private space`;
  const q = $('chatSearch').value.toLowerCase();
  const cs = state.conversations.filter(c => `${c.peer.name} ${c.peer.username}`.toLowerCase().includes(q) && (state.filter !== 'unread' || c.unread));
  if (!cs.length) {
    $('conversationList').innerHTML = `<div class="sidebar-empty"><span class="empty-icon">${icon('chat')}</span><h3>${q ? 'No chats found' : state.filter === 'unread' ? 'Everything is read' : 'Your story starts here'}</h3><p>${q ? 'Try another name or find a friend.' : state.filter === 'unread' ? 'You are all caught up.' : 'Find a friend and begin<br>your first conversation.'}</p><button class="text-button" data-new-chat>Start a chat ${icon('arrow')}</button></div>`;
    $('conversationList').querySelector('[data-new-chat]').onclick = openPeople;
    return;
  }
  $('conversationList').innerHTML = cs.map(c => `<button class="conversation-row ${c.id === state.active ? 'selected' : ''}" data-conversation="${c.id}" aria-label="Chat with ${escapeHTML(c.peer.name)}" ${c.id === state.active ? 'aria-current="true"' : ''}>${avatarHTML(c.peer, c.peer.online)}<div class="conversation-summary"><div class="row-top"><h3>${escapeHTML(c.peer.name)}</h3><time>${c.last ? (today(c.last.created) ? time(c.last.created) : new Date(c.last.created).toLocaleDateString('en-MY', { day: 'numeric', month: 'short' })) : ''}</time></div><div class="row-bottom"><p>${escapeHTML(preview(c.last))}</p>${c.unread ? `<span class="unread-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</div></div></button>`).join('');
  $('conversationList').querySelectorAll('[data-conversation]').forEach(b => { b.onclick = () => openConversation(b.dataset.conversation); });
}
function renderHeader() {
  const c = currentConversation(); if (!c) return;
  avatar($('peerAvatar'), c.peer);
  $('peerName').textContent = c.peer.name;
  $('peerStatus').textContent = c.peer.online ? 'Online · ready to chat' : `Last seen ${lastSeenText(c.peer.lastSeen)}`;
  $('peerStatus').classList.toggle('online', c.peer.online);
}
function lastSeenText(at) {
  if (!at) return 'unknown';
  const elapsed = Math.max(0, Date.now() - at), date = new Date(at), yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  if (elapsed < 60000) return 'just now';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)} minutes ago`;
  if (date.toDateString() === new Date().toDateString()) return `today at ${time(at)}`;
  if (date.toDateString() === yesterday.toDateString()) return `yesterday at ${time(at)}`;
  return date.toLocaleString('en-MY', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
async function openConversation(id) {
  const ticket = ++conversationRequest;
  state.active = id; state.messages = []; state.cursor = null;
  clearAttachment(); $('messageInput').value = ''; resizeInput();
  $('welcome').hidden = true; $('chatPanel').hidden = false;
  $('app').classList.add('chat-open'); $('app').classList.remove('preview');
  $('typingIndicator').hidden = true;
  $('messages').innerHTML = '<div class="empty-message">Loading your story…</div>';
  renderHeader(); renderConversations(); updateLocationBar();
  try {
    await reloadMessages(ticket);
    if (ticket === conversationRequest) { await markRead(); if (innerWidth > 760) $('messageInput').focus(); }
  } catch (e) { if (ticket === conversationRequest) { $('messages').innerHTML = '<div class="empty-message">Messages could not be loaded. Reopen the chat to try again.</div>'; toast(e.message); } }
}
async function reloadMessages(ticket = conversationRequest) {
  const id = state.active; if (!id) return;
  const page = await api(`/conversations/${id}/messages`);
  page.messages = await Promise.all(page.messages.map(decodeWire));
  if (state.active !== id || ticket !== conversationRequest) return;
  const combined = new Map(page.messages.map(m => [m.id, m]));
  // Preserve messages that arrived while the history request was in flight.
  state.messages.filter(m => m.created >= (page.messages[0]?.created || 0)).forEach(m => { if (!combined.has(m.id)) combined.set(m.id, m); });
  state.messages = [...combined.values()].sort((a, b) => a.created - b.created);
  state.cursor = page.next;
  renderMessages(true);
  acknowledgeDelivered(page.messages);
  await markRead();
}
async function markRead() {
  const id = state.active;
  if (!id || document.hidden || !state.me) return;
  await api(`/conversations/${id}/read`, { method: 'POST', body: {} });
  const c = state.conversations.find(c => c.id === id);
  if (c) { c.unread = 0; renderConversations(); }
}
$('olderMessages').onclick = async () => {
  const id = state.active, cursor = state.cursor, ticket = conversationRequest;
  if (!cursor) return;
  $('olderMessages').disabled = true;
  try {
    const page = await api(`/conversations/${id}/messages?before=${cursor}`);
    page.messages = await Promise.all(page.messages.map(decodeWire));
    if (ticket !== conversationRequest) return;
    const previousHeight = $('messageArea').scrollHeight;
    const all = new Map([...page.messages, ...state.messages].map(m => [m.id, m]));
    state.messages = [...all.values()]; state.cursor = page.next; renderMessages(false);
    acknowledgeDelivered(page.messages);
    $('messageArea').scrollTop += $('messageArea').scrollHeight - previousHeight;
  } catch (e) { toast(e.message); }
  finally { $('olderMessages').disabled = false; }
};
function linkText(text) {
  return escapeHTML(text).replace(/https?:\/\/[^\s<>]+/g, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}
function messageHTML(m) {
  const mine = m.senderId === state.me.id;
  let content;
  if (m.kind === 'image') content = `<img class="message-image" alt="${escapeHTML(m.body.caption || 'Shared image')}" data-image="${m.id}">${m.body.caption ? `<p class="message-text image-caption">${linkText(m.body.caption)}</p>` : ''}${m.secure ? `<div class="image-compression-label">${icon('lock')} ${formatBytes(m.body.size || 0)} · compressed & encrypted</div>` : ''}`;
  else if (m.kind === 'location') {
    const b = m.body, active = m.secure && b.active && b.expires > Date.now();
    const stale = Date.now() - b.updated > 60000;
    const watching = state.watches.has(m.id);
    const maps = `https://www.google.com/maps/search/?api=1&query=${b.latitude},${b.longitude}`;
    content = `<div class="message-map-wrap"><div class="message-map" data-location-map="${m.id}" aria-label="Interactive location map"></div><span class="map-coordinate">${b.latitude.toFixed(5)}, ${b.longitude.toFixed(5)}</span></div><div class="location-content"><strong>${active ? '<span class="live-dot"></span>' : ''}${active ? 'Live location' : 'Sharing ended'}</strong><p data-location-details>${active ? `Until ${time(b.expires)} · ` : ''}${stale ? 'Last location ' : 'Updated '}${time(b.updated)}${b.accuracy != null ? ` · ±${Math.round(b.accuracy)} m` : ''}</p><a class="location-link" href="${maps}" target="_blank" rel="noopener noreferrer">Open in maps ${icon('external')}</a><button class="text-button save-place" data-save-place="${m.id}">${icon('heart')} Save place</button>${mine && active ? `<button class="stop-location" data-stop-location="${m.id}">Stop sharing</button>${!watching ? `<button class="text-button" data-resume-location="${m.id}">Resume location updates</button>` : ''}` : ''}</div>`;
  } else content = `<p class="message-text">${m.locked ? icon('lock') : ''}${linkText(m.body.text)}</p>`;
  const status = m.readAt ? { cls: 'read', title: 'Read', icon: 'check' } : m.deliveredAt ? { cls: 'delivered', title: 'Delivered', icon: 'check' } : { cls: 'sent', title: 'Sent', icon: 'check-one' };
  return `<div class="message-row ${mine ? 'mine' : ''}" data-message-id="${m.id}"><div class="message-bubble ${m.kind === 'image' || m.kind === 'location' ? 'image-bubble' : ''}">${content}${m.legacy ? '<span class="legacy-label">Legacy message · not encrypted</span>' : ''}<div class="message-meta">${m.secure ? icon('lock') : ''}<time datetime="${new Date(m.created).toISOString()}">${time(m.created)}</time>${mine ? `<span class="delivery-status ${status.cls}" title="${status.title}" aria-label="${status.title}">${icon(status.icon)}</span>` : ''}</div></div></div>`;
}
function scrollMessagesToBottom() {
  const area = $('messageArea'), conversationId = state.active;
  const pin = () => { if (state.active === conversationId && area.isConnected) area.scrollTop = area.scrollHeight; };
  pin();
  requestAnimationFrame(() => { pin(); requestAnimationFrame(pin); });
}
function focusComposer() {
  if (!state.active) return;
  try { $('messageInput').focus({ preventScroll: true }); }
  catch { $('messageInput').focus(); scrollMessagesToBottom(); }
}
function renderMessages(forceBottom) {
  const area = $('messageArea');
  const closeToBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 110;
  const oldTop = area.scrollTop;
  let lastDay = '';
  destroyLocationMaps();
  $('messages').innerHTML = state.messages.length ? state.messages.map(m => {
    const d = day(m.created), label = d !== lastDay ? `<div class="day-marker">${today(m.created) ? 'Today' : d}</div>` : '';
    lastDay = d; return label + messageHTML(m);
  }).join('') : '<div class="empty-message">One “hello” can begin a beautiful story. 👋</div>';
  $('olderMessages').hidden = !state.cursor;
  $('messages').querySelectorAll('[data-image]').forEach(img => {
    const m = state.messages.find(x => x.id === img.dataset.image);
    imageSource(m).then(url => { if (img.isConnected) img.src = url; }).catch(e => { if (img.isConnected) { img.alt = 'Encrypted image could not be opened'; toast(e.message); } });
    img.onclick = async () => { try { $('fullImage').src = await imageSource(m); showDialog('imageDialog'); } catch (e) { toast(e.message); } };
    img.addEventListener('load', () => { if (forceBottom || closeToBottom) scrollMessagesToBottom(); }, { once: true });
  });
  $('messages').querySelectorAll('[data-stop-location]').forEach(b => { b.onclick = () => stopLocation(b.dataset.stopLocation); });
  $('messages').querySelectorAll('[data-resume-location]').forEach(b => { b.onclick = () => resumeLocation(b.dataset.resumeLocation); });
  $('messages').querySelectorAll('[data-save-place]').forEach(b => { b.onclick = () => openSavePlace(b.dataset.savePlace); });
  mountLocationMaps();
  if (forceBottom || closeToBottom) scrollMessagesToBottom(); else area.scrollTop = oldTop;
}
async function onMessage(raw) {
  const m = raw.kind === 'encrypted' ? await decodeWire(raw) : raw;
  if (!state.me) return;
  acknowledgeDelivered([m]);
  if (m.conversationId === state.active && !state.messages.some(x => x.id === m.id)) { state.messages.push(m); renderMessages(m.senderId === state.me.id); markRead().catch(() => {}); }
  const c = state.conversations.find(c => c.id === m.conversationId);
  if (!c) { refreshConversations().catch(e => toast(e.message)); return; }
  const duplicate = c.last?.id === m.id;
  c.last = m;
  if (!duplicate && m.senderId !== state.me.id && (m.conversationId !== state.active || document.hidden)) c.unread++;
  state.conversations.sort((a, b) => (b.last?.created || b.created) - (a.last?.created || a.created));
  renderConversations();
}
$('chatSearch').oninput = renderConversations;
for (const b of document.querySelectorAll('[data-filter]')) b.onclick = () => {
  state.filter = b.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('active', x === b));
  renderConversations();
};
$('backButton').onclick = () => { $('app').classList.remove('chat-open'); state.active = null; conversationRequest++; destroyLocationMaps(); $('chatPanel').hidden = true; $('welcome').hidden = false; renderConversations(); };
$('railChats').onclick = () => { $('app').classList.remove('preview', 'chat-open'); };
const profileItem = (label, value, link) => value ? `<div class="profile-detail"><span>${escapeHTML(label)}</span>${link ? `<a href="${escapeHTML(link)}" target="_blank" rel="noopener noreferrer">${escapeHTML(value)}</a>` : `<p>${escapeHTML(value)}</p>`}</div>` : '';
async function openProfile(userId) {
  $('profileBody').innerHTML = '<p class="people-empty">Loading profile…</p>'; $('profileMessage').hidden = true; showDialog('profileDialog');
  try {
    const user = await api(`/users/${encodeURIComponent(userId)}/profile`), p = user.profile || {};
    const conversation = state.conversations.find(item => item.peer.id === user.id);
    let security = '';
    if (conversation) {
      try {
        const peer = await getPeer(conversation.id), number = await safetyNumber(state.identity.record.fingerprint, peer.fingerprint, conversation.id);
        security = `<section class="profile-security"><h3>${icon('lock')} End-to-end encryption</h3><p>Compare this safety number with your friend through another channel.</p><div class="safety-number">${number}</div></section>`;
      } catch {}
    }
    const details = [
      profileItem('Occupation', p.occupation), profileItem('Phone', p.phone, p.phone ? `tel:${p.phone.replace(/[^+0-9]/g, '')}` : ''),
      profileItem('Home address', p.address), profileItem('Birthday', p.birthday),
      profileItem('TikTok', p.tiktok ? `@${p.tiktok}` : '', p.tiktok ? `https://www.tiktok.com/@${encodeURIComponent(p.tiktok)}` : ''),
      profileItem('Instagram', p.instagram ? `@${p.instagram}` : '', p.instagram ? `https://www.instagram.com/${encodeURIComponent(p.instagram)}/` : ''),
      profileItem('Facebook', p.facebook), profileItem('Website', p.website, p.website),
    ].join('');
    $('profileBody').innerHTML = `<div class="profile-hero">${avatarHTML(user)}<div><h3>${escapeHTML(user.name)}</h3><p>@${escapeHTML(user.username)}</p></div></div>${p.bio ? `<p class="profile-bio">${escapeHTML(p.bio)}</p>` : ''}<div class="profile-details">${details || '<p class="profile-empty">No profile details have been added yet.</p>'}</div>${security}`;
    if (user.id !== state.me.id) {
      $('profileMessage').hidden = false;
      $('profileMessage').onclick = async () => {
        $('profileMessage').disabled = true;
        try { const chat = await api('/conversations', { method: 'POST', body: { userId: user.id } }); await refreshConversations(); $('profileDialog').close(); await openConversation(chat.id); }
        catch (error) { toast(error.message); }
        finally { $('profileMessage').disabled = false; }
      };
    }
  } catch (error) { $('profileBody').innerHTML = `<p class="form-error">${escapeHTML(error.message)}</p>`; }
}
async function openPeople() {
  if (!state.me) { showDialog('authDialog'); return; }
  $('app').classList.remove('preview');
  $('peopleSearch').value = ''; showDialog('peopleDialog'); await loadPeople();
}
async function loadPeople() {
  const ticket = ++peopleRequest;
  $('peopleList').innerHTML = '<p class="people-empty">Looking for friends…</p>';
  try {
    const users = await api(`/users?q=${encodeURIComponent($('peopleSearch').value)}`);
    if (ticket !== peopleRequest) return;
    $('peopleList').innerHTML = users.length ? users.map(u => `<div class="person-row">${avatarHTML(u, u.online)}<button class="person-main" data-person="${u.id}"><span><b>${escapeHTML(u.name)}</b><small>@${escapeHTML(u.username)}</small></span>${icon('arrow')}</button><button class="person-profile" data-profile="${u.id}" title="View profile" aria-label="View ${escapeHTML(u.name)} profile">${icon('info')}</button></div>`).join('') : '<p class="people-empty">No approved friends found.</p>';
    $('peopleList').querySelectorAll('[data-person]').forEach(b => { b.onclick = async () => {
      b.disabled = true;
      try { const c = await api('/conversations', { method: 'POST', body: { userId: b.dataset.person } }); await refreshConversations(); $('peopleDialog').close(); await openConversation(c.id); }
      catch (e) { toast(e.message); } finally { b.disabled = false; }
    }; });
    $('peopleList').querySelectorAll('[data-profile]').forEach(button => { button.onclick = () => openProfile(button.dataset.profile); });
  } catch (e) { if (ticket === peopleRequest) $('peopleList').textContent = e.message; }
}
$('peopleSearch').oninput = () => { clearTimeout(peopleTimer); peopleTimer = setTimeout(loadPeople, 200); };
for (const id of ['newChat', 'emptyNewChat', 'welcomeStart', 'railPeople']) $(id).onclick = openPeople;
$('inviteButton').onclick = async () => {
  try { await navigator.clipboard.writeText(location.origin); toast('Link copied. Send it to a friend so they can request an account.'); }
  catch { showInfo('Invite a friend', `<p>Share this link with a friend. After registration, the Owner must activate their account.</p><p><a href="${escapeHTML(location.origin)}">${escapeHTML(location.origin)}</a></p><p>If this is a localhost link, it can only be opened on this computer.</p>`); }
};
$('themeButton').onclick = () => {
  const settings = appearanceSettings();
  $('appearanceTheme').value = settings.theme; $('appearanceBackground').value = settings.background;
  $('appearanceFont').value = settings.font; $('appearanceTextSize').value = settings.textSize || ({ small: 11, normal: 13, large: 17 }[settings.size] || 13);
  $('appearanceSizeValue').textContent = `${$('appearanceTextSize').value}px`; $('appearanceBold').checked = !!settings.bold; $('appearanceItalic').checked = !!settings.italic;
  showDialog('appearanceDialog');
};
for (const id of ['appearanceTheme','appearanceBackground','appearanceFont','appearanceTextSize','appearanceBold','appearanceItalic']) $(id).oninput = () => {
  const settings = { theme: $('appearanceTheme').value, background: $('appearanceBackground').value, font: $('appearanceFont').value, textSize: Number($('appearanceTextSize').value), bold: $('appearanceBold').checked, italic: $('appearanceItalic').checked };
  $('appearanceSizeValue').textContent = `${settings.textSize}px`;
  localStorage.setItem('zbuddy-appearance', JSON.stringify(settings)); applyAppearance(settings);
};
function openSavePlace(messageId) {
  const message = state.messages.find(item => item.id === messageId && item.kind === 'location');
  if (!message) return;
  state.placeDraft = message; $('placeName').value = ''; $('placeNote').value = ''; showDialog('savePlaceDialog'); $('placeName').focus();
}
$('savePlaceForm').onsubmit = async event => {
  event.preventDefault();
  const message = state.placeDraft, name = $('placeName').value.trim(), note = $('placeNote').value.trim();
  if (!message || !name) return;
  $('savePlaceSubmit').disabled = true;
  try {
    const clientId = crypto.randomUUID();
    const payload = { kind: 'place', name, note, latitude: message.body.latitude, longitude: message.body.longitude, sourceMessageId: message.id, savedAt: Date.now() };
    const envelope = await sealPayload(message.conversationId, clientId, payload);
    await api('/places', { method: 'POST', body: { conversationId: message.conversationId, clientId, envelope } });
    state.placeDraft = null; $('savePlaceDialog').close(); toast(`“${name}” was added to Saved places.`);
  } catch (error) { toast(error.message); }
  finally { $('savePlaceSubmit').disabled = false; }
};
async function loadPlaces() {
  destroyPlaceMaps();
  $('placesList').innerHTML = '<p class="places-empty">Loading places…</p>';
  const rows = await api('/places');
  state.places = await Promise.all(rows.map(decodePlace));
  if (!state.places.length) { $('placesList').innerHTML = `<div class="places-empty">${icon('pin')}<b>No saved places yet.</b><span>Open a location in chat and tap “Save place”.</span></div>`; return; }
  $('placesList').innerHTML = state.places.map(place => {
    const mine = place.senderId === state.me.id, conversation = state.conversations.find(c => c.id === place.conversationId);
    const owner = mine ? 'You' : (conversation?.peer.name || 'Your friend');
    const maps = `https://www.google.com/maps/search/?api=1&query=${place.body.latitude},${place.body.longitude}`;
    return `<article class="place-card">${place.secure ? `<div class="place-map" data-place-map="${place.id}" aria-label="Map of ${escapeHTML(place.body.name)}"></div>` : ''}<span class="place-card-pin">${icon('pin')}</span><div class="place-card-copy"><h3>${escapeHTML(place.body.name)}</h3>${place.body.note ? `<p>${escapeHTML(place.body.note)}</p>` : ''}<small>Saved by ${escapeHTML(owner)} · ${day(place.created)}</small>${place.secure ? `<a href="${maps}" target="_blank" rel="noopener noreferrer">Open in maps ${icon('external')}</a>` : ''}</div>${mine ? `<button class="icon-button place-delete" data-delete-place="${place.id}" title="Remove place" aria-label="Remove ${escapeHTML(place.body.name)}">${icon('close')}</button>` : ''}</article>`;
  }).join('');
  mountPlaceMaps();
  $('placesList').querySelectorAll('[data-delete-place]').forEach(button => { button.onclick = async () => {
    if (!confirm('Remove this place from your shared collection?')) return;
    button.disabled = true; try { await api(`/places/${button.dataset.deletePlace}`, { method: 'DELETE' }); await loadPlaces(); } catch (error) { toast(error.message); button.disabled = false; }
  }; });
}
$('railPlaces').onclick = () => needAccount(() => { showDialog('placesDialog'); loadPlaces().catch(error => { $('placesList').textContent = error.message; }); });
$('placesDialog').addEventListener('close', destroyPlaceMaps);
function showInfo(title, body) { $('infoTitle').textContent = title; $('infoBody').innerHTML = body; showDialog('infoDialog'); }
$('infoButton').onclick = () => showInfo('About Zbuddy', '<p>A private community for approved members: chat, photos, voice and video calls, and live location.</p><h3>You are in control.</h3><p>Location is shared only with your permission. Stop it at any time. The camera and microphone are used only during calls.</p><h3>Calls &amp; location</h3><p>Use a browser with camera, microphone, and GPS support over HTTPS or localhost. Both people must keep Zbuddy open to receive calls.</p><p>New messages, photos, locations, saved places, and call signals are encrypted on your device before being sent. Compare the safety number in contact information. On a new device, sign in with your email and password to unlock your chat key.</p><p>Stitch &amp; Angel wallpaper by burnss on <a href="https://wallpapers.com/wallpapers/love-stitch-and-angel-900-x-1599-wallpaper-loyrl6n1ouddysi0.html" target="_blank" rel="noopener noreferrer">Wallpapers.com</a>.</p>');
function openProfileEditor() {
  const p = state.me.profile || {};
  for (const [id, key] of [['profileBio','bio'],['profileOccupation','occupation'],['profilePhone','phone'],['profileAddress','address'],['profileBirthday','birthday'],['profileTikTok','tiktok'],['profileInstagram','instagram'],['profileFacebook','facebook'],['profileWebsite','website']]) $(id).value = p[key] || '';
  $('profileEditError').hidden = true; showDialog('profileEditDialog');
}
$('profileEditForm').onsubmit = async event => {
  event.preventDefault(); $('profileSave').disabled = true; $('profileEditError').hidden = true;
  try {
    state.me = await api('/me/profile', { method: 'PATCH', body: { bio: $('profileBio').value, occupation: $('profileOccupation').value, phone: $('profilePhone').value, address: $('profileAddress').value, birthday: $('profileBirthday').value, tiktok: $('profileTikTok').value, instagram: $('profileInstagram').value, facebook: $('profileFacebook').value, website: $('profileWebsite').value } });
    $('profileEditDialog').close(); showProfile(); toast('Profile updated.');
  } catch (error) { $('profileEditError').textContent = error.message; $('profileEditError').hidden = false; }
  finally { $('profileSave').disabled = false; }
};
async function loadAdminUsers() {
  $('accountAdminList').innerHTML = '<p class="people-empty">Loading accounts…</p>';
  const users = await api('/admin/users');
  $('accountAdminList').innerHTML = users.map(user => `<article class="account-admin-row">${avatarHTML(user)}<div><b>${escapeHTML(user.name)}</b><span>${escapeHTML(user.email || user.username)}</span><small>${user.role === 'owner' ? 'Owner' : user.activated ? `Active · ${user.activeSessions} session${user.activeSessions === 1 ? '' : 's'}` : user.emailVerified ? 'Waiting for activation' : 'Email not verified'}</small></div>${user.role === 'owner' ? '<strong>OWNER</strong>' : `<button class="${user.activated ? 'secondary' : 'primary'}" data-account="${user.id}" data-activate="${user.activated ? 'false' : 'true'}">${user.activated ? 'Deactivate' : 'Activate'}</button>`}</article>`).join('');
  $('accountAdminList').querySelectorAll('[data-account]').forEach(button => { button.onclick = async () => {
    const activate = button.dataset.activate === 'true';
    if (!activate && !confirm('Deactivate this account? It will be signed out on every device.')) return;
    button.disabled = true;
    try { await api(`/admin/users/${button.dataset.account}/activation`, { method: 'PATCH', body: { activated: activate } }); await loadAdminUsers(); toast(activate ? 'Account activated.' : 'Account deactivated.'); }
    catch (error) { toast(error.message); button.disabled = false; }
  }; });
}
function showProfile() {
  const u = state.me;
  const available = window.ZbuddyAndroid ? state.config.nativePushConfigured : webPushSupported();
  const notification = available ? `<div class="notification-setting"><div><h3>Message notifications</h3><p>${state.pushEnabled ? 'Enabled on this device.' : 'Receive notifications without revealing message text.'}</p></div><button class="${state.pushEnabled ? 'secondary' : 'primary'}" id="togglePush">${state.pushEnabled ? 'Disable' : 'Enable'}</button></div>` : '<p class="notification-unavailable">Push notifications are not configured for this device yet.</p>';
  showInfo('Your account', `<div class="profile-photo">${avatarHTML(u)}<div><button class="primary profile-photo-button" id="changeAvatar">Change photo</button>${u.avatar ? '<button class="text-button remove-avatar" id="removeAvatar">Remove photo</button>' : ''}</div></div><h3>${escapeHTML(u.name)}</h3><p>@${escapeHTML(u.username)} · ${u.role === 'owner' ? 'Owner' : 'Member'}</p>${u.email ? `<p class="account-email">${escapeHTML(u.email)}</p>` : ''}<p>Approved friends can find you using this username.</p><button class="secondary profile-action" id="editProfile">Edit profile details</button>${u.role === 'owner' ? '<button class="secondary profile-action" id="manageAccounts">Manage account activation</button>' : ''}${notification}<button class="logout-button" id="logoutButton">${icon('logout')} Sign out</button>`);
  $('changeAvatar').onclick = () => $('avatarInput').click();
  $('editProfile').onclick = openProfileEditor;
  if ($('manageAccounts')) $('manageAccounts').onclick = () => { showDialog('accountAdminDialog'); loadAdminUsers().catch(error => { $('accountAdminList').innerHTML = `<p class="form-error">${escapeHTML(error.message)}</p>`; }); };
  if ($('togglePush')) $('togglePush').onclick = async () => {
    $('togglePush').disabled = true;
    try { if (state.pushEnabled) await disablePush(); else await enablePush(); showProfile(); toast(state.pushEnabled ? 'Push notifications enabled.' : 'Push notifications disabled.'); }
    catch (error) { toast(error.message); if ($('togglePush')) $('togglePush').disabled = false; }
  };
  if ($('removeAvatar')) $('removeAvatar').onclick = async () => {
    if (!confirm('Remove your profile photo?')) return;
    $('removeAvatar').disabled = true;
    try { state.me = await api('/me/avatar', { method: 'DELETE' }); avatar($('profileButton'), state.me); showProfile(); toast('Profile photo removed.'); }
    catch (error) { toast(error.message); if ($('removeAvatar')) $('removeAvatar').disabled = false; }
  };
  $('logoutButton').onclick = async () => {
    $('logoutButton').disabled = true;
    try { await stopAllLocations(); if (state.call) await hangup(); if (state.pushEnabled) { try { await disablePush(); } catch {} } await api('/logout', { method: 'POST', body: {} }); state.socket?.disconnect(); resetSession(); $('infoDialog').close(); setAuthMode('login'); showDialog('authDialog'); }
    catch (e) { toast(e.message); if ($('logoutButton')) $('logoutButton').disabled = false; }
  };
}
$('profileButton').onclick = () => needAccount(showProfile);
$('avatarInput').onchange = async () => {
  const file = $('avatarInput').files[0]; $('avatarInput').value = ''; if (!file) return;
  const button = $('changeAvatar'); if (button) button.disabled = true;
  try {
    toast('Preparing your profile photo…');
    const blob = await compressAvatar(file), body = new FormData(); body.append('avatar', blob, 'avatar.webp');
    state.me = await api('/me/avatar', { method: 'POST', body });
    avatar($('profileButton'), state.me); showProfile(); toast('Profile photo updated.');
  } catch (error) { toast(error.message); if ($('changeAvatar')) $('changeAvatar').disabled = false; }
};
$('peerInfo').onclick = () => { const c = currentConversation(); if (c) openProfile(c.peer.id); };
$('peerAvatar').onclick = $('peerName').onclick = () => { const c = currentConversation(); if (c) openProfile(c.peer.id); };

function resizeInput() { const input = $('messageInput'); input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; $('charCount').textContent = input.value.length > 3500 ? `${input.value.length}/4000` : ''; }
$('messageInput').oninput = () => {
  resizeInput();
  if (state.active && Date.now() - typingSent > 1300) { typingSent = Date.now(); emit('typing', { conversationId: state.active, active: true }).catch(() => {}); }
};
$('messageInput').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); } };
$('composer').onsubmit = async e => {
  e.preventDefault();
  const originalInput = $('messageInput').value, text = originalInput.trim(), id = state.active;
  if ((!text && !state.attachment) || !id || state.sending || state.compressing) return;
  state.sending = true; $('sendButton').disabled = true; $('messageInput').setAttribute('aria-busy', 'true');
  const attachment = state.attachment;
  try {
    await getPeer(id);
    const retry = state.retry;
    const clientId = retry?.id === id && retry.text === text && retry.attachment === attachment ? retry.clientId : crypto.randomUUID();
    state.retry = { id, text, attachment, clientId };
    let payload;
    if (attachment) {
      if (!attachment.uploaded) {
        const encrypted = await encryptAttachment(attachment.blob, `Sembang/v1/image|${id}|${clientId}`);
        const body = new FormData(); body.append('image', encrypted.blob, 'encrypted.bin');
        const uploaded = await api(`/conversations/${id}/images`, { method: 'POST', body, headers: { 'X-Message-Id': clientId } });
        attachment.uploaded = { conversationId: id, clientId, url: uploaded.url, key: encrypted.key, iv: encrypted.iv };
      }
      const a = attachment.uploaded;
      if (a.conversationId !== id || a.clientId !== clientId) throw new Error('Select the image again for this chat.');
      payload = { kind: 'image', url: a.url, key: a.key, iv: a.iv, caption: text, name: attachment.name, mime: attachment.mime, size: attachment.size, originalSize: attachment.originalSize, width: attachment.width, height: attachment.height };
    } else payload = { kind: 'text', text };
    const message = await sendSecure(id, payload, clientId); await onMessage(message); state.retry = null;
    if (state.active === id) {
      if ($('messageInput').value === originalInput) $('messageInput').value = '';
      if (state.attachment === attachment) clearAttachment();
      resizeInput(); scrollMessagesToBottom();
    }
    emit('typing', { conversationId: id, active: false }).catch(() => {});
  } catch (err) {
    if (attachment && /image upload.*expired/i.test(err.message)) { delete attachment.uploaded; state.retry = null; }
    toast(err.message);
  }
  finally { state.sending = false; $('sendButton').disabled = false; $('messageInput').removeAttribute('aria-busy'); if (state.active === id) focusComposer(); }
};
$('imageButton').onclick = () => $('imageInput').click();
let attachmentVersion = 0;
$('imageInput').onchange = async () => {
  const file = $('imageInput').files[0]; if (!file) return;
  clearAttachment(); const version = attachmentVersion;
  state.compressing = true; $('imageButton').disabled = true; $('sendButton').disabled = true;
  toast('Compressing the image on your device…');
  try {
    const result = await compressImage(file);
    if (version !== attachmentVersion) return;
    state.attachment = { ...result, url: URL.createObjectURL(result.blob) };
    $('attachmentImage').src = state.attachment.url; $('attachmentName').textContent = result.name;
    const saved = Math.max(0, Math.round((1 - result.size / result.originalSize) * 100));
    $('compressionInfo').textContent = `${formatBytes(result.originalSize)} → ${formatBytes(result.size)}${saved ? ` · saved ${saved}%` : ''} · ${result.width}×${result.height}${result.still ? ' · GIF converted to a still image' : ''}`;
    $('attachmentPreview').hidden = false; $('messageInput').focus(); toast('Image ready. It will be encrypted before sending.');
  } catch (e) { toast(e.message); }
  finally { state.compressing = false; $('imageButton').disabled = false; $('sendButton').disabled = false; }
};
function clearAttachment() { attachmentVersion++; if (state.attachment) URL.revokeObjectURL(state.attachment.url); state.attachment = null; $('attachmentPreview').hidden = true; $('attachmentImage').removeAttribute('src'); $('imageInput').value = ''; }
$('removeAttachment').onclick = clearAttachment;
const emojis = ['😊','😂','❤️','👍','👋','🥰','🎉','🙏','😍','🔥','😎','🤔','😭','✨','💚','👌','🙌','☕','🌻','🥳','💯','🤗','👀','🚀'];
$('emojiPicker').innerHTML = emojis.map(e => `<button type="button" aria-label="${e}">${e}</button>`).join('');
$('emojiButton').onclick = () => { $('emojiPicker').hidden = !$('emojiPicker').hidden; };
$('emojiPicker').querySelectorAll('button').forEach(b => { b.onclick = () => {
  const t = $('messageInput'); if (t.value.length + b.textContent.length > 4000) return;
  t.setRangeText(b.textContent, t.selectionStart, t.selectionEnd, 'end'); resizeInput(); t.focus(); $('emojiPicker').hidden = true;
}; });
document.addEventListener('click', e => { if (!e.target.closest('#emojiButton, #emojiPicker')) $('emojiPicker').hidden = true; });

function geolocationError(err) { return err.code === 1 ? 'Location permission was denied. Enable it in your browser settings.' : err.code === 2 ? 'Your location could not be determined. Make sure GPS is on.' : 'Location took too long. Try again.'; }
function ensureLocation() {
  if (!window.isSecureContext) throw new Error('Live location requires HTTPS or localhost.');
  if (!navigator.geolocation) throw new Error('This browser does not support location.');
}
function getPosition() { return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, e => reject(new Error(geolocationError(e))), { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 })); }
const coords = p => ({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy });
$('locationButton').onclick = () => { if (state.active) showDialog('locationDialog'); };
$('startLocation').onclick = async () => {
  const id = state.active; if (!id) return;
  $('startLocation').disabled = true;
  try {
    ensureLocation();
    const p = await getPosition();
    const message = await sendSecure(id, { kind: 'location', ...coords(p), updated: Date.now(), active: true, expires: Date.now() + Number($('locationDuration').value) * 60000 });
    await prepareStop(message); watchLocation(message); await onMessage(message); $('locationDialog').close(); toast('Live location shared. You can stop it at any time.');
  } catch (err) { toast(err.message); }
  finally { $('startLocation').disabled = false; }
};
function watchLocation(m) {
  if (state.watches.has(m.id)) return;
  const w = { message: m, pending: null, stopping: false, id: m.id, conversationId: m.conversationId, expires: m.body.expires, lastSent: 0, latest: null, watch: null, timer: null };
  state.watches.set(m.id, w);
  w.watch = navigator.geolocation.watchPosition(p => {
    w.latest = p;
    if (Date.now() >= w.expires) { stopLocation(w.id); return; }
    if (Date.now() - w.lastSent >= 5000) updateLocation(w, p);
  }, err => { toast(geolocationError(err)); stopLocation(w.id); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  w.timer = setTimeout(() => stopLocation(w.id), Math.max(0, w.expires - Date.now()));
  updateLocationBar();
}
async function prepareStop(m) {
  const envelope = await sealPayload(m.conversationId, m.clientId, { kind: 'location', ...m.body, active: false });
  stoppedEnvelopes.set(m.id, { id: m.id, envelope });
}
async function updateLocation(w, position) {
  if (!w || w.pending || w.stopping || !state.socket?.connected || !state.watches.has(w.id)) return;
  w.lastSent = Date.now();
  w.pending = (async () => {
    try {
      w.message = { ...w.message, body: { ...w.message.body, ...coords(position), updated: Date.now() } };
      const envelope = await sealPayload(w.conversationId, w.message.clientId, { kind: 'location', ...w.message.body });
      await emit('message:update', { messageId: w.id, envelope }); await prepareStop(w.message);
    } catch (e) { if (/not found/i.test(e.message)) removeWatch(w.id); }
  })();
  try { await w.pending; } finally { w.pending = null; }
}
async function resumeLocation(id) {
  const m = state.messages.find(x => x.id === id); if (!m) return;
  try { ensureLocation(); const p = await getPosition(); await prepareStop(m); watchLocation(m); await updateLocation(state.watches.get(id), p); renderMessages(false); toast('Location updates resumed.'); } catch (e) { toast(e.message); }
}
function removeWatch(id) { const w = state.watches.get(id); if (!w) return; navigator.geolocation.clearWatch(w.watch); clearTimeout(w.timer); state.watches.delete(id); updateLocationBar(); }
async function stopLocation(id) {
  const w = state.watches.get(id);
  if (w) w.stopping = true;
  removeWatch(id);
  try {
    if (w?.pending) await w.pending;
    const m = w?.message || state.messages.find(x => x.id === id);
    if (m) await prepareStop(m);
    const update = stoppedEnvelopes.get(id);
    if (!update) throw new Error('The location key is unavailable.');
    if (state.socket?.connected) await emit('message:update', { messageId: id, envelope: update.envelope });
    else await api('/locations/stop', { method: 'POST', body: { updates: [update] } });
    stoppedEnvelopes.delete(id);
    if (m) m.body.active = false;
    const shown = state.messages.find(x => x.id === id); if (shown) shown.body.active = false;
    if (state.me) renderMessages(false);
  } catch { toast('GPS stopped. The server is unreachable, so the last location may remain until it expires.'); }
}
async function stopAllLocations() { await Promise.all([...state.watches.keys()].map(id => stopLocation(id))); }
function updateLocationBar() { $('locationBar').hidden = ![...state.watches.values()].some(w => w.conversationId === state.active); }
$('stopAllLocations').onclick = () => Promise.all([...state.watches.values()].filter(w => w.conversationId === state.active).map(w => stopLocation(w.id)));
// Browsers may suspend background pages; show the actual timestamp rather than implying continual GPS updates.
setInterval(() => { if (state.active && state.messages.some(m => m.kind === 'location')) renderMessages(false); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.active) { markRead().catch(() => {}); refreshConversations().catch(() => {}); } });
window.addEventListener('pagehide', () => {
  const updates = [...stoppedEnvelopes.values()];
  for (const [id, w] of state.watches) { w.stopping = true; removeWatch(id); }
  if (updates.length) fetch('/api/locations/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updates }), keepalive: true }).catch(() => {});
});

function mediaError(e) {
  if (e.name === 'NotAllowedError') return 'Camera or microphone permission was denied. Enable it in your browser settings.';
  if (e.name === 'NotFoundError') return 'No camera or microphone was found on this device.';
  if (e.name === 'NotReadableError') return 'The camera or microphone is being used by another app.';
  return e.message || 'The calling device is unavailable.';
}
async function getMedia(video) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Calls require HTTPS or localhost and a browser with camera/microphone support.');
  try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false }); }
  catch (e) { throw new Error(mediaError(e)); }
}
function enterCallFullscreen() {
  const dialog = $('callDialog');
  if (!document.fullscreenElement && dialog.requestFullscreen) {
    try { dialog.requestFullscreen({ navigationUI: 'hide' })?.catch(() => {}); } catch {}
  }
}
function updateFullscreenControl() {
  const active = document.fullscreenElement === $('callDialog');
  $('callFullscreen').title = active ? 'Exit full screen' : 'Full screen';
  $('callFullscreen').setAttribute('aria-label', active ? 'Exit full screen' : 'Enter full screen');
}
function updateMicrophoneControl(enabled = true) {
  $('muteCall').classList.toggle('off', !enabled); $('muteCall').innerHTML = icon(enabled ? 'mic' : 'micoff');
  $('muteCall').title = enabled ? 'Mute microphone' : 'Unmute microphone'; $('muteCall').setAttribute('aria-label', $('muteCall').title);
}
function updateCameraControl(enabled = true) {
  const call = state.call;
  if (call) call.videoEnabled = enabled;
  $('toggleCamera').classList.toggle('off', !enabled); $('toggleCamera').innerHTML = icon(enabled ? 'video' : 'cameraoff');
  $('toggleCamera').title = enabled ? 'Pause camera' : 'Resume camera'; $('toggleCamera').setAttribute('aria-label', $('toggleCamera').title);
  $('localVideoWrap').classList.toggle('paused', !enabled); $('localVideoPaused').hidden = enabled;
}
function updateRemoteCamera(enabled = true) {
  $('remoteVideo').classList.toggle('paused', !enabled); $('remoteVideoPaused').hidden = enabled;
}
function showCall(person, video, incoming) {
  avatar($('callAvatar'), person); $('callName').textContent = person.name;
  $('callType').textContent = video ? 'Video call' : 'Voice call';
  $('callStatus').textContent = incoming ? 'Incoming call…' : 'Preparing call…';
  $('acceptCall').hidden = !incoming; $('muteCall').hidden = incoming; $('toggleCamera').hidden = !video || incoming;
  updateMicrophoneControl(true); updateCameraControl(video); updateRemoteCamera(true);
  $('callDialog').classList.remove('connected'); $('callDialog').classList.toggle('video-call', video);
  $('remoteVideo').classList.remove('has-video'); $('localVideo').classList.remove('has-video'); $('callNetworkStatus').hidden = true;
  $('localVideoWrap').hidden = !video; updateFullscreenControl();
  showDialog('callDialog');
  if (video && !incoming) enterCallFullscreen();
}
function setCallStatus(text) { $('callStatus').textContent = text; }
async function startCall(video) {
  const c = currentConversation(); if (!c || state.call) return;
  if (!c.peer.online) { toast('Your friend is offline. Try again when they open Zbuddy.'); return; }
  const call = state.call = { id: null, outgoing: true, video, videoEnabled: video, remoteVideoEnabled: video, person: c.peer, conversationId: c.id, stream: null, pc: null, candidates: [], started: null, timer: null, timeout: null };
  showCall(c.peer, video, false);
  try {
    await getPeer(c.id);
    const stream = await getMedia(video);
    if (state.call !== call) { stream.getTracks().forEach(t => t.stop()); return; }
    call.stream = stream; attachLocalStream(call); createPeer(call);
    const result = await emit('call:start', { conversationId: c.id, video });
    if (state.call !== call) { emit('call:end', { id: result.id }).catch(() => {}); return; }
    call.id = result.id; if (!call.accepted) setCallStatus('Ringing…');
    call.timeout = setTimeout(() => { if (state.call === call && !call.started) { toast('The call could not connect. Check the network or TURN configuration.'); hangup(); } }, 65000);
  } catch (e) { if (state.call === call) { toast(e.message); cleanupCall(); } }
}
function incomingCall(d) {
  if (state.call) { emit('call:end', { id: d.id }).catch(() => {}); return; }
  const call = state.call = { id: d.id, outgoing: false, video: d.video, videoEnabled: d.video, remoteVideoEnabled: d.video, person: d.from, conversationId: d.conversationId, stream: null, pc: null, candidates: [], started: null, timer: null, timeout: null };
  showCall(d.from, d.video, true); document.title = `${d.from.name} is calling — Zbuddy`;
  call.timeout = setTimeout(() => { if (state.call === call && !call.pc) cleanupCall('Missed call'); }, 32000);
}
$('voiceCall').onclick = () => startCall(false);
$('videoCall').onclick = () => startCall(true);
$('acceptCall').onclick = async () => {
  const call = state.call; if (!call || call.outgoing) return;
  $('acceptCall').disabled = true;
  try {
    if (call.video) enterCallFullscreen();
    await getPeer(call.conversationId);
    const stream = await getMedia(call.video);
    if (state.call !== call) { stream.getTracks().forEach(t => t.stop()); return; }
    call.stream = stream; attachLocalStream(call); createPeer(call);
    await emit('call:accept', { id: call.id });
    if (state.call !== call) return;
    clearTimeout(call.timeout); call.timeout = setTimeout(() => { if (!call.started && state.call === call) { toast('The call connection failed. Check the TURN configuration.'); hangup(); } }, 35000);
    $('acceptCall').hidden = true; $('muteCall').hidden = false; $('toggleCamera').hidden = !call.video;
    setCallStatus('Connecting call…');
  } catch (e) { toast(e.message); await hangup(); }
  finally { $('acceptCall').disabled = false; }
};
function attachLocalStream(call) {
  $('localVideo').srcObject = call.stream;
  $('localVideo').classList.toggle('has-video', call.video);
  $('localVideoWrap').hidden = !call.video; updateCameraControl(call.videoEnabled);
}
function createPeer(call) {
  const pc = call.pc = new RTCPeerConnection(state.config);
  call.stream.getTracks().forEach(t => pc.addTrack(t, call.stream));
  pc.onicecandidate = e => { if (e.candidate && call.id && state.call === call) sendCallSignal(call, { candidate: e.candidate.toJSON() }).catch(() => {}); };
  pc.ontrack = e => {
    if (state.call !== call) return;
    $('remoteVideo').srcObject = e.streams[0];
    $('remoteVideo').classList.toggle('has-video', call.video);
    updateRemoteCamera(call.remoteVideoEnabled);
    $('remoteVideo').play().catch(() => { toast('Tap the video to play call audio.'); $('remoteVideo').onclick = () => $('remoteVideo').play(); });
  };
  pc.onconnectionstatechange = () => {
    if (state.call !== call) return;
    if (pc.connectionState === 'connected') {
      clearTimeout(call.timeout); $('callNetworkStatus').hidden = true;
      if (!call.started) {
        call.started = Date.now();
        const tick = () => { const seconds = Math.floor((Date.now() - call.started) / 1000); setCallStatus(`${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`); };
        tick(); call.timer = setInterval(tick, 1000);
      }
      if (call.video) $('callDialog').classList.add('connected');
      if (call.video && call.id) sendCallSignal(call, { media: { video: call.videoEnabled } }).catch(() => {});
    } else if (pc.connectionState === 'disconnected') {
      $('callNetworkStatus').textContent = 'The connection is unstable. Retrying…'; $('callNetworkStatus').hidden = false;
      clearTimeout(call.timeout); call.timeout = setTimeout(() => { if (state.call === call) { toast('The call connection was lost. Try calling again.'); hangup(); } }, 15000);
    } else if (pc.connectionState === 'failed') {
      toast('The call failed to connect. This network may require a TURN server.'); hangup();
    }
  };
}
async function sendCallSignal(call, signal) {
  const clientId = `${call.id}:${crypto.randomUUID()}`;
  const envelope = await sealPayload(call.conversationId, clientId, { kind: 'signal', signal });
  await emit('call:signal', { id: call.id, clientId, envelope });
}
async function offerCall() {
  const call = state.call; if (!call?.pc) return;
  const offer = await call.pc.createOffer(); await call.pc.setLocalDescription(offer);
  await sendCallSignal(call, { description: call.pc.localDescription.toJSON() });
}
async function handleSignal(signal) {
  const call = state.call; if (!call?.pc) return;
  if (signal.media && typeof signal.media.video === 'boolean') {
    call.remoteVideoEnabled = signal.media.video; updateRemoteCamera(call.remoteVideoEnabled);
  } else if (signal.description) {
    await call.pc.setRemoteDescription(signal.description);
    for (const c of call.candidates.splice(0)) await call.pc.addIceCandidate(c);
    if (signal.description.type === 'offer') {
      await call.pc.setLocalDescription(await call.pc.createAnswer());
      await sendCallSignal(call, { description: call.pc.localDescription.toJSON() });
    }
  } else if (signal.candidate) {
    if (call.pc.remoteDescription) await call.pc.addIceCandidate(signal.candidate); else call.candidates.push(signal.candidate);
  }
}
async function hangup() { const id = state.call?.id; cleanupCall(); if (id) try { await emit('call:end', { id }); } catch {} }
function cleanupCall(reason) {
  const call = state.call; if (!call) return;
  state.call = null;
  clearInterval(call.timer); clearTimeout(call.timeout);
  if (call.pc) { call.pc.onconnectionstatechange = null; call.pc.onicecandidate = null; call.pc.ontrack = null; call.pc.close(); }
  call.stream?.getTracks().forEach(t => t.stop());
  $('localVideo').srcObject = null; $('remoteVideo').srcObject = null;
  if (document.fullscreenElement === $('callDialog')) document.exitFullscreen().catch(() => {});
  $('callDialog').close(); $('callDialog').classList.remove('connected', 'video-call');
  renderConversations(); if (reason) toast(reason);
}
$('endCall').onclick = hangup;
$('muteCall').onclick = () => {
  const tracks = state.call?.stream?.getAudioTracks(); if (!tracks?.length) return;
  const enabled = !tracks[0].enabled; tracks.forEach(t => { t.enabled = enabled; });
  updateMicrophoneControl(enabled);
};
$('toggleCamera').onclick = () => {
  const call = state.call, tracks = call?.stream?.getVideoTracks(); if (!tracks?.length) return;
  const enabled = !tracks[0].enabled; tracks.forEach(t => { t.enabled = enabled; }); updateCameraControl(enabled);
  if (call.id) sendCallSignal(call, { media: { video: enabled } }).catch(() => toast('Camera status could not be sent.'));
};
$('callFullscreen').onclick = () => {
  if (document.fullscreenElement === $('callDialog')) document.exitFullscreen().catch(() => {}); else enterCallFullscreen();
};
document.addEventListener('fullscreenchange', updateFullscreenControl);

// Called by the Android system Back action.
window.sembangAndroidBack = () => {
  const modal = document.querySelector('dialog[open]');
  if (modal) {
    if (modal.id === 'callDialog') { hangup(); return true; }
    if (modal.id === 'authDialog') return false;
    modal.close(); return true;
  }
  if ($('app').classList.contains('chat-open')) { $('backButton').click(); return true; }
  return false;
};

(async () => {
  try {
    const auth = await api('/auth/config'); registrationOpen = auth.registrationOpen;
    $('registerTab').hidden = !registrationOpen;
    await boot(await api('/me'));
  }
  catch (e) { resetSession(); setAuthMode(registrationOpen ? 'register' : 'login'); showDialog('authDialog'); if (e.status !== 401) toast(e.message); }
})();
