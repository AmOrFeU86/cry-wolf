import { Wolf } from '../sim/entities';
import { Cell, isBuilt, type CellType } from '../sim/Grid';
import { World } from '../sim/World';
import { MODES, PHASES, type Replay, type ReplayFrame } from './replay';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpAngle = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
};

/** Reproduce una partida grabada sobre un World reconstruido con la misma semilla. */
export class ReplayPlayer {
  readonly world: World;
  time = 0;
  speed = 1;
  paused = false;
  lastDecision = '';
  private idx = 0;
  private wolves = new Map<number, Wolf>();
  private buildKey = '';
  private bridgeKey = '';

  constructor(readonly replay: Replay) {
    this.world = new World(replay.seed, replay.night);
  }

  get finished(): boolean {
    return this.time >= this.replay.time;
  }

  restart(): void {
    this.time = 0;
    this.idx = 0;
    this.lastDecision = '';
    this.world.clearScent();
  }

  update(dt: number): void {
    const frames = this.replay.frames;
    if (!this.paused) this.time = Math.min(this.replay.time, this.time + dt * this.speed);

    // avanzar frames, disparando sus eventos/decisiones una vez
    while (this.idx < frames.length - 1 && frames[this.idx + 1].t <= this.time) {
      this.idx++;
      this.onEnter(frames[this.idx]);
    }
    const a = frames[this.idx];
    const b = frames[Math.min(this.idx + 1, frames.length - 1)];
    const k = b.t > a.t ? Math.max(0, Math.min(1, (this.time - a.t) / (b.t - a.t))) : 0;
    this.apply(a, b, k);

    const w = this.world;
    const prevT = w.time;
    w.time = this.time;
    w.state = this.finished ? this.replay.result : 'playing';
    // el rastro no se graba: se reconstruye a partir del recorrido de la oveja
    if (this.time > prevT) w.updateScent(this.time - prevT);
  }

  private onEnter(f: ReplayFrame): void {
    if (f.ev) this.world.events.push(...f.ev);
    if (f.d) {
      const p = f.d.p?.[f.d.a];
      this.lastDecision = `${f.d.a}${p !== undefined ? ` (${Math.round(p * 100)}%)` : ''}`;
    }
  }

  private apply(a: ReplayFrame, b: ReplayFrame, k: number): void {
    const w = this.world;
    const s = w.sheep;
    s.pos.x = lerp(a.s[0], b.s[0], k);
    s.pos.z = lerp(a.s[1], b.s[1], k);
    s.facing = lerpAngle(a.s[2], b.s[2], k);
    const spd = lerp(a.s[3], b.s[3], k);
    s.vel.x = spd; // solo se usa la magnitud para animar
    s.vel.z = 0;
    s.eating = a.s[4] === 1;
    s.wool = a.s[5];
    s.stamina = a.s[6];
    s.elevation = lerp(a.s[7] ?? 0, b.s[7] ?? 0, k);

    const seen = new Set<number>();
    for (const wa of a.w) {
      const [id, x, z, h, sp, att, ph, md, sees] = wa;
      const wb = b.w.find((q) => q[0] === id) ?? wa;
      let wolf = this.wolves.get(id);
      if (!wolf) {
        wolf = new Wolf(x, z);
        this.wolves.set(id, wolf);
        w.wolves.push(wolf);
      }
      wolf.pos.x = lerp(x, wb[1], k);
      wolf.pos.z = lerp(z, wb[2], k);
      wolf.heading = lerpAngle(h, wb[3], k);
      wolf.speed = lerp(sp, wb[4], k);
      wolf.attacking = att ? [0, 0] : null;
      wolf.phase = PHASES[ph] ?? 'chase';
      wolf.mode = MODES[md] ?? 'hunt';
      wolf.sees = sees === 1;
      seen.add(id);
    }
    // al rebobinar, quitar lobos que aún no existían
    for (const [id, wolf] of this.wolves) {
      if (!seen.has(id)) {
        this.wolves.delete(id);
        w.wolves.splice(w.wolves.indexOf(wolf), 1);
      }
    }

    const key = a.f.map((f) => `${f[0]}:${f[2] ?? Cell.Fence}`).join(',');
    if (key !== this.buildKey) {
      this.buildKey = key;
      const g = w.grid;
      const want = new Map(a.f.map((f) => [f[0], (f[2] ?? Cell.Fence) as CellType]));
      for (let c = 0; c < g.cells.length; c++) {
        const type = want.get(c);
        if (type === undefined ? !isBuilt(g.cells[c]) : g.cells[c] === type) continue;
        g.set(c % g.n, Math.floor(c / g.n), type ?? Cell.Empty);
      }
    }
    for (const [c, hp] of a.f) w.grid.hp[c] = hp;
    const bkey = (a.b ?? []).join(';');
    if (bkey !== this.bridgeKey) {
      this.bridgeKey = bkey;
      const n = w.grid.n;
      w.bridges.length = 0;
      for (const [p, q] of a.b ?? []) w.bridges.push({ a: [p % n, Math.floor(p / n)], b: [q % n, Math.floor(q / n)] });
      w.bridgeVersion++;
    }
    a.g.forEach((amt, n) => (w.grass[n].amount = amt));
  }
}
