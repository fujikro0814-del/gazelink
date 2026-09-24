import { useEffect, useRef, useState } from 'react';
import type { ControlMode, CtrlConfig, NetConfig, NetParams } from '../../core/protocol/messages.ts';
import type { Session } from '../session/Session.ts';
import { fmt, useSession } from '../hooks.ts';
import type { SceneOptions } from '../scene/SceneView.tsx';

interface Props {
  session: Session;
  sceneOptions: SceneOptions;
  onSceneOptions: (o: SceneOptions) => void;
}

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  digits?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className="slider">
      <span className="slider-label">{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="slider-value">
        {props.value.toFixed(props.digits ?? 0)}
        {props.unit}
      </span>
    </label>
  );
}

function Check(props: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      {props.label}
    </label>
  );
}

const MODE_LABEL: Record<ControlMode, string> = { none: 'なし', tdpa: 'TDPA', wave: '波変数' };

/** Debounced sender so dragging a slider does not flood the channel with NETCFG/CTRLCFG. */
function useDebounced<T>(fn: (v: T) => void, ms: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (v: T) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(v), ms);
  };
}

export function ControlPanel({ session, sceneOptions, onSceneOptions }: Props) {
  useSession(session, 4);
  const isOp = session.role === 'operator';
  const ro = !isOp;

  // local drafts follow the server-confirmed config unless the user is editing
  const [net, setNet] = useState<NetParams>(session.netcfg.up);
  const [ctrl, setCtrl] = useState<CtrlConfig>(session.ctrlcfg);
  const editing = useRef(0);
  useEffect(() => {
    if (Date.now() - editing.current > 600) {
      setNet(session.netcfg.up);
      setCtrl(session.ctrlcfg);
    }
  });

  const sendNet = useDebounced<NetConfig>((c) => session.setNetConfig(c), 120);
  const sendCtrl = useDebounced<CtrlConfig>((c) => session.setCtrlConfig(c), 120);

  const updNet = (patch: Partial<NetParams>) => {
    editing.current = Date.now();
    const n = { ...net, ...patch };
    setNet(n);
    sendNet({ up: n, down: n, seed: session.netcfg.seed });
  };
  const updCtrl = (patch: Partial<CtrlConfig>) => {
    editing.current = Date.now();
    const c = { ...ctrl, ...patch };
    setCtrl(c);
    sendCtrl(c);
  };
  const updGaze = (patch: Partial<CtrlConfig['gaze']>) => updCtrl({ gaze: { ...ctrl.gaze, ...patch } });

  const s = session;
  const up = s.stats?.up.CMD;
  const down = s.meters.get('STATE');
  s.updateLoopStats();

  return (
    <aside className="panel">
      {ro && <div className="note">観戦中：設定は操作者だけが変更できます</div>}

      <section>
        <h3>通信路の劣化（片道・両方向）</h3>
        <Slider label="遅延" value={net.delayMs} min={0} max={800} step={10} unit=" ms" disabled={ro} onChange={(v) => updNet({ delayMs: v })} />
        <Slider label="揺らぎ σ" value={net.jitterMs} min={0} max={200} step={5} unit=" ms" disabled={ro} onChange={(v) => updNet({ jitterMs: v })} />
        <Check label="揺らぎによる順序の入れ替わりを許す" checked={net.allowReorder} disabled={ro} onChange={(v) => updNet({ allowReorder: v })} />
        <Slider label="損失率" value={net.loss * 100} min={0} max={50} step={1} unit=" %" disabled={ro} onChange={(v) => updNet({ loss: v / 100 })} />
        <Check label="連続損失（Gilbert–Elliott）" checked={net.burst} disabled={ro} onChange={(v) => updNet({ burst: v })} />
        {net.burst && (
          <Slider label="平均連続長" value={net.burstLength} min={1} max={20} step={1} unit=" 個" disabled={ro} onChange={(v) => updNet({ burstLength: v })} />
        )}
      </section>

      <section>
        <h3>遅延下の受動性制御</h3>
        <div className="segmented">
          {(['none', 'tdpa', 'wave'] as ControlMode[]).map((m) => (
            <button key={m} className={ctrl.mode === m ? 'on' : ''} disabled={ro} onClick={() => updCtrl({ mode: m })}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        {ctrl.mode === 'wave' && (
          <Slider label="特性インピーダンス" value={ctrl.waveImpedance} min={5} max={150} step={5} unit=" Ns/m" disabled={ro} onChange={(v) => updCtrl({ waveImpedance: v })} />
        )}
      </section>

      <section>
        <h3>視線適応ダンピング</h3>
        <Check label="有効にする" checked={ctrl.gaze.enabled} disabled={ro} onChange={(v) => updGaze({ enabled: v })} />
        <div className="segmented small">
          <button className={ctrl.gaze.target === 'master' ? 'on' : ''} disabled={ro} onClick={() => updGaze({ target: 'master' })}>
            主側（手元）にかける
          </button>
          <button className={ctrl.gaze.target === 'slave' ? 'on' : ''} disabled={ro} onClick={() => updGaze({ target: 'slave' })}>
            従側（先端）にかける
          </button>
        </div>
        <Slider label="忘却の時定数" value={ctrl.gaze.forgetTau} min={0.2} max={10} step={0.1} unit=" s" digits={1} disabled={ro} onChange={(v) => updGaze({ forgetTau: v })} />
        <Slider label="注意の広がり σ" value={ctrl.gaze.sigma * 100} min={2} max={20} step={1} unit=" cm" disabled={ro} onChange={(v) => updGaze({ sigma: v / 100 })} />
        <Slider label="B_MIN" value={ctrl.gaze.bMin} min={0} max={30} step={1} unit=" Ns/m" disabled={ro} onChange={(v) => updGaze({ bMin: Math.min(v, ctrl.gaze.bMax) })} />
        <Slider label="B_MAX" value={ctrl.gaze.bMax} min={5} max={150} step={1} unit=" Ns/m" disabled={ro} onChange={(v) => updGaze({ bMax: Math.max(v, ctrl.gaze.bMin) })} />
        <Slider label="変化速度の上限" value={ctrl.gaze.slewRate} min={10} max={1000} step={10} unit=" Ns/m/s" disabled={ro} onChange={(v) => updGaze({ slewRate: v })} />
      </section>

      <section>
        <h3>表示</h3>
        <Check label="指令のゴースト（水色）" checked={sceneOptions.showGhost} onChange={(v) => onSceneOptions({ ...sceneOptions, showGhost: v })} />
        <Check label="予測アーム（橙）" checked={sceneOptions.showPrediction} disabled={ro} onChange={(v) => onSceneOptions({ ...sceneOptions, showPrediction: v })} />
        <Check label="注意の場の熱分布" checked={sceneOptions.showHeatmap} onChange={(v) => onSceneOptions({ ...sceneOptions, showHeatmap: v })} />
        {isOp && (
          <button className="wide" onClick={() => session.reset()}>
            試行をやり直す（初期姿勢へ）
          </button>
        )}
      </section>

      <section>
        <h3>計測</h3>
        <table className="readout">
          <tbody>
            <tr><th>RTT（SYNC / PING）</th><td>{fmt(s.clock.lastRtt, 1)} / {fmt(s.pingRtt, 1)} ms</td></tr>
            <tr><th>片道遅延 上り / 下り</th><td>{fmt(s.lastUpOwd, 1)} / {fmt(down?.lastOwdMs, 1)} ms</td></tr>
            <tr><th>時計のずれ θ（S − C）</th><td>{fmt(s.clock.offset, 2)} ms</td></tr>
            <tr><th>揺らぎ（RFC 3550）上り / 下り</th><td>{fmt(up?.jitterMs, 2)} / {fmt(down?.jitterMs, 2)} ms</td></tr>
            <tr><th>損失率 上り / 下り</th><td>{up ? fmt((100 * up.lost) / Math.max(1, up.lost + up.received), 1) : '—'} / {down ? fmt(100 * down.lossRatio, 1) : '—'} %</td></tr>
            <tr><th>受信頻度 STATE</th><td>{down ? down.rateHz(performance.timeOrigin + performance.now()) : '—'} Hz</td></tr>
            <tr><th>主側の物理（目標 1000）</th><td>{s.loopStats.stepsPerSec} 刻み/s・起床 {fmt(s.loopStats.wakeMeanMs, 2)}±{fmt(s.loopStats.wakeJitterMs, 2)} ms</td></tr>
            <tr><th>従側の物理（サーバ）</th><td>{s.stats ? `${s.stats.sim.stepHz} 刻み/s・起床 ${fmt(s.stats.sim.meanWakeMs, 2)}±${fmt(s.stats.sim.periodJitterMs, 2)} ms` : '—'}</td></tr>
          </tbody>
        </table>
      </section>
    </aside>
  );
}
