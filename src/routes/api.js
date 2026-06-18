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
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Small helper to wrap handlers and forward errors.
const h = (fn) => (req, res) => {
  try { fn(req, res); }
  catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
};

const publicUser = (u) => u && ({ id: u.id, name: u.name, username: u.username, role: u.role, email: u.email, lastActive: u.lastActive, store: u.store });

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
  db.prepare('UPDATE users SET lastActive=? WHERE id=?').run('Just now', user.id);
  res.json({ token: issueToken(user), user: publicUser(user) });
}));

// Confirm a saved token is still valid (used on app reload).
r.get('/auth/me', requireAuth, h((req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  res.json({ user: publicUser(user) });
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
  const safe = filename.replace(/[^a-z0-9._-]/gi, '_').slice(0, 40);
  const name = `${Date.now()}-${safe}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(m[2], 'base64'));
  res.status(201).json({ path: `/uploads/${name}` });
}));

// ---------------- PRODUCTS ----------------
r.get('/products', h((req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY id').all());
}));

r.post('/products', h((req, res) => {
  const { name, name_fr = '', category, price, stock = 0, sku, emoji = '📦', image = null } = req.body;
  if (!name || !category || price == null || !sku) throw new Error('name, category, price and sku are required');
  const info = db.prepare(
    'INSERT INTO products (name,name_fr,category,price,stock,sku,emoji,image) VALUES (?,?,?,?,?,?,?,?)'
  ).run(name, name_fr, category, price, stock, sku, emoji, image);
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id=?').get(info.lastInsertRowid));
}));

r.put('/products/:id', h((req, res) => {
  const cur = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!cur) throw new Error('product not found');
  const n = { ...cur, ...req.body };
  db.prepare('UPDATE products SET name=?,name_fr=?,category=?,price=?,stock=?,sku=?,emoji=?,image=? WHERE id=?')
    .run(n.name, n.name_fr, n.category, n.price, n.stock, n.sku, n.emoji, n.image ?? null, req.params.id);
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
r.get('/users', h((req, res) =>
  res.json(db.prepare('SELECT id,name,username,role,email,lastActive,store FROM users ORDER BY id').all())
));

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
    .run(name, username, role, email, 'Just now', store, hash, salt);
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
  const { items = [], customerId = null, method = 'cash', cashier = '', discount = 0, tva = 0 } = req.body;
  if (!items.length) throw new Error('cannot checkout an empty cart');

  const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
  const total = Math.round(subtotal - discount + tva);
  const year = new Date().getFullYear();
  const invoiceNo = `INV-${year}-${Math.floor(Math.random() * 9000 + 1000)}`;
  const createdAt = new Date().toISOString();

  const tx = db.transaction(() => {
    const orderInfo = db.prepare(
      'INSERT INTO orders (invoiceNo,customerId,subtotal,discount,tva,total,method,cashier,createdAt) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(invoiceNo, customerId, subtotal, Math.round(discount), Math.round(tva), total, method, cashier, createdAt);
    const orderId = orderInfo.lastInsertRowid;

    const itemIns = db.prepare('INSERT INTO order_items (orderId,productId,name,sku,price,qty) VALUES (?,?,?,?,?,?)');
    const stockUpd = db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id=?');
    const moveIns = db.prepare('INSERT INTO stock_movements (productName,type,qty,source,date,user) VALUES (?,?,?,?,?,?)');
    const dateStr = createdAt.slice(0, 16).replace('T', ' ');

    for (const it of items) {
      itemIns.run(orderId, it.id, it.name, it.sku, it.price, it.qty);
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
  const products = db.prepare('SELECT name,sku,category,price,stock FROM products ORDER BY stock ASC').all();
  const value = products.reduce((s, p) => s + p.price * p.stock, 0);
  const low = products.filter(p => p.stock < 10).length;
  res.json({ products, stockValue: value, lowStock: low, totalSkus: products.length });
}));

export default r;
