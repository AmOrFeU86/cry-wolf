// Conejos salvajes: solo decorado. Viven en el renderer (no en la simulación), así que no cambian
// las partidas ni las repeticiones. Saltan por el prado, comen, se sientan a mirar y huyen
// a saltos si la oveja o un lobo se acercan.
import * as THREE from 'three';
import { Cell, type Grid } from '../sim/Grid';
import type { World } from '../sim/World';
import { createRabbit, type RabbitModel } from './models';

const COUNT = 12;
/** Distancia a la que se asustan. */
const SHEEP_FEAR = 3.5;
const WOLF_FEAR = 7;

type Action = 'graze' | 'sit' | 'look';

interface Rabbit {
  model: RabbitModel;
  x: number;
  z: number;
  heading: number;
  /** Destino del paseo o de la huida. */
  tx: number;
  tz: number;
  moving: boolean;
  fleeing: boolean;
  /** Salto en curso: origen, destino y progreso 0..1 (t < 0: pausa entre saltos). */
  hx: number;
  hz: number;
  ex: number;
  ez: number;
  t: number;
  action: Action;
  timer: number;
  earVel: number;
  ear: number;
  phase: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const damp = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class Rabbits {
  readonly group = new THREE.Group();
  private list: Rabbit[] = [];
  private grid: Grid | null = null;

  reset(world: World): void {
    this.group.clear();
    this.list = [];
    this.grid = world.grid;
    const g = world.grid;
    for (let k = 0; k < COUNT; k++) {
      // celda libre, lejos de donde empieza la oveja
      let x = 0;
      let z = 0;
      for (let tries = 0; tries < 50; tries++) {
        x = rand(-g.half + 3, g.half - 3);
        z = rand(-g.half + 3, g.half - 3);
        if (this.free(x, z) && Math.hypot(x - world.sheep.pos.x, z - world.sheep.pos.z) > 8) break;
      }
      const model = createRabbit();
      this.group.add(model.root);
      this.list.push({
        model, x, z, heading: rand(0, Math.PI * 2), tx: x, tz: z, moving: false, fleeing: false,
        hx: x, hz: z, ex: x, ez: z, t: 1, action: 'graze', timer: rand(0.5, 4), earVel: 0, ear: 0, phase: rand(0, 10),
      });
    }
  }

  private free(x: number, z: number): boolean {
    const g = this.grid!;
    const [i, j] = g.toCell(x, z);
    return g.inBounds(i, j) && g.get(i, j) === Cell.Empty;
  }

  /** ¿Se puede ir en línea recta? */
  private clear(x0: number, z0: number, x1: number, z1: number): boolean {
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.4);
    for (let k = 1; k <= n; k++) if (!this.free(x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n)) return false;
    return true;
  }

  /** Elige destino: en una dirección (huida) o al azar cerca (paseo). */
  private pickTarget(r: Rabbit, awayX = 0, awayZ = 0): boolean {
    const flee = awayX !== 0 || awayZ !== 0;
    const base = Math.atan2(awayX, awayZ);
    for (let k = 0; k < 10; k++) {
      const a = flee ? base + rand(-0.9, 0.9) * (1 + k * 0.15) : rand(0, Math.PI * 2);
      const d = flee ? rand(5, 8) : rand(1.5, 4.5);
      const tx = r.x + Math.sin(a) * d;
      const tz = r.z + Math.cos(a) * d;
      if (this.free(tx, tz) && this.clear(r.x, r.z, tx, tz)) {
        r.tx = tx;
        r.tz = tz;
        r.moving = true;
        return true;
      }
    }
    return false;
  }

  update(world: World, dt: number, camPos: THREE.Vector3): void {
    if (!this.grid || dt <= 0) return;
    const s = world.sheep.pos;
    for (const r of this.list) {
      // ¿alguien cerca? huye en dirección contraria
      let ax = 0;
      let az = 0;
      const ds = Math.hypot(r.x - s.x, r.z - s.z);
      if (ds < SHEEP_FEAR && world.state !== 'lost') {
        ax += (r.x - s.x) / (ds + 0.01);
        az += (r.z - s.z) / (ds + 0.01);
      }
      for (const w of world.wolves) {
        const dw = Math.hypot(r.x - w.pos.x, r.z - w.pos.z);
        if (dw < WOLF_FEAR) {
          ax += ((r.x - w.pos.x) / (dw + 0.01)) * 2;
          az += ((r.z - w.pos.z) / (dw + 0.01)) * 2;
        }
      }
      if ((ax || az) && !r.fleeing && this.pickTarget(r, ax, az)) {
        r.fleeing = true;
        r.earVel += 12; // orejas tiesas del susto
      }

      if (r.moving) this.hop(r, dt);
      else {
        r.timer -= dt;
        if (r.timer <= 0) {
          // nuevo plan: pasear o quedarse haciendo algo
          if (Math.random() < 0.55) this.pickTarget(r);
          r.action = Math.random() < 0.5 ? 'graze' : Math.random() < 0.5 ? 'sit' : 'look';
          r.timer = rand(1.5, 5);
        }
      }
      // los lejanos no hace falta animarlos con detalle: solo se colocan
      const far = Math.hypot(r.x - camPos.x, r.z - camPos.z) > 45;
      this.pose(r, dt, far);
    }
  }

