// "プロトコル観察": live message stream with hex + decoded view, live sequence diagram,
// delay / loss histograms (observed vs. expected from the settings), and log download.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Degrader, geTransitions, BURST_BINS } from '../../core/net/degrader.ts';
import { hex } from '../../core/protocol/codec.ts';
import { OWD_BINS, OWD_BIN_MS, type MsgName, type NetParams } from '../../core/protocol/messages.ts';
import type { InspectorEntry, Session } from '../session/Session.ts';
import { fmt, useSession } from '../hooks.ts';
import { Histogram } from './Histogram.tsx';

export const TYPE_COLOR: Record<string, string> = {
  HELLO: '#c792ea',
  WELCOME: '#c792ea',
  SYNC_REQ: '#82aaff',
  SYNC_RESP: '#82aaff',
  CMD: '#4fc3f7',
  STATE: '#7bd88f',
  GAZE: '#ff4fd8',
  NETCFG: '#ffc857',
  CTRLCFG: '#ffc857',
  RESET: '#ffc857',
  EVENT: '#ff6b6b',
  STATS: '#9aa3ad',
  PING: '#607080',
  PONG: '#607080',
  ERROR: '#ff6b6b',
  BYE: '#c792ea',
  '?': '#ff6b6b',
};

/** Expected one-way delay histogram for the artificial part, by simulating the degrader. */
function expectedDelay(p: NetParams): number[] {
  const d = new Degrader<number>({ ...p, loss: 0 }, 99);
  for (let i = 0; i < 10000; i++) d.submit(i, i * 10, 'X', false);
  const total = d.appliedDelayHist.reduce((a, b) => a + b, 0) || 1;
  return d.appliedDelayHist.map((c) => c / total);
}

/** Expected burst-length distribution: geometric with p_BG for GE, and for Bernoulli p(1-p)^(k-1)-ish. */
function expectedBurst(p: NetParams): number[] {
  const out = new Array<number>(BURST_BINS).fill(0);
  if (p.loss <= 0) return out;
  const q = p.burst ? geTransitions(p.loss, p.burstLength).pBG : 1 - p.loss;
  for (let k = 1; k < BURST_BINS; k++) out[k] = Math.pow(1 - q, k - 1) * q;
  return out;
}

function fieldsOf(e: InspectorEntry): string {
  if (!e.msg) return '(復号できません)';
  const { t: _t, ...rest } = e.msg as unknown as Record<string, unknown>;
  const round = (v: unknown): unknown => {
    if (typeof v === 'number') return Number.isInteger(v) ? v : Number(v.toPrecision(6));
    if (Array.isArray(v)) return v.map(round);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]));
    return v;
  };
  return JSON.stringify(round(rest), null, 1);
}

