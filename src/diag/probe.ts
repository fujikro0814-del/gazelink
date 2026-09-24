// Connectivity probe: which server paths are reachable from this page?
export type ProbeState = 'pending' | 'ok' | 'fail';

export interface ProbeResult {
  http: ProbeState;
  ws: ProbeState;
  sse: ProbeState;
}

const TIMEOUT_MS = 4000;

function withTimeout(p: Promise<boolean>): Promise<ProbeState> {
  return Promise.race([
    p.then((ok) => (ok ? 'ok' : 'fail') as ProbeState).catch(() => 'fail' as ProbeState),
    new Promise<ProbeState>((r) => setTimeout(() => r('fail'), TIMEOUT_MS)),
  ]);
}

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

function probeHttp(): Promise<ProbeState> {
  return withTimeout(
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => Boolean(j && j.ok)),
  );
}

function probeWs(): Promise<ProbeState> {
  return withTimeout(
    new Promise<boolean>((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl('/ws'));
      } catch {
        resolve(false);
        return;
      }
      const token = `probe-${Math.random()}`;
      ws.onopen = () => ws.send(token);
      ws.onmessage = (e) => {
        resolve(e.data === token);
        ws.close();
      };
      ws.onerror = () => resolve(false);
      setTimeout(() => ws.close(), TIMEOUT_MS);
    }),
  );
}

function probeSse(): Promise<ProbeState> {
  return withTimeout(
    new Promise<boolean>((resolve) => {
      if (typeof EventSource === 'undefined') {
        resolve(false);
        return;
      }
      const es = new EventSource('/api/sse-probe');
      let count = 0;
      es.onmessage = () => {
        count++;
        // Two events arriving separately shows the stream is not being buffered.
        if (count >= 2) {
          resolve(true);
          es.close();
        }
      };
      es.onerror = () => {
        resolve(false);
        es.close();
      };
    }),
  );
}

export async function runProbe(onUpdate: (r: ProbeResult) => void): Promise<ProbeResult> {
  const r: ProbeResult = { http: 'pending', ws: 'pending', sse: 'pending' };
  onUpdate({ ...r });
  const set = (k: keyof ProbeResult) => (s: ProbeState) => {
    r[k] = s;
    onUpdate({ ...r });
  };
  await Promise.all([probeHttp().then(set('http')), probeWs().then(set('ws')), probeSse().then(set('sse'))]);
  return r;
}
