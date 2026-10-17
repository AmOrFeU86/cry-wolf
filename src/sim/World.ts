import { CONFIG } from '../config';
import { Cell, Grid, isBuilt, type CellType, type Vec2 } from './Grid';
import { clamp, dist, wrapAngle } from './math';
import { LAST_NIGHT, NIGHTS, itemsForNight, type Night } from './nights';
import { PIECE_CELL, pieceOfCell, type ItemId, type PieceId } from './pieces';
import { mulberry32 } from './rng';
import { emptyInput, Sheep, type Grass, type Wolf, type PlayerInput, type Scent } from './entities';
import { WolfAI } from './WolfAI';

export type GameState = 'playing' | 'won' | 'lost';

/** Donde empieza la (primera) oveja: el centro del prado. */
const START: Vec2 = { x: 0.5, z: 0.5 };
/** Orden de una oveja que no hace nada. */
const IDLE = emptyInput();

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
  | 'nightfall' // anochece: los lobos ven peor y huelen mejor
  | 'gate' // la oveja llega a una puerta (se abre)
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
  id?: number; // oveja que lo provoca (esquive, subir, caer, lanzar, atrapada...)
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
  locked: boolean; // aún no se ha desbloqueado en esta noche
}

/** Puente colgante entre dos torres. */
export interface Bridge {
  a: [number, number];
  b: [number, number];
}

/** Jugador de una partida multijugador. */
export interface PlayerSlot {
  id: number;
  name: string;
}

/** Piña en el aire. */
interface Projectile {
  x: number;
  z: number;
  t: number; // segundos hasta caer
}

/**
 * Simulación completa del juego, sin nada de render.
 * Se puede ejecutar igual en el navegador o en un servidor (multijugador).
 */
export class World {
  readonly grid = new Grid(CONFIG.mapSize);
  /** Todas las ovejas. En solitario solo hay una. */
  readonly flock: Sheep[] = [];
  /** Id de la oveja que se ve y controla en esta pantalla (`sheep`). */
  focus = 0;
  readonly wolves: Wolf[] = [];
  readonly grass: Grass[] = [];
  /** Rastro de olor de la oveja, de más antiguo a más reciente. */
  readonly scent: Scent[] = [];
  /** Eventos del frame para efectos/sonidos. Los consume el render. */
  readonly events: GameEvent[] = [];
  readonly rng: () => number;

  time = 0;
  state: GameState = 'playing';
  readonly projectiles: Projectile[] = [];
  readonly bridges: Bridge[] = [];
  /** Cambia al poner o quitar puentes (para el render). */
  bridgeVersion = 0;
  private bridgeGridVersion = -1;
  /** Hazañas de la partida (para el resumen final y la experiencia). */
  readonly stats = { escapes: 0, closeCalls: 0, bitesAbsorbed: 0, lured: 0, built: 0, towerTime: 0 };
  readonly night: Night;
  /** Lo que se puede construir o lanzar en esta noche. */
  readonly items: ItemId[];
  private readonly wolfAI = new WolfAI(this);
  private spawnTimer = CONFIG.prepTime;
  private firstWave = true;
  private nightfall = false;

  constructor(
    readonly seed = (Math.random() * 2 ** 31) | 0,
    /** Índice de la noche (0 = la primera). Por defecto la última: la dificultad completa. */
    readonly nightIndex = LAST_NIGHT,
    /** Jugadores (multijugador). Sin ellos, una sola oveja con id 0. */
    players: PlayerSlot[] = [{ id: 0, name: '' }],
  ) {
    this.night = NIGHTS[nightIndex];
    this.items = itemsForNight(nightIndex);
    this.rng = mulberry32(seed);
    this.generate();
    for (const p of players) this.addSheep(p.id, p.name);
    this.focus = players[0]?.id ?? 0;
  }

  /** La oveja de esta pantalla (en solitario, la única). */
  get sheep(): Sheep {
    return this.flock.find((s) => s.id === this.focus) ?? this.flock[0];
  }

