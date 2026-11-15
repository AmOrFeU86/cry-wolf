import { CONFIG } from '../config';
import { Cell, isBuilt, type Vec2 } from './Grid';
import { clamp, dist, wrapAngle } from './math';
import { findWolfPath } from './pathfinding';
import { pieceOfCell } from './pieces';
import { Wolf, type Scent, type Sheep } from './entities';
import type { World } from './World';

/** Comportamiento de los lobos: aparecer, sentidos, modos, caminos, romper construcciones y salto. */
export class WolfAI {
  constructor(private world: World) {}

  spawn(): void {
    const world = this.world;
    const n = CONFIG.mapSize;
    const g = world.grid;
    const r = world.rng;
    for (let t = 0; t < 200; t++) {
      // en un vértice junto al borde con sitio para un lobo grande
      const k = 2 + Math.floor(r() * (n - 3));
      const side = Math.floor(r() * 4);
      const i = side === 0 ? 2 : side === 1 ? n - 2 : k;
      const j = side === 2 ? 2 : side === 3 ? n - 2 : k;
      if (g.vertexCost(i, j, 0) !== 0) continue;
      const c = g.vertex(i, j);
      if (world.alive.some((s) => dist(c, s.pos) < 22) && t < 160) continue;
      const w = new Wolf(c.x, c.z);
      w.heading = Math.atan2(-c.x, -c.z); // mirando hacia el centro del mapa
      w.repathTimer = r() * CONFIG.wolf.repathInterval;
      world.wolves.push(w);
      world.events.push({ type: 'wolfSpawn', x: c.x, z: c.z });
      return;
    }
  }

  update(dt: number): void {
    for (const w of this.world.wolves) this.updateWolf(w, dt);
    this.separate();
  }

  /** Oveja a la que caza el lobo (si sigue en juego). */
  private preyOf(w: Wolf): Sheep | null {
    return this.world.flock.find((s) => s.id === w.prey && !s.caught) ?? null;
  }

  /** ¿Ve el lobo a esta oveja? Alcance, campo de visión y obstáculos. */
  private canSee(w: Wolf, s: Sheep): boolean {
    const world = this.world;
    const cw = CONFIG.wolf;
    if (s.safe > 0) return false; // acaba de volver al centro (modo niño)
    const d = dist(w.pos, s.pos);
    const angle = Math.abs(wrapAngle(Math.atan2(s.pos.x - w.pos.x, s.pos.z - w.pos.z) - w.heading));
    // si ya te persigue no hace falta que estés en su campo de visión: te está mirando
    const inView = (w.mode === 'hunt' && w.prey === s.id) || d < cw.closeSense || angle < cw.fov;
    // subida a una torre se la ve desde más lejos y no la tapa nada
    const high = s.tower !== null || s.crossing !== null;
    const range = world.sightRange * (high ? CONFIG.tower.sightBonus : 1) * (s.kid ? CONFIG.kid.sight : 1);
    return d < range && inView && (high || world.grid.sightLine(w.pos, s.pos));
  }

