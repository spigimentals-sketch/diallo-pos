// CustomerDisplay.jsx — the second-screen view. Loaded in its own browser
// window (see customerDisplay.js) on the same origin with ?display=customer;
// main.jsx renders this instead of the full POS app for that URL. It shows
// nothing but the live cart, kept in sync via BroadcastChannel, styled to
// match the rest of the app (same Logo, same emerald/stone palette, same
// Fraunces serif used on the receipt) rather than inventing a separate look.
import React, { useEffect, useState } from 'react';
import { ShoppingCart, CheckCircle2 } from 'lucide-react';
import { fmt, Logo } from './DialloPOS.jsx';
import { imageUrl } from './api.js';
import { CHANNEL_NAME } from './customerDisplay.js';

const EMPTY_CART = { items: [], subtotal: 0, tva: 0, total: 0, customerName: null, paid: false };
const serif = { fontFamily: "'Fraunces', serif" };

export default function CustomerDisplay() {
  const [state, setState] = useState(EMPTY_CART);

  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (e) => setState(e.data || EMPTY_CART);
    return () => channel.close();
  }, []);

  const { items, subtotal, tva, total, customerName, paid } = state;

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-stone-50 via-white to-emerald-50/30">
      <div className="flex items-center justify-between px-10 py-6 border-b border-stone-200/80 bg-white/70 backdrop-blur flex-shrink-0">
        <Logo size="lg" subtitle="Supermarché" />
        {customerName && (
          <div className="px-4 py-2 rounded-full bg-emerald-50 text-emerald-800 text-sm font-medium">
            Welcome, {customerName}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-10 py-8">
        {paid ? (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <div className="w-24 h-24 rounded-full bg-emerald-50 flex items-center justify-center mb-6">
              <CheckCircle2 size={48} className="text-emerald-600" />
            </div>
            <div className="text-4xl text-stone-900" style={{ ...serif, fontWeight: 600 }}>Thank you for shopping with us!</div>
            <div className="text-stone-500 text-lg mt-3">Please come again</div>
          </div>
        ) : items.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <div className="w-24 h-24 rounded-full bg-emerald-50 flex items-center justify-center mb-6">
              <ShoppingCart size={40} className="text-emerald-700" />
            </div>
            <div className="text-2xl text-stone-400" style={serif}>Your items will appear here</div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-3">
            {items.map((it, i) => (
              <div key={i} className="flex items-center gap-4 bg-white rounded-2xl border border-stone-200/80 px-6 py-4 shadow-sm">
                <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-stone-50 to-stone-100 flex items-center justify-center text-3xl overflow-hidden flex-shrink-0">
                  {it.image ? <img src={imageUrl(it.image)} alt="" className="w-full h-full object-cover" /> : (it.emoji || '🛒')}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xl font-medium text-stone-900 truncate">{it.name}</div>
                  <div className="text-stone-500 text-sm mt-0.5">{it.qty} × {fmt(it.price)}</div>
                </div>
                <div className="text-2xl text-emerald-900 flex-shrink-0" style={{ ...serif, fontWeight: 600 }}>{fmt(it.price * it.qty)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {items.length > 0 && !paid && (
        <div className="flex-shrink-0 bg-white border-t border-stone-200/80 px-10 py-6">
          <div className="max-w-3xl mx-auto space-y-1.5">
            <div className="flex justify-between text-stone-500 text-base"><span>Subtotal</span><span>{fmt(subtotal)}</span></div>
            <div className="flex justify-between text-stone-500 text-base"><span>TVA</span><span>{fmt(tva)}</span></div>
            <div className="flex justify-between items-baseline border-t border-stone-200 mt-3 pt-3">
              <span className="text-xl text-stone-700 font-medium">Total</span>
              <span className="text-4xl text-emerald-900" style={{ ...serif, fontWeight: 700 }}>{fmt(total)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
