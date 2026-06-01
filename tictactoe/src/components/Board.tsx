import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  animateBoardIn,
  animateBoardOut,
  animateTurnBadgeOut,
  dimNonWinningMarks,
  highlightWinningMarks,
} from '../anim';
import type { Board as BoardType, Mark as MarkType, Outcome } from '../game/types';
import { Mark } from './Mark';
import styles from './Board.module.css';

interface BoardProps {
  board: BoardType;
  outcome: Outcome;
  current: MarkType;
  busy: boolean;
  onCellClick: (index: number) => void;
}

const VIEW = 300;
const CELL = VIEW / 3;

const GRID_LINES: ReadonlyArray<readonly [number, number, number, number]> = [
  [CELL, 0, CELL, VIEW],
  [CELL * 2, 0, CELL * 2, VIEW],
  [0, CELL, VIEW, CELL],
  [0, CELL * 2, VIEW, CELL * 2],
];

export function Board({ board, outcome, current, busy, onCellClick }: BoardProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const turnBadgeRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef<(SVGGElement | null)[]>([]);
  const gridRefs = useRef<(SVGLineElement | null)[]>([]);
  const markRefs = useRef<(SVGGElement | null)[]>([]);
  const hitRefs = useRef<(SVGRectElement | null)[]>([]);

  // roving tabindex — only one cell is in the tab order at a time; arrow keys
  // move focus between the rendered hit rects, so Tab enters the grid once
  // and the user navigates inside with arrow keys (ARIA grid pattern).
  const [focusedCell, setFocusedCell] = useState<number>(4);
  const firstEmpty = board.findIndex(c => c === null);
  const tabbableCell = board[focusedCell] === null ? focusedCell : firstEmpty;

  const moveFocus = (from: number, dir: 'up' | 'down' | 'left' | 'right') => {
    let next = from;
    for (let step = 0; step < 8; step++) {
      switch (dir) {
        case 'up':
          next = (next + 6) % 9;
          break;
        case 'down':
          next = (next + 3) % 9;
          break;
        case 'right':
          next = next % 3 === 2 ? next - 2 : next + 1;
          break;
        case 'left':
          next = next % 3 === 0 ? next + 2 : next - 1;
          break;
      }
      const el = hitRefs.current[next];
      if (el) {
        setFocusedCell(next);
        el.focus();
        return;
      }
    }
  };

  useLayoutEffect(() => {
    if (!turnBadgeRef.current) return;
    const cells = cellRefs.current.filter((c): c is SVGGElement => !!c);
    const lines = gridRefs.current.filter((c): c is SVGLineElement => !!c);
    animateBoardIn(turnBadgeRef.current, cells, lines);
  }, []);

  const winningSet = outcome.kind === 'win' ? new Set<number>(outcome.line) : null;

  // on game end: dim losers + pop winners on a win, and fade the whole wrap
  // so the board has already dimmed by the time EndScreen mounts on top.
  useEffect(() => {
    if (outcome.kind === 'ongoing') return;
    if (outcome.kind === 'win') {
      const winSet = new Set(outcome.line);
      const winning: SVGGElement[] = [];
      const losing: SVGGElement[] = [];
      markRefs.current.forEach((el, i) => {
        if (!el) return;
        (winSet.has(i) ? winning : losing).push(el);
      });
      dimNonWinningMarks(losing);
      highlightWinningMarks(winning);
    }
    if (wrapRef.current) animateBoardOut(wrapRef.current);
    if (turnBadgeRef.current) animateTurnBadgeOut(turnBadgeRef.current);
  }, [outcome]);

  return (
    <div className={styles.boardWrap} ref={wrapRef}>
      {/* always rendered so it reserves layout space — hidden when the game ends */}
      <div
        className={`${styles.turn}${outcome.kind === 'ongoing' ? '' : ` ${styles.turnHidden}`}`}
        style={{ '--turn-hue': current === 'X' ? 25 : 235 } as React.CSSProperties}
        aria-live="polite"
        aria-hidden={outcome.kind !== 'ongoing'}
        ref={turnBadgeRef}
      >
        <span className={styles.turnToken} aria-hidden="true">
          <svg className={styles.turnGlyph} viewBox="-10 -10 20 20">
            {current === 'X' ? (
              <path d="M -5 -5 L 5 5 M 5 -5 L -5 5" />
            ) : (
              <circle cx="0" cy="0" r="5" />
            )}
          </svg>
        </span>
        {busy ? (
          <>
            CPU
            <span className={styles.turnDots} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </>
        ) : (
          <>YOUR TURN</>
        )}
      </div>
      <svg
        className={styles.board}
        style={{ '--cell-hue': current === 'X' ? 25 : 235 } as React.CSSProperties}
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        role="grid"
        aria-label="tic tac toe board"
      >
        {Array.from({ length: 9 }, (_, i) => {
          const x = (i % 3) * CELL;
          const y = Math.floor(i / 3) * CELL;
          const cellValue = board[i];
          const disabled = !!cellValue || outcome.kind !== 'ongoing' || busy;
          return (
            <g
              key={i}
              ref={el => {
                cellRefs.current[i] = el;
              }}
              className={`${styles.cell}${disabled ? '' : ` ${styles.cellInteractive}`}`}
            >
              <rect
                className={styles.cellBg}
                x={x + 6}
                y={y + 6}
                rx={10}
                ry={10}
                width={CELL - 12}
                height={CELL - 12}
              />
              {!disabled && (
                <rect
                  className={styles.cellHit}
                  ref={el => {
                    hitRefs.current[i] = el;
                  }}
                  x={x}
                  y={y}
                  width={CELL}
                  height={CELL}
                  role="gridcell"
                  aria-label={`cell ${i + 1}, empty, place ${current}`}
                  tabIndex={tabbableCell === i ? 0 : -1}
                  onFocus={() => setFocusedCell(i)}
                  onClick={() => onCellClick(i)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onCellClick(i);
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      moveFocus(i, 'up');
                    } else if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      moveFocus(i, 'down');
                    } else if (e.key === 'ArrowLeft') {
                      e.preventDefault();
                      moveFocus(i, 'left');
                    } else if (e.key === 'ArrowRight') {
                      e.preventDefault();
                      moveFocus(i, 'right');
                    }
                  }}
                />
              )}
            </g>
          );
        })}

        {GRID_LINES.map(([x1, y1, x2, y2], i) => (
          <line
            key={i}
            ref={el => {
              gridRefs.current[i] = el;
            }}
            className={styles.boardGridLine}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
          />
        ))}

        {/* each mark lives in its own nested <svg> — overflow:hidden on that
            viewport clips the ghost-particle trail at the cell edge. */}
        {board.map((cell, i) => {
          if (!cell) return null;
          const x = (i % 3) * CELL;
          const y = Math.floor(i / 3) * CELL;
          const inner = CELL - 12;
          const center = inner / 2;
          return (
            <svg
              key={`mark-${i}-${cell}`}
              x={x + 6}
              y={y + 6}
              width={inner}
              height={inner}
              viewBox={`0 0 ${inner} ${inner}`}
              style={{ overflow: 'hidden' }}
            >
              <g
                ref={el => {
                  markRefs.current[i] = el;
                }}
                className={styles.markCell}
              >
                <Mark
                  mark={cell}
                  cx={center}
                  cy={center}
                  size={52}
                  winning={winningSet?.has(i) ?? false}
                />
              </g>
            </svg>
          );
        })}
      </svg>
    </div>
  );
}
