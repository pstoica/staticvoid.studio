import { useMemo } from 'react';
import styles from './Background.module.css';

interface Shape {
  type: 'X' | 'O';
  left: number;
  top: number;
  size: number;
  opacity: number;
  hue: number;
  huePeriod: number;
  floatAmp: number;
  floatPeriod: number;
  floatDelay: number;
  rotXAmp: number;
  rotXPeriod: number;
  rotXDelay: number;
  rotYAmp: number;
  rotYPeriod: number;
  rotYDelay: number;
  rotZAmp: number;
  rotZPeriod: number;
  rotZDelay: number;
}

const COLS = 3;
const ROWS = 5;
const TOTAL = COLS * ROWS;
const MARGIN_PCT = 6;

const rand = (min: number, max: number): number => min + Math.random() * (max - min);

/* jittered-grid placement so shapes stay spaced out. sizes are split between
   a small band and a large band so the mix reads as varied; smaller shapes
   get a slightly higher opacity so they don't disappear. per-axis amplitudes
   and periods are re-rolled per shape, and each axis gets a negative delay
   equal to a random slice of its own period — that starts every shape mid-
   cycle, so they're all on different phases right from mount. */
function buildShapes(): Shape[] {
  const cellW = 100 / COLS;
  const cellH = 100 / ROWS;
  return Array.from({ length: TOTAL }, (_, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const left = col * cellW + rand(MARGIN_PCT, cellW - MARGIN_PCT);
    const top = row * cellH + rand(MARGIN_PCT, cellH - MARGIN_PCT);
    const small = Math.random() < 0.45;
    const size = small ? rand(26, 72) : rand(90, 168);
    const floatPeriod = rand(5500, 10500);
    const rotXPeriod = rand(7000, 15000);
    const rotYPeriod = rand(8500, 17000);
    const rotZPeriod = rand(9000, 18000);
    return {
      type: Math.random() < 0.5 ? 'X' : 'O',
      left,
      top,
      size,
      opacity: 0.2 + (small ? rand(0.1, 0.16) : rand(0.08, 0.13)),
      hue: Math.floor(rand(0, 360)),
      huePeriod: rand(500, 4000),
      floatAmp: rand(8, 20),
      floatPeriod,
      floatDelay: rand(0, floatPeriod),
      rotXAmp: rand(22, 300),
      rotXPeriod,
      rotXDelay: rand(0, rotXPeriod),
      rotYAmp: rand(22, 300),
      rotYPeriod,
      rotYDelay: rand(0, rotYPeriod),
      rotZAmp: rand(12, 300),
      rotZPeriod,
      rotZDelay: rand(0, rotZPeriod),
    };
  });
}

interface BackgroundProps {
  /** quiets the floating shapes while the user is focused on the board */
  dim?: boolean;
}

export function Background({ dim = false }: BackgroundProps) {
  // lock positions at mount so re-renders don't re-roll the layout
  const shapes = useMemo(() => buildShapes(), []);

  return (
    <div className={`${styles.bg}${dim ? ` ${styles.bgDim}` : ''}`} aria-hidden="true">
      {shapes.map((s, i) => (
        <div
          key={i}
          className={styles.shapeSlot}
          style={
            {
              left: `${s.left}%`,
              top: `${s.top}%`,
              width: `${s.size}px`,
              height: `${s.size}px`,
              opacity: s.opacity,
              '--hue-from': s.hue,
              '--hue-period': `${s.huePeriod}ms`,
              '--float-amp': `${s.floatAmp}px`,
              '--float-period': `${s.floatPeriod}ms`,
              '--float-delay': `-${s.floatDelay}ms`,
              '--rx-amp': `${s.rotXAmp}deg`,
              '--rx-period': `${s.rotXPeriod}ms`,
              '--rx-delay': `-${s.rotXDelay}ms`,
              '--ry-amp': `${s.rotYAmp}deg`,
              '--ry-period': `${s.rotYPeriod}ms`,
              '--ry-delay': `-${s.rotYDelay}ms`,
              '--rz-amp': `${s.rotZAmp}deg`,
              '--rz-period': `${s.rotZPeriod}ms`,
              '--rz-delay': `-${s.rotZDelay}ms`,
            } as React.CSSProperties
          }
        >
          <div className={`${styles.shapeLayer} ${styles.shapeFloat}`}>
            <div className={`${styles.shapeLayer} ${styles.shapeRotX}`}>
              <div className={`${styles.shapeLayer} ${styles.shapeRotY}`}>
                <div className={`${styles.shapeLayer} ${styles.shapeRotZ}`}>
                  <svg viewBox="-50 -50 100 100">
                    {s.type === 'X' ? (
                      <path
                        d="M -30 -30 L 30 30 M 30 -30 L -30 30"
                        stroke="currentColor"
                        strokeWidth="10"
                        strokeLinecap="round"
                        fill="none"
                      />
                    ) : (
                      <circle
                        cx="0"
                        cy="0"
                        r="28"
                        stroke="currentColor"
                        strokeWidth="10"
                        fill="none"
                      />
                    )}
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
