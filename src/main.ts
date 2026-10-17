import './style.css';
import { InputController } from './client/InputController';
import { Sfx, type VolumeKind } from './audio/Sfx';
import { GameRenderer } from './render/GameRenderer';
import { ITEMS } from './sim/pieces';
import { scoreOf } from './sim/score';
import { World } from './sim/World';
import { formatTime, Hud } from './ui/Hud';
import { Threats } from './ui/Threats';
import type { Replay } from './replay/replay';
import { ReplayPlayer } from './replay/ReplayPlayer';

type Mode = 'menu' | 'playing' | 'paused' | 'over' | 'replay';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new GameRenderer(canvas);
const controls = new InputController(canvas);
const hud = new Hud();
const sfx = new Sfx();
const threats = new Threats();

const screens = {
  menu: document.getElementById('menu')!,
  pause: document.getElementById('pause')!,
  end: document.getElementById('end')!,
};
const BEST_KEY = 'wolfsheep.best';
const BEST_SCORE_KEY = 'wolfsheep.bestScore';
const SLOWMO_SCALE = 0.3;
const SLOWMO_TIME = 0.5; // segundos reales

let world = new World();
renderer.setWorld(world);
let mode: Mode = 'menu';
let replay: ReplayPlayer | null = null;
let slowmo = 0;

