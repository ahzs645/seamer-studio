// Minimal dense linear algebra for the measurement-completion regression.
// Gauss-Jordan elimination with partial pivoting (singular threshold 1e-10), matching the
// original model's inverse routine.

const SINGULAR = 1e-10;

/** Invert a square matrix (row-major n x n). Returns null if singular. */
export function invert(a: number[][]): number[][] | null {
  const n = a.length;
  // augmented [A | I]
  const m: number[][] = a.map((row, i) => {
    const r = row.slice();
    for (let j = 0; j < n; j++) r.push(i === j ? 1 : 0);
    return r;
  });

  for (let col = 0; col < n; col++) {
    // partial pivot
    let pivotRow = col;
    let pivotVal = Math.abs(m[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r][col]);
      if (v > pivotVal) { pivotVal = v; pivotRow = r; }
    }
    if (pivotVal < SINGULAR) return null;
    if (pivotRow !== col) { const t = m[pivotRow]; m[pivotRow] = m[col]; m[col] = t; }

    const piv = m[col][col];
    for (let j = 0; j < 2 * n; j++) m[col][j] /= piv;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[col][j];
    }
  }

  return m.map((row) => row.slice(n));
}

/** Multiply matrix (m x n) by vector (n) -> (m). */
export function matVec(a: number[][], v: number[]): number[] {
  return a.map((row) => {
    let s = 0;
    for (let j = 0; j < v.length; j++) s += row[j] * v[j];
    return s;
  });
}

/** Dot product. */
export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
