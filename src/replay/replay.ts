import { isBuilt } from '../sim/Grid';
import type { GameEvent, World } from '../sim/World';
import type { Decision } from '../bot/brains';
import type { WolfMode, WolfPhase } from '../sim/entities';

/** sheep: [x, z, facing, speed, eating, wool, stamina, altura (0 suelo, 1 en una torre)] */
type SheepFrame = [number, number, number, number, number, number, number, number?];
/** wolf: [id, x, z, heading, speed, attacking, fase, modo, te ve] */
type WolfFrame = [number, number, number, number, number, number, number, number, number];
export const PHASES: WolfPhase[] = ['chase', 'windup', 'pounce', 'recover'];
export const MODES: WolfMode[] = ['wander', 'investigate', 'hunt', 'search', 'track'];

export interface ReplayFrame {
  t: number;
  s: SheepFrame;
  w: WolfFrame[];
  f: [number, number, number?][]; // [índice de celda, hp, tipo de celda (sin él: valla)]
  g: number[]; // cantidad de cada hierba
  b?: [number, number][]; // puentes: [celda de una torre, celda de la otra]
  ev?: GameEvent[];
  d?: { a: string; p?: Record<string, number> };
}

export interface Replay {
  version: 1;
  seed: number;
  brain: string;
  result: 'won' | 'lost';
  time: number;
  frames: ReplayFrame[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export class ReplayRecorder {
  readonly frames: ReplayFrame[] = [];
  private pendingEvents: GameEvent[] = [];
  private pendingDecision: Decision | null = null;
  private nextT = 0;

  constructor(
    private world: World,
    private interval = 0.1,
  ) {}

  /** Llamar después de cada world.update y antes de vaciar world.events. */
  tick(decision: Decision | null): void {
    const w = this.world;
    this.pendingEvents.push(...w.events);
    if (decision) this.pendingDecision = decision;
    if (w.time < this.nextT && w.state === 'playing') return;
    this.nextT = w.time + this.interval;

    const s = w.sheep;
    const f: [number, number, number][] = [];
    w.grid.cells.forEach((c, k) => {
      if (isBuilt(c)) f.push([k, Math.round(w.grid.hp[k]), c]);
    });
    const frame: ReplayFrame = {
      t: r2(w.time),
      s: [r2(s.pos.x), r2(s.pos.z), r2(s.facing), r2(s.speed), s.eating ? 1 : 0, r2(s.wool), Math.round(s.stamina), r2(s.elevation)],
      w: w.wolves.map((x) => [x.id, r2(x.pos.x), r2(x.pos.z), r2(x.heading), r2(x.speed), x.attacking ? 1 : 0, PHASES.indexOf(x.phase), MODES.indexOf(x.mode), x.sees ? 1 : 0]),
      f,
      g: w.grass.map((g) => r2(g.amount)),
    };
    if (w.bridges.length) frame.b = w.bridges.map((br) => [br.a[1] * w.grid.n + br.a[0], br.b[1] * w.grid.n + br.b[0]]);
    if (this.pendingEvents.length) frame.ev = this.pendingEvents.splice(0);
    if (this.pendingDecision) {
      frame.d = { a: this.pendingDecision.action, p: this.pendingDecision.probs };
      this.pendingDecision = null;
    }
    this.frames.push(frame);
  }

  build(brain: string): Replay {
    const w = this.world;
    return {
      version: 1,
      seed: w.seed,
      brain,
      result: w.state === 'won' ? 'won' : 'lost',
      time: r2(w.time),
      frames: this.frames,
    };
  }
}
