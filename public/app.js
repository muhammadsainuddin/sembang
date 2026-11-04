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
const state = { me: null, socket: null, conversations: [], active: null, messages: [], places: [], placeDraft: null, cursor: null, filter: 'all', attachment: null, reply: null, actionMessage: null, sending: false, watches: new Map(), call: null, pushEnabled: false, config: { iceServers: [], mapStyleUrl: '', vapidPublicKey: '', nativePushConfigured: false } };
const peers = new Map(), imageCache = new Map(), stoppedEnvelopes = new Map(), locationMaps = new Map(), placeMaps = new Map();
let incomingQueue = Promise.resolve();
const enqueue = fn => { incomingQueue = incomingQueue.then(fn).catch(e => { if (state.me) toast(e.message); }); };
let emailVerificationRequest = null, pendingVaultPassword = null, passwordResetRequest = null, registrationOpen = true;
let authMode = 'register', toastTimer, typingTimer, typingSent = 0, peopleTimer, peopleRequest = 0, conversationRequest = 0, refreshVersion = 0;
let bottomPinUntil = 0;

const appearanceDefaults = { theme: 'system', palette: 'purple', background: 'flowers', font: 'system', textSize: 13, bold: false, italic: false, accent: '#8e68ac', mine: '#e8d6f4', peer: '#fffafc' };
const appearancePalettes = {
  purple: { accent:'#8e68ac', deep:'#5d3c73', lime:'#eadcf4', mine:'#ead8f4', peer:'#fffafd', bg:'#faf7fc', panel:'#ffffff', soft:'#f4edf8', text:'#4b3b55', muted:'#8d8195', line:'#ebe1f0' },
  blue: { accent:'#668fb5', deep:'#426987', lime:'#dcecf8', mine:'#dcecf8', peer:'#fbfdff', bg:'#f5f9fc', panel:'#ffffff', soft:'#eaf2f8', text:'#344b5d', muted:'#718697', line:'#dce8f0' },
  green: { accent:'#6f9d82', deep:'#47745b', lime:'#dff0e5', mine:'#dceee3', peer:'#fbfefc', bg:'#f5faf7', panel:'#ffffff', soft:'#eaf4ed', text:'#355044', muted:'#748b80', line:'#dce9e1' },
  grey: { accent:'#7f8994', deep:'#59636d', lime:'#e7eaed', mine:'#e7eaed', peer:'#ffffff', bg:'#f6f7f8', panel:'#ffffff', soft:'#eceff1', text:'#3f464d', muted:'#7d858c', line:'#e0e3e6' }
};
let wallpaperObjectUrl = '';
function appearanceStore() { return new Promise((resolve, reject) => { const request = indexedDB.open('zbuddy-preferences', 1); request.onupgradeneeded = () => request.result.createObjectStore('assets'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
async function wallpaperAsset(value) { const db = await appearanceStore(); return new Promise((resolve, reject) => { const tx = db.transaction('assets', value === undefined ? 'readonly' : 'readwrite'), store = tx.objectStore('assets'), request = value === undefined ? store.get('wallpaper') : value === null ? store.delete('wallpaper') : store.put(value, 'wallpaper'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); tx.oncomplete = () => db.close(); }); }
async function refreshWallpaper() { if (wallpaperObjectUrl) URL.revokeObjectURL(wallpaperObjectUrl), wallpaperObjectUrl = ''; try { const blob = await wallpaperAsset(); if (blob) { wallpaperObjectUrl = URL.createObjectURL(blob); document.documentElement.style.setProperty('--custom-wallpaper', `url("${wallpaperObjectUrl}")`); } else document.documentElement.style.removeProperty('--custom-wallpaper'); } catch {} }
const soundDefaults = { ringtone: 'classic' };
let soundContext = null, soundLoop = null, soundPreviewTimer = null;
function appearanceSettings() {
  try { return { ...appearanceDefaults, ...JSON.parse(localStorage.getItem('zbuddy-appearance') || '{}') }; }
  catch { return { ...appearanceDefaults }; }
}
function applyAppearance(settings = appearanceSettings()) {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.chatBackground = ['flowers','plain','dots','dream','custom'].includes(settings.background) ? settings.background : 'flowers';
  document.documentElement.dataset.chatFont = ['system','rounded','serif','mono'].includes(settings.font) ? settings.font : 'system';
  const legacySize = { small: 11, normal: 13, large: 17 }[settings.size];
  document.documentElement.style.setProperty('--chat-text-size', `${Math.min(24, Math.max(11, Number(settings.textSize || legacySize || 13)))}px`);
  document.documentElement.dataset.chatBold = settings.bold ? 'true' : 'false';
  document.documentElement.dataset.chatItalic = settings.italic ? 'true' : 'false';
  const validColour = value => /^#[0-9a-f]{6}$/i.test(value || ''), preset = appearancePalettes[settings.palette] || appearancePalettes.purple;
  const colours = settings.palette === 'custom' ? { ...preset, accent: validColour(settings.accent) ? settings.accent : preset.accent, mine: validColour(settings.mine) ? settings.mine : preset.mine, peer: validColour(settings.peer) ? settings.peer : preset.peer } : preset;
  for (const [name, value] of Object.entries({ green:colours.accent,'green-deep':colours.deep,lime:colours.lime,bubble:colours.mine,'peer-bubble':colours.peer,bg:colours.bg,panel:colours.panel,soft:colours.soft,text:colours.text,muted:colours.muted,line:colours.line })) document.documentElement.style.setProperty(`--${name}`, value);
  if (settings.background === 'custom') refreshWallpaper();
}
applyAppearance();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (appearanceSettings().theme === 'system') applyAppearance(); });

function soundSettings() {
  try { return { ...soundDefaults, ...JSON.parse(localStorage.getItem('zbuddy-sounds') || '{}') }; }
  catch { return { ...soundDefaults }; }
}
function audioEngine() {
  const AudioEngine = window.AudioContext || window.webkitAudioContext;
  if (!AudioEngine) return null;
  soundContext ||= new AudioEngine();
  if (soundContext.state === 'suspended') soundContext.resume().catch(() => {});
  return soundContext;
}
function playTonePattern(name) {
  const context = audioEngine(); if (!context || name === 'silent') return;
  const patterns = {
    classic: [[0, 440, .24], [.34, 540, .24], [.68, 440, .24]],
    gentle: [[0, 523, .32], [.38, 659, .36]],
    pulse: [[0, 720, .13], [.22, 720, .13], [.58, 620, .18]],
    ringback: [[0, 425, .38], [.48, 425, .38]],
  };
  const now = context.currentTime + .02;
  for (const [offset, frequency, duration] of patterns[name] || patterns.classic) {
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.type = name === 'gentle' ? 'sine' : 'triangle'; oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(.0001, now + offset); gain.gain.exponentialRampToValueAtTime(.045, now + offset + .02); gain.gain.exponentialRampToValueAtTime(.0001, now + offset + duration);
    oscillator.connect(gain).connect(context.destination); oscillator.start(now + offset); oscillator.stop(now + offset + duration + .03);
  }
}
function stopCallSound() {
  clearInterval(soundLoop); soundLoop = null;
  try { window.ZbuddyAndroid?.stopRingtone?.(); } catch {}
}
function startWebCallSound(name) {
  stopCallSound(); if (name === 'silent') return;
  playTonePattern(name); soundLoop = setInterval(() => playTonePattern(name), name === 'ringback' ? 3200 : 2500);
}
function startIncomingRingtone() {
  stopCallSound();
  try { if (window.ZbuddyAndroid?.startRingtone) { window.ZbuddyAndroid.startRingtone(); return; } } catch {}
  startWebCallSound(soundSettings().ringtone);
}
function startOutgoingRingback() { startWebCallSound('ringback'); }
document.addEventListener('pointerdown', () => audioEngine(), { once: true, passive: true });

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
let locationMapObserver, placeMapObserver, combinedLocationEntry = null;
function destroyCombinedLocationMap() { if (combinedLocationEntry) combinedLocationEntry.map.remove(); combinedLocationEntry = null; $('combinedLiveMap')?.replaceChildren(); }
function destroyLocationMaps() { locationMapObserver?.disconnect(); locationMapObserver = null; for (const entry of locationMaps.values()) entry.map.remove(); locationMaps.clear(); }
function destroyPlaceMaps() { placeMapObserver?.disconnect(); placeMapObserver = null; for (const map of placeMaps.values()) map.remove(); placeMaps.clear(); }
function createPlaceMap(container) {
  const place = state.places.find(item => item.id === container.dataset.placeMap); if (!place?.secure || placeMaps.has(place.id) || !container.isConnected) return;
  try { const center = [place.body.longitude, place.body.latitude], map = new maplibregl.Map({ container, style: state.config.mapStyleUrl, center, zoom: 13.5, attributionControl: false, interactive: true }); map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right'); map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left'); new maplibregl.Marker({ color: '#8d67af' }).setLngLat(center).addTo(map); placeMaps.set(place.id, map); }
  catch { container.textContent = 'The map could not be loaded'; }
}
function mountPlaceMaps() {
  if (!state.config.mapStyleUrl) return;
  placeMapObserver ||= 'IntersectionObserver' in window ? new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) { placeMapObserver.unobserve(entry.target); createPlaceMap(entry.target); } }, { root: $('placesList'), rootMargin: '300px' }) : null;
  document.querySelectorAll('[data-place-map]').forEach(container => {
    const place = state.places.find(item => item.id === container.dataset.placeMap); if (!place?.secure || placeMaps.has(place.id)) return;
    if (placeMapObserver) placeMapObserver.observe(container); else createPlaceMap(container);
  });
}
function sharedLiveLocations(conversationId = state.active) {
  const latest = new Map();
  for (const message of state.messages) if (message.conversationId === conversationId && message.kind === 'location' && message.secure && message.body.active && message.body.expires > Date.now()) {
    const previous = latest.get(message.senderId); if (!previous || message.body.updated > previous.body.updated) latest.set(message.senderId, message);
  }
  return [...latest.values()].sort((a, b) => Number(a.senderId !== state.me.id) - Number(b.senderId !== state.me.id));
}
function locationPerson(message) {
  const mine = message.senderId === state.me.id, peer = state.conversations.find(item => item.id === message.conversationId)?.peer;
  return { mine, name: mine ? 'You' : peer?.name || 'Your friend', initial: initials(mine ? state.me.name : peer?.name || 'Friend').slice(0, 1) };
}
function locationMarkerElement(message) {
  const person = locationPerson(message), element = document.createElement('div'); element.className = `shared-location-marker ${person.mine ? 'mine' : 'peer'}`;
  const pin = document.createElement('span'), initial = document.createElement('b'), label = document.createElement('small'); initial.textContent = person.initial; label.textContent = person.name; pin.append(initial); element.append(pin, label); return element;
}
function syncLocationEntry(entry, animate = true) {
  const locations = sharedLiveLocations(entry.conversationId), activeIds = new Set(locations.map(message => message.senderId));
  for (const [senderId, marker] of entry.markers) if (!activeIds.has(senderId)) { marker.remove(); entry.markers.delete(senderId); }
  for (const message of locations) {
    let marker = entry.markers.get(message.senderId);
    if (!marker) { marker = new maplibregl.Marker({ element: locationMarkerElement(message), anchor: 'bottom' }).addTo(entry.map); entry.markers.set(message.senderId, marker); }
    marker.setLngLat([message.body.longitude, message.body.latitude]);
  }
  if (locations.length > 1) {
    const bounds = new maplibregl.LngLatBounds(); locations.forEach(message => bounds.extend([message.body.longitude, message.body.latitude]));
    entry.map.fitBounds(bounds, { padding: entry.large ? 80 : 35, maxZoom: 15, duration: animate ? 600 : 0 });
  } else if (locations.length === 1) entry.map.easeTo({ center: [locations[0].body.longitude, locations[0].body.latitude], zoom: entry.large ? 15 : 14.5, duration: animate ? 600 : 0 });
  return locations;
}
function syncEveryLocationMap(conversationId = state.active) {
  for (const entry of locationMaps.values()) if (entry.conversationId === conversationId) syncLocationEntry(entry);
  if (combinedLocationEntry?.conversationId === conversationId) updateCombinedLocationMap();
}
function createLocationMap(container) {
  const message = state.messages.find(item => item.id === container.dataset.locationMap); if (!message || locationMaps.has(message.id) || !container.isConnected) return;
  try {
    const map = new maplibregl.Map({ container, style: state.config.mapStyleUrl, center: [message.body.longitude, message.body.latitude], zoom: 14.5, attributionControl: false });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right'); map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    const entry = { map, markers: new Map(), conversationId: message.conversationId, large: false }; locationMaps.set(message.id, entry); map.once('load', () => syncLocationEntry(entry, false));
  } catch { container.classList.add('map-failed'); container.textContent = 'The map could not be loaded'; }
}
function mountLocationMaps() {
  if (!state.config.mapStyleUrl) return;
  locationMapObserver ||= 'IntersectionObserver' in window ? new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) { locationMapObserver.unobserve(entry.target); createLocationMap(entry.target); } }, { root: $('messageArea'), rootMargin: '500px 0px' }) : null;
  document.querySelectorAll('[data-location-map]').forEach(container => {
    const message = state.messages.find(item => item.id === container.dataset.locationMap);
    if (!message || locationMaps.has(message.id)) return;
    if (locationMapObserver) locationMapObserver.observe(container); else createLocationMap(container);
  });
}
function refreshLocationMap(message) {
  const row = document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
  if (!row || !message.body.active || message.body.expires <= Date.now()) { const entry = locationMaps.get(message.id); entry?.map.remove(); locationMaps.delete(message.id); syncEveryLocationMap(message.conversationId); return false; }
  const coordinate = row.querySelector('.map-coordinate');
  if (coordinate) coordinate.textContent = `${message.body.latitude.toFixed(5)}, ${message.body.longitude.toFixed(5)}`;
  const details = row.querySelector('[data-location-details]');
  if (details) details.textContent = `Until ${time(message.body.expires)} · ${Date.now() - message.body.updated > 60000 ? 'Last location ' : 'Updated '}${time(message.body.updated)}${message.body.accuracy != null ? ` · ±${Math.round(message.body.accuracy)} m` : ''}`;
  syncEveryLocationMap(message.conversationId); return true;
}
function updateCombinedLocationMap() {
  if (!combinedLocationEntry) return;
  const locations = syncLocationEntry(combinedLocationEntry), peer = currentConversation()?.peer;
  $('liveMapStatus').textContent = locations.length > 1 ? `${state.me.name} and ${peer?.name || 'your friend'} are sharing live location` : locations.length ? `Waiting for ${peer?.name || 'your friend'} to share live location` : 'No active live location';
  $('liveMapPeople').innerHTML = locations.map(message => { const person = locationPerson(message), age = Math.max(0, Math.round((Date.now() - message.body.updated) / 1000)); return `<span class="live-map-person ${person.mine ? 'mine' : 'peer'}"><i></i><b>${escapeHTML(person.name)}</b><small>${age < 10 ? 'Live now' : `${age}s ago`}</small></span>`; }).join('');
}
function openCombinedLocationMap(conversationId = state.active) {
  if (!state.config.mapStyleUrl) return toast('The map is not configured on this server.');
  showDialog('liveMapDialog'); requestAnimationFrame(() => {
    destroyCombinedLocationMap();
    try { const first = sharedLiveLocations(conversationId)[0], map = new maplibregl.Map({ container: $('combinedLiveMap'), style: state.config.mapStyleUrl, center: first ? [first.body.longitude, first.body.latitude] : [101.6869, 3.139], zoom: 14, attributionControl: false }); map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right'); map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left'); combinedLocationEntry = { map, markers: new Map(), conversationId, large: true }; map.once('load', () => updateCombinedLocationMap()); }
    catch { $('combinedLiveMap').textContent = 'The map could not be loaded.'; }
  });
}
$('liveMapDialog').addEventListener('close', destroyCombinedLocationMap);
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

