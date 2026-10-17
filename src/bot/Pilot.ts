import { CONFIG } from '../config';
import { emptyInput, type PlayerInput } from '../sim/entities';
import { Cell, type Vec2 } from '../sim/Grid';
import { findPath } from '../sim/pathfinding';
import type { PieceId } from '../sim/pieces';
import type { World } from '../sim/World';

export type Action = 'flee' | 'eat' | 'build' | 'tower' | 'distract';
export const ACTIONS: Action[] = ['flee', 'eat', 'build', 'tower', 'distract'];

/** Una celda a la que ir (hierba, torre...). */
interface CellTarget {
  i: number;
  j: number;
  x: number;
  z: number;
}

/**
 * "Las manos" del bot: convierte una acción de alto nivel (decidida por un cerebro)
 * en el PlayerInput de cada frame, igual que lo haría un jugador con teclado.
 */
export class Pilot {
  private fleeDir: Vec2 = { x: 0, z: 1 };
  private path: [number, number][] | null = null;
  private pathIdx = 0;
  private pathTarget = '';
  private repath = 0;
  private placeCooldown = 0;

  /** piece: lo que construye con la acción 'build'. */
  constructor(
    private world: World,
    readonly piece: PieceId = 'fence',
  ) {}

  input(action: Action, dt: number): PlayerInput {
    const w = this.world;
    const s = w.sheep;
    const inp = emptyInput();
    this.repath -= dt;
    this.placeCooldown -= dt;

    const nearest = this.nearestWolf();
    const wolfDist = nearest ? Math.hypot(nearest.x - s.pos.x, nearest.z - s.pos.z) : Infinity;

    if (action === 'build' && s.wool < CONFIG.pieces[this.piece].cost) action = 'flee';
    if (action === 'eat' && !this.bestGrass()) action = 'flee';

    if (s.crossing) return inp; // los bots aún no usan puentes; si acaba en uno, que lo termine
    // En la torre: quedarse; cualquier otra acción = saltar abajo y huir
    if (s.tower) {
      if (action === 'tower') return inp;
      if (action === 'distract' && this.distract(inp)) return inp;
      const d = this.jumpDir();
      inp.moveX = d.x;
      inp.moveZ = d.z;
      inp.dash = true;
      return inp;
    }
    if (action === 'tower' && this.goToTower(inp)) return this.reflexes(inp, wolfDist, false);
    if (action === 'tower') action = 'flee';
    if (action === 'distract' && !this.distract(inp)) action = 'flee';
    if (action === 'distract') {
      // lanzar sin dejar de alejarse
      const d = this.bestFleeDir();
      inp.moveX = d.x;
      inp.moveZ = d.z;
      return this.reflexes(inp, wolfDist, true);
    }

    if (action === 'flee' || action === 'build') {
      const d = this.bestFleeDir();
      inp.moveX = d.x;
      inp.moveZ = d.z;
      // correr hace ruido: solo si alguien nos está cazando de cerca
      inp.sprint = this.hunted(9);
      if (action === 'build' && nearest) {
        // retroceder apuntando al lobo y soltar vallas en medio
        inp.buildMode = true;
        inp.item = this.piece;
        inp.aimX = nearest.x - s.pos.x;
        inp.aimZ = nearest.z - s.pos.z;
        inp.sprint = false;
        if (this.placeCooldown <= 0 && w.buildTarget?.valid) {
          inp.place = true;
          this.placeCooldown = 0.25;
        }
      }
    } else {
      const g = this.bestGrass()!;
      const d = Math.hypot(g.x - s.pos.x, g.z - s.pos.z);
      if (d < CONFIG.sheep.eatRange - 0.3) {
        inp.eat = true;
      } else {
        const dir = this.steerTo(g);
        inp.moveX = dir.x;
        inp.moveZ = dir.z;
        inp.sprint = this.hunted(9);
      }
    }

    return this.reflexes(inp, wolfDist, true);
  }

