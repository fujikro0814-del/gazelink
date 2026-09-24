// Small dense linear algebra for the IK (matrices are row-major number[][]).

/** Solve A x = b by Gaussian elimination with partial pivoting. Returns x and det(A). A, b are not modified. */
export function solve(A: number[][], b: number[]): { x: number[]; det: number } {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  let det = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (p !== c) {
      [M[p], M[c]] = [M[c], M[p]];
      det = -det;
    }
    const piv = M[c][c];
    det *= piv;
    if (Math.abs(piv) < 1e-300) return { x: new Array(n).fill(0), det: 0 };
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / piv;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return { x, det };
}

/** A * A^T (m x m) for an m x n matrix. */
export function aat(A: number[][]): number[][] {
  const m = A.length;
  const n = A[0].length;
  const out: number[][] = [];
  for (let i = 0; i < m; i++) {
    out.push(new Array(m).fill(0));
  }
  for (let i = 0; i < m; i++) {
    for (let j = i; j < m; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += A[i][k] * A[j][k];
      out[i][j] = s;
      out[j][i] = s;
    }
  }
  return out;
}

/** A^T * y for an m x n matrix A and m-vector y. */
export function atv(A: number[][], y: number[]): number[] {
  const n = A[0].length;
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < A.length; i++) {
    for (let k = 0; k < n; k++) out[k] += A[i][k] * y[i];
  }
  return out;
}

/** A * v for an m x n matrix A and n-vector v. */
export function av(A: number[][], v: number[]): number[] {
  return A.map((row) => row.reduce((s, a, k) => s + a * v[k], 0));
}
