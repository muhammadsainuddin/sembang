export function loadConfig(env = process.env) {
  const number = (key, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const value = env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} is invalid.`);
    return value;
  };
  const production = env.NODE_ENV === 'production';
  const origin = env.APP_ORIGIN || '';
  if (origin) {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('APP_ORIGIN must be an origin without a path.');
    if (production && url.protocol !== 'https:') throw new Error('APP_ORIGIN must use HTTPS in production.');
  }
  if (production && (!origin || env.COOKIE_SECURE !== 'true')) throw new Error('Production requires an HTTPS APP_ORIGIN and COOKIE_SECURE=true.');
  const trustProxy = (env.TRUST_PROXY || '').split(',').map(x => x.trim()).filter(Boolean);
  if (trustProxy.some(x => ['true', 'false'].includes(x) || /^\d+$/.test(x))) throw new Error('TRUST_PROXY must contain proxy addresses/CIDRs, not true or a hop count.');
  const requireEmailVerification = env.EMAIL_VERIFICATION_REQUIRED === undefined ? production : env.EMAIL_VERIFICATION_REQUIRED === 'true';
  if (production && !requireEmailVerification) throw new Error('Email verification is required in production.');
  if (requireEmailVerification && (!env.SMTP_HOST || !env.SMTP_FROM)) throw new Error('Set SMTP_HOST and SMTP_FROM for email verification.');
  if (!!env.SMTP_USER !== !!env.SMTP_PASSWORD) throw new Error('SMTP_USER and SMTP_PASSWORD must be set together.');
  if (production && !env.AUTH_SECRET) throw new Error('Production requires a random AUTH_SECRET of at least 32 bytes.');
  if (env.AUTH_SECRET && env.AUTH_SECRET.length < 43) throw new Error('AUTH_SECRET is too short; generate one with openssl rand -hex 32.');
  const mapStyleUrl = env.MAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/liberty';
  const mapStyle = new URL(mapStyleUrl);
  if (mapStyle.protocol !== 'https:' || mapStyle.username || mapStyle.password) throw new Error('MAP_STYLE_URL must be a valid HTTPS URL.');
  const vapidSubject = env.VAPID_SUBJECT || (env.SMTP_USER ? `mailto:${env.SMTP_USER}` : origin || 'mailto:admin@localhost.invalid');
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(vapidSubject)) throw new Error('VAPID_SUBJECT must be a mailto: or valid HTTPS URL.');
  return {
    production, origin, trustProxy, requireEmailVerification, mapStyleUrl, vapidSubject,
    firebaseServiceAccountFile: env.FIREBASE_SERVICE_ACCOUNT_FILE || '', firebaseServiceAccountBase64: env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '',
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'), port: number('PORT', 3000, 1, 65535),
    cookieSecure: env.COOKIE_SECURE === 'true', authSecret: env.AUTH_SECRET || 'local-development-only-change-before-deployment',
    sessionMs: number('SESSION_HOURS', 168, 1, 720) * 3600000,
    maxActiveSessions: number('MAX_ACTIVE_SESSIONS', 50, 2, 200),
    userStorageBytes: number('USER_STORAGE_MB', 256, 3) * 1048576,
    totalStorageBytes: number('TOTAL_STORAGE_MB', 4096, 3) * 1048576,
    minFreeBytes: number('MIN_FREE_DISK_MB', 512, 0) * 1048576,
    pendingUploadMs: number('UPLOAD_PENDING_HOURS', 24, 1, 168) * 3600000,
    maxUserMessages: number('MAX_USER_MESSAGES', 50000), maxTotalMessages: number('MAX_TOTAL_MESSAGES', 500000),
    maxConversations: number('MAX_CONVERSATIONS', 500), maxUsers: number('MAX_USERS', 100, 1, 1000), registrationEnabled: env.REGISTRATION_ENABLED !== 'false',
    accountApprovalRequired: env.ACCOUNT_APPROVAL_REQUIRED === undefined ? production : env.ACCOUNT_APPROVAL_REQUIRED === 'true',
    smtp: { host: env.SMTP_HOST, port: number('SMTP_PORT', 587, 1, 65535), secure: env.SMTP_SECURE === 'true', from: env.SMTP_FROM,
      ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}) },
    turnUrls: (env.TURN_URL || '').split(',').filter(Boolean), turnSecret: env.TURN_SHARED_SECRET || '',
    turnUsername: env.TURN_USERNAME || '', turnCredential: env.TURN_CREDENTIAL || '',
  };
}
