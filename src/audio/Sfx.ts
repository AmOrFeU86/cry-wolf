// Efectos de sonido con Web Audio: grabaciones de public/sfx (ver CREDITS.md) y, si falta alguna, sintetizados.
// Lee los eventos del mundo (antes de que el render los consuma) y su estado (latido, pasos de lobo).
import type { Vec2 } from '../sim/Grid';
import type { GameEvent, World } from '../sim/World';
import { dayProgress } from '../render/DayCycle';

const MUTE_KEY = 'wolfsheep.mute';
const VOLUME_KEY = 'wolfsheep.volume';
/** Ganancia de los efectos al 100 %. */
const SFX_GAIN = 0.7;
export type VolumeKind = 'music' | 'sfx';
const SAMPLES = ['howl', 'howl-pack', 'heartbeat', 'growl', 'forest', 'break', 'bite', 'bleat', 'step', 'whoosh', 'fall', 'sniff', 'creak', 'chew', 'grass'] as const;
type SampleId = (typeof SAMPLES)[number];
const AMBIENCE_VOL = 0.22;
/** Música de fondo (public/music, ver CREDITS.md): una pista de día y otra de noche que se funden según la hora. */
const MUSIC_VOL = 0.32;
const MUSIC = ['day', 'night'] as const;

interface PlayOpts {
  vol?: number;
  rate?: number;
  range?: number; // metros a los que deja de oírse
  when?: number;
  dur?: number; // cortar (con un pequeño fundido) a los dur segundos
}

