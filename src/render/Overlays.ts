// Ayudas visuales de los sentidos: conos de visión, rastro de olor y ondas de ruido.
import * as THREE from 'three';
import { CONFIG } from '../config';
import { blocksSight } from '../sim/Grid';
import type { Wolf, WolfMode } from '../sim/entities';
import type { World } from '../sim/World';

const RAYS = 36;
const MAX_SCENT = 400;

const CONE_STYLE: Record<WolfMode, { color: number; opacity: number }> = {
  wander: { color: 0xfff1a8, opacity: 0.16 },
  investigate: { color: 0xffa64d, opacity: 0.22 },
  search: { color: 0xffa64d, opacity: 0.22 },
  track: { color: 0xffa64d, opacity: 0.22 },
  hunt: { color: 0xff2a1a, opacity: 0.3 },
};

interface Cone {
  fan: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  close: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  edge: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>;
}

interface Ring {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  radius: number;
  life: number;
  max: number;
}

// Onda de sonido: frente suave con estela, un eco más débil detrás y una marca tenue
// en el radio que oyen los lobos. Todo en unidades de mundo (el grosor no crece con el radio).
const RING_VERT = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const RING_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uMax;
  uniform float uR;
  uniform float uK;
  uniform float uSeed;
  varying vec2 vP;
  float band(float d, float c, float w) { float x = (d - c) / w; return exp(-x * x); }
  void main() {
    vec2 p = vP * uMax;
    float a = atan(p.y, p.x);
    // frente un poco irregular, como una onda real sobre la hierba
    float d = length(p) + (sin(a * 5.0 + uSeed) + sin(a * 9.0 - uSeed * 1.7)) * 0.04 * uR / uMax;
    float fade = 1.0 - uK;
    float front = band(d, uR, 0.16);
    float wake = smoothstep(uR - 1.6, uR, d) * step(d, uR) * 0.28;
    float echo = band(d, uR * 0.62, 0.12) * 0.45 * smoothstep(0.15, 0.35, uK);
    float edge = band(d, uMax - 0.04, 0.05) * 0.35 * smoothstep(0.0, 0.25, uK);
    float alpha = (front + wake + echo) * fade * fade + edge * fade;
    if (d > uMax || alpha < 0.004) discard;
    gl_FragColor = vec4(uColor, alpha * 0.75);
  }
