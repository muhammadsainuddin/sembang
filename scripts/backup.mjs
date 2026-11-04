import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync, mkdirSync, statSync, chmodSync, rmSync, renameSync, readdirSync, unlinkSync, writeFileSync, createReadStream, statfsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function createBackup(dataDir, backupDir, { retentionDays = 14 } = {}) {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(path.join(backupDir, '.work-'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir, `sembang-backup-${stamp}-${randomBytes(3).toString('hex')}.tar.gz`);
  const partial = target + '.partial';
  let source, snapshot;
  try {
    source = new DatabaseSync(path.join(dataDir, 'sembang.sqlite'), { readOnly: true });
    const sourceBytes = statSync(path.join(dataDir, 'sembang.sqlite')).size;
    const mediaBytes = source.prepare('SELECT coalesce(sum(bytes),0) AS n FROM media WHERE committed=1').get().n;
    let avatarFiles = source.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'avatar')
      ? source.prepare('SELECT avatar AS filename FROM users WHERE avatar IS NOT NULL').all() : [];
    let avatarBytes = 0;
    for (const { filename } of avatarFiles) {
      if (path.basename(filename) !== filename || !/^[A-Za-z0-9_.-]+$/.test(filename) || filename === '.' || filename === '..') throw new Error('Nama foto profil tidak sah dalam pangkalan data.');
      avatarBytes += statSync(path.join(dataDir, 'avatars', filename)).size;
    }
    const disk = statfsSync(backupDir);
    const reserve = Math.max(512, Number(process.env.MIN_FREE_DISK_MB || 512)) * 1048576;
    if (disk.bavail * disk.bsize < sourceBytes * 3 + mediaBytes + avatarBytes + reserve) throw new Error('Ruang backup tidak mencukupi; backup lama dikekalkan.');
    await backup(source, path.join(staging, 'sembang.sqlite')); source.close(); source = null;
    snapshot = new DatabaseSync(path.join(staging, 'sembang.sqlite'));
    // Only immutable committed objects are part of a consistent online snapshot.
    snapshot.prepare('DELETE FROM media WHERE committed=0').run();
    const files = snapshot.prepare('SELECT filename FROM media WHERE committed=1').all();
    avatarFiles = snapshot.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'avatar')
      ? snapshot.prepare('SELECT avatar AS filename FROM users WHERE avatar IS NOT NULL').all() : [];
    snapshot.exec('PRAGMA wal_checkpoint(TRUNCATE)'); snapshot.close(); snapshot = null;
    chmodSync(path.join(staging, 'sembang.sqlite'), 0o600);
    mkdirSync(path.join(staging, 'uploads'), { mode: 0o700 });
    for (const { filename } of files) {
      if (path.basename(filename) !== filename || !/^[A-Za-z0-9_.-]+$/.test(filename) || filename === '.' || filename === '..') throw new Error('Nama media tidak sah dalam snapshot.');
      const original = path.resolve(dataDir, 'uploads', filename);
      if (!statSync(original).isFile()) throw new Error('Fail media snapshot tidak tersedia.');
      copyFileSync(original, path.join(staging, 'uploads', filename));
      chmodSync(path.join(staging, 'uploads', filename), 0o600);
    }
    mkdirSync(path.join(staging, 'avatars'), { mode: 0o700 });
    for (const { filename } of avatarFiles) {
      if (path.basename(filename) !== filename || !/^[A-Za-z0-9_.-]+$/.test(filename) || filename === '.' || filename === '..') throw new Error('Nama foto profil tidak sah dalam snapshot.');
      copyFileSync(path.join(dataDir, 'avatars', filename), path.join(staging, 'avatars', filename));
      chmodSync(path.join(staging, 'avatars', filename), 0o600);
    }
    const vapidSource = path.join(dataDir, 'push-vapid.json');
    copyFileSync(vapidSource, path.join(staging, 'push-vapid.json'));
    chmodSync(path.join(staging, 'push-vapid.json'), 0o600);
    writeFileSync(path.join(staging, 'backup.json'), JSON.stringify({ format: 1, createdAt: new Date().toISOString(), mediaFiles: files.length, avatarFiles: avatarFiles.length, serverVersion: '1.11.0' })+'\n', { mode: 0o600 });
    const result = spawnSync('tar', ['-h', '-czf', partial, '-C', staging, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status !== 0) throw new Error('Arkib backup gagal; semak ruang backup dan ketersediaan fail.');
    chmodSync(partial, 0o600); renameSync(partial, target);
    const hash = createHash('sha256'); for await (const chunk of createReadStream(target)) hash.update(chunk);
    writeFileSync(target+'.sha256', `${hash.digest('hex')}  ${path.basename(target)}\n`, { mode: 0o600 });
    const cutoff = Date.now() - retentionDays * 86400000;
    for (const file of readdirSync(backupDir)) {
      if (!/^sembang-backup-\d{4}-\d{2}-\d{2}T[0-9TZ-]+-[a-f0-9]{6}\.tar\.gz$/.test(file)) continue;
      const old = path.join(backupDir,file);
      if (statSync(old).mtimeMs < cutoff) { unlinkSync(old); try { unlinkSync(old+'.sha256'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    }
    return target;
  } finally {
    source?.close(); snapshot?.close(); rmSync(staging, { recursive: true, force: true });
    try { unlinkSync(partial); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const days = Number(process.env.BACKUP_RETENTION_DAYS || 14);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('BACKUP_RETENTION_DAYS mesti 1–365.');
  const result = await createBackup(process.env.DATA_DIR || '/app/data', process.env.BACKUP_DIR || '/backups', { retentionDays: days });
  console.log(`Backup siap: ${path.basename(result)}`);
}
