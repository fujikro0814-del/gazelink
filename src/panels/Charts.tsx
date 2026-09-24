// Bottom strip: 10-second scrolling time series (uPlot).
import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import type { Session } from '../session/Session.ts';
import type { Series } from '../session/series.ts';

interface ChartDef {
  title: string;
  unit: string;
  series: (s: Session) => Series;
  lines: Array<{ label: string; col: number; stroke: string; dash?: number[] }>;
  range?: [number, number];
}

const CHARTS: ChartDef[] = [
  {
    title: '往復・片道遅延',
    unit: 'ms',
    series: (s) => s.rttSeries,
    lines: [
      { label: 'RTT(SYNC)', col: 0, stroke: '#4fc3f7' },
      { label: 'RTT(PING)', col: 1, stroke: '#9aa3ad', dash: [4, 3] },
      { label: '片道 下り', col: 2, stroke: '#7bd88f' },
      { label: '片道 上り', col: 3, stroke: '#ffc857' },
    ],
  },
  {
    title: 'エネルギー',
    unit: 'J',
    series: (s) => s.energySeries,
    lines: [
      { label: '通信路の生成 E_gen', col: 0, stroke: '#ff6b6b' },
      { label: '主側の蓄積 H_m', col: 1, stroke: '#4fc3f7' },
      { label: '従側の蓄積 H_s', col: 2, stroke: '#7bd88f' },
    ],
  },
  {
    title: 'ダンピング係数 b(t)',
    unit: 'Ns/m',
    series: (s) => s.dampingSeries,
    lines: [{ label: 'b', col: 0, stroke: '#ff4fd8' }],
  },
  {
    title: '接触力',
    unit: 'N',
    series: (s) => s.forceSeries,
    lines: [
      { label: '|f_e| 環境', col: 0, stroke: '#ff6b6b' },
      { label: '|f_c| 通信路へ返す力', col: 1, stroke: '#ffa94d', dash: [4, 3] },
    ],
  },
];

const WINDOW_MS = 10_000;

function makeChart(el: HTMLElement, def: ChartDef, width: number, height: number): uPlot {
  const opts: uPlot.Options = {
    width,
    height,
    title: `${def.title} [${def.unit}]`,
    legend: { show: true, live: false },
    cursor: { show: false },
    scales: { x: { time: false } },
    axes: [
      {
        stroke: '#8593a3',
        grid: { stroke: '#232b35', width: 1 },
        ticks: { stroke: '#2a3441' },
        values: (_u, v) => v.map((x) => `${x.toFixed(0)}s`),
        size: 26,
        font: '10px sans-serif',
      },
      {
        stroke: '#8593a3',
        grid: { stroke: '#232b35', width: 1 },
        ticks: { stroke: '#2a3441' },
        size: 44,
        font: '10px sans-serif',
      },
    ],
    series: [{}, ...def.lines.map((l) => ({ label: l.label, stroke: l.stroke, width: 1.4, dash: l.dash, spanGaps: true, points: { show: false } }))],
  };
  return new uPlot(opts, [[], ...def.lines.map(() => [])], el);
}

export function Charts({ session }: { session: Session }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const cells = CHARTS.map(() => {
      const d = document.createElement('div');
      d.className = 'chart-cell';
      host.appendChild(d);
      return d;
    });
    let plots: uPlot[] = [];
    const build = () => {
      for (const p of plots) p.destroy();
      const w = Math.max(200, Math.floor(host.clientWidth / CHARTS.length) - 6);
      const h = Math.max(120, host.clientHeight - 36);
      plots = CHARTS.map((def, i) => makeChart(cells[i], def, w, h));
    };
    build();
    const ro = new ResizeObserver(() => build());
    ro.observe(host);

    const timer = setInterval(() => {
      const now = performance.timeOrigin + performance.now();
      const since = now - WINDOW_MS;
      CHARTS.forEach((def, i) => {
        const w = def.series(session).window(since);
        const t = w[0].map((x) => (x - now) / 1000);
        const data = [t, ...def.lines.map((l) => w[l.col + 1])];
        plots[i].setData(data as uPlot.AlignedData, false);
        plots[i].setScale('x', { min: -WINDOW_MS / 1000, max: 0 });
        // y range from the visible data, with a little headroom
        let lo = Infinity;
        let hi = -Infinity;
        for (let k = 1; k < data.length; k++)
          for (const y of data[k]) {
            if (!Number.isFinite(y)) continue;
            lo = Math.min(lo, y);
            hi = Math.max(hi, y);
          }
        if (!Number.isFinite(lo)) {
          lo = 0;
          hi = 1;
        }
        if (hi - lo < 1e-6) hi = lo + 1;
        const pad = 0.08 * (hi - lo);
        plots[i].setScale('y', { min: Math.min(0, lo - pad), max: hi + pad });
      });
    }, 100);

    return () => {
      clearInterval(timer);
      ro.disconnect();
      for (const p of plots) p.destroy();
      host.innerHTML = '';
    };
  }, [session]);

  return <div className="charts" ref={hostRef} />;
}
