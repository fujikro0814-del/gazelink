// "自動実験": delay x control mode x gaze adaptation, scripted wall press, run in a Worker.
import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import type { ControlMode } from '../../core/protocol/messages.ts';
import { TRIAL_DURATION, type TrialCondition, type TrialResult } from '../../core/sim/experiment.ts';
import { fmt } from '../hooks.ts';

const DELAYS = [0, 50, 100, 200, 400, 800];
const MODES: ControlMode[] = ['none', 'tdpa', 'wave'];
const MODE_LABEL: Record<ControlMode, string> = { none: 'なし', tdpa: 'TDPA', wave: '波変数' };
const SERIES_COLOR: Record<string, string> = {
  'none-false': '#ff6b6b',
  'none-true': '#ff9f9f',
  'tdpa-false': '#4fc3f7',
  'tdpa-true': '#9fdcf7',
  'wave-false': '#7bd88f',
  'wave-true': '#b5ebc0',
};

function conditions(): TrialCondition[] {
  const out: TrialCondition[] = [];
  for (const mode of MODES) for (const gaze of [false, true]) for (const delayMs of DELAYS) out.push({ mode, gaze, delayMs });
  return out;
}

function download(name: string, text: string) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    /* sandboxed frame */
  }
}

function SummaryChart({ results, metric, title, unit, log }: { results: (TrialResult | null)[]; metric: (r: TrialResult) => number; title: string; unit: string; log?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const keys = MODES.flatMap((m) => [`${m}-false`, `${m}-true`]);
  useEffect(() => {
    const el = ref.current!;
    plot.current = new uPlot(
      {
        width: Math.max(300, el.clientWidth),
        height: 210,
        title: `${title} [${unit}]`,
        cursor: { show: false },
        legend: { show: true, live: false },
        scales: { x: { time: false }, y: log ? { distr: 3 } : {} },
        axes: [
          { stroke: '#8593a3', grid: { stroke: '#232b35' }, values: (_u, v) => v.map((x) => `${x}`), label: '片道遅延 [ms]', labelSize: 16, font: '10px sans-serif', labelFont: '11px sans-serif' },
          { stroke: '#8593a3', grid: { stroke: '#232b35' }, size: 50, font: '10px sans-serif' },
        ],
        series: [
          {},
          ...keys.map((k) => {
            const [m, g] = k.split('-');
            return {
              label: `${MODE_LABEL[m as ControlMode]}${g === 'true' ? '＋視線' : ''}`,
              stroke: SERIES_COLOR[k],
              width: 1.6,
              dash: g === 'true' ? [5, 3] : undefined,
              points: { show: true, size: 5 },
            };
          }),
        ],
      },
      [DELAYS, ...keys.map(() => DELAYS.map(() => null))] as unknown as uPlot.AlignedData,
      el,
    );
    return () => plot.current?.destroy();
  }, []);
  useEffect(() => {
    const conds = conditions();
    const data = keys.map((k) =>
      DELAYS.map((d) => {
        const i = conds.findIndex((c) => `${c.mode}-${c.gaze}` === k && c.delayMs === d);
        const r = results[i];
        if (!r) return null;
        const v = metric(r);
        return log ? Math.max(1e-4, v) : v;
      }),
    );
    plot.current?.setData([DELAYS, ...data] as unknown as uPlot.AlignedData);
  });
  return <div className="exp-chart" ref={ref} />;
}

function TraceChart({ r }: { r: TrialResult }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const p = new uPlot(
      {
        width: Math.max(300, el.clientWidth),
        height: 190,
        title: `接触力と b(t)：${MODE_LABEL[r.condition.mode]}・片道 ${r.condition.delayMs} ms・視線適応 ${r.condition.gaze ? 'ON' : 'OFF'}`,
        cursor: { show: false },
        legend: { show: true, live: false },
        scales: { x: { time: false }, b: { range: [0, 70] } },
        axes: [
          { stroke: '#8593a3', grid: { stroke: '#232b35' }, values: (_u, v) => v.map((x) => `${x}s`), font: '10px sans-serif' },
          { stroke: '#8593a3', grid: { stroke: '#232b35' }, size: 44, font: '10px sans-serif' },
          { scale: 'b', side: 1, stroke: '#ff4fd8', grid: { show: false }, size: 40, font: '10px sans-serif' },
        ],
        series: [
          {},
          { label: '|f_e| [N]', stroke: '#ff6b6b', width: 1.3 },
          { label: 'E_gen [J]', stroke: '#ffc857', width: 1.3 },
          { label: 'b [Ns/m]', stroke: '#ff4fd8', width: 1.1, scale: 'b' },
        ],
      },
      [r.trace.t, r.trace.force, r.trace.eGen, r.trace.b],
      el,
    );
    return () => p.destroy();
  }, [r]);
  return <div className="exp-chart" ref={ref} />;
}

