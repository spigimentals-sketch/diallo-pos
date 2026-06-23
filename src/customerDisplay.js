// customerDisplay.js — keeps a customer-facing second-screen window in sync
// with the live checkout cart. Both windows are the same origin/app, so a
// BroadcastChannel is enough — no server round trip, no extra backend state.
export const CHANNEL_NAME = 'diallo-customer-display';

// Opens a second browser window pointed at the same app with ?display=customer,
// which main.jsx uses to render just the customer-facing cart view instead of
// the full POS. The cashier drags this window to the second monitor and
// fullscreens it (F11) — browsers don't allow JS to fullscreen a window it
// didn't just create from a direct user gesture in that window's own context.
export function openCustomerDisplay() {
  const url = `${window.location.origin}${window.location.pathname}?display=customer`;
  return window.open(url, 'diallo-customer-display', 'width=1024,height=768');
}
