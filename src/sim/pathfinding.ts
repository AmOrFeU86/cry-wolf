import { Cell, Grid, isBuilt, type Vec2 } from './Grid';

const DIRS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

class MinHeap {
  private items: number[] = [];
  private pri: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, p: number): void {
    const { items, pri } = this;
    let i = items.length;
    items.push(item);
    pri.push(p);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pri[parent] <= p) break;
      items[i] = items[parent];
      pri[i] = pri[parent];
      i = parent;
    }
    items[i] = item;
    pri[i] = p;
  }

  pop(): number {
    const { items, pri } = this;
    const top = items[0];
    const lastI = items.pop()!;
    const lastP = pri.pop()!;
    const n = items.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && pri[r] < pri[l] ? r : l;
        if (pri[c] >= lastP) break;
        items[i] = items[c];
        pri[i] = pri[c];
        i = c;
      }
      items[i] = lastI;
      pri[i] = lastP;
    }
    return top;
  }
}

/**
 * A* en la cuadrícula (8 direcciones, sin cortar esquinas).
 * Las construcciones se pueden "atravesar" con un coste extra proporcional a su vida
 * (breakPenalty por cada 150 de vida): el lobo decide si rodear o romper.
 * passGates: la oveja cruza las puertas como si fueran suelo.
 */
export function findPath(
  grid: Grid,
  si: number,
  sj: number,
  gi: number,
  gj: number,
  breakPenalty: number,
  passGates = false,
  maxIter = 8000,
): [number, number][] | null {
  const n = grid.n;
  if (!grid.inBounds(si, sj) || !grid.inBounds(gi, gj)) return null;

  const size = n * n;
  const g = new Float32Array(size).fill(Infinity);
  const came = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const start = sj * n + si;
  const goal = gj * n + gi;
  const h = (i: number, j: number) => {
    const dx = Math.abs(i - gi);
    const dz = Math.abs(j - gj);
    return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  };
  const stepCost = (k: number) => {
    const type = grid.cells[k];
    if (type === Cell.Empty || (passGates && type === Cell.Gate)) return 1;
    return isBuilt(type) ? 1 + breakPenalty * (grid.hp[k] / 150) : Infinity;
  };

  const heap = new MinHeap();
  g[start] = 0;
  heap.push(start, h(si, sj));

  let iter = 0;
  while (heap.size > 0 && iter++ < maxIter) {
    const cur = heap.pop();
    if (cur === goal) {
      const path: [number, number][] = [];
      for (let k = goal; k !== -1; k = came[k]) path.push([k % n, (k / n) | 0]);
      return path.reverse();
    }
    if (closed[cur]) continue;
    closed[cur] = 1;
    const ci = cur % n;
    const cj = (cur / n) | 0;
    for (const [di, dj, base] of DIRS) {
      const ni = ci + di;
      const nj = cj + dj;
      if (!grid.inBounds(ni, nj)) continue;
      const idx = nj * n + ni;
      const c = stepCost(idx);
      if (c === Infinity) continue;
      if (di !== 0 && dj !== 0 && (grid.isSolid(ci + di, cj, passGates) || grid.isSolid(ci, cj + dj, passGates))) continue;
      if (closed[idx]) continue;
      const ng = g[cur] + base * c;
      if (ng < g[idx]) {
        g[idx] = ng;
        came[idx] = cur;
        heap.push(idx, ng + h(ni, nj));
      }
    }
  }
  return null;
}

/**
 * A* para el lobo, que es grande: ocupa un bloque de 2×2 celdas centrado en un vértice de la cuadrícula
 * (ver Grid.vertexCost). Así no cabe por huecos de una celda y a veces tiene que romper para pasar.
 * Termina en cualquier vértice a menos de `reach` del objetivo. Devuelve vértices [vi, vj].
 */
export function findWolfPath(
  grid: Grid,
  start: [number, number],
  goal: Vec2,
  reach: number,
  breakPenalty: number,
  maxIter = 8000,
): [number, number][] | null {
  const m = grid.n + 1; // vértices por lado
  const [si, sj] = start;
  if (si < 0 || sj < 0 || si >= m || sj >= m) return null;
  const size = m * m;
  const g = new Float32Array(size).fill(Infinity);
  const came = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const gx = goal.x + grid.half;
  const gz = goal.z + grid.half;
  const h = (i: number, j: number) => {
    const dx = Math.abs(i - gx);
    const dz = Math.abs(j - gz);
    return Math.max(0, Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz) - reach);
  };
  const reached = (i: number, j: number) => Math.hypot(i - gx, j - gz) <= reach;

  const heap = new MinHeap();
  const startK = sj * m + si;
  g[startK] = 0;
  heap.push(startK, h(si, sj));
  let iter = 0;
  while (heap.size > 0 && iter++ < maxIter) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    const ci = cur % m;
    const cj = (cur / m) | 0;
    if (reached(ci, cj)) {
      const path: [number, number][] = [];
      for (let k = cur; k !== -1; k = came[k]) path.push([k % m, (k / m) | 0]);
      return path.reverse();
    }
    for (const [di, dj, base] of DIRS) {
      const ni = ci + di;
      const nj = cj + dj;
      const idx = nj * m + ni;
      if (ni < 0 || nj < 0 || ni >= m || nj >= m || closed[idx]) continue;
      const extra = grid.vertexCost(ni, nj, breakPenalty);
      if (extra === Infinity) continue;
      // en diagonal, sin rozar las esquinas: los dos vértices de al lado tienen que estar libres de obstáculos naturales
      if (di !== 0 && dj !== 0 && (grid.vertexCost(ci + di, cj, breakPenalty) === Infinity || grid.vertexCost(ci, cj + dj, breakPenalty) === Infinity)) continue;
      const ng = g[cur] + base + extra;
      if (ng < g[idx]) {
        g[idx] = ng;
        came[idx] = cur;
        heap.push(idx, ng + h(ni, nj));
      }
    }
  }
  return null;
}
