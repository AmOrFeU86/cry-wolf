// Cliente multijugador: conecta con el servidor, envía las órdenes del jugador y mantiene
// una copia del mundo (World) que se dibuja igual que en solitario.
import { emptyInput, Wolf, type PlayerInput } from '../sim/entities';
import { Cell, isBuilt, type CellType } from '../sim/Grid';
import { World } from '../sim/World';
import { MODES, PHASES } from '../replay/replay';
import { NET_VERSION, WS_PATH, type ClientMsg, type PlayerInfo, type ServerMsg } from './protocol';
import type { Snapshot } from './snapshot';

/** Los demás se dibujan un poco en el pasado para poder interpolar entre dos fotos. */
const DELAY = 0.1;
/** Cada cuánto se envían las órdenes (s). */
const SEND_INTERVAL = 1 / 30;
/** Cada cuánto se confirma al servidor la última foto recibida (s). */
const ACK_INTERVAL = 0.1;
/** La hora del servidor se calcula con la foto que llegó antes en los últimos segundos (s). */
const OFFSET_WINDOW = 3;
/** Si las fotos empiezan a llegar más tarde, se retrasa el reloj poco a poco (s por s). */
const OFFSET_SLEW = 0.1;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpAngle = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
};

export interface NetHandlers {
  room(players: PlayerInfo[], host: number, playing: boolean): void;
  start(world: World): void;
  error(msg: string): void;
  closed(): void;
}

/** Dirección del servidor: la misma web (o ?server=host:puerto para probar contra otro). */
export function serverUrl(): string {
  const custom = new URLSearchParams(location.search).get('server');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return custom ? `${custom.startsWith('ws') ? '' : `${proto}//`}${custom}${custom.includes('/ws') ? '' : WS_PATH}` : `${proto}//${location.host}${WS_PATH}`;
}

export class NetClient {
  id = 0;
  room = '';
  host = 0;
  players: PlayerInfo[] = [];
  world: World | null = null;
  private ws: WebSocket;
  private snaps: Snapshot[] = [];
  /** Hora del servidor menos la hora local (se ajusta con cada foto). */
  private offset: number | null = null;
  /** Diferencia de hora de cada foto reciente: [hora local, diferencia]. */
  private offsets: [number, number][] = [];
  private lastSnapAt = 0;
  private lastAck = 0;
  private acked = -1;
  private wolves = new Map<number, Wolf>();
  private pending: PlayerInput | null = null;
  private sendTimer = 0;
  private closedByUs = false;

  constructor(name: string, room: string, kid: boolean, private on: NetHandlers) {
    this.ws = new WebSocket(serverUrl());
    this.ws.addEventListener('open', () => this.send({ t: 'join', v: NET_VERSION, name, room, kid }));
    this.ws.addEventListener('message', (e) => this.onMessage(JSON.parse(String(e.data)) as ServerMsg));
    this.ws.addEventListener('close', () => {
      if (!this.closedByUs) this.on.closed();
    });
    this.ws.addEventListener('error', () => this.on.error('No se puede conectar con el servidor'));
  }

  get isHost(): boolean {
    return this.id === this.host;
  }

  /** Mi oveja (aunque la cámara esté siguiendo a otra porque me han cazado). */
  get me() {
    return this.world?.flock.find((s) => s.id === this.id) ?? null;
  }

  close(): void {
    this.closedByUs = true;
    this.ws.close();
  }

  /** Dejar de mover la oveja (pausa): manda una orden vacía ya. */
  idle(): void {
    this.pending = null;
    this.send({ t: 'input', i: emptyInput() });
  }

  start(night: number): void {
    this.send({ t: 'start', night });
  }

  /** Guarda la orden del jugador; los pulsos (esquive, construir) se acumulan hasta enviarla. */
  input(i: PlayerInput, dt: number): void {
    const p = this.pending;
    this.pending = p ? { ...i, dash: i.dash || p.dash, place: i.place || p.place, remove: i.remove || p.remove } : i;
    this.sendTimer -= dt;
    if (this.sendTimer > 0) return;
    this.sendTimer = SEND_INTERVAL;
    this.send({ t: 'input', i: this.pending });
    this.pending = null;
  }

