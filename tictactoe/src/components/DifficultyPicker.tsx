import { useLayoutEffect, useRef } from 'react';
import { ensureReady } from '@web-kits/audio';
import { animatePickerFadeIn, animatePickerIn, animatePickerOut } from '../anim';
import { useGameSounds } from '../audio';
import type { Difficulty } from '../game/types';
import styles from './DifficultyPicker.module.css';
import { Button } from './Button';

interface DifficultyPickerProps {
  title?: string;
  onConfirm: (difficulty: Difficulty) => void;
  /** 'stagger' is the delayed first-load entrance; 'fade' is the plain
      fade used when the picker is taking over from the EndScreen card. */
  entrance?: 'stagger' | 'fade';
}

interface Option {
  value: Difficulty;
  name: string;
  stars: number;
  hue: number;
}

const OPTIONS: Option[] = [
  { value: 'easy', name: 'Easy', stars: 1, hue: 145 },
  { value: 'medium', name: 'Medium', stars: 2, hue: 275 },
  { value: 'hard', name: 'Hard', stars: 3, hue: 25 },
];

export function DifficultyPicker({
  title = 'Choose your difficulty',
  onConfirm,
  entrance = 'stagger',
}: DifficultyPickerProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const sounds = useGameSounds();

  useLayoutEffect(() => {
    if (!cardRef.current) return;
    if (entrance === 'fade') {
      animatePickerFadeIn(cardRef.current);
      return;
    }
    const opts = optionRefs.current.filter((o): o is HTMLButtonElement => !!o);
    animatePickerIn(cardRef.current, opts);
    // entrance is captured at mount — the picker only mounts once per phase
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSelect = async (value: Difficulty) => {
    if (!cardRef.current) return;
    // first user gesture — unlocks the AudioContext for the rest of the session
    ensureReady();
    sounds.button();
    await animatePickerOut(cardRef.current);
    onConfirm(value);
  };

  const onOptionKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      optionRefs.current[(i + 1) % OPTIONS.length]?.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      optionRefs.current[(i - 1 + OPTIONS.length) % OPTIONS.length]?.focus();
    }
  };

  return (
    <div className={styles.picker} ref={cardRef}>
      <h2 className={styles.pickerTitle}>{title}</h2>
      <div className={styles.pickerOptions} aria-label="difficulty">
        {OPTIONS.map((opt, i) => (
          <Button
            key={opt.value}
            ref={el => {
              optionRefs.current[i] = el;
            }}
            type="button"
            className={styles.optCard}
            onClick={() => onSelect(opt.value)}
            onKeyDown={e => onOptionKeyDown(e, i)}
            hue={opt.hue}
          >
            <span className={styles.optCardName}>{opt.name}</span>
            <span className={styles.optCardStars} aria-label={`${opt.stars} of 3`}>
              {[1, 2, 3].map(n => (
                <span
                  key={n}
                  className={`${styles.optCardStar} ${n <= opt.stars ? styles.optCardStarOn : styles.optCardStarOff}`}
                  aria-hidden="true"
                >
                  ★
                </span>
              ))}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
