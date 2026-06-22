// api.js — a thin wrapper around fetch() for every backend endpoint.
// In dev, BASE is '' and Vite proxies /api -> localhost:4000.
// In prod, set VITE_API_URL to your backend's URL.
const BASE = import.meta.env.VITE_API_URL || '';

// Turn a stored image path like "/uploads/x.jpg" into a full URL the browser can load.
// In dev, Vite proxies /uploads to the backend, so the bare path works too.
export function imageUrl(p) {
  if (!p) return null;
  if (p.startsWith('http') || p.startsWith('data:')) return p;
  return `${BASE}${p}`;
}

// --- Auth token: kept in memory + localStorage so login survives reloads ---
let authToken = (typeof localStorage !== 'undefined' && localStorage.getItem('diallo_token')) || null;
export function setToken(t) {
  authToken = t;
  try { t ? localStorage.setItem('diallo_token', t) : localStorage.removeItem('diallo_token'); } catch {}
}
export function getToken() { return authToken; }

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  // auth
  getStaff: () => req('GET', '/auth/staff'),
  login: (username, pin) => req('POST', '/auth/login', { username, pin }),
  me: () => req('GET', '/auth/me'),
  heartbeat: () => req('POST', '/auth/heartbeat'),
  setUserPin: (id, pin) => req('PUT', `/users/${id}/pin`, { pin }),
  // products
  getProducts: () => req('GET', '/products'),
  createProduct: (p) => req('POST', '/products', p),
  updateProduct: (id, p) => req('PUT', `/products/${id}`, p),
  deleteProduct: (id) => req('DELETE', `/products/${id}`),
  uploadImage: (filename, dataUrl) => req('POST', '/upload', { filename, dataUrl }),
  // customers
  getCustomers: () => req('GET', '/customers'),
  createCustomer: (c) => req('POST', '/customers', c),
  updateCustomer: (id, c) => req('PUT', `/customers/${id}`, c),
  // suppliers
  getSuppliers: () => req('GET', '/suppliers'),
  createSupplier: (s) => req('POST', '/suppliers', s),
  updateSupplier: (id, s) => req('PUT', `/suppliers/${id}`, s),
  // purchase orders
  getPurchaseOrders: () => req('GET', '/purchase-orders'),
  createPurchaseOrder: (po) => req('POST', '/purchase-orders', po),
  updatePurchaseOrder: (id, patch) => req('PATCH', `/purchase-orders/${id}`, patch),
  recordPOPayment: (id, payment) => req('POST', `/purchase-orders/${id}/payments`, payment),
  getPOPayments: (id) => req('GET', `/purchase-orders/${id}/payments`),
  // stock movements
  getStockMovements: () => req('GET', '/stock-movements'),
  // users
  getUsers: () => req('GET', '/users'),
  createUser: (u) => req('POST', '/users', u),
  updateUser: (id, u) => req('PUT', `/users/${id}`, u),
  deleteUser: (id) => req('DELETE', `/users/${id}`),
  // employees & shifts
  getEmployees: () => req('GET', '/employees'),
  getShifts: () => req('GET', '/shifts'),
  // photoPath is the /uploads/... path from a prior uploadImage() call — a
  // clock-in photo, taken right at the moment of clocking in (see the
  // camera modal in the Shifts view), standing in for "this is really
  // that person" now that fingerprint verification proved impractical.
  clockIn: (photoPath) => req('POST', '/shifts/clock-in', { photo: photoPath }),
  clockOut: (countedCash) => req('POST', '/shifts/clock-out', { countedCash }),
  // orders / checkout
  createOrder: (o) => req('POST', '/orders', o),
  getOrders: () => req('GET', '/orders'),
  // settings
  getSettings: () => req('GET', '/settings'),
  saveSettings: (s) => req('PUT', '/settings', s),
  // reports
  salesReport: (days = 30) => req('GET', `/reports/sales?days=${days}`),
  profitabilityReport: (limit = 5) => req('GET', `/reports/profitability?limit=${limit}`),
  inventoryReport: () => req('GET', '/reports/inventory'),
  rangeReport: (from, to) => req('GET', `/reports/range?from=${from}&to=${to}`),
  zReport: (date) => req('GET', `/reports/z?date=${date}`),
  pnlReport: (from, to) => req('GET', `/reports/pnl?from=${from}&to=${to}`),
  pnlTrend: (months = 6) => req('GET', `/reports/pnl-trend?months=${months}`),
  // expenses
  getExpenses: () => req('GET', '/expenses'),
  createExpense: (e) => req('POST', '/expenses', e),
  deleteExpense: (id) => req('DELETE', `/expenses/${id}`),
  // maintenance
  clearData: () => req('POST', '/maintenance/clear-data'),
  clearActivity: () => req('POST', '/maintenance/clear-activity'),
};

export default api;

// --- Offline mutation queue ---
// Floor-critical actions that can't be allowed to silently vanish when the
// backend is unreachable: checkout, clocking in/out, recording an expense.
// Each gets queued here instead of being lost, and retried automatically
// once the connection is back. Every handler is safe to retry — either via
// a clientId/clientOrderId the server dedupes on (order, expense), or
// because the resulting state is naturally idempotent (clock in/out: an
// "already clocked in"/"not clocked in" error on retry means it already
// worked, not that it failed). Everything else in the app (products,
// suppliers, settings, user management, edits/deletes) intentionally just
// fails honestly offline instead — queueing an edit risks overwriting newer
// server-side data with stale local data once it replays, which is a worse
// outcome than asking someone to retry once they're back online.
const PENDING_KEY = 'diallo_pending_mutations';

const MUTATION_HANDLERS = {
  order: { run: (p) => api.createOrder(p) },
  // The clock-in photo is queued as a raw data URL (the upload itself also
  // needs connectivity), so retrying means uploading it now and only then
  // clocking in with the resulting path.
  clockIn: {
    run: async (p) => { const { path } = await api.uploadImage('clockin.jpg', p?.photo); return api.clockIn(path); },
    alreadyDone: (e) => /already clocked in/i.test(e.message || ''),
  },
  clockOut: { run: (p) => api.clockOut(p?.countedCash), alreadyDone: (e) => /not clocked in/i.test(e.message || '') },
  expense: { run: (p) => api.createExpense(p) },
};

export function getPendingMutations() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch { return []; }
}
function savePendingMutations(list) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch {}
}
export function queuePendingMutation(type, payload) {
  const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  savePendingMutations([...getPendingMutations(), { id, type, payload, queuedAt: new Date().toISOString() }]);
  return id;
}
export function removePendingMutation(id) {
  savePendingMutations(getPendingMutations().filter((m) => m.id !== id));
}

// Attempts to sync every queued mutation, in order. Stops on the first
// connectivity failure (no point hammering while still offline) but a
// genuine server rejection (e.g. bad data) doesn't block the rest of the
// queue — it's left in place for a human to investigate rather than
// silently dropped.
export async function flushPendingMutations() {
  let synced = 0, failing = 0;
  for (const m of getPendingMutations()) {
    const handler = MUTATION_HANDLERS[m.type];
    if (!handler) { removePendingMutation(m.id); continue; }
    try {
      await handler.run(m.payload);
      removePendingMutation(m.id);
      synced++;
    } catch (e) {
      if (handler.alreadyDone?.(e)) { removePendingMutation(m.id); synced++; continue; }
      if (!e.status) break; // still offline — retry the whole queue later
      failing++;
    }
  }
  return { synced, failing };
}
