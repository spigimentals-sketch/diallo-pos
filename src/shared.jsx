// shared.jsx — infrastructure that makes the buttons work:
//  • DataProvider: loads everything from the backend and keeps it in state.
//    If the backend is unreachable it falls back to the seed data passed in,
//    so the UI still runs as a demo.
//  • Toasts, a generic Modal, simple form fields.
//  • CSV export helper.
//  • Entity forms (Product, Supplier, User, Purchase Order).
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { X, CheckCircle2, AlertTriangle, Info, ShieldCheck, Delete, UserCircle2 } from 'lucide-react';
import api, { imageUrl, setToken, getToken, getPendingMutations, queuePendingMutation, flushPendingMutations } from './api.js';

/* ---------------- CSV export ---------------- */
export function downloadCsv(filename, rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map(r => r.map(esc).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

const CODE39_PATTERNS = {
  '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn',
  '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw',
  '8': 'wnnwnnwnn', '9': 'nnwwnnwnn', 'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw',
  'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn', 'F': 'nnwnwwnnn',
  'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn',
  'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww',
  'O': 'wnnnwnnwn', 'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn',
  'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn', 'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw',
  'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn', 'Z': 'nwwnwnnnn',
  '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '$': 'nwnwnwnnn',
  '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn',
};

// Renders a price-tag label: optional item name on top, the scannable CODE39
// barcode (always encoding just the SKU, so hardware scanners still match it
// against p.sku), the SKU as human-readable text, and an optional price at
// the bottom. Only the bars encode data — name/price are printed, not encoded.
export function createBarcodeDataUrl(text, { name, price } = {}) {
  const normalized = text.trim().toUpperCase();
  if (!normalized) throw new Error('SKU is required to generate a barcode');
  const codes = [`*`, ...normalized.split(''), `*`];
  const patternStrings = codes.map(c => CODE39_PATTERNS[c]);
  if (patternStrings.some(p => !p)) {
    throw new Error('SKU contains unsupported characters for barcode printing');
  }

  const moduleWidth = 2;
  const barHeight = 100;
  const quietZone = moduleWidth * 10;
  const charGap = moduleWidth;
  const totalModules = patternStrings.reduce((sum, pattern) => {
    return sum + pattern.split('').reduce((acc, digit) => acc + (digit === 'w' ? 3 : 1), 0);
  }, 0) + (patternStrings.length - 1) * charGap;

  const barsWidth = totalModules * moduleWidth + quietZone * 2;
  const nameText = (name || '').trim();
  const priceText = price != null && price !== '' ? `${new Intl.NumberFormat('fr-FR').format(Math.round(Number(price)))} FCFA` : '';

  const nameFont = 'bold 20px Arial, sans-serif';
  const priceFont = 'bold 22px Arial, sans-serif';
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = nameFont;
  const nameWidth = nameText ? measure.measureText(nameText).width : 0;
  measure.font = priceFont;
  const priceWidth = priceText ? measure.measureText(priceText).width : 0;

  const width = Math.ceil(Math.max(barsWidth, nameWidth + 24, priceWidth + 24));
  const nameBlockHeight = nameText ? 34 : 0;
  const priceBlockHeight = priceText ? 36 : 0;
  const skuBlockHeight = 32;
  const topPad = 16;
  const height = topPad + nameBlockHeight + barHeight + skuBlockHeight + priceBlockHeight + 12;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'black';
  ctx.textAlign = 'center';

  let y = topPad;
  if (nameText) {
    ctx.font = nameFont;
    y += 20;
    ctx.fillText(nameText, width / 2, y);
    y += nameBlockHeight - 20;
  }

  const barsTop = y;
  let x = (width - barsWidth) / 2 + quietZone;
  patternStrings.forEach((pattern, index) => {
    for (let i = 0; i < pattern.length; i += 1) {
      const w = pattern[i] === 'w' ? moduleWidth * 3 : moduleWidth;
      if (i % 2 === 0) ctx.fillRect(x, barsTop, w, barHeight);
      x += w;
    }
    if (index < patternStrings.length - 1) {
      x += charGap;
    }
  });
  y += barHeight;

  ctx.font = '16px Arial, sans-serif';
  y += 22;
  ctx.fillText(normalized, width / 2, y);
  y += skuBlockHeight - 22;

  if (priceText) {
    ctx.font = priceFont;
    y += 24;
    ctx.fillText(priceText, width / 2, y);
  }

  return canvas.toDataURL('image/png');
}

/* ---------------- Toasts ---------------- */
const ToastCtx = createContext({ toast: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const toast = useCallback((message, type = 'success') => {
    const id = Date.now() + Math.random();
    setItems(prev => [...prev, { id, message, type }]);
    setTimeout(() => setItems(prev => prev.filter(t => t.id !== id)), 3200);
  }, []);
  const icons = { success: CheckCircle2, error: AlertTriangle, info: Info };
  const colors = {
    success: 'bg-emerald-900 text-white',
    error: 'bg-rose-600 text-white',
    info: 'bg-stone-900 text-white',
  };
  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-5 right-5 z-[100] space-y-2">
        {items.map(t => {
          const Icon = icons[t.type] || Info;
          return (
            <div key={t.id} className={`flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg text-sm font-medium ${colors[t.type]}`}>
              <Icon size={16} /> {t.message}
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------- Modal ---------------- */
export function Modal({ open, onClose, title, children, footer }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center z-[90] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-lg w-full flex flex-col" style={{ maxHeight: '90vh' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-200">
          <h3 className="font-semibold text-stone-900" style={{ fontFamily: "'Fraunces', serif" }}>{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-stone-100"><X size={16} className="text-stone-500" /></button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
        {footer && <div className="px-5 py-4 border-t border-stone-200 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export const Field = ({ label, children }) => (
  <label className="block mb-3">
    <span className="block text-xs font-medium text-stone-600 mb-1">{label}</span>
    {children}
  </label>
);
export const Input = (props) => (
  <input {...props} className="w-full px-3 py-2 bg-white border border-stone-200 rounded-lg text-sm focus:outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
);
export const SelectInput = ({ options, ...props }) => (
  <select {...props} className="w-full px-3 py-2 bg-white border border-stone-200 rounded-lg text-sm focus:outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100">
    {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
  </select>
);
export const PrimaryBtn = (p) => <button {...p} className="px-4 py-2 bg-emerald-900 text-white rounded-lg text-sm font-medium hover:bg-emerald-800 disabled:opacity-50" />;
export const GhostBtn = (p) => <button {...p} className="px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 rounded-lg" />;

/* ---------------- Data layer ---------------- */
const DataCtx = createContext(null);
export const useData = () => useContext(DataCtx);

export function DataProvider({ fallback, children }) {
  const [state, setState] = useState({
    products: fallback.products || [],
    customers: fallback.customers || [],
    suppliers: fallback.suppliers || [],
    purchaseOrders: fallback.purchaseOrders || [],
    stockMovements: fallback.stockMovements || [],
    users: fallback.users || [],
    employees: fallback.employees || [],
    shifts: fallback.shifts || [],
    settings: fallback.settings || {},
  });
  const [online, setOnline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingSyncCount, setPendingSyncCount] = useState(() => getPendingMutations().length);

  const refresh = useCallback(async () => {
    try {
      const [products, customers, suppliers, purchaseOrders, stockMovements, users, employees, shifts, settings] =
        await Promise.all([
          api.getProducts(), api.getCustomers(), api.getSuppliers(), api.getPurchaseOrders(),
          api.getStockMovements(), api.getUsers(), api.getEmployees(), api.getShifts(), api.getSettings(),
        ]);
      setState({ products, customers, suppliers, purchaseOrders, stockMovements, users, employees, shifts, settings });
      setOnline(true);
    } catch (e) {
      // Backend not running — keep using the fallback seed (demo mode).
      setOnline(false);
      console.warn('Backend unreachable, running in offline demo mode:', e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // A checkout/clock-in/clock-out/expense that couldn't reach the backend
  // queues itself instead of being lost. Try to flush that queue: once on
  // mount, periodically as a safety net (the `online` flag above is only as
  // fresh as the last refresh, not a live connection monitor), and
  // immediately when the OS reports the network came back.
  useEffect(() => {
    const tryFlush = async () => {
      if (getPendingMutations().length === 0) return;
      const { synced } = await flushPendingMutations();
      setPendingSyncCount(getPendingMutations().length);
      if (synced > 0) refresh();
    };
    tryFlush();
    const id = setInterval(tryFlush, 20000);
    window.addEventListener('online', tryFlush);
    return () => { clearInterval(id); window.removeEventListener('online', tryFlush); };
  }, [refresh]);

  // Used when checkout/clock-in/clock-out/an expense can't reach the
  // backend right now — queues it instead of losing it.
  const queueMutation = (type, payload) => {
    queuePendingMutation(type, payload);
    setPendingSyncCount(getPendingMutations().length);
  };

  // Generic local-state patch helpers so the UI updates instantly,
  // whether or not the backend call succeeds.
  const patch = (key, fn) => setState(prev => ({ ...prev, [key]: fn(prev[key]) }));

  const value = {
    ...state, online, loading, refresh, patch, setState, pendingSyncCount, queueMutation,
    upsertProduct: (p) => patch('products', list => {
      const i = list.findIndex(x => x.id === p.id);
      return i >= 0 ? list.map(x => x.id === p.id ? p : x) : [...list, p];
    }),
    upsertCustomer: (c) => patch('customers', list => {
      const i = list.findIndex(x => x.id === c.id);
      return i >= 0 ? list.map(x => x.id === c.id ? c : x) : [...list, c];
    }),
    upsertSupplier: (s) => patch('suppliers', list => {
      const i = list.findIndex(x => x.id === s.id);
      return i >= 0 ? list.map(x => x.id === s.id ? s : x) : [...list, s];
    }),
    upsertPO: (po) => patch('purchaseOrders', list => {
      const i = list.findIndex(x => x.id === po.id);
      return i >= 0 ? list.map(x => x.id === po.id ? po : x) : [po, ...list];
    }),
    upsertUser: (u) => patch('users', list => {
      const i = list.findIndex(x => x.id === u.id);
      return i >= 0 ? list.map(x => x.id === u.id ? u : x) : [...list, u];
    }),
  };
  return <DataCtx.Provider value={value}>{children}</DataCtx.Provider>;
}

/* ---------------- Entity forms ---------------- */
const CATS = ['cosmetics', 'wines', 'whiskey', 'school_materials', 'perfumes', 'icecream', 'shawarma'];

export function ProductForm({ open, onClose, initial }) {
  const { upsertProduct, patch } = useData();
  const { toast } = useToast();
  const blank = { name: '', name_fr: '', category: 'cosmetics', price: 0, cost: 0, discount: 0, stock: 0, sku: '', emoji: '📦', image: null };
  const [form, setForm] = useState(initial || blank);
  const [uploading, setUploading] = useState(false);
  const [autoGenerateSku, setAutoGenerateSku] = useState(false);
  useEffect(() => { setForm(initial || blank); setAutoGenerateSku(false); }, [initial, open]);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const makeSku = (category = 'SKU') => {
    const prefix = category.toString().replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 3) || 'SKU';
    return `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
  };
  const handleGenerateSku = () => setForm(f => ({ ...f, sku: makeSku(f.category) }));
  const handleToggleAutoSku = (checked) => {
    setAutoGenerateSku(checked);
    if (checked && !form.sku) setForm(f => ({ ...f, sku: makeSku(f.category) }));
  };

  const printBarcode = () => {
    if (!form.sku) {
      toast('Please generate or enter a SKU before printing a barcode.', 'error');
      return;
    }
    try {
      const dataUrl = createBarcodeDataUrl(form.sku, { name: form.name, price: form.price });
      const popup = window.open('', '_blank');
      if (!popup) {
        toast('Unable to open print window. Please allow popups and try again.', 'error');
        return;
      }
      popup.document.write(`<!doctype html><html><head><title>Print barcode</title><style>body{margin:0;padding:24px;font-family:Arial,sans-serif;color:#111;background:#fff} .label{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh} .label img{max-width:100%;height:auto;}</style></head><body><div class="label"><img src="${dataUrl}" alt="Barcode" /></div><script>window.onload = () => { window.print(); };</script></body></html>`);
      popup.document.close();
    } catch (error) {
      toast(error.message || 'Failed to generate barcode.', 'error');
    }
  };

  // When a photo is chosen: read it as a base64 data URL and upload it.
  // Inventory edits require connectivity (see note on `save` below), so this
  // fails honestly offline rather than pretending the photo attached.
  const onPickImage = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Please choose an image file', 'error'); return; }
    setUploading(true);
    try {
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => rej(new Error('Could not read file'));
        fr.readAsDataURL(file);
      });
      const { path } = await api.uploadImage(file.name, dataUrl);
      setForm(f => ({ ...f, image: path }));
      toast('Photo attached');
    } catch (err) {
      toast(!err.status ? "Can't upload while offline — try again once connected" : err.message, 'error');
    } finally {
      setUploading(false);
    }
  };

  // Inventory edits intentionally require connectivity rather than queueing:
  // an offline edit replayed later could silently overwrite newer changes
  // someone else made in the meantime, which is worse than asking for a retry.
  const save = async () => {
    const payload = { ...form, price: Number(form.price), cost: Number(form.cost || 0), discount: Number(form.discount || 0), stock: Number(form.stock) };
    if (!payload.sku) payload.sku = makeSku(payload.category);
    try {
      const saved = initial?.id
        ? await api.updateProduct(initial.id, payload)
        : await api.createProduct(payload);
      upsertProduct(saved);
      toast(initial?.id ? 'Product updated' : 'Product added');
      onClose();
    } catch (e) {
      toast(!e.status ? "Can't save while offline — try again once connected" : e.message, 'error');
    }
  };

  const remove = async () => {
    if (!initial?.id) return;
    if (!window.confirm(`Delete "${initial.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteProduct(initial.id);
      patch('products', list => list.filter(p => p.id !== initial.id));
      toast('Product deleted');
      onClose();
    } catch (e) {
      toast(!e.status ? "Can't delete while offline — try again once connected" : e.message, 'error');
    }
  };

  const preview = form.image ? imageUrl(form.image) : null;

  return (
    <Modal open={open} onClose={onClose} title={initial?.id ? 'Edit product' : 'Add product'}
      footer={<>
        {initial?.id && (
          <button onClick={remove} className="px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 rounded-lg mr-auto">Delete</button>
        )}
        <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        <PrimaryBtn onClick={save} disabled={uploading}>{uploading ? 'Uploading…' : 'Save'}</PrimaryBtn>
      </>}>

      {/* Photo picker */}
      <Field label="Photo">
        <div className="flex items-center gap-3">
          <div className="w-20 h-20 rounded-xl bg-stone-100 border border-stone-200 flex items-center justify-center overflow-hidden flex-shrink-0">
            {preview
              ? <img src={preview} alt="" className="w-full h-full object-cover" />
              : <span className="text-3xl">{form.emoji || '📦'}</span>}
          </div>
          <div className="flex flex-col gap-2">
            <label className="px-3 py-2 bg-white border border-stone-200 rounded-lg text-sm font-medium cursor-pointer hover:bg-stone-50 inline-block">
              {preview ? 'Change photo' : 'Upload photo'}
              <input type="file" accept="image/*" className="hidden" onChange={onPickImage} />
            </label>
            {preview && (
              <button type="button" onClick={() => setForm(f => ({ ...f, image: null }))}
                className="text-xs text-stone-500 hover:text-rose-600 text-left">Remove photo</button>
            )}
          </div>
        </div>
      </Field>

      <Field label="Name (EN)"><Input value={form.name} onChange={set('name')} /></Field>
      <Field label="Name (FR)"><Input value={form.name_fr} onChange={set('name_fr')} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Category"><SelectInput value={form.category} onChange={set('category')} options={CATS.map(c => ({ value: c, label: c }))} /></Field>
        <Field label="Emoji (fallback)"><Input value={form.emoji} onChange={set('emoji')} /></Field>
        <Field label="Selling price (FCFA)"><Input type="number" value={form.price} onChange={set('price')} /></Field>
        <Field label="Cost price (FCFA)"><Input type="number" value={form.cost} onChange={set('cost')} /></Field>
        <Field label="Discount (%)"><Input type="number" value={form.discount} onChange={set('discount')} /></Field>
        <Field label="Stock"><Input type="number" value={form.stock} onChange={set('stock')} /></Field>
      </div>
      {Number(form.discount) > 0 && Number(form.price) > 0 && (
        <div className="-mt-1 mb-1 text-xs text-stone-500">
          Sells at <span className="font-medium text-emerald-700">{Math.round(Number(form.price) * (1 - Number(form.discount) / 100)).toLocaleString()} FCFA</span> after {Number(form.discount)}% discount
        </div>
      )}
      {Number(form.price) > 0 && Number(form.cost) > 0 && (
        <div className="-mt-1 mb-1 text-xs text-stone-500">
          Margin: <span className="font-medium text-emerald-700">{(Number(form.price) - Number(form.cost)).toLocaleString()} FCFA</span>
          {' '}per unit ({Math.round(((Number(form.price) - Number(form.cost)) / Number(form.price)) * 100)}%)
        </div>
      )}
      <Field label="SKU">
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2 items-center">
            <Input value={form.sku} onChange={set('sku')} placeholder="e.g. COS-1234" disabled={autoGenerateSku} />
            <button type="button" onClick={handleGenerateSku}
              className="px-3 py-2 rounded-lg border border-stone-200 text-sm bg-stone-50 hover:bg-stone-100">Generate</button>
            <button type="button" onClick={printBarcode}
              className="px-3 py-2 rounded-lg border border-emerald-300 text-sm bg-emerald-50 text-emerald-900 hover:bg-emerald-100">Print barcode</button>
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-stone-500">
            <input type="checkbox" checked={autoGenerateSku} onChange={(e) => handleToggleAutoSku(e.target.checked)}
              className="h-4 w-4 rounded border-stone-300 text-emerald-600 focus:ring-emerald-500" />
            Generate SKU automatically
          </label>
        </div>
      </Field>
    </Modal>
  );
}

export function SupplierForm({ open, onClose, initial }) {
  const { upsertSupplier } = useData();
  const { toast } = useToast();
  const blank = { name: '', contact: '', phone: '', email: '', category: '', status: 'active', productsCount: 0 };
  const [form, setForm] = useState(initial || blank);
  useEffect(() => { setForm(initial || blank); }, [initial, open]);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
  // Requires connectivity — see note on ProductForm.save for why supplier
  // edits aren't queued offline.
  const save = async () => {
    try {
      const saved = initial?.id ? await api.updateSupplier(initial.id, form) : await api.createSupplier(form);
      upsertSupplier(saved);
      toast(initial?.id ? 'Supplier updated' : 'Supplier added');
      onClose();
    } catch (e) {
      toast(!e.status ? "Can't save while offline — try again once connected" : e.message, 'error');
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={initial?.id ? 'Edit supplier' : 'Add supplier'}
      footer={<><GhostBtn onClick={onClose}>Cancel</GhostBtn><PrimaryBtn onClick={save}>Save</PrimaryBtn></>}>
      <Field label="Company name"><Input value={form.name} onChange={set('name')} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Contact person"><Input value={form.contact} onChange={set('contact')} /></Field>
        <Field label="Category"><Input value={form.category} onChange={set('category')} /></Field>
        <Field label="Phone"><Input value={form.phone} onChange={set('phone')} /></Field>
        <Field label="Email"><Input value={form.email} onChange={set('email')} /></Field>
      </div>
      <Field label="Status"><SelectInput value={form.status} onChange={set('status')} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} /></Field>
    </Modal>
  );
}

export function UserForm({ open, onClose, initial }) {
  const { upsertUser } = useData();
  const { toast } = useToast();
  const blank = { name: '', username: '', role: 'cashier', email: '', store: 'Central', pin: '1234' };
  const [form, setForm] = useState(initial || blank);
  useEffect(() => { setForm(initial ? { ...initial, pin: '' } : blank); }, [initial, open]);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
  // Requires connectivity — user management is security-sensitive and not
  // something to queue blindly offline (see note on ProductForm.save).
  const save = async () => {
    if (!initial?.id && !/^\d{4,6}$/.test(String(form.pin || ''))) {
      toast('PIN must be 4–6 digits', 'error'); return;
    }
    try {
      const saved = initial?.id ? await api.updateUser(initial.id, form) : await api.createUser(form);
      upsertUser(saved);
      toast(initial?.id ? 'User updated' : 'User added');
      onClose();
    } catch (e) {
      toast(!e.status ? "Can't save while offline — try again once connected" : e.message, 'error');
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={initial?.id ? 'Edit user' : 'Add user'}
      footer={<><GhostBtn onClick={onClose}>Cancel</GhostBtn><PrimaryBtn onClick={save}>Save</PrimaryBtn></>}>
      <Field label="Full name"><Input value={form.name} onChange={set('name')} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Username (for login)"><Input value={form.username || ''} onChange={set('username')} placeholder="e.g. paul" /></Field>
        <Field label="Email"><Input value={form.email} onChange={set('email')} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Role"><SelectInput value={form.role} onChange={set('role')} options={[{ value: 'admin', label: 'Admin' }, { value: 'manager', label: 'Manager' }, { value: 'cashier', label: 'Cashier' }, { value: 'accountant', label: 'Accountant' }]} /></Field>
        <Field label="Store"><Input value={form.store} onChange={set('store')} /></Field>
      </div>
      {!initial?.id
        ? <Field label="Login PIN (4–6 digits)"><Input value={form.pin} onChange={set('pin')} inputMode="numeric" placeholder="1234" /></Field>
        : <p className="text-xs text-stone-400 -mt-1">Use “Reset PIN” in the users table to change this user's PIN.</p>}
    </Modal>
  );
}

export function POForm({ open, onClose }) {
  const { suppliers, upsertPO } = useData();
  const { toast } = useToast();
  const blank = { supplierId: suppliers[0]?.id || null, items: 1, total: 0, status: 'draft' };
  const [form, setForm] = useState(blank);
  useEffect(() => { setForm({ ...blank, supplierId: suppliers[0]?.id || null }); }, [open]); // eslint-disable-line
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
  // Requires connectivity — see note on ProductForm.save for why this isn't
  // queued offline.
  const save = async () => {
    const sup = suppliers.find(s => String(s.id) === String(form.supplierId));
    const payload = { supplierId: Number(form.supplierId), supplier: sup?.name || '', items: Number(form.items), total: Number(form.total), status: form.status };
    try {
      const saved = await api.createPurchaseOrder(payload);
      upsertPO(saved);
      toast('Purchase order created');
      onClose();
    } catch (e) {
      toast(!e.status ? "Can't save while offline — try again once connected" : e.message, 'error');
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Create purchase order"
      footer={<><GhostBtn onClick={onClose}>Cancel</GhostBtn><PrimaryBtn onClick={save}>Create</PrimaryBtn></>}>
      <Field label="Supplier">
        <SelectInput value={form.supplierId || ''} onChange={set('supplierId')} options={suppliers.map(s => ({ value: s.id, label: s.name }))} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Items"><Input type="number" value={form.items} onChange={set('items')} /></Field>
        <Field label="Total (FCFA)"><Input type="number" value={form.total} onChange={set('total')} /></Field>
      </div>
    </Modal>
  );
}

/* ---------------- Auth: provider + login screen ---------------- */
const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  // On load, if a token is saved, confirm it's still valid.
  useEffect(() => {
    const token = getToken();
    if (!token) { setChecking(false); return; }
    api.me()
      .then(({ user }) => setUser(user))
      .catch(() => { setToken(null); setUser(null); })
      .finally(() => setChecking(false));
  }, []);

  // While signed in, ping the backend every 45s so the admin's "who's online"
  // list (Settings > Users) knows this account is still active.
  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => { api.heartbeat().catch(() => {}); }, 45000);
    return () => clearInterval(id);
  }, [user]);

  const login = async (username, pin) => {
    const { token, user } = await api.login(username, pin);
    setToken(token);
    setUser(user);
    return user;
  };
  const logout = () => { setToken(null); setUser(null); };

  return (
    <AuthCtx.Provider value={{ user, checking, login, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

// Login screen: username + PIN, with quick-pick suggestions of other users.
export function LoginScreen() {
  const { login } = useAuth();
  const { toast } = useToast();
  const [staff, setStaff] = useState([]);
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.getStaff().then(setStaff).catch(() => setStaff([])); }, []);

  const colors = [
    'from-amber-400 to-rose-500', 'from-emerald-400 to-teal-600',
    'from-sky-400 to-indigo-600', 'from-fuchsia-400 to-purple-600',
    'from-orange-400 to-red-500', 'from-cyan-400 to-blue-600',
  ];
  const initials = (name) => (name || '?').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();

  const submit = async () => {
    if (!username) { toast('Choose or type a username', 'error'); return; }
    if (!/^\d{4,6}$/.test(pin)) { toast('Enter your 4–6 digit PIN', 'error'); return; }
    setBusy(true);
    try { await login(username.trim(), pin); }
    catch (e) { toast(e.message || 'Login failed', 'error'); setPin(''); }
    finally { setBusy(false); }
  };

  const pick = (u) => { setUsername(u.username || ''); setPin(''); };
  const press = (d) => { if (!busy) setPin(p => (p + d).slice(0, 6)); };
  const back = () => setPin(p => p.slice(0, -1));

  // The currently-typed user (to show their name nicely), plus everyone else as suggestions.
  const current = staff.find(s => (s.username || '').toLowerCase() === username.trim().toLowerCase());
  const others = staff.filter(s => s !== current);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-stone-100 via-white to-emerald-50 p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-emerald-900 mx-auto mb-3 flex items-center justify-center">
            <ShieldCheck className="text-white" size={26} />
          </div>
          <h1 className="text-2xl text-stone-900" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600 }}>Diallo Supermarché</h1>
          <p className="text-sm text-stone-500 mt-1">Sign in to continue</p>
        </div>

        <div className="bg-white rounded-2xl border border-stone-200 p-6">
          {/* Username */}
          <label className="block text-xs font-medium text-stone-600 mb-1">Username</label>
          <div className="flex items-center gap-2 mb-3">
            <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-semibold flex-shrink-0 bg-gradient-to-br ${current ? colors[staff.indexOf(current) % colors.length] : 'from-stone-300 to-stone-400'}`}>
              {current ? initials(current.name) : <UserCircle2 size={18} />}
            </div>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              placeholder="Type your username"
              className="flex-1 px-3 py-2 bg-white border border-stone-200 rounded-lg text-sm focus:outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
          </div>

          {/* PIN dots + keypad */}
          <label className="block text-xs font-medium text-stone-600 mb-1">PIN</label>
          <div className="flex justify-center gap-3 my-3 h-4">
            {[0,1,2,3,4,5].map(i => i < Math.max(4, pin.length) && (
              <div key={i} className={`w-3 h-3 rounded-full ${pin.length > i ? 'bg-emerald-700' : 'bg-stone-200'}`} />
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[1,2,3,4,5,6,7,8,9].map(n => (
              <button key={n} onClick={() => press(String(n))} disabled={busy}
                className="h-12 rounded-xl bg-stone-50 hover:bg-stone-100 text-lg font-medium text-stone-800 disabled:opacity-50">{n}</button>
            ))}
            <button onClick={back} disabled={busy} className="h-12 rounded-xl text-stone-500 hover:bg-stone-100 flex items-center justify-center"><Delete size={18} /></button>
            <button onClick={() => press('0')} disabled={busy} className="h-12 rounded-xl bg-stone-50 hover:bg-stone-100 text-lg font-medium text-stone-800 disabled:opacity-50">0</button>
            <button onClick={submit} disabled={busy} className="h-12 rounded-xl bg-emerald-900 text-white hover:bg-emerald-800 text-sm font-medium disabled:opacity-50">{busy ? '…' : 'Sign in'}</button>
          </div>
        </div>

        {/* Suggested users — always shown so it's easy to switch accounts */}
        {others.length > 0 && (
          <div className="mt-5">
            <div className="text-[11px] uppercase tracking-wider text-stone-400 font-medium mb-2 text-center">
              {current ? 'Switch user' : 'Suggested users'}
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {others.map((s, i) => (
                <button key={s.id} onClick={() => pick(s)}
                  className="flex items-center gap-2 bg-white border border-stone-200 rounded-full pl-1 pr-3 py-1 hover:border-emerald-600 hover:shadow-sm transition">
                  <span className={`w-6 h-6 rounded-full bg-gradient-to-br ${colors[staff.indexOf(s) % colors.length]} flex items-center justify-center text-white text-[10px] font-semibold`}>{initials(s.name)}</span>
                  <span className="text-xs font-medium text-stone-700 pr-1">{s.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
