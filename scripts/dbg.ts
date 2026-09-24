// Developer tool: step one TDPA+gaze trial and print internal signals.
import { OfflineTeleop } from '../core/sim/teleop.ts';
import { scriptedHand, scriptedGaze } from '../core/sim/experiment.ts';
import { NET_DEFAULTS } from '../core/config.ts';
import type { ControlMode } from '../core/protocol/messages.ts';

const mode = (process.argv[2] ?? 'tdpa') as ControlMode;
const delayMs = Number(process.argv[3] ?? 100);
const gaze = process.argv[4] !== '0';
const sim = new OfflineTeleop({ mode, gazeEnabled: gaze, seed: 42, net: { ...NET_DEFAULTS, delayMs } });
const f = (v: number[], d = 3) => v.map((x) => x.toFixed(d)).join(',');
let gc = 0;
for (let k = 0; k < 5000; k++) {
  const t = k / 1000;
  sim.setHand(scriptedHand(t, sim.slave.home));
  if (gaze && t >= gc) {
    sim.gaze(scriptedGaze(t), 1);
    gc += 1 / 30;
  }
  sim.step();
  if (k % 250 === 0) {
    const s = sim.slave;
    const m = sim.master;
    console.log(
      t.toFixed(2),
      'xs', f(s.xs), 'xd', f(s.xd), 'xm', f(m.xm),
      'b', s.b.toFixed(1), 'A', s.damping.last.attention.toFixed(2),
      'fc', f(s.fc, 1), 'Wr', s.observer.toFixed(3), 'EinRcvd', s.cmd.eIn.toFixed(3), 'EoutS', s.energy.out.toFixed(3),
      'Wl', m.observer.toFixed(3), 'alpha', m.pcAlpha.toFixed(1),
    );
  }
}
