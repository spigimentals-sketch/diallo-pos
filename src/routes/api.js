// routes/api.js — every REST endpoint for the POS.
import { Router } from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { db } from '../db.js';
import { hashPin, verifyPin, issueToken, requireAuth, requireRole, verifyToken } from '../auth.js';

const r = Router();

// Where uploaded product photos are stored on disk.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Small helper to wrap handlers and forward errors — sync throws and
// rejected promises both land in the same place.
const h = (fn) => (req, res) => {
  const onError = (e) => { console.error(e); res.status(400).json({ error: e.message }); };
  try {
    const result = fn(req, res);
    if (result && typeof result.catch === 'function') result.catch(onError);
  } catch (e) { onError(e); }
};

// Clock-in is meant to happen at the fixed POS terminal, not on a handheld
// device — phones AND tablets are both rejected. This mirrors the same
// check the frontend makes before it even calls this endpoint; it's not
// airtight (a UA header can be spoofed) but it backs that check up rather
// than trusting the client alone.
const isHandheldUA = (ua = '') => {
  if (/iPad/i.test(ua)) return true;
  if (/iPhone|iPod/i.test(ua)) return true;
  if (/Android/i.test(ua)) return true;
  if (/Windows Phone/i.test(ua)) return true;
  return false;
};

// A user counts as "online" if they've logged in or sent a heartbeat in the
// last 90s (the front-end pings every 45s while signed in, so this tolerates
// one missed ping). Pre-existing demo accounts have a human string like
// "2 min ago" instead of a timestamp — Date.parse returns NaN for those, so
// they correctly fall through to offline rather than throwing.
const ONLINE_THRESHOLD_MS = 90 * 1000;
const withOnline = (u) => u && { ...u, online: !!u.lastActive && (Date.now() - Date.parse(u.lastActive)) < ONLINE_THRESHOLD_MS };
const publicUser = (u) => u && withOnline({ id: u.id, name: u.name, username: u.username, role: u.role, email: u.email, lastActive: u.lastActive, store: u.store, whatsapp: u.whatsapp, hourlyRate: u.hourlyRate });

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

// Same idea as /upload, but for PDFs — used by the WhatsApp notification
// feature so a generated payslip/notice has a real URL to put in the
// message text (wa.me links can only pre-fill text, never attach a file).
r.post('/upload-document', requireAuth, h((req, res) => {
  const { filename = 'document', dataUrl } = req.body || {};
  if (!dataUrl || !dataUrl.startsWith('data:application/pdf')) throw new Error('dataUrl (base64 PDF) is required');
  const m = dataUrl.match(/^data:application\/pdf;base64,(.+)$/);
  if (!m) throw new Error('unsupported document data');
  const base = filename.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9._-]/gi, '_').slice(0, 40) || 'document';
  const name = `${Date.now()}-${base}.pdf`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(m[1], 'base64'));
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

// ---------------- CATEGORIES ----------------
r.get('/categories', h((req, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY label').all());
}));

