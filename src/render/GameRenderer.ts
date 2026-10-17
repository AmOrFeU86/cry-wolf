import * as THREE from 'three';
import { CONFIG } from '../config';
import { Cell, isBuilt, type Vec2 } from '../sim/Grid';
import type { Grass, Sheep } from '../sim/entities';
import { pieceOfCell, PIECES, type PieceId } from '../sim/pieces';
import type { World } from '../sim/World';
import {
  buildInstanced,
  createGrass,
  createBridge,
  createPiece,
  createPinecone,
  createSheep,
  createWolf,
  FLOWER,
  MUSHROOM,
  PINE,
  ROCK,
  ROUND_TREE,
  TUFT,
  type AnimatedModel,
} from './models';
import { Overlays } from './Overlays';
import { Vfx } from './Vfx';
import { mulberry32 } from '../sim/rng';
import { findPath } from '../sim/pathfinding';
import { DayCycle } from './DayCycle';
import { Rabbits } from './Rabbits';

/** Altura en pantalla de la mira de construcción (coordenadas NDC: 0 = centro, 1 = arriba). */
export const AIM_NDC_Y = 0.2;
/** El modelo del lobo se hizo para radio 0.48: se agranda según su radio actual. */
const WOLF_SCALE = CONFIG.wolf.radius / 0.48;
/** Altura de la plataforma de la torre, donde se enganchan los puentes. */
const BRIDGE_Y = 2.2;

const PIECE_DEBRIS: Record<PieceId, number> = { fence: 0xa8743f, hedge: 0x4f9a3c, wall: 0x8c8a83, gate: 0x8a5a30, tower: 0x8c8a83 };

/** Icono de alerta (sprite que siempre mira a cámara). */
function makeIcon(text: string, color: string): THREE.SpriteMaterial {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.font = 'bold 54px Trebuchet MS, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#222';
  ctx.strokeText(text, 32, 35);
  ctx.fillStyle = color;
  ctx.fillText(text, 32, 35);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.SpriteMaterial({ map: tex, depthTest: false, fog: false });
}

/** Nombre flotando sobre las ovejas de los demás jugadores. */
function makeLabel(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const font = 'bold 40px Fredoka, Trebuchet MS, sans-serif';
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(text).width) + 28;
  c.height = 56;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(60, 40, 20, 0.85)';
  ctx.strokeText(text, c.width / 2, 30);
  ctx.fillStyle = '#fff6e0';
  ctx.fillText(text, c.width / 2, 30);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, fog: false }));
  sprite.scale.set((c.width / c.height) * 0.42, 0.42, 1);
  sprite.renderOrder = 10;
  return sprite;
}

