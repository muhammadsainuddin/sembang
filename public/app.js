import { encryptPayload, decryptPayload, encryptAttachment, decryptAttachment, safetyNumber } from './crypto.js';
import { unlockIdentity, pinPeer } from './vault.js';
import { compressImage, formatBytes } from './compress.js';
const $ = id => document.getElementById(id);
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = name => name.trim().split(/\s+/).filter(x => /^[\p{L}\p{N}]/u.test(x)).slice(0, 2).map(x => x[0]).join('').toUpperCase();
const time = at => new Date(at).toLocaleTimeString('ms-MY', { hour: '2-digit', minute: '2-digit', hour12: false });
const day = at => new Date(at).toLocaleDateString('ms-MY', { day: 'numeric', month: 'short', year: 'numeric' });
const today = at => new Date(at).toDateString() === new Date().toDateString();
const state = { me: null, socket: null, conversations: [], active: null, messages: [], cursor: null, filter: 'all', attachment: null, sending: false, watches: new Map(), call: null, config: { iceServers: [] } };
const peers = new Map(), imageCache = new Map(), stoppedEnvelopes = new Map();
let incomingQueue = Promise.resolve();
const enqueue = fn => { incomingQueue = incomingQueue.then(fn).catch(e => { if (state.me) toast(e.message); }); };
let emailVerificationRequest = null;
let authMode = 'register', toastTimer, typingTimer, typingSent = 0, peopleTimer, peopleRequest = 0, conversationRequest = 0, refreshVersion = 0;

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
  try { res = await fetch(`/api${url}`, init); } catch { throw new Error('Tidak dapat menghubungi pelayan. Periksa sambungan kamu.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Permintaan gagal. Cuba lagi.'); e.status = res.status; throw e; }
  return data;
}
function emit(event, data) {
  return new Promise((resolve, reject) => {
    if (!state.socket?.connected) return reject(new Error('Sambungan belum tersedia. Cuba semula sebentar.'));
    state.socket.timeout(12000).emit(event, data, (err, result) => {
      if (err) return reject(new Error('Pelayan belum menjawab. Cuba lagi.'));
      if (!result?.ok) return reject(new Error(result?.error || 'Permintaan gagal.'));
      resolve(result);
    });
  });
}
function showDialog(id) { if (!$(id).open) $(id).showModal(); }
function avatar(el, user) { el.style.background = user.color; el.textContent = initials(user.name); }
function needAccount(fn) { if (!state.me) { showDialog('authDialog'); return; } fn(); }
function currentConversation() { return state.conversations.find(c => c.id === state.active); }
function setAuthMode(mode) {
  authMode = mode;
  const register = mode === 'register';
  $('registerTab').classList.toggle('active', register);
  $('loginTab').classList.toggle('active', !register);
  $('nameLabel').hidden = !register;
  $('authName').required = register;
  $('emailHelp').hidden = !register;
  $('authTitle').textContent = register ? 'Mari kenal dulu.' : 'Hai, kembali lagi.';
  $('authSubtitle').textContent = register ? 'Cipta akaun dan mulakan cerita kamu.' : 'Cerita kamu menanti. Jom sambung.';
  $('authPassword').autocomplete = register ? 'new-password' : 'current-password';
  $('authPassword').minLength = register ? 8 : 1;
  $('authSubmit').innerHTML = `${register ? 'Jom mula' : 'Log masuk'} ${icon('arrow')}`;
  $('authError').hidden = true;
}
$('registerTab').onclick = () => setAuthMode('register');
$('loginTab').onclick = () => setAuthMode('login');
$('authForm').onsubmit = async e => {
  e.preventDefault();
  $('authSubmit').disabled = true;
  $('authError').hidden = true;
  try {
    const user = await api(`/${authMode}`, { method: 'POST', body: { name: $('authName').value, email: $('authEmail').value, password: $('authPassword').value } });
    $('authPassword').value = '';
    if (user.verificationRequired) {
      emailVerificationRequest = user.requestId; $('verifyCode').value = ''; $('verifyError').hidden = true;
      $('verifyEmailAddress').textContent = $('authEmail').value.trim();
      showDialog('verifyDialog'); return;
    }
    $('authDialog').close();
    await boot(user);
    toast(authMode === 'register' ? `Selamat datang, ${user.name}! Jemput kawan untuk mula sembang.` : `Selamat kembali, ${user.name}.`);
  } catch (err) { $('authError').textContent = err.message; $('authError').hidden = false; }
  finally { $('authSubmit').disabled = false; }
};
$('verifyForm').onsubmit = async e => {
  e.preventDefault(); $('verifySubmit').disabled = true; $('verifyError').hidden = true;
  try {
    const user = await api('/verify-email', { method: 'POST', body: { requestId: emailVerificationRequest, code: $('verifyCode').value.trim() } });
    emailVerificationRequest = null; $('verifyCode').value = ''; $('verifyDialog').close(); $('authDialog').close();
    await boot(user); toast('Emel disahkan. Selamat datang ke Sembang.');
  } catch (error) { $('verifyError').textContent = error.message; $('verifyError').hidden = false; }
  finally { $('verifySubmit').disabled = false; }
};
$('verifyBack').onclick = () => { emailVerificationRequest = null; $('verifyCode').value = ''; $('verifyDialog').close(); };
$('previewButton').onclick = () => { $('authDialog').close(); $('app').classList.add('preview'); };
for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => $(b.dataset.close).close();
for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', e => {
  if (e.target !== d || ['callDialog', 'recoveryDialog', 'unlockDialog'].includes(d.id)) return;
  const r = d.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
});
$('callDialog').addEventListener('cancel', e => { e.preventDefault(); hangup(); });