  /** Ovejas que siguen en juego. */
  get alive(): Sheep[] {
    return this.flock.filter((s) => !s.caught);
  }

  get buildTarget(): BuildTarget | null {
    return this.sheep.buildTarget;
  }

  get nearGrass(): Grass | null {
    return this.sheep.nearGrass;
  }

  get nearTower(): [number, number] | null {
    return this.sheep.nearTower;
  }

  /** Mete una oveja en el prado: la primera en el centro, las demás alrededor en el primer hueco libre. */
  addSheep(id: number, name = ''): Sheep {
    const s = new Sheep();
    s.id = id;
    s.name = name;
    const k = this.flock.length;
    if (k > 0) {
      const g = this.grid;
      // en corro alrededor del centro; si está ocupado (construcciones), cada vez más lejos
      for (let r = 1.4; r < 20; r += 0.7) {
        const a = k * 2.4 + r;
        const p = { x: 0.5 + Math.sin(a) * r, z: 0.5 + Math.cos(a) * r };
        const [i, j] = g.toCell(p.x, p.z);
        if (g.get(i, j) !== Cell.Empty) continue;
        const q = { ...p };
        if (g.collideCircle(q, CONFIG.sheep.radius, true)) continue;
        s.pos = p;
        break;
      }
    }
    this.flock.push(s);
    return s;
  }

  removeSheep(id: number): void {
    const k = this.flock.findIndex((s) => s.id === id);
    if (k >= 0) this.flock.splice(k, 1);
    for (const w of this.wolves) if (w.prey === id) w.prey = null;
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
    const [si, sj] = g.toCell(START.x, START.z);
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
    const [si, sj] = g.nearestVertex(START);
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

  /** Segundos a sobrevivir desde que llegan los lobos. */
  get survivalTime(): number {
    return this.night.survivalTime;
  }

  /** Segundos sobrevividos desde que llegaron los lobos. */
  get survived(): number {
    return clamp(this.time - CONFIG.prepTime, 0, this.survivalTime);
  }

  /** Hora del día: 0 al empezar (mañana) → 1 al acabar (noche). */
  get dayProgress(): number {
    return Math.min(1, this.time / (CONFIG.prepTime + this.survivalTime));
  }

  /** 0 de día → 1 de noche cerrada (al final de la partida). */
  get darkness(): number {
    return clamp((this.dayProgress - 0.72) / 0.16, 0, 1);
  }

  /** Alcance de la vista de los lobos: de noche ven menos. */
  get sightRange(): number {
    return CONFIG.wolf.sightRange * (1 + (CONFIG.darkness.sight - 1) * this.darkness);
  }

  /** Alcance del olfato de los lobos: de noche huelen mejor. */
  get smellRange(): number {
    return CONFIG.wolf.smellRange * (1 + (CONFIG.darkness.smell - 1) * this.darkness);
  }

  /**
   * Avanza la simulación. `input`: la orden de la única oveja (solitario) o, en multijugador,
   * la de cada oveja por id (las que no tengan orden se quedan quietas).
   */
  update(dt: number, input: PlayerInput | ReadonlyMap<number, PlayerInput>): void {
    if (this.state !== 'playing') return;
    this.time += dt;

    if (!this.nightfall && this.darkness >= 0.5) {
      this.nightfall = true;
      this.events.push({ type: 'nightfall', x: this.sheep.pos.x, z: this.sheep.pos.z });
    }
    for (const s of this.flock) {
      if (s.caught) continue;
      const inp = input instanceof Map ? (input.get(s.id) ?? IDLE) : s === this.flock[0] ? (input as PlayerInput) : IDLE;
      s.noiseFx -= dt;
      if (s.noiseFx <= 0) s.lastNoiseR = 0;
      this.updateSheep(s, dt, inp);
      this.updateScent(dt, s);
      this.updateBuild(s, inp);
    }
    this.updateBridges();
    this.updateProjectiles(dt);
    this.updateGrass(dt);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.wolves.length < this.night.maxWolves) {
      const count = this.firstWave ? CONFIG.wolf.firstWolves : 1;
      for (let k = 0; k < count; k++) this.wolfAI.spawn();
      if (this.firstWave) this.events.push({ type: 'howl', x: 0, z: 0 });
      this.firstWave = false;
      this.spawnTimer = this.night.spawnInterval;
    }

    this.wolfAI.update(dt);

    for (const s of this.flock) {
      if (s.caught || s.tower || s.crossing) continue;
      if (!this.wolves.some((w) => dist(w.pos, s.pos) < CONFIG.wolf.catchDistance)) continue;
      s.caught = true;
      s.eating = false;
      s.buildTarget = null;
      s.vel.x = s.vel.z = 0;
      this.events.push({ type: 'caught', x: s.pos.x, z: s.pos.z, id: s.id });
    }
    if (!this.flock.some((s) => !s.caught)) {
      this.state = 'lost';
      return;
    }

    if (this.time >= CONFIG.prepTime + this.survivalTime) this.state = 'won';
  }