/** Piña en vuelo (solo visual: la simulación ya sabe dónde cae). */
interface Flying {
  mesh: THREE.Mesh;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);

  private level = new THREE.Group();
  /** Modelo de la oveja que sigue la cámara. */
  private sheep: AnimatedModel = createSheep();
  /** Todas las ovejas por id (multijugador), con el nombre encima de las de los demás. */
  private flock = new Map<number, { model: AnimatedModel; label: THREE.Sprite | null; name: string }>();
  private wolves = new Map<number, AnimatedModel>();
  /** Construcciones por índice de celda. */
  private builds = new Map<number, THREE.Group>();
  private buildVersion = -1;
  private grass: { model: THREE.Group; data: Grass }[] = [];
  private ghosts = new Map<PieceId, THREE.Group>();
  private ghostMat = new THREE.MeshLambertMaterial({ color: 0x66ff88, transparent: true, opacity: 0.45, depthWrite: false });
  private raycaster = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private vfx = new Vfx();
  /** Acumuladores de emisión continua (partículas por segundo) y fase anterior de cada lobo. */
  private emit = new Map<string, number>();
  private wolfPhase = new Map<number, string>();
  private flying: Flying[] = [];
  private bridges = new THREE.Group();
  private bridgeVersion = -1;
  /** Vista previa del puente que se va a tender. */
  private bridgeLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: 0x66ff88, transparent: true, opacity: 0.9, depthTest: false }),
  );
  /** Dónde caerá la piña. */
  private aimMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.42, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }),
  );
  private camTarget = new THREE.Vector3();
  private gateLocal = new THREE.Vector3();
  private alertIcons = new Map<number, THREE.Sprite>();
  private iconSeen = makeIcon('!', '#ff4a3a');
  private iconSearch = makeIcon('?', '#ffd23a');
  private iconTrack = makeIcon('👃', '#ffffff');
  private overlays = new Overlays();
  private day: DayCycle;
  private rabbits = new Rabbits();
  /** Celdas por las que pasa el camino (ahí no se ponen flores). */
  private pathCells = new Set<number>();
  private shake = 0;
  private time = 0;
  /** Resolución adaptativa: baja si el juego no llega a ~45 fps y no vuelve a subir por encima de donde falló. */
  private pixelRatio = Math.min(window.devicePixelRatio, 2);
  private pixelRatioCap = this.pixelRatio;
  private perfFrames = 0;
  private perfStart = performance.now();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // comprime las luces altas sin cambiar los tonos (la lana deja de quemarse). Coste: nada.
    this.renderer.toneMapping = THREE.NeutralToneMapping;

    // cielo, luces, nubes y luciérnagas: cambian con la hora de la partida (mañana → noche)
    this.scene.background = new THREE.Color();
    this.scene.fog = new THREE.Fog(0xffffff, 30, 82);
    this.day = new DayCycle(this.renderer, this.scene);
    const sun = this.day.sun;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -45;
    sc.right = sc.top = 45;
    sc.near = 1;
    sc.far = 130;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.03;
    this.scene.add(this.day.group, this.day.hemi, sun, this.buildGround(), this.level, this.overlays.group, this.vfx.group);

    this.aimMarker.visible = false;
    this.bridgeLine.visible = false;
    this.bridgeLine.renderOrder = 10;
    this.scene.add(this.aimMarker, this.bridgeLine);
    for (const p of PIECES) {
      const ghost = createPiece(p, this.ghostMat);
      ghost.traverse((o) => (o.castShadow = o.receiveShadow = false));
      ghost.visible = false;
      this.ghosts.set(p, ghost);
      this.scene.add(ghost);
    }

    const resize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);
    resize();
  }

  private buildGround(): THREE.Mesh {
    const size = CONFIG.mapSize + 60;
    const geo = new THREE.PlaneGeometry(size, size, 80, 80);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const base = new THREE.Color(0xa9c972);
    const dark = new THREE.Color(0x88ad5c);
    const warm = new THREE.Color(0xc2cf6e); // claros secos, tono de hierba al sol
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k);
      const z = pos.getZ(k);
      const n = Math.sin(x * 0.31) * Math.cos(z * 0.27) * 0.5 + Math.sin(x * 0.9 + z * 0.7) * 0.25 + Math.random() * 0.25;
      c.copy(base).lerp(dark, Math.max(0, Math.min(1, n * 0.5 + 0.35)));
      const patch = Math.sin(x * 0.11 + 1.3) * Math.sin(z * 0.13 - 0.7);
      if (patch > 0.55) c.lerp(warm, Math.min(1, (patch - 0.55) * 2.5));
      colors.set([c.r, c.g, c.b], k * 3);
      pos.setY(k, (Math.random() - 0.5) * 0.04);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    ground.receiveShadow = true;
    return ground;
  }

  /** Reconstruye todo lo que depende del mundo (al empezar partida). */
  setWorld(world: World): void {
    this.level.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    });
    this.level.clear();
    this.flock.clear();
    this.wolves.clear();
    this.alertIcons.clear();
    this.overlays.reset();
    this.builds.clear();
    this.buildVersion = -1;
    this.bridges = new THREE.Group();
    this.bridgeVersion = -1;
    this.grass = [];
    this.vfx.reset();
    this.emit.clear();
    this.wolfPhase.clear();
    for (const f of this.flying) this.scene.remove(f.mesh);
    this.flying = [];

    const g = world.grid;
    const rng = world.rng;
    const pines: THREE.Matrix4[] = [];
    const rounds: THREE.Matrix4[] = [];
    const rocks: THREE.Matrix4[] = [];
    const m = (x: number, z: number, s: number, rot = rng() * Math.PI * 2, sy = s) =>
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, 0, z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot),
        new THREE.Vector3(s, sy, s),
      );

    for (let j = 0; j < g.n; j++) {
      for (let i = 0; i < g.n; i++) {
        const type = g.get(i, j);
        const c = g.center(i, j);
        const jx = (rng() - 0.5) * 0.2;
        const jz = (rng() - 0.5) * 0.2;
        if (type === Cell.Tree || type === Cell.Border) {
          const s = 0.85 + rng() * 0.45;
          (rng() < 0.6 ? pines : rounds).push(m(c.x + jx, c.z + jz, s, undefined, s * (0.9 + rng() * 0.4)));
        } else if (type === Cell.Rock) {
          rocks.push(m(c.x + jx, c.z + jz, 0.9 + rng() * 0.3));
        }
      }
    }
    // Bosque decorativo fuera del mapa
    const half = g.n / 2;
    for (let k = 0; k < 1400; k++) {
      const x = (rng() - 0.5) * (g.n + 50);
      const z = (rng() - 0.5) * (g.n + 50);
      if (Math.abs(x) < half + 0.5 && Math.abs(z) < half + 0.5) continue;
      const s = 0.9 + rng() * 0.8;
      (rng() < 0.7 ? pines : rounds).push(m(x, z, s, undefined, s * (0.9 + rng() * 0.5)));
    }

    this.level.add(
      buildInstanced(PINE, pines, rng),
      buildInstanced(ROUND_TREE, rounds, rng),
      buildInstanced(ROCK, rocks, rng),
      this.buildPath(world),
      this.buildMeadow(world),
    );

    this.sheep = this.sheepModel(world.sheep).model;
    this.rabbits.reset(world);
    this.level.add(this.rabbits.group);

    for (const data of world.grass) {
      const model = createGrass();
      model.position.set(data.x, 0, data.z);
      model.rotation.y = rng() * Math.PI * 2;
      this.level.add(model);
      this.grass.push({ model, data });
    }

    this.camTarget.set(world.sheep.pos.x, 1, world.sheep.pos.z);
  }

  /** Camino de tierra que cruza el prado de un lado a otro esquivando árboles y rocas (solo decorado). */
  private buildPath(world: World): THREE.Object3D {
    const g = world.grid;
    const rnd = mulberry32(world.seed ^ 0xa7);
    this.pathCells.clear();
    // celda libre más cercana a un punto
    const freeNear = (ti: number, tj: number): [number, number] | null => {
      for (let r = 0; r < 12; r++)
        for (let dj = -r; dj <= r; dj++)
          for (let di = -r; di <= r; di++)
            if (Math.max(Math.abs(di), Math.abs(dj)) === r && g.get(ti + di, tj + dj) === Cell.Empty) return [ti + di, tj + dj];
      return null;
    };
    const vertical = rnd() < 0.5;
    const a0 = Math.floor(g.n * (0.2 + rnd() * 0.25));
    const b0 = Math.floor(g.n * (0.55 + rnd() * 0.25));
    const sCell = freeNear(vertical ? a0 : 2, vertical ? 2 : a0);
    const eCell = freeNear(vertical ? b0 : g.n - 3, vertical ? g.n - 3 : b0);
    const cells = sCell && eCell ? findPath(g, sCell[0], sCell[1], eCell[0], eCell[1], 0) : null;
    if (!cells || cells.length < 8) return new THREE.Group();

    // curva suave por una de cada tres celdas, alargada hacia dentro del bosque por los dos extremos
    const pts: THREE.Vector3[] = [];
    const out = (c: [number, number], sign: number) => {
      const p = g.center(...c);
      return vertical ? new THREE.Vector3(p.x, 0, p.z + sign * 6) : new THREE.Vector3(p.x + sign * 6, 0, p.z);
    };
    pts.push(out(cells[0], -1));
    for (let k = 0; k < cells.length; k += 3) {
      const p = g.center(...cells[k]);
      pts.push(new THREE.Vector3(p.x, 0, p.z));
    }
    const last = g.center(...cells[cells.length - 1]);
    pts.push(new THREE.Vector3(last.x, 0, last.z), out(cells[cells.length - 1], 1));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const samples = curve.getSpacedPoints(Math.ceil(curve.getLength() / 0.4));

    // cinta: 4 vértices por muestra (borde de hierba, tierra, tierra, borde de hierba) → bordes difuminados
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const dirt = [new THREE.Color(0xd0ae7c), new THREE.Color(0xc8a472), new THREE.Color(0xd6b584)];
    const edge = new THREE.Color(0xa2bd6a);
    const tan = new THREE.Vector3();
    samples.forEach((p, k) => {
      tan.subVectors(samples[Math.min(k + 1, samples.length - 1)], samples[Math.max(k - 1, 0)]).normalize();
      const nx = -tan.z;
      const nz = tan.x;
      const w = 0.55 + Math.sin(k * 0.37) * 0.1 + rnd() * 0.06;
      const ow = w + 0.3 + rnd() * 0.1;
      for (const [off, c] of [[-ow, edge], [-w, dirt[Math.floor(rnd() * 3)]], [w, dirt[Math.floor(rnd() * 3)]], [ow, edge]] as const) {
        pos.push(p.x + nx * off, 0.03, p.z + nz * off);
        col.push(c.r, c.g, c.b);
      }
      for (let o = -1; o <= 1; o++) {
        const [ci, cj] = g.toCell(p.x + nx * o * w, p.z + nz * o * w);
        if (g.inBounds(ci, cj)) this.pathCells.add(cj * g.n + ci);
      }
      if (k === 0) return;
      const b = (k - 1) * 4;
      const c = k * 4;
      for (let q = 0; q < 3; q++) idx.push(b + q, b + q + 1, c + q, b + q + 1, c + q + 1, c + q);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    if (geo.attributes.normal.getY(0) < 0) geo.index!.array.reverse(); // que mire hacia arriba
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    );
    mesh.receiveShadow = true;
    return mesh;
  }

  /** Flores, setas y matojos por el prado. Solo decorado: usa su propio RNG para no alterar la simulación
   *  (las repeticiones dependen de world.rng). Unas pocas instancias, sin sombra propia. */
  private buildMeadow(world: World): THREE.Group {
    const g = world.grid;
    const rnd = mulberry32(world.seed ^ 0x5eed);
    const grassCells = new Set(world.grass.map((gr) => gr.j * g.n + gr.i));
    const flowers: THREE.Matrix4[] = [];
    const mushrooms: THREE.Matrix4[] = [];
    const tufts: THREE.Matrix4[] = [];
    const m = (x: number, z: number, s: number) =>
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, 0, z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2),
        new THREE.Vector3(s, s * (0.8 + rnd() * 0.5), s),
      );
    for (let j = 0; j < g.n; j++) {
      for (let i = 0; i < g.n; i++) {
        const type = g.get(i, j);
        const c = g.center(i, j);
        if (type === Cell.Tree || type === Cell.Border || type === Cell.Rock) {
          // setas al pie de árboles y rocas
          if (rnd() < 0.12) {
            const a = rnd() * Math.PI * 2;
            const n = 1 + Math.floor(rnd() * 3);
            for (let k = 0; k < n; k++) mushrooms.push(m(c.x + Math.cos(a) * 0.55 + (rnd() - 0.5) * 0.25, c.z + Math.sin(a) * 0.55 + (rnd() - 0.5) * 0.25, 0.7 + rnd() * 0.6));
          }
          continue;
        }
        if (type !== Cell.Empty || grassCells.has(j * g.n + i) || this.pathCells.has(j * g.n + i)) continue;
        // ramilletes: zonas con más flores que otras
        const field = Math.sin(i * 0.37 + 2) * Math.cos(j * 0.29 - 1) * 0.5 + 0.5;
        if (rnd() < 0.05 + field * 0.22) {
          const n = 2 + Math.floor(rnd() * 4);
          for (let k = 0; k < n; k++) flowers.push(m(c.x + (rnd() - 0.5) * 0.9, c.z + (rnd() - 0.5) * 0.9, 1.1 + rnd() * 0.6));
        }
        if (rnd() < 0.1) tufts.push(m(c.x + (rnd() - 0.5) * 0.6, c.z + (rnd() - 0.5) * 0.6, 0.45 + rnd() * 0.25));
      }
    }
    const group = new THREE.Group();
    group.add(buildInstanced(FLOWER, flowers, rnd), buildInstanced(MUSHROOM, mushrooms, rnd), buildInstanced(TUFT, tufts, rnd));
    group.traverse((o) => (o.castShadow = false));
    return group;
  }

  /** Modelo de una oveja (se crea la primera vez que aparece). */
  private sheepModel(s: Sheep) {
    let entry = this.flock.get(s.id);
    if (!entry) {
      entry = { model: createSheep(), label: null, name: '' };
      this.flock.set(s.id, entry);
      this.level.add(entry.model.root);
    }
    return entry;
  }

  /** Altura de la oveja: en lo alto de la torre o siguiendo la curva del puente. */
  private sheepY(world: World, s: Sheep): number {
    let y = s.elevation * CONFIG.tower.height;
    if (s.crossing) {
      // sigue la curva del puente (misma caída que createBridge)
      const a = world.grid.center(...s.crossing.from);
      const b = world.grid.center(...s.crossing.to);
      y -= Math.sin(s.crossing.t * Math.PI) * (0.12 + Math.hypot(b.x - a.x, b.z - a.z) * 0.05);
    }
    return y;
  }

  render(world: World, dt: number, yaw: number, pitch: number): void {
    this.time += dt;
    this.adaptResolution();
    const s = world.sheep;
    const sheepY = this.sheepY(world, s);

    for (const o of world.flock) {
      const entry = this.sheepModel(o);
      const m = entry.model;
      const y = o === s ? sheepY : this.sheepY(world, o);
      m.root.position.set(o.pos.x, y, o.pos.z);
      m.root.rotation.y = o.facing;
      m.root.visible = !o.caught && world.state !== 'lost';
      m.update(dt, { speed: o.speed, eating: o.eating, stunned: o.stun > 0, tired: o.exhausted });
      // nombre encima de las demás ovejas
      const showLabel = o !== s && o.name !== '' && m.root.visible;
      if (entry.label && (entry.name !== o.name || !showLabel)) {
        this.level.remove(entry.label);
        entry.label.material.map?.dispose();
        entry.label.material.dispose();
        entry.label = null;
      }
      if (showLabel && !entry.label) {
        entry.label = makeLabel(o.name);
        entry.name = o.name;
        this.level.add(entry.label);
      }
      entry.label?.position.set(o.pos.x, y + 1.55, o.pos.z);
    }
    this.sheep = this.sheepModel(s).model;
    if (this.flock.size > world.flock.length) {
      for (const [id, entry] of this.flock) {
        if (world.flock.some((o) => o.id === id)) continue;
        this.level.remove(entry.model.root);
        if (entry.label) this.level.remove(entry.label);
        this.flock.delete(id);
      }
    }

    for (const w of world.wolves) {
      let model = this.wolves.get(w.id);
      if (!model) {
        model = createWolf();
        model.root.scale.setScalar(WOLF_SCALE);
        this.wolves.set(w.id, model);
        this.level.add(model.root);
      }
      model.root.position.set(w.pos.x, 0, w.pos.z);
      model.root.rotation.y = w.heading;
      model.update(dt, { speed: w.speed, attacking: w.attacking !== null, pose: w.phase, mode: w.mode });

      let icon = this.alertIcons.get(w.id);
      if (!icon) {
        icon = new THREE.Sprite(this.iconSeen);
        icon.scale.set(0.6, 0.6, 1);
        this.alertIcons.set(w.id, icon);
        this.level.add(icon);
      }
      const mat =
        w.mode === 'hunt' ? this.iconSeen
        : w.mode === 'track' ? this.iconTrack
        : w.mode === 'search' || w.mode === 'investigate' ? this.iconSearch
        : null;
      icon.visible = mat !== null;
      if (mat) icon.material = mat;
      icon.position.set(w.pos.x, 2.1 * WOLF_SCALE + Math.sin(this.time * 6 + w.id) * 0.08, w.pos.z);
    }
    if (this.wolves.size > world.wolves.length) {
      const alive = new Set(world.wolves.map((w) => w.id));
      for (const [id, model] of this.wolves) {
        if (alive.has(id)) continue;
        this.level.remove(model.root);
        this.wolves.delete(id);
        const icon = this.alertIcons.get(id);
        if (icon) this.level.remove(icon);
        this.alertIcons.delete(id);
      }
    }

    this.rabbits.update(world, dt, this.camera.position);
    this.syncBuilds(world);
    if (dt > 0) this.animateGates(world, dt);
    this.syncBridges(world);

    for (const { model, data } of this.grass) {
      const target = data.amount > 0 ? 0.35 + 0.65 * (data.amount / CONFIG.grass.amount) : 0.12;
      const sc = model.scale.y + (target - model.scale.y) * Math.min(1, dt * 6);
      model.scale.set(1, sc, 1);
      // brisa: cada mata se mece con su propio desfase
      model.rotation.x = Math.sin(this.time * 1.7 + data.x * 0.5) * 0.06;
      model.rotation.z = Math.cos(this.time * 1.3 + data.z * 0.5) * 0.06;
    }

    // Fantasma: la pieza elegida (verde/rojo) o, sobre una construcción, ella misma en naranja (desmontar)
    const bt = world.buildTarget;
    const shown = bt ? (bt.removable ?? (bt.item === 'pinecone' || bt.item === 'bridge' ? null : bt.item)) : null;
    this.aimMarker.visible = bt?.item === 'pinecone' || bt?.item === 'bridge';
    this.bridgeLine.visible = bt?.item === 'bridge' && s.tower !== null;
    if (bt && this.bridgeLine.visible) {
      const c = world.grid.center(...s.tower!);
      const pos = this.bridgeLine.geometry.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, c.x, BRIDGE_Y, c.z);
      pos.setXYZ(1, bt.x, BRIDGE_Y, bt.z);
      pos.needsUpdate = true;
      this.bridgeLine.geometry.computeBoundingSphere();
      (this.bridgeLine.material as THREE.LineBasicMaterial).color.setHex(bt.valid ? 0x66ff88 : 0xff5555);
    }
    if (bt && this.aimMarker.visible) {
      this.aimMarker.position.set(bt.x, 0.07, bt.z);
      this.aimMarker.material.color.setHex(bt.valid ? 0xffffff : 0xff5555);
      this.aimMarker.scale.setScalar(1 + Math.sin(this.time * 6) * 0.1);
    }
    for (const [p, ghost] of this.ghosts) ghost.visible = p === shown;
    if (bt && shown) {
      const ghost = this.ghosts.get(shown)!;
      const c = world.grid.center(bt.i, bt.j);
      ghost.position.set(c.x, 0, c.z);
      ghost.rotation.y = shown === 'gate' ? this.gateRotation(world, bt.i, bt.j) : 0;
      ghost.scale.setScalar(bt.removable ? 1.08 : 1);
      this.ghostMat.color.setHex(bt.removable ? 0xffa53a : bt.valid ? 0x66ff88 : 0xff5555);
      this.ghostMat.opacity = 0.35 + Math.sin(this.time * 6) * 0.1;
    }

    this.handleEvents(world);
    if (dt > 0) this.continuousVfx(world, dt, sheepY);
    this.overlays.update(world, dt);
    this.vfx.update(dt, this.camTarget, this.time);
    this.updateFlying(dt);
    this.updateCamera(world, dt, yaw, pitch);
    this.day.update(world, dt, this.time, this.camera, this.camTarget, this.sheep.root.position);
    this.vfx.setMotes(1 - this.day.night);
    this.renderer.render(this.scene, this.camera);
  }

  private syncBuilds(world: World): void {
    const g = world.grid;
    if (g.version !== this.buildVersion) {
      this.buildVersion = g.version;
      for (let k = 0; k < g.cells.length; k++) {
        const piece = isBuilt(g.cells[k]) ? pieceOfCell(g.cells[k]) : null;
        const existing = this.builds.get(k);
        if (existing && existing.userData.piece !== piece) {
          this.level.remove(existing);
          this.builds.delete(k);
        }
        if (piece && existing?.userData.piece !== piece) {
          const f = createPiece(piece);
          const i = k % g.n;
          const j = Math.floor(k / g.n);
          const c = g.center(i, j);
          f.position.set(c.x, 0, c.z);
          f.rotation.y = piece === 'gate' ? this.gateRotation(world, i, j) : (Math.floor(Math.random() * 4) * Math.PI) / 2;
          f.userData.piece = piece;
          f.userData.hp = g.hp[k];
          f.userData.wobble = 0;
          f.scale.setScalar(0.01);
          this.level.add(f);
          this.builds.set(k, f);
        }
      }
    }
    for (const [k, f] of this.builds) {
      const hp = g.hp[k];
      if (hp < f.userData.hp) f.userData.wobble = 1;
      f.userData.hp = hp;
      f.userData.wobble = Math.max(0, f.userData.wobble - 0.05);
      const ratio = hp / CONFIG.pieces[f.userData.piece as PieceId].hp;
      const grow = Math.min(1, f.scale.x + 0.12);
      f.scale.set(grow, grow * (0.55 + 0.45 * ratio), grow);
      f.rotation.z = Math.sin(this.time * 40) * 0.05 * f.userData.wobble;
    }
  }

  private syncBridges(world: World): void {
    if (world.bridgeVersion === this.bridgeVersion) return;
    this.bridgeVersion = world.bridgeVersion;
    this.level.remove(this.bridges);
    this.bridges = new THREE.Group();
    for (const br of world.bridges) {
      const a = world.grid.center(...br.a);
      const b = world.grid.center(...br.b);
      this.bridges.add(createBridge(new THREE.Vector3(a.x, BRIDGE_Y, a.z), new THREE.Vector3(b.x, BRIDGE_Y, b.z)));
    }
    this.level.add(this.bridges);
  }

  /**
   * Las hojas de las puertas se abren al acercarse la oveja, hacia el lado al que va,
   * y se cierran solas con un muelle (rebotan un poco al cerrarse).
   */
  private animateGates(world: World, dt: number): void {
    for (const f of this.builds.values()) {
      const leaves = f.userData.leaves as THREE.Object3D[] | undefined;
      if (!leaves) continue;
      const d = f.userData;
      d.open ??= 0;
      d.vel ??= 0;
      d.side ??= 1;
      // la oveja más cercana en coordenadas de la puerta: z es la dirección en la que se cruza
      let p: THREE.Vector3 | null = null;
      for (const s of world.flock) {
        if (s.caught || s.elevation >= 0.5) continue;
        const q = f.worldToLocal(this.gateLocal.set(s.pos.x, 0, s.pos.z));
        if (Math.abs(q.x) < 0.7 && Math.abs(q.z) < 1.05) {
          p = q;
          break;
        }
      }
      const near = p !== null;
      // al empezar a abrirse, decide el lado: se abre hacia donde va la oveja
      if (p && d.open < 0.05 && d.vel <= 0) d.side = p.z < 0 ? 1 : -1;
      const target = near ? 1.35 : 0;
      d.vel += (90 * (target - d.open) - 8 * d.vel) * dt;
      d.open = Math.max(-0.2, Math.min(1.6, d.open + d.vel * dt));
      const a = d.open * d.side;
      leaves[0].rotation.y = -a;
      leaves[1].rotation.y = Math.PI + a;
    }
  }

  /** La puerta se alinea con lo que tenga a los lados (por defecto se cruza en dirección Z). */
  private gateRotation(world: World, i: number, j: number): number {
    const g = world.grid;
    const alongX = Number(g.isSolid(i - 1, j)) + Number(g.isSolid(i + 1, j));
    const alongZ = Number(g.isSolid(i, j - 1)) + Number(g.isSolid(i, j + 1));
    return alongZ > alongX ? Math.PI / 2 : 0;
  }

  /** Punto del suelo bajo la mira de construcción (con la cámara del último frame). */
  aimPoint(): Vec2 | null {
    this.raycaster.setFromCamera(new THREE.Vector2(0, AIM_NDC_Y), this.camera);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.ground, hit)) return { x: hit.x, z: hit.z };
    // mirando al horizonte: muy lejos en la dirección de la cámara (World lo acerca a buildRange)
    const d = this.raycaster.ray.direction;
    return { x: this.camera.position.x + d.x * 100, z: this.camera.position.z + d.z * 100 };
  }

  private handleEvents(world: World): void {
    for (const e of world.events) {
      switch (e.type) {
        case 'built':
          this.vfx.burst(e.x, 0.3, e.z, 0xd8b98a, 10, 2);
          this.vfx.dustRing(e.x, e.z, 10, 1.5);
          break;
        case 'dismantled':
          this.vfx.burst(e.x, 0.5, e.z, PIECE_DEBRIS[e.piece ?? 'fence'], 12, 2.5);
          this.vfx.dust(e.x, e.z, 5, 0.4);
          break;
        case 'bitten':
          this.vfx.burst(e.x, 0.6, e.z, PIECE_DEBRIS[e.piece ?? 'fence'], 4, 2.5);
          this.vfx.dust(e.x, e.z, 2, 0.3, 0xcdb98f, 0.22, 0.4);
          break;
        case 'destroyed':
          this.vfx.burst(e.x, 0.5, e.z, PIECE_DEBRIS[e.piece ?? 'fence'], 24, 4.5);
          this.vfx.dust(e.x, e.z, 10, 0.6, 0xbfae8a, 0.45, 0.3);
          this.vfx.dustRing(e.x, e.z, 12, 3);
          this.shake = Math.max(this.shake, 0.25);
          break;
        case 'wolfSpawn':
          this.vfx.burst(e.x, 0.5, e.z, 0x6f747d, 14, 3);
          this.vfx.dust(e.x, e.z, 8, 0.6, 0x9a9488, 0.4);
          break;
        case 'dash':
          this.vfx.burst(e.x, 0.3, e.z, 0xf4f0e6, 8, 2);
          this.vfx.dustRing(e.x, e.z, 8, 2.2);
          break;
        case 'noise':
          this.overlays.ring(e.x, e.z, e.r ?? 5, 0xfff4d6);
          break;
        case 'howl':
          if (e.r) this.overlays.ring(e.x, e.z, e.r, 0xff4a3a);
          // vaho del aullido
          this.vfx.dust(e.x, e.z, 6, 0.2, 0xe8eef2, 0.22, 1.3);
          break;
        case 'climb':
          this.vfx.burst(e.x, 2.2, e.z, 0xf4f0e6, 6, 1.5);
          break;
        case 'fall':
          this.vfx.burst(e.x, 0.4, e.z, 0xf4f0e6, 16, 3);
          this.vfx.dustRing(e.x, e.z, 14, 3);
          this.shake = Math.max(this.shake, 0.35);
          break;
        case 'throw': {
          const mesh = createPinecone();
          this.scene.add(mesh);
          const thrower = world.flock.find((o) => o.id === e.id) ?? world.sheep;
          const from = new THREE.Vector3(e.x, 0.9 + thrower.elevation * CONFIG.tower.height, e.z);
          this.flying.push({ mesh, from, to: new THREE.Vector3(e.tx ?? e.x, 0.1, e.tz ?? e.z), t: 0 });
          break;
        }
        case 'land':
          this.vfx.burst(e.x, 0.2, e.z, 0x6e4a2a, 8, 2.5);
          this.vfx.dust(e.x, e.z, 4, 0.2);
          break;
        case 'caught':
          this.vfx.burst(e.x, 0.8, e.z, 0xf4f0e6, 60, 6);
          this.vfx.dust(e.x, e.z, 10, 0.5, 0xf4f0e6, 0.5, 0.6);
          this.vfx.dustRing(e.x, e.z, 16, 3.5);
          this.shake = 0.6;
          break;
        case 'closeCall':
          this.vfx.burst(e.x, 0.8, e.z, 0xf4f0e6, 8, 2.5);
          this.shake = Math.max(this.shake, 0.15);
          break;
        case 'windup':
          this.vfx.dust(e.x, e.z, 5, 0.5);
          break;
        case 'sniff':
          this.vfx.dust(e.x, e.z, 3, 0.3, 0xd9d4c4, 0.16, 0.3);
          break;
      }
    }
    world.events.length = 0;
  }

  /** Cuenta partículas pendientes a `rate` por segundo y devuelve cuántas tocan este frame. */
  private due(key: string, rate: number, dt: number): number {
    const acc = (this.emit.get(key) ?? 0) + rate * dt;
    const n = Math.floor(acc);
    this.emit.set(key, acc - n);
    return n;
  }

  /** Efectos que dependen del estado y no de un evento: polvo al correr, hierba al comer, estelas... */
  private continuousVfx(world: World, dt: number, sheepY: number): void {
    const s = world.sheep;
    const fx = Math.sin(s.facing);
    const fz = Math.cos(s.facing);

    if (s.elevation === 0 && !s.crossing) {
      const sprint = s.speed > CONFIG.sheep.walkSpeed * 1.1;
      const n = this.due('sheepDust', s.dashTimer > 0 ? 40 : sprint ? 12 : s.speed > 1 ? 2.5 : 0, dt);
      if (n) this.vfx.dust(s.pos.x - fx * 0.4, s.pos.z - fz * 0.4, n, 0.25, 0xcdb98f, sprint ? 0.28 : 0.2);
      if (s.dashTimer > 0) for (let k = this.due('sheepStreak', 60, dt); k > 0; k--) this.vfx.streak(s.pos.x, 0.7, s.pos.z);
    }
    if (s.eating) {
      const n = this.due('eat', 7, dt);
      if (n) this.vfx.grassBits(s.pos.x + fx * 0.75, 0.25, s.pos.z + fz * 0.75, n);
    }
    // vaho del jadeo cuando va sin aguante
    if (s.exhausted && this.due('pant', 2.5, dt)) {
      this.vfx.dust(s.pos.x + fx * 0.8, s.pos.z + fz * 0.8, 1, 0.05, 0xf0f4f6, 0.14, sheepY + 0.95);
    }
    this.vfx.setStars(s.stun > 0 && world.state !== 'lost', s.pos.x, sheepY + 1.45, s.pos.z, this.time);

    for (const w of world.wolves) {
      const id = `w${w.id}`;
      // aterriza del salto
      if (this.wolfPhase.get(w.id) === 'pounce' && w.phase !== 'pounce') this.vfx.dustRing(w.pos.x, w.pos.z, 10, 2.5);
      this.wolfPhase.set(w.id, w.phase);
      const pounce = w.phase === 'pounce';
      const n = this.due(id, pounce ? 30 : w.speed > CONFIG.wolf.speed * 0.9 ? 9 : w.speed > 2 ? 2 : 0, dt);
      if (n) {
        const bx = w.pos.x - Math.sin(w.heading) * 0.5 * WOLF_SCALE;
        const bz = w.pos.z - Math.cos(w.heading) * 0.5 * WOLF_SCALE;
        this.vfx.dust(bx, bz, n, 0.3, 0xbfae8a, pounce ? 0.32 : 0.26);
      }
      if (pounce) for (let k = this.due(`${id}s`, 50, dt); k > 0; k--) this.vfx.streak(w.pos.x, 0.8 * WOLF_SCALE, w.pos.z, 0xdde3ea);
    }

    // hojas que caen alrededor de la cámara
    for (let k = this.due('leaf', 1.6, dt); k > 0; k--) this.vfx.leaf(this.camTarget.x, this.camTarget.z, 14);
  }

  private updateFlying(dt: number): void {
    const dur = CONFIG.pinecone.flightTime;
    this.flying = this.flying.filter((f) => {
      f.t += dt;
      const k = Math.min(1, f.t / dur);
      f.mesh.position.lerpVectors(f.from, f.to, k);
      f.mesh.position.y += Math.sin(k * Math.PI) * Math.max(2, f.from.distanceTo(f.to) * 0.35); // parábola
      f.mesh.rotation.x += dt * 12;
      if (k < 1) return true;
      this.scene.remove(f.mesh);
      return false;
    });
  }

  private updateCamera(world: World, dt: number, yaw: number, pitch: number): void {
    const s = world.sheep;
    const k = 1 - Math.exp(-dt * 10);
    // subida a la torre la cámara también sube: se ve mucho más lejos
    this.camTarget.lerp(new THREE.Vector3(s.pos.x, 1 + s.elevation * CONFIG.tower.height, s.pos.z), k);
    const d = 9;
    const desired = new THREE.Vector3(
      this.camTarget.x + Math.sin(yaw) * Math.cos(pitch) * d,
      this.camTarget.y + Math.sin(pitch) * d,
      this.camTarget.z + Math.cos(yaw) * Math.cos(pitch) * d,
    );
    this.camera.position.copy(desired);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      const a = this.shake * 0.5;
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.y += (Math.random() - 0.5) * a;
    }
    this.camera.lookAt(this.camTarget);
    // la cámara se abre un poco al correr y al esquivar: sensación de velocidad
    const fov = 60 + (s.dashTimer > 0 ? 8 : s.speed > CONFIG.sheep.walkSpeed * 1.1 ? 4 : 0);
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-dt * (s.dashTimer > 0 ? 20 : 4)));
      this.camera.updateProjectionMatrix();
    }
  }

  private adaptResolution(): void {
    this.perfFrames++;
    const now = performance.now();
    const elapsed = now - this.perfStart;
    if (elapsed < 2000) return;
    const fps = (this.perfFrames * 1000) / elapsed;
    this.perfFrames = 0;
    this.perfStart = now;
    if (elapsed > 4000) return; // pestaña oculta o pausa larga: la medida no vale
    let pr = this.pixelRatio;
    if (fps < 45) {
      this.pixelRatioCap = pr - 0.01;
      pr = Math.max(0.6, pr - 0.15);
    } else if (fps > 57) {
      pr = Math.min(this.pixelRatioCap, pr + 0.1);
    }
    if (Math.abs(pr - this.pixelRatio) < 0.01) return;
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
}
