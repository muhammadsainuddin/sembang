import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(tmpdir(), 'zbuddy-server-package-'));
const dir = path.join(temp, 'zbuddy-nodejs-server'); mkdirSync(dir);
try {
  for (const name of ['server.js', 'lib', 'deploy', 'ALMALINUX.md', 'package.json', 'package-lock.json', 'public', 'test', 'Dockerfile', '.dockerignore', 'compose.yaml', 'compose.external-proxy.yaml', 'Caddyfile', '.env.example']) cpSync(path.join(root, name), path.join(dir, name), { recursive: true });
  mkdirSync(path.join(dir, 'scripts'));
  cpSync(path.join(root, 'scripts/backup.mjs'), path.join(dir, 'scripts/backup.mjs'));
  cpSync(path.join(root, 'SERVER.md'), path.join(dir, 'README.md'));
  cpSync(path.join(root, 'README.md'), path.join(dir, 'DEVELOPMENT.md'));
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  pkg.scripts = { start: 'node server.js', dev: 'node --watch server.js', test: 'node --test test/*.test.js', backup: 'node scripts/backup.mjs' };
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const target = path.join(root, 'releases', `zbuddy-nodejs-server-v${pkg.version}.zip`); mkdirSync(path.dirname(target), { recursive: true });
  const archive = path.join(temp, 'server.zip');
  const r = process.platform === 'win32'
    ? spawnSync('tar.exe', ['-a', '-c', '-f', archive, 'zbuddy-nodejs-server'], { cwd: temp, stdio: 'inherit' })
    : spawnSync('zip', ['-q', '-r', archive, 'zbuddy-nodejs-server'], { cwd: temp, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('The server package could not be generated.');
  copyFileSync(archive, target);
  const digest = createHash('sha256').update(readFileSync(target)).digest('hex'); writeFileSync(target + '.sha256', `${digest}  ${path.basename(target)}\n`);
  console.log(`Node.js package ready: ${target}`);
} finally { rmSync(temp, { recursive: true, force: true }); }
