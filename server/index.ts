// GazeLink server entry: serves the built client and hosts the WebSocket endpoint.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 3000;
const isDev = process.argv.includes('--dev');
const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: Date.now() });
  });

  if (isDev) {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    // dist/server.mjs sits next to dist/client/
    const clientDir = path.join(here, 'client');
    app.use(express.static(clientDir, { index: 'index.html', maxAge: '1h' }));
    app.use((_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
  });

  server.listen(PORT, () => {
    console.log(`[gazelink] listening on http://localhost:${PORT} (${isDev ? 'dev' : 'prod'})`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
