import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  animateDrawTitle,
  animateEndCardIn,
  animateEndCardOut,
  animateLossTitle,
  animateWinTitle,
} from '../anim';
import { useGameSounds } from '../audio';
import type { GameResult } from '../game/stats';
import { DifficultyPicker } from './DifficultyPicker';
import type { Difficulty } from '../game/types';
import { Button } from './Button';
import styles from './EndScreen.module.css';

interface EndScreenProps {
  result: GameResult;
  difficulty: Difficulty;
  onReplay: (difficulty: Difficulty) => void;
}

const TITLES: Record<GameResult, string> = {
  win: 'YOU WIN',
  loss: 'YOU LOSE',
  draw: 'DRAW',
};

const HUE_FOR_RESULT: Record<GameResult, number> = {
  win: 145,
  loss: 25,
  draw: 275,
};

const VARIANT_CLASS: Record<GameResult, string> = {
  win: styles.endWin,
  loss: styles.endLoss,
  draw: styles.endDraw,
};

export function EndScreen({ result, difficulty, onReplay }: EndScreenProps) {
  const [showPicker, setShowPicker] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const charRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const actionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const sounds = useGameSounds();

  const onActionKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      actionRefs.current[(i + 1) % actionRefs.current.length]?.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const len = actionRefs.current.length;
      actionRefs.current[(i - 1 + len) % len]?.focus();
    }
  };

  const chars = useMemo(() => Array.from(TITLES[result]), [result]);

  useLayoutEffect(() => {
    if (cardRef.current) animateEndCardIn(cardRef.current);
    // reveal sound lands with the title anim
    if (result === 'win') sounds.win();
    else if (result === 'loss') sounds.lose();
    else sounds.draw();
    // only fire once on mount; `sounds` identity is stable after patch load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const els = charRefs.current.filter((c): c is HTMLSpanElement => !!c);
    if (els.length === 0) return;
    if (result === 'win') return animateWinTitle(els);
    if (result === 'loss') return animateLossTitle(els);
    return animateDrawTitle(els);
  }, [result]);

  if (showPicker) {
    return (
      <div className={styles.end} role="dialog" aria-modal="true" aria-label="choose next opponent">
        <DifficultyPicker onConfirm={onReplay} entrance="fade" />
      </div>
    );
  }

  const accentHue = HUE_FOR_RESULT[result];

  return (
    <div
      className={`${styles.end} ${VARIANT_CLASS[result]}`}
      role="dialog"
      aria-modal="true"
      aria-label={TITLES[result]}
    >
      <div className={styles.endCard} ref={cardRef}>
        <h2 className={styles.endTitle} aria-label={TITLES[result]}>
          {chars.map((ch, i) => (
            <span
              key={i}
              ref={el => {
                charRefs.current[i] = el;
              }}
              className={styles.endChar}
              aria-hidden="true"
            >
              {ch === ' ' ? ' ' : ch}
            </span>
          ))}
        </h2>
        <p className={styles.endSub}>
          {result === 'win' && 'clean line — run it back?'}
          {result === 'loss' && 'tough one — try again'}
          {result === 'draw' && 'dead even — rematch?'}
        </p>
        <div className={styles.endActions}>
          <Button
            ref={el => {
              actionRefs.current[0] = el;
            }}
            block
            hue={accentHue}
            onClick={async () => {
              sounds.button();
              if (cardRef.current) await animateEndCardOut(cardRef.current);
              onReplay(difficulty);
            }}
            onKeyDown={e => onActionKeyDown(e, 0)}
            autoFocus
          >
            Play again
          </Button>
          <Button
            ref={el => {
              actionRefs.current[1] = el;
            }}
            block
            ghost
            onClick={async () => {
              sounds.button();
              if (cardRef.current) await animateEndCardOut(cardRef.current);
              setShowPicker(true);
            }}
            onKeyDown={e => onActionKeyDown(e, 1)}
          >
            Change difficulty
          </Button>
        </div>
      </div>
    </div>
  );
}