  private updateSheep(s: Sheep, dt: number, input: PlayerInput): void {
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
      this.events.push({ type: 'fall', x: s.pos.x, z: s.pos.z, id: s.id });
    }
    if (s.stun > 0) moving = false;

    if (s.crossing) {
      if (this.crossBridge(s, dt, moving, mx, mz)) return;
      // el puente se ha caído con ella encima
      s.crossing = null;
      s.stun = CONFIG.tower.fallStun;
      this.grid.collideCircle(s.pos, c.radius, true);
      this.events.push({ type: 'fall', x: s.pos.x, z: s.pos.z, id: s.id });
      moving = false;
    }

    if (s.tower) {
      // En lo alto: los lobos no llegan. Solo puede girar, construir o lanzar, y saltar abajo (esquive)
      s.vel.x = s.vel.z = 0;
      s.eating = false;
      s.nearGrass = null;
      s.nearTower = null;
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
      this.events.push({ type: 'dash', x: s.pos.x, z: s.pos.z, id: s.id });
      this.makeNoise(c.dashNoise, s);
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

      if (moving) this.makeNoise(sprinting ? c.sprintNoise : c.walkNoise, s);
      const speed = moving ? (sprinting ? c.sprintSpeed : c.walkSpeed) : 0;
      const k = Math.min(1, c.accel * dt);
      s.vel.x += (mx * speed - s.vel.x) * k;
      s.vel.z += (mz * speed - s.vel.z) * k;
    }

    s.pos.x += s.vel.x * dt;
    s.pos.z += s.vel.z * dt;
    this.grid.collideCircle(s.pos, c.radius, true);
    this.checkGates(s);

    if (moving) {
      const target = Math.atan2(mx, mz);
      s.facing += clamp(wrapAngle(target - s.facing), -14 * dt, 14 * dt);
    }

    // Subir a una torre: quieta a su lado manteniendo E
    s.nearTower = this.adjacentTower(s);
    if (input.climb && !moving && s.dashTimer <= 0 && s.nearTower) {
      s.climb += dt;
      if (s.climb >= CONFIG.tower.climbTime) {
        s.climb = 0;
        s.tower = s.nearTower;
        const tc = this.grid.center(...s.tower);
        s.pos.x = tc.x;
        s.pos.z = tc.z;
        s.vel.x = s.vel.z = 0;
        this.events.push({ type: 'climb', x: tc.x, z: tc.z, id: s.id });
      }
    } else {
      s.climb = 0;
    }
    s.elevation = s.tower ? 1 : (s.climb / CONFIG.tower.climbTime) * 0.5;

