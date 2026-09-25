// Keyboard jogging of the hand: W/A/S/D move horizontally relative to the current view,
// Q/E move up/down, Shift slows down. The velocity follows the keys through a first-order
// filter so it ramps up and down smoothly instead of stepping.
import { JOG } from '../../core/config.ts';
import type { Vec3 } from '../../core/math/vec.ts';

export interface JogKeys {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  slow: boolean;
}

export const noKeys = (): JogKeys => ({ forward: false, back: false, left: false, right: false, up: false, down: false, slow: false });

/** Map KeyboardEvent.code (layout-independent, unaffected by Shift) to a jog key. */
export const JOG_CODES: Record<string, keyof JogKeys> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  KeyQ: 'up',
  KeyE: 'down',
  ShiftLeft: 'slow',
  ShiftRight: 'slow',
};

export class HandJog {
  /** current hand velocity in the robot frame [m/s] */
  readonly v: Vec3 = [0, 0, 0];

  /**
   * Advance by dt. `forward` is the horizontal unit vector (robot frame) the camera looks along.
   * Returns the displacement to apply to the hand.
   */
  step(dt: number, keys: JogKeys, forward: [number, number]): Vec3 {
    const speed = JOG.speed * (keys.slow ? JOG.slowFactor : 1);
    const f = forward;
    const r: [number, number] = [f[1], -f[0]]; // right-hand side of the view direction
    const ax = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
    const ay = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const az = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
    const target: Vec3 = [ax * f[0] + ay * r[0], ax * f[1] + ay * r[1], az];
    // diagonal moves are not faster than straight ones
    const hn = Math.hypot(target[0], target[1]);
    if (hn > 1) {
      target[0] /= hn;
      target[1] /= hn;
    }
    const k = 1 - Math.exp(-dt / JOG.tau);
    for (let i = 0; i < 3; i++) this.v[i] += (target[i] * speed - this.v[i]) * k;
    // the exponential decay never reaches zero; with no key held, stop once it is negligible
    const idle = target[0] === 0 && target[1] === 0 && target[2] === 0;
    if (idle && Math.hypot(this.v[0], this.v[1], this.v[2]) < JOG.stopSpeed) this.reset();
    return [this.v[0] * dt, this.v[1] * dt, this.v[2] * dt];
  }

  /** Cancel the velocity component along axis i (used when the hand hits the workspace bound). */
  stopAxis(i: number): void {
    this.v[i] = 0;
  }

  reset(): void {
    this.v[0] = this.v[1] = this.v[2] = 0;
  }
}
