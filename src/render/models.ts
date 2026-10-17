// Modelos low-poly generados por código. Todos miran hacia +Z.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const lambert = (color: number) => new THREE.MeshLambertMaterial({ color, flatShading: true });

export const MATS = {
  wool: lambert(0xf4f0e6),
  skin: lambert(0x3b3431),
  eyeWhite: lambert(0xffffff),
  pupil: lambert(0x111111),
  wolf: lambert(0x6f747d),
  wolfLight: lambert(0xb9bdc4),
  wolfDark: lambert(0x3c4048),
  // MeshBasic: los ojos brillan aunque no haya luz (para las noches del futuro)
  wolfEye: new THREE.MeshBasicMaterial({ color: 0xffcf3a }),
  wood: lambert(0xa8743f),
  woodDark: lambert(0x6e4a2a),
  trunk: lambert(0x8a5a38),
  tinted: lambert(0xffffff), // color por instancia
  grass: lambert(0x74b04a),
  grassLight: lambert(0xa6d468),
  flower: lambert(0xffe27a),
  hedge: lambert(0x3f8a34),
  hedgeLight: lambert(0x58a845),
  stone: lambert(0xa69d90),
  stoneDark: lambert(0x7f766b),
  iron: lambert(0x3a3a3e),
};

/** Copia una geometría aplicando transformación (y la des-indexa para poder fusionarla). */
function place(
  geo: THREE.BufferGeometry,
  x = 0, y = 0, z = 0,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = sx, sz = sx,
): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.applyMatrix4(
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(sx, sy, sz),
    ),
  );
  return g;
}

const merge = (geos: THREE.BufferGeometry[]) => {
  const m = mergeGeometries(geos);
  if (!m) throw new Error('mergeGeometries falló');
  m.computeVertexNormals();
  return m;
};

const shadowed = <T extends THREE.Object3D>(o: T): T => {
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  return o;
};

const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material) => new THREE.Mesh(geo, mat);

export interface AnimParams {
  speed: number;
  eating?: boolean;
  attacking?: boolean;
  pose?: 'chase' | 'windup' | 'pounce' | 'recover';
  /** Oveja aturdida. */
  stunned?: boolean;
  /** Oveja sin aguante: jadea. */
  tired?: boolean;
  /** Lobo: wander, hunt, track... (cambia cómo lleva la cabeza, las orejas y la cola). */
  mode?: string;
}

export interface AnimatedModel {
  root: THREE.Group;
  update(dt: number, p: AnimParams): void;
}

// ------------------------------------------------------------------ animación procedural
// Patas de dos segmentos movidas por un ciclo de paso (paso / trote / galope mezclados según la velocidad),
// muelles para lo que va con retraso (orejas, cola, lana) y pequeños comportamientos en reposo.

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Acerca `cur` a `target` de forma exponencial, igual a cualquier framerate. */
const damp = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Muelle amortiguado: sigue a su objetivo con retraso y rebote. */
class Spring {
  vel = 0;
  constructor(private k: number, private damping: number, public v = 0) {}
  step(target: number, dt: number): number {
    this.vel += ((target - this.v) * this.k - this.vel * this.damping) * dt;
    this.v += this.vel * dt;
    return this.v;
  }
}

interface Gait {
  /** Desfase de cada pata en el ciclo: [delantera izq, delantera der, trasera izq, trasera der]. */
  offsets: readonly number[];
  /** Fracción del ciclo con la pata apoyada. */
  duty: number;
  /** Cuánto dobla la rodilla al levantar la pata. */
  lift: number;
}

const WALK: Gait = { offsets: [0.25, 0.75, 0, 0.5], duty: 0.62, lift: 0.75 };
const TROT: Gait = { offsets: [0, 0.5, 0.5, 0], duty: 0.42, lift: 1.1 };
const GALLOP: Gait = { offsets: [0.55, 0.65, 0, 0.1], duty: 0.32, lift: 1.35 };
const GAITS = [WALK, TROT, GALLOP];

interface GaitConfig {
  /** Largo de la pata en unidades del modelo. */
  legLen: number;
  /** Velocidades (en el mundo) a las que pasa de paso a trote y de trote a galope. */
  trotAt: number;
  gallopAt: number;
  /** Ciclos por segundo de cada aire en función de la velocidad. */
  freq: readonly ((v: number) => number)[];
  /** Exageración del bote y el cabeceo. */
  bounce: number;
}

interface GaitFrame {
  hips: number[];
  knees: number[];
  bob: number; // altura extra del cuerpo
  pitch: number;
  roll: number;
  stretch: number; // >0 estirado (en el aire), <0 encogido
  intensity: number; // 0 parado, 1 moviéndose
}

/** Ciclo de paso compartido por las cuatro patas. */
class Gaiter {
  phase = Math.random();
  private out: GaitFrame = { hips: [0, 0, 0, 0], knees: [0, 0, 0, 0], bob: 0, pitch: 0, roll: 0, stretch: 0, intensity: 0 };
  constructor(private cfg: GaitConfig) {}

  /** `speed` en unidades del mundo por segundo; `scale` es la escala del modelo en el mundo. */
  step(dt: number, speed: number, scale: number): GaitFrame {
    const { cfg, out } = this;
    const sg = smooth(cfg.gallopAt - 0.7, cfg.gallopAt + 0.7, speed);
    const st = smooth(cfg.trotAt - 0.6, cfg.trotAt + 0.6, speed);
    const weights = [1 - st, Math.max(0, st - sg), sg];
    let freq = 0;
    for (let g = 0; g < 3; g++) freq += weights[g] * cfg.freq[g](speed);
    this.phase = (this.phase + dt * freq) % 1;
    const p = this.phase;
    const L = cfg.legLen * scale;
    const k = smooth(0.05, 1.2, speed);
    out.intensity = k;
    out.hips.fill(0);
    out.knees.fill(0);
    for (let g = 0; g < 3; g++) {
      const w = weights[g];
      if (w < 1e-3) continue;
      const gait = GAITS[g];
      // amplitud para que la pata apoyada avance a la velocidad del cuerpo (sin patinar)
      const amp = Math.min(0.8, (speed * gait.duty) / (2 * L * Math.max(0.5, freq)));
      for (let i = 0; i < 4; i++) {
        const lp = (p + gait.offsets[i]) % 1;
        let hip: number;
        let knee = 0;
        if (lp < gait.duty) {
          hip = lerp(-amp, amp, lp / gait.duty); // apoyada: barre hacia atrás
        } else {
          const s = (lp - gait.duty) / (1 - gait.duty);
          hip = lerp(amp, -amp, s * s * (3 - 2 * s)); // en el aire: vuelve adelante
          knee = Math.sin(s * Math.PI) * gait.lift * k;
          if (i >= 2) hip -= Math.sin(s * Math.PI) * 0.25 * k; // la trasera recoge el muslo
        }
        out.hips[i] += hip * w;
        out.knees[i] += knee * w;
      }
    }
    const b = cfg.bounce * k * cfg.legLen;
    out.bob =
      b *
      (weights[0] * 0.03 * (1 - Math.cos(2 * TAU * p)) * 0.5 +
        weights[1] * 0.1 * (1 - Math.cos(2 * TAU * (p - 0.21))) * 0.5 +
        weights[2] * 0.2 * (1 + Math.cos(TAU * (p - 0.83))) * 0.5);
    out.pitch = cfg.bounce * k * (weights[0] * 0.015 * Math.sin(2 * TAU * p) - weights[2] * 0.09 * Math.cos(TAU * (p - 0.2)));
    out.roll = k * (weights[0] * 0.05 + weights[1] * 0.03) * Math.sin(TAU * p);
    out.stretch = cfg.bounce * k * (weights[2] * 0.07 * Math.cos(TAU * (p - 0.83)) - weights[1] * 0.03 * Math.cos(2 * TAU * (p - 0.21)));
    return out;
  }
}

