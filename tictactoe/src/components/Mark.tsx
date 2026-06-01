import { useLayoutEffect, useRef } from 'react';
import { animateMarkGhosts, animateMarkGrow, GHOST_COUNT } from '../anim';
import type { Mark as MarkType } from '../game/types';
import styles from './Mark.module.css';

interface MarkProps {
  mark: MarkType;
  cx: number;
  cy: number;
  size?: number;
  /** part of the winning trio — recolored to --win-color, CSS handles the fade */
  winning?: boolean;
}

const MARK_PATH = (mark: MarkType, cx: number, cy: number, s: number): string => {
  if (mark === 'O') {
    const r = s / 2;
    return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`;
  }
  const h = s / 2;
  return `M ${cx - h} ${cy - h} L ${cx + h} ${cy + h} M ${cx + h} ${cy - h} L ${cx - h} ${cy + h}`;
};

export function Mark({ mark, cx, cy, size = 56, winning = false }: MarkProps) {
  const groupRef = useRef<SVGGElement>(null);
  const ghostRefs = useRef<(SVGPathElement | null)[]>([]);

  useLayoutEffect(() => {
    if (groupRef.current) animateMarkGrow(groupRef.current);
    const ghosts = ghostRefs.current.filter((g): g is SVGPathElement => !!g);
    if (ghosts.length) animateMarkGhosts(ghosts);
  }, []);

  const d = MARK_PATH(mark, cx, cy, size);
  const variantClass = mark === 'X' ? styles.markX : styles.markO;
  const className = [styles.mark, variantClass, winning && styles.markWinning]
    .filter(Boolean)
    .join(' ');

  return (
    <g className={className}>
      <g className={styles.markGhosts}>
        {Array.from({ length: GHOST_COUNT }, (_, i) => (
          <path
            key={i}
            ref={el => {
              ghostRefs.current[i] = el;
            }}
            className={styles.markGhost}
            d={d}
            style={{ '--ghost-hue': (i * (360 / GHOST_COUNT)) % 360 } as React.CSSProperties}
          />
        ))}
      </g>
      {/* only the primary shape receives the grow animation — scaling the
          outer group would also scale the ghosts past the clip boundary */}
      <g ref={groupRef} className={styles.markPrimary}>
        <path className={styles.markPath} d={d} />
      </g>
    </g>
  );
}
