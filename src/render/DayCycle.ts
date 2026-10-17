// Ciclo de día: la partida empieza por la mañana y acaba de noche, cambiando poco a poco.
// Todo barato: cielo con colores por vértice (se recalculan en CPU, ~560 vértices), nubes instanciadas,
// estrellas y luciérnagas como puntos, una luz puntual (el farolillo de la oveja) que siempre existe
// (apagada de día) para no recompilar shaders. Sin post-procesado.
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { World } from '../sim/World';

interface Keyframe {
  t: number;
  skyTop: number;
  horizon: number;
  glow: number;
  fog: number;
  /** Sol de día, luna de noche. */
  light: number;
  lightIntensity: number;
  /** Dirección de la luz en grados (acimut, elevación). */
  azimuth: number;
  elevation: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  exposure: number;
  /** 0 de día, 1 de noche cerrada: estrellas, luciérnagas, farolillo. */
  night: number;
}

const KEYS: Keyframe[] = [
  // mañana: luz rosada y baja por el este
  { t: 0, skyTop: 0x9ccdf0, horizon: 0xffd6c4, glow: 0xffe3b8, fog: 0xf1dfd0, light: 0xffe0ba, lightIntensity: 2.4, azimuth: -70, elevation: 16,
    hemiSky: 0xfff0ea, hemiGround: 0x8a8a5a, hemiIntensity: 1.45, exposure: 1.05, night: 0 },
  // mediodía: cielo azul limpio, luz alta y blanca
  { t: 0.28, skyTop: 0x7dbdea, horizon: 0xd9ecf0, glow: 0xfffbea, fog: 0xdfe9e0, light: 0xfff3e0, lightIntensity: 2.9, azimuth: 0, elevation: 62,
    hemiSky: 0xf2f6ff, hemiGround: 0x839152, hemiIntensity: 1.6, exposure: 1.05, night: 0 },
  // tarde dorada
  { t: 0.55, skyTop: 0x8ec3e6, horizon: 0xffe2bf, glow: 0xfff0c8, fog: 0xf4dcbc, light: 0xffd9a6, lightIntensity: 2.8, azimuth: 40, elevation: 34,
    hemiSky: 0xfff0dc, hemiGround: 0x8a8a52, hemiIntensity: 1.55, exposure: 1.05, night: 0 },
  // atardecer
  { t: 0.73, skyTop: 0x6d80bb, horizon: 0xffa274, glow: 0xffc276, fog: 0xeab08e, light: 0xff9c5c, lightIntensity: 2.1, azimuth: 70, elevation: 8,
    hemiSky: 0xffd8c0, hemiGround: 0x7a7058, hemiIntensity: 1.45, exposure: 1.05, night: 0.1 },
  // anochecer (la luz casi apagada: aquí cambia de sol a luna sin que se note)
  { t: 0.84, skyTop: 0x2f3c72, horizon: 0x8c6a98, glow: 0xc98c86, fog: 0x5c5a82, light: 0xb08ab0, lightIntensity: 0.25, azimuth: 80, elevation: 3,
    hemiSky: 0x9a8ab8, hemiGround: 0x3e3a48, hemiIntensity: 0.95, exposure: 1.1, night: 0.6 },
  // noche de luna
  { t: 0.92, skyTop: 0x0f1b3c, horizon: 0x2c3d6a, glow: 0x5a6c9c, fog: 0x26345a, light: 0xa8c0ff, lightIntensity: 0.95, azimuth: -130, elevation: 48,
    hemiSky: 0x7088c4, hemiGround: 0x2a3a3c, hemiIntensity: 0.85, exposure: 1.15, night: 1 },
  { t: 1, skyTop: 0x0c1636, horizon: 0x283a66, glow: 0x5a6c9c, fog: 0x233257, light: 0xa8c0ff, lightIntensity: 0.95, azimuth: -140, elevation: 52,
    hemiSky: 0x7088c4, hemiGround: 0x2a3a3c, hemiIntensity: 0.85, exposure: 1.15, night: 1 },
];

const COLOR_KEYS = ['skyTop', 'horizon', 'glow', 'fog', 'light', 'hemiSky', 'hemiGround'] as const;
const NUM_KEYS = ['lightIntensity', 'azimuth', 'elevation', 'hemiIntensity', 'exposure', 'night'] as const;

/** ?dia=0.8 fija la hora (0 mañana … 1 noche) para probar el aspecto sin jugar. */
const FORCED = (() => {
  const v = new URLSearchParams(location.search).get('dia');
  return v === null ? null : Math.min(1, Math.max(0, Number(v)));
})();

