import './style.css';
import './touch.css';
import { InputController } from './client/InputController';
import { TouchControls } from './client/TouchControls';
import { isTouchMode } from './client/touchMode';
import { Sfx, type VolumeKind } from './audio/Sfx';
import { GameRenderer } from './render/GameRenderer';
import { LAST_NIGHT, NIGHTS, itemsForNight } from './sim/nights';
import { itemInfo, ITEMS } from './sim/pieces';
import { scoreOf } from './sim/score';
import { World } from './sim/World';
import { formatTime, Hud } from './ui/Hud';
import { Threats } from './ui/Threats';
import type { Replay } from './replay/replay';
import { ReplayPlayer } from './replay/ReplayPlayer';
import { NetClient } from './net/NetClient';
import { MAX_NAME, MAX_ROOM } from './net/protocol';
import { emptyInput } from './sim/entities';

type Mode = 'menu' | 'playing' | 'paused' | 'over' | 'replay';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new GameRenderer(canvas);
const controls = new InputController(canvas);
const hud = new Hud();
const sfx = new Sfx();
const threats = new Threats();
const touch = new TouchControls(controls, () => pause());

/** Al entrar a jugar: con ratón se captura el puntero; con el dedo, pantalla completa (si el navegador deja). */
function grabInput(): void {
  if (!isTouchMode()) {
    controls.lock();
    return;
  }
  const el = document.documentElement;
  if (document.fullscreenElement || !el.requestFullscreen) return;
  el.requestFullscreen({ navigationUI: 'hide' })
    .then(() => {
      // en el móvil se juega mejor apaisado; si no se puede bloquear, da igual
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      o?.lock?.('landscape').catch(() => {});
    })
    .catch(() => {});
}

const screens = {
  menu: document.getElementById('menu')!,
  pause: document.getElementById('pause')!,
  end: document.getElementById('end')!,
  online: document.getElementById('online')!,
};
const BEST_KEY = 'wolfsheep.best';
const BEST_SCORE_KEY = 'wolfsheep.bestScore';
const NIGHT_KEY = 'wolfsheep.night'; // última noche desbloqueada (índice)
const KID_KEY = 'wolfsheep.kid'; // modo niño (ver CONFIG.kid): '1' activado
const SLOWMO_SCALE = 0.3;
const SLOWMO_TIME = 0.5; // segundos reales

let world = new World();
renderer.setWorld(world);
let mode: Mode = 'menu';
let replay: ReplayPlayer | null = null;
/** Partida multijugador (null en solitario). */
let net: NetClient | null = null;
let slowmo = 0;
/** Modo niño elegido en el menú (se aplica a mi oveja en la próxima partida). */
let kidMode = loadText(KID_KEY) === '1';
/** Récord de tiempo de cada noche (el de la última noche es el récord de siempre). */
const bestKey = (night: number) => (night === LAST_NIGHT ? BEST_KEY : `${BEST_KEY}.${night + 1}`);
const unlockedNight = () => Math.min(LAST_NIGHT, loadBest(NIGHT_KEY));
let selectedNight = unlockedNight();

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

/** Texto grande y rápido en pantalla ("¡Por los pelos!"), con una línea pequeña opcional debajo. */
const calloutEl = document.getElementById('callout')!;
function callout(text: string, cls: string, sub = ''): void {
  calloutEl.textContent = text;
  if (sub) calloutEl.insertAdjacentHTML('beforeend', `<small>${sub}</small>`);
  calloutEl.className = '';
  void calloutEl.offsetWidth; // reiniciar la animación
  calloutEl.className = `show ${cls}`;
}

/** Momentos épicos: mirar los eventos del frame (antes de que el render los consuma). */
function epicMoments(): void {
  for (const e of world.events) {
    if (e.type === 'rescue') {
      const s = world.flock.find((o) => o.id === e.id);
      if (!s) continue;
      const lives = s.lives > 0 ? `Te quedan ${'❤️'.repeat(s.lives)}` : 'Es tu última oportunidad: ¡cuidado!';
      if (s === world.sheep) callout('¡Uf, a salvo!', 'escape', lives);
      else callout(`¡${s.name || 'Una oveja'} se ha salvado!`, 'escape');
    } else if (e.type === 'caught' && net && world.flock.length > 1) {
      // multijugador: avisar de quién ha caído (si caen todas, ya lo dice la pantalla final)
      if (world.alive.length === 0) continue;
      const mine = e.id === net.id;
      const name = world.flock.find((s) => s.id === e.id)?.name || 'una oveja';
      callout(mine ? '¡Te han cazado!' : `¡Han cazado a ${name}!`, 'close', mine ? 'Ahora miras a tus compañeras' : '');
    } else if (e.type === 'closeCall') {
      if (net && e.id !== net.id) continue;
      callout('¡Por los pelos!', 'close');
      // en multijugador el tiempo es el mismo para todos: sin cámara lenta
      if (mode === 'playing' && !net) slowmo = SLOWMO_TIME;
    } else if (e.type === 'escape') {
      callout('¡Despistado!', 'escape');
    } else if (e.type === 'nightfall') {
      callout('🌙 Anochece', 'night', 'Los lobos ven peor… pero huelen mejor');
    }
  }
}

