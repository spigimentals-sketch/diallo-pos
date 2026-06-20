// routes/api.js — every REST endpoint for the POS.
import { Router } from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { db } from '../db.js';
import { hashPin, verifyPin, issueToken, requireAuth, requireRole } from '../auth.js';

const r = Router();

// Where uploaded product photos are stored on disk.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Small helper to wrap handlers and forward errors.
const h = (fn) => (req, res) => {
  try { fn(req, res); }
  catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
};

// A user counts as "online" if they've logged in or sent a heartbeat in the
// last 90s (the front-end pings every 45s while signed in, so this tolerates
// one missed ping). Pre-existing demo accounts have a human string like
// "2 min ago" instead of a timestamp — Date.parse returns NaN for those, so
// they correctly fall through to offline rather than throwing.
const ONLINE_THRESHOLD_MS = 90 * 1000;
const withOnline = (u) => u && { ...u, online: !!u.lastActive && (Date.now() - Date.parse(u.lastActive)) < ONLINE_THRESHOLD_MS };
const publicUser = (u) => u && withOnline({ id: u.id, name: u.name, username: u.username, role: u.role, email: u.email, lastActive: u.lastActive, store: u.store });

// ---------------- AUTH ----------------
// Public: accounts to suggest on the login screen (no secrets).
r.get('/auth/staff', h((req, res) => {
  res.json(db.prepare('SELECT id, name, username, role, store FROM users ORDER BY name').all());
}));

