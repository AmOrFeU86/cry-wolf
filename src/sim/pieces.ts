import { CONFIG } from '../config';
import { Cell, type CellType } from './Grid';

export type PieceId = keyof typeof CONFIG.pieces;
export const PIECES: PieceId[] = ['fence', 'hedge', 'wall', 'gate', 'tower'];
/** Lo que se elige en la barra (teclas 1-7): las piezas, el puente entre torres y la piña para lanzar. */
export type ItemId = PieceId | 'bridge' | 'pinecone';
export const ITEMS: ItemId[] = [...PIECES, 'bridge', 'pinecone'];

export const itemInfo = (id: ItemId) => (id === 'pinecone' ? CONFIG.pinecone : id === 'bridge' ? CONFIG.bridge : CONFIG.pieces[id]);

export const PIECE_CELL: Record<PieceId, CellType> = {
  fence: Cell.Fence,
  hedge: Cell.Hedge,
  wall: Cell.Wall,
  gate: Cell.Gate,
  tower: Cell.Tower,
};

export function pieceOfCell(c: number): PieceId | null {
  return PIECES.find((p) => PIECE_CELL[p] === c) ?? null;
}
