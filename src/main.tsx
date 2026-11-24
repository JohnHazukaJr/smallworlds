import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './fonts.css';
import './global.css';
import App from './App';
import { requestPersistentStorage } from './storage/quota';

// Stories live only in this browser; ask it to keep them.
void requestPersistentStorage();
// Deleted stories must not linger inside old tombstones.
void import('./db').then(({ stripTombstonePayloads }) => stripTombstonePayloads()).catch(() => undefined);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
