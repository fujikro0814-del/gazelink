// Developer tool: print a compact trace of one trial. usage: node scripts/trace.ts <mode> <delayMs> [gaze]
import { runTrial } from '../core/sim/experiment.ts';
import type { ControlMode } from '../core/protocol/messages.ts';

const mode = (process.argv[2] ?? 'tdpa') as ControlMode;
const delayMs = Number(process.argv[3] ?? 200);
const gaze = process.argv[4] === '1';
const r = runTrial({ mode, delayMs, gaze });
console.log(`${mode} ${delayMs}ms osc=${r.oscillating} f=${r.oscFreqHz} amp=${r.oscAmp.toFixed(2)} trans=${r.contactTransitions}`);
for (let i = 0; i < r.trace.t.length; i += 5) {
  const t = r.trace.t[i];
  if (t < 2.5) continue;
  const bar = '#'.repeat(Math.min(60, Math.round(r.trace.force[i] * 2)));
  console.log(
    `${t.toFixed(2)}  F=${r.trace.force[i].toFixed(1).padStart(5)}  xs=${r.trace.xs[i].toFixed(3)}  xm=${r.trace.xm[i].toFixed(3)}  eGen=${r.trace.eGen[i].toFixed(3).padStart(7)}  ${bar}`,
  );
}