function refreshSoundSettings() {
  const native = !!window.ZbuddyAndroid?.chooseSound;
  $('nativeSoundSettings').hidden = !native; $('webSoundSettings').hidden = native;
  if (native) {
    try {
      $('notificationSoundName').textContent = window.ZbuddyAndroid.getSoundName('notification') || 'Device default';
      $('callRingtoneName').textContent = window.ZbuddyAndroid.getSoundName('call') || 'Device default';
    } catch {}
  } else $('webRingtone').value = soundSettings().ringtone;
}
function openSoundSettings() { refreshSoundSettings(); showDialog('soundDialog'); }
$('chooseNotificationSound').onclick = () => { try { window.ZbuddyAndroid?.chooseSound?.('notification'); } catch { toast('The Android sound picker could not be opened.'); } };
$('chooseCallRingtone').onclick = () => { try { window.ZbuddyAndroid?.chooseSound?.('call'); } catch { toast('The Android sound picker could not be opened.'); } };
$('webRingtone').onchange = () => {
  const ringtone = ['classic','gentle','pulse','silent'].includes($('webRingtone').value) ? $('webRingtone').value : 'classic';
  localStorage.setItem('zbuddy-sounds', JSON.stringify({ ringtone }));
};
$('previewRingtone').onclick = () => {
  clearTimeout(soundPreviewTimer); startWebCallSound($('webRingtone').value);
  soundPreviewTimer = setTimeout(stopCallSound, 2600);
};
$('soundDialog').addEventListener('close', () => { clearTimeout(soundPreviewTimer); soundPreviewTimer = null; if (!state.call) stopCallSound(); });
window.addEventListener('zbuddy:sound-changed', refreshSoundSettings);

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
  if (!m || m.kind === 'deleted') return m ? { ...m, body: {}, secure: true } : m;
  if (m.kind !== 'encrypted') return { ...m, legacy: !m.secure };
  try {
    const payload = await decryptPayload(state.identity, await getPeer(m.conversationId), m, state.me.id);
    if (!['text', 'image', 'location'].includes(payload.kind)) throw new Error();
    const { kind, ...body } = payload;
    if (kind === 'text' && (typeof body.text !== 'string' || body.text.length > 4000)) throw new Error();
    if (kind === 'image' && (!/^\/media\/[a-f0-9-]{36}$/.test(body.url) || !['image/webp','image/png','image/jpeg'].includes(body.mime) || typeof body.key !== 'string' || typeof body.iv !== 'string')) throw new Error();
    if (kind === 'location' && (!Number.isFinite(body.latitude) || !Number.isFinite(body.longitude) || Math.abs(body.latitude) > 90 || Math.abs(body.longitude) > 180 || !Number.isFinite(body.updated) || !Number.isFinite(body.expires))) throw new Error();
    if (body.reply && (typeof body.reply.id !== 'string' || typeof body.reply.senderId !== 'string' || typeof body.reply.text !== 'string' || body.reply.text.length > 180)) throw new Error();
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
    if (index !== -1) { state.messages[index] = m; if (m.kind !== 'location' || !refreshLocationMap(m)) replaceMessageRow(m); }
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
      state.messages.forEach(m => { if (m.senderId !== userId && !m.readAt) { m.deliveredAt ||= at; m.readAt = at; updateDeliveryStatus(m); } });
    }
    const c = state.conversations.find(c => c.id === conversationId);
    if (c) { if (userId === state.me.id) c.unread = 0; if (c.last && c.last.senderId !== userId) { c.last.deliveredAt ||= at; c.last.readAt ||= at; } renderConversations(); }
  });
  socket.on('messages:delivered', ({ conversationId, messageIds, at }) => {
    const ids = new Set(messageIds || []);
    if (conversationId === state.active) { state.messages.forEach(m => { if (ids.has(m.id)) { m.deliveredAt ||= at; updateDeliveryStatus(m); } }); }
    const c = state.conversations.find(c => c.id === conversationId);
    if (c?.last && ids.has(c.last.id)) { c.last.deliveredAt ||= at; renderConversations(); }
  });
  socket.on('message:deleted', ({ id, mode, deletedAt }) => {
    const index = state.messages.findIndex(message => message.id === id); if (index === -1) return;
    if (mode === 'me') { state.messages.splice(index, 1); renderMessages(false); }
    else { state.messages[index] = { ...state.messages[index], kind: 'deleted', body: {}, deletedAt }; replaceMessageRow(state.messages[index]); }
    refreshConversations().catch(() => {});
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
    try { call.accepted = true; stopCallSound(); setCallStatus('Connecting call…'); await offerCall(); }
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
  destroyLocationMaps(); destroyCombinedLocationMap(); destroyPlaceMaps();
  for (const promise of imageCache.values()) promise.then(url => URL.revokeObjectURL(url)).catch(() => {});
  imageCache.clear(); $('fullImage').removeAttribute('src'); $('messages').innerHTML = '';
  state.me = null; state.active = null; state.messages = []; state.places = []; state.placeDraft = null; state.conversations = []; state.pushEnabled = false;
  conversationRequest++; refreshVersion++;
  $('app').classList.remove('chat-open');
  $('chatPanel').hidden = true; $('welcome').hidden = false;
  $('offlineBanner').hidden = true; $('connectionText').textContent = 'Secure connection';
  clearAttachment(); clearReply(); renderConversations();
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
  if (m.kind === 'deleted') return `${own}Message deleted`;
  if (m.kind === 'image') return `${own}Image${m.body.caption ? ' · ' + m.body.caption : ''}`;
  if (m.kind === 'location') return `${own}${m.body.active && m.body.expires > Date.now() ? 'Live location' : 'Last location'}`;
  return own + (m.body?.text || 'Message');
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
  const list = $('conversationList'), keep = new Set(cs.map(c => c.id));
  list.querySelectorAll('[data-conversation]').forEach(row => { if (!keep.has(row.dataset.conversation)) row.remove(); });
  list.querySelector('.sidebar-empty')?.remove();
  for (const c of cs) {
    let row = list.querySelector(`[data-conversation="${CSS.escape(c.id)}"]`);
    if (!row) {
      row = document.createElement('button'); row.className = 'conversation-row'; row.dataset.conversation = c.id;
      row.innerHTML = '<span class="avatar"></span><div class="conversation-summary"><div class="row-top"><h3></h3><time></time></div><div class="row-bottom"><p></p><span class="unread-badge" hidden></span></div></div>';
      row.onclick = () => openConversation(row.dataset.conversation); list.append(row);
    }
    const avatarKey = `${c.peer.avatar || ''}|${c.peer.color}|${c.peer.name}|${c.peer.online}`;
    if (row.dataset.avatarKey !== avatarKey) { const holder = document.createElement('div'); holder.innerHTML = avatarHTML(c.peer, c.peer.online); row.querySelector('.avatar').replaceWith(holder.firstElementChild); row.dataset.avatarKey = avatarKey; }
    row.classList.toggle('selected', c.id === state.active); row.setAttribute('aria-label', `Chat with ${c.peer.name}`);
    if (c.id === state.active) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
    row.querySelector('h3').textContent = c.peer.name; row.querySelector('time').textContent = c.last ? (today(c.last.created) ? time(c.last.created) : new Date(c.last.created).toLocaleDateString('en-MY', { day: 'numeric', month: 'short' })) : '';
    row.querySelector('.row-bottom p').textContent = preview(c.last);
    const badge = row.querySelector('.unread-badge'); badge.hidden = !c.unread; badge.textContent = c.unread > 99 ? '99+' : c.unread || '';
    list.append(row);
  }
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
  clearAttachment(); clearReply(); $('messageInput').value = ''; resizeInput();
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
  const reply = m.body?.reply ? `<button class="message-reply" data-jump-message="${escapeHTML(m.body.reply.id)}"><b>${escapeHTML(m.body.reply.senderId === state.me.id ? 'You' : currentConversation()?.peer.name || 'Message')}</b><span>${escapeHTML(m.body.reply.text)}</span></button>` : '';
  if (m.kind === 'deleted') content = '<p class="message-text deleted-message">This message was deleted.</p>';
  else if (m.kind === 'image') content = `${reply}<img class="message-image" alt="${escapeHTML(m.body.caption || 'Shared image')}" data-image="${m.id}" loading="lazy">${m.body.caption ? `<p class="message-text image-caption">${linkText(m.body.caption)}</p>` : ''}${m.secure ? `<div class="image-compression-label">${icon('lock')} ${formatBytes(m.body.size || 0)} · compressed & encrypted</div>` : ''}`;
  else if (m.kind === 'location') {
    const b = m.body, active = m.secure && b.active && b.expires > Date.now();
    const stale = Date.now() - b.updated > 60000;
    const watching = state.watches.has(m.id);
    const maps = `https://www.google.com/maps/search/?api=1&query=${b.latitude},${b.longitude}`;
    content = `${reply}<div class="message-map-wrap"><div class="message-map" data-location-map="${m.id}" aria-label="Interactive map showing shared live locations"></div><span class="map-coordinate">${b.latitude.toFixed(5)}, ${b.longitude.toFixed(5)}</span></div><div class="location-content"><strong>${active ? '<span class="live-dot"></span>' : ''}${active ? 'Live location' : 'Sharing ended'}</strong><p data-location-details>${active ? `Until ${time(b.expires)} · ` : ''}${stale ? 'Last location ' : 'Updated '}${time(b.updated)}${b.accuracy != null ? ` · ±${Math.round(b.accuracy)} m` : ''}</p>${active ? `<button class="text-button view-together" data-open-live-map="${m.conversationId}">${icon('pin')} View both on live map</button>` : ''}<a class="location-link" href="${maps}" target="_blank" rel="noopener noreferrer">Open in maps ${icon('external')}</a><button class="text-button save-place" data-save-place="${m.id}">${icon('heart')} Save place</button>${mine && active ? `<button class="stop-location" data-stop-location="${m.id}">Stop sharing</button>${!watching ? `<button class="text-button" data-resume-location="${m.id}">Resume location updates</button>` : ''}` : ''}</div>`;
  } else content = `${reply}<p class="message-text">${m.locked ? icon('lock') : ''}${linkText(m.body.text)}</p>`;
  const status = m.readAt ? { cls: 'read', title: 'Read', icon: 'check' } : m.deliveredAt ? { cls: 'delivered', title: 'Delivered', icon: 'check' } : { cls: 'sent', title: 'Sent', icon: 'check-one' };
  return `<div class="message-row ${mine ? 'mine' : ''} ${m.pending ? 'pending' : ''} ${m.failed ? 'failed' : ''}" data-message-id="${m.id}"><div class="message-bubble ${m.kind === 'image' || m.kind === 'location' ? 'image-bubble' : ''}">${content}${m.legacy ? '<span class="legacy-label">Legacy message · not encrypted</span>' : ''}<div class="message-meta">${m.secure ? icon('lock') : ''}<time datetime="${new Date(m.created).toISOString()}">${time(m.created)}</time>${mine ? `<span class="delivery-status ${status.cls}" title="${m.pending ? 'Sending' : status.title}" aria-label="${m.pending ? 'Sending' : status.title}">${m.pending ? '…' : icon(status.icon)}</span>` : ''}</div></div></div>`;
}
const imageObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    const img = entry.target; imageObserver.unobserve(img);
    const m = state.messages.find(item => item.id === img.dataset.image); if (!m) continue;
    imageSource(m).then(async url => { if (!img.isConnected) return; img.src = url; try { await img.decode(); } catch {} if (Date.now() < bottomPinUntil) scrollMessagesToBottom(); })
      .catch(error => { if (img.isConnected) { img.alt = 'Encrypted image could not be opened'; toast(error.message); } });
  }
}, { root: $('messageArea'), rootMargin: '500px 0px' }) : null;
function messagePreview(m) {
  if (!m || m.kind === 'deleted') return 'Deleted message';
  if (m.kind === 'image') return m.body.caption || 'Image';
  if (m.kind === 'location') return 'Live location';
  return String(m.body.text || '').replace(/\s+/g, ' ').slice(0, 180);
}
function setReply(m) {
  if (!m || m.kind === 'deleted') return;
  state.reply = { id: m.id, senderId: m.senderId, text: messagePreview(m) };
  $('replyName').textContent = m.senderId === state.me.id ? 'Replying to yourself' : `Replying to ${currentConversation()?.peer.name || 'message'}`;
  $('replyText').textContent = state.reply.text; $('replyPreview').hidden = false; focusComposer();
}
function clearReply() { state.reply = null; $('replyPreview').hidden = true; }
$('cancelReply').onclick = clearReply;
function jumpToMessage(id) {
  const row = $('messages').querySelector(`[data-message-id="${CSS.escape(id)}"]`);
  if (!row) return toast('The original message is not loaded yet.');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' }); row.classList.remove('message-highlight'); requestAnimationFrame(() => row.classList.add('message-highlight')); setTimeout(() => row.classList.remove('message-highlight'), 1600);
}
function openMessageActions(id) {
  const m = state.messages.find(item => item.id === id); if (!m || m.pending) return;
  state.actionMessage = m; $('actionReply').hidden = m.kind === 'deleted'; $('actionDeleteEveryone').hidden = m.senderId !== state.me.id || m.kind === 'deleted'; showDialog('messageActionDialog');
}
$('actionReply').onclick = () => { const message = state.actionMessage; $('messageActionDialog').close(); if (message) setReply(message); };
async function deleteAction(mode) {
  const message = state.actionMessage; if (!message) return;
  if (mode === 'everyone' && !confirm('Delete this message for everyone?')) return;
  $('actionDeleteMe').disabled = true; $('actionDeleteEveryone').disabled = true;
  try {
    await api(`/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE', body: { mode } });
    const index = state.messages.findIndex(item => item.id === message.id);
    if (index !== -1) {
      if (mode === 'me') { state.messages.splice(index, 1); renderMessages(false); }
      else { state.messages[index] = { ...message, kind: 'deleted', body: {}, deletedAt: Date.now() }; replaceMessageRow(state.messages[index]); }
    }
    $('messageActionDialog').close(); refreshConversations().catch(() => {});
  } catch (error) { toast(error.message); }
  finally { $('actionDeleteMe').disabled = false; $('actionDeleteEveryone').disabled = false; state.actionMessage = null; }
}
$('actionDeleteMe').onclick = () => deleteAction('me');
$('actionDeleteEveryone').onclick = () => deleteAction('everyone');
function bindMessageInteractions(root = $('messages')) {
  root.querySelectorAll('[data-image]').forEach(img => {
    if (imageObserver) imageObserver.observe(img); else {
      const m = state.messages.find(x => x.id === img.dataset.image); if (m) imageSource(m).then(url => { if (img.isConnected) img.src = url; }).catch(error => toast(error.message));
    }
    img.onclick = async () => { const m = state.messages.find(x => x.id === img.dataset.image); if (!m) return; try { state.fullImageMessage = m; $('fullImage').src = await imageSource(m); showDialog('imageDialog'); } catch (error) { toast(error.message); } };
  });
  root.querySelectorAll('[data-jump-message]').forEach(button => { button.onclick = event => { event.stopPropagation(); jumpToMessage(button.dataset.jumpMessage); }; });
  const rows = [...(root.matches?.('.message-row') ? [root] : []), ...root.querySelectorAll('.message-row')];
  rows.forEach(row => {
    let timer, startX = 0, startY = 0;
    row.onpointerdown = event => { if (event.button !== 0) return; startX = event.clientX; startY = event.clientY; timer = setTimeout(() => { navigator.vibrate?.(20); openMessageActions(row.dataset.messageId); }, 520); };
    row.onpointermove = event => { if (Math.abs(event.clientX-startX) > 12 || Math.abs(event.clientY-startY) > 12) clearTimeout(timer); };
    row.onpointerup = row.onpointercancel = () => clearTimeout(timer);
    row.oncontextmenu = event => { event.preventDefault(); openMessageActions(row.dataset.messageId); };
  });
}
function bindLocationActions(root = $('messages')) {
  root.querySelectorAll('[data-stop-location]').forEach(button => { button.onclick = () => stopLocation(button.dataset.stopLocation); });
  root.querySelectorAll('[data-resume-location]').forEach(button => { button.onclick = () => resumeLocation(button.dataset.resumeLocation); });
  root.querySelectorAll('[data-save-place]').forEach(button => { button.onclick = () => openSavePlace(button.dataset.savePlace); });
  root.querySelectorAll('[data-open-live-map]').forEach(button => { button.onclick = () => openCombinedLocationMap(button.dataset.openLiveMap); });
}
function appendMessage(m) {
  const container = $('messages'); container.querySelector('.empty-message')?.remove();
  const previous = state.messages.at(-2), d = day(m.created);
  if (!previous || day(previous.created) !== d) container.insertAdjacentHTML('beforeend', `<div class="day-marker">${today(m.created) ? 'Today' : d}</div>`);
  container.insertAdjacentHTML('beforeend', messageHTML(m));
  const row = container.querySelector(`[data-message-id="${CSS.escape(m.id)}"]`); if (row) { bindMessageInteractions(row); bindLocationActions(row); }
  if (m.kind === 'location') { mountLocationMaps(); syncEveryLocationMap(m.conversationId); }
  pinMessagesToBottom();
}
function replaceMessageRow(m) {
  const existing = $('messages').querySelector(`[data-message-id="${CSS.escape(m.id)}"]`);
  if (!existing) return;
  const wrapper = document.createElement('div'); wrapper.innerHTML = messageHTML(m);
  const replacement = wrapper.firstElementChild; existing.replaceWith(replacement); bindMessageInteractions(replacement); bindLocationActions(replacement);
  if (m.kind === 'location') { mountLocationMaps(); syncEveryLocationMap(m.conversationId); }
}
function updateDeliveryStatus(message) {
  const target = $('messages').querySelector(`[data-message-id="${CSS.escape(message.id)}"] .delivery-status`); if (!target) return;
  const status = message.readAt ? { cls: 'read', title: 'Read', icon: 'check' } : message.deliveredAt ? { cls: 'delivered', title: 'Delivered', icon: 'check' } : { cls: 'sent', title: 'Sent', icon: 'check-one' };
  target.className = `delivery-status ${status.cls}`; target.title = status.title; target.setAttribute('aria-label', status.title); target.innerHTML = icon(status.icon);
}
function scrollMessagesToBottom() {
  const area = $('messageArea'), conversationId = state.active;
  const pin = () => { if (state.active === conversationId && area.isConnected) area.scrollTo({ top: area.scrollHeight, behavior: 'auto' }); };
  pin();
  requestAnimationFrame(() => { pin(); requestAnimationFrame(pin); });
  setTimeout(pin, 80); setTimeout(pin, 220); setTimeout(pin, 450);
}
function pinMessagesToBottom(duration = 1400) { bottomPinUntil = Math.max(bottomPinUntil, Date.now() + duration); scrollMessagesToBottom(); }
function focusComposer() {
  if (!state.active) return;
  try { $('messageInput').focus({ preventScroll: true }); }
  catch { $('messageInput').focus(); pinMessagesToBottom(); }
}
function renderMessages(forceBottom) {
  const area = $('messageArea');
  const closeToBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 110 || Date.now() < bottomPinUntil;
  const oldTop = area.scrollTop;
  let lastDay = '';
  destroyLocationMaps();
  $('messages').innerHTML = state.messages.length ? state.messages.map(m => {
    const d = day(m.created), label = d !== lastDay ? `<div class="day-marker">${today(m.created) ? 'Today' : d}</div>` : '';
    lastDay = d; return label + messageHTML(m);
  }).join('') : '<div class="empty-message">One “hello” can begin a beautiful story. 👋</div>';
  $('olderMessages').hidden = !state.cursor;
  bindMessageInteractions();
  bindLocationActions();
  mountLocationMaps();
  if (forceBottom || closeToBottom) scrollMessagesToBottom(); else area.scrollTop = oldTop;
}
async function onMessage(raw) {
  const m = raw.kind === 'encrypted' ? await decodeWire(raw) : raw;
  if (!state.me) return;
  acknowledgeDelivered([m]);
  if (m.conversationId === state.active) {
    const optimisticIndex = state.messages.findIndex(item => item.pending && item.senderId === m.senderId && item.clientId === m.clientId);
    if (optimisticIndex !== -1) {
      const oldId = state.messages[optimisticIndex].id, oldRow = $('messages').querySelector(`[data-message-id="${CSS.escape(oldId)}"]`); state.messages[optimisticIndex] = m;
      if (oldRow) { const wrapper = document.createElement('div'); wrapper.innerHTML = messageHTML(m); const replacement = wrapper.firstElementChild; oldRow.replaceWith(replacement); bindMessageInteractions(replacement); bindLocationActions(replacement); if (m.kind === 'location') { mountLocationMaps(); syncEveryLocationMap(m.conversationId); } }
    } else if (!state.messages.some(x => x.id === m.id)) { state.messages.push(m); appendMessage(m); }
    markRead().catch(() => {}); if (m.senderId !== state.me.id && !document.hidden) playTonePattern('gentle');
  }
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
function setRailActive(id = 'railChats') { document.querySelectorAll('.rail .rail-btn').forEach(button => button.classList.toggle('active', button.id === id)); }
$('backButton').onclick = () => { $('app').classList.remove('chat-open'); state.active = null; conversationRequest++; destroyLocationMaps(); $('chatPanel').hidden = true; $('welcome').hidden = false; setRailActive(); renderConversations(); };
$('railChats').onclick = () => { $('app').classList.remove('preview', 'chat-open'); setRailActive(); };
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
    $('profileBody').innerHTML = `<div class="profile-hero"><button class="profile-avatar-view" type="button" ${user.avatar ? `data-profile-photo="${escapeHTML(user.avatar)}"` : 'disabled'} aria-label="View profile photo">${avatarHTML(user)}</button><div><h3>${escapeHTML(user.name)}</h3><p>@${escapeHTML(user.username)}</p></div></div>${p.bio ? `<p class="profile-bio">${escapeHTML(p.bio)}</p>` : ''}<div class="profile-details">${details || '<p class="profile-empty">No profile details have been added yet.</p>'}</div>${security}`;
    $('profileBody').querySelector('[data-profile-photo]')?.addEventListener('click', event => { state.fullImageMessage = null; $('fullImage').src = event.currentTarget.dataset.profilePhoto; showDialog('imageDialog'); });
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
$('railPeople').addEventListener('click', () => setRailActive('railPeople'));
$('peopleDialog').addEventListener('close', () => setRailActive());
$('inviteButton').onclick = async () => {
  try { await navigator.clipboard.writeText(location.origin); toast('Link copied. Send it to a friend so they can request an account.'); }
  catch { showInfo('Invite a friend', `<p>Share this link with a friend. After registration, the Owner must activate their account.</p><p><a href="${escapeHTML(location.origin)}">${escapeHTML(location.origin)}</a></p><p>If this is a localhost link, it can only be opened on this computer.</p>`); }
};
$('themeButton').onclick = () => {
  const settings = appearanceSettings();
  $('appearanceTheme').value = settings.theme; $('appearancePalette').value = settings.palette || 'purple'; $('appearanceBackground').value = settings.background;
  $('appearanceFont').value = settings.font; $('appearanceTextSize').value = settings.textSize || ({ small: 11, normal: 13, large: 17 }[settings.size] || 13);
  $('appearanceAccent').value = settings.accent || appearanceDefaults.accent; $('appearanceMine').value = settings.mine || appearanceDefaults.mine; $('appearancePeer').value = settings.peer || appearanceDefaults.peer;
  $('appearanceSizeValue').textContent = `${$('appearanceTextSize').value}px`; $('appearanceBold').checked = !!settings.bold; $('appearanceItalic').checked = !!settings.italic;
  showDialog('appearanceDialog');
};
for (const id of ['appearanceTheme','appearancePalette','appearanceBackground','appearanceFont','appearanceTextSize','appearanceBold','appearanceItalic','appearanceAccent','appearanceMine','appearancePeer']) $(id).oninput = () => {
  const settings = { theme: $('appearanceTheme').value, palette: $('appearancePalette').value, background: $('appearanceBackground').value, font: $('appearanceFont').value, textSize: Number($('appearanceTextSize').value), bold: $('appearanceBold').checked, italic: $('appearanceItalic').checked, accent: $('appearanceAccent').value, mine: $('appearanceMine').value, peer: $('appearancePeer').value };
  if (id === 'appearancePalette' && settings.palette !== 'custom') { const preset = appearancePalettes[settings.palette]; $('appearanceAccent').value = preset.accent; $('appearanceMine').value = preset.mine; $('appearancePeer').value = preset.peer; settings.accent = preset.accent; settings.mine = preset.mine; settings.peer = preset.peer; }
  if (['appearanceAccent','appearanceMine','appearancePeer'].includes(id)) { settings.palette = 'custom'; $('appearancePalette').value = 'custom'; }
  $('appearanceSizeValue').textContent = `${settings.textSize}px`;
  localStorage.setItem('zbuddy-appearance', JSON.stringify(settings)); applyAppearance(settings);
};
$('uploadWallpaper').onclick = () => $('wallpaperInput').click();
$('wallpaperInput').onchange = async () => { const file = $('wallpaperInput').files[0]; $('wallpaperInput').value = ''; if (!file) return; try { const source = await createImageBitmap(file), scale = Math.min(1, 1920 / Math.max(source.width, source.height)), canvas = document.createElement('canvas'); canvas.width = Math.round(source.width * scale); canvas.height = Math.round(source.height * scale); canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height); source.close?.(); const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error()), 'image/webp', .82)); await wallpaperAsset(blob); const settings = appearanceSettings(); settings.background = 'custom'; localStorage.setItem('zbuddy-appearance', JSON.stringify(settings)); $('appearanceBackground').value = 'custom'; await refreshWallpaper(); applyAppearance(settings); toast('Chat wallpaper updated.'); } catch { toast('The wallpaper could not be prepared.'); } };
$('removeWallpaper').onclick = async () => { await wallpaperAsset(null).catch(() => {}); const settings = appearanceSettings(); if (settings.background === 'custom') settings.background = 'plain'; localStorage.setItem('zbuddy-appearance', JSON.stringify(settings)); $('appearanceBackground').value = settings.background; await refreshWallpaper(); applyAppearance(settings); toast('Custom wallpaper removed.'); };
$('appearanceReset').onclick = async () => { localStorage.removeItem('zbuddy-appearance'); await wallpaperAsset(null).catch(() => {}); await refreshWallpaper(); applyAppearance(appearanceDefaults); $('themeButton').click(); toast('Appearance reset.'); };
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
$('railPlaces').onclick = () => needAccount(() => { setRailActive('railPlaces'); showDialog('placesDialog'); loadPlaces().catch(error => { $('placesList').textContent = error.message; }); });
$('placesDialog').addEventListener('close', () => { destroyPlaceMaps(); setRailActive(); });
function showInfo(title, body) { $('infoTitle').textContent = title; $('infoBody').innerHTML = body; showDialog('infoDialog'); }
$('infoButton').onclick = () => showInfo('About Zbuddy', '<p>A private community for approved members: chat, photos, voice and video calls, and live location.</p><h3>Developer</h3><p><strong>Aigeo</strong><br>Freelance Programmer<br>Developed for My Purple</p><h3>You are in control.</h3><p>Location is shared only with your permission. Stop it at any time. The camera and microphone are used only during calls.</p><h3>Calls &amp; location</h3><p>Use a browser with camera, microphone, and GPS support over HTTPS or localhost. Incoming calls on Android use an ongoing notification while active.</p><p>New messages, photos, locations, saved places, and call signals are encrypted on your device before being sent. Compare the safety number in contact information. On a new device, sign in with your email and password to unlock your chat key.</p>');
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
  const serverSettings = window.ZbuddyAndroid?.openServerSettings ? '<button class="secondary profile-action" id="serverSettings">Change server</button>' : '';
  const appLock = window.ZbuddyAndroid?.configureAppLock ? `<button class="secondary profile-action" id="appLockSettings">App Lock · ${window.ZbuddyAndroid.appLockEnabled?.() ? 'On' : 'Off'}</button>` : '';
  showInfo('Your account', `<div class="profile-photo"><button class="profile-avatar-view" id="viewOwnAvatar" type="button" ${u.avatar ? '' : 'disabled'} aria-label="View profile photo">${avatarHTML(u)}</button><div><button class="primary profile-photo-button" id="changeAvatar">Change photo</button>${u.avatar ? '<button class="text-button remove-avatar" id="removeAvatar">Remove photo</button>' : ''}</div></div><h3>${escapeHTML(u.name)}</h3><p>@${escapeHTML(u.username)} · ${u.role === 'owner' ? 'Owner' : 'Member'}</p>${u.email ? `<p class="account-email">${escapeHTML(u.email)}</p>` : ''}<p>Approved friends can find you using this username.</p><button class="secondary profile-action" id="editProfile">Edit profile details</button><button class="secondary profile-action" id="appearanceSettings">Chat appearance</button><button class="secondary profile-action" id="soundSettings">Call &amp; notification sounds</button>${appLock}<button class="secondary profile-action" id="aboutSettings">About Zbuddy</button>${serverSettings}${u.role === 'owner' ? '<button class="secondary profile-action" id="manageAccounts">Manage account activation</button>' : ''}${notification}<button class="logout-button" id="logoutButton">${icon('logout')} Sign out</button>`);
  $('changeAvatar').onclick = () => $('avatarInput').click();
  if (u.avatar) $('viewOwnAvatar').onclick = () => { state.fullImageMessage = null; $('fullImage').src = u.avatar; showDialog('imageDialog'); };
  $('editProfile').onclick = () => { $('infoDialog').close(); openProfileEditor(); };
  $('appearanceSettings').onclick = () => { $('infoDialog').close(); $('themeButton').click(); };
  $('soundSettings').onclick = () => { $('infoDialog').close(); openSoundSettings(); };
  if ($('appLockSettings')) $('appLockSettings').onclick = () => window.ZbuddyAndroid.configureAppLock();
  $('aboutSettings').onclick = () => { $('infoDialog').close(); $('infoButton').click(); };
  if ($('serverSettings')) $('serverSettings').onclick = () => { if (confirm('Change server? Any open chat or call will close.')) window.ZbuddyAndroid.openServerSettings(); };
  if ($('manageAccounts')) $('manageAccounts').onclick = () => { $('infoDialog').close(); showDialog('accountAdminDialog'); loadAdminUsers().catch(error => { $('accountAdminList').innerHTML = `<p class="form-error">${escapeHTML(error.message)}</p>`; }); };
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
$('railSettings').onclick = () => needAccount(() => { setRailActive('railSettings'); showProfile(); });
$('infoDialog').addEventListener('close', () => setRailActive());
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
$('sendButton').onpointerdown = event => event.preventDefault();
$('composer').onsubmit = async e => {
  e.preventDefault();
  const originalInput = $('messageInput').value, text = originalInput.trim(), id = state.active;
  if ((!text && !state.attachment) || !id || state.sending || state.compressing) return;
  state.sending = true; bottomPinUntil = Date.now() + 5000; $('sendButton').disabled = true; $('messageInput').setAttribute('aria-busy', 'true');
  const attachment = state.attachment, reply = state.reply, clientId = crypto.randomUUID();
  const pending = { id: `pending-${clientId}`, clientId, conversationId: id, senderId: state.me.id, created: Date.now(), pending: true, secure: false, kind: attachment ? 'image' : 'text', body: attachment ? { url: attachment.url, caption: text, reply } : { text, reply } };
  state.messages.push(pending); appendMessage(pending);
  $('messageInput').value = ''; resizeInput(); clearReply();
  if (attachment) { state.attachment = null; attachmentVersion++; $('attachmentPreview').hidden = true; $('attachmentImage').removeAttribute('src'); $('imageInput').value = ''; }
  focusComposer();
  try {
    await getPeer(id);
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
      payload = { kind: 'image', url: a.url, key: a.key, iv: a.iv, caption: text, name: attachment.name, mime: attachment.mime, size: attachment.size, originalSize: attachment.originalSize, width: attachment.width, height: attachment.height, ...(reply ? { reply } : {}) };
    } else payload = { kind: 'text', text, ...(reply ? { reply } : {}) };
    const message = await sendSecure(id, payload, clientId);
    const pendingIndex = state.messages.findIndex(item => item.id === pending.id);
    const pendingRow = $('messages').querySelector(`[data-message-id="${CSS.escape(pending.id)}"]`);
    if (pendingIndex !== -1) state.messages[pendingIndex] = message;
    if (pendingRow) { const wrapper = document.createElement('div'); wrapper.innerHTML = messageHTML(message); const replacement = wrapper.firstElementChild; pendingRow.replaceWith(replacement); bindMessageInteractions(replacement); }
    await onMessage(message); playTonePattern('pulse');
    if (state.active === id) {
      resizeInput(); pinMessagesToBottom(1800);
    }
    emit('typing', { conversationId: id, active: false }).catch(() => {});
  } catch (err) {
    const delivered = state.messages.some(item => item.clientId === clientId && !item.pending && item.id !== pending.id);
    if (delivered) { playTonePattern('pulse'); toast('Message sent.'); }
    else {
      pending.pending = false; pending.failed = true; replaceMessageRow(pending);
      if (!$('messageInput').value) $('messageInput').value = originalInput;
      if (!state.reply && reply) { state.reply = reply; $('replyName').textContent = reply.senderId === state.me.id ? 'Replying to yourself' : `Replying to ${currentConversation()?.peer.name || 'message'}`; $('replyText').textContent = reply.text; $('replyPreview').hidden = false; }
      if (!state.attachment && attachment) { state.attachment = attachment; $('attachmentImage').src = attachment.url; $('attachmentName').textContent = attachment.name; $('attachmentPreview').hidden = false; }
      resizeInput(); toast(err.message);
    }
  }
  finally { state.sending = false; $('sendButton').disabled = false; $('messageInput').removeAttribute('aria-busy'); if (attachment && !state.attachment) URL.revokeObjectURL(attachment.url); if (state.active === id) { focusComposer(); pinMessagesToBottom(900); } }
};
window.visualViewport?.addEventListener('resize', () => { if (state.active && Date.now() < bottomPinUntil) scrollMessagesToBottom(); });
$('imageButton').onclick = () => $('imageInput').click();
let attachmentVersion = 0;
let cropSource = null, cropFile = null, cropRotation = 0;
function drawCrop() {
  if (!cropSource) return;
  const canvas = $('cropCanvas'), context = canvas.getContext('2d'), size = 720, zoom = Number($('cropZoom').value || 1);
  canvas.width = size; canvas.height = size; context.clearRect(0, 0, size, size); context.save(); context.translate(size / 2, size / 2); context.rotate(cropRotation * Math.PI / 180);
  const swapped = Math.abs(cropRotation % 180) === 90, width = swapped ? cropSource.height : cropSource.width, height = swapped ? cropSource.width : cropSource.height;
  const scale = Math.max(size / width, size / height) * zoom; context.drawImage(cropSource, -cropSource.width * scale / 2, -cropSource.height * scale / 2, cropSource.width * scale, cropSource.height * scale); context.restore();
}
async function prepareAttachment(file) {
  clearAttachment(); const version = attachmentVersion;
  state.compressing = true; $('imageButton').disabled = true; $('sendButton').disabled = true; toast('Compressing the image on your device…');
  try {
    const result = await compressImage(file); if (version !== attachmentVersion) return;
    state.attachment = { ...result, url: URL.createObjectURL(result.blob) };
    $('attachmentImage').src = state.attachment.url; $('attachmentName').textContent = result.name;
    const saved = Math.max(0, Math.round((1 - result.size / result.originalSize) * 100));
    $('compressionInfo').textContent = `${formatBytes(result.originalSize)} → ${formatBytes(result.size)}${saved ? ` · saved ${saved}%` : ''} · ${result.width}×${result.height}${result.still ? ' · GIF converted to a still image' : ''}`;
    $('attachmentPreview').hidden = false; focusComposer(); toast('Image ready. It will be encrypted before sending.');
  } catch (error) { toast(error.message); }
  finally { state.compressing = false; $('imageButton').disabled = false; $('sendButton').disabled = false; }
}
$('imageInput').onchange = async () => {
  const file = $('imageInput').files[0]; if (!file) return;
  try { cropSource?.close?.(); cropSource = await createImageBitmap(file); cropFile = file; cropRotation = 0; $('cropZoom').value = '1'; drawCrop(); showDialog('cropDialog'); }
  catch { await prepareAttachment(file); }
};
$('cropZoom').oninput = drawCrop;
$('rotateCrop').onclick = () => { cropRotation = (cropRotation + 90) % 360; drawCrop(); };
function cancelCrop() { if ($('cropDialog').open) $('cropDialog').close(); cropSource?.close?.(); cropSource = null; cropFile = null; $('imageInput').value = ''; }
$('cancelCrop').onclick = cancelCrop;
$('applyCrop').onclick = async () => {
  if (!cropSource || !cropFile) return;
  $('applyCrop').disabled = true;
  try {
    const blob = await new Promise((resolve, reject) => $('cropCanvas').toBlob(value => value ? resolve(value) : reject(new Error('The cropped photo could not be prepared.')), 'image/jpeg', .92));
    const file = new File([blob], cropFile.name.replace(/\.[^.]+$/, '') + '-cropped.jpg', { type: 'image/jpeg' });
    cancelCrop(); await prepareAttachment(file);
  } catch (error) { toast(error.message); }
  finally { $('applyCrop').disabled = false; }
};
function clearAttachment() { attachmentVersion++; if (state.attachment) URL.revokeObjectURL(state.attachment.url); state.attachment = null; $('attachmentPreview').hidden = true; $('attachmentImage').removeAttribute('src'); $('imageInput').value = ''; }
$('removeAttachment').onclick = clearAttachment;
const emojiGroups = {
  Recent: [], Smileys: ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😋','😎','🤓','🧐','🤔','🤭','🤫','😴','🥳','😭','😤','😡'],
  People: ['👋','🤚','🖐️','✋','👌','🤌','✌️','🤞','🫶','🤟','🤘','👈','👉','👆','👇','👍','👎','👏','🙌','👐','🙏','💪','👀','🫂'],
  Hearts: ['❤️','🩷','🧡','💛','💚','💙','🩵','💜','🤎','🖤','🤍','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟'],
  Nature: ['🌸','🌺','🌻','🌹','🌷','🪻','🌿','🍀','🌈','⭐','✨','🔥','🌙','☀️','🌊','🦋','🐱','🐶','🐼','🦄'],
  Food: ['☕','🍵','🥤','🍰','🎂','🍫','🍓','🍉','🍇','🍕','🍔','🍜','🍣','🍦','🥰','🍽️'],
  Activity: ['🎉','🎊','🎁','🎈','⚽','🏸','🎮','🎵','🎬','📸','✈️','🚗','🏡','📍','🚀','💯','✅','❌']
};
let activeEmojiGroup = 'Smileys';
function emojiRecent() { try { return JSON.parse(localStorage.getItem('zbuddy-emoji-recent') || '[]').slice(0, 32); } catch { return []; } }
function renderEmojiPicker() {
  emojiGroups.Recent = emojiRecent(); if (activeEmojiGroup === 'Recent' && !emojiGroups.Recent.length) activeEmojiGroup = 'Smileys';
  $('emojiPicker').innerHTML = `<div class="emoji-tabs">${Object.keys(emojiGroups).map(name => `<button type="button" class="${name === activeEmojiGroup ? 'active' : ''}" data-emoji-group="${name}">${name === 'Recent' ? '🕘' : emojiGroups[name][0]}</button>`).join('')}</div><div class="emoji-grid">${emojiGroups[activeEmojiGroup].map(emoji => `<button type="button" data-emoji="${emoji}" aria-label="${emoji}">${emoji}</button>`).join('')}</div>`;
  $('emojiPicker').querySelectorAll('[data-emoji-group]').forEach(button => button.onclick = () => { activeEmojiGroup = button.dataset.emojiGroup; renderEmojiPicker(); });
  $('emojiPicker').querySelectorAll('[data-emoji]').forEach(button => button.onclick = () => {
    const input = $('messageInput'), emoji = button.dataset.emoji; if (input.value.length + emoji.length > 4000) return;
    input.setRangeText(emoji, input.selectionStart, input.selectionEnd, 'end');
    localStorage.setItem('zbuddy-emoji-recent', JSON.stringify([emoji, ...emojiRecent().filter(item => item !== emoji)].slice(0, 32))); resizeInput(); focusComposer();
  });
}
renderEmojiPicker();
$('emojiButton').onclick = () => { $('emojiPicker').hidden = !$('emojiPicker').hidden; };
document.addEventListener('click', e => { if (!e.target.closest('#emojiButton, #emojiPicker')) $('emojiPicker').hidden = true; });

$('saveFullImage').onclick = async () => {
  try {
    const source = $('fullImage').src, response = await fetch(source), blob = await response.blob(), extension = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg', name = `Zbuddy-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
    if (window.ZbuddyAndroid?.saveImage) {
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
      window.ZbuddyAndroid.saveImage(data, blob.type || 'image/jpeg', name); toast('Photo saved to Pictures/Zbuddy.');
    } else { const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  } catch (error) { toast('The photo could not be saved.'); }
};

function geolocationError(err) { return err.code === 1 ? 'Location permission was denied. Enable it in your browser settings.' : err.code === 2 ? 'Your location could not be determined. Make sure GPS is on.' : 'Location took too long. Try again.'; }
function ensureLocation() {
  if (!window.isSecureContext) throw new Error('Live location requires HTTPS or localhost.');
  if (!navigator.geolocation) throw new Error('This browser does not support location.');
}
function getPosition() { return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, e => reject(new Error(geolocationError(e))), { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 })); }
const coords = p => ({ latitude: Number(p.coords.latitude), longitude: Number(p.coords.longitude), accuracy: Number.isFinite(p.coords.accuracy) ? Math.max(0, p.coords.accuracy) : null });
$('locationButton').onclick = () => { if (state.active) showDialog('locationDialog'); };
$('startLocation').onclick = async () => {
  const id = state.active; if (!id) return;
  $('startLocation').disabled = true;
  try {
    ensureLocation();
    const p = await getPosition();
    const duration = Number($('locationDuration').value), message = await sendSecure(id, { kind: 'location', ...coords(p), updated: Date.now(), active: true, expires: Date.now() + duration * 60000, ...(state.reply ? { reply: state.reply } : {}) });
    await prepareStop(message); watchLocation(message); await onMessage(message); $('locationDialog').close(); toast('Live location shared. You can stop it at any time.');
    clearReply(); try { window.ZbuddyAndroid?.setBackgroundLocationActive?.(true); } catch {}
  } catch (err) { toast(err.message); }
  finally { $('startLocation').disabled = false; }
};
function watchLocation(m) {
  if (state.watches.has(m.id)) return;
  const w = { message: m, pending: null, stopping: false, id: m.id, conversationId: m.conversationId, expires: m.body.expires, lastSent: 0, lastErrorToast: 0, latest: null, watch: null, timer: null };
  state.watches.set(m.id, w);
  w.watch = navigator.geolocation.watchPosition(p => {
    w.latest = p;
    w.message = { ...w.message, body: { ...w.message.body, ...coords(p), updated: Date.now() } };
    const shown = state.messages.find(x => x.id === w.id);
    if (shown) { shown.body = { ...shown.body, ...w.message.body }; refreshLocationMap(shown); }
    if (Date.now() >= w.expires) { stopLocation(w.id); return; }
    if (Date.now() - w.lastSent >= 5000) updateLocation(w, p);
  }, err => { if (Date.now() - w.lastErrorToast > 60000) { w.lastErrorToast = Date.now(); toast(geolocationError(err)); } if (err.code === 1) stopLocation(w.id); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
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
    } catch (e) { w.lastSent = 0; if (/not found/i.test(e.message)) removeWatch(w.id); }
  })();
  try { await w.pending; } finally { w.pending = null; }
}
async function resumeLocation(id) {
  const m = state.messages.find(x => x.id === id); if (!m) return;
  try { ensureLocation(); const p = await getPosition(); await prepareStop(m); watchLocation(m); await updateLocation(state.watches.get(id), p); renderMessages(false); toast('Location updates resumed.'); } catch (e) { toast(e.message); }
}
function removeWatch(id) { const w = state.watches.get(id); if (!w) return; navigator.geolocation.clearWatch(w.watch); clearTimeout(w.timer); state.watches.delete(id); updateLocationBar(); if (!state.watches.size) try { window.ZbuddyAndroid?.setBackgroundLocationActive?.(false); } catch {} }
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
setInterval(() => { if (state.active && state.messages.some(m => m.kind === 'location')) renderMessages(false); if (combinedLocationEntry) updateCombinedLocationMap(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.active) { markRead().catch(() => {}); refreshConversations().catch(() => {}); for (const w of state.watches.values()) getPosition().then(position => updateLocation(w, position)).catch(() => {}); } });

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
  if (incoming) try { window.ZbuddyAndroid?.setCallActive?.(true, true, person.name, video); } catch {}
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
    call.stream = stream; try { window.ZbuddyAndroid?.setCallActive?.(true, false, c.peer.name, video); } catch {} attachLocalStream(call); createPeer(call);
    const result = await emit('call:start', { conversationId: c.id, video });
    if (state.call !== call) { emit('call:end', { id: result.id }).catch(() => {}); return; }
    call.id = result.id; if (!call.accepted) setCallStatus('Ringing…');
    if (!call.accepted) startOutgoingRingback();
    call.timeout = setTimeout(() => { if (state.call === call && !call.started) { toast('The call could not connect. Check the network or TURN configuration.'); hangup(); } }, 65000);
  } catch (e) { if (state.call === call) { toast(e.message); cleanupCall(); } }
}
function incomingCall(d) {
  if (state.call) { emit('call:end', { id: d.id }).catch(() => {}); return; }
  const call = state.call = { id: d.id, outgoing: false, video: d.video, videoEnabled: d.video, remoteVideoEnabled: d.video, person: d.from, conversationId: d.conversationId, stream: null, pc: null, candidates: [], started: null, timer: null, timeout: null };
  showCall(d.from, d.video, true); startIncomingRingtone(); document.title = `${d.from.name} is calling — Zbuddy`;
  call.timeout = setTimeout(() => { if (state.call === call && !call.pc) cleanupCall('Missed call'); }, 32000);
}
$('voiceCall').onclick = () => startCall(false);
$('videoCall').onclick = () => startCall(true);
$('acceptCall').onclick = async () => {
  const call = state.call; if (!call || call.outgoing) return;
  stopCallSound();
  $('acceptCall').disabled = true;
  try {
    if (call.video) enterCallFullscreen();
    await getPeer(call.conversationId);
    const stream = await getMedia(call.video);
    if (state.call !== call) { stream.getTracks().forEach(t => t.stop()); return; }
    call.stream = stream; try { window.ZbuddyAndroid?.setCallActive?.(true, false, call.person.name, call.video); } catch {} attachLocalStream(call); createPeer(call);
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
      clearTimeout(call.timeout); stopCallSound(); $('callNetworkStatus').hidden = true;
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
  stopCallSound();
  try { window.ZbuddyAndroid?.setCallActive?.(false, false, '', false); } catch {}
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
