// Cuadrícula del mundo. Obstáculos y construcciones ocupan celdas completas.
// En el futuro: varios niveles de altura (torres).

export const Cell = {
  Empty: 0,
  Tree: 1,
  Rock: 2,
  Fence: 3,
  Border: 4,
  Hedge: 5,
  Wall: 6,
  Gate: 7,
  Tower: 8,
} as const;
export type CellType = (typeof Cell)[keyof typeof Cell];

/** Construcciones de la oveja: los lobos las pueden romper a mordiscos. */
export const isBuilt = (c: number): boolean =>
  c === Cell.Fence || c === Cell.Hedge || c === Cell.Wall || c === Cell.Gate || c === Cell.Tower;
/** ¿Tapa la vista? Todo lo sólido salvo la valla (se ve entre los palos). */
export const blocksSight = (c: number): boolean => c !== Cell.Empty && c !== Cell.Fence;

export interface Vec2 {
  x: number;
  z: number;
}

export class Grid {
  readonly cells: Uint8Array;
  readonly hp: Float32Array;
  readonly half: number;
  /** Se incrementa cada vez que cambia una celda (para que el render sepa cuándo resincronizar). */
  version = 0;

  constructor(readonly n: number) {
    this.cells = new Uint8Array(n * n);
    this.hp = new Float32Array(n * n);
    this.half = n / 2;
  }

  inBounds(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < this.n && j < this.n;
  }

  get(i: number, j: number): number {
    return this.inBounds(i, j) ? this.cells[j * this.n + i] : Cell.Border;
  }

  set(i: number, j: number, type: CellType, hp = 0): void {
    if (!this.inBounds(i, j)) return;
    const k = j * this.n + i;
    this.cells[k] = type;
    this.hp[k] = hp;
    this.version++;
  }

  /** ¿Bloquea el paso? La oveja (passGates) cruza las puertas; los lobos no. */
  isSolid(i: number, j: number, passGates = false): boolean {
    const c = this.get(i, j);
    return c !== Cell.Empty && !(passGates && c === Cell.Gate);
  }

  toCell(x: number, z: number): [number, number] {
    return [Math.floor(x + this.half), Math.floor(z + this.half)];
  }

  center(i: number, j: number): Vec2 {
    return { x: i - this.half + 0.5, z: j - this.half + 0.5 };
  }

  // ---- Vértices: el lobo es grande y se coloca en vértices, ocupando las 4 celdas que lo rodean.
  // El vértice (vi, vj) es la esquina compartida por las celdas (vi-1..vi, vj-1..vj).

  vertex(vi: number, vj: number): Vec2 {
    return { x: vi - this.half, z: vj - this.half };
  }

  /**
   * Coste extra de que el lobo ocupe ese vértice: Infinity si hay árboles, rocas o borde;
   * si no, lo que cuesta romper las construcciones del bloque (breakPenalty por cada 150 de vida).
   */
  vertexCost(vi: number, vj: number, breakPenalty: number): number {
    let extra = 0;
    for (let j = vj - 1; j <= vj; j++) {
      for (let i = vi - 1; i <= vi; i++) {
        const c = this.get(i, j);
        if (c === Cell.Empty) continue;
        if (!isBuilt(c)) return Infinity;
        extra += breakPenalty * (this.hp[j * this.n + i] / 150);
      }
    }
    return extra;
  }

  /** Vértice libre de obstáculos naturales más cercano a un punto (entre las 4 esquinas de su celda). */
  nearestVertex(p: Vec2): [number, number] {
    const [ci, cj] = this.toCell(p.x, p.z);
    let best: [number, number] = [Math.round(p.x + this.half), Math.round(p.z + this.half)];
    let bd = Infinity;
    for (const [vi, vj] of [[ci, cj], [ci + 1, cj], [ci, cj + 1], [ci + 1, cj + 1]] as const) {
      if (this.vertexCost(vi, vj, 0) === Infinity) continue;
      const v = this.vertex(vi, vj);
      const d = Math.hypot(v.x - p.x, v.z - p.z);
      if (d < bd) {
        bd = d;
        best = [vi, vj];
      }
    }
    return best;
  }

  /** Aplica daño a la construcción de una celda. Devuelve true si se ha destruido. */
  damage(i: number, j: number, amount: number): boolean {
    if (!this.inBounds(i, j)) return false;
    const k = j * this.n + i;
    this.hp[k] -= amount;
    if (this.hp[k] <= 0) {
      this.set(i, j, Cell.Empty);
      return true;
    }
    return false;
  }

  /** Empuja un círculo fuera de las celdas sólidas. Devuelve true si ha chocado. */
  collideCircle(p: Vec2, r: number, passGates = false): boolean {
    const [ci, cj] = this.toCell(p.x, p.z);
    let hit = false;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (!this.isSolid(i, j, passGates)) continue;
        const minX = i - this.half;
        const minZ = j - this.half;
        const nx = Math.max(minX, Math.min(p.x, minX + 1));
        const nz = Math.max(minZ, Math.min(p.z, minZ + 1));
        const dx = p.x - nx;
        const dz = p.z - nz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        hit = true;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = (r - d) / d;
          p.x += dx * push;
          p.z += dz * push;
        } else {
          // Centro dentro de la celda: salir por el borde más cercano
          const left = p.x - minX;
          const right = minX + 1 - p.x;
          const top = p.z - minZ;
          const bottom = minZ + 1 - p.z;
          const m = Math.min(left, right, top, bottom);
          if (m === left) p.x = minX - r;
          else if (m === right) p.x = minX + 1 + r;
          else if (m === top) p.z = minZ - r;
          else p.z = minZ + 1 + r;
        }
      }
    }
    return hit;
  }

  /** ¿Se ve b desde a? Ver blocksSight. La celda de b no cuenta (una oveja en una puerta se ve). */
  sightLine(a: Vec2, b: Vec2): boolean {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const steps = Math.ceil(Math.hypot(dx, dz) / 0.3);
    const [bi, bj] = this.toCell(b.x, b.z);
    for (let s = 1; s < steps; s++) {
      const [i, j] = this.toCell(a.x + (dx * s) / steps, a.z + (dz * s) / steps);
      if (i === bi && j === bj) continue;
      if (blocksSight(this.get(i, j))) return false;
    }
    return true;
  }

  /** ¿Hay camino recto libre entre a y b para un cuerpo de radio r? */
  lineOfSight(a: Vec2, b: Vec2, r: number, passGates = false): boolean {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return true;
    const px = (-dz / len) * r;
    const pz = (dx / len) * r;
    const steps = Math.ceil(len / 0.25);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      for (let o = -1; o <= 1; o++) {
        const [i, j] = this.toCell(x + px * o, z + pz * o);
        if (this.isSolid(i, j, passGates)) return false;
      }
    }
    return true;
  }
}