function showScreen(name: keyof typeof screens | null): void {
  for (const [k, el] of Object.entries(screens)) el.classList.toggle('hidden', k !== name);
}

function updateBestLabel(): void {
  const best = loadBest(bestKey(selectedNight));
  document.getElementById('best')!.textContent = best > 0 ? `Récord de la noche ${selectedNight + 1}: ${formatTime(best)}` : '';
}

/** Botones del menú para elegir noche: las desbloqueadas se pueden elegir. */
function renderNights(): void {
  const box = document.getElementById('nights')!;
  box.innerHTML = '';
  NIGHTS.forEach((_, k) => {
    const b = document.createElement('button');
    const locked = k > unlockedNight();
    b.textContent = locked ? `🔒 Noche ${k + 1}` : `Noche ${k + 1}`;
    b.disabled = locked;
    b.classList.toggle('selected', k === selectedNight);
    b.addEventListener('click', () => {
      selectedNight = k;
      renderNights();
      updateBestLabel();
    });
    box.appendChild(b);
  });
}

function toMenu(): void {
  mode = 'menu';
  hud.show(false);
  renderNights();
  updateBestLabel();
  showScreen('menu');
}

/** Prepara los controles para una partida nueva (con o sin modo niño). */
function resetControls(): void {
  controls.kid = kidMode;
  controls.reset();
  controls.items = world.items;
  controls.yaw = 0;
  // modo niño: cámara fija algo más alta para ver mejor alrededor
  controls.pitch = kidMode ? 0.85 : 0.55;
}

function start(night = selectedNight): void {
  selectedNight = night;
  world = new World(undefined, night, [{ id: 0, name: '', kid: kidMode }]);
  renderer.setWorld(world);
  resetControls();
  mode = 'playing';
  controls.enabled = true;
  showScreen(null);
  hud.show(true);
  sfx.start();
  grabInput();
}

function pause(): void {
  if (mode !== 'playing') return;
  mode = 'paused';
  if (net) net.idle();
  else sfx.stopLoops();
  controls.enabled = false;
  document.getElementById('pause-online')!.classList.toggle('hidden', !net);
  showScreen('pause');
}

function resume(): void {
  mode = 'playing';
  controls.enabled = true;
  showScreen(null);
  grabInput();
}

