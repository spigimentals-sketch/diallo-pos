import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import DialloPOS from './DialloPOS.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DialloPOS />
  </React.StrictMode>
);

// Register the service worker only in production builds — in dev it would
// just fight with Vite's own module reloading.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
