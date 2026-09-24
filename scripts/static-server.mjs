// Serves dist/client as plain static files with no API at all: simulates a page whose server
// side is unreachable, to exercise the Worker (single-player) fallback.
// usage: node scripts/static-server.mjs <port>
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.argv[2] ?? 3460);
const root = path.resolve('dist/client');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
      res.writeHead(404).end('no server here');
      return;
    }
    const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(await readFile(path.join(root, 'index.html')));
    }
  })
  .listen(port, () => console.log(`[static] http://localhost:${port} (no API)`));
