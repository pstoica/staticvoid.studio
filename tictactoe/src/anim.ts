import { animate, stagger, utils } from 'animejs';

export const GHOST_COUNT = 20;

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

// uniform random in [min, max] — keeps the ghost params read as ranges
const rand = (min: number, max: number): number => min + Math.random() * (max - min);
const irand = (min: number, max: number): number => Math.round(rand(min, max));

/* ---------- board entrance ---------- */

export function animateBoardIn(
  turnBadge: HTMLDivElement,
  cellEls: SVGGElement[],
  gridLineEls: SVGLineElement[],
) {
  if (prefersReducedMotion()) {
    turnBadge.style.opacity = '1';
    cellEls.forEach(el => {
      el.style.opacity = '1';
    });
    gridLineEls.forEach(el => {
      el.style.opacity = '1';
    });
    return;
  }

  utils.set(turnBadge, { opacity: 0 });
  utils.set(cellEls, { opacity: 0, scale: 0.55, rotate: -10 });
  utils.set(gridLineEls, { opacity: 0 });

  animate(turnBadge, { opacity: [0, 1], delay: 500 });

  animate(cellEls, {
    opacity: [0, 1],
    scale: [0.55, 1],
    rotate: [-10, 0],
    duration: 720,
    delay: stagger(55, { from: 'center', grid: [3, 3] }),
    ease: 'outBack(1.6)',
  });

  animate(gridLineEls, {
    opacity: [0, 1],
    duration: 540,
    delay: stagger(60, { start: 320 }),
    ease: 'outQuad',
  });
}

/* ---------- mark placement ---------- */

export function animateMarkGrow(groupEl: SVGGElement) {
  if (prefersReducedMotion()) return;
  utils.set(groupEl, { scale: 0, opacity: 0 });
  animate(groupEl, {
    opacity: [{ to: 1, duration: 90, ease: 'outQuad' }],
    scale: [
      { to: 1.14, duration: 180, ease: 'outBack(2.2)' },
      { to: 1, duration: 180, ease: 'outQuad' },
    ],
  });
}

/* Each ghost is a frozen debris snapshot: random position inside the cell +
   scale / rotation / 3D tilt, fully re-rolled per placement so no two marks
   produce the same scatter. Only opacity animates. The nested <svg> in
   Board.tsx has overflow:hidden to catch any spill past the cell edge. */
export function animateMarkGhosts(paths: SVGPathElement[]) {
  if (prefersReducedMotion()) return;
  if (paths.length === 0) return;
  paths.forEach((el, i) => {
    utils.set(el, {
      translateX: rand(-40, 40),
      translateY: rand(-40, 40),
      scaleX: rand(0.1, 0.6),
      scaleY: rand(0.1, 0.6),
      rotate: rand(-180, 180),
      rotateX: rand(-90, 90),
      rotateY: rand(-90, 90),
      opacity: 0,
    });
    animate(el, {
      opacity: [
        { to: rand(0.1, 1), duration: irand(28, 70), ease: 'outQuad' },
        { to: 0, duration: irand(200, 450), ease: 'outQuad' },
      ],
      delay: i * 28,
    });
  });
}

/* ---------- end-of-game ---------- */

export function dimNonWinningMarks(marks: SVGGElement[]) {
  if (prefersReducedMotion()) return;
  animate(marks, {
    opacity: [{ to: 0.28, duration: 480, ease: 'outQuad' }],
    delay: 220,
  });
}

export function highlightWinningMarks(marks: SVGGElement[]) {
  if (prefersReducedMotion()) return;
  animate(marks, {
    scale: [
      { to: 1.18, duration: 280, ease: 'outQuad' },
      { to: 1.0, duration: 480, ease: 'outElastic(1, 0.6)' },
    ],
    delay: stagger(80, { start: 200 }),
  });
}

/* Starts at ~850ms so the wrap fade finishes right as GameSession's 1300ms
   onFinish fires and EndScreen mounts — crossfade instead of a hard swap. */
