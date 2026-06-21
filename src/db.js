// db.js — pure-JavaScript SQLite (no compiler, no Python needed).
//
// We use node-sqlite3-wasm (a WebAssembly build of SQLite) and wrap it so the
// rest of the project keeps using the familiar better-sqlite3 style API:
//   db.prepare(sql).run(...args) / .get(...args) / .all(...args)
//   db.exec(sql)
//   db.transaction(fn)
//   db.pragma(...)   (no-op shim)
//
// This means seed.js and routes/api.js did NOT have to change.
import pkg from 'node-sqlite3-wasm';
const { Database: WasmDatabase } = pkg;
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');

const raw = new WasmDatabase(DB_PATH);

// Normalise BigInt (wasm returns BigInt for row ids) back to Number.
const fix = (v) => (typeof v === 'bigint' ? Number(v) : v);
const fixRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  for (const k of Object.keys(row)) row[k] = fix(row[k]);
  return row;
};
// better-sqlite3 lets you pass args either spread (a, b, c) or as one array/object.
// For named parameters the code uses @name in the SQL and a plain {name: ...} object.
// node-sqlite3-wasm looks up each object key as the FULL parameter name, so the key
// must include the '@' prefix to match the @name placeholders. We add that prefix.
const norm = (args) => {
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    const obj = args[0];
    const out = {};
    for (const k of Object.keys(obj)) {
      // If the key already starts with a binding sigil, leave it; otherwise prefix '@'.
      const key = /^[@:$]/.test(k) ? k : '@' + k;
      out[key] = obj[k];
    }
    return out;
  }
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args.length ? args : undefined;
};

// A prepared-statement wrapper matching better-sqlite3's surface.
class Stmt {
  constructor(sql) { this.sql = sql; }
  run(...args) {
    const info = raw.run(this.sql, norm(args));
    return { changes: fix(info.changes), lastInsertRowid: fix(info.lastInsertRowid) };
  }
  get(...args) { return fixRow(raw.get(this.sql, norm(args))); }
  all(...args) { return (raw.all(this.sql, norm(args)) || []).map(fixRow); }
}

export const db = {
  prepare: (sql) => new Stmt(sql),
  exec: (sql) => { raw.exec(sql); },
  pragma: () => {},                       // pragmas are optional; ignore safely
  transaction: (fn) => {
    // Return a function that runs fn() wrapped in BEGIN/COMMIT, rolling back on error.
    return (...a) => {
      raw.exec('BEGIN');
      try { const r = fn(...a); raw.exec('COMMIT'); return r; }
      catch (e) { try { raw.exec('ROLLBACK'); } catch {} throw e; }
    };
  },
  close: () => raw.close(),
};

// ---- Schema (unchanged) ----
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  name_fr   TEXT,
  category  TEXT NOT NULL,
  price     INTEGER NOT NULL,
  cost      INTEGER NOT NULL DEFAULT 0,
  discount  INTEGER NOT NULL DEFAULT 0,
  stock     INTEGER NOT NULL DEFAULT 0,
  sku       TEXT UNIQUE NOT NULL,
  emoji     TEXT DEFAULT '📦',
  image     TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL,
  phone  TEXT,
  points INTEGER DEFAULT 0,
  tier   TEXT DEFAULT 'Bronze',
  visits INTEGER DEFAULT 0,
  spent  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS suppliers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  contact       TEXT,
  phone         TEXT,
  email         TEXT,
  productsCount INTEGER DEFAULT 0,
  lastOrder     TEXT,
  status        TEXT DEFAULT 'active',
  category      TEXT
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id         TEXT PRIMARY KEY,
  supplierId INTEGER,
  supplier   TEXT,
  date       TEXT,
  items      INTEGER DEFAULT 0,
  total      INTEGER DEFAULT 0,
  status     TEXT DEFAULT 'draft'
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  productName TEXT,
  type        TEXT,
  qty         INTEGER,
  source      TEXT,
  date        TEXT,
  user        TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  username   TEXT UNIQUE,
  role       TEXT DEFAULT 'cashier',
  email      TEXT UNIQUE,
  lastActive TEXT,
  store      TEXT,
  pin_hash   TEXT,
  pin_salt   TEXT
);

CREATE TABLE IF NOT EXISTS employees (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  role     TEXT,
  initials TEXT,
  color    TEXT,
  rate     INTEGER DEFAULT 1000
);