  /** Vista del lobo: elige a quién caza (su presa si la sigue viendo; si no, la más cercana que vea). */
  private perceive(w: Wolf, dt: number): void {
    const world = this.world;
    const cw = CONFIG.wolf;
    w.howlCooldown -= dt;
    let s = this.preyOf(w);
    w.sees = s !== null && this.canSee(w, s);
    if (!w.sees) {
      let bd = Infinity;
      for (const o of world.flock) {
        if (o.caught || o === s || !this.canSee(w, o)) continue;
        const d = dist(w.pos, o.pos);
        if (d < bd) {
          bd = d;
          s = o;
          w.sees = true;
        }
      }
    }
    if (s) w.prey = s.id;
    if (!s) {
      // su presa ya no está (atrapada o se ha ido): a buscar por donde la vio
      if (w.mode === 'hunt') {
        w.mode = 'search';
        w.modeTime = cw.searchTime;
        w.target = w.lastSeen ? world.clampToMap(w.lastSeen) : null;
      }
      w.sees = false;
    }

    if (w.sees && s) {
      w.lostTime = 0;
      if (w.mode !== 'hunt') {
        w.mode = 'hunt';
        if (w.howlCooldown <= 0) {
          // ¡Aullido! avisa a la manada
          w.howlCooldown = 8;
          world.events.push({ type: 'howl', x: w.pos.x, z: w.pos.z, r: cw.howlRange });
          for (const o of world.wolves) {
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
      const smell = world.smellRange;
      for (const p of world.scent) {
        // solo huellas más frescas que la última que siguió (si no, se queda oliendo el mismo rastro)
        if (p.t > w.trackT && dist(p, w.pos) < smell && world.scentStrength(p) > 0.1 && (!best || p.t > best.t)) best = p;
      }
      if (best) {
        w.mode = 'track';
        w.trackT = best.t;
        w.target = { x: best.x, z: best.z };
        world.events.push({ type: 'sniff', x: w.pos.x, z: w.pos.z });
      }
    } else if (w.mode === 'hunt' && w.lastSeen && (w.lostTime += dt) > cw.loseSightTime) {
      // Te ha perdido: va a donde cree que has ido y busca por la zona
      w.mode = 'search';
      world.stats.escapes++;
      world.events.push({ type: 'escape', x: w.pos.x, z: w.pos.z });
      w.modeTime = cw.searchTime;
      w.target = world.clampToMap({
        x: w.lastSeen.x + w.lastSeenVel.x * cw.predict,
        z: w.lastSeen.z + w.lastSeenVel.z * cw.predict,
      });
    }
  }

  private updateWolf(w: Wolf, dt: number): void {
    const world = this.world;
    const cw = CONFIG.wolf;

    // mientras muerde una construcción no se le acaba la paciencia (buscar, seguir el rastro...)
    const wasBiting = w.attacking !== null;
    w.attacking = null;
    w.repathTimer -= dt;
    w.pounceCooldown -= dt;
    if (!wasBiting) w.modeTime -= dt;
    this.perceive(w, dt);
    const s = this.preyOf(w);
    if (this.updatePounce(w, s, dt)) return;

    let speed = cw.searchSpeed;
    // el lobo grande no siempre puede llegar al punto exacto (ver goalReach)
    const arrived = () => !w.target || dist(w.pos, w.target) < cw.goalReach + 0.3;
    switch (w.mode) {
      case 'hunt':
        if (s) w.target = { x: s.pos.x, z: s.pos.z };
        speed = s?.kid ? CONFIG.kid.wolfSpeed : cw.speed + world.night.speedGrowth * world.survived;
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
          for (const p of world.scent) {
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
          const towardSheep = world.rng() < cw.wanderTowardSheep;
          // con varias ovejas, hacia una cualquiera (en solitario no gasta números aleatorios de más)
          const alive = world.alive;
          const near = towardSheep && alive.length ? alive[alive.length > 1 ? Math.floor(world.rng() * alive.length) : 0] : null;
          w.target = this.randomPointNear(near ? near.pos : w.pos, near ? 12 : 14);
          w.modeTime = 8;
        }
        break;
    }
    if (w.phase === 'recover') speed = cw.recoverSpeed;
    // con una pista (te vio, te oyó, sigue tu rastro) rompe lo que le cierre el paso; merodeando, no
    if (w.target) this.steer(w, w.target, speed, w.mode === 'hunt', w.mode !== 'wander', dt);
  }

  /** Mueve al lobo hacia un punto: en línea recta si puede, si no con A*. breaks: rompe lo que le cierre el paso. */
  private steer(w: Wolf, target: Vec2, maxSpeed: number, hunting: boolean, breaks: boolean, dt: number): void {
    const world = this.world;
    const cw = CONFIG.wolf;
    const g = world.grid;
    let tx = target.x;
    let tz = target.z;
    let turnRate = hunting ? cw.turnRate : cw.pathTurnRate;

    if (g.lineOfSight(w.pos, target, cw.radius * 0.9)) {
      w.path = null;
    } else {
      if (!w.path || w.repathTimer <= 0) {
        w.repathTimer = cw.repathInterval + world.rng() * 0.15;
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
        world.events.push({ type: 'destroyed', x: c.x, z: c.z, piece });
        w.path = null;
      } else if (w.biteTimer <= 0) {
        w.biteTimer = 0.45;
        world.events.push({ type: 'bitten', x: c.x, z: c.z, piece });
        world.stats.bitesAbsorbed++;
      }
      return;
    }

    w.heading = wrapAngle(w.heading + clamp(diff, -turnRate * dt, turnRate * dt));
    const align = Math.max(0, Math.cos(diff));
    const targetSpeed = maxSpeed * (0.35 + 0.65 * align);
    w.speed += (targetSpeed - w.speed) * Math.min(1, dt * 4);
    this.move(w, dt);
  }

  /** Construcción más cercana a p entre las 4 celdas que ocupa un lobo en el vértice (vi, vj). */
  private nearestBuiltAround(vi: number, vj: number, p: Vec2): [number, number] | null {
    const g = this.world.grid;
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
    const world = this.world;
    const g = world.grid;
    for (let t = 0; t < 20; t++) {
      const a = world.rng() * Math.PI * 2;
      const r = world.rng() * radius;
      const q = world.clampToMap({ x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r });
      const [i, j] = g.toCell(q.x, q.z);
      if (g.get(i, j) === Cell.Empty) return g.center(i, j);
    }
    return { x: p.x, z: p.z };
  }

  /** Máquina de estados del salto. Devuelve true si controla el movimiento este frame. */
  private updatePounce(w: Wolf, s: Sheep | null, dt: number): boolean {
    const world = this.world;
    const cw = CONFIG.wolf;
    w.phaseTime -= dt;
    switch (w.phase) {
      case 'chase': {
        if (!s) return false;
        const d = dist(w.pos, s.pos);
        if (w.sees && w.pounceCooldown <= 0 && d < cw.pounceRange && world.grid.lineOfSight(w.pos, s.pos, cw.radius * 0.9)) {
          w.phase = 'windup';
          w.phaseTime = s.kid ? CONFIG.kid.windupTime : cw.windupTime;
          world.events.push({ type: 'windup', x: w.pos.x, z: w.pos.z });
        }
        return false;
      }
      case 'windup': {
        // se agacha, frena y apunta (con giro limitado)
        const desired = s ? Math.atan2(s.pos.x - w.pos.x, s.pos.z - w.pos.z) : w.heading;
        w.heading = wrapAngle(w.heading + clamp(wrapAngle(desired - w.heading), -cw.turnRate * dt, cw.turnRate * dt));
        w.speed = Math.max(0, w.speed - 20 * dt);
        this.move(w, dt);
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
        const hit = this.move(w, dt);
        if (w.phaseTime <= 0 || hit) {
          // ¡por los pelos! el salto acaba muy cerca pero sin atraparla
          const d = s ? dist(w.pos, s.pos) : Infinity;
          if (s && d > cw.catchDistance && d < cw.catchDistance + 1.2 && !s.tower) {
            world.stats.closeCalls++;
            world.events.push({ type: 'closeCall', x: s.pos.x, z: s.pos.z, id: s.id });
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

  private move(w: Wolf, dt: number): boolean {
    w.pos.x += Math.sin(w.heading) * w.speed * dt;
    w.pos.z += Math.cos(w.heading) * w.speed * dt;
    return this.world.grid.collideCircle(w.pos, CONFIG.wolf.radius);
  }

  private separate(): void {
    const wolves = this.world.wolves;
    const r = CONFIG.wolf.radius * 2;
    for (let a = 0; a < wolves.length; a++) {
      for (let b = a + 1; b < wolves.length; b++) {
        const p = wolves[a].pos;
        const q = wolves[b].pos;
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
    for (const w of wolves) this.world.grid.collideCircle(w.pos, CONFIG.wolf.radius);
  }
}