async function getPeer(conversationId) {
  if (!peers.has(conversationId)) {
    const me = state.me, identity = state.identity;
    const pending = (async () => {
      const keys = await api(`/conversations/${conversationId}/keys`);
      if (!keys.peer) throw new Error('Kenalan perlu log masuk dan menyediakan kunci chat dahulu.');
      if (keys.self?.fingerprint !== identity?.record.fingerprint) throw new Error('Kunci akaun tidak sepadan.');
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
  } catch { return { ...m, kind: 'text', body: { text: 'Mesej tidak dapat dibuka. Semak kunci dan kod pemulihan kamu.' }, secure: false, locked: true }; }
}
async function imageSource(m) {
  if (!m.secure) return m.body.url;
  if (!imageCache.has(m.body.url)) imageCache.set(m.body.url, (async () => {
    const res = await fetch(m.body.url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Gambar tidak dapat dimuatkan.');
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
async function boot(user) {
  state.me = user;
  $('app').classList.remove('preview');
  avatar($('profileButton'), user);
  $('profileButton').title = `${user.name} (@${user.username})`;
  state.socket?.disconnect();
  state.identity = await unlockIdentity(user, api);
  state.config = await api('/config');
  const socket = state.socket = io({ autoConnect: false });
  socket.on('connect', async () => {
    $('connectionDot').classList.remove('offline');
    $('connectionText').textContent = 'Dalam talian';
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
    $('connectionText').textContent = 'Menyambung semula…';
    $('offlineBanner').hidden = false;
    if (state.call) cleanupCall('Sambungan terputus');
  });
  socket.on('connect_error', err => {
    if (/log masuk/i.test(err.message)) {
      socket.disconnect(); resetSession(); setAuthMode('login'); showDialog('authDialog'); toast('Sesi kamu tamat. Sila log masuk semula.');
    }
  });
  socket.on('message', m => enqueue(() => onMessage(m)));
  socket.on('identities:changed', () => { peers.clear(); refreshConversations().catch(() => {}); });
  socket.on('message:updated', raw => enqueue(async () => {
    const m = await decodeWire(raw); if (!state.me) return;
    const index = state.messages.findIndex(x => x.id === m.id);
    if (index !== -1) { state.messages[index] = m; renderMessages(false); }
    const c = state.conversations.find(x => x.id === m.conversationId);
    if (c?.last?.id === m.id) { c.last = m; renderConversations(); }
    if (m.kind === 'location' && !m.body.active && state.watches.has(m.id)) removeWatch(m.id);
  }));
  socket.on('conversations:changed', () => refreshConversations().catch(e => toast(e.message)));
  socket.on('users:changed', () => { if ($('peopleDialog').open) loadPeople(); });
  socket.on('presence', ({ userId, online }) => {
    state.conversations.forEach(c => { if (c.peer.id === userId) c.peer.online = online; });
    renderConversations(); renderHeader();
  });
  socket.on('messages:read', ({ conversationId, userId, at }) => {
    if (conversationId === state.active) {
      state.messages.forEach(m => { if (m.senderId !== userId && !m.readAt) m.readAt = at; }); renderMessages(false);
    }
    const c = state.conversations.find(c => c.id === conversationId);
    if (c) { if (userId === state.me.id) c.unread = 0; if (c.last && c.last.senderId !== userId) c.last.readAt ||= at; renderConversations(); }
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
    try { call.accepted = true; setCallStatus('Menyambungkan panggilan…'); await offerCall(); }
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
    } catch { toast('Isyarat panggilan tidak dapat disahkan. Panggilan dihentikan.'); hangup(); }
  }));
  socket.on('call:ended', d => { if (state.call?.id === d.id) cleanupCall(d.reason); });
  socket.connect();
  await refreshConversations();
}
function resetSession() {
  for (const id of [...state.watches.keys()]) removeWatch(id);
  state.identity = null; peers.clear(); stoppedEnvelopes.clear();
  for (const promise of imageCache.values()) promise.then(url => URL.revokeObjectURL(url)).catch(() => {});
  imageCache.clear(); $('fullImage').removeAttribute('src'); $('messages').innerHTML = '';
  state.me = null; state.active = null; state.messages = []; state.conversations = [];
  conversationRequest++; refreshVersion++;
  $('app').classList.remove('chat-open');
  $('chatPanel').hidden = true; $('welcome').hidden = false;
  $('offlineBanner').hidden = true; $('connectionText').textContent = 'Sambungan selamat';
  clearAttachment(); renderConversations();
  $('profileButton').textContent = 'S';
}
async function refreshConversations() {
  const version = ++refreshVersion;
  const conversations = await api('/conversations');
  for (const c of conversations) if (c.last) c.last = await decodeWire(c.last);
  if (version !== refreshVersion || !state.me) return;
  state.conversations = conversations;
  renderConversations(); renderHeader();
}
function preview(m) {
  if (!m) return 'Mulakan cerita kamu…';
  const own = m.senderId === state.me?.id ? 'Kamu: ' : '';
  if (m.kind === 'image') return `${own}Gambar${m.body.caption ? ' · ' + m.body.caption : ''}`;
  if (m.kind === 'location') return `${own}Lokasi ${m.body.active && m.body.expires > Date.now() ? 'langsung' : 'terakhir'}`;
  return own + m.body.text;
}
function renderConversations() {
  $('chatCount').textContent = state.conversations.length;
  const unread = state.conversations.reduce((n, c) => n + c.unread, 0);
  $('unreadCount').textContent = unread;
  if (!state.call) document.title = `${unread ? `(${unread}) ` : ''}Sembang — Ruang untuk lebih dekat`;
  const q = $('chatSearch').value.toLowerCase();
  const cs = state.conversations.filter(c => `${c.peer.name} ${c.peer.username}`.toLowerCase().includes(q) && (state.filter !== 'unread' || c.unread));
  if (!cs.length) {
    $('conversationList').innerHTML = `<div class="sidebar-empty"><span class="empty-icon">${icon('chat')}</span><h3>${q ? 'Tiada perbualan dijumpai' : state.filter === 'unread' ? 'Semua sudah dibaca' : 'Cerita bermula di sini'}</h3><p>${q ? 'Cuba nama lain atau cari kawan baharu.' : state.filter === 'unread' ? 'Kamu sudah mengikuti semua cerita.' : 'Cari kawan dan mulakan<br>perbualan pertama kamu.'}</p><button class="text-button" data-new-chat>Mulakan chat ${icon('arrow')}</button></div>`;
    $('conversationList').querySelector('[data-new-chat]').onclick = openPeople;
    return;
  }
  $('conversationList').innerHTML = cs.map(c => `<button class="conversation-row ${c.id === state.active ? 'selected' : ''}" data-conversation="${c.id}" aria-label="Chat dengan ${escapeHTML(c.peer.name)}" ${c.id === state.active ? 'aria-current="true"' : ''}><div class="avatar" style="background:${c.peer.color}">${escapeHTML(initials(c.peer.name))}${c.peer.online ? '<span class="online-dot"></span>' : ''}</div><div class="conversation-summary"><div class="row-top"><h3>${escapeHTML(c.peer.name)}</h3><time>${c.last ? (today(c.last.created) ? time(c.last.created) : new Date(c.last.created).toLocaleDateString('ms-MY', { day: 'numeric', month: 'short' })) : ''}</time></div><div class="row-bottom"><p>${escapeHTML(preview(c.last))}</p>${c.unread ? `<span class="unread-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</div></div></button>`).join('');
  $('conversationList').querySelectorAll('[data-conversation]').forEach(b => { b.onclick = () => openConversation(b.dataset.conversation); });
}
function renderHeader() {
  const c = currentConversation(); if (!c) return;
  avatar($('peerAvatar'), c.peer);
  $('peerName').textContent = c.peer.name;
  $('peerStatus').textContent = c.peer.online ? 'Dalam talian · sedia untuk sembang' : `@${c.peer.username} · luar talian`;
  $('peerStatus').classList.toggle('online', c.peer.online);
}
async function openConversation(id) {
  const ticket = ++conversationRequest;
  state.active = id; state.messages = []; state.cursor = null;
  clearAttachment(); $('messageInput').value = ''; resizeInput();
  $('welcome').hidden = true; $('chatPanel').hidden = false;
  $('app').classList.add('chat-open'); $('app').classList.remove('preview');
  $('typingIndicator').hidden = true;
  $('messages').innerHTML = '<div class="empty-message">Memuatkan cerita…</div>';
  renderHeader(); renderConversations(); updateLocationBar();
  try {
    await reloadMessages(ticket);
    if (ticket === conversationRequest) { await markRead(); if (innerWidth > 760) $('messageInput').focus(); }
  } catch (e) { if (ticket === conversationRequest) { $('messages').innerHTML = '<div class="empty-message">Tidak dapat memuatkan mesej. Buka semula perbualan untuk cuba lagi.</div>'; toast(e.message); } }
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
  if (m.kind === 'image') content = `<img class="message-image" alt="${escapeHTML(m.body.caption || 'Gambar dikongsi')}" data-image="${m.id}">${m.body.caption ? `<p class="message-text image-caption">${linkText(m.body.caption)}</p>` : ''}${m.secure ? `<div class="image-compression-label">${icon('lock')} ${formatBytes(m.body.size || 0)} · dimampatkan & disulitkan</div>` : ''}`;
  else if (m.kind === 'location') {
    const b = m.body, active = m.secure && b.active && b.expires > Date.now();
    const stale = Date.now() - b.updated > 60000;
    const watching = state.watches.has(m.id);
    const maps = `https://www.google.com/maps/search/?api=1&query=${b.latitude},${b.longitude}`;
    content = `<div class="message-map" role="img" aria-label="Penanda lokasi; buka peta untuk melihat kedudukan sebenar"><span class="map-pin">${icon('pin')}</span><span class="map-coordinate">${b.latitude.toFixed(5)}, ${b.longitude.toFixed(5)}</span></div><div class="location-content"><strong>${active ? '<span class="live-dot"></span>' : ''}${active ? 'Lokasi langsung' : 'Perkongsian tamat'}</strong><p>${active ? `Sehingga ${time(b.expires)} · ` : ''}${stale ? 'Lokasi terakhir ' : 'Dikemas kini '}${time(b.updated)}${b.accuracy != null ? ` · ±${Math.round(b.accuracy)} m` : ''}</p><a class="location-link" href="${maps}" target="_blank" rel="noopener noreferrer">Buka dalam peta ${icon('external')}</a>${mine && active ? `<button class="stop-location" data-stop-location="${m.id}">Hentikan perkongsian</button>${!watching ? `<button class="text-button" data-resume-location="${m.id}">Sambung kemas kini lokasi</button>` : ''}` : ''}</div>`;
  } else content = `<p class="message-text">${m.locked ? icon('lock') : ''}${linkText(m.body.text)}</p>`;
  return `<div class="message-row ${mine ? 'mine' : ''}" data-message-id="${m.id}"><div class="message-bubble ${m.kind === 'image' || m.kind === 'location' ? 'image-bubble' : ''}">${content}${m.legacy ? '<span class="legacy-label">Mesej lama · belum disulitkan</span>' : ''}<div class="message-meta">${m.secure ? icon('lock') : ''}<time datetime="${new Date(m.created).toISOString()}">${time(m.created)}</time>${mine ? `<span class="${m.readAt ? 'read' : ''}" title="${m.readAt ? 'Dibaca' : 'Dihantar'}">${icon('check')}</span>` : ''}</div></div></div>`;
}
function renderMessages(scroll) {
  const area = $('messageArea');
  const closeToBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 110;
  const oldTop = area.scrollTop;
  let lastDay = '';
  $('messages').innerHTML = state.messages.length ? state.messages.map(m => {
    const d = day(m.created), label = d !== lastDay ? `<div class="day-marker">${today(m.created) ? 'Hari ini' : d}</div>` : '';
    lastDay = d; return label + messageHTML(m);
  }).join('') : '<div class="empty-message">Satu “hai” boleh jadi permulaan cerita yang indah. 👋</div>';
  $('olderMessages').hidden = !state.cursor;
  $('messages').querySelectorAll('[data-image]').forEach(img => {
    const m = state.messages.find(x => x.id === img.dataset.image);
    imageSource(m).then(url => { if (img.isConnected) img.src = url; }).catch(e => { if (img.isConnected) { img.alt = 'Gambar sulit gagal dibuka'; toast(e.message); } });
    img.onclick = async () => { try { $('fullImage').src = await imageSource(m); showDialog('imageDialog'); } catch (e) { toast(e.message); } };
    img.addEventListener('load', () => { if (scroll || closeToBottom) area.scrollTop = area.scrollHeight; }, { once: true });
  });
  $('messages').querySelectorAll('[data-stop-location]').forEach(b => { b.onclick = () => stopLocation(b.dataset.stopLocation); });
  $('messages').querySelectorAll('[data-resume-location]').forEach(b => { b.onclick = () => resumeLocation(b.dataset.resumeLocation); });
  if (scroll || closeToBottom) area.scrollTop = area.scrollHeight; else area.scrollTop = oldTop;
}
async function onMessage(raw) {
  const m = raw.kind === 'encrypted' ? await decodeWire(raw) : raw;
  if (!state.me) return;
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
$('backButton').onclick = () => { $('app').classList.remove('chat-open'); state.active = null; conversationRequest++; $('chatPanel').hidden = true; $('welcome').hidden = false; renderConversations(); };
$('railChats').onclick = () => { $('app').classList.remove('preview', 'chat-open'); };
async function openPeople() {
  if (!state.me) { showDialog('authDialog'); return; }
  $('app').classList.remove('preview');
  $('peopleSearch').value = ''; showDialog('peopleDialog'); await loadPeople();
}
async function loadPeople() {
  const ticket = ++peopleRequest;
  $('peopleList').innerHTML = '<p class="people-empty">Mencari kawan…</p>';
  try {
    const users = await api(`/users?q=${encodeURIComponent($('peopleSearch').value)}`);
    if (ticket !== peopleRequest) return;
    $('peopleList').innerHTML = users.length ? users.map(u => `<button class="person-row" data-person="${u.id}"><span class="avatar" style="background:${u.color}">${escapeHTML(initials(u.name))}${u.online ? '<span class="online-dot"></span>' : ''}</span><span><b>${escapeHTML(u.name)}</b><small>@${escapeHTML(u.username)}</small></span>${icon('arrow')}</button>`).join('') : '<p class="people-empty">Belum ada kawan di sini.<br>Salin pautan jemputan dan ajak mereka sertai Sembang.</p>';
    $('peopleList').querySelectorAll('[data-person]').forEach(b => { b.onclick = async () => {
      b.disabled = true;
      try { const c = await api('/conversations', { method: 'POST', body: { userId: b.dataset.person } }); await refreshConversations(); $('peopleDialog').close(); await openConversation(c.id); }
      catch (e) { toast(e.message); } finally { b.disabled = false; }
    }; });
  } catch (e) { if (ticket === peopleRequest) $('peopleList').textContent = e.message; }
}
$('peopleSearch').oninput = () => { clearTimeout(peopleTimer); peopleTimer = setTimeout(loadPeople, 200); };
for (const id of ['newChat', 'emptyNewChat', 'welcomeStart', 'railPeople']) $(id).onclick = openPeople;
$('inviteButton').onclick = async () => {
  try { await navigator.clipboard.writeText(location.origin); toast('Pautan disalin. Hantar kepada kawan dan minta mereka cipta akaun.'); }
  catch { showInfo('Jemput kawan', `<p>Kongsi pautan ini dengan kawan. Mereka boleh cipta akaun untuk mula chat.</p><p><a href="${escapeHTML(location.origin)}">${escapeHTML(location.origin)}</a></p><p>Jika pautan ini ialah localhost, ia hanya boleh dibuka pada komputer ini.</p>`); }
};
$('themeButton').onclick = () => { document.documentElement.classList.toggle('dark'); localStorage.setItem('sembang-theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light'); };
if (localStorage.getItem('sembang-theme') === 'dark') document.documentElement.classList.add('dark');
function showInfo(title, body) { $('infoTitle').textContent = title; $('infoBody').innerHTML = body; showDialog('infoDialog'); }
$('infoButton').onclick = () => showInfo('Sedikit tentang Sembang.', '<p>Satu ruang untuk chat berdua, hantar gambar, panggilan suara dan video, serta berkongsi lokasi langsung.</p><h3>Kamu yang pegang kawalan.</h3><p>Lokasi hanya dikongsi dengan izin kamu. Kamu boleh hentikannya pada bila-bila masa. Kamera dan mikrofon digunakan semasa panggilan sahaja.</p><h3>Untuk panggilan & lokasi</h3><p>Gunakan pelayar yang menyokong kamera, mikrofon dan GPS melalui HTTPS atau localhost. Kedua-dua pengguna perlu membuka Sembang untuk menerima panggilan.</p><p>Mesej baharu, gambar, lokasi dan isyarat panggilan disulitkan pada peranti sebelum dihantar. Bandingkan nombor keselamatan pada maklumat kenalan. Mesej lama belum disulitkan. Simpan kod pemulihan secara peribadi untuk peranti baharu.</p><p>Latar Stitch &amp; Angel oleh burnss di <a href="https://wallpapers.com/wallpapers/love-stitch-and-angel-900-x-1599-wallpaper-loyrl6n1ouddysi0.html" target="_blank" rel="noopener noreferrer">Wallpapers.com</a>.</p>');
$('profileButton').onclick = () => needAccount(() => {
  const u = state.me;
  showInfo('Akaun kamu', `<div class="avatar" style="background:${u.color}">${escapeHTML(initials(u.name))}</div><h3>${escapeHTML(u.name)}</h3><p>@${escapeHTML(u.username)}</p>${u.email ? `<p class="account-email">${escapeHTML(u.email)}</p>` : ''}<p>Kawan boleh mencari kamu menggunakan nama pengguna ini.</p><button class="logout-button" id="logoutButton">${icon('logout')} Log keluar</button>`);
  $('logoutButton').onclick = async () => {
    $('logoutButton').disabled = true;
    try { await stopAllLocations(); if (state.call) await hangup(); await api('/logout', { method: 'POST', body: {} }); state.socket?.disconnect(); resetSession(); $('infoDialog').close(); setAuthMode('login'); showDialog('authDialog'); }
    catch (e) { toast(e.message); if ($('logoutButton')) $('logoutButton').disabled = false; }
  };
});
$('peerInfo').onclick = async () => {
  const c = currentConversation(); if (!c) return;
  try {
    const peer = await getPeer(c.id), number = await safetyNumber(state.identity.record.fingerprint, peer.fingerprint, c.id);
    showInfo('Kenalan & keselamatan', `<div class="avatar" style="background:${c.peer.color}">${escapeHTML(initials(c.peer.name))}</div><h3>${escapeHTML(c.peer.name)}</h3><p>@${escapeHTML(c.peer.username)}</p><h3>${icon('lock')} Penyulitan hujung ke hujung</h3><p>Bandingkan nombor ini dengan kenalan melalui saluran lain. Nombor mesti sama pada kedua-dua peranti.</p><div class="safety-number">${number}</div><p>Gambar dimampatkan pada peranti sebelum disulitkan. Kandungan chat baharu tidak dihantar sebagai teks biasa.</p>`);
  } catch (e) { toast(e.message); }
};

function resizeInput() { const input = $('messageInput'); input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; $('charCount').textContent = input.value.length > 3500 ? `${input.value.length}/4000` : ''; }
$('messageInput').oninput = () => {
  resizeInput();
  if (state.active && Date.now() - typingSent > 1300) { typingSent = Date.now(); emit('typing', { conversationId: state.active, active: true }).catch(() => {}); }
};
$('messageInput').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); } };
$('composer').onsubmit = async e => {
  e.preventDefault();
  const text = $('messageInput').value.trim(), id = state.active;
  if ((!text && !state.attachment) || !id || state.sending || state.compressing) return;
  state.sending = true; $('sendButton').disabled = true; $('messageInput').disabled = true;
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
      if (a.conversationId !== id || a.clientId !== clientId) throw new Error('Pilih semula gambar untuk perbualan ini.');
      payload = { kind: 'image', url: a.url, key: a.key, iv: a.iv, caption: text, name: attachment.name, mime: attachment.mime, size: attachment.size, originalSize: attachment.originalSize, width: attachment.width, height: attachment.height };
    } else payload = { kind: 'text', text };
    const message = await sendSecure(id, payload, clientId); await onMessage(message); state.retry = null;
    if (state.active === id) { $('messageInput').value = ''; if (state.attachment === attachment) clearAttachment(); resizeInput(); }
    emit('typing', { conversationId: id, active: false }).catch(() => {});
  } catch (err) {
    if (attachment && /Muat naik gambar.*tamat tempoh/.test(err.message)) { delete attachment.uploaded; state.retry = null; }
    toast(err.message);
  }
  finally { state.sending = false; $('sendButton').disabled = false; $('messageInput').disabled = false; if (state.active === id) $('messageInput').focus(); }
};
$('imageButton').onclick = () => $('imageInput').click();
let attachmentVersion = 0;
$('imageInput').onchange = async () => {
  const file = $('imageInput').files[0]; if (!file) return;
  clearAttachment(); const version = attachmentVersion;
  state.compressing = true; $('imageButton').disabled = true; $('sendButton').disabled = true;
  toast('Sedang memampatkan gambar pada peranti…');
  try {
    const result = await compressImage(file);
    if (version !== attachmentVersion) return;
    state.attachment = { ...result, url: URL.createObjectURL(result.blob) };
    $('attachmentImage').src = state.attachment.url; $('attachmentName').textContent = result.name;
    const saved = Math.max(0, Math.round((1 - result.size / result.originalSize) * 100));
    $('compressionInfo').textContent = `${formatBytes(result.originalSize)} → ${formatBytes(result.size)}${saved ? ` · jimat ${saved}%` : ''} · ${result.width}×${result.height}${result.still ? ' · GIF jadi gambar pegun' : ''}`;
    $('attachmentPreview').hidden = false; $('messageInput').focus(); toast('Gambar siap. Ia akan disulitkan sebelum dihantar.');
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

function geolocationError(err) { return err.code === 1 ? 'Izin lokasi ditolak. Benarkan lokasi dalam tetapan pelayar.' : err.code === 2 ? 'Lokasi tidak dapat ditentukan. Pastikan GPS dihidupkan.' : 'Lokasi mengambil masa terlalu lama. Cuba lagi.'; }
function ensureLocation() {
  if (!window.isSecureContext) throw new Error('Lokasi langsung memerlukan HTTPS atau localhost.');
  if (!navigator.geolocation) throw new Error('Pelayar ini tidak menyokong lokasi.');
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
    await prepareStop(message); watchLocation(message); await onMessage(message); $('locationDialog').close(); toast('Lokasi langsung dikongsi. Kamu boleh hentikan pada bila-bila masa.');
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
    } catch (e) { if (/dijumpai/.test(e.message)) removeWatch(w.id); }
  })();
  try { await w.pending; } finally { w.pending = null; }
}
async function resumeLocation(id) {
  const m = state.messages.find(x => x.id === id); if (!m) return;
  try { ensureLocation(); const p = await getPosition(); await prepareStop(m); watchLocation(m); await updateLocation(state.watches.get(id), p); renderMessages(false); toast('Kemas kini lokasi disambung.'); } catch (e) { toast(e.message); }
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
    if (!update) throw new Error('Kunci lokasi tidak tersedia.');
    if (state.socket?.connected) await emit('message:update', { messageId: id, envelope: update.envelope });
    else await api('/locations/stop', { method: 'POST', body: { updates: [update] } });
    stoppedEnvelopes.delete(id);
    if (m) m.body.active = false;
    const shown = state.messages.find(x => x.id === id); if (shown) shown.body.active = false;
    if (state.me) renderMessages(false);
  } catch { toast('GPS dihentikan. Pelayan belum dapat dihubungi; lokasi terakhir mungkin kekal hingga tamat tempoh.'); }
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
  if (e.name === 'NotAllowedError') return 'Izin kamera atau mikrofon ditolak. Benarkan dalam tetapan pelayar.';
  if (e.name === 'NotFoundError') return 'Kamera atau mikrofon tidak ditemui pada peranti ini.';
  if (e.name === 'NotReadableError') return 'Kamera atau mikrofon sedang digunakan oleh aplikasi lain.';
  return e.message || 'Peranti panggilan tidak tersedia.';
}
async function getMedia(video) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Panggilan memerlukan HTTPS atau localhost dan pelayar yang menyokong kamera/mikrofon.');
  try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false }); }
  catch (e) { throw new Error(mediaError(e)); }
}
function showCall(person, video, incoming) {
  avatar($('callAvatar'), person); $('callName').textContent = person.name;
  $('callType').textContent = video ? 'Panggilan video' : 'Panggilan suara';
  $('callStatus').textContent = incoming ? 'Panggilan masuk…' : 'Menyediakan panggilan…';
  $('acceptCall').hidden = !incoming; $('muteCall').hidden = incoming; $('toggleCamera').hidden = !video || incoming;
  $('muteCall').classList.remove('off'); $('muteCall').innerHTML = icon('mic'); $('muteCall').setAttribute('aria-label', 'Bisu mikrofon');
  $('toggleCamera').classList.remove('off'); $('toggleCamera').innerHTML = icon('video'); $('callDialog').classList.remove('connected');
  $('remoteVideo').classList.remove('has-video'); $('localVideo').classList.remove('has-video'); $('callNetworkStatus').hidden = true;
  showDialog('callDialog');
}
function setCallStatus(text) { $('callStatus').textContent = text; }
async function startCall(video) {
  const c = currentConversation(); if (!c || state.call) return;
  if (!c.peer.online) { toast('Kawan kamu sedang luar talian. Cuba apabila mereka membuka Sembang.'); return; }
  const call = state.call = { id: null, outgoing: true, video, person: c.peer, conversationId: c.id, stream: null, pc: null, candidates: [], started: null, timer: null, timeout: null };
  showCall(c.peer, video, false);
  try {
    await getPeer(c.id);
    const stream = await getMedia(video);
    if (state.call !== call) { stream.getTracks().forEach(t => t.stop()); return; }
    call.stream = stream; attachLocalStream(call); createPeer(call);
    const result = await emit('call:start', { conversationId: c.id, video });
    if (state.call !== call) { emit('call:end', { id: result.id }).catch(() => {}); return; }
    call.id = result.id; if (!call.accepted) setCallStatus('Berdering…');
    call.timeout = setTimeout(() => { if (state.call === call && !call.started) { toast('Panggilan tidak dapat disambung. Semak rangkaian atau konfigurasi TURN.'); hangup(); } }, 65000);
  } catch (e) { if (state.call === call) { toast(e.message); cleanupCall(); } }
}
function incomingCall(d) {
  if (state.call) { emit('call:end', { id: d.id }).catch(() => {}); return; }
  const call = state.call = { id: d.id, outgoing: false, video: d.video, person: d.from, conversationId: d.conversationId, stream: null, pc: null, candidates: [], started: null, timer: null, timeout: null };
  showCall(d.from, d.video, true); document.title = `${d.from.name} sedang memanggil — Sembang`;
  call.timeout = setTimeout(() => { if (state.call === call && !call.pc) cleanupCall('Panggilan terlepas'); }, 32000);
}
$('voiceCall').onclick = () => startCall(false);
$('videoCall').onclick = () => startCall(true);
$('acceptCall').onclick = async () => {
  const call = state.call; if (!call || call.outgoing) return;
  $('acceptCall').disabled = true;
  try {
    await getPeer(call.conversationId);
    const stream = await getMedia(call.video);
    if (state.call !== call) { stream.getTracks().forEach(t => t.stop()); return; }
    call.stream = stream; attachLocalStream(call); createPeer(call);
    await emit('call:accept', { id: call.id });
    if (state.call !== call) return;
    clearTimeout(call.timeout); call.timeout = setTimeout(() => { if (!call.started && state.call === call) { toast('Sambungan panggilan gagal. Semak konfigurasi TURN.'); hangup(); } }, 35000);
    $('acceptCall').hidden = true; $('muteCall').hidden = false; $('toggleCamera').hidden = !call.video;
    setCallStatus('Menyambungkan panggilan…');
  } catch (e) { toast(e.message); await hangup(); }
  finally { $('acceptCall').disabled = false; }
};
function attachLocalStream(call) {
  $('localVideo').srcObject = call.stream;
  $('localVideo').classList.toggle('has-video', call.video);
}
function createPeer(call) {
  const pc = call.pc = new RTCPeerConnection(state.config);
  call.stream.getTracks().forEach(t => pc.addTrack(t, call.stream));
  pc.onicecandidate = e => { if (e.candidate && call.id && state.call === call) sendCallSignal(call, { candidate: e.candidate.toJSON() }).catch(() => {}); };
  pc.ontrack = e => {
    if (state.call !== call) return;
    $('remoteVideo').srcObject = e.streams[0];
    $('remoteVideo').classList.toggle('has-video', call.video);
    $('remoteVideo').play().catch(() => { toast('Ketik pada video untuk memainkan audio panggilan.'); $('remoteVideo').onclick = () => $('remoteVideo').play(); });
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
    } else if (pc.connectionState === 'disconnected') {
      $('callNetworkStatus').textContent = 'Sambungan tidak stabil. Sedang mencuba semula…'; $('callNetworkStatus').hidden = false;
      clearTimeout(call.timeout); call.timeout = setTimeout(() => { if (state.call === call) { toast('Sambungan panggilan terputus. Cuba panggil semula.'); hangup(); } }, 15000);
    } else if (pc.connectionState === 'failed') {
      toast('Panggilan gagal disambung. Rangkaian ini mungkin memerlukan pelayan TURN.'); hangup();
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
  if (signal.description) {
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
  $('callDialog').close(); $('callDialog').classList.remove('connected');
  renderConversations(); if (reason) toast(reason);
}
$('endCall').onclick = hangup;
$('muteCall').onclick = () => {
  const tracks = state.call?.stream?.getAudioTracks(); if (!tracks?.length) return;
  const enabled = !tracks[0].enabled; tracks.forEach(t => { t.enabled = enabled; });
  $('muteCall').classList.toggle('off', !enabled); $('muteCall').innerHTML = icon(enabled ? 'mic' : 'micoff');
  $('muteCall').title = enabled ? 'Bisu mikrofon' : 'Hidupkan mikrofon'; $('muteCall').setAttribute('aria-label', $('muteCall').title);
};
$('toggleCamera').onclick = () => {
  const tracks = state.call?.stream?.getVideoTracks(); if (!tracks?.length) return;
  const enabled = !tracks[0].enabled; tracks.forEach(t => { t.enabled = enabled; }); $('toggleCamera').classList.toggle('off', !enabled); $('toggleCamera').innerHTML = icon(enabled ? 'video' : 'cameraoff');
};

// Called by the Android system Back action; keep key setup dialogs recoverable.
window.sembangAndroidBack = () => {
  const modal = document.querySelector('dialog[open]');
  if (modal) {
    if (modal.id === 'recoveryDialog' || modal.id === 'unlockDialog') { toast('Simpan atau pulihkan kod kunci dahulu.'); return true; }
    if (modal.id === 'callDialog') { hangup(); return true; }
    if (modal.id === 'authDialog') return false;
    modal.close(); return true;
  }
  if ($('app').classList.contains('chat-open')) { $('backButton').click(); return true; }
  return false;
};

(async () => {
  try { await boot(await api('/me')); }
  catch (e) { showDialog('authDialog'); if (e.status !== 401) toast(e.message); }
})();
