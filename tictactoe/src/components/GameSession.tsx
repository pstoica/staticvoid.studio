import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Board } from './Board';
import { useGameSounds } from '../audio';
import { CPU_MARK, HUMAN_MARK } from '../game/constants';
import { EMPTY_BOARD, evaluate, opposite, play } from '../game/board';
import { CpuPlayer, HumanPlayer, type Player } from '../game/players';
import type { GameResult } from '../game/stats';
import type { Board as BoardType, Difficulty, Mark, Outcome } from '../game/types';

interface GameSessionProps {
  difficulty: Difficulty;
  onFinish: (result: GameResult) => void;
  /** fired once when the outcome settles and we start the pre-EndScreen delay */
  onCalculating?: () => void;
}

export function GameSession({ difficulty, onFinish, onCalculating }: GameSessionProps) {
  const [board, setBoard] = useState<BoardType>(EMPTY_BOARD);
  // coin flip on who starts — with perfect play tic-tac-toe is a forced draw
  // either way, but X has a real edge against imperfect opponents (more moves,
  // sets the rhythm), so letting the CPU go first sometimes keeps Easy/Medium
  // from feeling one-sided.
  const [current, setCurrent] = useState<Mark>(() =>
    Math.random() < 0.5 ? HUMAN_MARK : CPU_MARK,
  );
  const sounds = useGameSounds();

  const players = useMemo<Record<Mark, Player>>(
    () => ({
      X: new HumanPlayer(HUMAN_MARK),
      O: new CpuPlayer(CPU_MARK, difficulty),
    }),
    [difficulty],
  );

  const outcome: Outcome = useMemo(() => evaluate(board), [board]);
  // derived from current + outcome — no need to track it as state
  const busy = players[current].kind === 'cpu' && outcome.kind === 'ongoing';
  const finishedRef = useRef(false);

  // parent callbacks can re-identify on every render (e.g. an inline arrow
  // around onFinish). keeping them in refs means the end-of-game effect only
  // depends on `outcome`, so it doesn't re-run and clobber its own timer
  // when App re-renders in the middle of the 1300ms resolving window. same
  // rationale for `sounds`: its identity flips when the audio patch loads,
  // which would otherwise retrigger the move-lander effect mid-turn.
  const onFinishRef = useRef(onFinish);
  const onCalculatingRef = useRef(onCalculating);
  const soundsRef = useRef(sounds);
  useEffect(() => {
    onFinishRef.current = onFinish;
    onCalculatingRef.current = onCalculating;
    soundsRef.current = sounds;
  });

  useEffect(() => {
    if (outcome.kind !== 'ongoing') return;
    const player = players[current];
    const ac = new AbortController();

    player
      .chooseMove(board, ac.signal)
      .then(idx => {
        setBoard(prev => {
          if (prev[idx] !== null) return prev;
          return play(prev, idx, current);
        });
        setCurrent(opposite(current));
        if (player.kind === 'cpu') soundsRef.current.placeCpu();
        else soundsRef.current.placeHuman();
      })
      .catch(err => {
        if ((err as Error).name !== 'AbortError') console.error(err);
      });

    return () => ac.abort();
  }, [board, current, outcome.kind, players]);

  useEffect(() => {
    if (outcome.kind === 'ongoing' || finishedRef.current) return;
    finishedRef.current = true;
    onCalculatingRef.current?.();
    const result: GameResult =
      outcome.kind === 'draw' ? 'draw' : outcome.winner === HUMAN_MARK ? 'win' : 'loss';
    const t = window.setTimeout(() => onFinishRef.current(result), 1300);
    return () => window.clearTimeout(t);
  }, [outcome]);

  const handleCellClick = useCallback(
    (idx: number) => {
      const human = players[HUMAN_MARK] as HumanPlayer;
      if (current !== HUMAN_MARK) return;
      if (board[idx] !== null) return;
      human.submit(idx);
    },
    [board, current, players],
  );

  return (
    <Board
      board={board}
      outcome={outcome}
      current={current}
      busy={busy}
      onCellClick={handleCellClick}
    />
  );
}
