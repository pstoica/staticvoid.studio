import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { GameSoundsProvider } from './audio';
import './global.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <GameSoundsProvider>
      <App />
    </GameSoundsProvider>
  </StrictMode>,
);