// Lets the product form create a category on the fly instead of being
// limited to the 7 built-in ones. id is derived from the label (slugified)
// so it slots into products.category/checkout filters/Home cards the same
// way the built-ins do; re-posting an existing label just returns it as-is
// rather than erroring, so the form can call this unconditionally.
r.post('/categories', h((req, res) => {
  const { label } = req.body || {};
  if (!label || !label.trim()) throw new Error('label is required');
  const trimmed = label.trim();
  const id = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!id) throw new Error('Could not derive a category id from that name');
  const existing = db.prepare('SELECT * FROM categories WHERE id=?').get(id);
  if (existing) return res.json(existing);
  db.prepare('INSERT INTO categories (id, label) VALUES (?, ?)').run(id, trimmed);
  res.status(201).json({ id, label: trimmed });
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
// Accounts payable: every PO carries amountPaid, so `outstanding` is what's
// still owed to that supplier. Computed on read rather than stored, so it
// can never drift out of sync with recorded payments.
const withOutstanding = (po) => po && { ...po, outstanding: po.total - (po.amountPaid || 0) };

r.get('/purchase-orders', h((req, res) =>
  res.json(db.prepare('SELECT * FROM purchase_orders ORDER BY date DESC').all().map(withOutstanding))
));
r.post('/purchase-orders', h((req, res) => {
  const { supplierId = null, supplier = '', items = 0, total = 0, status = 'draft', dueDate = null } = req.body;
  const year = new Date().getFullYear();
  const seq = (db.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get().n + 146);
  const id = `PO-${year}-${String(seq).padStart(4, '0')}`;
  const date = new Date().toISOString().slice(0, 10);
  db.prepare('INSERT INTO purchase_orders (id,supplierId,supplier,date,items,total,status,dueDate,amountPaid) VALUES (?,?,?,?,?,?,?,?,0)')
    .run(id, supplierId, supplier, date, items, total, status, dueDate);
  res.status(201).json(withOutstanding(db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id)));
}));
r.patch('/purchase-orders/:id', h((req, res) => {
  const cur = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!cur) throw new Error('PO not found');
  const status = req.body.status ?? cur.status;
  const dueDate = req.body.dueDate ?? cur.dueDate;
  db.prepare('UPDATE purchase_orders SET status=?, dueDate=? WHERE id=?').run(status, dueDate, req.params.id);
  res.json(withOutstanding(db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id)));
}));

// Record a payment against a PO (accounts-payable ledger). Admin/manager
// only — this moves real money against a supplier balance.
r.post('/purchase-orders/:id/payments', requireAuth, requireRole('admin', 'manager'), h((req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po) throw new Error('PO not found');
  const { amount, method = 'cash', note = '' } = req.body || {};
  const amt = Math.round(Number(amount));
  if (!amt || amt <= 0) throw new Error('amount must be a positive number');
  const outstanding = po.total - (po.amountPaid || 0);
  if (amt > outstanding) throw new Error(`Amount exceeds outstanding balance of ${outstanding}`);

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO po_payments (purchaseOrderId,amount,method,note,createdBy,createdAt) VALUES (?,?,?,?,?,?)')
      .run(po.id, amt, method, note, req.user.name, new Date().toISOString());
    db.prepare('UPDATE purchase_orders SET amountPaid = amountPaid + ? WHERE id=?').run(amt, po.id);
  });
  tx();
  res.status(201).json(withOutstanding(db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(po.id)));
}));

r.get('/purchase-orders/:id/payments', h((req, res) =>
  res.json(db.prepare('SELECT * FROM po_payments WHERE purchaseOrderId=? ORDER BY createdAt DESC').all(req.params.id))
));

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
  const rows = db.prepare('SELECT id,name,username,role,email,lastActive,store,whatsapp,hourlyRate FROM users ORDER BY id').all();
  res.json(rows.map(withOnline));
}));

r.post('/users', requireAuth, requireRole('admin', 'manager'), h((req, res) => {
  const { name, role = 'cashier', email = '', store = '', pin = '1234', whatsapp = '', hourlyRate = 0 } = req.body;
  let { username } = req.body;
  if (!name) throw new Error('name is required');
  if (!/^\d{4,6}$/.test(String(pin))) throw new Error('PIN must be 4–6 digits');
  const slug = (s) => (s || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);
  username = slug(username) || slug((email || '').split('@')[0]) || slug(name) || 'user';
  let base = username, n = 1;
  while (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) username = `${base}${++n}`;
  const { hash, salt } = hashPin(pin);
  const info = db.prepare('INSERT INTO users (name,username,role,email,lastActive,store,pin_hash,pin_salt,whatsapp,hourlyRate) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(name, username, role, email, null, store, hash, salt, whatsapp, Number(hourlyRate) || 0);
  res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid)));
}));

