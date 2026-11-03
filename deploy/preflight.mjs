import { loadConfig } from '../lib/config.js';
const domain = process.env.SEMBANG_DOMAIN;
if (!domain || domain === 'chat.example.com' || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) throw new Error('Tetapkan SEMBANG_DOMAIN kepada domain sebenar tanpa https:// atau laluan.');
loadConfig({ ...process.env, NODE_ENV: 'production', APP_ORIGIN: `https://${domain}`, COOKIE_SECURE: 'true', EMAIL_VERIFICATION_REQUIRED: 'true' });
console.log('Konfigurasi production sah. Semak DNS, port 80/443 dan penghantaran SMTP pada VPS sebelum jemput pengguna.');
