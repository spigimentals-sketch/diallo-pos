import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import DialloPOS from './DialloPOS.jsx';
import CustomerDisplay from './CustomerDisplay.jsx';

// A second browser window opened with ?display=customer (see
// customerDisplay.js) gets the bare customer-facing cart view instead of
// the full POS — same bundle, same origin, just a different root component.
const isCustomerDisplay = new URLSearchParams(window.location.search).get('display') === 'customer';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isCustomerDisplay ? <CustomerDisplay /> : <DialloPOS />}
  </React.StrictMode>
);

// Register the service worker only in production builds — in dev it would
// just fight with Vite's own module reloading.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