function end(): void {
  mode = 'over';
  controls.enabled = false;
  controls.unlock();
  setEndButtons();
  if (net) {
    endOnline();
    return;
  }
  const t = world.survived;
  const night = world.nightIndex;
  const prev = loadBest(bestKey(night));
  const record = t > prev;
  if (record) saveBest(t, bestKey(night));
  const won = world.state === 'won';
  const hasNext = won && night < LAST_NIGHT;
  if (hasNext && night + 1 > unlockedNight()) saveBest(night + 1, NIGHT_KEY);
  document.getElementById('end-title')!.textContent = won
    ? night === LAST_NIGHT
      ? '¡Has sobrevivido a la última noche!'
      : `¡Has sobrevivido a la noche ${night + 1}!`
    : '¡Te han cazado!';
  const fresh = hasNext ? itemsForNight(night + 1).filter((id) => !world.items.includes(id)) : [];
  document.getElementById('end-text')!.innerHTML =
    `Tiempo: ${formatTime(t)}` +
    (record ? ' · ¡Nuevo récord!' : prev > 0 ? ` · Récord: ${formatTime(prev)}` : '') +
    (fresh.length ? `<br>🔓 Desbloqueas: ${fresh.map((id) => `${itemInfo(id).icon} ${itemInfo(id).name}`).join(', ')}` : '');
  const next = document.getElementById('next')!;
  next.classList.toggle('hidden', !hasNext);
  next.textContent = `Noche ${night + 2} ▶`;

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

/** Final de una partida multijugador: sin récords; si ganáis, se desbloquea la siguiente noche y el anfitrión puede empezarla. */
function endOnline(): void {
  const won = world.state === 'won';
  const night = world.nightIndex;
  const hasNext = won && night < LAST_NIGHT;
  if (hasNext && night + 1 > unlockedNight()) saveBest(night + 1, NIGHT_KEY);
  if (hasNext) onlineNight = night + 1;
  const next = document.getElementById('next')!;
  next.classList.toggle('hidden', !hasNext || !net?.isHost);
  next.textContent = `Noche ${night + 2} ▶`;
  const alive = world.alive.map((s) => s.name).join(', ');
  document.getElementById('end-title')!.textContent = won ? `¡Habéis sobrevivido a la noche ${world.nightIndex + 1}!` : '¡Os han cazado a todas!';
  document.getElementById('end-text')!.innerHTML = `Tiempo: ${formatTime(world.survived)}` + (won ? `<br>🐑 Llegan al amanecer: ${alive}` : '');
  const score = scoreOf(world);
  const rows = score.lines.map((l) => `<tr><td>${l.label}</td><td>${l.count}</td><td>+${l.points}</td></tr>`).join('');
  document.getElementById('end-score')!.innerHTML = `<table>${rows}<tr class="total"><td>Total del rebaño</td><td></td><td>${score.total}</td></tr></table>`;
  setTimeout(() => {
    if (mode === 'over') showScreen('end');
  }, 900);
}

/** En multijugador, la pantalla final solo ofrece volver a la sala (o al menú). */
function setEndButtons(): void {
  if (net) document.getElementById('next')!.classList.add('hidden');
  document.getElementById('again')!.classList.toggle('hidden', !!net);
  document.getElementById('to-room')!.classList.toggle('hidden', !net);
}

// ---------------------------------------------------------------- multijugador

const NAME_KEY = 'wolfsheep.name';
const ROOM_KEY = 'wolfsheep.room';
const $input = (id: string) => document.getElementById(id) as HTMLInputElement;
let onlineNight = 0;

function loadText(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function saveText(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* sin almacenamiento */
  }
}

function onlineError(msg: string): void {
  document.getElementById('online-error')!.textContent = msg;
}

/** Pantalla de jugar con amigos: el formulario o, ya conectado, la sala. */
function showOnline(): void {
  mode = 'menu';
  hud.show(false);
  controls.enabled = false;
  document.getElementById('online-form')!.classList.toggle('hidden', !!net);
  document.getElementById('online-room-box')!.classList.toggle('hidden', !net);
  showScreen('online');
}

function leaveOnline(): void {
  net?.close();
  net = null;
  document.getElementById('flock')!.classList.add('hidden');
}

function renderRoom(playing: boolean): void {
  if (!net) return;
  document.getElementById('online-room-name')!.textContent = net.room;
  const list = document.getElementById('online-players')!;
  list.innerHTML = '';
  for (const p of net.players) {
    const li = document.createElement('li');
    li.textContent = `${p.id === net.host ? '👑 ' : '🐑 '}${p.name}`;
    li.classList.toggle('me', p.id === net.id);
    list.appendChild(li);
  }
  // el anfitrión elige la noche entre las que tiene desbloqueadas
  const nights = document.getElementById('online-nights')!;
  nights.innerHTML = '';
  if (net.isHost && !playing) {
    onlineNight = Math.min(onlineNight, unlockedNight());
    NIGHTS.forEach((_, k) => {
      if (k > unlockedNight()) return;
      const b = document.createElement('button');
      b.textContent = `Noche ${k + 1}`;
      b.classList.toggle('selected', k === onlineNight);
      b.addEventListener('click', () => {
        onlineNight = k;
        renderRoom(playing);
      });
      nights.appendChild(b);
    });
  }
  const host = net.players.find((p) => p.id === net!.host)?.name ?? '';
  document.getElementById('online-wait')!.textContent = playing
    ? 'Hay una partida en marcha: entrarás en la siguiente… o espera, ¡ya te meten!'
    : net.isHost
      ? 'Eres el anfitrión: elige la noche y empieza cuando estéis todos'
      : `Esperando a que ${host} empiece la partida…`;
  document.getElementById('online-start')!.classList.toggle('hidden', !net.isHost || playing);
}

function joinOnline(): void {
  const name = $input('online-name').value.trim().slice(0, MAX_NAME);
  const room = $input('online-room').value.trim().slice(0, MAX_ROOM) || 'principal';
  saveText(NAME_KEY, name);
  saveText(ROOM_KEY, room);
  onlineError('Conectando…');
  leaveOnline();
  const client = new NetClient(name, room, kidMode, {
    room: (_players, _host, playing) => {
      if (net !== client) return;
      onlineError('');
      renderRoom(playing);
      if (mode === 'menu') showOnline();
    },
    start: (w) => {
      if (net !== client) return;
      world = w;
      renderer.setWorld(world);
      resetControls();
      mode = 'playing';
      controls.enabled = true;
      setEndButtons();
      showScreen(null);
      hud.show(true);
      sfx.start();
      grabInput();
    },
    error: (msg) => {
      if (net !== client) return;
      onlineError(msg);
    },
    closed: () => {
      if (net !== client) return;
      leaveOnline();
      showOnline();
      onlineError('Se ha perdido la conexión con el servidor');
    },
  });
  net = client;
}

$input('online-name').value = loadText(NAME_KEY);
$input('online-room').value = loadText(ROOM_KEY);
document.getElementById('online-open')!.addEventListener('click', () => {
  onlineError('');
  showOnline();
});
document.getElementById('online-back')!.addEventListener('click', toMenu);
document.getElementById('online-join')!.addEventListener('click', joinOnline);
for (const id of ['online-name', 'online-room']) $input(id).addEventListener('keydown', (e) => e.key === 'Enter' && joinOnline());
document.getElementById('online-start')!.addEventListener('click', () => net?.start(onlineNight));
document.getElementById('online-leave')!.addEventListener('click', () => {
  leaveOnline();
  toMenu();
});
document.getElementById('to-room')!.addEventListener('click', showOnline);

/** Lista de ovejas de la partida (arriba a la izquierda). */
let flockKey = '';
function updateFlockHud(): void {
  const el = document.getElementById('flock')!;
  const show = !!net && mode !== 'menu';
  el.classList.toggle('hidden', !show);
  if (!show) return;
  const key = world.flock.map((s) => `${s.id}:${s.name}:${s.caught}:${s.lives}`).join('|');
  if (key === flockKey) return;
  flockKey = key;
  el.innerHTML = '';
  for (const s of world.flock) {
    const d = document.createElement('div');
    d.className = `pill${s.caught ? ' caught' : ''}`;
    d.textContent = `${s.caught ? '💀' : '🐑'} ${s.name}${s.id === net!.id ? ' (tú)' : ''}${s.kid && !s.caught ? ` ${'❤️'.repeat(s.lives)}` : ''}`;
    el.appendChild(d);
  }
}

document.getElementById('play')!.addEventListener('click', () => {
  leaveOnline();
  start();
});
document.getElementById('again')!.addEventListener('click', () => start(world.nightIndex));
document.getElementById('next')!.addEventListener('click', () => {
  // multijugador: el anfitrión empieza la siguiente noche para todos
  if (net) net.start(world.nightIndex + 1);
  else start(world.nightIndex + 1);
});
document.getElementById('to-menu')!.addEventListener('click', () => {
  leaveOnline();
  setEndButtons();
  toMenu();
});
document.getElementById('resume')!.addEventListener('click', resume);
document.addEventListener('pointerlockchange', () => {
  if (!controls.locked && mode === 'playing' && !isTouchMode()) pause();
});
// cambiar de aplicación en el móvil (o de pestaña): pausa
document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'playing') pause();
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

