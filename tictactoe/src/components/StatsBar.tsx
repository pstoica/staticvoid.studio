import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { animate, utils } from 'animejs';
import type { GameRecord, GameResult, Stats } from '../game/stats';
import styles from './StatsBar.module.css';

interface StatsBarProps {
  stats: Stats;
  onReset: () => void;
}

const TOKEN: Record<GameResult, string> = {
  win: 'W',
  loss: 'L',
  draw: 'D',
};

const VALUE_CLASS: Record<GameResult, string> = {
  win: styles.statsValueWin,
  loss: styles.statsValueLoss,
  draw: styles.statsValueDraw,
};

const TOKEN_CLASS: Record<GameResult, string> = {
  win: styles.statsTokenWin,
  loss: styles.statsTokenLoss,
  draw: styles.statsTokenDraw,
};

// keeps the strip narrow enough to fit the pill within the stage on mobile
const STRIP_CAP = 10;

export function StatsBar({ stats, onReset }: StatsBarProps) {
  const [confirming, setConfirming] = useState(false);
  const hasAny = stats.wins + stats.losses + stats.draws > 0;

  if (confirming) {
    return (
      <div
        className={`${styles.stats} ${styles.statsConfirm}`}
        role="alertdialog"
        aria-label="reset history confirmation"
      >
        <span className={styles.statsConfirmText}>Reset history?</span>
        <div className={styles.statsConfirmBtns}>
          <button
            type="button"
            className={`${styles.statsConfirmBtn} ${styles.statsConfirmBtnYes}`}
            onClick={() => {
              onReset();
              setConfirming(false);
            }}
            autoFocus
          >
            Yes
          </button>
          <button
            type="button"
            className={`${styles.statsConfirmBtn} ${styles.statsConfirmBtnNo}`}
            onClick={() => setConfirming(false)}
          >
            No
          </button>
        </div>
      </div>
    );
  }

  const recent = stats.history.slice(-STRIP_CAP);

  return (
    <div className={styles.stats} aria-label="win loss record">
      <div className={styles.statsGroup}>
        <span className={styles.statsLabel}>W</span>
        <span className={`${styles.statsValue} ${VALUE_CLASS.win}`}>{stats.wins}</span>
      </div>
      <div className={styles.statsGroup}>
        <span className={styles.statsLabel}>L</span>
        <span className={`${styles.statsValue} ${VALUE_CLASS.loss}`}>{stats.losses}</span>
      </div>
      <div className={styles.statsGroup}>
        <span className={styles.statsLabel}>D</span>
        <span className={`${styles.statsValue} ${VALUE_CLASS.draw}`}>{stats.draws}</span>
      </div>
      {recent.length > 0 && <StatsStrip recent={recent} />}
      {hasAny && (
        <button
          type="button"
          className={styles.statsReset}
          onClick={() => setConfirming(true)}
          aria-label="reset history"
          title="Reset history"
        >
          <svg className={styles.statsResetIcon} viewBox="-6 -6 12 12" aria-hidden="true">
            <path d="M -3 -3 L 3 3 M 3 -3 L -3 3" />
          </svg>
        </button>
      )}
    </div>
  );
}

/* Fixed-width overflow container. Once the cap is hit, the inner row shifts
   left by one slot (translateX) so the oldest token exits through the left
   edge while the new one enters from the right, each with its own fade.
   Pre-cap adds just fade in place. */

interface StatsStripProps {
  recent: GameRecord[];
}

const TOKEN_STEP = 16; // token width (12px) + gap (4px)
const DURATION = 340;
const EASE = 'outQuart';

function StatsStrip({ recent }: StatsStripProps) {
  const [displayed, setDisplayed] = useState<GameRecord[]>(recent);
  const elRefs = useRef(new Map<string, HTMLSpanElement>());
  const rowRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<GameRecord[]>(recent);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = recent;

    if (prev.length === recent.length && prev.every((p, i) => p.at === recent[i]?.at)) {
      return;
    }

    const prevAt = new Set(prev.map(p => p.at));
    const recentAt = new Set(recent.map(r => r.at));
    const newEntry = recent.find(r => !prevAt.has(r.at));
    const oldEntry = prev.find(p => !recentAt.has(p.at));

    if (!newEntry) {
      // reset or other backfill — snap to whatever recent is now
      setDisplayed(recent);
      return;
    }

    // keep the outgoing token at slot 0 while it slides out; the container's
    // overflow clips anything past its edges
    setDisplayed(oldEntry ? [oldEntry, ...recent] : recent);

    const frame = requestAnimationFrame(() => {
      const row = rowRef.current;
      const newEl = elRefs.current.get(newEntry.at);
      const oldEl = oldEntry ? elRefs.current.get(oldEntry.at) : null;

      if (oldEntry && row && oldEl && newEl) {
        // row scrolls one slot left while old fades out the left edge and
        // new fades in from the right
        utils.set(row, { translateX: 0 });
        animate(row, {
          translateX: [0, -TOKEN_STEP],
          duration: DURATION,
          ease: EASE,
          onComplete: () => {
            // flushSync so the 12-item state commits in the same paint as
            // resetting translateX — otherwise one frame shows 13 items at
            // translateX: 0 and the trailing token clips past the edge.
            flushSync(() => {
              setDisplayed(recent);
            });
            utils.set(row, { translateX: 0 });
          },
        });
        animate(oldEl, {
          opacity: [1, 0],
          duration: DURATION,
          ease: EASE,
        });
        animate(newEl, {
          opacity: [0, 1],
          duration: DURATION,
          ease: EASE,
        });
      } else if (newEl) {
        // pre-cap append — just fade in at its natural flex slot
        animate(newEl, {
          opacity: [0, 1],
          duration: DURATION,
          ease: EASE,
        });
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [recent]);

  // visible width = visible token count × slot step − trailing gap. clamped
  // at STRIP_CAP because during the cap transition `displayed` briefly
  // carries cap+1 entries (the outgoing one), and the strip should hold
  // its ceiling width.
  const visibleCount = Math.min(displayed.length, STRIP_CAP);
  const stripWidth = Math.max(0, visibleCount * TOKEN_STEP - 4);

  return (
    <div className={styles.statsStrip} style={{ width: `${stripWidth}px` }} aria-label="recent games">
      <div className={styles.statsStripRow} ref={rowRef}>
        {displayed.map(r => (
          <span
            key={r.at}
            ref={el => {
              if (el) elRefs.current.set(r.at, el);
              else elRefs.current.delete(r.at);
            }}
            className={`${styles.statsToken} ${TOKEN_CLASS[r.result]}`}
            title={r.result}
          >
            {TOKEN[r.result]}
          </span>
        ))}
      </div>
    </div>
  );
}
