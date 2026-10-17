// Banco de pruebas de las animaciones (solo en desarrollo: /anim.html)
import * as THREE from 'three';
import { createPiece, createRabbit, createSheep, createWolf } from './render/models';
import { CONFIG } from './config';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd3f0);
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 100);
camera.position.set(5.5, 2.6, 5.5);
camera.lookAt(0, 0.7, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x5a7a3a, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(4, 8, 3);
sun.castShadow = true;
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshLambertMaterial({ color: 0x6dbb4a }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const sheep = createSheep();
sheep.root.position.x = -1.1;
const wolf = createWolf();
wolf.root.scale.setScalar(CONFIG.wolf.radius / 0.48);
wolf.root.position.x = 1.3;
scene.add(sheep.root, wolf.root);
// conejos: uno sentado y otro comiendo, delante (?only=rabbit para verlos de cerca)
const rabbits = [createRabbit(), createRabbit()];
rabbits[0].root.position.set(-0.35, 0, 1.7);
rabbits[0].root.rotation.y = 0.9;
rabbits[0].body.rotation.x = -0.45;
rabbits[1].root.position.set(0.45, 0, 1.9);
rabbits[1].root.rotation.y = -0.6;
rabbits[1].head.rotation.x = 0.55;
for (const r of rabbits) scene.add(r.root);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string) => Number($<HTMLInputElement>(id).value);
const on = (id: string) => $<HTMLInputElement>(id).checked;

// parámetros por URL para capturas: ?ss=5&ws=6&pose=windup&t=1.3&cam=side
const q = new URLSearchParams(location.search);
for (const [k, v] of q) {
  const el = document.getElementById(k) as HTMLInputElement | HTMLSelectElement | null;
  if (!el) continue;
  if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = v === '1';
  else el.value = v;
}
if (q.get('cam') === 'side') {
  camera.position.set(0.1, 1.1, 8);
  camera.lookAt(0.1, 0.75, 0);
}
if (q.get('ui') === '0') $('ui').style.display = 'none';
// ?only=sheep|wolf: un solo animal centrado y de cerca
const only = q.get('only');
if (only === 'rabbit') {
  sheep.root.visible = wolf.root.visible = false;
  camera.position.set(0.1, 0.9, 3.6);
  camera.lookAt(0.05, 0.2, 1.8);
}
// ?only=gate: tres puertas entre vallas (cerrada, entreabierta, abierta con la oveja pasando)
if (only === 'gate') {
  wolf.root.visible = false;
  for (const r of rabbits) r.root.visible = false;
  [0, 0.6, 1.35].forEach((open, k) => {
    const x = (k - 1) * 3.2;
    for (const dx of [-2, -1, 1, 2]) {
      const f = createPiece('fence');
      f.position.x = x + dx;
      scene.add(f);
    }
    const gate = createPiece('gate');
    gate.position.x = x;
    const [l, r] = gate.userData.leaves as THREE.Object3D[];
    l.rotation.y = -open;
    r.rotation.y = Math.PI + open;
    scene.add(gate);
  });
  sheep.root.position.set(3.2, 0, 0.15);
  camera.position.set(2.5, 4.2, 7.5);
  camera.lookAt(0, 0.4, 0);
}
if (only && only !== 'rabbit' && only !== 'gate') {
  (only === 'sheep' ? wolf : sheep).root.visible = false;
  const target = only === 'sheep' ? sheep.root : wolf.root;
  target.position.x = 0;
  const d = only === 'sheep' ? 3.2 : 5;
  if (q.get('cam') === 'side') camera.position.set(0, 0.9, d);
  else camera.position.set(d * 0.7, 1.6, d * 0.7);
  camera.lookAt(0, only === 'sheep' ? 0.55 : 0.85, 0);
}

let last = performance.now();
let angle = 0;
function frame(now: number) {
  const dt = q.has('freeze') ? 0 : Math.min(0.05, (now - last) / 1000) * num('slow');
  last = now;
  step(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function step(dt: number) {
  const ss = num('ss');
  const ws = num('ws');
  $('ssv').textContent = ss.toFixed(1);
  $('wsv').textContent = ws.toFixed(1);
  if (on('circle')) {
    angle += dt * 0.8;
    sheep.root.rotation.y = angle;
    wolf.root.rotation.y = angle;
  } else if (only === 'gate') {
    sheep.root.rotation.y = 0; // cruzando la puerta (hacia +Z)
  } else {
    sheep.root.rotation.y = Math.PI / 2;
    wolf.root.rotation.y = Math.PI / 2;
  }
  sheep.update(dt, { speed: ss, eating: on('eat'), stunned: on('stun'), tired: on('tired') });
  wolf.update(dt, {
    speed: ws,
    attacking: on('bite'),
    pose: $<HTMLSelectElement>('pose').value as 'chase',
    mode: $<HTMLSelectElement>('mode').value,
  });
}

// ?t=N: avanza N segundos simulados de golpe (capturas deterministas)
const warm = Number(q.get('t') ?? 0);
for (let k = 0; k < warm * 60; k++) step(1 / 60);
// ?strip=N&dt=0.04: N fotogramas seguidos en una cuadrícula (para revisar ciclos en una captura)
const strip = Number(q.get('strip') ?? 0);
if (strip > 0) {
  const cols = Math.ceil(Math.sqrt(strip));
  const rows = Math.ceil(strip / cols);
  const w = innerWidth / cols;
  const h = innerHeight / rows;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setScissorTest(true);
  for (let k = 0; k < strip; k++) {
    const x = (k % cols) * w;
    const y = innerHeight - (Math.floor(k / cols) + 1) * h;
    renderer.setViewport(x, y, w, h);
    renderer.setScissor(x, y, w, h);
    renderer.render(scene, camera);
    step(Number(q.get('dt') ?? 0.04));
  }
} else requestAnimationFrame(frame);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
