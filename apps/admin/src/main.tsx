/**
 * The admin console's entry (B088): the API base was compiled in from VITE_ADMIN_API_BASE.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

declare const __ADMIN_API_BASE__: string;

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App config={{ apiBase: __ADMIN_API_BASE__ }} />
    </StrictMode>,
  );
}
