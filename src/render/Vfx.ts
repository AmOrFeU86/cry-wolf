// Efectos visuales baratos: todas las partículas van en UN InstancedMesh (1 draw call),
// opacas (sin ordenar transparencias) y sin sombras. Se desvanecen encogiéndose.
import * as THREE from 'three';

const MAX = 700;
const MOTES = 140;
const MOTE_BOX = 22; // lado del cubo de motas que sigue a la cámara

/** debris: trocitos que rebotan · puff: polvo que crece y se deshace · leaf: hoja que cae balanceándose · streak: estela alargada */
const enum Kind {
  Debris,
  Puff,
  Leaf,
  Streak,
}

const LEAF_COLORS = [0x8cbf4a, 0xe0ac3c, 0xd9803a, 0xc9a23a, 0xb8732f];

export class Vfx {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private n = 0;
  // estado por partícula en arrays planos (sin objetos por partícula: nada de basura para el GC)
  private pos = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private rot = new Float32Array(MAX * 3);
  private spin = new Float32Array(MAX);
  private life = new Float32Array(MAX);
  private max = new Float32Array(MAX);
  private size = new Float32Array(MAX);
  private grav = new Float32Array(MAX);
  private drag = new Float32Array(MAX);
  private kind = new Uint8Array(MAX);
  private col = new Float32Array(MAX * 3);

  private motes: THREE.Points;
  private moteSeed = new Float32Array(MOTES);
  private moteCenter = new THREE.Vector3();

  private stars = new THREE.Group();

  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();

