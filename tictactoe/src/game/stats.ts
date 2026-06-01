import type { Difficulty } from './types';

export type GameResult = 'win' | 'loss' | 'draw';

export interface GameRecord {
  result: GameResult;
  difficulty: Difficulty;
  at: string;
}

export interface Stats {
  wins: number;
  losses: number;
  draws: number;
  history: GameRecord[];
}

const STORAGE_KEY = 'tictactoe:stats:v1';
const HISTORY_CAP = 30;

export const EMPTY_STATS: Stats = {
  wins: 0,
  losses: 0,
  draws: 0,
  history: [],
};

export function clearStats(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function loadStats(): Stats {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STATS;
    const parsed = JSON.parse(raw) as Partial<Stats>;
    return {
      wins: parsed.wins ?? 0,
      losses: parsed.losses ?? 0,
      draws: parsed.draws ?? 0,
      history: Array.isArray(parsed.history) ? parsed.history.slice(-HISTORY_CAP) : [],
    };
  } catch {
    return EMPTY_STATS;
  }
}

export function saveStats(stats: Stats): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // ignore quota / privacy-mode failures
  }
}

export function appendResult(stats: Stats, record: GameRecord): Stats {
  const next: Stats = {
    wins: stats.wins + (record.result === 'win' ? 1 : 0),
    losses: stats.losses + (record.result === 'loss' ? 1 : 0),
    draws: stats.draws + (record.result === 'draw' ? 1 : 0),
    history: [...stats.history, record].slice(-HISTORY_CAP),
  };
  return next;
}
