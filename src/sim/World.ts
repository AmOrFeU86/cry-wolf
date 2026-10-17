import { CONFIG } from '../config';
import { Cell, Grid, isBuilt, type CellType, type Vec2 } from './Grid';
import { findWolfPath } from './pathfinding';
import { PIECE_CELL, pieceOfCell, type ItemId, type PieceId } from './pieces';
import { mulberry32 } from './rng';
import { Sheep, Wolf, type Grass, type PlayerInput, type Scent } from './entities';

export type GameState = 'playing' | 'won' | 'lost';

export type GameEventType =
  | 'built'
  | 'destroyed'
  | 'bitten'
  | 'dismantled'
  | 'climb'
  | 'fall'
  | 'throw'
  | 'land'
  | 'escape' // un lobo que te cazaba te ha perdido
  | 'closeCall' // un salto que ha pasado rozando
  | 'windup' // un lobo se agacha para saltar
  | 'wolfSpawn'
  | 'caught'
  | 'dash'
  | 'howl'
  | 'noise'
  | 'sniff';
export interface GameEvent {
  type: GameEventType;
  x: number;
  z: number;
  r?: number; // radio (ruido, aullido)
  piece?: PieceId; // construcción afectada
  tx?: number; // destino (piña lanzada)
  tz?: number;
}

export interface BuildTarget {
  i: number;
  j: number;
  x: number; // punto exacto apuntado (centro de la celda para las piezas)
  z: number;
  item: ItemId;
  valid: boolean; // se puede colocar ahí la pieza elegida (o lanzar la piña)
  removable: PieceId | null; // hay una construcción que se puede desmontar
  poor: boolean; // falta lana para la pieza elegida
}

/** Puente colgante entre dos torres. */
export interface Bridge {
  a: [number, number];
  b: [number, number];
}

/** Piña en el aire. */
interface Projectile {
  x: number;
  z: number;
  t: number; // segundos hasta caer
}

const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Simulación completa del juego, sin nada de render.
 * Se puede ejecutar igual en el navegador o en un servidor (multijugador futuro).
 */
export class World {
  readonly grid = new Grid(CONFIG.mapSize);
  readonly sheep = new Sheep();
  readonly wolves: Wolf[] = [];
  readonly grass: Grass[] = [];
  /** Rastro de olor de la oveja, de más antiguo a más reciente. */
  readonly scent: Scent[] = [];
  /** Eventos del frame para efectos/sonidos. Los consume el render. */
  readonly events: GameEvent[] = [];
  readonly rng: () => number;

  time = 0;
  state: GameState = 'playing';
  buildTarget: BuildTarget | null = null;
  nearGrass: Grass | null = null;
  /** Torre a la que se puede subir desde donde está la oveja. */
  nearTower: [number, number] | null = null;
  readonly projectiles: Projectile[] = [];
  readonly bridges: Bridge[] = [];
  /** Cambia al poner o quitar puentes (para el render). */
  bridgeVersion = 0;
  private bridgeGridVersion = -1;
  /** Hazañas de la partida (para el resumen final y la experiencia). */
  readonly stats = { escapes: 0, closeCalls: 0, bitesAbsorbed: 0, lured: 0, built: 0, towerTime: 0 };
  private spawnTimer = CONFIG.prepTime;
  private firstWave = true;
  private scentTimer = 0;
  private lastScent: Vec2 | null = null;
  private noiseFx = 0;
  private lastNoiseR = 0;

  constructor(readonly seed = (Math.random() * 2 ** 31) | 0) {
    this.rng = mulberry32(seed);
    this.generate();
  }

  // ---------------------------------------------------------------- mapa

  private generate(): void {
    const n = CONFIG.mapSize;
    const g = this.grid;
    const r = this.rng;

    for (let k = 0; k < n; k++) {
      g.set(k, 0, Cell.Border);
      g.set(k, n - 1, Cell.Border);
      g.set(0, k, Cell.Border);
      g.set(n - 1, k, Cell.Border);
    }

    const tryPlace = (i: number, j: number, type: CellType) => {
      if (i <= 0 || j <= 0 || i >= n - 1 || j >= n - 1) return;
      if (Math.hypot(i - n / 2, j - n / 2) < 6) return; // zona de inicio despejada
      if (g.get(i, j) !== Cell.Empty) return;
      g.set(i, j, type);
    };
    const rndCell = () => 1 + Math.floor(r() * (n - 2));

    // Bosquecillos
    for (let c = 0; c < 14; c++) {
      const cx = rndCell();
      const cz = rndCell();
      const count = 4 + Math.floor(r() * 10);
      for (let k = 0; k < count; k++) {
        tryPlace(Math.round(cx + (r() - 0.5) * 6), Math.round(cz + (r() - 0.5) * 6), Cell.Tree);
      }
    }
    for (let k = 0; k < 40; k++) tryPlace(rndCell(), rndCell(), Cell.Tree);
    for (let k = 0; k < 30; k++) tryPlace(rndCell(), rndCell(), Cell.Rock);

    this.fillUnreachable();
    this.fillWolfPockets();

    // Parches de hierba
    let tries = 0;
    while (this.grass.length < CONFIG.grass.count && tries++ < 1000) {
      const i = rndCell();
      const j = rndCell();
      if (g.get(i, j) !== Cell.Empty) continue;
      if (Math.hypot(i - n / 2, j - n / 2) < 3) continue;
      if (this.grass.some((q) => Math.abs(q.i - i) + Math.abs(q.j - j) < 4)) continue;
      const c = g.center(i, j);
      this.grass.push({ i, j, x: c.x, z: c.z, amount: CONFIG.grass.amount, regrow: 0 });
    }
  }

