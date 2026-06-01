import { createContext, use, useMemo, type ReactNode } from 'react';
import { SoundProvider, usePatch } from '@web-kits/audio/react';
import type { SoundPatch } from '@web-kits/audio';
import crispPatch from '../.web-kits/crisp.json';

/* Thin wrapper over @web-kits/audio so the rest of the app doesn't have to
   know which patch / sound name backs each event. The patch is loaded once
   at the provider and exposed as named triggers. */

export interface GameSounds {
  /** generic UI button / card press */
  button: () => void;
  /** human player's mark landing on the board */
  placeHuman: () => void;
  /** CPU's mark landing on the board — deliberately softer than placeHuman */
  placeCpu: () => void;
  win: () => void;
  lose: () => void;
  draw: () => void;
}

const NOOP: GameSounds = {
  button: () => {},
  placeHuman: () => {},
  placeCpu: () => {},
  win: () => {},
  lose: () => {},
  draw: () => {},
};

const GameSoundsContext = createContext<GameSounds>(NOOP);

function SoundsInner({ children }: { children: ReactNode }) {
  // cast: the JSON shape matches SoundPatch but TS sees it as a plain object
  const patch = usePatch(crispPatch as unknown as SoundPatch);

  const value = useMemo<GameSounds>(
    () => ({
      // 'click' is a clean UI tap — used for picker cards + EndScreen buttons
      button: () => {
        if (patch.ready) patch.play('click');
      },
      // 'pop' has more body + attack — the player's piece feels committed
      placeHuman: () => {
        if (patch.ready) patch.play('pop');
      },
      // 'tap' is very short + subdued — cpu feels more matter-of-fact
      placeCpu: () => {
        if (patch.ready) patch.play('tap');
      },
      win: () => {
        if (patch.ready) patch.play('success');
      },
      lose: () => {
        if (patch.ready) patch.play('error');
      },
      draw: () => {
        if (patch.ready) patch.play('delete');
      },
    }),
    [patch],
  );

  return <GameSoundsContext value={value}>{children}</GameSoundsContext>;
}

export function GameSoundsProvider({ children }: { children: ReactNode }) {
  return (
    <SoundProvider volume={0.55}>
      <SoundsInner>{children}</SoundsInner>
    </SoundProvider>
  );
}

// co-located with the provider because it reads the same context; splitting
// just to placate react-refresh adds more noise than the HMR cost saves.
// eslint-disable-next-line react-refresh/only-export-components
export function useGameSounds(): GameSounds {
  return use(GameSoundsContext);
}
