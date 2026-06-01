import { useLayoutEffect, useRef } from 'react';
import { animateBrandCalculating, animateBrandHues } from '../anim';
import styles from './Brand.module.css';

const BRAND_CHARS: ReadonlyArray<{ ch: string; kind: 'letter' | 'dot' }> = [
  { ch: 't', kind: 'letter' },
  { ch: 'i', kind: 'letter' },
  { ch: 'c', kind: 'letter' },
  { ch: '·', kind: 'dot' },
  { ch: 't', kind: 'letter' },
  { ch: 'a', kind: 'letter' },
  { ch: 'c', kind: 'letter' },
  { ch: '·', kind: 'dot' },
  { ch: 't', kind: 'letter' },
  { ch: 'o', kind: 'letter' },
  { ch: 'e', kind: 'letter' },
];

interface BrandProps {
  /** flicker the per-letter hues randomly while the game is resolving */
  calculating?: boolean;
}

export function Brand({ calculating = false }: BrandProps) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const cleanup = calculating
      ? animateBrandCalculating(ref.current)
      : animateBrandHues(ref.current);
    return cleanup;
  }, [calculating]);

  return (
    <div className={styles.brand} ref={ref} aria-label="tictactoe">
      {BRAND_CHARS.map((c, i) => (
        <span
          key={i}
          className={c.kind === 'dot' ? styles.brandDot : styles.brandLetter}
          aria-hidden="true"
        >
          {c.kind === 'dot' ? '' : c.ch}
        </span>
      ))}
    </div>
  );
}
