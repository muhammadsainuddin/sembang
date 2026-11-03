import { readdirSync, statSync, statfsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 + 16;
export function mediaStorage(db, dataDir, config) {
  const directory = path.join(dataDir, 'uploads');
  const reservations = new Map();
  let reservedBytes = 0;
  let storedBytes = readdirSync(directory).reduce((sum, file) => {
    const stat = statSync(path.join(directory, file)); return sum + (stat.isFile() ? stat.size : 0);
  }, 0);
  const error = (message, status = 507) => Object.assign(new Error(message), { status });
  function freeSpace(additional = 0) {
    const disk = statfsSync(directory);
    if (disk.bavail * disk.bsize - reservedBytes - additional < config.minFreeBytes) throw error('Ruang pelayan hampir penuh. Cuba lagi selepas storan ditambah.');
  }
  function reserve(userId) {
    if (reservedBytes >= 16 * MAX_UPLOAD_BYTES || (reservations.get(userId) || 0) >= 2 * MAX_UPLOAD_BYTES) throw error('Muat naik sedang sibuk. Cuba sebentar lagi.', 503);
    const used = db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM media WHERE owner_id=?').get(userId).n;
    if (used + (reservations.get(userId) || 0) + MAX_UPLOAD_BYTES > config.userStorageBytes) throw error('Kuota gambar akaun sudah penuh.', 413);
    if (storedBytes + reservedBytes + MAX_UPLOAD_BYTES > config.totalStorageBytes) throw error('Kuota storan pelayan sudah penuh.');
    freeSpace(MAX_UPLOAD_BYTES);
    reservedBytes += MAX_UPLOAD_BYTES;
    reservations.set(userId, (reservations.get(userId) || 0) + MAX_UPLOAD_BYTES);
    let released = false;
    return () => {
      if (released) return; released = true;
      reservedBytes -= MAX_UPLOAD_BYTES;
      const remaining = reservations.get(userId) - MAX_UPLOAD_BYTES;
      if (remaining) reservations.set(userId, remaining); else reservations.delete(userId);
    };
  }
  function cleanup(now = Date.now()) {
    const expired = db.prepare('SELECT id,filename,bytes FROM media WHERE committed=0 AND created_at<?').all(now - config.pendingUploadMs);
    for (const row of expired) {
      try { unlinkSync(path.join(directory, row.filename)); }
      catch (error) { if (error.code !== 'ENOENT') continue; }
      db.prepare('DELETE FROM media WHERE id=? AND committed=0').run(row.id);
      storedBytes = Math.max(0, storedBytes - row.bytes);
    }
    return expired.length;
  }
  return { reserve, freeSpace, cleanup, added(bytes) { storedBytes += bytes; } };
}
