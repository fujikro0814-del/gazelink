// Port energy bookkeeping (docs/CONTROL.md §3): power into the channel is positive; inflow and
// outflow are integrated separately, as required by the time-domain passivity approach.
export class PortEnergy {
  /** energy that entered the channel through this port [J] */
  in = 0;
  /** energy that left the channel through this port [J] */
  out = 0;

  /** Accumulate one step of power flowing into the channel. */
  add(powerIntoChannel: number, dt: number): void {
    if (powerIntoChannel > 0) this.in += powerIntoChannel * dt;
    else this.out -= powerIntoChannel * dt;
  }

  reset(): void {
    this.in = 0;
    this.out = 0;
  }
}

export const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
