import { readFileSync } from 'node:fs';
import { resolveOutboundFile, resolveOutboundDir } from '../dist/core/files.js';
import { loadConfig } from '../dist/config.js';
import { resolveWorkdir } from '../dist/core/permissions.js';
import { Store } from '../dist/storage/db.js';

for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const cfg = loadConfig();
const store = new Store(cfg.dbPath);
const chatId = cfg.allowedChatIds[0];
const workdir = resolveWorkdir(cfg, chatId, store.getSession(chatId).project);
store.close();

const show = (label, fn) => {
  try {
    console.log(label.padEnd(34), '->', 'OK', JSON.stringify(fn()));
  } catch (e) {
    console.log(label.padEnd(34), '->', e.message);
  }
};

console.log('workdir =', workdir, '\n');
// `.` and `./` must now mean "the project root", not "escape attempt".
show('/get .', () => resolveOutboundFile(workdir, '.').abs);
show('/get ./', () => resolveOutboundFile(workdir, './').abs);
show('/files .', () => resolveOutboundDir(workdir, '.').rel);
show('/files ./', () => resolveOutboundDir(workdir, './').rel);
show('/files venn-2.16.html (a file)', () => resolveOutboundDir(workdir, 'venn-2.16.html').rel);
console.log('');
// Escapes must still be refused.
show('/get ../outside.txt', () => resolveOutboundFile(workdir, '../outside.txt').abs);
show('/get ../../etc/hosts', () => resolveOutboundFile(workdir, '../../etc/hosts').abs);
show('/get D:/Windows/win.ini', () => resolveOutboundFile(workdir, 'D:/Windows/win.ini').abs);
show('/get ..', () => resolveOutboundFile(workdir, '..').abs);
show('/files ../..', () => resolveOutboundDir(workdir, '../..').rel);
show('/files inbox/nope', () => resolveOutboundDir(workdir, 'inbox/nope').rel);