  /** Rellena con árboles los huecos cerrados para que todo sea alcanzable. */
  private fillUnreachable(): void {
    const g = this.grid;
    const n = g.n;
    const seen = new Uint8Array(n * n);
    const [si, sj] = g.toCell(this.sheep.pos.x, this.sheep.pos.z);
    const stack = [sj * n + si];
    seen[stack[0]] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      const i = k % n;
      const j = (k / n) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di;
        const nj = j + dj;
        const nk = nj * n + ni;
        if (g.inBounds(ni, nj) && !seen[nk] && g.get(ni, nj) === Cell.Empty) {
          seen[nk] = 1;
          stack.push(nk);
        }
      }
    }
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) if (!seen[j * n + i] && g.get(i, j) === Cell.Empty) g.set(i, j, Cell.Tree);
  }

  /**
   * El lobo es grande y no cabe por huecos de una celda. Para que no haya escondites donde ningún lobo
   * pueda atraparte, se rellenan con árboles las celdas sin ninguna esquina a la que pueda llegar un lobo.
   * Los pasos estrechos cortos se quedan: son atajos solo para la oveja.
   */
  private fillWolfPockets(): void {
    const g = this.grid;
    const m = g.n + 1;
    const free = (vi: number, vj: number) => vi >= 0 && vj >= 0 && vi < m && vj < m && g.vertexCost(vi, vj, 0) === 0;
    const seen = new Uint8Array(m * m);
    const [si, sj] = g.nearestVertex(this.sheep.pos);
    const stack = [sj * m + si];
    seen[stack[0]] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      const vi = k % m;
      const vj = (k / m) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = vi + di;
        const nj = vj + dj;
        if (free(ni, nj) && !seen[nj * m + ni]) {
          seen[nj * m + ni] = 1;
          stack.push(nj * m + ni);
        }
      }
    }
    for (let j = 0; j < g.n; j++) {
      for (let i = 0; i < g.n; i++) {
        if (g.get(i, j) !== Cell.Empty) continue;
        const corners = [j * m + i, j * m + i + 1, (j + 1) * m + i, (j + 1) * m + i + 1];
        if (!corners.some((k) => seen[k])) g.set(i, j, Cell.Tree);
      }
    }
  }

  // ---------------------------------------------------------------- update

  /** ¿Estamos en la fase de preparación (sin lobos)? */
  get preparing(): boolean {
    return this.time < CONFIG.prepTime;
  }

  update(dt: number, input: PlayerInput): void {
    if (this.state !== 'playing') return;
    this.time += dt;

    this.noiseFx -= dt;
    if (this.noiseFx <= 0) this.lastNoiseR = 0;
    this.updateSheep(dt, input);
    this.updateScent(dt);
    this.updateBuild(input);
    this.updateBridges();
    this.updateProjectiles(dt);
    this.updateGrass(dt);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.wolves.length < CONFIG.wolf.maxWolves) {
      const count = this.firstWave ? CONFIG.wolf.firstWolves : 1;
      for (let k = 0; k < count; k++) this.spawnWolf();
      if (this.firstWave) this.events.push({ type: 'howl', x: 0, z: 0 });
      this.firstWave = false;
      this.spawnTimer = CONFIG.wolf.spawnInterval;
    }

    for (const w of this.wolves) this.updateWolf(w, dt);
    this.separateWolves();

    for (const w of this.wolves) {
      if (!this.sheep.tower && !this.sheep.crossing && dist(w.pos, this.sheep.pos) < CONFIG.wolf.catchDistance) {
        this.state = 'lost';
        this.events.push({ type: 'caught', x: this.sheep.pos.x, z: this.sheep.pos.z });
        return;
      }
    }

    if (this.time >= CONFIG.prepTime + CONFIG.survivalTime) this.state = 'won';
  }

  private updateSheep(dt: number, input: PlayerInput): void {
    const s = this.sheep;
    const c = CONFIG.sheep;

    let mx = input.moveX;
    let mz = input.moveZ;
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    let moving = len > 0.1;

    s.dashCooldown = Math.max(0, s.dashCooldown - dt);
    s.throwCooldown = Math.max(0, s.throwCooldown - dt);
    s.stun = Math.max(0, s.stun - dt);

    // La torre se ha derrumbado bajo sus pies: cae aturdida
    if (s.tower && this.grid.get(...s.tower) !== Cell.Tower) {
      s.tower = null;
      s.stun = CONFIG.tower.fallStun;
      this.events.push({ type: 'fall', x: s.pos.x, z: s.pos.z });
    }
    if (s.stun > 0) moving = false;

    if (s.crossing) {
      if (this.crossBridge(dt, moving, mx, mz)) return;
      // el puente se ha caído con ella encima
      s.crossing = null;
      s.stun = CONFIG.tower.fallStun;
      this.grid.collideCircle(s.pos, c.radius, true);
      this.events.push({ type: 'fall', x: s.pos.x, z: s.pos.z });
      moving = false;
    }

    if (s.tower) {
      // En lo alto: los lobos no llegan. Solo puede girar, construir o lanzar, y saltar abajo (esquive)
      s.vel.x = s.vel.z = 0;
      s.eating = false;
      this.nearGrass = null;
      this.nearTower = null;
      s.stamina = Math.min(c.staminaMax, s.stamina + c.staminaRegen * dt);
      if (moving) s.facing += clamp(wrapAngle(Math.atan2(mx, mz) - s.facing), -14 * dt, 14 * dt);
      const dir = moving ? { x: mx, z: mz } : { x: Math.sin(s.facing), z: Math.cos(s.facing) };
      const jump = input.dash && s.dashCooldown <= 0 ? this.jumpSpot(s.tower, dir) : null;
      // moverse hacia un puente: cruzarlo
      const to = !jump && moving ? this.bridgeToward(s.tower, dir) : null;
      if (to) {
        s.crossing = { from: s.tower, to, t: 0 };
        s.tower = null;
        s.elevation = 1;
        return;
      }
      if (!jump) {
        s.elevation = 1;
        this.stats.towerTime += dt;
        return;
      }
      s.tower = null;
      s.pos.x = jump.p.x;
      s.pos.z = jump.p.z;
      mx = jump.dir.x;
      mz = jump.dir.z;
      moving = true;
    }

    if (input.dash && s.stun <= 0 && s.dashCooldown <= 0 && s.stamina >= c.dashStamina) {
      s.dashTimer = c.dashTime;
      s.dashCooldown = c.dashCooldown;
      s.stamina -= c.dashStamina;
      s.dashDir = moving ? { x: mx, z: mz } : { x: Math.sin(s.facing), z: Math.cos(s.facing) };
      const dl = Math.hypot(s.dashDir.x, s.dashDir.z) || 1;
      s.dashDir.x /= dl;
      s.dashDir.z /= dl;
      this.events.push({ type: 'dash', x: s.pos.x, z: s.pos.z });
      this.makeNoise(c.dashNoise);
    }

    if (s.dashTimer > 0) {
      s.dashTimer -= dt;
      s.vel.x = s.dashDir.x * c.dashSpeed;
      s.vel.z = s.dashDir.z * c.dashSpeed;
    } else {
      const sprinting = input.sprint && moving && !s.exhausted && s.stamina > 0;
      if (sprinting) {
        s.stamina = Math.max(0, s.stamina - c.staminaDrain * dt);
        if (s.stamina <= 0) s.exhausted = true;
      } else {
        s.stamina = Math.min(c.staminaMax, s.stamina + c.staminaRegen * dt);
      }
      if (s.exhausted && s.stamina >= c.exhaustedUntil) s.exhausted = false;

      if (moving) this.makeNoise(sprinting ? c.sprintNoise : c.walkNoise);
      const speed = moving ? (sprinting ? c.sprintSpeed : c.walkSpeed) : 0;
      const k = Math.min(1, c.accel * dt);
      s.vel.x += (mx * speed - s.vel.x) * k;
      s.vel.z += (mz * speed - s.vel.z) * k;
    }

    s.pos.x += s.vel.x * dt;
    s.pos.z += s.vel.z * dt;
    this.grid.collideCircle(s.pos, c.radius, true);

    if (moving) {
      const target = Math.atan2(mx, mz);
      s.facing += clamp(wrapAngle(target - s.facing), -14 * dt, 14 * dt);
    }

    // Subir a una torre: quieta a su lado manteniendo E
    this.nearTower = this.adjacentTower();
    if (input.climb && !moving && s.dashTimer <= 0 && this.nearTower) {
      s.climb += dt;
      if (s.climb >= CONFIG.tower.climbTime) {
        s.climb = 0;
        s.tower = this.nearTower;
        const tc = this.grid.center(...s.tower);
        s.pos.x = tc.x;
        s.pos.z = tc.z;
        s.vel.x = s.vel.z = 0;
        this.events.push({ type: 'climb', x: tc.x, z: tc.z });
      }
    } else {
      s.climb = 0;
    }
    s.elevation = s.tower ? 1 : (s.climb / CONFIG.tower.climbTime) * 0.5;

    // Comer
    this.nearGrass = null;
    let best = c.eatRange;
    for (const gr of this.grass) {
      if (gr.amount <= 0) continue;
      const d = dist(gr, s.pos);
      if (d < best) {
        best = d;
        this.nearGrass = gr;
      }
    }
    s.eating = input.eat && !moving && s.dashTimer <= 0 && s.climb === 0 && !s.tower && this.nearGrass !== null;
    if (s.eating && this.nearGrass) {
      const gr = this.nearGrass;
      const amt = Math.min(c.eatRate * dt, gr.amount);
      gr.amount -= amt;
      s.wool += amt;
      if (gr.amount <= 0) gr.regrow = CONFIG.grass.regrowTime;
    }
  }

  private updateBuild(input: PlayerInput): void {
    this.buildTarget = null;
    if (!input.buildMode) return;
    const s = this.sheep;
    const g = this.grid;
    if (input.item === 'pinecone') {
      this.updateThrow(input);
      return;
    }
    if (input.item === 'bridge') {
      this.updateBridgeBuild(input);
      return;
    }
    const aim = this.aimPoint(input, CONFIG.buildRange, 1.5);
    const [i, j] = g.toCell(aim.x, aim.z);
    const piece = input.item;
    const cost = CONFIG.pieces[piece].cost;
    const cell = g.get(i, j);
    const poor = s.wool < cost;
    const valid =
      cell === Cell.Empty &&
      !poor &&
      !this.grass.some((q) => q.i === i && q.j === j) &&
      !this.cellOccupied(i, j);
    const onIt = s.tower !== null && s.tower[0] === i && s.tower[1] === j; // no se desmonta la torre en la que estás
    const removable = isBuilt(cell) && !onIt ? pieceOfCell(cell) : null;
    const c = g.center(i, j);
    this.buildTarget = { i, j, x: c.x, z: c.z, item: piece, valid, removable, poor };

    if (input.place && valid) {
      g.set(i, j, PIECE_CELL[piece], CONFIG.pieces[piece].hp);
      s.wool -= cost;
      this.events.push({ type: 'built', x: c.x, z: c.z, piece });
      this.stats.built++;
      this.makeNoise(CONFIG.sheep.buildNoise);
    } else if (input.remove && removable) {
      const p = CONFIG.pieces[removable];
      const k = j * g.n + i;
      s.wool += p.cost * CONFIG.dismantleRefund * Math.max(0, g.hp[k] / p.hp);
      g.set(i, j, Cell.Empty);
      this.events.push({ type: 'dismantled', x: c.x, z: c.z, piece: removable });
      this.makeNoise(CONFIG.sheep.buildNoise);
    }
  }

  /**
   * Punto del suelo apuntado: la mira (como mucho a `range` de la oveja) o, si no hay mira (bots),
   * `fallback` metros en la dirección aimX/aimZ.
   */
  private aimPoint(input: PlayerInput, range: number, fallback: number): Vec2 {
    const s = this.sheep;
    if (input.aimAt) {
      const dx = input.aimAt.x - s.pos.x;
      const dz = input.aimAt.z - s.pos.z;
      const k = Math.min(1, range / (Math.hypot(dx, dz) || 1));
      return { x: s.pos.x + dx * k, z: s.pos.z + dz * k };
    }
    const aimLen = Math.hypot(input.aimX, input.aimZ);
    return {
      x: s.pos.x + (aimLen > 1e-3 ? input.aimX / aimLen : Math.sin(s.facing)) * fallback,
      z: s.pos.z + (aimLen > 1e-3 ? input.aimZ / aimLen : Math.cos(s.facing)) * fallback,
    };
  }

  /** Lanzar una piña donde apunta la mira: al caer hace ruido y atrae a los lobos que no te están cazando. */
  private updateThrow(input: PlayerInput): void {
    const s = this.sheep;
    const p = CONFIG.pinecone;
    const target = this.clampToMap(this.aimPoint(input, p.range, p.range * 0.6));
    const [i, j] = this.grid.toCell(target.x, target.z);
    const poor = s.wool < p.cost;
    const valid = !poor && s.throwCooldown <= 0 && s.stun <= 0;
    this.buildTarget = { i, j, x: target.x, z: target.z, item: 'pinecone', valid, removable: null, poor };
    if (input.place && valid) {
      s.wool -= p.cost;
      s.throwCooldown = p.cooldown;
      this.projectiles.push({ x: target.x, z: target.z, t: p.flightTime });
      this.events.push({ type: 'throw', x: s.pos.x, z: s.pos.z, tx: target.x, tz: target.z });
    }
  }

  /** Tender un puente desde la torre en la que está hasta otra torre cercana apuntada. */
  private updateBridgeBuild(input: PlayerInput): void {
    const s = this.sheep;
    const g = this.grid;
    const p = CONFIG.bridge;
    const aim = this.aimPoint(input, p.range + 1, 3);
    // la torre más cercana al punto apuntado (se perdona un poco de puntería)
    const [ai, aj] = g.toCell(aim.x, aim.z);
    let target: [number, number] | null = null;
    let bd = Infinity;
    for (let j = aj - 1; j <= aj + 1; j++) {
      for (let i = ai - 1; i <= ai + 1; i++) {
        if (g.get(i, j) !== Cell.Tower || (s.tower && s.tower[0] === i && s.tower[1] === j)) continue;
        const d = dist(g.center(i, j), aim);
        if (d < bd) {
          bd = d;
          target = [i, j];
        }
      }
    }
    const from = s.tower;
    const at = target ? g.center(...target) : aim;
    const len = from && target ? dist(g.center(...from), at) : Infinity;
    const poor = s.wool < p.cost;
    const valid = !!from && !!target && len <= p.range && !this.bridgeBetween(from, target) && !poor;
    this.buildTarget = { i: target?.[0] ?? ai, j: target?.[1] ?? aj, x: at.x, z: at.z, item: 'bridge', valid, removable: null, poor };
    if (input.place && valid && from && target) {
      this.bridges.push({ a: from, b: target });
      this.bridgeVersion++;
      s.wool -= p.cost;
      this.stats.built++;
      const c = g.center(...from);
      this.events.push({ type: 'built', x: (c.x + at.x) / 2, z: (c.z + at.z) / 2 });
      this.makeNoise(CONFIG.sheep.buildNoise);
    }
  }

  bridgeBetween(a: [number, number], b: [number, number]): boolean {
    const same = (p: [number, number], q: [number, number]) => p[0] === q[0] && p[1] === q[1];
    return this.bridges.some((br) => (same(br.a, a) && same(br.b, b)) || (same(br.a, b) && same(br.b, a)));
  }

  /** Torre al otro lado de un puente que sale de `from` hacia `dir` (±45°). */
  private bridgeToward(from: [number, number], dir: Vec2): [number, number] | null {
    const g = this.grid;
    const c = g.center(...from);
    let best: [number, number] | null = null;
    let bestDot = Math.cos(Math.PI / 4);
    for (const br of this.bridges) {
      const other = br.a[0] === from[0] && br.a[1] === from[1] ? br.b : br.b[0] === from[0] && br.b[1] === from[1] ? br.a : null;
      if (!other) continue;
      const o = g.center(...other);
      const l = dist(o, c);
      const dot = ((o.x - c.x) * dir.x + (o.z - c.z) * dir.z) / l;
      if (dot > bestDot) {
        bestDot = dot;
        best = other;
      }
    }
    return best;
  }

  /** Avanza por el puente. Devuelve false si el puente ya no existe (se cae). */
  private crossBridge(dt: number, moving: boolean, mx: number, mz: number): boolean {
    const s = this.sheep;
    const cr = s.crossing!;
    if (!this.bridgeBetween(cr.from, cr.to)) return false;
    let a = this.grid.center(...cr.from);
    let b = this.grid.center(...cr.to);
    // darse la vuelta a mitad
    if (moving && mx * (b.x - a.x) + mz * (b.z - a.z) < 0) {
      [cr.from, cr.to] = [cr.to, cr.from];
      cr.t = 1 - cr.t;
      [a, b] = [b, a];
    }
    const len = dist(a, b);
    const speed = CONFIG.bridge.speed;
    cr.t = Math.min(1, cr.t + (speed * dt) / len);
    s.pos.x = a.x + (b.x - a.x) * cr.t;
    s.pos.z = a.z + (b.z - a.z) * cr.t;
    s.vel.x = ((b.x - a.x) / len) * speed; // solo para la animación
    s.vel.z = ((b.z - a.z) / len) * speed;
    s.facing += clamp(wrapAngle(Math.atan2(b.x - a.x, b.z - a.z) - s.facing), -14 * dt, 14 * dt);
    s.eating = false;
    s.elevation = 1;
    this.nearGrass = null;
    this.nearTower = null;
    s.stamina = Math.min(CONFIG.sheep.staminaMax, s.stamina + CONFIG.sheep.staminaRegen * dt);
    this.stats.towerTime += dt;
    if (cr.t >= 1) {
      s.tower = cr.to;
      s.crossing = null;
      s.vel.x = s.vel.z = 0;
    }
    return true;
  }

  /** Los puentes cuyas torres ya no existen se caen. */
  private updateBridges(): void {
    const g = this.grid;
    if (g.version === this.bridgeGridVersion) return;
    this.bridgeGridVersion = g.version;
    for (let k = this.bridges.length - 1; k >= 0; k--) {
      const br = this.bridges[k];
      if (g.get(...br.a) === Cell.Tower && g.get(...br.b) === Cell.Tower) continue;
      this.bridges.splice(k, 1);
      this.bridgeVersion++;
      const a = g.center(...br.a);
      const b = g.center(...br.b);
      this.events.push({ type: 'destroyed', x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
    }
  }

  private updateProjectiles(dt: number): void {
    for (let k = this.projectiles.length - 1; k >= 0; k--) {
      const pr = this.projectiles[k];
      pr.t -= dt;
      if (pr.t > 0) continue;
      this.projectiles.splice(k, 1);
      this.events.push({ type: 'land', x: pr.x, z: pr.z });
      this.makeNoise(CONFIG.pinecone.noise, pr);
    }
  }

  /** Torre pegada a la oveja (en las 8 celdas de alrededor). */
  private adjacentTower(): [number, number] | null {
    const s = this.sheep;
    const g = this.grid;
    const [ci, cj] = g.toCell(s.pos.x, s.pos.z);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (g.get(i, j) !== Cell.Tower) continue;
        const minX = i - g.half;
        const minZ = j - g.half;
        const nx = clamp(s.pos.x, minX, minX + 1);
        const nz = clamp(s.pos.z, minZ, minZ + 1);
        if (Math.hypot(s.pos.x - nx, s.pos.z - nz) < CONFIG.sheep.radius + 0.3) return [i, j];
      }
    }
    return null;
  }

  /** Dónde cae al saltar de la torre: hacia `dir` si hay sitio; si no, lo más parecido. */
  private jumpSpot(cell: [number, number], dir: Vec2): { p: Vec2; dir: Vec2 } | null {
    const c = this.grid.center(...cell);
    const base = Math.atan2(dir.x, dir.z);
    for (const da of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
      const d = { x: Math.sin(base + da), z: Math.cos(base + da) };
      for (const k of [1.0, 1.3]) {
        const p = { x: c.x + d.x * k, z: c.z + d.z * k };
        if (!this.grid.collideCircle({ ...p }, CONFIG.sheep.radius, true)) return { p, dir: d };
      }
    }
    return null;
  }

  private cellOccupied(i: number, j: number): boolean {
    const minX = i - this.grid.half;
    const minZ = j - this.grid.half;
    const overlaps = (p: Vec2, r: number) => {
      const nx = clamp(p.x, minX, minX + 1);
      const nz = clamp(p.z, minZ, minZ + 1);
      return (p.x - nx) ** 2 + (p.z - nz) ** 2 < r * r;
    };
    if (overlaps(this.sheep.pos, CONFIG.sheep.radius)) return true;
    return this.wolves.some((w) => overlaps(w.pos, CONFIG.wolf.radius));
  }

  private updateGrass(dt: number): void {
    for (const gr of this.grass) {
      if (gr.amount > 0) continue;
      gr.regrow -= dt;
      if (gr.regrow <= 0) gr.amount = CONFIG.grass.amount;
    }
  }

  // ---------------------------------------------------------------- lobos

  private spawnWolf(): void {
    const n = CONFIG.mapSize;
    const g = this.grid;
    const r = this.rng;
    for (let t = 0; t < 200; t++) {
      // en un vértice junto al borde con sitio para un lobo grande
      const k = 2 + Math.floor(r() * (n - 3));
      const side = Math.floor(r() * 4);
      const i = side === 0 ? 2 : side === 1 ? n - 2 : k;
      const j = side === 2 ? 2 : side === 3 ? n - 2 : k;
      if (g.vertexCost(i, j, 0) !== 0) continue;
      const c = g.vertex(i, j);
      if (dist(c, this.sheep.pos) < 22 && t < 160) continue;
      const w = new Wolf(c.x, c.z);
      w.heading = Math.atan2(-c.x, -c.z); // mirando hacia el centro del mapa
      w.repathTimer = r() * CONFIG.wolf.repathInterval;
      this.wolves.push(w);
      this.events.push({ type: 'wolfSpawn', x: c.x, z: c.z });
      return;
    }
  }

  /** Deja huellas de olor al moverse; quieta, refresca la última. Público para las repeticiones. */
  updateScent(dt: number): void {
    const c = CONFIG.sheep;
    const s = this.sheep;
    this.scentTimer -= dt;
    if (this.scentTimer <= 0) {
      this.scentTimer = c.scentInterval;
      if (!this.lastScent || dist(this.lastScent, s.pos) > 0.6) {
        this.scent.push({ x: s.pos.x, z: s.pos.z, t: this.time });
        this.lastScent = { x: s.pos.x, z: s.pos.z };
      } else if (this.scent.length) {
        this.scent[this.scent.length - 1].t = this.time;
      }
    }
    while (this.scent.length && this.time - this.scent[0].t > c.scentLife) this.scent.shift();
  }

  clearScent(): void {
    this.scent.length = 0;
    this.lastScent = null;
    this.scentTimer = 0;
  }

  /** Intensidad 0..1 de una huella. */
  scentStrength(p: Scent): number {
    return Math.max(0, 1 - (this.time - p.t) / CONFIG.sheep.scentLife);
  }

  /** Ruido (de la oveja, o en `at`): los lobos que lo oyen (y no la están cazando ya) van a investigar. */
  private makeNoise(radius: number, at: Vec2 = this.sheep.pos): void {
    const away = at !== this.sheep.pos;
    if (radius >= 4 && (away || this.noiseFx <= 0 || radius > this.lastNoiseR)) {
      if (!away) {
        this.noiseFx = 0.5;
        this.lastNoiseR = radius;
      }
      this.events.push({ type: 'noise', x: at.x, z: at.z, r: radius });
    }
    for (const w of this.wolves) {
      if (w.mode === 'hunt' || dist(w.pos, at) > radius) continue;
      if (away && w.mode !== 'investigate') this.stats.lured++;
      w.mode = 'investigate';
      w.modeTime = 10;
      w.target = this.clampToMap({ x: at.x + (this.rng() - 0.5) * 3, z: at.z + (this.rng() - 0.5) * 3 });
    }
  }

  /** Vista del lobo: alcance, campo de visión y obstáculos. Gestiona cazar / perder de vista. */
  private perceive(w: Wolf, dt: number): void {
    const cw = CONFIG.wolf;
    const s = this.sheep;
    w.howlCooldown -= dt;
    const d = dist(w.pos, s.pos);
    const angle = Math.abs(wrapAngle(Math.atan2(s.pos.x - w.pos.x, s.pos.z - w.pos.z) - w.heading));
    // si ya te persigue no hace falta que estés en su campo de visión: te está mirando
    const inView = w.mode === 'hunt' || d < cw.closeSense || angle < cw.fov;
    // subida a una torre se la ve desde más lejos y no la tapa nada
    const high = s.tower !== null || s.crossing !== null;
    w.sees = d < cw.sightRange * (high ? CONFIG.tower.sightBonus : 1) && inView && (high || this.grid.sightLine(w.pos, s.pos));

    if (w.sees) {
      w.lostTime = 0;
      if (w.mode !== 'hunt') {
        w.mode = 'hunt';
        if (w.howlCooldown <= 0) {
          // ¡Aullido! avisa a la manada
          w.howlCooldown = 8;
          this.events.push({ type: 'howl', x: w.pos.x, z: w.pos.z, r: cw.howlRange });
          for (const o of this.wolves) {
            if (o === w || o.mode === 'hunt' || dist(o.pos, w.pos) > cw.howlRange) continue;
            o.mode = 'investigate';
            o.modeTime = 12;
            o.target = { x: s.pos.x, z: s.pos.z };
          }
        }
      }
      w.lastSeen = { x: s.pos.x, z: s.pos.z };
      w.lastSeenVel = { x: s.vel.x, z: s.vel.z };
    } else if (w.mode !== 'hunt' && w.mode !== 'track') {
      // Olfato: si cruza tu rastro, lo sigue desde la huella más fresca a su alcance
      let best: Scent | null = null;
      for (const p of this.scent) {
        // solo huellas más frescas que la última que siguió (si no, se queda oliendo el mismo rastro)
        if (p.t > w.trackT && dist(p, w.pos) < cw.smellRange && this.scentStrength(p) > 0.1 && (!best || p.t > best.t)) best = p;
      }
      if (best) {
        w.mode = 'track';
        w.trackT = best.t;
        w.target = { x: best.x, z: best.z };
        this.events.push({ type: 'sniff', x: w.pos.x, z: w.pos.z });
      }
    } else if (w.mode === 'hunt' && w.lastSeen && (w.lostTime += dt) > cw.loseSightTime) {
      // Te ha perdido: va a donde cree que has ido y busca por la zona
      w.mode = 'search';
      this.stats.escapes++;
      this.events.push({ type: 'escape', x: w.pos.x, z: w.pos.z });
      w.modeTime = cw.searchTime;
      w.target = this.clampToMap({
        x: w.lastSeen.x + w.lastSeenVel.x * cw.predict,
        z: w.lastSeen.z + w.lastSeenVel.z * cw.predict,
      });
    }
  }

  private updateWolf(w: Wolf, dt: number): void {
    const cw = CONFIG.wolf;
    const s = this.sheep;

    // mientras muerde una construcción no se le acaba la paciencia (buscar, seguir el rastro...)
    const wasBiting = w.attacking !== null;
    w.attacking = null;
    w.repathTimer -= dt;
    w.pounceCooldown -= dt;
    if (!wasBiting) w.modeTime -= dt;
    this.perceive(w, dt);
    if (this.updatePounce(w, dt)) return;

    let speed = cw.searchSpeed;
    // el lobo grande no siempre puede llegar al punto exacto (ver goalReach)
    const arrived = () => !w.target || dist(w.pos, w.target) < cw.goalReach + 0.3;
    switch (w.mode) {
      case 'hunt':
        w.target = { x: s.pos.x, z: s.pos.z };
        speed = cw.speed + cw.speedGrowth * Math.max(0, this.time - CONFIG.prepTime);
        break;
      case 'investigate':
        if (arrived() || w.modeTime <= 0) {
          w.mode = 'search';
          w.modeTime = cw.searchTime * 0.6;
          w.lastSeen = w.target;
          w.target = null;
        }
        break;
      case 'search':
        if (w.modeTime <= 0) {
          w.mode = 'wander';
          w.target = null;
        } else if (arrived()) {
          w.target = this.randomPointNear(w.lastSeen ?? w.pos, 5);
        }
        break;
      case 'track':
        speed = cw.trackSpeed;
        if (arrived()) {
          // siguiente huella más fresca cerca; si no hay, ha perdido el rastro
          let best: Scent | null = null;
          for (const p of this.scent) {
            if (p.t > w.trackT && dist(p, w.pos) < 4.5 && (!best || p.t > best.t)) best = p;
          }
          if (best) {
            w.trackT = best.t;
            w.target = { x: best.x, z: best.z };
          } else {
            w.mode = 'search';
            w.modeTime = cw.searchTime * 0.6;
            w.lastSeen = { x: w.pos.x, z: w.pos.z };
            w.target = null;
          }
        }
        break;
      case 'wander':
        speed = cw.wanderSpeed;
        if (arrived() || w.modeTime <= 0) {
          const towardSheep = this.rng() < cw.wanderTowardSheep;
          w.target = this.randomPointNear(towardSheep ? s.pos : w.pos, towardSheep ? 12 : 14);
          w.modeTime = 8;
        }
        break;
    }
    if (w.phase === 'recover') speed = cw.recoverSpeed;
    // con una pista (te vio, te oyó, sigue tu rastro) rompe lo que le cierre el paso; merodeando, no
    if (w.target) this.steerWolf(w, w.target, speed, w.mode === 'hunt', w.mode !== 'wander', dt);
  }

  /** Mueve al lobo hacia un punto: en línea recta si puede, si no con A*. breaks: rompe lo que le cierre el paso. */
  private steerWolf(w: Wolf, target: Vec2, maxSpeed: number, hunting: boolean, breaks: boolean, dt: number): void {
    const cw = CONFIG.wolf;
    const g = this.grid;
    let tx = target.x;
    let tz = target.z;
    let turnRate = hunting ? cw.turnRate : cw.pathTurnRate;

    if (g.lineOfSight(w.pos, target, cw.radius * 0.9)) {
      w.path = null;
    } else {
      if (!w.path || w.repathTimer <= 0) {
        w.repathTimer = cw.repathInterval + this.rng() * 0.15;
        // cazando, llegar a donde pueda morder; si no, basta con acercarse
        const reach = hunting ? cw.catchDistance - 0.15 : cw.goalReach;
        w.path = findWolfPath(g, g.nearestVertex(w.pos), target, reach, breaks ? cw.breakPenalty : 1000);
        w.pathIdx = 1;
        if (!w.path && !breaks) {
          w.target = null; // destino inalcanzable: elegir otro
          return;
        }
      }
      if (w.path) {
        turnRate = cw.pathTurnRate;
        while (w.pathIdx < w.path.length) {
          const v = g.vertex(...w.path[w.pathIdx]);
          if (dist(w.pos, v) < 0.45) w.pathIdx++;
          else break;
        }
        if (w.pathIdx < w.path.length) {
          const [vi, vj] = w.path[w.pathIdx];
          const v = g.vertex(vi, vj);
          tx = v.x;
          tz = v.z;
          // ¿hay construcciones en el hueco por el que tiene que pasar? → romper la más cercana
          const blocker = this.nearestBuiltAround(vi, vj, w.pos);
          if (blocker && dist(w.pos, g.center(...blocker)) < cw.radius + 0.85) {
            if (!breaks) {
              w.target = null;
              w.path = null;
              return;
            }
            w.attacking = blocker;
            const c = g.center(...blocker);
            tx = c.x;
            tz = c.z;
          }
        }
      }
    }

    const desired = Math.atan2(tx - w.pos.x, tz - w.pos.z);
    const diff = wrapAngle(desired - w.heading);

    if (w.attacking) {
      const [i, j] = w.attacking;
      w.heading += clamp(diff, -turnRate * dt, turnRate * dt);
      w.speed = 0;
      w.biteTimer -= dt;
      const c = g.center(i, j);
      const piece = pieceOfCell(g.get(i, j)) ?? undefined;
      if (g.damage(i, j, cw.biteDamage * dt)) {
        this.events.push({ type: 'destroyed', x: c.x, z: c.z, piece });
        w.path = null;
      } else if (w.biteTimer <= 0) {
        w.biteTimer = 0.45;
        this.events.push({ type: 'bitten', x: c.x, z: c.z, piece });
        this.stats.bitesAbsorbed++;
      }
      return;
    }

    w.heading = wrapAngle(w.heading + clamp(diff, -turnRate * dt, turnRate * dt));
    const align = Math.max(0, Math.cos(diff));
    const targetSpeed = maxSpeed * (0.35 + 0.65 * align);
    w.speed += (targetSpeed - w.speed) * Math.min(1, dt * 4);
    this.moveWolf(w, dt);
  }

  /** Construcción más cercana a p entre las 4 celdas que ocupa un lobo en el vértice (vi, vj). */
  private nearestBuiltAround(vi: number, vj: number, p: Vec2): [number, number] | null {
    const g = this.grid;
    let best: [number, number] | null = null;
    let bd = Infinity;
    for (let j = vj - 1; j <= vj; j++) {
      for (let i = vi - 1; i <= vi; i++) {
        if (!isBuilt(g.get(i, j))) continue;
        const d = dist(g.center(i, j), p);
        if (d < bd) {
          bd = d;
          best = [i, j];
        }
      }
    }
    return best;
  }

  private randomPointNear(p: Vec2, radius: number): Vec2 {
    const g = this.grid;
    for (let t = 0; t < 20; t++) {
      const a = this.rng() * Math.PI * 2;
      const r = this.rng() * radius;
      const q = this.clampToMap({ x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r });
      const [i, j] = g.toCell(q.x, q.z);
      if (g.get(i, j) === Cell.Empty) return g.center(i, j);
    }
    return { x: p.x, z: p.z };
  }

  private clampToMap(p: Vec2): Vec2 {
    const lim = this.grid.half - 1.5;
    return { x: clamp(p.x, -lim, lim), z: clamp(p.z, -lim, lim) };
  }

  /** Máquina de estados del salto. Devuelve true si controla el movimiento este frame. */
  private updatePounce(w: Wolf, dt: number): boolean {
    const cw = CONFIG.wolf;
    const s = this.sheep;
    w.phaseTime -= dt;
    switch (w.phase) {
      case 'chase': {
        const d = dist(w.pos, s.pos);
        if (w.sees && w.pounceCooldown <= 0 && d < cw.pounceRange && this.grid.lineOfSight(w.pos, s.pos, cw.radius * 0.9)) {
          w.phase = 'windup';
          w.phaseTime = cw.windupTime;
          this.events.push({ type: 'windup', x: w.pos.x, z: w.pos.z });
        }
        return false;
      }
      case 'windup': {
        // se agacha, frena y apunta (con giro limitado)
        const desired = Math.atan2(s.pos.x - w.pos.x, s.pos.z - w.pos.z);
        w.heading = wrapAngle(w.heading + clamp(wrapAngle(desired - w.heading), -cw.turnRate * dt, cw.turnRate * dt));
        w.speed = Math.max(0, w.speed - 20 * dt);
        this.moveWolf(w, dt);
        if (w.phaseTime <= 0) {
          w.phase = 'pounce';
          w.phaseTime = cw.pounceTime;
          w.speed = cw.pounceSpeed;
        }
        return true;
      }
      case 'pounce': {
        // línea recta, sin girar
        w.speed = cw.pounceSpeed;
        const hit = this.moveWolf(w, dt);
        if (w.phaseTime <= 0 || hit) {
          // ¡por los pelos! el salto acaba muy cerca pero sin atraparla
          const d = dist(w.pos, s.pos);
          if (d > cw.catchDistance && d < cw.catchDistance + 1.2 && !s.tower) {
            this.stats.closeCalls++;
            this.events.push({ type: 'closeCall', x: s.pos.x, z: s.pos.z });
          }
          w.phase = 'recover';
          w.phaseTime = cw.recoverTime;
          w.pounceCooldown = cw.pounceCooldown;
        }
        return true;
      }
      case 'recover':
        if (w.phaseTime <= 0) w.phase = 'chase';
        return false;
    }
  }

  private moveWolf(w: Wolf, dt: number): boolean {
    w.pos.x += Math.sin(w.heading) * w.speed * dt;
    w.pos.z += Math.cos(w.heading) * w.speed * dt;
    return this.grid.collideCircle(w.pos, CONFIG.wolf.radius);
  }

  private separateWolves(): void {
    const r = CONFIG.wolf.radius * 2;
    for (let a = 0; a < this.wolves.length; a++) {
      for (let b = a + 1; b < this.wolves.length; b++) {
        const p = this.wolves[a].pos;
        const q = this.wolves[b].pos;
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const d = Math.hypot(dx, dz);
        if (d > 1e-4 && d < r) {
          const push = (r - d) / d / 2;
          p.x -= dx * push;
          p.z -= dz * push;
          q.x += dx * push;
          q.z += dz * push;
        }
      }
    }
    for (const w of this.wolves) this.grid.collideCircle(w.pos, CONFIG.wolf.radius);
  }
}