/** Pata de dos segmentos: cadera → muslo → rodilla → caña. */
function createLeg(
  parent: THREE.Object3D,
  x: number, y: number, z: number,
  upper: THREE.BufferGeometry, upperMat: THREE.Material, upperLen: number,
  lower: THREE.BufferGeometry, lowerMat: THREE.Material,
  foot?: THREE.Mesh,
) {
  const hip = new THREE.Group();
  hip.position.set(x, y, z);
  hip.add(mesh(upper, upperMat));
  const knee = new THREE.Group();
  knee.position.y = -upperLen;
  knee.add(mesh(lower, lowerMat));
  if (foot) knee.add(foot);
  hip.add(knee);
  parent.add(hip);
  return { hip, knee };
}

/** Parpadeo cada pocos segundos (escala en Y del grupo de los ojos). */
function blinker() {
  let next = rand(1, 4);
  let t = 0;
  return (dt: number, eyes: THREE.Object3D, closed = false) => {
    t += dt;
    if (t > next) {
      t = 0;
      next = Math.random() < 0.2 ? 0.25 : rand(2, 5); // a veces doble parpadeo
    }
    const open = closed ? 0.15 : t < 0.12 ? Math.abs(t / 0.06 - 1) : 1;
    eyes.scale.y = Math.max(0.1, open);
  };
}

/** Velocidad de giro y aceleración a partir de lo que cambia entre frames. */
function motionTracker() {
  let prevYaw: number | null = null;
  let prevSpeed = 0;
  const st = { yawRate: 0, accel: 0 };
  return (dt: number, yaw: number, speed: number) => {
    const rawYaw = prevYaw === null ? 0 : wrapAngle(yaw - prevYaw) / dt;
    const rawAcc = (speed - prevSpeed) / dt;
    prevYaw = yaw;
    prevSpeed = speed;
    st.yawRate = damp(st.yawRate, clamp(rawYaw, -12, 12), 10, dt);
    st.accel = damp(st.accel, clamp(rawAcc, -80, 80), 8, dt);
    return { ...st, rawAcc };
  };
}

// ------------------------------------------------------------------ oveja

const ICO = new THREE.IcosahedronGeometry(1, 0);
const BOX = new THREE.BoxGeometry(1, 1, 1);

const SHEEP_WOOL_BASE = 0.5; // la lana se aplasta/estira desde aquí
const sheepWoolGeo = (() => {
  const puffs: [number, number, number, number][] = [
    [0, 0.78, 0, 0.42],
    [0.2, 0.84, 0.24, 0.3],
    [-0.2, 0.84, 0.24, 0.3],
    [0.22, 0.82, -0.22, 0.3],
    [-0.22, 0.82, -0.22, 0.3],
    [0, 1.02, 0.08, 0.3],
    [0, 1.0, -0.2, 0.28],
    [0.27, 0.66, 0.02, 0.28],
    [-0.27, 0.66, 0.02, 0.28],
    [0, 0.76, 0.38, 0.27],
    [0, 0.78, -0.42, 0.27],
  ];
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * Math.PI;
  return merge(puffs.map(([x, y, z, s]) => place(ICO, x, y - SHEEP_WOOL_BASE, z, rnd(), rnd(), rnd(), s, s * 0.92, s)));
})();

const sheepHeadGeo = merge([
  place(BOX, 0, 0, 0.12, 0, 0, 0, 0.3, 0.32, 0.36),
  place(BOX, 0, -0.07, 0.31, 0, 0, 0, 0.24, 0.2, 0.14),
]);
const sheepEarGeo = place(BOX, 0.09, 0, 0, 0, 0, 0, 0.2, 0.06, 0.11);
// los ojos se modelan alrededor de y=0 para que el parpadeo los cierre sobre su centro
const sheepEyeGeo = merge([
  place(BOX, 0.085, 0, 0.305, 0, 0, 0, 0.08, 0.09, 0.02),
  place(BOX, -0.085, 0, 0.305, 0, 0, 0, 0.08, 0.09, 0.02),
]);
const sheepPupilGeo = merge([
  place(BOX, 0.085, -0.01, 0.318, 0, 0, 0, 0.045, 0.055, 0.02),
  place(BOX, -0.085, -0.01, 0.318, 0, 0, 0, 0.045, 0.055, 0.02),
]);
const SHEEP_HIP = 0.56;
const SHEEP_UPPER = 0.27;
const sheepUpperGeo = place(BOX, 0, -SHEEP_UPPER / 2 + 0.02, 0, 0, 0, 0, 0.13, SHEEP_UPPER + 0.04, 0.13);
const sheepLowerGeo = place(BOX, 0, -0.13, 0, 0, 0, 0, 0.1, 0.27, 0.1);
const sheepHoofGeo = place(BOX, 0, -0.27, 0.01, 0, 0, 0, 0.12, 0.05, 0.13);

const SHEEP_GAIT: GaitConfig = {
  legLen: 0.55,
  trotAt: 2.4,
  gallopAt: 6.6,
  freq: [(v) => 1.0 + v * 0.5, (v) => 1.7 + v * 0.38, (v) => 1.9 + v * 0.3],
  bounce: 1.1,
};

