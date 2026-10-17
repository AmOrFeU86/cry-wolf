// Foto del estado de la partida que el servidor reparte unas 30 veces por segundo.
// Arrays en vez de objetos para que ocupe poco (mismo estilo que las repeticiones).
import { isBuilt } from '../sim/Grid';
import type { GameEvent, GameState, World } from '../sim/World';
import { MODES, PHASES } from '../replay/replay';

/**
 * sheep: [id, x, z, facing, vx, vz, eating, wool, stamina, elevation, stun, exhausted, caught,
 *         dashTimer, dashCooldown, throwCooldown, climb, torre (celda o -1), puente desde (celda o -1), puente hasta, puente t]
 */
export type SheepSnap = number[];
/** wolf: [id, x, z, heading, speed, attacking (celda o -1), fase, modo, te ve, presa (id de oveja o -1)] */
export type WolfSnap = number[];

export interface Snapshot {
  t: number;
  st: GameState;
  s: SheepSnap[];
  w: WolfSnap[];
  g: number[]; // cantidad de cada hierba
  b: [number, number][]; // puentes: [celda de una torre, celda de la otra]
  /** Construcciones [celda, hp, tipo]; solo cuando cambian (o al entrar alguien). */
  f?: [number, number, number][];
  ev: GameEvent[];
  stats: World['stats'];
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Lo usa el servidor: recuerda qué construcciones mandó la última vez para no repetirlas. */
export class SnapshotEncoder {
  private lastBuilds = '';

  /** full: mandar las construcciones aunque no hayan cambiado (alguien acaba de entrar). */
  encode(world: World, events: GameEvent[], full: boolean): Snapshot {
    const g = world.grid;
    const cell = (c: [number, number] | null) => (c ? c[1] * g.n + c[0] : -1);
    const f: [number, number, number][] = [];
    g.cells.forEach((c, k) => {
      if (isBuilt(c)) f.push([k, Math.round(g.hp[k]), c]);
    });
    const key = JSON.stringify(f);
    const snap: Snapshot = {
      t: r3(world.time),
      st: world.state,
      s: world.flock.map((s) => [
        s.id, r2(s.pos.x), r2(s.pos.z), r2(s.facing), r2(s.vel.x), r2(s.vel.z), s.eating ? 1 : 0, r2(s.wool), Math.round(s.stamina),
        r2(s.elevation), r2(s.stun), s.exhausted ? 1 : 0, s.caught ? 1 : 0, r2(s.dashTimer), r2(s.dashCooldown), r2(s.throwCooldown),
        r2(s.climb), cell(s.tower), cell(s.crossing?.from ?? null), cell(s.crossing?.to ?? null), r2(s.crossing?.t ?? 0),
      ]),
      w: world.wolves.map((w) => [
        w.id, r2(w.pos.x), r2(w.pos.z), r2(w.heading), r2(w.speed), cell(w.attacking), PHASES.indexOf(w.phase), MODES.indexOf(w.mode), w.sees ? 1 : 0, w.prey ?? -1,
      ]),
      g: world.grass.map((q) => r2(q.amount)),
      b: world.bridges.map((br) => [cell(br.a), cell(br.b)]),
      ev: events,
      stats: { ...world.stats },
    };
    if (full || key !== this.lastBuilds) {
      snap.f = f;
      this.lastBuilds = key;
    }
    return snap;
  }
}