/** Hora del día de la partida: 0 al empezar (mañana) → 1 al acabar (noche). */
export function dayProgress(world: World): number {
  if (FORCED !== null) return FORCED;
  return Math.min(1, world.time / (CONFIG.prepTime + CONFIG.survivalTime));
}

export function dayIcon(p: number): string {
  return p < 0.18 ? '🌄' : p < 0.45 ? '☀️' : p < 0.68 ? '🌤️' : p < 0.82 ? '🌇' : '🌙';
}

const CLOUDS = 16;
const FIREFLIES = 70;
const FLY_BOX = 20;
const STARS = 450;
const SKY_R = 150;
/** La luna sale siempre por el mismo sitio (la luz de noche viene de ahí). */
const MOON_DIR = new THREE.Vector3(Math.sin(-2.27) * 0.67, 0.74, Math.cos(-2.27) * 0.67).normalize();

/** Textura de brillo redondo para luciérnagas, sol y luna. */
function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class DayCycle {
  readonly group = new THREE.Group();
  readonly hemi = new THREE.HemisphereLight();
  readonly sun = new THREE.DirectionalLight();
  /** Farolillo cálido sobre la oveja: de noche ilumina un poco alrededor. */
  readonly lantern = new THREE.PointLight(0xffb866, 0, 10, 1.4);

  private key = { ...KEYS[0] };
  private dir = new THREE.Vector3();
  private sky: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private skyDirs: Float32Array;
  private stars: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private sunDisc: THREE.Sprite;
  private moonDisc: THREE.Sprite;
  private clouds: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  private cloudData: { x: number; z: number; y: number; s: number; speed: number; rot: number }[] = [];
  private flies: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private flySeed = new Float32Array(FIREFLIES * 3);
  private flyCenter = new THREE.Vector3();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();
  private c2 = new THREE.Color();
  private lastP = -1;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene) {
    // cielo
    const geo = new THREE.SphereGeometry(SKY_R, 32, 16);
    const pos = geo.attributes.position;
    this.skyDirs = new Float32Array(pos.count * 3);
    for (let k = 0; k < pos.count; k++) {
      this.v.fromBufferAttribute(pos, k).normalize();
      this.skyDirs.set([this.v.x, this.v.y, this.v.z], k * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.sky = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false, toneMapped: false }),
    );
    this.sky.renderOrder = -3;
    this.sky.frustumCulled = false;

    // estrellas (solo la mitad de arriba)
    const sp = new Float32Array(STARS * 3);
    for (let k = 0; k < STARS; k++) {
      const a = Math.random() * Math.PI * 2;
      const y = 0.08 + Math.random() * 0.92;
      const r = Math.sqrt(1 - y * y);
      sp.set([Math.cos(a) * r * (SKY_R - 5), y * (SKY_R - 5), Math.sin(a) * r * (SKY_R - 5)], k * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.stars = new THREE.Points(
      sg,
      new THREE.PointsMaterial({ color: 0xfff8e8, size: 2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false, toneMapped: false }),
    );
    this.stars.renderOrder = -2;
    this.stars.frustumCulled = false;

    const glow = glowTexture();
    const disc = (color: number) => {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: glow, color, fog: false, depthWrite: false, transparent: true, toneMapped: false }),
      );
      sprite.renderOrder = -1;
      return sprite;
    };
    this.sunDisc = disc(0xfff4d0);
    this.moonDisc = disc(0xf2f4ff);

    // nubes: varias bolas aplastadas fusionadas en una geometría, una instancia por nube
    const parts: THREE.BufferGeometry[] = [];
    const ico = new THREE.IcosahedronGeometry(1, 0);
    for (const [x, y, z, s] of [[0, 0, 0, 2.2], [2, -0.3, 0.4, 1.6], [-2, -0.3, -0.2, 1.7], [0.9, 0.6, -0.5, 1.4], [-1, 0.4, 0.6, 1.3]]) {
      const g = ico.clone();
      g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(s * 1.3, s * 0.75, s)));
      parts.push(g);
    }
    const cloudGeo = mergeSimple(parts);
    this.clouds = new THREE.InstancedMesh(cloudGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, fog: false }), CLOUDS);
    this.clouds.frustumCulled = false;
    this.clouds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let k = 0; k < CLOUDS; k++) {
      const a = (k / CLOUDS) * Math.PI * 2 + Math.random() * 0.4;
      const r = 45 + Math.random() * 60;
      this.cloudData.push({
        x: Math.cos(a) * r,
        z: Math.sin(a) * r,
        y: 26 + Math.random() * 16,
        s: 1.6 + Math.random() * 1.6,
        speed: 0.6 + Math.random() * 0.8,
        rot: Math.random() * Math.PI,
      });
    }

    // luciérnagas
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FIREFLIES * 3), 3).setUsage(THREE.DynamicDrawUsage));
    fg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(FIREFLIES * 3), 3).setUsage(THREE.DynamicDrawUsage));
    for (let k = 0; k < this.flySeed.length; k++) this.flySeed[k] = Math.random() * 100;
    this.flies = new THREE.Points(
      fg,
      new THREE.PointsMaterial({
        size: 0.45, map: glow, vertexColors: true, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
      }),
    );
    this.flies.frustumCulled = false;

    this.sun.castShadow = true;
    this.group.add(this.sky, this.stars, this.sunDisc, this.moonDisc, this.clouds, this.flies, this.lantern);
  }

  /** Interpola los fotogramas clave para la hora `p` (0..1). */
  private sample(p: number): void {
    let k = 0;
    while (k < KEYS.length - 2 && p > KEYS[k + 1].t) k++;
    const a = KEYS[k];
    const b = KEYS[k + 1];
    const u = Math.min(1, Math.max(0, (p - a.t) / (b.t - a.t)));
    const f = u * u * (3 - 2 * u);
    for (const key of COLOR_KEYS) this.key[key] = this.c.setHex(a[key]).lerp(this.c2.setHex(b[key]), f).getHex();
    for (const key of NUM_KEYS) this.key[key] = a[key] + (b[key] - a[key]) * f;
  }

  /** Color actual de la niebla (para el suelo lejano y el fondo). */
  get fogColor(): number {
    return this.key.fog;
  }

  get night(): number {
    return this.key.night;
  }

  update(world: World, dt: number, time: number, camera: THREE.Camera, camTarget: THREE.Vector3, sheep: THREE.Vector3): void {
    const p = dayProgress(world);
    const K = this.key;
    // la hora solo avanza: basta recalcular colores cuando cambia de verdad
    if (Math.abs(p - this.lastP) > 0.0005) {
      this.lastP = p;
      this.sample(p);
      const az = THREE.MathUtils.degToRad(K.azimuth);
      const el = THREE.MathUtils.degToRad(K.elevation);
      this.dir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();

      this.sun.color.setHex(K.light);
      this.sun.intensity = K.lightIntensity;
      this.hemi.color.setHex(K.hemiSky);
      this.hemi.groundColor.setHex(K.hemiGround);
      this.hemi.intensity = K.hemiIntensity;
      this.renderer.toneMappingExposure = K.exposure;
      const fog = this.scene.fog as THREE.Fog;
      fog.color.setHex(K.fog);
      (this.scene.background as THREE.Color).setHex(K.fog);
      // de noche la niebla se acerca un poco: el bosque lejano se pierde en la oscuridad
      fog.near = 30 - K.night * 6;
      fog.far = 82 - K.night * 14;

      this.paintSky();
      this.stars.material.opacity = Math.max(0, (K.night - 0.35) / 0.65);
      const day = 1 - Math.min(1, K.night * 2.5);
      this.sunDisc.material.opacity = day;
      this.sunDisc.material.color.setHex(K.glow).lerp(this.c2.setHex(0xffffff), 0.4);
      this.moonDisc.material.opacity = Math.max(0, (K.night - 0.5) * 2);
      this.lantern.intensity = K.night * 4.5;
      const cl = this.clouds.material;
      // las nubes cogen el color del cielo: rosadas al atardecer, azuladas de noche
      cl.emissive.setHex(K.horizon).multiplyScalar(0.35 + K.night * 0.1);
      cl.color.setHex(0xffffff).lerp(this.c2.setHex(0x5a6890), K.night * 0.7);
    }

    // sol y luna en el cielo (la luz que da sombra es la misma dirección)
    const cp = camera.position;
    this.sky.position.copy(cp);
    this.stars.position.copy(cp);
    this.stars.rotation.y = time * 0.004;
    this.sunDisc.position.copy(cp).addScaledVector(this.dir, SKY_R - 10);
    this.sunDisc.scale.setScalar(26);
    this.moonDisc.position.copy(cp).addScaledVector(MOON_DIR, SKY_R - 10);
    this.moonDisc.scale.setScalar(16);
    // apunta al centro del mapa (la cámara de sombras lo cubre entero: sin parpadeos al moverse)
    this.sun.position.copy(this.dir).multiplyScalar(60);
    this.lantern.position.set(sheep.x, sheep.y + 2.8, sheep.z);

    this.updateClouds(dt, cp);
    this.updateFlies(time, camTarget);
  }

  private paintSky(): void {
    const K = this.key;
    const attr = this.sky.geometry.attributes.color as THREE.BufferAttribute;
    const top = new THREE.Color(K.skyTop);
    const horizon = new THREE.Color(K.horizon);
    const glow = new THREE.Color(K.glow);
    const fog = new THREE.Color(K.fog);
    const d = this.skyDirs;
    for (let k = 0; k < attr.count; k++) {
      const x = d[k * 3], y = d[k * 3 + 1], z = d[k * 3 + 2];
      if (y < 0) {
        attr.setXYZ(k, fog.r, fog.g, fog.b);
        continue;
      }
      this.c.copy(horizon).lerp(top, Math.pow(y, 0.6));
      const s = Math.max(0, x * this.dir.x + y * this.dir.y + z * this.dir.z);
      this.c.lerp(glow, Math.pow(s, 6) * 0.8);
      // halo ancho del sol en el horizonte al atardecer
      const h = Math.max(0, x * this.dir.x + z * this.dir.z) * (1 - y);
      this.c.lerp(glow, Math.pow(h, 3) * 0.35 * (1 - K.night));
      attr.setXYZ(k, this.c.r, this.c.g, this.c.b);
    }
    attr.needsUpdate = true;
  }

  private updateClouds(dt: number, cp: THREE.Vector3): void {
    const span = 220;
    this.cloudData.forEach((cd, k) => {
      cd.x += cd.speed * dt;
      // se recolocan al salir de la caja que rodea a la cámara (cielo infinito)
      let rx = cd.x - cp.x;
      let rz = cd.z - cp.z;
      if (rx > span / 2) cd.x -= span;
      if (rx < -span / 2) cd.x += span;
      if (rz > span / 2) cd.z -= span;
      if (rz < -span / 2) cd.z += span;
      rx = cd.x - cp.x;
      rz = cd.z - cp.z;
      // bajo la cámara no: se apartan para no tapar la vista desde la torre
      const near = Math.hypot(rx, rz) < 30 ? 0 : 1;
      this.q.setFromAxisAngle(this.v.set(0, 1, 0), cd.rot);
      this.m.compose(this.v.set(cd.x, cd.y, cd.z), this.q, this.s.setScalar(cd.s * near));
      this.clouds.setMatrixAt(k, this.m);
    });
    this.clouds.instanceMatrix.needsUpdate = true;
  }

  private updateFlies(time: number, camTarget: THREE.Vector3): void {
    // aparecen al atardecer
    const amount = Math.max(0, Math.min(1, (this.key.night - 0.05) / 0.5));
    this.flies.visible = amount > 0;
    if (!amount) return;
    this.flyCenter.lerp(camTarget, 0.05);
    const pos = this.flies.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.flies.geometry.attributes.color as THREE.BufferAttribute;
    const half = FLY_BOX / 2;
    for (let k = 0; k < FIREFLIES; k++) {
      const a = this.flySeed[k * 3], b = this.flySeed[k * 3 + 1], c = this.flySeed[k * 3 + 2];
      // posición fija en una rejilla "infinita" alrededor de la cámara + vuelo errático
      const bx = ((a * 7.3) % FLY_BOX) - half;
      const bz = ((b * 5.1) % FLY_BOX) - half;
      let x = bx + Math.sin(time * 0.4 + a) * 1.5;
      let z = bz + Math.cos(time * 0.35 + b) * 1.5;
      x = ((x - this.flyCenter.x + half) % FLY_BOX + FLY_BOX) % FLY_BOX - half + this.flyCenter.x;
      z = ((z - this.flyCenter.z + half) % FLY_BOX + FLY_BOX) % FLY_BOX - half + this.flyCenter.z;
      const y = 0.4 + (c % 2) + Math.sin(time * 0.8 + c) * 0.4;
      pos.setXYZ(k, x, y, z);
      // parpadeo lento: cada una se enciende y se apaga a su ritmo
      const blink = Math.max(0, Math.sin(time * (0.8 + (a % 1)) + b)) ** 2 * amount;
      col.setXYZ(k, 1 * blink, 0.85 * blink, 0.35 * blink);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }
}

/** Fusiona geometrías no indexadas (para no depender de BufferGeometryUtils aquí). */
function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = flat.reduce((n, g) => n + g.attributes.position.count, 0);
  const out = new Float32Array(total * 3);
  let o = 0;
  for (const g of flat) {
    out.set(g.attributes.position.array as Float32Array, o);
    o += g.attributes.position.count * 3;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(out, 3));
  merged.computeVertexNormals();
  return merged;
}