CREATE TABLE IF NOT EXISTS shifts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  employeeId   INTEGER,
  name         TEXT,
  role         TEXT,
  clockIn      TEXT,
  clockOut     TEXT,
  expectedCash INTEGER,
  countedCash  INTEGER,
  cashVariance INTEGER,
  clockInPhoto TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  invoiceNo TEXT UNIQUE,
  customerId INTEGER,
  subtotal  INTEGER,
  discount  INTEGER,
  tva       INTEGER,
  total     INTEGER,
  method    TEXT,
  cashier   TEXT,
  createdAt TEXT,
  clientOrderId TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId   INTEGER,
  productId INTEGER,
  name      TEXT,
  sku       TEXT,
  price     INTEGER,
  cost      INTEGER DEFAULT 0,
  qty       INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  date      TEXT NOT NULL,
  category  TEXT,
  payee     TEXT,
  amount    INTEGER NOT NULL DEFAULT 0,
  method    TEXT,
  note      TEXT,
  createdBy TEXT,
  createdAt TEXT,
  clientId  TEXT
);
`);

// ---- Migrations for databases created before a column existed ----
// Adds the products.image column if an older data.db is missing it.
// Safe to run every boot: we check first and ignore "duplicate column" errors.
try {
  const cols = db.prepare('PRAGMA table_info(products)').all();
  if (!cols.some((c) => c.name === 'image')) {
    db.exec('ALTER TABLE products ADD COLUMN image TEXT');
    console.log('• Migrated: added products.image column');
  }
} catch (e) {
  console.warn('image-column migration skipped:', e.message);
}

// Ensure the users table has username + PIN columns on older databases.
try {
  const ucols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!ucols.includes('pin_hash')) db.exec('ALTER TABLE users ADD COLUMN pin_hash TEXT');
  if (!ucols.includes('pin_salt')) db.exec('ALTER TABLE users ADD COLUMN pin_salt TEXT');
  if (!ucols.includes('username')) db.exec('ALTER TABLE users ADD COLUMN username TEXT');
} catch (e) {
  console.warn('users-column migration skipped:', e.message);
}

// Ensure cost columns exist for margin tracking on older databases.
try {
  const pcols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
  if (!pcols.includes('cost')) db.exec('ALTER TABLE products ADD COLUMN cost INTEGER NOT NULL DEFAULT 0');
  if (!pcols.includes('discount')) db.exec('ALTER TABLE products ADD COLUMN discount INTEGER NOT NULL DEFAULT 0');
  const ocols = db.prepare('PRAGMA table_info(order_items)').all().map(c => c.name);
  if (!ocols.includes('cost')) db.exec('ALTER TABLE order_items ADD COLUMN cost INTEGER DEFAULT 0');
} catch (e) {
  console.warn('cost-column migration skipped:', e.message);
}

// Ensure orders.clientOrderId exists (lets a retried/offline-queued checkout
// be deduplicated instead of creating a second sale) and is unique.
try {
  const ordcols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
  if (!ordcols.includes('clientOrderId')) db.exec('ALTER TABLE orders ADD COLUMN clientOrderId TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_clientOrderId ON orders(clientOrderId)');
} catch (e) {
  console.warn('clientOrderId migration skipped:', e.message);
}

// Same idempotency mechanism as orders, for offline-queued expense entries.
try {
  const expcols = db.prepare('PRAGMA table_info(expenses)').all().map(c => c.name);
  if (!expcols.includes('clientId')) db.exec('ALTER TABLE expenses ADD COLUMN clientId TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_clientId ON expenses(clientId)');
} catch (e) {
  console.warn('expenses clientId migration skipped:', e.message);
}

// Per-shift cash reconciliation columns, for accountability at clock-out.
try {
  const shcols = db.prepare('PRAGMA table_info(shifts)').all().map(c => c.name);
  if (!shcols.includes('expectedCash')) db.exec('ALTER TABLE shifts ADD COLUMN expectedCash INTEGER');
  if (!shcols.includes('countedCash')) db.exec('ALTER TABLE shifts ADD COLUMN countedCash INTEGER');
  if (!shcols.includes('cashVariance')) db.exec('ALTER TABLE shifts ADD COLUMN cashVariance INTEGER');
  if (!shcols.includes('clockInPhoto')) db.exec('ALTER TABLE shifts ADD COLUMN clockInPhoto TEXT');
} catch (e) {
  console.warn('shifts cash-reconciliation migration skipped:', e.message);
}

// Accounts-payable columns on purchase orders: a due date and how much of
// the total has been paid so far (outstanding = total - amountPaid).
try {
  const pocols = db.prepare('PRAGMA table_info(purchase_orders)').all().map(c => c.name);
  if (!pocols.includes('dueDate')) db.exec('ALTER TABLE purchase_orders ADD COLUMN dueDate TEXT');
  if (!pocols.includes('amountPaid')) db.exec('ALTER TABLE purchase_orders ADD COLUMN amountPaid INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  console.warn('purchase_orders AP migration skipped:', e.message);
}

// Payment history against purchase orders (accounts-payable ledger).
db.exec(`
CREATE TABLE IF NOT EXISTS po_payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  purchaseOrderId TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  method          TEXT,
  note            TEXT,
  createdBy       TEXT,
  createdAt       TEXT
);
`);

export default db;
