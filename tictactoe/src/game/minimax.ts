import { availableMoves, evaluate, opposite, play } from './board';
import type { Board, Mark } from './types';

const WIN = 10;

function score(board: Board, turn: Mark, perspective: Mark, depth: number): number {
  const outcome = evaluate(board);
  if (outcome.kind === 'win') {
    return outcome.winner === perspective ? WIN - depth : depth - WIN;
  }
  if (outcome.kind === 'draw') return 0;

  const isMax = turn === perspective;
  let best = isMax ? -Infinity : Infinity;
  for (const m of availableMoves(board)) {
    const s = score(play(board, m, turn), opposite(turn), perspective, depth + 1);
    if (isMax) {
      if (s > best) best = s;
    } else {
      if (s < best) best = s;
    }
  }
  return best;
}

export function bestMove(board: Board, mark: Mark): number {
  const moves = availableMoves(board);
  if (moves.length === 0) throw new Error('no moves available');

  let bestScore = -Infinity;
  let tied: number[] = [];
  for (const m of moves) {
    const s = score(play(board, m, mark), opposite(mark), mark, 1);
    if (s > bestScore) {
      bestScore = s;
      tied = [m];
    } else if (s === bestScore) {
      tied.push(m);
    }
  }
  return tied[Math.floor(Math.random() * tied.length)]!;
}

export function randomMove(board: Board): number {
  const moves = availableMoves(board);
  if (moves.length === 0) throw new Error('no moves available');
  return moves[Math.floor(Math.random() * moves.length)]!;
}