export class Sfx {
  private ctx: AudioContext | null = null;
  /** Bus de efectos (todo lo que no es música va aquí). */
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  /** Salida final: el silencio (M) actúa aquí. */
  private out: GainNode | null = null;
  private volume: Record<VolumeKind, number> = { music: 1, sfx: 1 };
  private noise: AudioBuffer | null = null;
  private muted = false;
  private nextBeat = 0;
  private stepTimers = new Map<number, number>();
  private eatTimer = 0;
  /** Masticar en bucle mientras come. */
  private chew: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private yaw = 0;
  private listener: Vec2 = { x: 0, z: 0 };
  private samples = new Map<SampleId, AudioBuffer>();
  private ambience: GainNode | null = null;
  private music: GainNode[] = [];
  /** 0 tranquilo … 1 un lobo a punto de saltar (lo calcula el latido). */
  private danger = 0;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
      const v = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? '{}') as Partial<Record<VolumeKind, number>>;
      for (const k of ['music', 'sfx'] as const) if (typeof v[k] === 'number') this.volume[k] = Math.min(1, Math.max(0, v[k]));
    } catch {
      /* sin almacenamiento */
    }
  }

  /** Crear el audio necesita un gesto del usuario (click o tecla): llamar al empezar a jugar. */
  start(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.out = this.ctx.createGain();
      this.out.gain.value = this.muted ? 0 : 1;
      this.master = this.ctx.createGain();
      this.master.gain.value = SFX_GAIN * this.volume.sfx;
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = this.volume.music;
      // compresor suave para que varios sonidos a la vez no saturen
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(this.out);
      this.musicBus.connect(this.out);
      this.out.connect(comp).connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let k = 0; k < len; k++) data[k] = Math.random() * 2 - 1;
      void this.loadSamples();
      this.startMusic();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private async loadSamples(): Promise<void> {
    await Promise.all(
      SAMPLES.map(async (id) => {
        try {
          const res = await fetch(`${import.meta.env.BASE_URL}sfx/${id}.mp3`);
          if (!res.ok) return;
          this.samples.set(id, await this.ctx!.decodeAudioData(await res.arrayBuffer()));
          if (id === 'forest') this.startAmbience();
        } catch {
          /* sin ese archivo: se usa el sintetizado */
        }
      }),
    );
  }

  /** Fondo de bosque en bucle (baja cuando hay peligro, ver heartbeat). */
  private startAmbience(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.samples.get('forest')!;
    src.loop = true;
    this.ambience = ctx.createGain();
    this.ambience.gain.value = 0;
    this.ambience.gain.setTargetAtTime(AMBIENCE_VOL, ctx.currentTime, 1.5);
    src.connect(this.ambience).connect(this.master!);
    src.start();
  }

  /** Las pistas largas se leen en streaming con <audio> (decodificadas ocuparían decenas de MB). */
  private startMusic(): void {
    const ctx = this.ctx!;
    this.music = MUSIC.map((id, k) => {
      const el = new Audio(`${import.meta.env.BASE_URL}music/${id}.mp3`);
      el.loop = true;
      el.crossOrigin = 'anonymous';
      const g = ctx.createGain();
      g.gain.value = 0;
      if (k === 0) g.gain.setTargetAtTime(MUSIC_VOL, ctx.currentTime + 0.5, 2); // entra suave
      ctx.createMediaElementSource(el).connect(g).connect(this.musicBus!);
      el.play().catch(() => {
        /* sin el archivo o sin permiso del navegador: el juego sigue sin música */
      });
      return g;
    });
  }

  /** Funde día ↔ noche al atardecer y baja la música cuando hay peligro. */
  private updateMusic(world: World): void {
    if (this.music.length < 2) return;
    const night = Math.min(1, Math.max(0, (dayProgress(world) - 0.72) / 0.16));
    const vol = MUSIC_VOL * (1 - 0.6 * this.danger);
    const t = this.ctx!.currentTime;
    // fundido de potencia constante: no hay bajón a mitad del cruce
    this.music[0].gain.setTargetAtTime(vol * Math.cos((night * Math.PI) / 2), t, 0.5);
    this.music[1].gain.setTargetAtTime(vol * Math.sin((night * Math.PI) / 2), t, 0.5);
  }

  /** Reproduce una grabación con dirección y distancia. Devuelve false si no está cargada (→ usar el sintetizado). */
  private play(id: SampleId, at: Vec2 | null, o: PlayOpts = {}): boolean {
    const buf = this.samples.get(id);
    if (!buf) return false;
    const out = this.spatial(at, o.range ?? 30);
    if (!out) return true; // demasiado lejos: no suena, pero tampoco hace falta el sintetizado
    const ctx = this.ctx!;
    const t = o.when ?? ctx.currentTime;
    const vol = o.vol ?? 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (o.rate ?? 1) * (0.93 + Math.random() * 0.14); // que no suene siempre igual
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g).connect(out);
    src.start(t);
    if (o.dur) {
      g.gain.setValueAtTime(vol, t + Math.max(0, o.dur - 0.08));
      g.gain.linearRampToValueAtTime(0, t + o.dur);
      src.stop(t + o.dur + 0.01);
    }
    return true;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.out && this.ctx) this.out.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.05);
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      /* sin almacenamiento */
    }
    return this.muted;
  }

  getVolume(kind: VolumeKind): number {
    return this.volume[kind];
  }

  /** Volumen de 0 a 1 (se guarda para la próxima vez). */
  setVolume(kind: VolumeKind, v: number): void {
    this.volume[kind] = Math.min(1, Math.max(0, v));
    const bus = kind === 'music' ? this.musicBus : this.master;
    if (bus && this.ctx) bus.gain.setTargetAtTime(this.volume[kind] * (kind === 'sfx' ? SFX_GAIN : 1), this.ctx.currentTime, 0.05);
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify(this.volume));
    } catch {
      /* sin almacenamiento */
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Llamar cada frame ANTES de renderer.render (que vacía world.events). active=false: solo eventos, sin latido. */
  update(world: World, dt: number, yaw: number, active = true): void {
    if (!this.ctx || !this.master) return;
    this.yaw = yaw;
    this.listener = world.sheep.pos;
    for (const e of world.events) this.onEvent(e, world);
    this.updateMusic(world);
    if (world.state !== 'playing') {
      this.danger = 0;
      this.stopLoops();
      return;
    }
    if (active) this.heartbeat(world);
    this.wolfSteps(world, dt);
    this.bridgeSteps(world, dt);
    this.eating(world, dt);
  }

  // ------------------------------------------------------------------ eventos

  private onEvent(e: GameEvent, world: World): void {
    const at = { x: e.x, z: e.z };
    switch (e.type) {
      case 'howl':
        // el primero (sin radio) es la llegada de la manada, a lo lejos
        if (e.r) {
          if (!this.play('howl', at, { vol: 0.9, range: 80 })) this.howl(at, 1);
        } else if (!this.play('howl-pack', null, { vol: 0.45 })) {
          this.howl({ x: world.sheep.pos.x + 30, z: world.sheep.pos.z }, 0.5, true);
        }
        break;
      case 'wolfSpawn':
        if (!this.play('howl', at, { vol: 0.45, range: 80, rate: 0.9 })) this.howl(at, 0.45);
        break;
      case 'windup':
        this.play('growl', at, { vol: 0.8, range: 20, dur: 1 });
        break;
      case 'bitten':
        if (!this.play('bite', at, { vol: 0.55, rate: 1.15 })) this.bite(at);
        break;
      case 'destroyed': {
        const heavy = e.piece === 'wall' || e.piece === 'tower';
        if (!this.play('break', at, { vol: 0.9, rate: heavy ? 0.7 : 1 })) this.crack(at, heavy);
        break;
      }
      case 'built':
        this.knock(at, e.piece === 'wall' || e.piece === 'tower' ? 110 : 190);
        break;
      case 'dismantled':
        this.knock(at, 260);
        break;
      case 'dash':
        if (!this.play('whoosh', at, { vol: 0.5 })) this.whoosh(at, 0.35, 900, 3000);
        break;
      case 'throw':
        if (!this.play('whoosh', at, { vol: 0.35, rate: 1.3 })) this.whoosh(at, 0.25, 1500, 4000);
        break;
      case 'land':
        this.thud(at, 0.5);
        break;
      case 'climb':
        if (!this.play('creak', at, { vol: 0.6 })) this.knock(at, 300);
        break;
      case 'fall':
        if (!this.play('fall', at, { vol: 0.9 })) this.thud(at, 1);
        break;
      case 'sniff':
        if (!this.play('sniff', at, { vol: 0.5, range: 20 })) this.sniff(at);
        break;
      case 'caught':
        this.play('bleat', null, { vol: 0.9 });
        this.caught();
        break;
    }
  }

  // ------------------------------------------------------------------ estado continuo

  /** Latido: lento si te buscan, rápido y fuerte si te ven o hay un lobo a punto de saltar. */
  private heartbeat(world: World): void {
    const ctx = this.ctx!;
    let danger = 0;
    const s = world.sheep.pos;
    for (const w of world.wolves) {
      const d = Math.hypot(w.pos.x - s.x, w.pos.z - s.z);
      if (w.phase === 'windup' || w.phase === 'pounce') danger = Math.max(danger, 1);
      else if (w.mode === 'hunt') danger = Math.max(danger, 0.55 + 0.4 * Math.max(0, 1 - d / 15));
      else if (w.mode !== 'wander' && d < 18) danger = Math.max(danger, 0.25);
    }
    this.danger = danger;
    // el bosque se apaga un poco cuando hay peligro (se oye mejor el latido y los pasos)
    if (this.ambience) this.ambience.gain.setTargetAtTime(AMBIENCE_VOL * (1 - 0.65 * danger), ctx.currentTime, 0.4);
    if (danger <= 0) {
      this.nextBeat = 0;
      return;
    }
    const now = ctx.currentTime;
    if (this.nextBeat === 0) this.nextBeat = now;
    if (now < this.nextBeat - 0.05) return;
    const bpm = 60 + danger * 90;
    const vol = 0.15 + danger * 0.35;
    // la grabación ya trae el "pum-pum"; el sintetizado son dos golpes
    if (!this.play('heartbeat', null, { vol: vol * 2.4, when: this.nextBeat })) {
      this.beat(this.nextBeat, vol);
      this.beat(this.nextBeat + 0.14, vol * 0.7);
    }
    this.nextBeat = Math.max(now, this.nextBeat) + 60 / bpm;
  }

  /** Pasos de los lobos que corren cerca (aunque no los veas). */
  private wolfSteps(world: World, dt: number): void {
    for (const w of world.wolves) {
      const d = Math.hypot(w.pos.x - this.listener.x, w.pos.z - this.listener.z);
      if (d > 14 || w.speed < 1) continue;
      const t = (this.stepTimers.get(w.id) ?? 0) - dt;
      if (t > 0) {
        this.stepTimers.set(w.id, t);
        continue;
      }
      this.stepTimers.set(w.id, 1.6 / Math.max(2, w.speed));
      if (!this.play('step', w.pos, { vol: 0.4, rate: 0.75, range: 14 })) this.thud(w.pos, 0.18, 70 + Math.random() * 30);
    }
  }

  private bridgeTimer = 0;

  /** Crujidos de madera al cruzar un puente. */
  private bridgeSteps(world: World, dt: number): void {
    if (!world.sheep.crossing) return;
    this.bridgeTimer -= dt;
    if (this.bridgeTimer > 0) return;
    this.bridgeTimer = 0.32;
    if (!this.play('creak', world.sheep.pos, { vol: 0.22, rate: 1.5, dur: 0.35 })) this.knock(world.sheep.pos, 230 + Math.random() * 60);
  }

  /** Apagar lo que suena en bucle (comer). Llamar al pausar. */
  stopLoops(): void {
    if (!this.chew || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.chew.gain.gain.setTargetAtTime(0, t, 0.06);
    this.chew.src.stop(t + 0.4);
    this.chew = null;
  }

  private eating(world: World, dt: number): void {
    const chew = this.samples.get('chew');
    if (chew) {
      if (world.sheep.eating && !this.chew) {
        // tirón de hierba y a masticar, desde un punto al azar de la grabación para que no suene siempre igual
        this.play('grass', null, { vol: 0.5 });
        const ctx = this.ctx!;
        const src = ctx.createBufferSource();
        src.buffer = chew;
        src.loop = true;
        src.playbackRate.value = 1.1 + Math.random() * 0.1; // la oveja es más pequeña que el caballo
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.gain.setTargetAtTime(0.55, ctx.currentTime + 0.1, 0.08);
        src.connect(gain).connect(this.master!);
        src.start(ctx.currentTime, Math.random() * (chew.duration - 2));
        this.chew = { src, gain };
      } else if (!world.sheep.eating && this.chew) {
        this.stopLoops();
      }
      return;
    }
    if (!world.sheep.eating) return;
    this.eatTimer -= dt;
    if (this.eatTimer > 0) return;
    this.eatTimer = 0.28;
    this.noiseBurst(world.sheep.pos, { dur: 0.06, freq: 2500 + Math.random() * 1500, q: 1.5, vol: 0.12 });
  }

  // ------------------------------------------------------------------ síntesis

  /** Paneo izquierda/derecha según la cámara y volumen por distancia a la oveja. */
  private spatial(at: Vec2 | null, range = 30): AudioNode | null {
    const ctx = this.ctx!;
    if (!at) return this.master;
    const dx = at.x - this.listener.x;
    const dz = at.z - this.listener.z;
    const d = Math.hypot(dx, dz);
    if (d > range) return null;
    const gain = ctx.createGain();
    gain.gain.value = 1 / (1 + (d / (range * 0.25)) ** 2);
    // derecha de la cámara = (cos yaw, -sin yaw)
    const pan = d < 0.5 ? 0 : (dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw)) / d;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan * 0.85));
      gain.connect(p).connect(this.master!);
    } else {
      gain.connect(this.master!);
    }
    return gain;
  }

  private env(g: GainNode, t: number, attack: number, peak: number, release: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
  }

  private noiseBurst(at: Vec2 | null, o: { dur: number; freq: number; q: number; vol: number; sweepTo?: number; type?: BiquadFilterType }): void {
    const out = this.spatial(at);
    if (!out) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'bandpass';
    f.frequency.setValueAtTime(o.freq, t);
    if (o.sweepTo) f.frequency.exponentialRampToValueAtTime(o.sweepTo, t + o.dur);
    f.Q.value = o.q;
    const g = ctx.createGain();
    this.env(g, t, 0.005, o.vol, o.dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + o.dur + 0.05);
  }

  private tone(at: Vec2 | null, o: { type: OscillatorType; from: number; to: number; dur: number; vol: number; when?: number; attack?: number }): void {
    const out = this.spatial(at);
    if (!out) return;
    const ctx = this.ctx!;
    const t = o.when ?? ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.from, t);
    osc.frequency.exponentialRampToValueAtTime(o.to, t + o.dur);
    const g = ctx.createGain();
    this.env(g, t, o.attack ?? 0.005, o.vol, o.dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + (o.attack ?? 0.005) + o.dur + 0.05);
  }

  /** Aullido: sube, se mantiene con vibrato y cae. */
  private howl(at: Vec2, vol: number, far = false): void {
    const out = this.spatial(at, 80);
    if (!out) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const base = 280 + Math.random() * 80;
    const dur = 1.8 + Math.random() * 0.6;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.exponentialRampToValueAtTime(base * 1.9, t + 0.35);
    osc.frequency.setValueAtTime(base * 1.9, t + dur * 0.7);
    osc.frequency.exponentialRampToValueAtTime(base * 1.2, t + dur);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = base * 0.04;
    lfo.connect(lfoGain).connect(osc.frequency);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = far ? 900 : 1600;
    f.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25 * vol, t + 0.3);
    g.gain.setValueAtTime(0.25 * vol, t + dur * 0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    // eco del bosque
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.28;
    const fb = ctx.createGain();
    fb.gain.value = 0.35;
    osc.connect(f).connect(g);
    g.connect(out);
    g.connect(delay).connect(fb).connect(delay);
    fb.connect(out);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + dur + 0.1);
    lfo.stop(t + dur + 0.1);
  }

  private bite(at: Vec2): void {
    this.noiseBurst(at, { dur: 0.09, freq: 1200, q: 2, vol: 0.5 });
    this.tone(at, { type: 'square', from: 140, to: 70, dur: 0.07, vol: 0.12 });
  }

  private crack(at: Vec2, heavy: boolean): void {
    this.noiseBurst(at, { dur: heavy ? 0.6 : 0.35, freq: heavy ? 700 : 1800, q: 0.8, vol: 0.8, sweepTo: 200, type: 'lowpass' });
    this.tone(at, { type: 'sine', from: heavy ? 90 : 130, to: 40, dur: 0.3, vol: 0.5 });
  }

  private knock(at: Vec2, freq: number): void {
    this.tone(at, { type: 'triangle', from: freq, to: freq * 0.6, dur: 0.12, vol: 0.4 });
    this.noiseBurst(at, { dur: 0.03, freq: 3000, q: 1, vol: 0.2 });
  }

  private whoosh(at: Vec2, dur: number, from: number, to: number): void {
    this.noiseBurst(at, { dur, freq: from, q: 1.2, vol: 0.25, sweepTo: to });
  }

  private thud(at: Vec2, vol: number, freq = 90): void {
    this.tone(at, { type: 'sine', from: freq, to: freq * 0.5, dur: 0.12, vol: 0.5 * vol });
  }

  private sniff(at: Vec2): void {
    for (let k = 0; k < 3; k++) {
      const t = this.ctx!.currentTime + k * 0.12;
      const out = this.spatial(at, 20);
      if (!out) return;
      const src = this.ctx!.createBufferSource();
      src.buffer = this.noise;
      const f = this.ctx!.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 2500;
      const g = this.ctx!.createGain();
      this.env(g, t, 0.02, 0.15, 0.06);
      src.connect(f).connect(g).connect(out);
      src.start(t, Math.random() * 0.5);
      src.stop(t + 0.1);
    }
  }

  private beat(when: number, vol: number): void {
    this.tone(null, { type: 'sine', from: 62, to: 40, dur: 0.11, vol, when, attack: 0.01 });
  }

  private caught(): void {
    this.tone(null, { type: 'sawtooth', from: 220, to: 55, dur: 0.9, vol: 0.35 });
    this.tone(null, { type: 'sawtooth', from: 233, to: 58, dur: 0.9, vol: 0.3 });
    this.noiseBurst(null, { dur: 0.4, freq: 900, q: 0.7, vol: 0.6, sweepTo: 150, type: 'lowpass' });
  }
}

