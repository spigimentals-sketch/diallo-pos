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
  clockIn: () => req('POST', '/shifts/clock-in'),
  clockOut: () => req('POST', '/shifts/clock-out'),
  // orders / checkout
  createOrder: (o) => req('POST', '/orders', o),
  getOrders: () => req('GET', '/orders'),
  // settings
  getSettings: () => req('GET', '/settings'),
  saveSettings: (s) => req('PUT', '/settings', s),
  // reports
  salesReport: () => req('GET', '/reports/sales'),
  inventoryReport: () => req('GET', '/reports/inventory'),
  rangeReport: (from, to) => req('GET', `/reports/range?from=${from}&to=${to}`),
  zReport: (date) => req('GET', `/reports/z?date=${date}`),
  // expenses
  getExpenses: () => req('GET', '/expenses'),
  createExpense: (e) => req('POST', '/expenses', e),
  deleteExpense: (id) => req('DELETE', `/expenses/${id}`),
  // maintenance
  clearData: () => req('POST', '/maintenance/clear-data'),
};

export default api;
