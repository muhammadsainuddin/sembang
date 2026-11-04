import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const android = path.join(root, 'android');
const javaCandidates = [process.env.JAVA_HOME, '/Applications/Android Studio.app/Contents/jbr/Contents/Home', '/usr/lib/jvm/java-21-openjdk-amd64', '/usr/lib/jvm/java-17-openjdk-amd64'].filter(Boolean);
const javaHome = javaCandidates.find(p => existsSync(path.join(p, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')));
const sdk = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(homedir(), 'Library/Android/sdk'), path.join(homedir(), 'Android/Sdk')].filter(Boolean).find(existsSync);
if (!javaHome || !sdk) throw new Error('Install Android Studio + SDK and set JAVA_HOME/ANDROID_HOME before building the APK.');
const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk };
function run(exe, args, extra = {}) { const r = spawnSync(exe, args, { cwd: android, env, stdio: 'inherit', ...extra }); if (r.status !== 0) throw new Error(`Build failed (${path.basename(exe)}).`); }
writeFileSync(path.join(android, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n`);
const signDir = path.join(android, '.signing'); mkdirSync(signDir, { recursive: true, mode: 0o700 });
const keystore = path.join(signDir, 'sembang.jks'), properties = path.join(signDir, 'signing.properties');
if (!existsSync(keystore)) {
  if (existsSync(properties)) throw new Error('The signing key is missing. Restore android/.signing/sembang.jks before building an update.');
  const password = randomBytes(32).toString('hex');
  run(path.join(javaHome, 'bin', 'keytool'), ['-genkeypair', '-keystore', keystore, '-storetype', 'JKS', '-alias', 'sembang', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=Sembang, OU=Android, O=Sembang', '-storepass:env', 'SEMBANG_SIGN_PASSWORD', '-keypass:env', 'SEMBANG_SIGN_PASSWORD', '-noprompt'], { env: { ...env, SEMBANG_SIGN_PASSWORD: password } });
  writeFileSync(properties, `keyAlias=sembang\nstorePassword=${password}\nkeyPassword=${password}\n`, { mode: 0o600 }); chmodSync(keystore, 0o600);
}
if (!existsSync(properties)) throw new Error('Restore android/.signing/signing.properties to use the existing signing key.');
const tasks = process.argv.includes('--check') ? ['testDebugUnitTest', 'lintRelease', 'assembleRelease'] : ['assembleRelease'];
const args = ['--no-daemon', ...tasks];
if (process.env.SEMBANG_SERVER_URL) {
  const u = new URL(process.env.SEMBANG_SERVER_URL);
  if (u.protocol !== 'https:' || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new Error('SEMBANG_SERVER_URL must be an HTTPS origin without a path or credentials.');
  args.push(`-PserverUrl=${u.origin}`);
}
run(process.platform === 'win32' ? 'gradlew.bat' : path.join(android, 'gradlew'), args, { shell: process.platform === 'win32' });
const releases = path.join(root, 'releases'); mkdirSync(releases, { recursive: true });
const version = /versionName\s+'([0-9]+\.[0-9]+\.[0-9]+)'/.exec(readFileSync(path.join(android, 'app/build.gradle'), 'utf8'))?.[1];
if (!version) throw new Error('Android version not found.');
const target = path.join(releases, `zbuddy-v${version}.apk`); copyFileSync(path.join(android, 'app/build/outputs/apk/release/app-release.apk'), target);
const sum = createHash('sha256').update(readFileSync(target)).digest('hex'); writeFileSync(`${target}.sha256`, `${sum}  ${path.basename(target)}\n`);
console.log(`APK ready: ${target}`);
