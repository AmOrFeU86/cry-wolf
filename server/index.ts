/**
 * Servidor multijugador: ejecuta la simulación (src/sim) de cada sala y reparte el estado por WebSocket.
 * También sirve el juego compilado (dist/), así que en el VPS basta con:
 *
 *   npm install && npm run build && npm run server      (PORT=8080 por defecto)
 *
 * En local, con `npm run dev` en otra terminal, Vite redirige /ws a este servidor.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { emptyInput, type PlayerInput } from '../src/sim/entities';
import { LAST_NIGHT } from '../src/sim/nights';
import { ITEMS } from '../src/sim/pieces';
import { World, type GameEvent } from '../src/sim/World';
import { cleanName, MAX_NAME, MAX_PLAYERS, MAX_ROOM, NET_VERSION, WS_PATH, type ClientMsg, type PlayerInfo, type ServerMsg } from '../src/net/protocol';
import { SnapshotEncoder } from '../src/net/snapshot';

const PORT = Number(process.env.PORT ?? 8080);
const DIST = resolve(process.env.DIST ?? 'dist');
const DT = 1 / 30; // paso de la simulación (el mismo que usan los bots) y ritmo de envío

interface Player extends PlayerInfo {
  ws: WebSocket;
  input: PlayerInput;
}

let nextId = 1;
const rooms = new Map<string, Room>();

class Room {
  readonly players = new Map<number, Player>();
  host = 0;
  world: World | null = null;
  playing = false;
  private encoder = new SnapshotEncoder();
  private events: GameEvent[] = [];
  /** Alguien ha entrado: la próxima foto lleva todas las construcciones. */
  private full = false;

  constructor(readonly name: string) {}

  join(p: Player): void {
    this.players.set(p.id, p);
    if (!this.host) this.host = p.id;
    send(p.ws, { t: 'welcome', id: p.id, room: this.name });
    // partida en marcha: entra como una oveja más
    if (this.playing && this.world) {
      this.world.addSheep(p.id, p.name);
      send(p.ws, { t: 'start', seed: this.world.seed, night: this.world.nightIndex, players: this.list() });
      this.full = true;
    }
    this.broadcastRoom();
  }

  leave(id: number): void {
    this.players.delete(id);
    this.world?.removeSheep(id);
    if (this.host === id) this.host = this.players.keys().next().value ?? 0;
    if (this.playing && this.world && this.world.flock.length === 0) this.playing = false;
    if (this.players.size === 0) rooms.delete(this.name);
    else this.broadcastRoom();
  }

  start(by: number, night: number): void {
    if (by !== this.host || this.playing) return;
    const n = Number.isInteger(night) ? Math.max(0, Math.min(LAST_NIGHT, night)) : 0;
    const players = this.list();
    this.world = new World(undefined, n, players);
    this.events = [];
    this.full = true;
    this.playing = true;
    for (const p of this.players.values()) p.input = emptyInput();
    this.broadcast({ t: 'start', seed: this.world.seed, night: n, players });
    this.broadcastRoom();
  }

  step(): void {
    const w = this.world;
    if (!this.playing || !w) return;
    const inputs = new Map<number, PlayerInput>();
    for (const p of this.players.values()) {
      inputs.set(p.id, p.input);
      // los pulsos (esquive, construir) se aplican una sola vez
      p.input = { ...p.input, dash: false, place: false, remove: false };
    }
    w.update(DT, inputs);
    this.events.push(...w.events);
    w.events.length = 0;
    const snap = this.encoder.encode(w, this.events.splice(0), this.full);
    this.full = false;
    this.broadcast({ t: 'snap', s: snap });
    if (w.state !== 'playing') {
      this.playing = false;
      this.broadcastRoom();
    }
  }

  private list(): PlayerInfo[] {
    return [...this.players.values()].map((p) => ({ id: p.id, name: p.name }));
  }

  broadcastRoom(): void {
    this.broadcast({ t: 'room', players: this.list(), host: this.host, playing: this.playing });
  }

  broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) if (p.ws.readyState === p.ws.OPEN) p.ws.send(data);
  }
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Lo que llega del navegador no es de fiar: solo se copian campos válidos. */
function readInput(raw: unknown, prev: PlayerInput): PlayerInput {
  const i = (raw ?? {}) as Record<string, unknown>;
  const aim = i.aimAt as Record<string, unknown> | null;
  return {
    moveX: Math.max(-1, Math.min(1, num(i.moveX))),
    moveZ: Math.max(-1, Math.min(1, num(i.moveZ))),
    aimX: num(i.aimX),
    aimZ: num(i.aimZ),
    aimAt: aim && typeof aim === 'object' ? { x: num(aim.x), z: num(aim.z) } : null,
    sprint: i.sprint === true,
    // un pulso que aún no se ha aplicado no se pierde aunque llegue otra orden antes del siguiente paso
    dash: i.dash === true || prev.dash,
    eat: i.eat === true,
    climb: i.climb === true,
    buildMode: i.buildMode === true,
    item: ITEMS.includes(i.item as never) ? (i.item as PlayerInput['item']) : prev.item,
    place: i.place === true || prev.place,
    remove: i.remove === true || prev.remove,
  };
}

// ---------------------------------------------------------------- HTTP: el juego compilado

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
};

const http = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = normalize(join(DIST, url));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(
      existsSync(DIST) ? 'No encontrado' : 'Falta compilar el juego: npm run build',
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

// ---------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ server: http, path: WS_PATH, maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  let player: Player | null = null;
  let room: Room | null = null;

  ws.on('message', (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!player) {
      if (msg.t !== 'join') return;
      if (msg.v !== NET_VERSION) {
        send(ws, { t: 'error', msg: 'Versión distinta del servidor: recarga la página' });
        ws.close();
        return;
      }
      const roomName = cleanName(msg.room, MAX_ROOM).toLowerCase() || 'principal';
      room = rooms.get(roomName) ?? new Room(roomName);
      if (room.players.size >= MAX_PLAYERS) {
        send(ws, { t: 'error', msg: `La sala está llena (máximo ${MAX_PLAYERS})` });
        ws.close();
        return;
      }
      rooms.set(roomName, room);
      const id = nextId++;
      player = { id, name: cleanName(msg.name, MAX_NAME) || `Oveja ${id}`, ws, input: emptyInput() };
      room.join(player);
      console.log(`+ ${player.name} (#${id}) en "${roomName}" · ${room.players.size} jugadores`);
      return;
    }
    if (msg.t === 'input') player.input = readInput(msg.i, player.input);
    else if (msg.t === 'start') room!.start(player.id, msg.night);
  });

  ws.on('close', () => {
    if (!player || !room) return;
    console.log(`- ${player.name} (#${player.id}) sale de "${room.name}"`);
    room.leave(player.id);
  });
});

// Paso fijo: se acumula el tiempo real y se avanza la simulación de DT en DT
let last = performance.now();
let acc = 0;
setInterval(() => {
  const now = performance.now();
  acc = Math.min(acc + (now - last) / 1000, DT * 5); // si el servidor se atasca, no intentar recuperar de golpe
  last = now;
  while (acc >= DT) {
    acc -= DT;
    for (const room of rooms.values()) room.step();
  }
}, 5);

http.listen(PORT, () => {
  console.log(`Servidor de ¡Que viene el lobo! en http://localhost:${PORT} (WebSocket en ${WS_PATH})`);
  if (!existsSync(DIST)) console.log('Aviso: no hay dist/. Ejecuta `npm run build` o usa `npm run dev` para el cliente.');
});
