import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Diagnostics } from './app/diagnostics';
import './style.css';

createRoot(document.getElementById('root')!).render(<StrictMode><Diagnostics /></StrictMode>);