// Public: exchange { username, pin } for a signed token.
r.post('/auth/login', h((req, res) => {
  const { username, pin } = req.body || {};
  if (!username || pin == null) return res.status(400).json({ error: 'Username and PIN are required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username).trim());
  if (!user || !verifyPin(pin, user.pin_hash, user.pin_salt)) {
    return res.status(401).json({ error: 'Incorrect username or PIN' });
  }
  db.prepare('UPDATE users SET lastActive=? WHERE id=?').run(new Date().toISOString(), user.id);
  res.json({ token: issueToken(user), user: publicUser(user) });
}));

// Confirm a saved token is still valid (used on app reload).
r.get('/auth/me', requireAuth, h((req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  res.json({ user: publicUser(user) });
}));

// Authenticated: ping to mark this account as currently active. The front-end
// calls this every 45s while signed in, powering the admin "who's online" list.
r.post('/auth/heartbeat', requireAuth, h((req, res) => {
  db.prepare('UPDATE users SET lastActive=? WHERE id=?').run(new Date().toISOString(), req.user.id);
  res.json({ ok: true });
}));

// Admin/manager: set or reset a user's PIN.
r.put('/users/:id/pin', requireAuth, requireRole('admin', 'manager'), h((req, res) => {
  const { pin } = req.body || {};
  if (!/^\d{4,6}$/.test(String(pin || ''))) throw new Error('PIN must be 4–6 digits');
  if (!db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id)) throw new Error('user not found');
  const { hash, salt } = hashPin(pin);
  db.prepare('UPDATE users SET pin_hash=?, pin_salt=? WHERE id=?').run(hash, salt, req.params.id);
  res.json({ ok: true });
}));

// ---------------- IMAGE UPLOAD ----------------
// Accepts JSON { filename, dataUrl } where dataUrl is a base64 data URL from the
// browser (FileReader.readAsDataURL). Writes the file to /uploads and returns
// the public path the front-end should store, e.g. { path: "/uploads/ab12.jpg" }.
r.post('/upload', h((req, res) => {
  const { filename = 'photo', dataUrl } = req.body || {};
  if (!dataUrl || !dataUrl.startsWith('data:')) throw new Error('dataUrl (base64 image) is required');
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) throw new Error('unsupported image data');
  const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg');
  const base = filename.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9._-]/gi, '_').slice(0, 40) || 'photo';
  const name = `${Date.now()}-${base}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(m[2], 'base64'));
  res.status(201).json({ path: `/uploads/${name}` });
}));

// ---------------- PRODUCTS ----------------
r.get('/products', h((req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY id').all());
}));

r.post('/products', h((req, res) => {
  const { name, name_fr = '', category, price, cost = 0, discount = 0, stock = 0, sku, emoji = '📦', image = null } = req.body;
  if (!name || !category || price == null || !sku) throw new Error('name, category, price and sku are required');
  const info = db.prepare(
    'INSERT INTO products (name,name_fr,category,price,cost,discount,stock,sku,emoji,image) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(name, name_fr, category, price, cost, discount, stock, sku, emoji, image);
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id=?').get(info.lastInsertRowid));
}));

r.put('/products/:id', h((req, res) => {
  const cur = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!cur) throw new Error('product not found');
  const n = { ...cur, ...req.body };
  db.prepare('UPDATE products SET name=?,name_fr=?,category=?,price=?,cost=?,discount=?,stock=?,sku=?,emoji=?,image=? WHERE id=?')
    .run(n.name, n.name_fr, n.category, n.price, n.cost ?? 0, n.discount ?? 0, n.stock, n.sku, n.emoji, n.image ?? null, req.params.id);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id));
}));

r.delete('/products/:id', h((req, res) => {
  db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------------- CUSTOMERS ----------------
r.get('/customers', h((req, res) => {
  res.json(db.prepare('SELECT * FROM customers ORDER BY spent DESC').all());
}));
r.post('/customers', h((req, res) => {
  const { name, phone = '', points = 0, tier = 'Bronze', visits = 0, spent = 0 } = req.body;
  if (!name) throw new Error('name is required');
  const info = db.prepare('INSERT INTO customers (name,phone,points,tier,visits,spent) VALUES (?,?,?,?,?,?)')
    .run(name, phone, points, tier, visits, spent);
  res.status(201).json(db.prepare('SELECT * FROM customers WHERE id=?').get(info.lastInsertRowid));
}));
r.put('/customers/:id', h((req, res) => {
  const cur = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!cur) throw new Error('customer not found');
  const n = { ...cur, ...req.body };
  db.prepare('UPDATE customers SET name=?,phone=?,points=?,tier=?,visits=?,spent=? WHERE id=?')
    .run(n.name, n.phone, n.points, n.tier, n.visits, n.spent, req.params.id);
  res.json(db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id));
}));

// ---------------- SUPPLIERS ----------------
r.get('/suppliers', h((req, res) => res.json(db.prepare('SELECT * FROM suppliers ORDER BY id').all())));
r.post('/suppliers', h((req, res) => {
  const { name, contact = '', phone = '', email = '', productsCount = 0, lastOrder = '', status = 'active', category = '' } = req.body;
  if (!name) throw new Error('name is required');
  const info = db.prepare('INSERT INTO suppliers (name,contact,phone,email,productsCount,lastOrder,status,category) VALUES (?,?,?,?,?,?,?,?)')
    .run(name, contact, phone, email, productsCount, lastOrder, status, category);
  res.status(201).json(db.prepare('SELECT * FROM suppliers WHERE id=?').get(info.lastInsertRowid));
}));
r.put('/suppliers/:id', h((req, res) => {
  const cur = db.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id);
  if (!cur) throw new Error('supplier not found');
  const n = { ...cur, ...req.body };
  db.prepare('UPDATE suppliers SET name=?,contact=?,phone=?,email=?,productsCount=?,lastOrder=?,status=?,category=? WHERE id=?')
    .run(n.name, n.contact, n.phone, n.email, n.productsCount, n.lastOrder, n.status, n.category, req.params.id);
  res.json(db.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id));
}));

// ---------------- PURCHASE ORDERS ----------------
r.get('/purchase-orders', h((req, res) => res.json(db.prepare('SELECT * FROM purchase_orders ORDER BY date DESC').all())));
r.post('/purchase-orders', h((req, res) => {
  const { supplierId = null, supplier = '', items = 0, total = 0, status = 'draft' } = req.body;
  const year = new Date().getFullYear();
  const seq = (db.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get().n + 146);
  const id = `PO-${year}-${String(seq).padStart(4, '0')}`;
  const date = new Date().toISOString().slice(0, 10);
  db.prepare('INSERT INTO purchase_orders (id,supplierId,supplier,date,items,total,status) VALUES (?,?,?,?,?,?,?)')
    .run(id, supplierId, supplier, date, items, total, status);
  res.status(201).json(db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id));
}));
r.patch('/purchase-orders/:id', h((req, res) => {
  const cur = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!cur) throw new Error('PO not found');
  const status = req.body.status ?? cur.status;
  db.prepare('UPDATE purchase_orders SET status=? WHERE id=?').run(status, req.params.id);
  res.json(db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id));
}));

// ---------------- STOCK MOVEMENTS ----------------
r.get('/stock-movements', h((req, res) => res.json(db.prepare('SELECT * FROM stock_movements ORDER BY id DESC').all())));
r.post('/stock-movements', h((req, res) => {
  const { productName, type, qty, source = '', user = 'System' } = req.body;
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const info = db.prepare('INSERT INTO stock_movements (productName,type,qty,source,date,user) VALUES (?,?,?,?,?,?)')
    .run(productName, type, qty, source, date, user);
  res.status(201).json(db.prepare('SELECT * FROM stock_movements WHERE id=?').get(info.lastInsertRowid));
}));

// ---------------- USERS ----------------
r.get('/users', h((req, res) => {
  const rows = db.prepare('SELECT id,name,username,role,email,lastActive,store FROM users ORDER BY id').all();
  res.json(rows.map(withOnline));
}));

r.post('/users', requireAuth, requireRole('admin', 'manager'), h((req, res) => {
  const { name, role = 'cashier', email = '', store = '', pin = '1234' } = req.body;
  let { username } = req.body;
  if (!name) throw new Error('name is required');
  if (!/^\d{4,6}$/.test(String(pin))) throw new Error('PIN must be 4–6 digits');
  const slug = (s) => (s || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);
  username = slug(username) || slug((email || '').split('@')[0]) || slug(name) || 'user';
  let base = username, n = 1;
  while (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) username = `${base}${++n}`;
  const { hash, salt } = hashPin(pin);
  const info = db.prepare('INSERT INTO users (name,username,role,email,lastActive,store,pin_hash,pin_salt) VALUES (?,?,?,?,?,?,?,?)')
    .run(name, username, role, email, null, store, hash, salt);
  res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid)));
}));

r.put('/users/:id', requireAuth, requireRole('admin', 'manager'), h((req, res) => {
  const cur = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!cur) throw new Error('user not found');
  const n = { ...cur, ...req.body };
  db.prepare('UPDATE users SET name=?,role=?,email=?,store=? WHERE id=?')
    .run(n.name, n.role, n.email, n.store, req.params.id);
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id)));
}));

// Admin only: delete a cashier or manager account.
// Guards: cannot delete an admin account, and cannot delete yourself.
// Also removes that person's shifts so they disappear from the Shifts page.
r.delete('/users/:id', requireAuth, requireRole('admin'), h((req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!target) throw new Error('user not found');
  if (target.role === 'admin') throw new Error('Admin accounts cannot be deleted');
  if (Number(req.params.id) === Number(req.user.id)) throw new Error('You cannot delete your own account');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM shifts WHERE employeeId=?').run(req.params.id);
    db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  });
  tx();
  res.json({ ok: true });
}));

// ---------------- EMPLOYEES & SHIFTS ----------------
// Shifts are keyed to the logged-in user account (employeeId = user id), so each
// person can only clock themselves in or out. Managers/admins read the full list.
r.get('/employees', h((req, res) => res.json(db.prepare('SELECT * FROM employees ORDER BY id').all())));
r.get('/shifts', h((req, res) => res.json(db.prepare('SELECT * FROM shifts ORDER BY clockIn DESC').all())));

// Clock IN — always the authenticated user.
r.post('/shifts/clock-in', requireAuth, h((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!u) throw new Error('account not found');
  const open = db.prepare('SELECT * FROM shifts WHERE employeeId=? AND clockOut IS NULL').get(u.id);
  if (open) throw new Error('You are already clocked in');
  const info = db.prepare('INSERT INTO shifts (employeeId,name,role,clockIn,clockOut) VALUES (?,?,?,?,NULL)')
    .run(u.id, u.name, u.role, new Date().toISOString());
  res.status(201).json(db.prepare('SELECT * FROM shifts WHERE id=?').get(info.lastInsertRowid));
}));

// Clock OUT — always the authenticated user.
r.post('/shifts/clock-out', requireAuth, h((req, res) => {
  const open = db.prepare('SELECT * FROM shifts WHERE employeeId=? AND clockOut IS NULL').get(req.user.id);
  if (!open) throw new Error('You are not clocked in');
  db.prepare('UPDATE shifts SET clockOut=? WHERE id=?').run(new Date().toISOString(), open.id);
  res.json(db.prepare('SELECT * FROM shifts WHERE id=?').get(open.id));
}));

// ---------------- ORDERS / CHECKOUT (the heart of the POS) ----------------
// A single transaction: create the order, store its line items,
// decrement product stock, log stock-out movements, bump customer stats.
r.post('/orders', h((req, res) => {
  const { items = [], customerId = null, method = 'cash', cashier = '', discount = 0, tva = 0, clientOrderId = null } = req.body;
  if (!items.length) throw new Error('cannot checkout an empty cart');

  // Idempotency: a retried or offline-queued checkout sends the same
  // clientOrderId. If we already recorded it, return that sale instead of
  // creating a second one (e.g. the connection dropped after the order
  // saved but before the success response reached the cashier's browser).
  if (clientOrderId) {
    const existing = db.prepare('SELECT * FROM orders WHERE clientOrderId=?').get(clientOrderId);
    if (existing) {
      existing.items = db.prepare('SELECT * FROM order_items WHERE orderId=?').all(existing.id);
      return res.status(200).json(existing);
    }
  }

  const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
  const total = Math.round(subtotal - discount + tva);
  const year = new Date().getFullYear();
  const invoiceNo = `INV-${year}-${Math.floor(Math.random() * 9000 + 1000)}`;
  const createdAt = new Date().toISOString();

  const tx = db.transaction(() => {
    const orderInfo = db.prepare(
      'INSERT INTO orders (invoiceNo,customerId,subtotal,discount,tva,total,method,cashier,createdAt,clientOrderId) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(invoiceNo, customerId, subtotal, Math.round(discount), Math.round(tva), total, method, cashier, createdAt, clientOrderId);
    const orderId = orderInfo.lastInsertRowid;

    const itemIns = db.prepare('INSERT INTO order_items (orderId,productId,name,sku,price,cost,qty) VALUES (?,?,?,?,?,?,?)');
    const stockUpd = db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id=?');
    const moveIns = db.prepare('INSERT INTO stock_movements (productName,type,qty,source,date,user) VALUES (?,?,?,?,?,?)');
    const costOf = db.prepare('SELECT cost FROM products WHERE id=?');
    const dateStr = createdAt.slice(0, 16).replace('T', ' ');

    for (const it of items) {
      const unitCost = it.id ? (costOf.get(it.id)?.cost || 0) : 0;
      itemIns.run(orderId, it.id, it.name, it.sku, it.price, unitCost, it.qty);
      if (it.id) {
        stockUpd.run(it.qty, it.id);
        moveIns.run(it.name, 'out', it.qty, invoiceNo, dateStr, cashier || 'POS');
      }
    }

    if (customerId) {
      const earned = Math.floor(total / 1000);
      db.prepare('UPDATE customers SET spent = spent + ?, points = points + ?, visits = visits + 1 WHERE id=?')
        .run(total, earned, customerId);
    }
    return orderId;
  });

  const orderId = tx();
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  order.items = db.prepare('SELECT * FROM order_items WHERE orderId=?').all(orderId);
  res.status(201).json(order);
}));

r.get('/orders', h((req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY createdAt DESC LIMIT 200').all();
  res.json(orders);
}));

// ---------------- SETTINGS ----------------
r.get('/settings', h((req, res) => {
  const row = db.prepare('SELECT json FROM settings WHERE id=1').get();
  res.json(row ? JSON.parse(row.json) : {});
}));
r.put('/settings', h((req, res) => {
  const json = JSON.stringify(req.body || {});
  db.prepare('INSERT INTO settings (id,json) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(json);
  res.json(req.body);
}));

// ---------------- EXPENSES ----------------
// Recorded by accountants/managers/admins. Read by anyone who can see finance.
r.get('/expenses', requireAuth, h((req, res) => {
  res.json(db.prepare('SELECT * FROM expenses ORDER BY date DESC, id DESC').all());
}));

r.post('/expenses', requireAuth, requireRole('admin', 'manager', 'accountant'), h((req, res) => {
  const { date, category = '', payee = '', amount, method = 'cash', note = '', clientId = null } = req.body || {};
  if (!date || amount == null) throw new Error('date and amount are required');

  // Same idempotency pattern as orders: a retried/offline-queued expense
  // carries the same clientId, so a retry can't double-record it.
  if (clientId) {
    const existing = db.prepare('SELECT * FROM expenses WHERE clientId=?').get(clientId);
    if (existing) return res.status(200).json(existing);
  }

  const info = db.prepare(
    'INSERT INTO expenses (date,category,payee,amount,method,note,createdBy,createdAt,clientId) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(date, category, payee, Math.round(Number(amount)), method, note, req.user.name, new Date().toISOString(), clientId);
  res.status(201).json(db.prepare('SELECT * FROM expenses WHERE id=?').get(info.lastInsertRowid));
}));

r.delete('/expenses/:id', requireAuth, requireRole('admin', 'manager', 'accountant'), h((req, res) => {
  db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
  res.json({ ok: true });
}));

// Admin only: wipe all demo/operational data so the shop starts from scratch.
// Clears inventory, sales, stock movements, purchase orders, customers,
// suppliers, expenses, shifts and employees. Every other login account is
// deleted too — only the admin account used to run the reset survives.
// Settings (business profile) are left untouched.
r.post('/maintenance/clear-data', requireAuth, requireRole('admin'), h((req, res) => {
  const tx = db.transaction(() => {
    for (const tbl of [
      'order_items', 'orders', 'stock_movements', 'purchase_orders',
      'products', 'customers', 'suppliers', 'expenses', 'shifts', 'employees',
    ]) {
      db.prepare(`DELETE FROM ${tbl}`).run();
    }
    db.prepare('DELETE FROM users WHERE id != ?').run(req.user.id);
  });
  tx();
  res.json({ ok: true });
}));

// ---------------- REPORTS ----------------
// Simple aggregations the front-end can render or download.
r.get('/reports/sales', h((req, res) => {
  const rows = db.prepare(`
    SELECT substr(createdAt,1,10) AS day, COUNT(*) AS orders, SUM(total) AS sales
    FROM orders GROUP BY day ORDER BY day DESC LIMIT 30
  `).all();
  const totals = db.prepare('SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue FROM orders').get();
  res.json({ daily: rows, totals });
}));

r.get('/reports/inventory', h((req, res) => {
  const products = db.prepare('SELECT name,sku,category,price,cost,stock FROM products ORDER BY stock ASC').all();
  const value = products.reduce((s, p) => s + p.price * p.stock, 0);
  const costValue = products.reduce((s, p) => s + (p.cost || 0) * p.stock, 0);
  const low = products.filter(p => p.stock < 10).length;
  res.json({ products, stockValue: value, stockCostValue: costValue, lowStock: low, totalSkus: products.length });
}));

// ---- Accounting: a date-range report powering exports, TVA and margin ----
// Query params: from=YYYY-MM-DD & to=YYYY-MM-DD (inclusive). Defaults to today.
const dayBounds = (from, to) => {
  const today = new Date().toISOString().slice(0, 10);
  const f = (from || today) + ' 00:00:00';
  const t = (to || from || today) + ' 23:59:59';
  return { f, t };
};

r.get('/reports/range', h((req, res) => {
  const { f, t } = dayBounds(req.query.from, req.query.to);
  const where = 'WHERE createdAt >= ? AND createdAt <= ?';

  const totals = db.prepare(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(subtotal),0) AS subtotal,
            COALESCE(SUM(discount),0) AS discount,
            COALESCE(SUM(tva),0) AS tva,
            COALESCE(SUM(total),0) AS revenue
     FROM orders ${where}`
  ).get(f, t);

  const byMethod = db.prepare(
    `SELECT method, COUNT(*) AS orders, COALESCE(SUM(total),0) AS amount
     FROM orders ${where} GROUP BY method`
  ).all(f, t);

  const daily = db.prepare(
    `SELECT substr(createdAt,1,10) AS day, COUNT(*) AS orders,
            COALESCE(SUM(total),0) AS sales, COALESCE(SUM(tva),0) AS tva
     FROM orders ${where} GROUP BY day ORDER BY day`
  ).all(f, t);

  // Margin from order line items (cost snapshotted at sale time).
  const margin = db.prepare(
    `SELECT COALESCE(SUM(oi.price*oi.qty),0) AS itemRevenue,
            COALESCE(SUM(oi.cost*oi.qty),0) AS itemCost
     FROM order_items oi JOIN orders o ON o.id = oi.orderId ${where.replace('createdAt', 'o.createdAt')}`
  ).get(f, t);

  const orders = db.prepare(
    `SELECT invoiceNo, createdAt, cashier, method, subtotal, discount, tva, total
     FROM orders ${where} ORDER BY createdAt`
  ).all(f, t);

  const grossProfit = (margin.itemRevenue || 0) - (margin.itemCost || 0);
  const marginPct = margin.itemRevenue ? (grossProfit / margin.itemRevenue) * 100 : 0;

  res.json({
    from: req.query.from || new Date().toISOString().slice(0, 10),
    to: req.query.to || req.query.from || new Date().toISOString().slice(0, 10),
    totals, byMethod, daily,
    margin: { revenue: margin.itemRevenue, cost: margin.itemCost, grossProfit, marginPct },
    orders,
  });
}));

