export function loadConfig(env = process.env) {
  const number = (key, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const value = env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} tidak sah.`);
    return value;
  };
  const production = env.NODE_ENV === 'production';
  const origin = env.APP_ORIGIN || '';
  if (origin) {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('APP_ORIGIN mesti origin tanpa laluan.');
    if (production && url.protocol !== 'https:') throw new Error('APP_ORIGIN production mesti HTTPS.');
  }
  if (production && (!origin || env.COOKIE_SECURE !== 'true')) throw new Error('Production memerlukan APP_ORIGIN HTTPS dan COOKIE_SECURE=true.');
  const trustProxy = (env.TRUST_PROXY || '').split(',').map(x => x.trim()).filter(Boolean);
  if (trustProxy.some(x => ['true', 'false'].includes(x) || /^\d+$/.test(x))) throw new Error('TRUST_PROXY mesti alamat/CIDR proxy, bukan true atau bilangan hop.');
  const requireEmailVerification = env.EMAIL_VERIFICATION_REQUIRED === undefined ? production : env.EMAIL_VERIFICATION_REQUIRED === 'true';
  if (production && !requireEmailVerification) throw new Error('Pengesahan emel wajib untuk production.');
  if (requireEmailVerification && (!env.SMTP_HOST || !env.SMTP_FROM)) throw new Error('Tetapkan SMTP_HOST dan SMTP_FROM untuk pengesahan emel.');
  if (!!env.SMTP_USER !== !!env.SMTP_PASSWORD) throw new Error('SMTP_USER dan SMTP_PASSWORD mesti ditetapkan bersama.');
  if (production && !env.AUTH_SECRET) throw new Error('Production memerlukan AUTH_SECRET rawak sekurang-kurangnya 32 bait.');
  if (env.AUTH_SECRET && env.AUTH_SECRET.length < 43) throw new Error('AUTH_SECRET terlalu pendek; jana dengan openssl rand -hex 32.');
  return {
    production, origin, trustProxy, requireEmailVerification,
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'), port: number('PORT', 3000, 1, 65535),
    cookieSecure: env.COOKIE_SECURE === 'true', authSecret: env.AUTH_SECRET || 'local-development-only-change-before-deployment',
    sessionMs: number('SESSION_HOURS', 168, 1, 720) * 3600000,
    userStorageBytes: number('USER_STORAGE_MB', 256, 3) * 1048576,
    totalStorageBytes: number('TOTAL_STORAGE_MB', 4096, 3) * 1048576,
    minFreeBytes: number('MIN_FREE_DISK_MB', 512, 0) * 1048576,
    pendingUploadMs: number('UPLOAD_PENDING_HOURS', 24, 1, 168) * 3600000,
    maxUserMessages: number('MAX_USER_MESSAGES', 50000), maxTotalMessages: number('MAX_TOTAL_MESSAGES', 500000),
    maxConversations: number('MAX_CONVERSATIONS', 500), registrationEnabled: env.REGISTRATION_ENABLED !== 'false',
    smtp: { host: env.SMTP_HOST, port: number('SMTP_PORT', 587, 1, 65535), secure: env.SMTP_SECURE === 'true', from: env.SMTP_FROM,
      ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}) },
    turnUrls: (env.TURN_URL || '').split(',').filter(Boolean), turnSecret: env.TURN_SHARED_SECRET || '',
    turnUsername: env.TURN_USERNAME || '', turnCredential: env.TURN_CREDENTIAL || '',
  };
}
