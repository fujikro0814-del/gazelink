// Prediction arm (docs/CONTROL.md §6): start from the latest slave state and replay the CMDs
// that were sent but not yet applied, as if they arrive after the estimated uplink delay.
import { COMM, SLAVE } from '../../core/config.ts';
import type { Vec3 } from '../../core/math/vec.ts';
import { contactForce } from '../../core/sim/env.ts';
import type { Session } from '../session/Session.ts';

const MAX_HORIZON_MS = 2000;

export function predictSlave(s: Session): Vec3 | null {
  const st = s.state;
  if (!st || !s.clock.synced) return null;
  const now = performance.timeOrigin + performance.now();
  const up = Number.isFinite(s.lastUpOwd) ? Math.max(0, s.lastUpOwd) : 0;
  const tStart = s.clock.toClient(st.ts);
  const tEnd = Math.min(now + up, tStart + MAX_HORIZON_MS);
  const x: Vec3 = [...st.xs];
  const v: Vec3 = [...st.vs];
  const xd: Vec3 = [...st.xd];
  const b = SLAVE.baseB + (s.ctrlcfg.gaze.enabled && s.ctrlcfg.gaze.target === 'slave' ? st.b : 0);
  const period = 1 / COMM.controlRateHz;
  const cmds = s.sentCmds;
  let ci = 0;
  let cur = { xm: [...st.xd] as Vec3, vm: [0, 0, 0] as Vec3, arrive: tStart };
  const dt = 0.001;
  for (let t = tStart; t < tEnd; t += 1) {
    while (ci < cmds.length && cmds[ci].at + up <= t) {
      cur = { xm: cmds[ci].xm, vm: cmds[ci].vm, arrive: cmds[ci].at + up };
      ci++;
    }
    const hold = Math.min((t - cur.arrive) / 1000, 1.5 * period);
    const vd: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      vd[i] = cur.vm[i] + (cur.xm[i] + cur.vm[i] * hold - xd[i]) / period;
    }
    const fe = contactForce(x, v).force;
    for (let i = 0; i < 3; i++) {
      const fc = SLAVE.couplingK * (xd[i] - x[i]) + SLAVE.couplingB * (vd[i] - v[i]);
      xd[i] += vd[i] * dt;
      v[i] += ((fc + fe[i] - b * v[i]) / SLAVE.mass) * dt;
      x[i] += v[i] * dt;
    }
  }
  return x;
}
