import { bestMove, randomMove } from './minimax';
import type { Board, Difficulty, Mark, PlayerKind } from './types';

export interface Player {
  readonly mark: Mark;
  readonly kind: PlayerKind;
  chooseMove(board: Board, signal: AbortSignal): Promise<number>;
}

export class HumanPlayer implements Player {
  readonly kind: PlayerKind = 'human';
  private pending: ((idx: number) => void) | null = null;

  constructor(readonly mark: Mark) {}

  chooseMove(_board: Board, signal: AbortSignal): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      this.pending = resolve;
      signal.addEventListener(
        'abort',
        () => {
          this.pending = null;
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }

  submit(index: number): boolean {
    const r = this.pending;
    if (!r) return false;
    this.pending = null;
    r(index);
    return true;
  }
}

export class CpuPlayer implements Player {
  readonly kind: PlayerKind = 'cpu';

  constructor(
    readonly mark: Mark,
    readonly difficulty: Difficulty,
    private readonly thinkMs = 450,
    /** +/- jitter around thinkMs so the CPU doesn't feel metronomic */
    private readonly thinkJitterMs = 160,
  ) {}

  chooseMove(board: Board, signal: AbortSignal): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      const move = pickByDifficulty(board, this.mark, this.difficulty);
      const jitter = (Math.random() * 2 - 1) * this.thinkJitterMs;
      const delay = Math.max(150, this.thinkMs + jitter);
      const t = window.setTimeout(() => resolve(move), delay);
      signal.addEventListener(
        'abort',
        () => {
          window.clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }
}

function pickByDifficulty(board: Board, mark: Mark, difficulty: Difficulty): number {
  switch (difficulty) {
    case 'easy':
      return randomMove(board);
    case 'medium':
      return Math.random() < 0.18 ? randomMove(board) : bestMove(board, mark);
    case 'hard':
      return bestMove(board, mark);
  }
}