export function createSheep(): AnimatedModel {
  const root = new THREE.Group();
  // body pivota a la altura de la cadera; torso devuelve todo a coordenadas del modelo
  const body = new THREE.Group();
  body.position.y = SHEEP_HIP;
  root.add(body);
  const torso = new THREE.Group();
  torso.position.y = -SHEEP_HIP;
  body.add(torso);

  const wool = new THREE.Group();
  wool.position.y = SHEEP_WOOL_BASE;
  wool.add(mesh(sheepWoolGeo, MATS.wool));
  torso.add(wool);

  const tail = mesh(ICO, MATS.wool);
  tail.scale.setScalar(0.13);
  tail.position.set(0, 0.38, -0.6);
  wool.add(tail);

  const neck = new THREE.Group(); // gira la cabeza a los lados
  neck.position.set(0, 0.92, 0.46);
  torso.add(neck);
  const head = new THREE.Group();
  head.position.z = 0.04;
  neck.add(head);
  head.add(mesh(sheepHeadGeo, MATS.skin));
  const eyes = new THREE.Group();
  eyes.position.y = 0.06;
  eyes.add(mesh(sheepEyeGeo, MATS.eyeWhite), mesh(sheepPupilGeo, MATS.pupil));
  head.add(eyes);
  const tuft = mesh(ICO, MATS.wool);
  tuft.scale.set(0.17, 0.12, 0.17);
  tuft.position.set(0, 0.17, 0.06);
  head.add(tuft);
  const ears = [1, -1].map((s) => {
    const ear = new THREE.Group();
    ear.position.set(s * 0.12, 0.07, 0.04);
    const m = mesh(sheepEarGeo, MATS.skin);
    m.scale.x = s;
    ear.add(m);
    head.add(ear);
    return ear;
  });

  const legs = [
    [0.17, 0.22],
    [-0.17, 0.22],
    [0.17, -0.22],
    [-0.17, -0.22],
  ].map(([x, z]) => createLeg(torso, x, SHEEP_HIP, z, sheepUpperGeo, MATS.skin, SHEEP_UPPER, sheepLowerGeo, MATS.skin, mesh(sheepHoofGeo, MATS.pupil)));

  const gaiter = new Gaiter(SHEEP_GAIT);
  const motion = motionTracker();
  const blink = blinker();
  const woolSpring = new Spring(260, 9); // la lana sigue al cuerpo con retraso
  const stretch = new Spring(180, 10);
  const earSprings = [new Spring(150, 6), new Spring(150, 6)];
  const tailSpring = new Spring(200, 7);
  const lean = new Spring(90, 14);
  let t = Math.random() * 10;
  let prevBob = 0;
  let idle = 0;
  let lookTimer = 1;
  let lookYaw = 0;
  let lookPitch = 0;
  let shake = 0; // >0 sacudiéndose
  let earFlick = rand(1, 4);
  let roll = 0;
  let headX = 0;
  let neckDrop = 0;

  return {
    root: shadowed(root),
    update(dt, { speed, eating, stunned, tired }) {
      if (dt <= 0) return;
      t += dt;
      const m = motion(dt, root.rotation.y, speed);
      // girando sobre sí misma también mueve las patas
      const eff = speed + Math.min(Math.abs(m.yawRate), 6) * 0.25;
      const g = gaiter.step(dt, eff, root.scale.x);

      // susto: arrancón brusco (esquive o salir corriendo) → se estira de golpe
      if (m.rawAcc > 45) stretch.vel += 2.5;
      stretch.step(0, dt);

      const moving = g.intensity > 0.1;
      idle = moving || eating ? 0 : idle + dt;

      // en reposo mira a los lados y de vez en cuando se sacude
      lookTimer -= dt;
      if (lookTimer <= 0) {
        lookTimer = rand(1.2, 3.5);
        const calm = idle > 0.8;
        lookYaw = calm ? rand(-0.75, 0.75) : 0;
        lookPitch = calm ? rand(-0.25, 0.15) : 0;
        if (calm && shake <= 0 && Math.random() < 0.18) shake = 0.7;
      }
      if (moving || eating) shake = 0;
      shake = Math.max(0, shake - dt);
      const shakeEnv = shake > 0 ? Math.sin((shake / 0.7) * Math.PI) : 0;

      // cuerpo: bote, cabeceo, inclinación al girar y al acelerar
      const bob = g.bob;
      const bobVel = (bob - prevBob) / dt;
      prevBob = bob;
      body.position.y = SHEEP_HIP + bob;
      const accelLean = lean.step(clamp(m.accel * 0.012, -0.18, 0.18), dt);
      body.rotation.x = g.pitch + accelLean;
      roll = damp(roll, clamp(-m.yawRate * speed * 0.03, -0.3, 0.3), 8, dt);
      const dizzy = stunned ? Math.sin(t * 5) * 0.12 : 0;
      body.rotation.z = roll + g.roll + shakeEnv * Math.sin(t * 45) * 0.22 + dizzy;
      body.rotation.y = dizzy * 0.5;

      // lana: aplasta al caer, estira en el aire; respira (más rápido si está agotada)
      const lag = woolSpring.step(bob, dt) - bob;
      const breath = tired ? Math.sin(t * 11) * 0.04 : Math.sin(t * 2.2) * 0.015;
      const sy = 1 + clamp(-lag * 1.8 + g.stretch * 0.3, -0.13, 0.13) + breath - stretch.v * 0.5;
      const sz = 1 + g.stretch + stretch.v;
      wool.scale.set(1 / Math.sqrt(sy * sz) + shakeEnv * 0.05, sy, sz);

      // patas
      for (let i = 0; i < 4; i++) {
        const wobble = stunned ? Math.sin(t * 7 + i * 1.7) * 0.15 : 0;
        legs[i].hip.rotation.x = g.hips[i] + wobble - accelLean * 0.6;
        legs[i].knee.rotation.x = g.knees[i];
        legs[i].hip.rotation.z = stunned ? (i % 2 ? -0.12 : 0.12) : 0; // patas abiertas
      }

      // cabeza
      let hx: number;
      let hy = clamp(m.yawRate * 0.12, -0.5, 0.5);
      let hz = 0;
      if (eating) {
        hx = 0.95 + Math.max(0, Math.sin(t * 12)) * 0.12; // mordisquea
        hy = Math.sin(t * 1.3) * 0.15;
      } else if (stunned) {
        hx = 0.15 + Math.sin(t * 6) * 0.2;
        hy = Math.cos(t * 6) * 0.35;
        hz = Math.sin(t * 6) * 0.25;
      } else {
        hx = -0.05 * g.intensity - g.pitch * 0.7 - accelLean * 0.8 + (moving ? 0 : lookPitch) + (tired ? 0.25 : 0);
        if (!moving) hy += lookYaw;
      }
      headX = damp(headX, hx, eating ? 10 : 7, dt);
      neckDrop = damp(neckDrop, eating ? 1 : 0, 6, dt);
      neck.position.set(0, 0.92 - neckDrop * 0.22, 0.46 + neckDrop * 0.08);
      head.rotation.x = headX + (tired ? Math.sin(t * 11) * 0.04 : 0);
      neck.rotation.y = damp(neck.rotation.y, hy, 6, dt);
      head.rotation.z = damp(head.rotation.z, hz + shakeEnv * Math.sin(t * 45 + 1) * 0.4, 12, dt);
      blink(dt, eyes, stunned && Math.sin(t * 3) > 0.6);

      // orejas: caídas comiendo o cansada, se mueven con el bote y a veces dan un respingo
      earFlick -= dt;
      if (earFlick <= 0) {
        earFlick = rand(1.5, 5);
        earSprings[Math.random() < 0.5 ? 0 : 1].vel += rand(6, 10);
      }
      const droop = eating || tired ? 0.9 : stunned ? 0.7 : 0.4 + g.intensity * 0.15;
      for (let s = 0; s < 2; s++) {
        const e = earSprings[s].step(droop - bobVel * 0.25 + accelLean, dt);
        ears[s].rotation.z = (s === 0 ? -1 : 1) * e;
        ears[s].rotation.y = (s === 0 ? -1 : 1) * 0.2;
      }

      // rabito: menea rápido contenta comiendo, con el bote al correr
      const wag = eating ? Math.sin(t * 18) * 0.09 : Math.sin(t * 7) * 0.02;
      tail.position.x = tailSpring.step(wag - m.yawRate * 0.02, dt);
      tail.position.y = 0.38 + clamp(-bobVel * 0.03, -0.06, 0.06);
    },
  };
}