  private hop(r: Rabbit, dt: number): void {
    const dur = r.fleeing ? 0.22 : 0.3;
    if (r.t >= 1) {
      // empieza el siguiente salto (con una pausita al pasear)
      const dx = r.tx - r.x;
      const dz = r.tz - r.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.15) {
        r.moving = false;
        r.fleeing = false;
        r.timer = rand(0.8, 3);
        r.action = Math.random() < 0.6 ? 'graze' : 'look';
        return;
      }
      const len = Math.min(d, r.fleeing ? 1.1 : 0.55);
      const ex = r.x + (dx / d) * len;
      const ez = r.z + (dz / d) * len;
      if (!this.free(ex, ez)) {
        // le han construido algo delante: cambia de idea
        r.moving = false;
        r.fleeing = false;
        r.timer = 0.3;
        return;
      }
      r.hx = r.x;
      r.hz = r.z;
      r.ex = ex;
      r.ez = ez;
      r.t = r.fleeing ? 0 : -rand(0.05, 0.25);
    }
    r.t = Math.min(1, r.t + dt / dur);
    const k = Math.max(0, r.t);
    r.x = r.hx + (r.ex - r.hx) * k;
    r.z = r.hz + (r.ez - r.hz) * k;
    if (r.t > 0) r.heading = r.heading + wrapAngle(Math.atan2(r.ex - r.hx, r.ez - r.hz) - r.heading) * Math.min(1, dt * 18);
  }

  private pose(r: Rabbit, dt: number, far: boolean): void {
    const m = r.model;
    r.phase += dt;
    const air = r.moving && r.t > 0 ? r.t : -1;
    const jump = air >= 0 ? Math.sin(air * Math.PI) : 0;
    m.root.position.set(r.x, jump * (r.fleeing ? 0.32 : 0.18), r.z);
    m.root.rotation.y = r.heading;
    if (far) return;

    // en el aire: estirado y con el morro arriba al despegar, abajo al aterrizar
    const inAir = air >= 0;
    const sitting = !r.moving && r.action === 'sit';
    const grazing = !r.moving && r.action === 'graze';
    const pitch = inAir ? (air - 0.5) * 0.6 : sitting ? -0.45 : grazing ? 0.12 : 0;
    m.body.rotation.x = damp(m.body.rotation.x, pitch, 14, dt);
    const stretch = inAir ? 1 + jump * 0.18 : 1;
    m.body.scale.set(1, 1 / Math.sqrt(stretch), stretch);

    // cabeza: mordisquea, mira a los lados o va al frente
    let hx = 0;
    let hy = 0;
    if (grazing) hx = 0.55 + Math.sin(r.phase * 9) * 0.06;
    else if (!r.moving && r.action === 'look') hy = Math.sin(r.phase * 0.9) * 0.8;
    else if (sitting) hy = Math.sin(r.phase * 0.6) * 0.4;
    m.head.rotation.x = damp(m.head.rotation.x, hx, 10, dt);
    m.head.rotation.y = damp(m.head.rotation.y, hy, 6, dt);
    m.nose.scale.y = 0.018 * (1 + Math.max(0, Math.sin(r.phase * 14)) * 0.3); // nariz que se mueve

    // orejas con muelle: se echan atrás al correr y tiemblan al aterrizar
    const earTarget = r.fleeing ? -0.7 : inAir ? -0.25 : grazing ? -0.15 : 0.05;
    r.earVel += ((earTarget - r.ear) * 160 - r.earVel * 9) * dt;
    r.ear += r.earVel * dt;
    m.ears[0].rotation.x = m.ears[1].rotation.x = r.ear;
    m.ears[0].rotation.z = 0.15 + Math.sin(r.phase * 1.3) * 0.04;
    m.ears[1].rotation.z = -0.15 - Math.sin(r.phase * 1.1 + 1) * 0.04;
    m.tail.scale.setScalar(0.06 * (1 + Math.max(0, Math.sin(r.phase * 7)) * (r.moving ? 0.25 : 0.05)));
  }
}