    // Comer
    s.nearGrass = this.grassNear(s);
    s.eating = input.eat && !moving && s.dashTimer <= 0 && s.climb === 0 && !s.tower && s.nearGrass !== null;
    if (s.eating && s.nearGrass) {
      const gr = s.nearGrass;
      const amt = Math.min(c.eatRate * dt, gr.amount);
      gr.amount -= amt;
      s.wool += amt;
      if (gr.amount <= 0) gr.regrow = CONFIG.grass.regrowTime;
    }
  }

  /** Hierba con algo que comer al alcance de la oveja. */
  private grassNear(s: Sheep): Grass | null {
    let found: Grass | null = null;
    let best = CONFIG.sheep.eatRange;
    for (const gr of this.grass) {
      if (gr.amount <= 0) continue;
      const d = dist(gr, s.pos);
      if (d < best) {
        best = d;
        found = gr;
      }
    }
    return found;
  }

  /**
   * Solo calcula lo que la oveja tiene a mano (pieza apuntada, hierba, torre) sin cambiar nada.
   * Lo usa el cliente multijugador para que la mira responda al instante, sin esperar al servidor.
   */
  preview(s: Sheep, input: PlayerInput): void {
    if (s.caught) {
      s.buildTarget = s.nearGrass = s.nearTower = null;
      return;
    }
    const onGround = !s.tower && !s.crossing;
    s.nearGrass = onGround ? this.grassNear(s) : null;
    s.nearTower = onGround ? this.adjacentTower(s) : null;
    this.updateBuild(s, { ...input, place: false, remove: false });
  }

  private updateBuild(s: Sheep, input: PlayerInput): void {
    s.buildTarget = null;
    if (!input.buildMode) return;
    const g = this.grid;
    if (!this.items.includes(input.item)) {
      const aim = this.aimPoint(s, input, CONFIG.buildRange, 1.5);
      const [i, j] = g.toCell(aim.x, aim.z);
      s.buildTarget = { i, j, x: aim.x, z: aim.z, item: input.item, valid: false, removable: null, poor: false, locked: true };
      return;
    }
    if (input.item === 'pinecone') {
      this.updateThrow(s, input);
      return;
    }
    if (input.item === 'bridge') {
      this.updateBridgeBuild(s, input);
      return;
    }
    const aim = this.aimPoint(s, input, CONFIG.buildRange, 1.5);
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
    s.buildTarget = { i, j, x: c.x, z: c.z, item: piece, valid, removable, poor, locked: false };

    if (input.place && valid) {
      g.set(i, j, PIECE_CELL[piece], CONFIG.pieces[piece].hp);
      s.wool -= cost;
      this.events.push({ type: 'built', x: c.x, z: c.z, piece, id: s.id });
      this.stats.built++;
      this.makeNoise(CONFIG.sheep.buildNoise, s);
    } else if (input.remove && removable) {
      const p = CONFIG.pieces[removable];
      const k = j * g.n + i;
      s.wool += p.cost * CONFIG.dismantleRefund * Math.max(0, g.hp[k] / p.hp);
      g.set(i, j, Cell.Empty);
      this.events.push({ type: 'dismantled', x: c.x, z: c.z, piece: removable, id: s.id });
      this.makeNoise(CONFIG.sheep.buildNoise, s);
    }
  }

  /**
   * Punto del suelo apuntado: la mira (como mucho a `range` de la oveja) o, si no hay mira (bots),
   * `fallback` metros en la dirección aimX/aimZ.
   */
  private aimPoint(s: Sheep, input: PlayerInput, range: number, fallback: number): Vec2 {
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
  private updateThrow(s: Sheep, input: PlayerInput): void {
    const p = CONFIG.pinecone;
    const target = this.clampToMap(this.aimPoint(s, input, p.range, p.range * 0.6));
    const [i, j] = this.grid.toCell(target.x, target.z);
    const poor = s.wool < p.cost;
    const valid = !poor && s.throwCooldown <= 0 && s.stun <= 0;
    s.buildTarget = { i, j, x: target.x, z: target.z, item: 'pinecone', valid, removable: null, poor, locked: false };
    if (input.place && valid) {
      s.wool -= p.cost;
      s.throwCooldown = p.cooldown;
      this.projectiles.push({ x: target.x, z: target.z, t: p.flightTime });
      this.events.push({ type: 'throw', x: s.pos.x, z: s.pos.z, tx: target.x, tz: target.z, id: s.id });
    }
  }

  /** Tender un puente desde la torre en la que está hasta otra torre cercana apuntada. */
  private updateBridgeBuild(s: Sheep, input: PlayerInput): void {
    const g = this.grid;
    const p = CONFIG.bridge;
    const aim = this.aimPoint(s, input, p.range + 1, 3);
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
    s.buildTarget = { i: target?.[0] ?? ai, j: target?.[1] ?? aj, x: at.x, z: at.z, item: 'bridge', valid, removable: null, poor, locked: false };
    if (input.place && valid && from && target) {
      this.bridges.push({ a: from, b: target });
      this.bridgeVersion++;
      s.wool -= p.cost;
      this.stats.built++;
      const c = g.center(...from);
      this.events.push({ type: 'built', x: (c.x + at.x) / 2, z: (c.z + at.z) / 2, id: s.id });
      this.makeNoise(CONFIG.sheep.buildNoise, s);
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
  private crossBridge(s: Sheep, dt: number, moving: boolean, mx: number, mz: number): boolean {
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
    s.nearGrass = null;
    s.nearTower = null;
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
      this.makeNoise(CONFIG.pinecone.noise, null, pr);
    }
  }

  /** Al acercarse a una puerta, se abre (evento para el sonido; la animación la hace el render). */
  private checkGates(s: Sheep): void {
    const g = this.grid;
    const [ci, cj] = g.toCell(s.pos.x, s.pos.z);
    const near = new Set<number>();
    for (let j = cj - 1; j <= cj + 1; j++) {
      for (let i = ci - 1; i <= ci + 1; i++) {
        if (g.get(i, j) !== Cell.Gate) continue;
        const c = g.center(i, j);
        if (dist(c, s.pos) > 1) continue;
        const k = j * g.n + i;
        near.add(k);
        if (!s.nearGates.has(k)) this.events.push({ type: 'gate', x: c.x, z: c.z, id: s.id });
      }
    }
    s.nearGates = near;
  }

  /** Torre pegada a la oveja (en las 8 celdas de alrededor). */
  private adjacentTower(s: Sheep): [number, number] | null {
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
    if (this.flock.some((s) => !s.caught && overlaps(s.pos, CONFIG.sheep.radius))) return true;
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

  /** Deja huellas de olor al moverse; quieta, refresca la última. Público para las repeticiones. */
  updateScent(dt: number, s = this.sheep): void {
    const c = CONFIG.sheep;
    s.scentTimer -= dt;
    if (s.scentTimer <= 0) {
      s.scentTimer = c.scentInterval;
      if (!s.lastScent || dist(s.lastScent, s.pos) > 0.6) {
        s.lastScent = { x: s.pos.x, z: s.pos.z, t: this.time };
        this.scent.push(s.lastScent);
      } else {
        // la última huella de esta oveja (con varias, no tiene por qué ser la última de la lista)
        s.lastScent.t = this.time;
      }
    }
    while (this.scent.length && this.time - this.scent[0].t > c.scentLife) this.scent.shift();
  }

  clearScent(): void {
    this.scent.length = 0;
    for (const s of this.flock) {
      s.lastScent = null;
      s.scentTimer = 0;
    }
  }

  /** Intensidad 0..1 de una huella. */
  scentStrength(p: Scent): number {
    return Math.max(0, 1 - (this.time - p.t) / CONFIG.sheep.scentLife);
  }

  /** Ruido (de la oveja, o en `at`): los lobos que lo oyen (y no la están cazando ya) van a investigar. */
  private makeNoise(radius: number, s: Sheep | null, at: Vec2 = s!.pos): void {
    const away = s === null;
    if (radius >= 4 && (away || s.noiseFx <= 0 || radius > s.lastNoiseR)) {
      if (s) {
        s.noiseFx = 0.5;
        s.lastNoiseR = radius;
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

  clampToMap(p: Vec2): Vec2 {
    const lim = this.grid.half - 1.5;
    return { x: clamp(p.x, -lim, lim), z: clamp(p.z, -lim, lim) };
  }
}