// ------------------------------------------------------------------ lobo

const wolfBodyGeo = merge([
  place(BOX, 0, 0.86, -0.12, 0, 0, 0, 0.5, 0.46, 1.0),
  place(BOX, 0, 0.92, 0.36, 0, 0, 0, 0.6, 0.6, 0.5),
]);
const wolfBellyGeo = merge([
  place(BOX, 0, 0.78, 0.5, 0, 0, 0, 0.44, 0.4, 0.3),
  place(BOX, 0, 0.66, -0.1, 0, 0, 0, 0.42, 0.1, 0.8),
]);
const wolfHeadGeo = place(BOX, 0, 0, 0.05, 0, 0, 0, 0.42, 0.38, 0.4);
const wolfEarGeo = place(new THREE.ConeGeometry(0.09, 0.24, 4), 0, 0.12, 0, 0, Math.PI / 4, 0);
const wolfSnoutGeo = place(BOX, 0, -0.04, 0.36, 0, 0, 0, 0.22, 0.12, 0.32);
const wolfNoseGeo = place(BOX, 0, 0.0, 0.53, 0, 0, 0, 0.09, 0.07, 0.05);
const wolfJawGeo = place(BOX, 0, -0.03, 0.15, 0, 0, 0, 0.19, 0.06, 0.3);
const wolfTongueGeo = merge([
  place(BOX, 0.03, 0.01, 0.2, 0, 0, 0, 0.09, 0.02, 0.2),
  place(BOX, 0.03, -0.05, 0.31, 0.5, 0, 0, 0.09, 0.02, 0.12), // cuelga por fuera
]);
const wolfEyeGeo = merge([
  place(BOX, 0.12, 0, 0.255, 0, 0, 0, 0.09, 0.05, 0.02),
  place(BOX, -0.12, 0, 0.255, 0, 0, 0, 0.09, 0.05, 0.02),
]);
const WOLF_HIP = 0.64;
const WOLF_UPPER = 0.32;
const wolfUpperGeo = place(BOX, 0, -WOLF_UPPER / 2 + 0.03, 0, 0, 0, 0, 0.16, WOLF_UPPER + 0.06, 0.17);
const wolfLowerGeo = place(BOX, 0, -0.14, 0, 0, 0, 0, 0.12, 0.3, 0.12);
const wolfPawGeo = place(BOX, 0, -0.29, 0.03, 0, 0, 0, 0.15, 0.06, 0.19);
const wolfTailGeoA = place(BOX, 0, 0, -0.17, 0, 0, 0, 0.15, 0.15, 0.36);
const wolfTailGeoB = merge([
  place(BOX, 0, 0, -0.15, 0, 0, 0, 0.13, 0.13, 0.3),
  place(BOX, 0, 0, -0.33, 0, 0, 0, 0.1, 0.1, 0.1),
]);
const wolfTongueMat = lambert(0xd9586a);

const WOLF_GAIT: GaitConfig = {
  legLen: 0.62,
  trotAt: 2.6,
  gallopAt: 5.0,
  freq: [(v) => 0.75 + v * 0.35, (v) => 1.15 + v * 0.3, (v) => 1.35 + v * 0.24],
  bounce: 1,
};

/** Poses fijas de las patas (cadera, rodilla) para el ataque: [delanteras, traseras]. */
const WOLF_POSES = {
  windup: { hipF: -0.75, kneeF: 1.15, hipB: 0.15, kneeB: 0.95, y: -0.2, rx: 0.1 },
  pounce: { hipF: -1.25, kneeF: 0.2, hipB: 1.15, kneeB: 0.1, y: 0.3, rx: -0.15 },
};