// ---------------------------------------------------------------- repeticiones (?replay=nombre)
const replayName = new URLSearchParams(location.search).get('replay');
if (replayName) {
  showScreen(null);
  fetch(`replays/${replayName}.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`No existe replays/${replayName}.json`);
      return r.json() as Promise<Replay>;
    })
    .then((data) => {
      replay = new ReplayPlayer(data);
      world = replay.world;
      renderer.setWorld(world);
      mode = 'replay';
      controls.enabled = true;
      controls.spectator = true;
      hud.show(true);
    })
    .catch((e) => {
      document.getElementById('end-title')!.textContent = 'Error';
      document.getElementById('end-text')!.textContent = String(e.message ?? e);
      showScreen('end');
    });
  window.addEventListener('keydown', (e) => {
    if (!replay) return;
    if (e.code === 'Space') replay.paused = !replay.paused;
    if (e.code === 'KeyR') replay.restart();
    if (e.code === 'Digit1') replay.speed = 1;
    if (e.code === 'Digit2') replay.speed = 2;
    if (e.code === 'Digit4') replay.speed = 4;
  });
}

function loadBest(key = BEST_KEY): number {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}
function saveBest(t: number, key = BEST_KEY): void {
  try {
    localStorage.setItem(key, String(t));
  } catch {
    /* sin almacenamiento */
  }
}

/** Texto grande y rápido en pantalla ("¡Por los pelos!"). */
const calloutEl = document.getElementById('callout')!;
function callout(text: string, cls: string): void {
  calloutEl.textContent = text;
  calloutEl.className = '';
  void calloutEl.offsetWidth; // reiniciar la animación
  calloutEl.className = `show ${cls}`;
}

/** Momentos épicos: mirar los eventos del frame (antes de que el render los consuma). */
function epicMoments(): void {
  for (const e of world.events) {
    if (e.type === 'closeCall') {
      callout('¡Por los pelos!', 'close');
      if (mode === 'playing') slowmo = SLOWMO_TIME;
    } else if (e.type === 'escape') {
      callout('¡Despistado!', 'escape');
    }
  }
}

function showScreen(name: keyof typeof screens | null): void {
  for (const [k, el] of Object.entries(screens)) el.classList.toggle('hidden', k !== name);
}

function updateBestLabel(): void {
  const best = loadBest();
  document.getElementById('best')!.textContent = best > 0 ? `Récord: ${formatTime(best)}` : '';
}

function start(): void {
  world = new World();
  renderer.setWorld(world);
  controls.reset();
  controls.yaw = 0;
  controls.pitch = 0.55;
  mode = 'playing';
  controls.enabled = true;
  showScreen(null);
  hud.show(true);
  sfx.start();
  controls.lock();
}

function pause(): void {
  if (mode !== 'playing') return;
  mode = 'paused';
  sfx.stopLoops();
  controls.enabled = false;
  showScreen('pause');
}

function resume(): void {
  mode = 'playing';
  controls.enabled = true;
  showScreen(null);
  controls.lock();
}

function end(): void {
  mode = 'over';
  controls.enabled = false;
  controls.unlock();
  const t = world.survived;
  const prev = loadBest();
  const record = t > prev;
  if (record) saveBest(t);
  const won = world.state === 'won';
  document.getElementById('end-title')!.textContent = won ? '¡Has sobrevivido!' : '¡Te han cazado!';
  document.getElementById('end-text')!.textContent =
    `Tiempo: ${formatTime(t)}` + (record ? ' · ¡Nuevo récord!' : prev > 0 ? ` · Récord: ${formatTime(prev)}` : '');

  const score = scoreOf(world);
  const prevScore = loadBest(BEST_SCORE_KEY);
  if (score.total > prevScore) saveBest(score.total, BEST_SCORE_KEY);
  const rows = score.lines.map((l) => `<tr><td>${l.label}</td><td>${l.count}</td><td>+${l.points}</td></tr>`).join('');
  document.getElementById('end-score')!.innerHTML =
    `<table>${rows}<tr class="total"><td>Total</td><td></td><td>${score.total}</td></tr></table>` +
    `<p>${score.total > prevScore ? (prevScore > 0 ? '⭐ ¡Récord de puntos!' : '') : `Récord: ${prevScore} puntos`}</p>`;
  // un momento para ver qué ha pasado antes de mostrar la pantalla
  setTimeout(() => {
    if (mode === 'over') showScreen('end');
  }, 900);
}

document.getElementById('play')!.addEventListener('click', start);
document.getElementById('again')!.addEventListener('click', start);
document.getElementById('resume')!.addEventListener('click', resume);
document.addEventListener('pointerlockchange', () => {
  if (!controls.locked && mode === 'playing') pause();
});
// volumen de música y sonidos (menú y pausa): los deslizadores del mismo tipo van sincronizados
const volumeInputs = [...document.querySelectorAll<HTMLInputElement>('input[data-vol]')];
for (const input of volumeInputs) {
  const kind = input.dataset.vol as VolumeKind;
  input.value = String(Math.round(sfx.getVolume(kind) * 100));
  input.addEventListener('input', () => {
    sfx.start();
    sfx.setVolume(kind, Number(input.value) / 100);
    for (const other of volumeInputs) if (other !== input && other.dataset.vol === kind) other.value = input.value;
  });
  input.addEventListener('change', () => input.blur()); // que las teclas vuelvan al juego
}
window.addEventListener('pointerdown', () => sfx.start()); // el audio solo arranca tras un gesto (p. ej. en repeticiones)
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM') sfx.toggleMute();
  if (e.code === 'KeyP' || (e.code === 'Escape' && !controls.locked)) {
    if (mode === 'playing') pause();
    else if (mode === 'paused') resume();
  }
});

updateBestLabel();

// Acceso para depurar desde la consola del navegador (solo en desarrollo)
if (import.meta.env.DEV) {
  Object.defineProperty(window, '__game', { get: () => ({ world, renderer, controls, mode }) });
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (mode === 'playing') {
    controls.update(dt);
    controls.aimAt = controls.buildMode ? renderer.aimPoint() : null;
    slowmo = Math.max(0, slowmo - dt);
    world.update(slowmo > 0 ? dt * SLOWMO_SCALE : dt, controls.getInput());
    if (world.state !== 'playing') end();
  } else if (mode === 'replay' && replay) {
    controls.update(dt);
    replay.update(dt);
  } else if (mode === 'menu') {
    controls.yaw += dt * 0.15; // cámara girando lentamente en el menú
  }

  epicMoments();
  // el sonido lee los eventos antes de que el render los consuma
  if (mode === 'playing' || mode === 'replay' || mode === 'over') sfx.update(world, dt, controls.yaw, mode !== 'over');
  renderer.render(world, mode === 'paused' ? 0 : dt, controls.yaw, controls.pitch);
  threats.update(world, renderer.camera, dt, mode === 'playing' || mode === 'replay');
  hud.update(world, mode === 'replay' ? false : controls.buildMode, mode === 'replay' ? null : ITEMS[controls.item]);
  if (replay) {
    const r = replay.replay;
    const bar = document.getElementById('replay-bar')!;
    bar.classList.remove('hidden');
    bar.textContent =
      `${replay.paused ? '⏸' : '▶'} Repetición · cerebro: ${r.brain} · semilla ${r.seed} · x${replay.speed}` +
      (replay.finished ? (r.result === 'won' ? ' · ¡GANA!' : ' · CAZADA') : '');
    document.getElementById('hint')!.textContent = replay.lastDecision ? `🤖 ${replay.lastDecision}` : '';
    document.getElementById('help')!.textContent = 'Espacio pausa · R reiniciar · 1/2/4 velocidad · Arrastrar ratón / flechas: cámara';
  }
  if (mode === 'over') updateBestLabel();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
