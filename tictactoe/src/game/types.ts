export type Mark = 'X' | 'O';

export type Cell = Mark | null;

export type Board = readonly [Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell];

export type WinLine = readonly [number, number, number];

export type Outcome =
  | { kind: 'ongoing' }
  | { kind: 'draw' }
  | { kind: 'win'; winner: Mark; line: WinLine };

export type Difficulty = 'easy' | 'medium' | 'hard';

export type PlayerKind = 'human' | 'cpu';
