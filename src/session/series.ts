// Fixed-capacity time series for the scrolling charts (column arrays, uPlot-friendly).
export class Series {
  readonly t: Float64Array;
  readonly cols: Float64Array[];
  private head = 0;
  private n = 0;

  readonly capacity: number;
  readonly names: string[];

  constructor(capacity: number, names: string[]) {
    this.capacity = capacity;
    this.names = names;
    this.t = new Float64Array(capacity);
    this.cols = names.map(() => new Float64Array(capacity));
  }

  push(t: number, values: number[]): void {
    this.t[this.head] = t;
    for (let i = 0; i < this.cols.length; i++) this.cols[i][this.head] = values[i] ?? NaN;
    this.head = (this.head + 1) % this.capacity;
    this.n = Math.min(this.capacity, this.n + 1);
  }

  get length(): number {
    return this.n;
  }

  /** Ordered copy of the samples with t >= since, as [t, ...cols] arrays. */
  window(since: number): number[][] {
    const out: number[][] = [[], ...this.cols.map(() => [] as number[])];
    for (let i = 0; i < this.n; i++) {
      const k = (this.head - this.n + i + this.capacity) % this.capacity;
      if (this.t[k] < since) continue;
      out[0].push(this.t[k]);
      for (let c = 0; c < this.cols.length; c++) out[c + 1].push(this.cols[c][k]);
    }
    return out;
  }

  clear(): void {
    this.head = 0;
    this.n = 0;
  }
}