`;

const ringMat = (color: number, max: number) =>
  new THREE.ShaderMaterial({
    vertexShader: RING_VERT,
    fragmentShader: RING_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uMax: { value: max },
      uR: { value: 0 },
      uK: { value: 0 },
      uSeed: { value: Math.random() * 6.28 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });

const overlayMat = (color: number, opacity: number) =>
  new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });

export class Overlays {
  readonly group = new THREE.Group();
  private cones = new Map<number, Cone>();
  private scent: THREE.InstancedMesh;
  private rings: Ring[] = [];
  private ringGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private fresh = new THREE.Color(0xd8b45a);
  private faded = new THREE.Color(0x8cbf5c); // color de la hierba: la huella se funde con el suelo

  constructor() {
    const print = new THREE.CircleGeometry(0.11, 6).rotateX(-Math.PI / 2);
    this.scent = new THREE.InstancedMesh(print, overlayMat(0xffffff, 0.75), MAX_SCENT);
    this.scent.count = 0;
    this.scent.frustumCulled = false;
    this.group.add(this.scent);
  }

  reset(): void {
    for (const c of this.cones.values()) this.group.remove(c.fan, c.close, c.edge);
    this.cones.clear();
    for (const r of this.rings) this.group.remove(r.mesh);
    this.rings = [];
  }

  ring(x: number, z: number, radius: number, color: number): void {
    const mesh = new THREE.Mesh(this.ringGeo, ringMat(color, radius));
    mesh.position.set(x, 0.06, z);
    mesh.scale.set(radius, 1, radius);
    this.group.add(mesh);
    this.rings.push({ mesh, radius, life: 0.9, max: 0.9 });
  }

  update(world: World, dt: number): void {
    this.updateCones(world);
    this.updateScent(world);
    this.rings = this.rings.filter((r) => {
      r.life -= dt;
      if (r.life <= 0) {
        this.group.remove(r.mesh);
        r.mesh.material.dispose();
        return false;
      }
      const k = 1 - r.life / r.max;
      const u = r.mesh.material.uniforms;
      u.uR.value = 0.3 + (r.radius - 0.3) * (1 - (1 - k) ** 3);
      u.uK.value = k;
      return true;
    });
  }

  private updateCones(world: World): void {
    const alive = new Set<number>();
    for (const w of world.wolves) {
      alive.add(w.id);
      let cone = this.cones.get(w.id);
      if (!cone) {
        cone = this.createCone();
        this.cones.set(w.id, cone);
        this.group.add(cone.fan, cone.close, cone.edge);
      }
      this.shapeCone(cone, w, world);
    }
    for (const [id, cone] of this.cones) {
      if (alive.has(id)) continue;
      this.group.remove(cone.fan, cone.close, cone.edge);
      this.cones.delete(id);
    }
  }

  private createCone(): Cone {
    const geo = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(new Float32Array((RAYS + 2) * 3), 3);
    geo.setAttribute('position', positions);
    const idx: number[] = [];
    for (let k = 1; k <= RAYS; k++) idx.push(0, k, k + 1);
    geo.setIndex(idx);
    const fan = new THREE.Mesh(geo, overlayMat(0xffffff, 0.2));
    fan.frustumCulled = false;
    const close = new THREE.Mesh(
      new THREE.CircleGeometry(CONFIG.wolf.closeSense, 28).rotateX(-Math.PI / 2),
      overlayMat(0xffffff, 0.1),
    );
    // borde del cono: mismo buffer de posiciones, recorrido en orden (centro → arco → centro)
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', positions);
    const edge = new THREE.LineLoop(edgeGeo, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.7, depthWrite: false }));
    edge.frustumCulled = false;
    return { fan, close, edge };
  }

  /** Abanico desde el lobo, con cada rayo recortado por lo que tapa la vista (igual que la vista real). */
  private shapeCone(cone: Cone, w: Wolf, world: World): void {
    const cw = CONFIG.wolf;
    const grid = world.grid;
    const pos = cone.fan.geometry.attributes.position as THREE.BufferAttribute;
    pos.setXYZ(0, 0, 0, 0);
    const range = world.sightRange; // de noche ven menos
    for (let k = 0; k <= RAYS; k++) {
      const a = w.heading - cw.fov + (2 * cw.fov * k) / RAYS;
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      let d = 0;
      while (d < range) {
        const nd = Math.min(range, d + 0.3);
        const [i, j] = grid.toCell(w.pos.x + dx * nd, w.pos.z + dz * nd);
        if (blocksSight(grid.get(i, j))) break;
        d = nd;
      }
      pos.setXYZ(k + 1, dx * d, 0, dz * d);
    }
    pos.needsUpdate = true;
    cone.fan.geometry.computeBoundingSphere();

    const style = CONE_STYLE[w.mode];
    cone.fan.position.set(w.pos.x, 0.05, w.pos.z);
    cone.fan.material.color.setHex(style.color);
    cone.fan.material.opacity = style.opacity;
    cone.edge.position.set(w.pos.x, 0.06, w.pos.z);
    cone.edge.material.color.setHex(style.color);
    cone.close.position.set(w.pos.x, 0.045, w.pos.z);
    cone.close.material.color.setHex(style.color);
    cone.close.material.opacity = style.opacity * 0.5;
  }

  /** Huellas por pares (pezuñas), que encogen y se apagan con el tiempo. */
  private updateScent(world: World): void {
    const list = world.scent;
    let n = 0;
    const from = Math.max(0, list.length - MAX_SCENT / 2);
    for (let k = from; k < list.length; k++) {
      const p = list[k];
      const strength = world.scentStrength(p);
      if (strength <= 0.02) continue;
      const next = list[k + 1] ?? list[k - 1];
      let ax = 0;
      let az = 1;
      if (next) {
        const l = Math.hypot(next.x - p.x, next.z - p.z) || 1;
        ax = (next.x - p.x) / l;
        az = (next.z - p.z) / l;
      }
      // encoge hasta desaparecer y se va fundiendo con la hierba
      const s = 1.3 * strength;
      this.color.copy(this.faded).lerp(this.fresh, strength);
      for (const side of [-1, 1]) {
        this.dummy.position.set(p.x - az * 0.14 * side + ax * 0.08 * side, 0.04, p.z + ax * 0.14 * side + az * 0.08 * side);
        this.dummy.scale.set(s, 1, s);
        this.dummy.updateMatrix();
        this.scent.setMatrixAt(n, this.dummy.matrix);
        this.scent.setColorAt(n, this.color);
        n++;
      }
    }
    this.scent.count = n;
    this.scent.instanceMatrix.needsUpdate = true;
    if (this.scent.instanceColor) this.scent.instanceColor.needsUpdate = true;
  }
}