  constructor() {
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ flatShading: true }),
      MAX,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, this.c.set(0xffffff));
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // las partículas se mueven: el bounding sphere nunca está al día
    this.group.add(this.mesh);

    // Motas de polen flotando alrededor de la cámara (puntos: casi gratis)
    const geo = new THREE.BufferGeometry();
    const p = new Float32Array(MOTES * 3);
    for (let k = 0; k < MOTES; k++) {
      p[k * 3] = (Math.random() - 0.5) * MOTE_BOX;
      p[k * 3 + 1] = Math.random() * 5;
      p[k * 3 + 2] = (Math.random() - 0.5) * MOTE_BOX;
      this.moteSeed[k] = Math.random() * 100;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3).setUsage(THREE.DynamicDrawUsage));
    this.motes = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color: 0xffe9a8, size: 0.08, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.motes.frustumCulled = false;
    this.group.add(this.motes);

    // Estrellitas del aturdimiento
    const starGeo = new THREE.OctahedronGeometry(0.09);
    const starMat = new THREE.MeshBasicMaterial({ color: 0xffe14a });
    for (let k = 0; k < 3; k++) this.stars.add(new THREE.Mesh(starGeo, starMat));
    this.stars.visible = false;
    this.group.add(this.stars);
  }

  reset(): void {
    this.n = 0;
    this.mesh.count = 0;
    this.stars.visible = false;
  }

  private spawn(
    kind: Kind,
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    color: number, size: number, life: number, grav: number, drag: number,
  ): void {
    // lleno: se recicla una cualquiera en vez de crecer
    const k = this.n < MAX ? this.n++ : Math.floor(Math.random() * MAX);
    const k3 = k * 3;
    this.pos[k3] = x;
    this.pos[k3 + 1] = y;
    this.pos[k3 + 2] = z;
    this.vel[k3] = vx;
    this.vel[k3 + 1] = vy;
    this.vel[k3 + 2] = vz;
    this.rot[k3] = Math.random() * 3;
    this.rot[k3 + 1] = Math.random() * 3;
    this.rot[k3 + 2] = Math.random() * 3;
    this.spin[k] = (Math.random() - 0.5) * 10;
    this.life[k] = this.max[k] = life;
    this.size[k] = size;
    this.grav[k] = grav;
    this.drag[k] = drag;
    this.kind[k] = kind;
    this.c.setHex(color);
    // un poco de variación de tono para que no parezcan clones
    const j = 0.9 + Math.random() * 0.2;
    this.col[k3] = this.c.r * j;
    this.col[k3 + 1] = this.c.g * j;
    this.col[k3 + 2] = this.c.b * j;
  }

  /** Trocitos que salen disparados y rebotan en el suelo. */
  burst(x: number, y: number, z: number, color: number, count: number, speed: number): void {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.6);
      this.spawn(Kind.Debris, x, y, z, Math.cos(a) * v, 2 + Math.random() * speed, Math.sin(a) * v,
        color, 0.1 + Math.random() * 0.06, 0.5 + Math.random() * 0.5, 12, 0);
    }
  }

  /** Nubecitas de polvo a ras de suelo. */
  dust(x: number, z: number, count: number, spread = 0.3, color = 0xcdb98f, size = 0.28, y = 0.1): void {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      const v = 0.4 + Math.random() * 0.8;
      this.spawn(Kind.Puff, x + Math.cos(a) * r, y + Math.random() * 0.1, z + Math.sin(a) * r,
        Math.cos(a) * v, 0.3 + Math.random() * 0.6, Math.sin(a) * v,
        color, size * (0.7 + Math.random() * 0.6), 0.45 + Math.random() * 0.4, -0.3, 3);
    }
  }

  /** Anillo de polvo que se abre (golpes, aterrizajes). */
  dustRing(x: number, z: number, count: number, speed: number, color = 0xcdb98f, size = 0.32): void {
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + Math.random() * 0.3;
      const v = speed * (0.8 + Math.random() * 0.4);
      this.spawn(Kind.Puff, x + Math.cos(a) * 0.2, 0.12, z + Math.sin(a) * 0.2,
        Math.cos(a) * v, 0.2 + Math.random() * 0.4, Math.sin(a) * v,
        color, size * (0.7 + Math.random() * 0.6), 0.5 + Math.random() * 0.3, 0, 4);
    }
  }

  /** Briznas de hierba que saltan al comer. */
  grassBits(x: number, y: number, z: number, count: number): void {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const v = 0.5 + Math.random() * 1;
      this.spawn(Kind.Debris, x, y, z, Math.cos(a) * v, 1.5 + Math.random() * 1.5, Math.sin(a) * v,
        Math.random() < 0.7 ? 0x5fae3c : 0x8fd05a, 0.06 + Math.random() * 0.04, 0.4 + Math.random() * 0.3, 9, 0);
    }
  }

  /** Estela blanca alargada (salto del lobo, esquive). */
  streak(x: number, y: number, z: number, color = 0xffffff): void {
    this.spawn(Kind.Streak, x + (Math.random() - 0.5) * 0.4, y + (Math.random() - 0.5) * 0.4, z + (Math.random() - 0.5) * 0.4,
      0, 0, 0, color, 0.05, 0.25, 0, 0);
  }

  /** Hoja que cae de los árboles cerca de un punto. */
  leaf(cx: number, cz: number, radius: number): void {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius;
    this.spawn(Kind.Leaf, cx + Math.cos(a) * r, 5 + Math.random() * 3, cz + Math.sin(a) * r,
      (Math.random() - 0.5) * 0.6, -0.6 - Math.random() * 0.4, (Math.random() - 0.5) * 0.6,
      LEAF_COLORS[Math.floor(Math.random() * LEAF_COLORS.length)], 0.16, 6 + Math.random() * 3, 0, 0);
  }

  /** Polen visible de día; de noche se apaga (salen las luciérnagas). */
  setMotes(amount: number): void {
    this.motes.visible = amount > 0.02;
    (this.motes.material as THREE.PointsMaterial).opacity = 0.85 * amount;
  }

  /** Estrellas girando sobre la cabeza (o nada si `show` es falso). */
  setStars(show: boolean, x: number, y: number, z: number, time: number): void {
    this.stars.visible = show;
    if (!show) return;
    this.stars.children.forEach((star, k) => {
      const a = time * 5 + (k / 3) * Math.PI * 2;
      star.position.set(x + Math.cos(a) * 0.35, y + Math.sin(time * 8 + k) * 0.05, z + Math.sin(a) * 0.35);
      star.rotation.y = time * 6;
    });
  }

  update(dt: number, camTarget: THREE.Vector3, time: number): void {
    this.updateParticles(dt, time);
    this.updateMotes(camTarget, time);
  }

  private updateParticles(dt: number, time: number): void {
    let k = 0;
    while (k < this.n) {
      this.life[k] -= dt;
      if (this.life[k] <= 0) {
        this.n--;
        if (k !== this.n) this.copy(this.n, k); // la última ocupa el hueco
        continue;
      }
      const k3 = k * 3;
      const kind = this.kind[k];
      const t = this.life[k] / this.max[k]; // 1 → 0
      const fr = Math.exp(-this.drag[k] * dt);
      this.vel[k3] *= fr;
      this.vel[k3 + 2] *= fr;
      this.vel[k3 + 1] = this.vel[k3 + 1] * fr - this.grav[k] * dt;
      if (kind === Kind.Leaf) {
        // vaivén de lado a lado mientras cae
        const sway = Math.sin(time * 2.5 + k) * 0.9;
        this.pos[k3] += (this.vel[k3] + sway) * dt;
        this.pos[k3 + 2] += (this.vel[k3 + 2] + Math.cos(time * 2 + k) * 0.4) * dt;
        this.pos[k3 + 1] += this.vel[k3 + 1] * dt;
      } else {
        this.pos[k3] += this.vel[k3] * dt;
        this.pos[k3 + 1] += this.vel[k3 + 1] * dt;
        this.pos[k3 + 2] += this.vel[k3 + 2] * dt;
      }
      if (this.pos[k3 + 1] < 0.04) {
        this.pos[k3 + 1] = 0.04;
        if (kind === Kind.Debris) {
          this.vel[k3] *= 0.5;
          this.vel[k3 + 2] *= 0.5;
          this.vel[k3 + 1] = Math.abs(this.vel[k3 + 1]) * 0.3;
        } else if (kind === Kind.Leaf) {
          // hoja posada: se queda quieta un rato y se encoge al final
          this.vel[k3] = this.vel[k3 + 1] = this.vel[k3 + 2] = 0;
          this.life[k] = Math.min(this.life[k], 1.5);
        }
      }

      let sx: number, sy: number, sz: number;
      const base = this.size[k];
      if (kind === Kind.Puff) {
        // crece rápido y se deshace despacio
        const g = Math.sin(Math.min(1, (1 - t) * 3) * Math.PI * 0.5) * t ** 0.5;
        sx = sy = sz = base * (0.4 + 1.2 * (1 - t)) * g * 1.6;
        this.rot[k3 + 1] += dt;
      } else if (kind === Kind.Leaf) {
        const g = Math.min(1, this.life[k] / 0.5);
        sx = base * g;
        sy = 0.02;
        sz = base * 0.65 * g;
        if (this.pos[k3 + 1] > 0.05) {
          this.rot[k3] = Math.sin(time * 3 + k) * 0.7;
          this.rot[k3 + 2] = Math.cos(time * 2.3 + k) * 0.7;
        } else {
          this.rot[k3] = this.rot[k3 + 2] = 0;
        }
      } else if (kind === Kind.Streak) {
        sx = sz = base * t;
        sy = 0.7 * t;
      } else {
        sx = sy = sz = base * Math.min(1, t * 2.5);
        this.rot[k3] += dt * this.spin[k];
        this.rot[k3 + 2] += dt * this.spin[k] * 0.7;
      }

      this.e.set(this.rot[k3], this.rot[k3 + 1], this.rot[k3 + 2]);
      this.q.setFromEuler(this.e);
      this.v.set(this.pos[k3], this.pos[k3 + 1], this.pos[k3 + 2]);
      this.s.set(sx, sy, sz);
      this.m.compose(this.v, this.q, this.s);
      this.mesh.setMatrixAt(k, this.m);
      this.c.setRGB(this.col[k3], this.col[k3 + 1], this.col[k3 + 2]);
      this.mesh.setColorAt(k, this.c);
      k++;
    }
    this.mesh.count = this.n;
    if (this.n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor!.needsUpdate = true;
    }
  }

  private copy(from: number, to: number): void {
    const f3 = from * 3;
    const t3 = to * 3;
    for (let i = 0; i < 3; i++) {
      this.pos[t3 + i] = this.pos[f3 + i];
      this.vel[t3 + i] = this.vel[f3 + i];
      this.rot[t3 + i] = this.rot[f3 + i];
      this.col[t3 + i] = this.col[f3 + i];
    }
    this.spin[to] = this.spin[from];
    this.life[to] = this.life[from];
    this.max[to] = this.max[from];
    this.size[to] = this.size[from];
    this.grav[to] = this.grav[from];
    this.drag[to] = this.drag[from];
    this.kind[to] = this.kind[from];
  }

  private updateMotes(center: THREE.Vector3, time: number): void {
    // las motas viven en coordenadas relativas a un centro que sigue a la cámara (envuelven al salir del cubo)
    this.moteCenter.set(center.x, 0, center.z);
    const attr = this.motes.geometry.attributes.position as THREE.BufferAttribute;
    const p = attr.array as Float32Array;
    const h = MOTE_BOX / 2;
    for (let k = 0; k < MOTES; k++) {
      const sd = this.moteSeed[k];
      let x = p[k * 3] + Math.sin(time * 0.4 + sd) * 0.006 + 0.004;
      const y = 0.5 + (sd % 3.5) + Math.sin(time * 0.6 + sd) * 0.4;
      let z = p[k * 3 + 2] + Math.cos(time * 0.3 + sd) * 0.006;
      // envolver respecto al centro
      const rx = x - this.moteCenter.x;
      const rz = z - this.moteCenter.z;
      if (rx > h) x -= MOTE_BOX;
      else if (rx < -h) x += MOTE_BOX;
      if (rz > h) z -= MOTE_BOX;
      else if (rz < -h) z += MOTE_BOX;
      p[k * 3] = x;
      p[k * 3 + 1] = y;
      p[k * 3 + 2] = z;
    }
    attr.needsUpdate = true;
  }
}
