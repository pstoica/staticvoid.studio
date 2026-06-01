import type { Board, Cell, Mark, Outcome, WinLine } from './types';

export const EMPTY_BOARD: Board = [null, null, null, null, null, null, null, null, null];

export const WIN_LINES: ReadonlyArray<WinLine> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function opposite(mark: Mark): Mark {
  return mark === 'X' ? 'O' : 'X';
}

export function play(board: Board, index: number, mark: Mark): Board {
  if (board[index] !== null) {
    throw new Error(`cell ${index} already occupied`);
  }
  const next = board.slice() as Cell[];
  next[index] = mark;
  return next as unknown as Board;
}

export function availableMoves(board: Board): number[] {
  const out: number[] = [];
  for (let i = 0; i < 9; i++) if (board[i] === null) out.push(i);
  return out;
}

export function evaluate(board: Board): Outcome {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    const v = board[a];
    if (v !== null && v === board[b] && v === board[c]) {
      return { kind: 'win', winner: v, line };
    }
  }
  if (board.every(c => c !== null)) return { kind: 'draw' };
  return { kind: 'ongoing' };
}