// Daily Z-report: one day's close-out summary + expected cash drawer.
r.get('/reports/z', h((req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const f = date + ' 00:00:00', t = date + ' 23:59:59';
  const where = 'WHERE createdAt >= ? AND createdAt <= ?';
  const totals = db.prepare(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(subtotal),0) AS subtotal,
            COALESCE(SUM(discount),0) AS discount, COALESCE(SUM(tva),0) AS tva,
            COALESCE(SUM(total),0) AS revenue FROM orders ${where}`
  ).get(f, t);
  const byMethod = db.prepare(
    `SELECT method, COUNT(*) AS orders, COALESCE(SUM(total),0) AS amount
     FROM orders ${where} GROUP BY method`
  ).all(f, t);
  const margin = db.prepare(
    `SELECT COALESCE(SUM(oi.price*oi.qty),0) AS itemRevenue, COALESCE(SUM(oi.cost*oi.qty),0) AS itemCost
     FROM order_items oi JOIN orders o ON o.id = oi.orderId WHERE o.createdAt >= ? AND o.createdAt <= ?`
  ).get(f, t);
  const cashDrawer = (byMethod.find(m => m.method === 'cash')?.amount) || 0;
  const grossProfit = (margin.itemRevenue || 0) - (margin.itemCost || 0);
  res.json({ date, totals, byMethod, expectedCash: cashDrawer,
    margin: { revenue: margin.itemRevenue, cost: margin.itemCost, grossProfit } });
}));

export default r;
