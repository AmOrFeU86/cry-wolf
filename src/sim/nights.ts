import { CONFIG } from '../config';
import { ITEMS, type ItemId } from './pieces';

export type Night = (typeof CONFIG.nights)[number];

export const NIGHTS: readonly Night[] = CONFIG.nights;
/** La última noche: la dificultad completa (y la que usan los bots si no se dice otra cosa). */
export const LAST_NIGHT = NIGHTS.length - 1;

/** Lo que se puede construir o lanzar en una noche: lo desbloqueado en ella y en las anteriores. */
export function itemsForNight(index: number): ItemId[] {
  const unlocked = new Set<string>(NIGHTS.slice(0, index + 1).flatMap((n) => n.unlock));
  return ITEMS.filter((id) => unlocked.has(id));
}

/** Noche (índice) en la que se desbloquea un objeto. */
export function unlockNight(id: ItemId): number {
  return NIGHTS.findIndex((n) => n.unlock.includes(id));
}
