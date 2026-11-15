// Mensajes entre el navegador y el servidor multijugador (JSON por WebSocket).
// El servidor manda: ejecuta la simulación y reparte el estado. Los jugadores solo envían sus órdenes.
import type { PlayerInput } from '../sim/entities';
import type { Snapshot } from './snapshot';

/** Cambia si el formato de los mensajes deja de ser compatible (cliente y servidor deben coincidir). */
export const NET_VERSION = 3;
/** Ruta del WebSocket en el servidor (en desarrollo, Vite la redirige al servidor). */
export const WS_PATH = '/ws';
export const MAX_NAME = 16;
export const MAX_ROOM = 24;
export const MAX_PLAYERS = 8;

export interface PlayerInfo {
  id: number;
  name: string;
  /** Modo niño: solo cambia su oveja (ver CONFIG.kid). */
  kid?: boolean;
}

export type ClientMsg =
  | { t: 'join'; v: number; name: string; room: string; kid?: boolean }
  /** Solo el anfitrión: empezar la partida en esa noche (índice). */
  | { t: 'start'; night: number }
  | { t: 'input'; i: PlayerInput }
  /** Hora de la última foto recibida: el servidor no manda más si el jugador va muy atrasado. */
  | { t: 'ack'; s: number };

export type ServerMsg =
  | { t: 'welcome'; id: number; room: string }
  /** Quién hay en la sala; `playing`: hay una partida en marcha. */
  | { t: 'room'; players: PlayerInfo[]; host: number; playing: boolean }
  /** Empieza una partida (o entras en una ya empezada): el mapa sale de la semilla. */
  | { t: 'start'; seed: number; night: number; players: PlayerInfo[] }
  | { t: 'snap'; s: Snapshot }
  | { t: 'error'; msg: string };

export const cleanName = (s: unknown, max: number): string =>
  String(s ?? '')
    .replace(/[\u0000-\u001f<>&"']/g, '')
    .trim()
    .slice(0, max);
