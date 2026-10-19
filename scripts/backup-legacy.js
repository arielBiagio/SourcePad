import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'backups', `better-auth-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`);
await mkdir(path.join(destination, 'scripts'), { recursive: true });
// Copias del código de trabajo (incluye los cambios locales), nunca de .env.
for (const name of ['server.js', 'auth.js', 'auth.html', 'index.html', 'package.json', 'package-lock.json', '.gitignore', '.env.example', 'scripts/migrate-auth.js']) {
  await copyFile(path.join(root, name), path.join(destination, name));
}
try {
  const db = new Database(path.join(root, 'auth.sqlite'), { readonly: true, fileMustExist: true });
  try { await db.backup(path.join(destination, 'auth.sqlite')); }
  finally { db.close(); }
} catch (error) {
  if (error.code !== 'SQLITE_CANTOPEN') throw error;
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ commit, createdAt: new Date().toISOString(), note: 'Respaldo local privado. .env permanece en la raíz original.' }, null, 2));
console.log(`Respaldo creado: ${destination}`);
