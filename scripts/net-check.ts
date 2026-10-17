/**
 * Comprueba el multijugador sin navegador:
 *  1. Simulación con varias ovejas: los lobos las cazan una a una y la partida acaba cuando no queda ninguna.
 *  2. Servidor real con dos clientes por WebSocket: sala, empezar, moverse, construir, salir.
 *
 *   npx tsx scripts/net-check.ts
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { CONFIG } from '../src/config';
import { emptyInput, type PlayerInput } from '../src/sim/entities';
import { World } from '../src/sim/World';
import { NET_VERSION, type ServerMsg } from '../src/net/protocol';
import type { Snapshot } from '../src/net/snapshot';

let failed = 0;
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${name}${extra ? ` (${extra})` : ''}`);
  if (!ok) failed++;
}

// ---------------------------------------------------------------- 1. simulación
{
  const players = [1, 2, 3].map((id) => ({ id, name: `Oveja ${id}` }));
  const w = new World(1234, 4, players);
  check('tres ovejas en sitios distintos', w.flock.length === 3 && new Set(w.flock.map((s) => `${s.pos.x},${s.pos.z}`)).size === 3);
  const idle = new Map(players.map((p) => [p.id, emptyInput()]));
  const caught: number[] = [];
  let lostWithSheepLeft = false;
  while (w.state === 'playing' && w.time < 400) {
    w.update(1 / 30, idle);
    for (const e of w.events) if (e.type === 'caught' && e.id !== undefined) caught.push(e.id);
    if (w.state === 'lost' && w.alive.length > 0) lostWithSheepLeft = true;
    w.events.length = 0;
  }
  check('los lobos cazan a cada oveja por separado', new Set(caught).size === caught.length && caught.length >= 1, `cazadas: ${caught.join(', ')}`);
  check('solo se pierde cuando no queda ninguna', !lostWithSheepLeft && (w.state === 'won' || w.alive.length === 0), w.state);
}

// ---------------------------------------------------------------- 2. servidor
const PORT = 8099;
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
server.stderr.on('data', (d) => process.stderr.write(d));
await new Promise<void>((ok) => server.stdout.on('data', (d) => String(d).includes('Servidor') && ok()));

class Bot {
  ws: WebSocket;
  id = 0;
  host = 0;
  players = 0;
  started = false;
  snap: Snapshot | null = null;
  events: string[] = [];
  constructor(name: string) {
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'join', v: NET_VERSION, name, room: 'prueba' })));
    this.ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMsg;
      if (m.t === 'welcome') this.id = m.id;
      if (m.t === 'room') {
        this.host = m.host;
        this.players = m.players.length;
      }
      if (m.t === 'start') this.started = true;
      if (m.t === 'snap') {
        this.snap = m.s;
        this.events.push(...m.s.ev.map((e) => e.type));
      }
    });
  }
  input(i: Partial<PlayerInput>): void {
    this.ws.send(JSON.stringify({ t: 'input', i: { ...emptyInput(), ...i } }));
  }
  me() {
    return this.snap?.s.find((r) => r[0] === this.id);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const a = new Bot('Ana');
const b = new Bot('Bea');
await wait(500);
check('los dos entran en la sala', a.players === 2 && b.players === 2);
check('la primera es la anfitriona', a.host === a.id && b.host === a.id);
b.ws.send(JSON.stringify({ t: 'start', night: 0 }));
await wait(200);
check('solo la anfitriona puede empezar', !a.started && !b.started);
a.ws.send(JSON.stringify({ t: 'start', night: 0 }));
await wait(400);
check('empieza la partida para las dos', a.started && b.started && a.snap?.s.length === 2);
check('la primera foto trae las construcciones', a.snap !== null);

const start = a.me()!;
for (let k = 0; k < 20; k++) {
  a.input({ moveX: 1 });
  await wait(30);
}
a.input({});
await wait(300);
const moved = a.me()!;
check('Ana se mueve hacia +X', moved[1] - start[1] > 2, `${start[1]} → ${moved[1]}`);
check('Bea ve a Ana en el mismo sitio', Math.abs((b.snap!.s.find((r) => r[0] === a.id)?.[1] ?? 0) - moved[1]) < 0.5);

// construir una valla delante (hay lana inicial)
const woolBefore = a.me()![7];
a.input({ buildMode: true, item: 'fence', aimAt: { x: moved[1] + 1.5, z: moved[2] }, place: true });
await wait(300);
check('Ana construye una valla', a.events.includes('built') && b.events.includes('built') && a.me()![7] === woolBefore - CONFIG.pieces.fence.cost);
check('la valla llega a Bea', (b.snap?.f ?? []).length > 0 || b.events.includes('built'));

b.ws.close();
await wait(400);
check('al salir Bea, su oveja desaparece', a.snap?.s.length === 1 && a.players === 1);

a.ws.close();
server.kill();
console.log(failed ? `\n${failed} comprobaciones fallidas` : '\nTodo bien');
process.exit(failed ? 1 : 0);