  private send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.id = msg.id;
        this.room = msg.room;
        break;
      case 'room':
        this.players = msg.players;
        this.host = msg.host;
        this.on.room(msg.players, msg.host, msg.playing);
        break;
      case 'start':
        this.players = msg.players;
        this.world = new World(msg.seed, msg.night, msg.players);
        this.world.focus = this.id;
        this.snaps = [];
        this.offset = null;
        this.offsets = [];
        this.wolves.clear();
        this.on.start(this.world);
        break;
      case 'snap':
        this.onSnap(msg.s);
        break;
      case 'error':
        this.on.error(msg.msg);
        break;
    }
  }

  /** Lo discreto (lana, construcciones, hierba, eventos...) se aplica en cuanto llega. */
  private onSnap(snap: Snapshot): void {
    const w = this.world;
    if (!w) return;
    const now = performance.now() / 1000;
    // la foto que llegó antes en los últimos segundos marca la hora. Si llega antes, se adelanta
    // el reloj de golpe; si las fotos se retrasan (un proxy que las acumula), se atrasa poco a poco
    this.offsets.push([now, snap.t - now]);
    while (this.offsets[0][0] < now - OFFSET_WINDOW) this.offsets.shift();
    const best = Math.max(...this.offsets.map((o) => o[1]));
    if (this.offset === null || best > this.offset || this.snaps.length === 0) this.offset = best;
    else this.offset = Math.max(best, this.offset - OFFSET_SLEW * (now - this.lastSnapAt));
    this.lastSnapAt = now;
    this.snaps.push(snap);
    while (this.snaps.length > 2 && this.snaps[1].t < snap.t - 1) this.snaps.shift();

    w.state = snap.st;
    w.events.push(...snap.ev);
    Object.assign(w.stats, snap.stats);
    snap.g.forEach((amt, k) => {
      if (w.grass[k]) w.grass[k].amount = amt;
    });
    const g = w.grid;
    if (snap.f) {
      const want = new Map(snap.f.map((f) => [f[0], f[2] as CellType]));
      for (let c = 0; c < g.cells.length; c++) {
        const type = want.get(c);
        if (type === undefined ? !isBuilt(g.cells[c]) : g.cells[c] === type) continue;
        g.set(c % g.n, Math.floor(c / g.n), type ?? Cell.Empty);
      }
      for (const [c, hp] of snap.f) g.hp[c] = hp;
    }
    const bkey = (b: [number, number][]) => b.map((p) => p.join(',')).join(';');
    const cellOf = (k: number): [number, number] => [k % g.n, Math.floor(k / g.n)];
    if (bkey(snap.b) !== bkey(w.bridges.map((br) => [br.a[1] * g.n + br.a[0], br.b[1] * g.n + br.b[0]]))) {
      w.bridges.length = 0;
      for (const [a, b] of snap.b) w.bridges.push({ a: cellOf(a), b: cellOf(b) });
      w.bridgeVersion++;
    }

    // ovejas que entran o salen
    for (const row of snap.s) {
      if (w.flock.some((s) => s.id === row[0])) continue;
      const p = this.players.find((q) => q.id === row[0]);
      w.addSheep(row[0], p?.name ?? '', p?.kid);
    }
    for (const s of [...w.flock]) if (!snap.s.some((row) => row[0] === s.id)) w.removeSheep(s.id);
    for (const row of snap.s) {
      const s = w.flock.find((q) => q.id === row[0])!;
      s.name = this.players.find((p) => p.id === s.id)?.name ?? s.name;
      s.eating = row[6] === 1;
      s.wool = row[7];
      s.stamina = row[8];
      s.stun = row[10];
      s.exhausted = row[11] === 1;
      s.caught = row[12] === 1;
      s.dashTimer = row[13];
      s.dashCooldown = row[14];
      s.throwCooldown = row[15];
      s.climb = row[16];
      s.tower = row[17] >= 0 ? cellOf(row[17]) : null;
      s.crossing = row[18] >= 0 ? { from: cellOf(row[18]), to: cellOf(row[19]), t: row[20] } : null;
      s.lives = row[21];
      s.safe = row[22];
    }
    // si me han cazado, la cámara sigue a una compañera que siga viva
    const me = this.me;
    if (me && !me.caught) w.focus = this.id;
    else if (!w.flock.some((s) => s.id === w.focus && !s.caught)) w.focus = w.alive[0]?.id ?? this.id;
  }

  /** Cada frame: coloca ovejas y lobos entre las dos fotos que tocan. */
  update(dt: number): void {
    const w = this.world;
    if (!w || this.offset === null || this.snaps.length === 0) return;
    const last = this.snaps[this.snaps.length - 1];
    // confirmar la última foto (siempre la más nueva, aunque lleguen varias de golpe)
    const local = performance.now() / 1000;
    if (last.t !== this.acked && local - this.lastAck >= ACK_INTERVAL) {
      this.lastAck = local;
      this.acked = last.t;
      this.send({ t: 'ack', s: last.t });
    }
    const now = local + this.offset;
    const renderT = Math.min(now - DELAY, last.t);
    let a = this.snaps[0];
    let b = a;
    for (let k = this.snaps.length - 1; k >= 0; k--) {
      if (this.snaps[k].t <= renderT) {
        a = this.snaps[k];
        b = this.snaps[Math.min(k + 1, this.snaps.length - 1)];
        break;
      }
    }
    const k = b.t > a.t ? Math.max(0, Math.min(1, (renderT - a.t) / (b.t - a.t))) : 0;
    w.time = Math.max(w.time, Math.min(now, last.t));

    for (const s of w.flock) {
      const rb = last.s.find((r) => r[0] === s.id);
      if (!rb) continue;
      if (s.id === this.id) {
        // mi oveja: la foto más reciente, adelantada con su velocidad (responde antes a las teclas)
        const ahead = Math.max(0, Math.min(0.1, now - last.t));
        const tx = rb[1] + (s.tower || s.crossing ? 0 : rb[4] * ahead);
        const tz = rb[2] + (s.tower || s.crossing ? 0 : rb[5] * ahead);
        const jump = Math.hypot(tx - s.pos.x, tz - s.pos.z) > 2;
        s.pos.x = jump ? tx : lerp(s.pos.x, tx, 0.5);
        s.pos.z = jump ? tz : lerp(s.pos.z, tz, 0.5);
        s.facing = lerpAngle(s.facing, rb[3], 0.5);
        s.vel.x = rb[4];
        s.vel.z = rb[5];
        s.elevation = rb[9];
        continue;
      }
      const ra = a.s.find((r) => r[0] === s.id) ?? rb;
      const rbb = b.s.find((r) => r[0] === s.id) ?? ra;
      s.pos.x = lerp(ra[1], rbb[1], k);
      s.pos.z = lerp(ra[2], rbb[2], k);
      s.facing = lerpAngle(ra[3], rbb[3], k);
      s.vel.x = lerp(ra[4], rbb[4], k);
      s.vel.z = lerp(ra[5], rbb[5], k);
      s.elevation = lerp(ra[9], rbb[9], k);
    }

    const g = w.grid;
    const seen = new Set<number>();
    for (const wa of a.w) {
      const [id, x, z, h, sp, att, ph, md, sees, prey] = wa;
      const wb = b.w.find((q) => q[0] === id) ?? wa;
      let wolf = this.wolves.get(id);
      if (!wolf) {
        wolf = new Wolf(x, z);
        this.wolves.set(id, wolf);
        w.wolves.push(wolf);
      }
      wolf.pos.x = lerp(x, wb[1], k);
      wolf.pos.z = lerp(z, wb[2], k);
      wolf.heading = lerpAngle(h, wb[3], k);
      wolf.speed = lerp(sp, wb[4], k);
      wolf.attacking = att >= 0 ? [att % g.n, Math.floor(att / g.n)] : null;
      wolf.phase = PHASES[ph] ?? 'chase';
      wolf.mode = MODES[md] ?? 'wander';
      wolf.sees = sees === 1;
      wolf.prey = prey >= 0 ? prey : null;
      seen.add(id);
    }
    for (const [id, wolf] of this.wolves) {
      if (seen.has(id)) continue;
      this.wolves.delete(id);
      w.wolves.splice(w.wolves.indexOf(wolf), 1);
    }
    // el rastro no se envía: se reconstruye con el recorrido de cada oveja
    for (const s of w.alive) w.updateScent(dt, s);
  }
}
