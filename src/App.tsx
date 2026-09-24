import { useEffect, useMemo, useState } from 'react';
import { SceneView, type SceneOptions } from './scene/SceneView.tsx';
import { runProbe, type ProbeResult, type ProbeState } from './diag/probe.ts';
import { Session } from './session/Session.ts';
import { ControlPanel } from './panels/ControlPanel.tsx';
import { Charts } from './panels/Charts.tsx';
import { ProtocolView } from './panels/ProtocolView.tsx';
import { TRANSPORT_LABEL } from './transport/auto.ts';
import { useSession } from './hooks.ts';

const LABEL: Record<ProbeState, string> = { pending: '確認中', ok: '可', fail: '不可' };

function Badge({ name, state }: { name: string; state: ProbeState }) {
  return (
    <span className={`badge badge-${state}`}>
      {name}：{LABEL[state]}
    </span>
  );
}

type Tab = 'operate' | 'protocol' | 'experiment' | 'about';
const TABS: Array<[Tab, string]> = [
  ['operate', '操作'],
  ['protocol', 'プロトコル観察'],
  ['experiment', '自動実験'],
  ['about', '説明'],
];

function params() {
  const u = new URLSearchParams(location.search);
  return { room: u.get('room'), transport: u.get('transport') };
}

function Lobby({ session, probe }: { session: Session; probe: ProbeResult | null }) {
  const p = params();
  const [room, setRoom] = useState(p.room ?? '');
  const failed = session.phase === 'error';
  return (
    <div className="lobby">
      <h1>GazeLink</h1>
      <p className="lead">遅延のあるネットワーク越しに、視線でダンピングを変えながらロボットアームを遠隔操作するシミュレータ</p>
      <div className="lobby-cards">
        <div className="card">
          <h2>操作者として始める</h2>
          <p>部屋を作り、アームを操作します。部屋番号を伝えると、他の人が観戦できます。</p>
          <button className="primary" onClick={() => session.start('operator', null, p.transport)}>
            部屋を作る
          </button>
        </div>
        <div className="card">
          <h2>観戦者として参加</h2>
          <p>操作者から聞いた部屋番号（4 文字）を入れてください。</p>
          <div className="row">
            <input
              className="code"
              value={room}
              maxLength={4}
              placeholder="K7Q2"
              onChange={(e) => setRoom(e.target.value.toUpperCase())}
            />
            <button className="primary" disabled={room.length !== 4} onClick={() => session.start('spectator', room, p.transport)}>
              参加
            </button>
          </div>
        </div>
      </div>
      {failed && <div className="error">{session.errorText}</div>}
      {session.attempts.length > 0 && (
        <div className="attempts">
          {session.attempts.map((a, i) => (
            <span key={i} className={a.ok ? 'ok' : 'fail'}>
              {TRANSPORT_LABEL[a.kind]}：{a.ok ? '接続' : `失敗（${a.error}）`}
            </span>
          ))}
        </div>
      )}
      {probe && (
        <div className="badges lobby-probe" title="サーバへの接続経路の診断結果">
          <Badge name="HTTP" state={probe.http} />
          <Badge name="WebSocket" state={probe.ws} />
          <Badge name="SSE" state={probe.sse} />
        </div>
      )}
    </div>
  );
}

function TopBar({ session, tab, setTab }: { session: Session; tab: Tab; setTab: (t: Tab) => void }) {
  useSession(session, 2);
  const s = session;
  const share = (() => {
    try {
      const u = new URL(location.href);
      u.searchParams.set('room', s.room);
      u.searchParams.delete('transport');
      return u.toString();
    } catch {
      return '';
    }
  })();
  return (
    <header className="topbar">
      <span className="brand">GazeLink</span>
      {s.serverMode === 'local' ? (
        <span className="banner warn">一人用モード（遅延は模擬）</span>
      ) : (
        <span className="room" title={share}>
          部屋 <b>{s.room}</b>
          <button className="link" onClick={() => navigator.clipboard?.writeText(share).catch(() => {})}>
            リンクをコピー
          </button>
        </span>
      )}
      <span className="chip">{s.role === 'operator' ? '操作者' : '観戦者'}</span>
      <span className="chip">{s.transportKind ? TRANSPORT_LABEL[s.transportKind] : '—'}</span>
      {s.role === 'operator' && <span className="chip muted">視線：マウスで代用（ボタンを押さずに動かす）</span>}
      {s.phase === 'reconnecting' && <span className="banner bad">再接続中…（{s.errorText}）</span>}
      {s.phase === 'error' && <span className="banner bad">{s.errorText}</span>}
      <span className="spacer" />
      <nav className="tabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </nav>
    </header>
  );
}

export function App() {
  const session = useMemo(() => new Session(), []);
  useSession(session);
  // exposed for debugging from the console and for the end-to-end checks
  (window as unknown as { __gazelink: Session }).__gazelink = session;
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [tab, setTab] = useState<Tab>('operate');
  const [sceneOptions, setSceneOptions] = useState<SceneOptions>({ showGhost: true, showPrediction: false, showHeatmap: true });

  useEffect(() => {
    runProbe(setProbe);
    const p = params();
    // a shared link with ?room= joins as a spectator directly
    if (p.room && p.room.length === 4) session.start('spectator', p.room.toUpperCase(), p.transport);
    return () => session.stop();
  }, [session]);

  if (session.phase === 'idle' || (session.phase === 'error' && !session.room) || (session.phase === 'connecting' && !session.room)) {
    return (
      <div className="app">
        <Lobby session={session} probe={probe} />
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar session={session} tab={tab} setTab={setTab} />
      <main className="workspace">
        <div className="center" hidden={tab !== 'operate'}>
          <SceneView session={session} options={sceneOptions} interactive={session.role === 'operator'} />
          {session.role === 'operator' && (
            <div className="hint">
              左ドラッグ：手を動かす　ホイール／Q・E：高さ　W・A・S・D：水平移動　右ドラッグ：視点　ボタンを押さずに動かす：視線
            </div>
          )}
          <Charts session={session} />
        </div>
        {tab === 'operate' && <ControlPanel session={session} sceneOptions={sceneOptions} onSceneOptions={setSceneOptions} />}
        {tab === 'protocol' && <ProtocolView session={session} />}
        {(tab === 'experiment' || tab === 'about') && <div className="placeholder">準備中</div>}
      </main>
    </div>
  );
}
