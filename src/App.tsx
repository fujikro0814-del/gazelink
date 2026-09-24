import { useEffect, useState } from 'react';
import { SceneView } from './scene/SceneView.tsx';
import { runProbe, type ProbeResult, type ProbeState } from './diag/probe.ts';

const LABEL: Record<ProbeState, string> = { pending: '確認中', ok: '可', fail: '不可' };

function Badge({ name, state }: { name: string; state: ProbeState }) {
  return (
    <span className={`badge badge-${state}`}>
      {name}：{LABEL[state]}
    </span>
  );
}

export function App() {
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  useEffect(() => {
    runProbe(setProbe);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">GazeLink</span>
        <span className="subtitle">視線適応型 遅延遠隔操作シミュレータ</span>
        <span className="spacer" />
        {probe && (
          <span className="badges" title="サーバへの接続経路の診断結果">
            <Badge name="HTTP" state={probe.http} />
            <Badge name="WebSocket" state={probe.ws} />
            <Badge name="SSE" state={probe.sse} />
          </span>
        )}
      </header>
      <main className="workspace">
        <SceneView />
      </main>
    </div>
  );
}