r.put('/users/:id', requireAuth, requireRole('admin', 'manager'), h((req, res) => {
  const cur = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!cur) throw new Error('user not found');
  const n = { ...cur, ...req.body };
  db.prepare('UPDATE users SET name=?,role=?,email=?,store=?,whatsapp=?,hourlyRate=? WHERE id=?')
    .run(n.name, n.role, n.email, n.store, n.whatsapp || '', Number(n.hourlyRate) || 0, req.params.id);
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
// Cashiers can see shift times but not the cash reconciliation outcome or
// their own clock-in photo — whether the drawer was balanced and who
// actually showed up are management/accounting's call to review, not
// something to surface back to the person being checked on. Stripped here,
// not just hidden in the UI, since the raw response is one devtools click
// away otherwise. This route stays public like its sibling reads
// (/products, /customers, /settings, ...) so the app's very first load —
// before anyone's logged in and there's no token yet to read a role from —
// doesn't fail; the front-end re-pulls this once a session exists, at
// which point the token here lets us actually tell who's asking.
r.get('/shifts', h((req, res) => {
  const shifts = db.prepare('SELECT * FROM shifts ORDER BY clockIn DESC').all();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  const canSeeCash = payload && ['admin', 'manager', 'accountant'].includes(payload.role);
  if (canSeeCash) return res.json(shifts);
  res.json(shifts.map(({ expectedCash, countedCash, cashVariance, clockInPhoto, ...rest }) => rest));
}));

// Clock IN — always the authenticated user. A clock-in photo is required:
// it's the thing standing in for "this is really that person," now that
// fingerprint verification turned out to be impractical (WebAuthn ties a
// credential to one exact origin, which broke every time the domain
// changed). The photo is just uploaded like a product photo (see /upload
// above) and the resulting path is stored against this shift.
r.post('/shifts/clock-in', requireAuth, h((req, res) => {
  if (isHandheldUA(req.headers['user-agent'])) throw new Error('Use the POS terminal for this — not a phone or tablet');
  const { photo } = req.body || {};
  if (!photo) throw new Error('A clock-in photo is required');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!u) throw new Error('account not found');
  const open = db.prepare('SELECT * FROM shifts WHERE employeeId=? AND clockOut IS NULL').get(u.id);
  if (open) throw new Error('You are already clocked in');
  const info = db.prepare('INSERT INTO shifts (employeeId,name,role,clockIn,clockOut,clockInPhoto) VALUES (?,?,?,?,NULL,?)')
    .run(u.id, u.name, u.role, new Date().toISOString(), photo);
  res.status(201).json(db.prepare('SELECT * FROM shifts WHERE id=?').get(info.lastInsertRowid));
}));

// Clock OUT — always the authenticated user. Reconciles the cash drawer:
// expectedCash is computed from this cashier's own cash-method sales during
// the shift, compared against what they actually counted (countedCash, from
// the clock-out prompt) to get an over/short variance for accountability.
// countedCash is optional so this stays robust for offline-queued retries —
// expectedCash is still recorded either way.
r.post('/shifts/clock-out', requireAuth, h((req, res) => {
  const open = db.prepare('SELECT * FROM shifts WHERE employeeId=? AND clockOut IS NULL').get(req.user.id);
  if (!open) throw new Error('You are not clocked in');
  const clockOutAt = new Date().toISOString();
  const { countedCash = null } = req.body || {};

  const expectedCash = db.prepare(
    `SELECT COALESCE(SUM(total),0) AS amount FROM orders
     WHERE method='cash' AND cashier=? AND createdAt >= ? AND createdAt <= ?`
  ).get(open.name, open.clockIn, clockOutAt).amount;

  const counted = countedCash != null && countedCash !== '' ? Math.round(Number(countedCash)) : null;
  const cashVariance = counted != null ? counted - expectedCash : null;

  db.prepare('UPDATE shifts SET clockOut=?, expectedCash=?, countedCash=?, cashVariance=? WHERE id=?')
    .run(clockOutAt, expectedCash, counted, cashVariance, open.id);
  const updated = db.prepare('SELECT * FROM shifts WHERE id=?').get(open.id);
  // Clock-out is always self-service, so the requester here is whoever just
  // clocked out — don't hand a cashier their own variance in the response
  // even though the UI doesn't render it; the JSON itself shouldn't carry it.
  if (!['admin', 'manager', 'accountant'].includes(req.user.role)) {
    const { expectedCash, countedCash, cashVariance, clockInPhoto, ...rest } = updated;
    return res.json(rest);
  }
  res.json(updated);
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
    // Re-check stock against the live database, not whatever the cart held
    // when the cashier started — another terminal may have sold the last
    // units in the meantime. Reject the whole sale rather than silently
    // selling stock that no longer exists.
    const stockOf = db.prepare('SELECT name, stock FROM products WHERE id=?');
    for (const it of items) {
      if (!it.id) continue;
      const p = stockOf.get(it.id);
      if (!p) throw new Error(`Product no longer exists: ${it.name}`);
      if (p.stock < it.qty) throw new Error(`Insufficient stock for ${p.name}: only ${p.stock} left`);
    }

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
      db.prepare('UPDATE customers SET spent = spent + ?, visits = visits + 1 WHERE id=?')
        .run(total, customerId);
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
  const { date, category = '', payee = '', amount, method = 'cash', note = '', clientId = null, type = 'operating' } = req.body || {};
  if (!date || amount == null) throw new Error('date and amount are required');
  if (type !== 'operating' && type !== 'setup') throw new Error('type must be "operating" or "setup"');

  // Same idempotency pattern as orders: a retried/offline-queued expense
  // carries the same clientId, so a retry can't double-record it.
  if (clientId) {
    const existing = db.prepare('SELECT * FROM expenses WHERE clientId=?').get(clientId);
    if (existing) return res.status(200).json(existing);
  }

  const info = db.prepare(
    'INSERT INTO expenses (date,category,payee,amount,method,note,createdBy,createdAt,clientId,type) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(date, category, payee, Math.round(Number(amount)), method, note, req.user.name, new Date().toISOString(), clientId, type);
  res.status(201).json(db.prepare('SELECT * FROM expenses WHERE id=?').get(info.lastInsertRowid));
}));

r.delete('/expenses/:id', requireAuth, requireRole('admin', 'manager', 'accountant'), h((req, res) => {
  db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
  res.json({ ok: true });
}));

// Admin only: wipe all demo/operational data so the shop starts from scratch.
// Clears inventory, sales, stock movements, purchase orders, customers,
// suppliers, expenses, shifts and employees. User accounts (logins/PINs/
// roles) are left untouched — staff shouldn't have to be recreated just
// because the shop's records were reset. Settings (business profile) are
// left untouched too.
r.post('/maintenance/clear-data', requireAuth, requireRole('admin'), h((req, res) => {
  const tx = db.transaction(() => {
    for (const tbl of [
      'order_items', 'orders', 'stock_movements', 'purchase_orders',
      'products', 'customers', 'suppliers', 'expenses', 'shifts', 'employees',
    ]) {
      db.prepare(`DELETE FROM ${tbl}`).run();
    }
  });
  tx();
  res.json({ ok: true });
}));

// Admin only: a narrower reset than clear-data above — wipes just the
// activity history that feeds the Dashboard (orders, their line items, and
// stock movements) plus the shift clock-in/out log. Products, customers,
// suppliers, expenses, employees, and user accounts are untouched, so this
// is safe to use to start a fresh reporting period without losing the
// shop's actual catalog/roster data.
r.post('/maintenance/clear-activity', requireAuth, requireRole('admin'), h((req, res) => {
  const tx = db.transaction(() => {
    for (const tbl of ['order_items', 'orders', 'stock_movements', 'shifts']) {
      db.prepare(`DELETE FROM ${tbl}`).run();
    }
  });
  tx();
  res.json({ ok: true });
}));

// ---------------- REPORTS ----------------
// Simple aggregations the front-end can render or download.
// `totals` is scoped to TODAY (it powers the Dashboard's "Today's sales" KPI
// — it previously summed every order ever placed, which is a different and
// much larger number than what the label claimed).
r.get('/reports/sales', h((req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const daily = db.prepare(`
    SELECT substr(createdAt,1,10) AS day, COUNT(*) AS orders, COALESCE(SUM(total),0) AS sales
    FROM orders WHERE substr(createdAt,1,10) >= ? GROUP BY day ORDER BY day ASC
  `).all(since);

  const totals = db.prepare(
    'SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue FROM orders WHERE substr(createdAt,1,10) = ?'
  ).get(today);

  // Real category breakdown for the same window (Dashboard's "By category" pie).
  const byCategory = db.prepare(`
    SELECT COALESCE(p.category, 'Other') AS category, COALESCE(SUM(oi.price*oi.qty),0) AS sales
    FROM order_items oi
    JOIN orders o ON o.id = oi.orderId
    LEFT JOIN products p ON p.id = oi.productId
    WHERE substr(o.createdAt,1,10) >= ?
    GROUP BY category ORDER BY sales DESC
  `).all(since);

  res.json({ daily, totals, byCategory });
}));

// Ranks products by actual profit contribution (not just units sold) —
// answers "what's really making money" rather than "what's just busy".
r.get('/reports/profitability', h((req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const rows = db.prepare(`
    SELECT productId, name, sku,
           SUM(qty) AS unitsSold,
           SUM(price*qty) AS revenue,
           SUM(cost*qty) AS cost
    FROM order_items
    WHERE productId IS NOT NULL
    GROUP BY productId
  `).all();
  const ranked = rows.map(r => {
    const grossProfit = r.revenue - r.cost;
    return { ...r, grossProfit, marginPct: r.revenue ? (grossProfit / r.revenue) * 100 : 0 };
  }).sort((a, b) => b.grossProfit - a.grossProfit).slice(0, limit);
  res.json(ranked);
}));

r.get('/reports/inventory', h((req, res) => {
  const products = db.prepare('SELECT name,sku,category,price,cost,stock FROM products ORDER BY stock ASC').all();
  const value = products.reduce((s, p) => s + p.price * p.stock, 0);
  const costValue = products.reduce((s, p) => s + (p.cost || 0) * p.stock, 0);
  const settingsRow = db.prepare('SELECT json FROM settings WHERE id=1').get();
  const threshold = Number(settingsRow ? JSON.parse(settingsRow.json).lowStockThreshold : null) || 10;
  const low = products.filter(p => p.stock < threshold).length;
  res.json({ products, stockValue: value, stockCostValue: costValue, lowStock: low, totalSkus: products.length });
}));

// ---- Accounting: a date-range report powering exports, TVA and margin ----
// Query params: from=YYYY-MM-DD & to=YYYY-MM-DD (inclusive). Defaults to today.
// orders.createdAt is stored as a full ISO timestamp (e.g.
// "2026-06-21T02:55:30.244Z"). The bounds must use the same 'T'/'Z' shape —
// comparing against "YYYY-MM-DD HH:MM:SS" (space-separated) is a string
// comparison where 'T' (0x54) sorts after ' ' (0x20), which makes
// `createdAt <= t` false for every order on the end date and silently drops
// that whole day from every report.
const dayBounds = (from, to) => {
  const today = new Date().toISOString().slice(0, 10);
  const f = (from || today) + 'T00:00:00.000Z';
  const t = (to || from || today) + 'T23:59:59.999Z';
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
  const f = date + 'T00:00:00.000Z', t = date + 'T23:59:59.999Z';
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

// ---- Profit & Loss: combines sales margin with recorded expenses for a
// date range. This is the one number an owner actually thinks in terms of —
// "did I make money" — rather than scattered margin/expense reports. ----
r.get('/reports/pnl', h((req, res) => {
  const { f, t } = dayBounds(req.query.from, req.query.to);
  const fromDate = req.query.from || new Date().toISOString().slice(0, 10);
  const toDate = req.query.to || req.query.from || new Date().toISOString().slice(0, 10);

  const margin = db.prepare(
    `SELECT COALESCE(SUM(oi.price*oi.qty),0) AS revenue, COALESCE(SUM(oi.cost*oi.qty),0) AS cogs
     FROM order_items oi JOIN orders o ON o.id = oi.orderId
     WHERE o.createdAt >= ? AND o.createdAt <= ?`
  ).get(f, t);

  const grossProfit = margin.revenue - margin.cogs;
  const grossMarginPct = margin.revenue ? (grossProfit / margin.revenue) * 100 : 0;

  // expenses.date is a plain YYYY-MM-DD string (from the date input), unlike
  // orders.createdAt which is a full timestamp — compare against the plain
  // from/to dates, not the time-bounded f/t used for orders. One-time
  // 'setup' costs are excluded here on purpose — they're tracked against
  // cumulative profit separately (see /reports/breakeven) instead of
  // distorting whichever single period they happened to be paid in.
  const expensesByCategory = db.prepare(
    `SELECT category, COALESCE(SUM(amount),0) AS amount FROM expenses
     WHERE date >= ? AND date <= ? AND type != 'setup' GROUP BY category ORDER BY amount DESC`
  ).all(fromDate, toDate);
  const totalExpenses = expensesByCategory.reduce((s, e) => s + e.amount, 0);

  const netProfit = grossProfit - totalExpenses;
  const netMarginPct = margin.revenue ? (netProfit / margin.revenue) * 100 : 0;

  res.json({
    from: fromDate, to: toDate,
    revenue: margin.revenue, cogs: margin.cogs, grossProfit, grossMarginPct,
    expensesByCategory, totalExpenses, netProfit, netMarginPct,
  });
}));

// ---- Monthly P&L trend, for a real month-over-month view ----
r.get('/reports/pnl-trend', h((req, res) => {
  const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);
  const rows = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const f = `${monthStr}-01T00:00:00.000Z`;
    const t = `${monthStr}-${String(lastDay).padStart(2, '0')}T23:59:59.999Z`;

    const margin = db.prepare(
      `SELECT COALESCE(SUM(oi.price*oi.qty),0) AS revenue, COALESCE(SUM(oi.cost*oi.qty),0) AS cogs
       FROM order_items oi JOIN orders o ON o.id = oi.orderId
       WHERE o.createdAt >= ? AND o.createdAt <= ?`
    ).get(f, t);
    const expenseTotal = db.prepare(
      "SELECT COALESCE(SUM(amount),0) AS amount FROM expenses WHERE date >= ? AND date <= ? AND type != 'setup'"
    ).get(`${monthStr}-01`, `${monthStr}-${String(lastDay).padStart(2, '0')}`).amount;

    const grossProfit = margin.revenue - margin.cogs;
    rows.push({
      month: monthStr, revenue: margin.revenue, cogs: margin.cogs, grossProfit,
      expenses: expenseTotal, netProfit: grossProfit - expenseTotal,
    });
  }
  res.json(rows);
}));

// ---- Break-even: have we earned back what it cost to set this place up? ----
// totalSetupCost is every expense ever logged with type='setup'. cumulativeNetProfit
// is the SAME net-profit math /reports/pnl uses (gross margin minus operating
// expenses) — but only counting from the day the OLDEST setup expense was
// recorded, onward. A store can have months of real sales history before its
// setup costs ever get logged; counting that pre-existing profit toward
// "recovering" a cost it never actually paid for would make recovery jump to
// 100% the instant the cost is entered, which is exactly backwards from what
// "haven't broken even yet" should mean. Profit only starts counting toward
// payback once there's an actual setup cost on the books to pay back.
r.get('/reports/breakeven', h((req, res) => {
  const setupCost = db.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM expenses WHERE type='setup'").get().amount;
  const earliestSetupDate = db.prepare("SELECT MIN(date) AS d FROM expenses WHERE type='setup'").get().d;
  const since = (earliestSetupDate || '9999-12-31') + 'T00:00:00.000Z';
  const margin = db.prepare(
    `SELECT COALESCE(SUM(oi.price*oi.qty),0) AS revenue, COALESCE(SUM(oi.cost*oi.qty),0) AS cogs
     FROM order_items oi JOIN orders o ON o.id = oi.orderId WHERE o.createdAt >= ?`
  ).get(since);
  const operatingExpenses = db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS amount FROM expenses WHERE type != 'setup' AND date >= ?"
  ).get(earliestSetupDate || '9999-12-31').amount;
  const cumulativeNetProfit = (margin.revenue - margin.cogs) - operatingExpenses;
  const remaining = Math.max(0, setupCost - cumulativeNetProfit);
  res.json({
    setupCost, cumulativeNetProfit, operatingExpenses,
    revenue: margin.revenue, cogs: margin.cogs,
    remaining, brokenEven: setupCost > 0 && cumulativeNetProfit >= setupCost,
    pctRecovered: setupCost > 0 ? Math.max(0, Math.min(100, Math.round((cumulativeNetProfit / setupCost) * 100))) : 0,
  });
}));

export default r;
