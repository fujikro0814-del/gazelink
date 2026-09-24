// Start the built server on a port, wait until it answers, run a check script against it, then
// shut the server down — all from one process, so no shell-level process killing is needed.
// usage: node scripts/with-server.mjs <port> <script.mjs> [args...]
//        (the script receives http://localhost:<port> as its first argument)
import { spawn } from 'node:child_process';

const [port = '3456', script, ...rest] = process.argv.slice(2);
if (!script) {
  console.error('usage: node scripts/with-server.mjs <port> <script.mjs> [args...]');
  process.exit(2);
}
const base = `http://localhost:${port}`;
// GAZELINK_STATIC=1 serves only the static client (no API) to test the Worker fallback
const serverArgs = process.env.GAZELINK_STATIC === '1' ? ['scripts/static-server.mjs', port] : ['dist/server.mjs'];
const server = spawn(process.execPath, serverArgs, {
  env: { ...process.env, PORT: port },
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/`);
      return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

let code = 1;
try {
  await waitReady();
  code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script, base, ...rest], { stdio: 'inherit' });
    child.on('exit', (c) => resolve(c ?? 1));
  });
} catch (e) {
  console.error(String(e));
} finally {
  server.kill();
}
process.exit(code);
