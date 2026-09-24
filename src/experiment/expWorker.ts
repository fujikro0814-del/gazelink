// Automated experiment runner: executes scripted wall-press trials faster than real time.
import { runTrial, type TrialCondition } from '../../core/sim/experiment.ts';

const scope = self as unknown as {
  postMessage: (m: unknown) => void;
  onmessage: ((e: MessageEvent) => void) | null;
};

let cancelled = false;

scope.onmessage = (e: MessageEvent) => {
  const d = e.data as { run?: TrialCondition[]; cancel?: boolean };
  if (d.cancel) {
    cancelled = true;
    return;
  }
  if (!d.run) return;
  cancelled = false;
  const conds = d.run;
  const t0 = performance.now();
  let i = 0;
  // run one trial per macrotask so a cancel message can get through
  const next = () => {
    if (cancelled || i >= conds.length) {
      scope.postMessage({ done: true, cancelled, elapsedMs: performance.now() - t0 });
      return;
    }
    const c = conds[i];
    const s0 = performance.now();
    const result = runTrial(c);
    scope.postMessage({ index: i, result, cpuMs: performance.now() - s0 });
    i++;
    setTimeout(next, 0);
  };
  next();
};
