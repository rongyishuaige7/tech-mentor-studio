import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
for (const file of ['server.js', 'public/app.js', ...['lib', 'scripts'].flatMap(dir => fs.readdirSync(dir).filter(name => name.endsWith('.js')).map(name => `${dir}/${name}`))]) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
execFileSync('bash', ['-n', 'start.sh'], { stdio: 'inherit' });
