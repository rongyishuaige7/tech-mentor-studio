import path from 'node:path';
import { createApp } from '../server.js';

export async function appFixture(t, repo, options = {}) {
  const app = createApp({ dataDir: path.join(repo, '.git', 'mentor-test-data'), scanRoots: [repo],
    keeperPath: path.join(repo, '.git', 'missing-keeper.db'), proxyKey: 'fixture-only', ...options });
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(base + '/api/session')).json();
  const request = (url, options = {}) => fetch(base + url, {
    ...options, headers: { 'X-Local-Token': token, ...options.headers }
  });
  return { request, base, app };
}