function SequenceDiagram({ session }: { session: Session }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const c = ref.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth;
      const H = c.clientHeight;
      if (c.width !== W * dpr || c.height !== H * dpr) {
        c.width = W * dpr;
        c.height = H * dpr;
      }
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const now = performance.timeOrigin + performance.now();
      const xs = 70;
      const xc = W - 70;
      const top = 26;
      const bottom = H - 10;
      // last 20 messages with a known time on both ends
      const up = Number.isFinite(session.lastUpOwd) ? session.lastUpOwd : NaN;
      const items = session.inspector
        .filter((e) => (e.dir === 'recv' ? e.sentAt !== undefined : Number.isFinite(up)))
        .slice(-20)
        .map((e) =>
          e.dir === 'recv'
            ? { e, from: e.sentAt!, to: e.t, fromX: xs, toX: xc }
            : { e, from: e.t, to: e.t + up, fromX: xc, toX: xs },
        );
      const oldest = items.length ? Math.min(...items.map((i) => i.from)) : now - 500;
      const span = Math.max(300, now - oldest + 20);
      const y = (t: number) => top + ((t - (now - span)) / span) * (bottom - top);
      // lifelines
      g.strokeStyle = '#3a4654';
      g.lineWidth = 2;
      for (const x of [xs, xc]) {
        g.beginPath();
        g.moveTo(x, top);
        g.lineTo(x, bottom);
        g.stroke();
      }
      g.fillStyle = '#d4dbe3';
      g.font = '12px sans-serif';
      g.textAlign = 'center';
      g.fillText('サーバ', xs, 16);
      g.fillText('このクライアント', xc, 16);
      g.fillStyle = '#8593a3';
      g.font = '10px sans-serif';
      g.textAlign = 'left';
      g.fillText(`縦軸 = 時刻（下が現在、全体 ${span.toFixed(0)} ms）`, 8, H - 2);
      // arrows
      for (const it of items) {
        const y0 = y(it.from);
        const y1 = y(Math.min(it.to, now));
        const col = TYPE_COLOR[it.e.type] ?? '#9aa3ad';
        g.strokeStyle = col;
        g.fillStyle = col;
        g.lineWidth = 1.2;
        g.setLineDash(it.e.dir === 'send' ? [5, 3] : []);
        g.beginPath();
        g.moveTo(it.fromX, y0);
        g.lineTo(it.toX, y1);
        g.stroke();
        g.setLineDash([]);
        const ang = Math.atan2(y1 - y0, it.toX - it.fromX);
        g.beginPath();
        g.moveTo(it.toX, y1);
        g.lineTo(it.toX - 7 * Math.cos(ang - 0.35), y1 - 7 * Math.sin(ang - 0.35));
        g.lineTo(it.toX - 7 * Math.cos(ang + 0.35), y1 - 7 * Math.sin(ang + 0.35));
        g.fill();
        g.font = '10px Consolas, monospace';
        g.textAlign = it.e.dir === 'recv' ? 'left' : 'right';
        g.fillText(`${it.e.type} #${it.e.seq}`, it.fromX + (it.e.dir === 'recv' ? 4 : -4), y0 - 2);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [session]);
  return <canvas className="seqdiag" ref={ref} />;
}

function download(name: string, text: string, mime: string) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    /* sandboxed frame without download permission */
  }
}