export function createWolf(): AnimatedModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = WOLF_HIP;
  root.add(body);
  const torso = new THREE.Group();
  torso.position.y = -WOLF_HIP;
  body.add(torso);
  // el pecho se mueve un poco por su cuenta (respira, se estira al galopar)
  const chest = new THREE.Group();
  chest.add(mesh(wolfBodyGeo, MATS.wolf), mesh(wolfBellyGeo, MATS.wolfLight));
  torso.add(chest);

  const neck = new THREE.Group();
  neck.position.set(0, 1.08, 0.58);
  torso.add(neck);
  const head = new THREE.Group();
  head.position.set(0, 0.04, 0.04);
  neck.add(head);
  head.add(mesh(wolfHeadGeo, MATS.wolf), mesh(wolfSnoutGeo, MATS.wolfLight), mesh(wolfNoseGeo, MATS.pupil));
  const eyes = new THREE.Group();
  eyes.position.y = 0.06;
  eyes.add(mesh(wolfEyeGeo, MATS.wolfEye));
  head.add(eyes);
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.1, 0.22);
  jaw.add(mesh(wolfJawGeo, MATS.wolfLight));
  const tongue = mesh(wolfTongueGeo, wolfTongueMat);
  tongue.visible = false;
  jaw.add(tongue);
  head.add(jaw);
  const ears = [1, -1].map((s) => {
    const ear = new THREE.Group();
    ear.position.set(s * 0.13, 0.17, -0.04);
    ear.add(mesh(wolfEarGeo, MATS.wolf));
    head.add(ear);
    return ear;
  });

  const tailA = new THREE.Group();
  tailA.position.set(0, 0.98, -0.6);
  tailA.add(mesh(wolfTailGeoA, MATS.wolfDark));
  torso.add(tailA);
  const tailB = new THREE.Group();
  tailB.position.z = -0.34;
  tailB.add(mesh(wolfTailGeoB, MATS.wolfDark));
  tailA.add(tailB);

  const legs = [
    [0.17, 0.4],
    [-0.17, 0.4],
    [0.16, -0.45],
    [-0.16, -0.45],
  ].map(([x, z]) => createLeg(torso, x, WOLF_HIP, z, wolfUpperGeo, MATS.wolf, WOLF_UPPER, wolfLowerGeo, MATS.wolfDark, mesh(wolfPawGeo, MATS.wolfDark)));

  const gaiter = new Gaiter(WOLF_GAIT);
  const motion = motionTracker();
  const blink = blinker();
  const lean = new Spring(80, 13);
  const earSprings = [new Spring(170, 8), new Spring(170, 8)];
  const tailPitch = [new Spring(120, 8), new Spring(90, 6)];
  const tailYaw = [new Spring(110, 7), new Spring(80, 5)];
  const landing = new Spring(160, 9); // sacudida al aterrizar del salto
  let t = Math.random() * 10;
  let prevBob = 0;
  let poseW = 0;
  let pose: keyof typeof WOLF_POSES = 'windup';
  let prevPose: AnimParams['pose'] = 'chase';
  let roll = 0;
  let headX = 0;
  let neckY = 0;
  let jawOpen = 0;
  let neckDrop = 0;
  let bodyY = 0;
  let bodyRx = 0;
  let lookTimer = 1;
  let lookYaw = 0;
  let sniffT = 0;
  let earFlick = rand(1, 4);

  return {
    root: shadowed(root),
    update(dt, { speed, attacking, pose: phase = 'chase', mode = 'hunt' }) {
      if (dt <= 0) return;
      t += dt;
      const m = motion(dt, root.rotation.y, speed);
      const eff = speed + Math.min(Math.abs(m.yawRate), 6) * 0.3;
      const g = gaiter.step(dt, eff, root.scale.x);
      const moving = g.intensity > 0.1;
      const hunting = mode === 'hunt';
      const sniffing = (mode === 'track' || mode === 'search' || mode === 'investigate') && !attacking;
      const recovering = phase === 'recover';

      if (prevPose === 'pounce' && phase !== 'pounce') landing.vel -= 3;
      prevPose = phase;
      landing.step(0, dt);

      // mezcla entre el ciclo de paso y las poses de ataque
      const posed = phase === 'windup' || phase === 'pounce';
      if (posed) pose = phase;
      poseW = damp(poseW, posed ? 1 : 0, phase === 'pounce' ? 25 : 14, dt);
      const P = WOLF_POSES[pose];
      const tremble = phase === 'windup' ? Math.sin(t * 60) * 0.025 : 0;

      // cuerpo
      const bob = g.bob;
      const bobVel = (bob - prevBob) / dt;
      prevBob = bob;
      const accelLean = lean.step(clamp(m.accel * 0.01, -0.15, 0.15), dt);
      const crouchHunt = hunting && !moving ? -0.05 : 0;
      bodyY = lerp(bob + crouchHunt + landing.v * 0.1, P.y + tremble, poseW);
      bodyRx = lerp(g.pitch + accelLean, P.rx, poseW);
      body.position.y = WOLF_HIP + bodyY;
      body.rotation.x = bodyRx + landing.v * 0.08;
      roll = damp(roll, clamp(-m.yawRate * speed * 0.025, -0.3, 0.3), 8, dt);
      body.rotation.z = roll + g.roll * 0.7;
      const pant = recovering || (!moving && hunting) ? 1 : 0;
      const breath = pant ? Math.sin(t * 16) * 0.035 : Math.sin(t * 2) * 0.012;
      chest.scale.set(1 + breath, 1 + breath, 1 + g.stretch);

      // patas
      for (let i = 0; i < 4; i++) {
        const front = i < 2;
        const hipP = front ? P.hipF : P.hipB;
        const kneeP = front ? P.kneeF : P.kneeB;
        legs[i].hip.rotation.x = lerp(g.hips[i] - accelLean * 0.5, hipP, poseW);
        legs[i].knee.rotation.x = lerp(g.knees[i], kneeP, poseW);
        legs[i].hip.rotation.z = recovering ? (i % 2 ? -0.08 : 0.08) : 0;
      }

      // cabeza: en caza baja y adelantada; rastreando, el hocico al suelo olfateando
      lookTimer -= dt;
      if (lookTimer <= 0) {
        lookTimer = rand(1.5, 4);
        lookYaw = mode === 'wander' || mode === 'search' ? rand(-0.6, 0.6) : 0;
      }
      let hx: number;
      let neckDropTarget = recovering ? 0.5 : 0;
      if (attacking) hx = 0.35 + Math.max(0, Math.sin(t * 14)) * 0.3;
      else if (phase === 'windup') hx = 0.3;
      else if (phase === 'pounce') hx = -0.1;
      else if (recovering) hx = 0.45;
      else if (sniffing && speed < 5) {
        sniffT += dt;
        hx = 0.85 + Math.sin(sniffT * 22) * 0.05 * (Math.sin(sniffT * 2.3) > 0 ? 1 : 0);
        neckDropTarget = 1;
      } else if (hunting) hx = 0.22 + g.intensity * 0.05;
      else hx = 0.05 * g.intensity - 0.08;
      headX = damp(headX, hx - bodyRx * 0.7 - g.pitch * 0.3, 9, dt);
      head.rotation.x = headX;
      neckDrop = damp(neckDrop, neckDropTarget, 6, dt);
      neck.position.set(0, 1.08 - neckDrop * 0.3, 0.58 + neckDrop * 0.12);
      head.position.z = 0.04 + (attacking ? Math.max(0, Math.sin(t * 14)) * 0.12 : 0);
      neckY = damp(neckY, clamp(m.yawRate * 0.15, -0.5, 0.5) + (moving || hunting ? 0 : lookYaw), 6, dt);
      neck.rotation.y = neckY;
      head.rotation.z = attacking ? Math.sin(t * 20) * 0.15 : 0; // sacude al morder

      // boca: abierta jadeando, al saltar y mordiendo
      const jawTarget = attacking ? Math.max(0, -Math.sin(t * 14)) * 0.6
        : phase === 'pounce' ? 0.65
        : phase === 'windup' ? 0.15
        : pant || (hunting && speed > 4) ? 0.22 + Math.sin(t * 16) * 0.06
        : 0;
      jawOpen = damp(jawOpen, jawTarget, 20, dt);
      jaw.rotation.x = jawOpen;
      tongue.visible = jawOpen > 0.14 && !attacking && phase !== 'pounce';
      blink(dt, eyes, false);

      // orejas: adelante cazando, aplastadas al agacharse, se agitan con el galope
      earFlick -= dt;
      if (earFlick <= 0) {
        earFlick = rand(2, 6);
        if (!hunting) earSprings[Math.random() < 0.5 ? 0 : 1].vel -= rand(5, 9);
      }
      const earBase = phase === 'windup' || phase === 'pounce' ? -1.0 : recovering ? -0.35 : hunting ? 0.25 : sniffing ? 0.1 : 0;
      for (let s = 0; s < 2; s++) {
        const e = earSprings[s].step(earBase + bobVel * 0.15 - accelLean * 0.5, dt);
        ears[s].rotation.x = e;
        ears[s].rotation.z = (s === 0 ? -1 : 1) * (0.1 + Math.max(0, -e) * 0.3);
      }

      // cola en dos tramos (positivo = caída): el segundo sigue al primero con retraso
      const tailBase = phase === 'windup' ? 0.45
        : phase === 'pounce' ? -0.1
        : recovering ? 1.15
        : hunting ? 0.25 - g.intensity * 0.2
        : sniffing ? 0.2
        : 0.95 - g.intensity * 0.35;
      const wagSpeed = attacking || phase === 'windup' ? 18 : sniffing ? 9 : 4;
      const wagAmp = attacking || phase === 'windup' ? 0.35 : sniffing ? 0.3 : moving ? 0.08 : 0.15;
      const ta = tailPitch[0].step(tailBase + bobVel * 0.2 - g.pitch, dt);
      const tb = tailPitch[1].step(ta * 0.5 + bobVel * 0.25, dt);
      tailA.rotation.x = -ta;
      tailB.rotation.x = -(tb - ta * 0.3);
      const ya = tailYaw[0].step(Math.sin(t * wagSpeed) * wagAmp - m.yawRate * 0.08, dt);
      tailA.rotation.y = ya;
      tailB.rotation.y = tailYaw[1].step(ya * 0.8, dt) - ya * 0.3;
    },
  };
}