  /** Esquives automáticos. canDash=false: no esquivar si eso estropea lo que está haciendo (subir). */
  private reflexes(inp: PlayerInput, wolfDist: number, canDash: boolean): PlayerInput {
    const w = this.world;
    const s = w.sheep;
    if (!canDash && s.climb > 0 && wolfDist > 2) return inp;

    // Reflejo 1: esquive lateral cuando un lobo salta (o está a punto)
    const pouncer = w.wolves.find(
      (x) =>
        (x.phase === 'pounce' || (x.phase === 'windup' && x.phaseTime < 0.12)) &&
        Math.hypot(x.pos.x - s.pos.x, x.pos.z - s.pos.z) < 6,
    );
    if (pouncer && s.dashCooldown <= 0) {
      const d = norm(s.pos.x - pouncer.pos.x, s.pos.z - pouncer.pos.z);
      const a = { x: -d.z, z: d.x };
      const b = { x: d.z, z: -d.x };
      const side = this.freeDistance(a) >= this.freeDistance(b) ? a : b;
      inp.moveX = side.x;
      inp.moveZ = side.z;
      inp.dash = true;
      inp.eat = false;
      return inp;
    }

    // Reflejo 2: esquive si un lobo está encima
    if (wolfDist < 2.3 && s.dashCooldown <= 0) {
      const d = this.bestFleeDir();
      inp.moveX = d.x;
      inp.moveZ = d.z;
      inp.dash = true;
      inp.eat = false;
    }
    return inp;
  }

  private nearestWolf(): Vec2 | null {
    const s = this.world.sheep;
    let best: Vec2 | null = null;
    let bd = Infinity;
    for (const w of this.world.wolves) {
      const d = Math.hypot(w.pos.x - s.pos.x, w.pos.z - s.pos.z);
      if (d < bd) {
        bd = d;
        best = w.pos;
      }
    }
    return best;
  }

  /** Hierba con buena relación cercanía / lejanía de los lobos. */
  private bestGrass() {
    const s = this.world.sheep;
    let best: (typeof this.world.grass)[number] | null = null;
    let bestScore = -Infinity;
    for (const g of this.world.grass) {
      if (g.amount <= 0) continue;
      const d = Math.hypot(g.x - s.pos.x, g.z - s.pos.z);
      const wd = Math.min(30, ...this.world.wolves.map((w) => Math.hypot(w.pos.x - g.x, w.pos.z - g.z)));
      const score = wd * 0.6 - d;
      if (score > bestScore) {
        bestScore = score;
        best = g;
      }
    }
    return best;
  }

  /** Ir a la torre más cercana (o construir una al lado) y subir. Devuelve false si no hay forma. */
  private goToTower(inp: PlayerInput): boolean {
    const w = this.world;
    const s = w.sheep;
    if (w.nearTower) {
      inp.climb = true;
      return true;
    }
    const t = this.nearestTower(12);
    if (t) {
      const d = this.steerTo(t);
      inp.moveX = d.x;
      inp.moveZ = d.z;
      inp.sprint = this.hunted(9);
      return true;
    }
    if (s.wool < CONFIG.pieces.tower.cost) return false;
    // construirla pegada, hacia donde huiríamos
    const d = this.bestFleeDir();
    inp.buildMode = true;
    inp.item = 'tower';
    inp.aimX = d.x;
    inp.aimZ = d.z;
    if (w.buildTarget?.item === 'tower' && w.buildTarget.valid) inp.place = true;
    else {
      inp.moveX = d.x * 0.3; // si no cabe ahí, moverse un poco y volver a intentar
      inp.moveZ = d.z * 0.3;
    }
    return true;
  }

  /** Lanzar una piña más allá del lobo que nos busca, para alejarlo. Devuelve false si no se puede. */
  private distract(inp: PlayerInput): boolean {
    const w = this.world;
    const s = w.sheep;
    const p = CONFIG.pinecone;
    if (s.wool < p.cost || s.throwCooldown > 0) return false;
    const target = w.wolves
      .filter((x) => x.mode !== 'wander')
      .sort((a, b) => Math.hypot(a.pos.x - s.pos.x, a.pos.z - s.pos.z) - Math.hypot(b.pos.x - s.pos.x, b.pos.z - s.pos.z))[0];
    if (!target) return false;
    const away = norm(target.pos.x - s.pos.x, target.pos.z - s.pos.z);
    inp.buildMode = true;
    inp.item = 'pinecone';
    inp.aimAt = { x: target.pos.x + away.x * 8, z: target.pos.z + away.z * 8 };
    inp.place = w.buildTarget?.item === 'pinecone' && w.buildTarget.valid;
    return true;
  }

