// Web Crypto only. Private keys never leave the client in plaintext.
const enc = new TextEncoder();
const dec = new TextDecoder();
const VAULT_ITERATIONS = 600000;
export const toB64 = value => {
  const bytes = new Uint8Array(value); let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(out);
};
export const fromB64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const publicPart = key => ({ kty: 'EC', crv: 'P-256', x: key.x, y: key.y });
export async function fingerprint(publicKey) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify(publicPart(publicKey)))))].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function aes(raw, usages) { return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages); }
async function passwordVaultKey(password, salt, iterations, usages) {
  if (typeof password !== 'string' || password.length < 1 || password.length > 128) throw new Error('A password is required to unlock chat.');
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, usages);
}
export async function sealBytes(key, bytes, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context), tagLength: 128 }, key, bytes);
  return { iv: toB64(iv), data };
}
export async function openBytes(key, iv, data, context) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv), additionalData: enc.encode(context), tagLength: 128 }, key, data);
}
export async function createIdentity(password) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKey = publicPart(jwk), id = await fingerprint(publicKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const backup = await sealBytes(await passwordVaultKey(password, salt, VAULT_ITERATIONS, ['encrypt']), enc.encode(JSON.stringify(jwk)), `Sembang/v2/vault|${id}`);
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { privateKey, record: { publicKey, fingerprint: id, backup: { v: 2, kdf: 'PBKDF2-SHA-256', iterations: VAULT_ITERATIONS, salt: toB64(salt), iv: backup.iv, data: toB64(backup.data) } } };
}
export async function recoverIdentity(record, password) {
  try {
    const backup = record?.backup;
    if (backup?.v !== 2 || backup.kdf !== 'PBKDF2-SHA-256' || backup.iterations !== VAULT_ITERATIONS) throw new Error();
    const salt = fromB64(backup.salt);
    if (salt.length !== 16) throw new Error();
    const plain = await openBytes(await passwordVaultKey(password, salt, backup.iterations, ['decrypt']), backup.iv, fromB64(backup.data), `Sembang/v2/vault|${record.fingerprint}`);
    const jwk = JSON.parse(dec.decode(plain));
    if (await fingerprint(jwk) !== record.fingerprint || await fingerprint(record.publicKey) !== record.fingerprint) throw new Error();
    const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    return { privateKey, record };
  } catch { throw new Error('The chat key could not be unlocked. Sign in again with the correct account password.'); }
}
export async function conversationKey(identity, peer, conversationId, senderKey, recipientKey) {
  if (await fingerprint(peer.publicKey) !== peer.fingerprint) throw new Error('The contact key is invalid.');
  const remote = await crypto.subtle.importKey('jwk', publicPart(peer.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: remote }, identity.privateKey, 256);
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(conversationId), info: enc.encode(`Sembang/v1/messages|${senderKey}|${recipientKey}`) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const aad = (conversationId, senderId, clientId, body) => JSON.stringify(['Sembang/v1', conversationId, senderId, clientId, body.senderKey, body.recipientKey]);
export async function encryptPayload(identity, peer, conversationId, senderId, clientId, payload) {
  const body = { v: 1, senderKey: identity.record.fingerprint, recipientKey: peer.fingerprint };
  const key = await conversationKey(identity, peer, conversationId, body.senderKey, body.recipientKey);
  const sealed = await sealBytes(key, enc.encode(JSON.stringify(payload)), aad(conversationId, senderId, clientId, body));
  return { ...body, iv: sealed.iv, data: toB64(sealed.data) };
}
export async function decryptPayload(identity, peer, message, myId) {
  const b = message.body;
  const own = message.senderId === myId;
  if (b.v !== 1 || b.senderKey !== (own ? identity.record.fingerprint : peer.fingerprint) || b.recipientKey !== (own ? peer.fingerprint : identity.record.fingerprint)) throw new Error('The message keys do not match.');
  const key = await conversationKey(identity, peer, message.conversationId, b.senderKey, b.recipientKey);
  const data = await openBytes(key, b.iv, fromB64(b.data), aad(message.conversationId, message.senderId, message.clientId, b));
  return JSON.parse(dec.decode(data));
}
export async function encryptAttachment(blob, context) {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const sealed = await sealBytes(await aes(rawKey, ['encrypt']), await blob.arrayBuffer(), context);
  return { blob: new Blob([sealed.data], { type: 'application/octet-stream' }), key: toB64(rawKey), iv: sealed.iv };
}
export async function decryptAttachment(buffer, descriptor, context) {
  const data = await openBytes(await aes(fromB64(descriptor.key), ['decrypt']), descriptor.iv, buffer, context);
  return new Blob([data], { type: descriptor.mime });
}
export async function safetyNumber(a, b, conversationId) {
  const input = [...[a, b].sort(), conversationId].join('|');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input)))].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{1,4}/g).join(' ');
}