export function ExperimentView() {
  const conds = useMemo(conditions, []);
  const [results, setResults] = useState<(TrialResult | null)[]>(() => conds.map(() => null));
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const worker = useRef<Worker | null>(null);

  useEffect(() => () => worker.current?.terminate(), []);

  const run = () => {
    worker.current?.terminate();
    const w = new Worker(new URL('../experiment/expWorker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    setResults(conds.map(() => null));
    setElapsed(null);
    setRunning(true);
    w.onmessage = (e: MessageEvent) => {
      const d = e.data as { index?: number; result?: TrialResult; done?: boolean; elapsedMs?: number };
      if (d.result !== undefined && d.index !== undefined) {
        const { index, result } = d;
        setResults((prev) => {
          const next = [...prev];
          next[index] = result;
          return next;
        });
      }
      if (d.done) {
        setRunning(false);
        setElapsed(d.elapsedMs ?? null);
      }
    };
    w.postMessage({ run: conds });
  };

  const done = results.filter(Boolean).length;
  const csv = () => {
    const head = 'delay_ms,mode,gaze,max_force_N,oscillating,osc_freq_Hz,osc_amp_N,e_gen_max_J,e_diss_J,pass_time_s,final_drift_mm';
    const rows = results
      .filter((r): r is TrialResult => !!r)
      .map((r) =>
        [r.condition.delayMs, r.condition.mode, r.condition.gaze ? 1 : 0, r.maxForce.toFixed(3), r.oscillating ? 1 : 0, r.oscFreqHz, r.oscAmp.toFixed(3), r.eGenMax.toExponential(4), r.eDiss.toFixed(4), Number.isFinite(r.passTime) ? r.passTime.toFixed(3) : '', (r.finalDrift * 1000).toFixed(2)].join(','),
      );
    download('gazelink-experiment.csv', [head, ...rows].join('\n') + '\n');
  };

  return (
    <div className="experiment">
      <div className="exp-head">
        <div>
          <h2>自動実験：遅延 × 受動性制御 × 視線適応</h2>
          <p className="muted">
            人の代わりに決まった軌道で手を動かし（初期姿勢 → 通過点の輪 → 壁へ 4 cm 押し込み、5.5 秒保持 → 引き戻し、1 試行 {TRIAL_DURATION} 秒）、
            {conds.length} 条件をブラウザ内の Worker で実時間より速く実行します。発振は、壁に触れてから 1 秒以降の接触力を周波数解析して判定します。
            視線適応 ON の試行では、視線は輪 → 壁の接触点の順に向いているものとします。
          </p>
        </div>
        <div className="exp-actions">
          <button className="primary" onClick={run} disabled={running}>
            {running ? `実行中… ${done}/${conds.length}` : '一括実行'}
          </button>
          <button onClick={csv} disabled={done === 0}>
            結果（CSV）
          </button>
          {elapsed !== null && (
            <span className="muted">
              {((conds.length * TRIAL_DURATION) / (elapsed / 1000)).toFixed(0)} 倍速（{(elapsed / 1000).toFixed(1)} 秒）
            </span>
          )}
        </div>
      </div>
      <div className="exp-body">
        <div className="exp-table">
          <table>
            <thead>
              <tr>
                <th>方式</th>
                <th>視線</th>
                <th>片道遅延</th>
                <th>最大接触力</th>
                <th>発振</th>
                <th>通信路の生成エネルギー（最大）</th>
                <th>受動性制御が消したエネルギー</th>
                <th>輪の通過時刻</th>
                <th>最終の位置ずれ</th>
              </tr>
            </thead>
            <tbody>
              {conds.map((c, i) => {
                const r = results[i];
                return (
                  <tr key={i} className={`${selected === i ? 'sel' : ''} ${r?.oscillating ? 'osc' : ''}`} onClick={() => r && setSelected(i)}>
                    <td style={{ color: SERIES_COLOR[`${c.mode}-false`] }}>{MODE_LABEL[c.mode]}</td>
                    <td>{c.gaze ? 'ON' : 'OFF'}</td>
                    <td>{c.delayMs} ms</td>
                    <td>{r ? `${r.maxForce.toFixed(1)} N` : ''}</td>
                    <td>{r ? (r.oscillating ? `あり（${r.oscFreqHz.toFixed(1)} Hz）` : 'なし') : ''}</td>
                    <td className={r && r.eGenMax > 1e-6 ? 'bad' : r ? 'good' : ''}>{r ? `${r.eGenMax > 1e-6 ? '+' : ''}${r.eGenMax.toExponential(1)} J` : ''}</td>
                    <td>{r ? `${r.eDiss.toFixed(2)} J` : ''}</td>
                    <td>{r ? (Number.isFinite(r.passTime) ? `${r.passTime.toFixed(2)} s` : '未通過') : ''}</td>
                    <td>{r ? `${fmt(r.finalDrift * 1000, 1)} mm` : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="exp-charts">
          <SummaryChart results={results} metric={(r) => r.maxForce} title="最大接触力" unit="N" />
          <SummaryChart results={results} metric={(r) => Math.max(r.eGenMax, 1e-4)} title="通信路の生成エネルギー（最大、対数）" unit="J" log />
          {selected !== null && results[selected] ? (
            <TraceChart r={results[selected]!} />
          ) : (
            <div className="muted exp-hint">表の行を選ぶと、その試行の接触力・E_gen・b(t) の時系列を表示します。</div>
          )}
          <div className="muted exp-hint">
            読み方：E_gen が正（赤字）の条件では、通信路（遅延＋標本化）がエネルギーを湧き出させています。「なし」は遅延が 200 ms を超えると発振し、TDPA は E_gen を常に 0 以下に保って発振を抑えます（代わりに位置ずれが残ります）。
            視線適応 ON では、壁の近くで手元が重くなるため、「なし」でも 200 ms で発振しなくなります。
          </div>
        </div>
      </div>
    </div>
  );
}