  private nearestTower(range: number): CellTarget | null {
    const g = this.world.grid;
    const s = this.world.sheep;
    const [ci, cj] = g.toCell(s.pos.x, s.pos.z);
    const r = Math.ceil(range);
    let best: CellTarget | null = null;
    let bd = range;
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        if (g.get(i, j) !== Cell.Tower) continue;
        const c = g.center(i, j);
        const d = Math.hypot(c.x - s.pos.x, c.z - s.pos.z);
        if (d < bd) {
          bd = d;
          best = { i, j, ...c };
        }
      }
    }
    return best;
  }

  /** Hacia dónde saltar de la torre: lejos de los lobos. */
  private jumpDir(): Vec2 {
    const s = this.world.sheep;
    let x = 0;
    let z = 0;
    for (const w of this.world.wolves) {
      const dx = s.pos.x - w.pos.x;
      const dz = s.pos.z - w.pos.z;
      const d2 = Math.max(0.5, dx * dx + dz * dz);
      x += dx / d2;
      z += dz / d2;
    }
    return x === 0 && z === 0 ? { x: Math.sin(s.facing), z: Math.cos(s.facing) } : norm(x, z);
  }

  private steerTo(g: CellTarget): Vec2 {
    const w = this.world;
    const s = w.sheep;
    const grid = w.grid;
    const r = CONFIG.sheep.radius;
    if (grid.lineOfSight(s.pos, g, r, true)) {
      this.path = null;
      return norm(g.x - s.pos.x, g.z - s.pos.z);
    }
    const key = `${g.i},${g.j}`;
    if (!this.path || this.repath <= 0 || this.pathTarget !== key) {
      const [si, sj] = grid.toCell(s.pos.x, s.pos.z);
      // la celda destino puede ser una torre: entrar en ella cuesta poco (se para al lado)
      this.path = findPath(grid, si, sj, g.i, g.j, grid.get(g.i, g.j) === Cell.Tower ? 0 : 1000, true);
      this.pathIdx = 1;
      this.pathTarget = key;
      this.repath = 0.5;
    }
    if (this.path) {
      while (this.pathIdx < this.path.length - 1) {
        const c = grid.center(...this.path[this.pathIdx]);
        if (Math.hypot(c.x - s.pos.x, c.z - s.pos.z) < 0.5) this.pathIdx++;
        else break;
      }
      const c = grid.center(...this.path[Math.min(this.pathIdx, this.path.length - 1)]);
      return norm(c.x - s.pos.x, c.z - s.pos.z);
    }
    return norm(g.x - s.pos.x, g.z - s.pos.z);
  }

  private hunted(range: number): boolean {
    const s = this.world.sheep;
    return this.world.wolves.some((w) => w.sees && Math.hypot(w.pos.x - s.pos.x, w.pos.z - s.pos.z) < range);
  }

  private freeDistance(d: Vec2): number {
    const s = this.world.sheep;
    let free = 0;
    while (free < 4 && this.world.grid.lineOfSight(s.pos, { x: s.pos.x + d.x * (free + 0.5), z: s.pos.z + d.z * (free + 0.5) }, CONFIG.sheep.radius, true)) free += 0.5;
    return free;
  }

  /** Prueba 16 direcciones y elige la que más aleja de los lobos sin meterse en esquinas. */
  private bestFleeDir(): Vec2 {
    const w = this.world;
    const s = w.sheep;
    const grid = w.grid;
    const half = grid.half;
    let best = this.fleeDir;
    let bestScore = -Infinity;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      let free = 0;
      while (free < 8 && grid.lineOfSight(s.pos, { x: s.pos.x + dx * (free + 0.5), z: s.pos.z + dz * (free + 0.5) }, CONFIG.sheep.radius, true)) free += 0.5;
      if (free < 1) continue;
      const step = Math.min(free, 4);
      const p = { x: s.pos.x + dx * step, z: s.pos.z + dz * step };
      let danger = 0;
      let hidden = 0;
      for (const wolf of w.wolves) {
        const d = Math.hypot(wolf.pos.x - p.x, wolf.pos.z - p.z);
        danger += 1 / Math.max(0.5, d);
        // esconderse: punto que el lobo que nos busca no puede ver
        if (wolf.mode !== 'wander' && !grid.sightLine(wolf.pos, p)) hidden += 1;
      }
      const edge = Math.min(half - Math.abs(p.x), half - Math.abs(p.z));
      const score = -danger * 20 + hidden * 1.5 + free * 0.25 + (dx * this.fleeDir.x + dz * this.fleeDir.z) * 0.8 - Math.max(0, 8 - edge) * 0.6;
      if (score > bestScore) {
        bestScore = score;
        best = { x: dx, z: dz };
      }
    }
    this.fleeDir = best;
    return best;
  }
}

function norm(x: number, z: number): Vec2 {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
}