// modo niño: las casillas del menú y de jugar con amigos van sincronizadas
const kidInputs = [...document.querySelectorAll<HTMLInputElement>('input[data-kid]')];
for (const input of kidInputs) {
  input.checked = kidMode;
  input.addEventListener('change', () => {
    kidMode = input.checked;
    saveText(KID_KEY, kidMode ? '1' : '');
    for (const other of kidInputs) other.checked = kidMode;
    input.blur(); // que las teclas vuelvan al juego
  });
}

renderNights();
updateBestLabel();

// Acceso para depurar desde la consola del navegador (solo en desarrollo)
if (import.meta.env.DEV) {
  Object.defineProperty(window, '__game', { get: () => ({ world, renderer, controls, mode }) });
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (net && (mode === 'playing' || mode === 'paused' || mode === 'over')) {
    // multijugador: la simulación está en el servidor; aquí solo se envían órdenes y se coloca lo recibido
    if (mode === 'playing') {
      controls.update(dt);
      controls.aimAt = controls.buildMode && !controls.kid ? renderer.aimPoint() : null;
      const input = controls.getInput();
      const me = net.me;
      if (me && !me.caught) {
        net.input(input, dt);
        world.preview(me, input);
      } else {
        world.preview(world.sheep, emptyInput());
      }
    }
    net.update(dt);
    if (mode !== 'over' && world.state !== 'playing') end();
  } else if (mode === 'playing') {
    controls.update(dt);
    controls.aimAt = controls.buildMode && !controls.kid ? renderer.aimPoint() : null;
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
  touch.update(world, mode === 'playing' || mode === 'replay');
  hud.update(world, mode === 'replay' ? false : controls.buildMode, mode === 'replay' ? null : ITEMS[controls.item], isTouchMode(), controls.kid);
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
  updateFlockHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
