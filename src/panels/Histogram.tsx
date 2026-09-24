// Small canvas histogram: observed counts as bars, an expected distribution as a line.
import { useEffect, useRef } from 'react';

interface Props {
  title: string;
  /** observed counts per bin */
  observed: number[];
  /** expected probability per bin (sums to 1), drawn scaled to the observed total */
  expected?: number[];
  binLabel: (i: number) => string;
  /** number of bins to show (from 0) */
  bins: number;
  color?: string;
  note?: string;
}

export function Histogram({ title, observed, expected, binLabel, bins, color = '#4fc3f7', note }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = c.clientHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, W, H);
    const padL = 34;
    const padB = 18;
    const padT = 6;
    const w = W - padL - 6;
    const h = H - padB - padT;
    const obs = observed.slice(0, bins);
    const total = observed.reduce((a, b) => a + b, 0);
    const exp = expected ? expected.slice(0, bins).map((p) => p * total) : [];
    const max = Math.max(1, ...obs, ...exp);
    const bw = w / bins;
    // axes
    g.strokeStyle = '#2a3441';
    g.beginPath();
    g.moveTo(padL, padT);
    g.lineTo(padL, padT + h);
    g.lineTo(padL + w, padT + h);
    g.stroke();
    g.fillStyle = '#8593a3';
    g.font = '10px sans-serif';
    g.textAlign = 'right';
    g.fillText(String(Math.round(max)), padL - 4, padT + 8);
    g.fillText('0', padL - 4, padT + h);
    g.textAlign = 'center';
    const every = Math.max(1, Math.ceil(bins / 8));
    for (let i = 0; i < bins; i += every) g.fillText(binLabel(i), padL + (i + 0.5) * bw, H - 5);
    // bars
    g.fillStyle = color;
    g.globalAlpha = 0.75;
    obs.forEach((v, i) => {
      const bh = (v / max) * h;
      g.fillRect(padL + i * bw + 1, padT + h - bh, Math.max(1, bw - 2), bh);
    });
    g.globalAlpha = 1;
    // expected line
    if (exp.length) {
      g.strokeStyle = '#ffc857';
      g.lineWidth = 1.5;
      g.beginPath();
      exp.forEach((v, i) => {
        const x = padL + (i + 0.5) * bw;
        const y = padT + h - (v / max) * h;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.stroke();
    }
  });
  return (
    <div className="hist">
      <div className="hist-title">
        {title}
        <span className="hist-legend">
          <i style={{ background: color }} />
          観測
          {expected && (
            <>
              <i className="line" />
              設定からの予想
            </>
          )}
        </span>
      </div>
      <canvas ref={ref} />
      {note && <div className="hist-note">{note}</div>}
    </div>
  );
}
