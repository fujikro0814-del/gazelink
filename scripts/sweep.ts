// Developer tool: run the scripted wall-press trial over delays x modes and print a table.
// usage: node scripts/sweep.ts [gaze=0|1]
import { runTrial } from '../core/sim/experiment.ts';
import type { ControlMode } from '../core/protocol/messages.ts';

const gaze = process.argv[2] === '1';
const delays = [0, 50, 100, 200, 400, 800];
const modes: ControlMode[] = ['none', 'tdpa', 'wave'];
console.log(`gaze=${gaze}`);
console.log('mode  delay  maxF[N]  osc  f[Hz]  amp[N]  trans  eGenMax[J]  eDiss[J]  pass[s]  drift[mm]');
for (const mode of modes) {
  for (const delayMs of delays) {
    const t0 = performance.now();
    const r = runTrial({ mode, delayMs, gaze });
    const ms = performance.now() - t0;
    console.log(
      [
        mode.padEnd(5),
        String(delayMs).padStart(5),
        r.maxForce.toFixed(1).padStart(8),
        (r.oscillating ? 'YES' : 'no').padStart(4),
        r.oscFreqHz.toFixed(1).padStart(6),
        r.oscAmp.toFixed(2).padStart(7),
        String(r.contactTransitions).padStart(6),
        r.eGenMax.toExponential(2).padStart(11),
        r.eDiss.toFixed(3).padStart(9),
        r.passTime.toFixed(2).padStart(8),
        (r.finalDrift * 1000).toFixed(1).padStart(10),
        `  (${ms.toFixed(0)} ms)`,
      ].join(' '),
    );
  }
}
