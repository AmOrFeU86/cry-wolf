import { CONFIG } from '../config';
import type { Vec2 } from './Grid';
import type { ItemId } from './pieces';

/** Intención del jugador en un frame. Es lo que en multijugador se enviará al servidor. */
export interface PlayerInput {
  moveX: number; // dirección en el mundo (ya rotada según la cámara)
  moveZ: number;
  aimX: number; // si no hay aimAt: dirección en la que construir (a 1,5 m); 0,0 = hacia donde mira la oveja
  aimZ: number;
  /** Punto del suelo donde apunta el jugador (la mira). Se acerca a la oveja si está más lejos de buildRange. */
  aimAt: Vec2 | null;
  sprint: boolean;
  dash: boolean;
  eat: boolean;
  climb: boolean; // mantener junto a una torre para subir
  buildMode: boolean;
  item: ItemId; // pieza a construir o piña a lanzar
  place: boolean; // mantenerlo pulsado construye en cada celda nueva a la que apuntes
  remove: boolean; // desmontar la construcción apuntada
}

export const emptyInput = (): PlayerInput => ({
  moveX: 0,
  moveZ: 0,
  aimX: 0,
  aimZ: 0,
  aimAt: null,
  sprint: false,
  dash: false,
  eat: false,
  climb: false,
  buildMode: false,
  item: 'fence',
  place: false,
  remove: false,
});

export class Sheep {
  pos: Vec2 = { x: 0.5, z: 0.5 };
  vel: Vec2 = { x: 0, z: 0 };
  facing = 0; // ángulo; dirección = (sin, cos)
  stamina = CONFIG.sheep.staminaMax;
  exhausted = false;
  dashTimer = 0;
  dashCooldown = 0;
  dashDir: Vec2 = { x: 0, z: 1 };
  wool = CONFIG.startWool;
  eating = false;
  /** Celda de la torre en la que está subida. */
  tower: [number, number] | null = null;
  /** Cruzando un puente: de la torre `from` a `to`, t de 0 a 1. */
  crossing: { from: [number, number]; to: [number, number]; t: number } | null = null;
  climb = 0; // segundos que lleva subiendo
  /** 0 en el suelo, 1 arriba de una torre (para el render y las repeticiones). */
  elevation = 0;
  stun = 0;
  throwCooldown = 0;

  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }
}

export type WolfPhase = 'chase' | 'windup' | 'pounce' | 'recover';
/** wander: merodea · investigate: va a un ruido/aullido · hunt: te ve · search: te ha perdido · track: sigue tu olor */
export type WolfMode = 'wander' | 'investigate' | 'hunt' | 'search' | 'track';

export class Wolf {
  private static nextId = 1;
  readonly id = Wolf.nextId++;
  pos: Vec2;
  heading = 0;
  speed = 0;
  path: [number, number][] | null = null;
  pathIdx = 0;
  repathTimer = 0;
  attacking: [number, number] | null = null;
  biteTimer = 0;
  phase: WolfPhase = 'chase';
  phaseTime = 0;
  pounceCooldown = 0;
  mode: WolfMode = 'wander';
  modeTime = 0;
  target: Vec2 | null = null;
  sees = false;
  lastSeen: Vec2 | null = null;
  lastSeenVel: Vec2 = { x: 0, z: 0 };
  howlCooldown = 0;
  lostTime = 0;
  trackT = 0; // momento de la huella que está siguiendo

  constructor(x: number, z: number) {
    this.pos = { x, z };
  }
}

/** Huella de olor: posición y momento en que se dejó. */
export interface Scent {
  x: number;
  z: number;
  t: number;
}

export interface Grass {
  i: number;
  j: number;
  x: number;
  z: number;
  amount: number;
  regrow: number;
}