// ------------------------------------------------------------------ valla

const fenceGeos = (() => {
  const stake = new THREE.CylinderGeometry(0.07, 0.085, 1, 5);
  const tip = new THREE.ConeGeometry(0.085, 0.18, 5);
  const wood: THREE.BufferGeometry[] = [];
  const pts: [number, number, number][] = [
    [-0.4, -0.4, 0.95], [0, -0.4, 0.85], [0.4, -0.4, 1.0],
    [-0.4, 0, 0.88], [0.4, 0, 0.92],
    [-0.4, 0.4, 1.0], [0, 0.4, 0.9], [0.4, 0.4, 0.86],
  ];
  for (const [x, z, h] of pts) {
    wood.push(place(stake, x, h / 2, z, 0, 0, 0, 1, h, 1));
    wood.push(place(tip, x, h + 0.09, z));
  }
  const rails: THREE.BufferGeometry[] = [];
  for (const y of [0.3, 0.62]) {
    rails.push(place(BOX, 0, y, 0.4, 0, 0, 0, 0.92, 0.08, 0.07));
    rails.push(place(BOX, 0, y, -0.4, 0, 0, 0, 0.92, 0.08, 0.07));
    rails.push(place(BOX, 0.4, y, 0, 0, 0, 0, 0.07, 0.08, 0.92));
    rails.push(place(BOX, -0.4, y, 0, 0, 0, 0, 0.07, 0.08, 0.92));
  }
  // aspa diagonal para que se lea como barricada
  rails.push(place(BOX, 0, 0.47, 0, 0, Math.PI / 4, 0, 1.1, 0.07, 0.07));
  return { wood: merge(wood), rails: merge(rails) };
})();

export function createFence(woodMat: THREE.Material = MATS.wood, railMat: THREE.Material = MATS.woodDark): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(fenceGeos.wood, woodMat), mesh(fenceGeos.rails, railMat));
  return shadowed(g);
}

// ------------------------------------------------------------------ seto, muro y puerta
// Más altos que la valla y macizos: se lee a simple vista que tapan la vista.

const hedgeGeos = (() => {
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const dark: THREE.BufferGeometry[] = [place(BOX, 0, 0.6, 0, 0, 0, 0, 0.9, 1.2, 0.9)];
  const light: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 14; k++) {
    const x = (rnd() - 0.5) * 0.8;
    const z = (rnd() - 0.5) * 0.8;
    const y = 0.35 + rnd() * 1.0;
    const r = 0.22 + rnd() * 0.16;
    (k % 2 ? dark : light).push(place(ICO, x, y, z, rnd() * 3, rnd() * 3, 0, r));
  }
  return { dark: merge(dark), light: merge(light) };
})();

const wallGeos = (() => {
  let seed = 5;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const a: THREE.BufferGeometry[] = [];
  const b: THREE.BufferGeometry[] = [];
  // hiladas de bloques al tresbolillo
  const rows: [number, number][][] = [
    [[-0.245, 0.47], [0.245, 0.47]], // [x, ancho]
    [[-0.37, 0.22], [0, 0.47], [0.37, 0.22]],
  ];
  for (let row = 0; row < 4; row++) {
    const y = 0.19 + row * 0.37;
    for (const [x, w] of rows[row % 2]) {
      const blk = place(BOX, x, y, 0, 0, (rnd() - 0.5) * 0.06, 0, w, 0.34, 0.96);
      (rnd() < 0.5 ? a : b).push(blk);
    }
  }
  // remate
  a.push(place(BOX, 0, 1.55, 0, 0, 0, 0, 1.0, 0.1, 1.0));
  return { a: merge(a), b: merge(b) };
})();

// Puerta de dos hojas: los postes y el travesaño quedan fijos; cada hoja gira sobre su bisagra (ver GATE_HINGE).
const GATE_HINGE = 0.38; // distancia del centro a cada bisagra
const gateGeos = (() => {
  // postes finos con remate y travesaño arriba: con la puerta abierta se ven las hojas, no un hueco
  const frame = merge([
    place(BOX, -0.45, 0.78, 0, 0, 0, 0, 0.14, 1.56, 0.14),
    place(BOX, 0.45, 0.78, 0, 0, 0, 0, 0.14, 1.56, 0.14),
    place(BOX, -0.45, 1.6, 0, 0, Math.PI / 4, 0, 0.17, 0.08, 0.17),
    place(BOX, 0.45, 1.6, 0, 0, Math.PI / 4, 0, 0.17, 0.08, 0.17),
    place(BOX, 0, 1.47, 0, 0, 0, 0, 1.06, 0.1, 0.12),
  ]);
  // una hoja con la bisagra en el origen, hacia +X (la otra es la misma girada media vuelta)
  const planks: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) planks.push(place(BOX, 0.065 + k * 0.12, 0.7, 0, 0, 0, 0, 0.11, 1.25, 0.08));
  planks.push(place(BOX, 0.19, 0.675, 0.055, 0, 0, -0.47, 0.07, 0.68, 0.03)); // travesaño en diagonal
  const iron = merge([
    place(BOX, 0.18, 0.35, 0.05, 0, 0, 0, 0.36, 0.07, 0.03),
    place(BOX, 0.18, 1.0, 0.05, 0, 0, 0, 0.36, 0.07, 0.03),
    place(BOX, 0.18, 0.35, -0.05, 0, 0, 0, 0.36, 0.07, 0.03),
    place(BOX, 0.18, 1.0, -0.05, 0, 0, 0, 0.36, 0.07, 0.03),
  ]);
  return { frame, planks: merge(planks), iron };
})();

const towerGeos = (() => {
  // base de piedra que se estrecha, plataforma de madera con barandilla y escalera
  const stone = merge([
    place(BOX, 0, 0.45, 0, 0, 0, 0, 0.96, 0.9, 0.96),
    place(BOX, 0, 1.3, 0, 0, 0.08, 0, 0.84, 0.8, 0.84),
    place(BOX, 0, 1.9, 0, 0, -0.05, 0, 0.74, 0.4, 0.74),
  ]);
  const deck = merge([place(BOX, 0, 2.15, 0, 0, 0, 0, 1.1, 0.1, 1.1)]);
  const rail: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) rail.push(place(BOX, x, 2.45, z, 0, 0, 0, 0.07, 0.5, 0.07));
  for (const s of [-1, 1]) {
    rail.push(place(BOX, 0, 2.62, s * 0.5, 0, 0, 0, 1.05, 0.06, 0.05));
    rail.push(place(BOX, s * 0.5, 2.62, 0, 0, 0, 0, 0.05, 0.06, 1.05));
  }
  // escalera en la cara +Z
  for (const x of [-0.18, 0.18]) rail.push(place(BOX, x, 1.05, 0.52, -0.06, 0, 0, 0.05, 2.1, 0.05));
  for (let k = 0; k < 6; k++) rail.push(place(BOX, 0, 0.25 + k * 0.33, 0.53 + k * 0.004, 0, 0, 0, 0.36, 0.04, 0.05));
  return { stone, deck, rail: merge(rail) };
})();