export function animateBoardOut(wrapEl: HTMLElement) {
  if (prefersReducedMotion()) return;
  animate(wrapEl, {
    opacity: [1, 0.15],
    scale: [1, 0.96],
    duration: 420,
    delay: 850,
    ease: 'inQuad',
  });
}

export function animateTurnBadgeOut(el: HTMLElement) {
  if (prefersReducedMotion()) {
    el.style.opacity = '0';
    return;
  }
  animate(el, {
    opacity: [1, 0],
    duration: 420,
    ease: 'outQuad',
  });
}

/* ---------- end-screen title reactions ---------- */

export function animateWinTitle(chars: HTMLElement[]) {
  if (prefersReducedMotion()) return () => {};
  chars.forEach((c, i) => {
    c.style.setProperty('--char-hue', String(120 + ((i * 22) % 220)));
  });
  const a = animate(chars, {
    translateY: [
      { to: -18, duration: 320, ease: 'outQuad' },
      { to: 0, duration: 520, ease: 'outBounce' },
    ],
    rotate: [
      { to: -4, duration: 320 },
      { to: 0, duration: 520, ease: 'outBack(1.4)' },
    ],
    delay: stagger(70),
    loop: true,
    loopDelay: 1400,
  });
  return () => a.pause();
}

/* Alternating-sign vertical jitter per letter so the word looks unsteady —
   wonky, not just shaking. Rotate/translate amplitudes vary per letter too. */
export function animateLossTitle(chars: HTMLElement[]) {
  if (prefersReducedMotion()) return () => {};
  const animations = chars.map((el, i) => {
    const sign = i % 2 === 0 ? 1 : -1;
    const rotAmp = 5 + (i % 3) * 2;
    const yAmp = 6 + (i % 2) * 2;
    return animate(el, {
      translateY: [
        { to: -yAmp * sign, duration: 85, ease: 'outQuad' },
        { to: yAmp * 0.7 * sign, duration: 95, ease: 'inOutQuad' },
        { to: -yAmp * 0.4 * sign, duration: 85, ease: 'inOutQuad' },
        { to: yAmp * 0.2 * sign, duration: 90, ease: 'inOutQuad' },
        { to: 0, duration: 140, ease: 'outQuad' },
      ],
      rotate: [
        { to: -rotAmp * sign, duration: 85 },
        { to: rotAmp * sign, duration: 110 },
        { to: -rotAmp * 0.5 * sign, duration: 85 },
        { to: 0, duration: 140, ease: 'outBack(1.6)' },
      ],
      translateX: [
        { to: -1.5 * sign, duration: 100 },
        { to: 1.5 * sign, duration: 100 },
        { to: 0, duration: 100 },
      ],
      delay: i * 48,
      loop: true,
      loopDelay: 1100,
    });
  });
  return () => animations.forEach(a => a.pause());
}

export function animateDrawTitle(chars: HTMLElement[]) {
  if (prefersReducedMotion()) return () => {};
  const a = animate(chars, {
    opacity: [
      { to: 0.55, duration: 700, ease: 'inOutSine' },
      { to: 1, duration: 700, ease: 'inOutSine' },
    ],
    delay: stagger(60),
    loop: true,
  });
  return () => a.pause();
}

export function animateEndCardIn(cardEl: HTMLElement) {
  if (prefersReducedMotion()) {
    cardEl.style.opacity = '1';
    return;
  }
  utils.set(cardEl, { opacity: 0, scale: 0.92, translateY: 14 });
  animate(cardEl, {
    opacity: [0, 1],
    scale: [0.92, 1],
    translateY: [14, 0],
    duration: 480,
    ease: 'outBack(1.4)',
  });
}

export function animateEndCardOut(cardEl: HTMLElement) {
  if (prefersReducedMotion()) return;
  return animate(cardEl, {
    opacity: [1, 0],
    scale: [1, 0.95],
    translateY: [0, -8],
    duration: 240,
    ease: 'inQuad',
  });
}

/* ---------- brand wordmark ---------- */

