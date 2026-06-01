import { useCallback, useState } from 'react';
import { Background } from './components/Background';
import { Brand } from './components/Brand';
import { DifficultyPicker } from './components/DifficultyPicker';
import { EndScreen } from './components/EndScreen';
import { GameSession } from './components/GameSession';
import { StatsBar } from './components/StatsBar';
import {
  appendResult,
  clearStats,
  EMPTY_STATS,
  loadStats,
  saveStats,
  type GameResult,
} from './game/stats';
import type { Difficulty } from './game/types';

type Phase =
  | { kind: 'pick' }
  | { kind: 'playing'; difficulty: Difficulty; gameId: number }
  | { kind: 'finished'; difficulty: Difficulty; result: GameResult };

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const [stats, setStats] = useState(() => loadStats());
  // true for the pre-EndScreen window where GameSession is waiting to resolve —
  // drives the brand wordmark's "calculating" flicker
  const [calculating, setCalculating] = useState(false);

  const startGame = useCallback((difficulty: Difficulty) => {
    setCalculating(false);
    setPhase({ kind: 'playing', difficulty, gameId: Date.now() });
  }, []);

  const finishGame = useCallback((difficulty: Difficulty, result: GameResult) => {
    setCalculating(false);
    setStats(prev => {
      const next = appendResult(prev, { result, difficulty, at: new Date().toISOString() });
      saveStats(next);
      return next;
    });
    setPhase({ kind: 'finished', difficulty, result });
  }, []);

  const handleCalculating = useCallback(() => setCalculating(true), []);

  const resetHistory = useCallback(() => {
    clearStats();
    setStats(EMPTY_STATS);
  }, []);

  return (
    <>
      <Background dim={phase.kind === 'playing'} />
      <div className="app">
        <div className="stage">
          <div className="stage__top">
            <Brand calculating={calculating} />
            <StatsBar stats={stats} onReset={resetHistory} />
          </div>

          <div className="stage__main">
            {phase.kind === 'pick' && <DifficultyPicker onConfirm={startGame} />}

            {phase.kind === 'playing' && (
              <GameSession
                key={phase.gameId}
                difficulty={phase.difficulty}
                onFinish={result => finishGame(phase.difficulty, result)}
                onCalculating={handleCalculating}
              />
            )}

            {phase.kind === 'finished' && (
              <EndScreen
                result={phase.result}
                difficulty={phase.difficulty}
                onReplay={startGame}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
