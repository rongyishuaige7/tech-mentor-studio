import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function buildFingerprint(root) {
  const hash = createHash('sha256');
  for (const name of ['server.js', ...fs.readdirSync(path.join(root, 'lib')).filter(name => name.endsWith('.js')).sort().map(name => `lib/${name}`)]) {
    hash.update(name); hash.update(fs.readFileSync(path.join(root, name)));
  }
  return hash.digest('hex');
}
