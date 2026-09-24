import { SceneView } from './scene/SceneView.tsx';

export function App() {
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">GazeLink</span>
        <span className="subtitle">視線適応型 遅延遠隔操作シミュレータ</span>
      </header>
      <main className="workspace">
        <SceneView />
      </main>
    </div>
  );
}