/**
 * Modelo de una construcción. Con `override` todas sus partes usan ese material (fantasma de construcción).
 * La puerta mira en +Z: hay que girarla para que quede en línea con lo que tenga al lado.
 */
export function createPiece(piece: 'fence' | 'hedge' | 'wall' | 'gate' | 'tower', override?: THREE.Material): THREE.Group {
  const m = (mat: THREE.Material) => override ?? mat;
  if (piece === 'fence') return createFence(m(MATS.wood), m(MATS.woodDark));
  const g = new THREE.Group();
  if (piece === 'hedge') g.add(mesh(hedgeGeos.dark, m(MATS.hedge)), mesh(hedgeGeos.light, m(MATS.hedgeLight)));
  else if (piece === 'wall') g.add(mesh(wallGeos.a, m(MATS.stone)), mesh(wallGeos.b, m(MATS.stoneDark)));
  else if (piece === 'tower') g.add(mesh(towerGeos.stone, m(MATS.stone)), mesh(towerGeos.deck, m(MATS.wood)), mesh(towerGeos.rail, m(MATS.woodDark)));
  else {
    g.add(mesh(gateGeos.frame, m(MATS.woodDark)));
    // hojas: userData.leaves = [izquierda, derecha], las abre el render al pasar la oveja
    const leaves = [-1, 1].map((side) => {
      const leaf = new THREE.Group();
      leaf.add(mesh(gateGeos.planks, m(MATS.wood)), mesh(gateGeos.iron, m(MATS.iron)));
      leaf.position.x = side * GATE_HINGE;
      leaf.rotation.y = side > 0 ? Math.PI : 0;
      g.add(leaf);
      return leaf;
    });
    g.userData.leaves = leaves;
  }
  return shadowed(g);
}

/** Puente colgante entre dos puntos (las plataformas de dos torres): tablones que cuelgan y dos cuerdas. */
export function createBridge(a: THREE.Vector3, b: THREE.Vector3): THREE.Group {
  const len = a.distanceTo(b);
  const yaw = Math.atan2(b.x - a.x, b.z - a.z);
  const sag = 0.12 + len * 0.05;
  const at = (t: number) => new THREE.Vector3().lerpVectors(a, b, t).setY(a.y + (b.y - a.y) * t - Math.sin(t * Math.PI) * sag);
  const planks: THREE.BufferGeometry[] = [];
  const n = Math.max(3, Math.round(len / 0.28));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const p = at(t);
    // inclinación según la curva
    const slope = Math.atan2(at(Math.min(1, t + 0.02)).y - at(Math.max(0, t - 0.02)).y, len * 0.04);
    planks.push(place(BOX, p.x, p.y, p.z, -slope, yaw, 0, 0.7, 0.05, 0.2));
  }
  const ropes: THREE.BufferGeometry[] = [];
  const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)).multiplyScalar(0.38);
  for (const s of [-1, 1]) {
    for (let k = 0; k < n; k++) {
      const p = at(k / n).addScaledVector(side, s).setY(at(k / n).y + 0.45);
      const q = at((k + 1) / n).addScaledVector(side, s).setY(at((k + 1) / n).y + 0.45);
      const mid = p.clone().add(q).multiplyScalar(0.5);
      const segLen = p.distanceTo(q);
      const pitch = Math.atan2(q.y - p.y, Math.hypot(q.x - p.x, q.z - p.z));
      ropes.push(place(BOX, mid.x, mid.y, mid.z, -pitch, yaw, 0, 0.035, 0.035, segLen + 0.02));
      if (k % 2 === 0) ropes.push(place(BOX, p.x, p.y - 0.22, p.z, 0, 0, 0, 0.02, 0.45, 0.02)); // cuerdas verticales
    }
  }
  const g = new THREE.Group();
  g.add(mesh(merge(planks), MATS.wood), mesh(merge(ropes), MATS.woodDark));
  return shadowed(g);
}

/** Piña (para lanzar). */
export function createPinecone(): THREE.Mesh {
  const geo = merge([place(ICO, 0, 0, 0, 0.4, 0.2, 0, 0.13, 0.18, 0.13), place(BOX, 0, 0.17, 0, 0, 0, 0, 0.03, 0.06, 0.03)]);
  return shadowed(mesh(geo, MATS.woodDark));
}

// ------------------------------------------------------------------ hierba

const grassGeo = (() => {
  const blade = new THREE.ConeGeometry(0.07, 0.5, 3);
  const geos: THREE.BufferGeometry[] = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 16; k++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * 0.42;
    const h = 0.6 + rnd() * 0.6;
    geos.push(place(blade, Math.cos(a) * r, 0.25 * h, Math.sin(a) * r, (rnd() - 0.5) * 0.5, rnd() * 3, (rnd() - 0.5) * 0.5, 1, h, 1));
  }
  return merge(geos);
})();
const flowerGeo = merge([
  place(ICO, 0.18, 0.42, 0.1, 0, 0, 0, 0.06),
  place(ICO, -0.2, 0.36, -0.12, 0, 0, 0, 0.05),
]);

export function createGrass(): THREE.Group {
  const g = new THREE.Group();
  const a = mesh(grassGeo, MATS.grass);
  const b = mesh(grassGeo, MATS.grassLight);
  b.rotation.y = 1.3;
  b.scale.setScalar(0.8);
  g.add(a, b, mesh(flowerGeo, MATS.flower));
  return shadowed(g);
}

// ------------------------------------------------------------------ decorado instanciado

export interface InstancePart {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  palette?: number[];
}

const pineFoliage = merge([
  place(new THREE.ConeGeometry(0.85, 1.3, 7), 0, 1.25, 0),
  place(new THREE.ConeGeometry(0.65, 1.1, 7), 0, 1.85, 0),
  place(new THREE.ConeGeometry(0.42, 0.9, 7), 0, 2.4, 0),
]);
export const PINE: InstancePart[] = [
  { geo: place(new THREE.CylinderGeometry(0.13, 0.18, 0.9, 6), 0, 0.45, 0), mat: MATS.trunk },
  { geo: pineFoliage, mat: MATS.tinted, palette: [0x3d8a55, 0x4a9a5e, 0x35784d, 0x5aa866, 0x447f4a] },
];