export function ProtocolView({ session }: { session: Session }) {
  useSession(session, 5);
  const [paused, setPaused] = useState(false);
  const [hideHighRate, setHideHighRate] = useState(false);
  const [selected, setSelected] = useState<InspectorEntry | null>(null);
  const frozen = useRef<InspectorEntry[]>([]);
  if (!paused) frozen.current = session.inspector.slice(-200);
  const rows = frozen.current.filter((e) => !hideHighRate || !['CMD', 'STATE', 'GAZE', 'PING', 'PONG', 'SYNC_REQ', 'SYNC_RESP'].includes(e.type)).slice(-60).reverse();
  const t0 = session.inspector[0]?.t ?? 0;

  const net = session.netcfg;
  const expDown = useMemo(() => expectedDelay(net.down), [net.down]);
  const expUp = useMemo(() => expectedDelay(net.up), [net.up]);
  const expBurst = useMemo(() => expectedBurst(net.up), [net.up]);
  const downMeter = session.meters.get('STATE');
  const upStats = session.stats?.up.CMD;
  const deg = session.stats?.degrader;
  const maxDelay = Math.max(net.up.delayMs + 4 * net.up.jitterMs, net.down.delayMs + 4 * net.down.jitterMs, 100);
  const bins = Math.min(OWD_BINS, Math.ceil(maxDelay / OWD_BIN_MS) + 3);

  const byType = new Map<MsgName | '?', { n: number; bytes: number }>();
  for (const e of session.log.slice(-3000)) {
    const r = byType.get(e.type) ?? { n: 0, bytes: 0 };
    r.n++;
    r.bytes += e.size;
    byType.set(e.type, r);
  }

  return (
    <div className="protocol">
      <div className="proto-left">
        <div className="proto-toolbar">
          <button onClick={() => setPaused(!paused)}>{paused ? '再開' : '一時停止'}</button>
          <label className="check">
            <input type="checkbox" checked={hideHighRate} onChange={(e) => setHideHighRate(e.target.checked)} />
            高頻度のメッセージを隠す
          </label>
          <span className="spacer" />
          <button onClick={() => download('gazelink-log.jsonl', session.exportJsonl(), 'application/x-ndjson')}>記録（JSON Lines）</button>
          <button onClick={() => download('gazelink-log.csv', session.exportCsv(), 'text/csv')}>記録（CSV）</button>
        </div>
        <div className="msglist">
          <table>
            <thead>
              <tr>
                <th>時刻 s</th>
                <th>向き</th>
                <th>種類</th>
                <th>seq</th>
                <th>符号化</th>
                <th>B</th>
                <th>片道 ms</th>
                <th>判定</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={`${e.t}-${e.type}-${e.seq}-${i}`} className={selected === e ? 'sel' : ''} onClick={() => setSelected(e)}>
                  <td>{((e.t - t0) / 1000).toFixed(3)}</td>
                  <td>{e.dir === 'send' ? '→ 送信' : '← 受信'}</td>
                  <td>
                    <span className="type" style={{ color: TYPE_COLOR[e.type] }}>
                      {e.type}
                    </span>
                  </td>
                  <td>{e.seq}</td>
                  <td>{e.enc === 'binary' ? 'バイナリ' : 'JSON'}</td>
                  <td>{e.size}</td>
                  <td>{fmt(e.owd, 1)}</td>
                  <td className={e.verdict && e.verdict !== 'fresh' ? 'warn' : ''}>
                    {e.verdict === 'late' ? '遅着・破棄' : e.verdict === 'duplicate' ? '重複・破棄' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="msgdetail">
          {selected ? (
            <>
              <div className="detail-head">
                <span style={{ color: TYPE_COLOR[selected.type] }}>{selected.type}</span> #{selected.seq}・{selected.size} バイト・
                {selected.enc === 'binary' ? 'バイナリ' : 'JSON'}
              </div>
              <div className="detail-body">
                <pre className="hex">{typeof selected.frame === 'string' ? selected.frame : hex(selected.frame)}</pre>
                <pre className="decoded">{fieldsOf(selected)}</pre>
              </div>
            </>
          ) : (
            <div className="muted">一覧の行を選ぶと、16 進表示と解釈を並べて表示します（一時停止すると選びやすくなります）</div>
          )}
        </div>
      </div>
      <div className="proto-right">
        <SequenceDiagram session={session} />
        <div className="hists">
          <Histogram
            title={`下り 片道遅延（設定 ${net.down.delayMs}±${net.down.jitterMs} ms）`}
            observed={downMeter?.owdHist ?? []}
            expected={expDown}
            bins={bins}
            binLabel={(i) => `${i * OWD_BIN_MS}`}
            color="#7bd88f"
            note={`STATE 受信 ${downMeter?.received ?? 0}・損失 ${fmt(100 * (downMeter?.lossRatio ?? 0), 1)}%（設定 ${(net.down.loss * 100).toFixed(0)}%）・遅着 ${downMeter?.late ?? 0}`}
          />
          <Histogram
            title={`上り 片道遅延（サーバで観測、設定 ${net.up.delayMs}±${net.up.jitterMs} ms）`}
            observed={upStats?.owdHist ?? []}
            expected={expUp}
            bins={bins}
            binLabel={(i) => `${i * OWD_BIN_MS}`}
            color="#ffc857"
            note={upStats ? `CMD 受信 ${upStats.received}・損失 ${fmt((100 * upStats.lost) / Math.max(1, upStats.lost + upStats.received), 1)}%（設定 ${(net.up.loss * 100).toFixed(0)}%）・遅着 ${upStats.late}` : 'サーバからの STATS 待ち'}
          />
          <Histogram
            title={`上り 連続損失の長さ（${net.up.burst ? `Gilbert–Elliott・平均 ${net.up.burstLength}` : 'ベルヌーイ'}）`}
            observed={deg?.burstHist ?? []}
            expected={expBurst}
            bins={BURST_BINS}
            binLabel={(i) => `${i}`}
            color="#ff6b6b"
            note={deg ? `劣化器が落とした数 ${deg.dropped} / 通した数 ${deg.passed}（${fmt((100 * deg.dropped) / Math.max(1, deg.dropped + deg.passed), 1)}%）` : ''}
          />
        </div>
        <table className="readout bytype">
          <thead>
            <tr>
              <th>種類（直近 3000 件）</th>
              <th>件数</th>
              <th>平均 B</th>
            </tr>
          </thead>
          <tbody>
            {[...byType.entries()].map(([t, r]) => (
              <tr key={t}>
                <th style={{ color: TYPE_COLOR[t] }}>{t}</th>
                <td>{r.n}</td>
                <td>{(r.bytes / r.n).toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
