// GazeLink server entry: serves the built client, and hosts the GLP/1 hub over WebSocket (/ws)
// and SSE + HTTP POST (/api/sse, /api/sse/send) (docs/PROTOCOL.md §2).
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Hub } from '../core/room/hub.ts';
import { unwrapText, wrapText, type Frame } from '../core/protocol/codec.ts';

const PORT = Number(process.env.PORT) || 3000;
const isDev = process.argv.includes('--dev');
const here = path.dirname(fileURLToPath(import.meta.url));

const clock = () => performance.timeOrigin + performance.now();

async function main(): Promise<void> {
  const hub = new Hub({ now: clock, mode: 'network', log: (m) => console.log(`[hub] ${m}`) });
  // physics / degrader pump; the hub integrates the real elapsed time in fixed 1 ms steps
  const pump = setInterval(() => hub.tick(), 1);

  const app = express();
  app.disable('x-powered-by');

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: Date.now(), rooms: hub.rooms.size });
  });

  // Short SSE stream used by the client's connectivity probe.
  app.get('/api/sse-probe', (_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let n = 0;
    const timer = setInterval(() => {
      res.write(`data: ${JSON.stringify({ n: n++, time: Date.now() })}\n\n`);
      if (n >= 3) {
        clearInterval(timer);
        res.end();
      }
    }, 200);
    res.on('close', () => clearInterval(timer));
  });

  // --- SSE transport: downlink as an event stream, uplink as batched POSTs
  const sseConns = new Map<string, { receive: (f: Frame) => void; close: () => void }>();
  let sseCounter = 0;

  app.get('/api/sse', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    const cid = `${Date.now().toString(36)}-${(++sseCounter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let open = true;
    const conn = hub.connect(
      {
        send: (frame) => {
          if (open) res.write(`data: ${wrapText(frame)}\n\n`);
        },
        close: () => {
          if (open) res.end();
        },
      },
      'sse',
    );
    sseConns.set(cid, conn);
    res.write(`event: open\ndata: ${JSON.stringify({ cid })}\n\n`);
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    req.on('close', () => {
      open = false;
      clearInterval(keepAlive);
      sseConns.delete(cid);
      conn.close();
    });
  });

  app.post('/api/sse/send', express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
    const conn = sseConns.get(String(req.query.cid ?? ''));
    if (!conn) {
      res.status(404).json({ ok: false, error: 'unknown connection' });
      return;
    }
    try {
      const items = JSON.parse(req.body as string) as string[];
      for (const s of items) conn.receive(unwrapText(s));
      res.json({ ok: true, n: items.length });
    } catch {
      res.status(400).json({ ok: false, error: 'bad batch' });
    }
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
  // GAZELINK_DISABLE_WS=1 simulates a host without WebSocket support (tests the SSE fallback)
  const wss = process.env.GAZELINK_DISABLE_WS === '1' ? null : new WebSocketServer({ server, path: '/ws' });
  if (!wss) console.log('[gazelink] WebSocket disabled (GAZELINK_DISABLE_WS=1)');
  wss?.on('connection', (ws) => {
    ws.binaryType = 'nodebuffer';
    let conn: ReturnType<Hub['connect']> | null = null;
    ws.on('message', (data, isBinary) => {
      const bytes = data as Buffer;
      const frame: Frame = isBinary ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes.toString('utf8');
      // connectivity probe: an unknown text frame before any GLP/1 message is echoed back
      if (!conn && !isBinary && typeof frame === 'string' && frame.startsWith('probe-')) {
        ws.send(frame);
        return;
      }
      if (!conn) {
        conn = hub.connect(
          {
            send: (f) => {
              if (ws.readyState === ws.OPEN) ws.send(f, { binary: typeof f !== 'string' });
            },
            close: () => ws.close(),
          },
          'ws',
        );
      }
      conn.receive(frame);
    });
    ws.on('close', () => conn?.close());
    ws.on('error', () => conn?.close());
  });

  server.listen(PORT, () => {
    console.log(`[gazelink] listening on http://localhost:${PORT} (${isDev ? 'dev' : 'prod'})`);
  });

  const shutdown = () => {
    clearInterval(pump);
    hub.shutdown();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