const roundFoliage = merge([
  place(ICO, 0, 1.55, 0, 0, 0, 0, 0.78),
  place(ICO, 0.38, 1.3, 0.18, 0.5, 0.3, 0, 0.5),
  place(ICO, -0.3, 1.35, -0.25, 0.2, 0.9, 0, 0.52),
]);
export const ROUND_TREE: InstancePart[] = [
  { geo: place(new THREE.CylinderGeometry(0.12, 0.17, 1.2, 6), 0, 0.6, 0), mat: MATS.trunk },
  { geo: roundFoliage, mat: MATS.tinted, palette: [0x7cbf56, 0x8fc85a, 0x6aae4c, 0xa8c950, 0x7cbf56, 0xe0ac3c, 0xd9803a, 0xc9b84a] },
];

export const ROCK: InstancePart[] = [
  {
    geo: merge([
      place(new THREE.DodecahedronGeometry(0.5, 0), 0, 0.22, 0, 0, 0, 0, 1, 0.7, 1),
      place(new THREE.DodecahedronGeometry(0.28, 0), 0.32, 0.12, 0.25, 0.4, 0.2, 0),
    ]),
    mat: MATS.tinted,
    palette: [0xa39c92, 0x938b80, 0xb0a99e, 0x9a9488],
  },
];

/** Crea un InstancedMesh por pieza, con una instancia por transformación. */
export function buildInstanced(parts: InstancePart[], transforms: THREE.Matrix4[], rng: () => number): THREE.Group {
  const group = new THREE.Group();
  if (transforms.length === 0) return group;
  const color = new THREE.Color();
  for (const part of parts) {
    const im = new THREE.InstancedMesh(part.geo, part.mat, transforms.length);
    transforms.forEach((m, k) => {
      im.setMatrixAt(k, m);
      if (part.palette) im.setColorAt(k, color.setHex(part.palette[Math.floor(rng() * part.palette.length)]));
    });
    im.castShadow = true;
    im.receiveShadow = true;
    group.add(im);
  }
  return group;
}

// ------------------------------------------------------------------ detalles del prado (solo decorado)

/** Florecillas sueltas: cabeza + tallo. El color va por instancia. */
export const FLOWER: InstancePart[] = [
  { geo: place(BOX, 0, 0.09, 0, 0, 0, 0, 0.02, 0.18, 0.02), mat: MATS.grass },
  {
    geo: merge([place(ICO, 0, 0.2, 0, 0, 0, 0, 0.065, 0.04, 0.065), place(ICO, 0, 0.215, 0, 0, 0, 0, 0.03)]),
    mat: MATS.tinted,
    palette: [0xffffff, 0xfff1f6, 0xffd6e4, 0xf7a8c4, 0xffe27a, 0xc9b6f2, 0xffb38a],
  },
];

/** Setas: pie claro y sombrero de color. */
export const MUSHROOM: InstancePart[] = [
  { geo: place(new THREE.CylinderGeometry(0.035, 0.045, 0.14, 6), 0, 0.07, 0), mat: MATS.wool },
  {
    geo: place(new THREE.SphereGeometry(0.1, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.13, 0, 0, 0, 0, 1, 0.75, 1),
    mat: MATS.tinted,
    palette: [0xd9533f, 0xc94a3a, 0xc98b4a, 0xe0b070],
  },
];

/** Matojo de briznas (más pequeño que la hierba comestible, no se come). */
export const TUFT: InstancePart[] = [{ geo: grassGeo, mat: MATS.tinted, palette: [0x8cc45a, 0x9ccf62, 0x7fb853, 0xb5d36e] }];

// ------------------------------------------------------------------ conejo (decorado)

export interface RabbitModel {
  root: THREE.Group;
  /** Pivota en las patas traseras (para sentarse y estirarse al saltar). */
  body: THREE.Group;
  head: THREE.Group;
  nose: THREE.Mesh;
  ears: THREE.Group[];
  tail: THREE.Mesh;
}

const RABBIT_FURS = [0xb08562, 0x9c7656, 0xa39a8e, 0xc4a07a, 0x8a7a6c];
const rabbitFurMats = RABBIT_FURS.map((c) => lambert(c));
const rabbitLight = lambert(0xefe4d2);
const rabbitPink = lambert(0xe8a0a8);
const rabbitBodyGeo = merge([
  place(ICO, 0, 0.19, 0.12, 0.3, 0.2, 0, 0.16, 0.15, 0.2),
  place(ICO, 0.08, 0.14, 0.02, 0.5, 0, 0, 0.1, 0.11, 0.12), // ancas
  place(ICO, -0.08, 0.14, 0.02, 0.5, 0, 0, 0.1, 0.11, 0.12),
  place(BOX, 0.07, 0.025, 0.08, 0, 0, 0, 0.06, 0.05, 0.16), // patas traseras
  place(BOX, -0.07, 0.025, 0.08, 0, 0, 0, 0.06, 0.05, 0.16),
]);
const rabbitPawGeo = merge([
  place(BOX, 0.045, 0.04, 0.25, 0, 0, 0, 0.035, 0.08, 0.045),
  place(BOX, -0.045, 0.04, 0.25, 0, 0, 0, 0.035, 0.08, 0.045),
]);
const rabbitHeadGeo = merge([place(ICO, 0, 0, 0.04, 0.2, 0.4, 0, 0.1, 0.095, 0.115), place(ICO, 0, -0.035, 0.1, 0, 0, 0, 0.06, 0.05, 0.05)]);
const rabbitEyeGeo = merge([place(BOX, 0.062, 0.02, 0.07, 0, 0, 0, 0.02, 0.035, 0.03), place(BOX, -0.062, 0.02, 0.07, 0, 0, 0, 0.02, 0.035, 0.03)]);
const rabbitEarGeo = place(BOX, 0, 0.1, 0, 0, 0, 0, 0.05, 0.2, 0.022);
const rabbitEarInnerGeo = place(BOX, 0, 0.1, 0.008, 0, 0, 0, 0.026, 0.15, 0.012);

export function createRabbit(): RabbitModel {
  const fur = rabbitFurMats[Math.floor(Math.random() * rabbitFurMats.length)];
  const root = new THREE.Group();
  root.scale.setScalar(1.25);
  const body = new THREE.Group();
  root.add(body);
  const torso = mesh(rabbitBodyGeo, fur);
  torso.castShadow = true;
  body.add(torso, mesh(rabbitPawGeo, fur));
  const tail = mesh(ICO, rabbitLight);
  tail.position.set(0, 0.18, -0.08);
  tail.scale.setScalar(0.06);
  body.add(tail);

  const head = new THREE.Group();
  head.position.set(0, 0.3, 0.27);
  body.add(head);
  head.add(mesh(rabbitHeadGeo, fur), mesh(rabbitEyeGeo, MATS.pupil));
  const nose = mesh(ICO, rabbitPink);
  nose.position.set(0, -0.02, 0.15);
  nose.scale.setScalar(0.018);
  head.add(nose);
  const ears = [1, -1].map((s) => {
    const ear = new THREE.Group();
    ear.position.set(s * 0.04, 0.06, -0.02);
    ear.add(mesh(rabbitEarGeo, fur), mesh(rabbitEarInnerGeo, rabbitPink));
    head.add(ear);
    return ear;
  });
  return { root, body, head, nose, ears, tail };
}