export function animateBrandHues(containerEl: HTMLElement) {
  if (prefersReducedMotion()) return () => {};
  const letters = Array.from(containerEl.children) as HTMLElement[];
  letters.forEach((el, i) => {
    el.style.setProperty('--letter-hue', String((i * 36) % 360));
  });
  const animations = letters.map((el, i) =>
    animate(el, {
      '--letter-hue': [(i * 36) % 360, ((i * 36) % 360) + 360],
      duration: 9000,
      ease: 'linear',
      loop: true,
    }),
  );
  return () => animations.forEach(a => a.pause());
}

/* Self-rescheduling flicker with an attack/release envelope on the tick
   interval: ramps fast for ~140ms (attack), then ease-in quad winds it down
   into a slow pulse over ~1160ms (release), lining up with GameSession's
   1300ms window before the EndScreen reveals. Discontinuous random hues on
   purpose — it should read as processing, not as a tween. */
export function animateBrandCalculating(containerEl: HTMLElement): () => void {
  const letters = Array.from(containerEl.children) as HTMLElement[];

  const ATTACK_MS = 140;
  const RELEASE_MS = 1160;
  const FAST_INTERVAL = 45;
  const SLOW_START = 180;
  const SLOW_END = 300;

  const startedAt = performance.now();
  let timerId: number | null = null;

  const tick = () => {
    letters.forEach(el => {
      el.style.setProperty('--letter-hue', String(Math.floor(Math.random() * 360)));
    });
    const elapsed = performance.now() - startedAt;
    let next: number;
    if (elapsed < ATTACK_MS) {
      const t = elapsed / ATTACK_MS;
      next = SLOW_START + (FAST_INTERVAL - SLOW_START) * t;
    } else {
      const t = Math.min((elapsed - ATTACK_MS) / RELEASE_MS, 1);
      next = FAST_INTERVAL + (SLOW_END - FAST_INTERVAL) * t * t;
    }
    timerId = window.setTimeout(tick, next);
  };

  tick();

  return () => {
    if (timerId !== null) window.clearTimeout(timerId);
  };
}

/* ---------- picker entrance / exit ---------- */

// held back long enough for the #root page fade-in (520ms) to settle before
// the picker's own stagger kicks in, so the two entrances don't overlap.
// only applies to first-load — re-entries from EndScreen use a plain fade.
const PICKER_ENTER_DELAY = 600;

export function animatePickerIn(cardEl: HTMLElement, optionEls: HTMLElement[]) {
  if (prefersReducedMotion()) return;
  utils.set(cardEl, { opacity: 0, translateY: 8 });
  utils.set(optionEls, { opacity: 0, translateX: -6 });
  animate(cardEl, {
    opacity: [0, 1],
    translateY: [8, 0],
    duration: 220,
    delay: PICKER_ENTER_DELAY,
    ease: 'outQuart',
  });
  animate(optionEls, {
    opacity: [0, 1],
    translateX: [-6, 0],
    duration: 180,
    delay: stagger(40, { start: PICKER_ENTER_DELAY + 60 }),
    ease: 'outQuart',
    // anime.js leaves the final frame's transform inline, which outranks
    // .btn:active's translateY in CSS and makes the press look dead. drop
    // the inline transform once the stagger is done so CSS can take over.
    onComplete: () => {
      optionEls.forEach(el => {
        el.style.transform = '';
      });
    },
  });
}

export function animatePickerOut(cardEl: HTMLElement) {
  if (prefersReducedMotion()) return;
  return animate(cardEl, {
    opacity: [1, 0],
    translateY: [0, -8],
    duration: 220,
    ease: 'outQuart',
  });
}

// EndScreen → picker re-entry: no stagger / no delay, just an opacity fade
// so it reads as a smooth handoff after animateEndCardOut runs.
export function animatePickerFadeIn(cardEl: HTMLElement) {
  if (prefersReducedMotion()) return;
  utils.set(cardEl, { opacity: 0 });
  animate(cardEl, {
    opacity: [0, 1],
    duration: 260,
    ease: 'outQuart',
  });
}
