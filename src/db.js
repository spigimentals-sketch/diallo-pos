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
  // whatsapp: for the WhatsApp-notification feature (payslip/notice PDFs).
  // hourlyRate: used to compute payslip totals from actual shift hours.
  if (!ucols.includes('whatsapp')) db.exec('ALTER TABLE users ADD COLUMN whatsapp TEXT');
  if (!ucols.includes('hourlyRate')) db.exec('ALTER TABLE users ADD COLUMN hourlyRate INTEGER DEFAULT 0');
} catch (e) {
  console.warn('users-column migration skipped:', e.message);
}

// Ensure cost columns exist for margin tracking on older databases.
try {
  const pcols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
  if (!pcols.includes('cost')) db.exec('ALTER TABLE products ADD COLUMN cost INTEGER NOT NULL DEFAULT 0');
  if (!pcols.includes('discount')) db.exec('ALTER TABLE products ADD COLUMN discount INTEGER NOT NULL DEFAULT 0');
  if (!pcols.includes('grade')) db.exec('ALTER TABLE products ADD COLUMN grade TEXT');
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

// 'operating' (rent, utilities, salaries — the regular running costs that
// reduce P&L) vs 'setup' (one-time pre-opening/startup costs the owner is
// trying to recoup, tracked separately against cumulative net profit
// instead of distorting any single period's P&L). Existing rows predate
// this distinction and default to 'operating'.
try {
  const expcols = db.prepare('PRAGMA table_info(expenses)').all().map(c => c.name);
  if (!expcols.includes('type')) {
    db.exec("ALTER TABLE expenses ADD COLUMN type TEXT NOT NULL DEFAULT 'operating'");
  }
} catch (e) {
  console.warn('expenses type migration skipped:', e.message);
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

// Product categories. id is the slug used everywhere else (products.category,
// checkout filters, Home page cards); label is what's actually shown/typed.
db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id    TEXT PRIMARY KEY,
  label TEXT NOT NULL
);
`);

// Backfill the 7 built-in categories once. Not gated behind seedIfEmpty —
// that skips entirely on any already-initialized database, which is every
// real deployment after its first boot, so this needs to run independently
// to reach databases that existed before this table did.
try {
  const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (count === 0) {
    const defaults = [
      ['cosmetics', 'Cosmetics'], ['wines', 'Wines'], ['whiskey', 'Whiskey'],
      ['school_materials', 'School materials'], ['perfumes', 'Perfumes'],
      ['icecream', 'Ice cream'], ['shawarma', 'Shawarma'],
    ];
    const ins = db.prepare('INSERT INTO categories (id, label) VALUES (?, ?)');
    defaults.forEach(([id, label]) => ins.run(id, label));
    console.log('• Seeded default categories');
  }
} catch (e) {
  console.warn('categories backfill skipped:', e.message);
}

// One-time correction: the seeded business name used to read "Diallo
// Supermarché" (only the company name capitalized like a regular word).
// Brand style is now "DIALLO" in caps with "Supermarché" in normal word
// case. Only overwrites it if it's still exactly the old default — a shop
// that already customized this in Settings keeps whatever they typed.
try {
  const row = db.prepare('SELECT json FROM settings WHERE id=1').get();
  if (row) {
    const parsed = JSON.parse(row.json);
    if (parsed.businessName === 'Diallo Supermarché') {
      parsed.businessName = 'DIALLO Supermarché';
      db.prepare('UPDATE settings SET json=? WHERE id=1').run(JSON.stringify(parsed));
      console.log('• Migrated: businessName casing to "DIALLO Supermarché"');
    }
  }
} catch (e) {
  console.warn('businessName casing migration skipped:', e.message);
}

// Supplier credit ledger — tracks goods taken on credit and payments made.
db.exec(`
CREATE TABLE IF NOT EXISTS supplier_credits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  supplierId  INTEGER NOT NULL,
  supplier    TEXT    NOT NULL,
  amount      REAL    NOT NULL,
  note        TEXT,
  date        TEXT    NOT NULL,
  createdAt   TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS supplier_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  supplierId  INTEGER NOT NULL,
  supplier    TEXT    NOT NULL,
  amount      REAL    NOT NULL,
  note        TEXT,
  date        TEXT    NOT NULL,
  createdAt   TEXT    NOT NULL
);
`);

// Discount approval requests — cashier submits, manager approves/rejects.
db.exec(`
CREATE TABLE IF NOT EXISTS discount_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cashier     TEXT    NOT NULL,
  cashierId   INTEGER,
  items       TEXT    NOT NULL,
  subtotal    REAL    NOT NULL,
  discountAmt REAL    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',
  note        TEXT,
  createdAt   TEXT    NOT NULL,
  resolvedAt  TEXT,
  resolvedBy  TEXT
);
`);

// School materials catalogue — 137 textbooks and workbooks extracted from the
// shop's supplier list. Seeded once on first boot; guarded by sentinel SKU
// SCH-001 so restarts never create duplicates. Prices and stock start at 0
// so the owner can fill them in via the Inventory screen.
// WB = workbook (📓), TB = textbook (📚).
try {
  const alreadySeeded = db.prepare("SELECT COUNT(*) AS n FROM products WHERE sku='SCH-001'").get().n > 0;
  if (!alreadySeeded) {
    // [name, grade, isWorkbook]
    const BOOKS = [
      // ── NMI Winners Primary ──
      ['Winners in English Class 1 (NMI)',              'CE1',       false],
      ['Winners in English Class 1 WB (NMI)',           'CE1',       true ],
      ['Winners in ICT Level 1 (NMI)',                  'CE1',       false],
      ['Winners in English Class 2 (NMI)',              'CE2',       false],
      ['Winners in English Class 2 WB (NMI)',           'CE2',       true ],
      ['Winners in Mathematics Class 2 (NMI)',          'CE2',       false],
      ['Winners in Mathematics Class 2 WB (NMI)',       'CE2',       true ],
      ['Winners in English Class 3 (NMI)',              'CM1',       false],
      ['Winners in English Class 3 WB (NMI)',           'CM1',       true ],
      ['Winners in English Class 4 (NMI)',              'CM2',       false],
      ['Winners in English Class 4 WB (NMI)',           'CM2',       true ],
      ['Winners in Social Studies Class 4 (NMI)',       'CM2',       false],
      ['Winners in Science & Tech Class 5 (NMI)',       '6ème',      false],
      ['Winners in Social Studies Class 6 (NMI)',       '5ème',      false],
      // ── NMI Brillants ──
      ['Les Brillants en Anglais CP Livret (NMI)',      'CP',        true ],
      ['Les Brillants en Anglais CE2 Livret (NMI)',     'CE2',       true ],
      ['Brillants Anglais CE2 (NMI)',                   'CE2',       false],
      // ── NMI Prime Secondary ──
      ['Prime English Book 1 (NMI)',                    '6ème',      false],
      ['Prime Physics Book 1 (NMI)',                    '6ème',      false],
      ['Prime English Book 2 (NMI)',                    '5ème',      false],
      ['A Pen Kills, Literature Form 3 (NMI)',          '4ème',      false],
      ['Prime Mathematics Book 3 (NMI)',                '4ème',      false],
      ['Prime Computer Science Book 3 (NMI)',           '4ème',      false],
      ['Prime Mathematics Book 4 & 5 (NMI)',            '3ème',      false],
      ['Prime English Book 4 (NMI)',                    '3ème',      false],
      ['Prime Physics O Level Book 5 (NMI)',            '2nde',      false],
      ['Mastering English Lower and Upper Sixth (NMI)', '1ère',      false],
      // ── NMI L\'Eveil ──
      ["L'Eveil Informatique 5ème (NMI)",               '5ème',      false],
      ["Erwachen l'Eveil Deutsch 4ème (NMI)",           '4ème',      false],
      ["L'Eveil Physique Chimie et Technologie 4ème (NMI)", '4ème', false],
      ["Erwachen l'Eveil Deutsch 3ème (NMI)",           '3ème',      false],
      ["L'Eveil Anglais 3ème (NMI)",                    '3ème',      false],
      // ── NMI L\'Excellence ──
      ["L'Excellence en Philosophie 2nde (NMI)",        '2nde',      false],
      ["L'Excellence en Informatique 2nde A et C (NMI)",'2nde',      false],
      ["L'Excellence en SVT 1ère C (NMI)",              '1ère',      false],
      ["L'Excellence en Physique 1ère D et C (NMI)",    '1ère',      false],
      ["L'Excellence en Chimie 1ère D et C (NMI)",      '1ère',      false],
      ["L'Excellence en Chimie Tle C et D (NMI)",       'Terminale', false],
      // ── Afric Educ ──
      ['How Are You Benjamin? (Africa Education)',       'CE1',       false],
      ['Benjamin is Not a Little Boy (Afric Educ)',      'CE1',       false],
      ['Littérature CE1: Comment ca va Benjamin (Afric Educ)', 'CE1', false],
      ['Je Pratique le Dessin et le Coloriage 1 (Afric Educ)', 'Maternelle', false],
      ['Je Pratique le Dessin et le Coloriage 2 (Afric Educ)', 'CP',  false],
      ['Syllabaire SIL-CP (Afric Educ)',                 'CP',        false],
      ['Mathématique Livret CM2 (Afric Educ)',            'CM2',       true ],
      ['French Class 3 (Afric Educ)',                    '4ème',      false],
      ['French Class 4 Livret (Afric Educ)',             '3ème',      true ],
      ['French Class 5 (Afric Educ)',                    '2nde',      false],
      ['French Class 5 Livret WB (Afric Educ)',          '2nde',      true ],
      ['French Class 6 (Afric Educ)',                    '1ère',      false],
      ['Anglais 6ème (Afric Educ)',                      '6ème',      false],
      ['Sciences 6ème (Afric Educ)',                     '6ème',      false],
      ['Français 5ème (Afric Educ)',                     '5ème',      false],
      ['Francais 4ème (Afric Educ)',                     '4ème',      false],
      ['Francais 3ème (Afric Educ)',                     '3ème',      false],
      ['Mathématiques 3ème (Afric Educ)',                '3ème',      false],
      ['SVTEEHB 3ème (Afric Educ)',                      '3ème',      false],
      ['Mathématiques 4ème (Afric Educ)',                '4ème',      false],
      ['French Form 5 (Afric Educ)',                     '2nde',      false],
      ['Computer Science Form 5 (Afric Educ)',           '2nde',      false],
      // ── Nathan ──
      ['A Vos Maths SIL (Nathan)',                       'Maternelle',false],
      ['A Vos Maths Livret SIL (Nathan)',                'Maternelle',true ],
      ['Vivons Ensemble SIL/CP (Nathan)',                 'CP',        false],
      ['A Vos Maths CP (Nathan)',                         'CP',        false],
      ['A Vos Maths Livret CP (Nathan)',                  'CP',        true ],
      ['Francais CE1 (Nathan)',                           'CE1',       false],
      ['Mathématiques CE2 (Nathan)',                      'CE2',       false],
      ['Mathématiques CM1 (Nathan)',                      'CM1',       false],
      ['Francais 6ème (Nathan)',                          '6ème',      false],
      // ── Anucam ──
      ["J'Apprends le Français Livre 2 (Anucam)",        'CE2',       false],
      ['Apprenons le Français A/L (Anucam)',              'CE1',       false],
      // ── Atemec ──
      ['Sound and Word Building Level 2 (Atemec)',        'CE2',       false],
      ['Mathematics WB Class 3 (Atemec)',                 'CM1',       true ],
      // ── ASVA ──
      ['Majors en Activités de Langage Maternelle 2ème Année (ASVA)', 'Maternelle', false],
      ['Majors en Sciences SIL (ASVA)',                   'Maternelle',false],
      ['Majors en Sciences CP (ASVA)',                    'CP',        false],
      ['English CM1 (ASVA)',                              'CM1',       false],
      ['English WB CM1 (ASVA)',                           'CM1',       true ],
      ['Majors en Mathématique 1ère A (ASVA)',            '1ère',      false],
      ['Majors en Philosophie Tle SES (ASVA)',            'Terminale', false],
      ['Majors en Mathématique Tle A (ASVA)',             'Terminale', false],
      // ── Cosmos ──
      ['Mon Cahier de Graphisme CP (Cosmos)',             'CP',        true ],
      ['Anglais CE1 (Cosmos)',                            'CE1',       false],
      ['Sciences et Technologies CM2 (Cosmos)',           'CM2',       false],
      // ── Edicef ──
      ['Champions en Francais CP Livret (Edicef)',        'CP',        true ],
      ['His/Géo Sciences Humaines CM1 (Edicef)',          'CM1',       false],
      ['Planète Cameroun Géographie 6e/1e Annee New (Edicef)', '6ème', false],
      ['Planète Cameroun Géographie 5e/2e Annee New (Edicef)', '5ème', false],
      ['Planète Cameroun Géographie 4e/3e Annee New (Edicef)', '4ème', false],
      // ── CLE ──
      ['Sciences Secondes Littéraires (CLE)',             '2nde',      false],
      ['Sciences 1ère Littéraires (CLE)',                 '1ère',      false],
      ['SVT Tle D et TI (CLE)',                           'Terminale', false],
      ['The Lady with a Beard (CLE)',                     '4ème',      false],
      // ── Betcha / Betchacam ──
      ['Mathematics Class 5 (Betcha)',                    '6ème',      false],
      ['English WB Class 6 (Betchacam)',                  '5ème',      true ],
      ['English Language Class 6 (Betcha)',               '5ème',      false],
      ['Mathematics Class 6 (Betcha)',                    '5ème',      false],
      ['Mathematics WB Class 6 (Bechacam)',               '5ème',      true ],
      // ── Mondoux ──
      ['TIC Niveau 3 CM1-CM2 (Mondoux)',                  'CM1',       false],
      ['Education à la Citoyenneté 6e/5e et 1e/2e Annee New (Mondoux)', '6ème', false],
      ['Mathématiques 6e (Mondoux)',                      '6ème',      false],
      ['SVTEEHB 4ème (Mondoux)',                          '4ème',      false],
      ['French Form 1 (Mondoux)',                         '6ème',      false],
      ['French Form 2 (Mondoux)',                         '5ème',      false],
      ['French Form 4 (Mondoux)',                         '3ème',      false],
      ['Innovative in English Book 3 (Mondoux)',          '4ème',      false],
      // ── Various publishers ──
      ['Integrated Secondary Mathematics Form 2 (Shiloh)','5ème',      false],
      ['Success in Commerce for Form 3, 4 and 5',         '4ème',      false],
      ['Introductory Ordinary Level Physics Form 3 (Grace)', '4ème',  false],
      ['Elementary Chemistry Forms 1 (Tewa)',             '6ème',      false],
      ['Elementary Mathematics N2 (Dove)',                '2nde',      false],
      ['The Essentials of Logic for Ordinary Level Forms 3, 4 & 5 (Grassroots)', '4ème', false],
      ["Geography for Competency Dev't Book 1 New 3rd Ed. (Greenworld)", '6ème', false],
      ['The Patriotic Citizen Book 1 (Greenworld)',        '6ème',      false],
      ["Geography for Competency Dev't Book 2 New 3rd Ed. (Greenworld)", '5ème', false],
      ['Understanding Biology for Intermediate Form 3 New 2nd Ed. (Greenworld)', '4ème', false],
      ['Understanding Biology Form 4&5 Vol 1 New 4th Ed. (Greenworld)', '3ème', false],
      ['Understanding Biology for Human Biology New Forms 4&5 Vol 2 (Greenworld)', '3ème', false],
      ['Citizenship Education Form 3 (Catwa)',            '4ème',      false],
      ['Economics for GCE O Level and ITVE Forms 3, 4, 5 (Catwa)', '4ème', false],
      ['Basic Geology for Colleges Form 4 and 5 (Tewa)',  '3ème',      false],
      ['Coeur du Sahel, Littérature 4ème (Proximité)',    '4ème',      false],
      ["L'art de Partager un Mari (Proximité)",           '4ème',      false],
      ["L'Attachement au Sol Natal Littérature 4e (Ifrikiya)", '4ème', false],
      ['Mathématiques 1ère D&TI (Ceper)',                 '1ère',      false],
      ['English WB Class 5 (Longhorn)',                   '6ème',      true ],
      ['Physics for Secondary Schools Form 2 (Longhorn)', '5ème',      false],
      ['Integrated Secondary Chemistry Form 2 (Dominion)','5ème',      false],
      ['Standard Ordinary Level Physics (Dominion)',       '3ème',      false],
      ['An Integrated History Since 1850 For G.C.E. O Level 3, 4 & 5 (Quality Print)', '4ème', false],
      ['Science and Technology Class 6 (Catwa)',          '5ème',      false],
      ['Fireside Tales (Peng Edition)',                   '4ème',      false],
      ['A Time to Reconcile, Literature Form 2 (Peacock)','5ème',      false],
      ['My Cameroon & Other Poems (Peng Edition)',        '3ème',      false],
      ['Inclusive Education, Literature Form 3 (Nyaa)',   '4ème',      false],
      ['Macbeth (New Swan Edition)',                       '3ème',      false],
      ['Lord of the Flies (Grace)',                       '3ème',      false],
    ];
    const ins = db.prepare(
      'INSERT INTO products (name,name_fr,category,grade,price,cost,discount,stock,sku,emoji,image) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    );
    const seedAll = db.transaction(() => {
      BOOKS.forEach(([name, grade, wb], i) => {
        const sku = `SCH-${String(i + 1).padStart(3, '0')}`;
        ins.run(name, '', 'school_materials', grade, 0, 0, 0, 0, sku, wb ? '📓' : '📚', null);
      });
    });
    seedAll();
    console.log(`• Seeded ${BOOKS.length} school materials (textbooks & workbooks)`);
  }
} catch (e) {
  console.warn('school materials seed skipped:', e.message);
}

// ── Invoice price/cost update (Horeb Solutions, 29 Jul 2026) ─────────────────
// unit price  → selling price;  total FCFA (after supplier discount) → cost
// Guarded by migrations table so it only runs once.
try {
  db.exec("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)");
  const done = db.prepare("SELECT name FROM migrations WHERE name='invoice_prices_2026_07_29'").get();
  if (!done) {
    // [name-from-invoice, unit_price, carton_total]
    const INV = [
      // ── Page 1 ─────────────────────────────────────────────────────────────
      ['His/Géo Sciences Humaines CM1 (EDICEF)',                                  1850, 14800],
      ['Planete Cameroun Geographie 6e/1e Annee New (Edicef)',                    4200, 16800],
      ['Planete Cameroun Geographie 5e/2e Annee New (Edicef)',                    4300,  6880],
      ['Planete Cameroun Geographie 4e/3e Annee New (Edicef)',                    4300, 17200],
      ['Sciences Secondes Littéraires (CLE)',                                     3500, 14000],
      ['Sciences 1ere Littéraires (CLE)',                                         5000, 20000],
      ['SVT Tle D et TI (CLE)',                                                   8000, 32000],
      ['The Lady with a beard (CLE)',                                              2500, 10000],
      ['Mathematics Class 5 (BETCHA)',                                             1900, 15200],
      ['English wb Class 6 (BETCHACAM)',                                           1150,  9775],
      ['English Language Class 6 (BETCHA)',                                        1900, 15200],
      ['Mathematics Class 6 (BETCHA)',                                             1900, 15200],
      ['Mathematics wb Class 6 (BECHACAM)',                                        1150,  9775],
      ['TIC Niveau 3 CM1-CM2 (Mondoux)',                                           1800, 14400],
      ['Education a la Citoyennete 6e/5e et 1e/2e Anne New (Mondoux)',             3500, 14000],
      ['Mathématiques 6e (Mondoux)',                                               4000, 32000],
      ['SVTEEHB 4eme (Mondoux)',                                                   4000, 32000],
      ['French Form 1 (Mondoux)',                                                  3600, 28800],
      ['French Form 2 (Mondoux)',                                                  3500, 28000],
      ['Innovative in English Book 3 (Mondoux)',                                   3600, 28800],
      // ── Page 2 ─────────────────────────────────────────────────────────────
      ['A Vos Maths Livret CP (NATHAN)',                                           1250, 10000],
      ['Francais CE1 (NATHAN)',                                                    1800, 14400],
      ['Mathematiques CE2 (NATHAN)',                                               1800, 14400],
      ['Mathématiques CM1 (NATHAN)',                                               1900, 15200],
      ['Francais 6eme (NATHAN)',                                                   4200, 33600],
      ["J'Apprends le Français Livre 2 (ANUCAM)",                                 1800, 14400],
      ['Apprenons le Français A/L (ANUCAM)',                                       4000,  6000],
      ['Sound and Word Building Level 2 (ATEMEC)',                                 1500, 12000],
      ['Mathematics wb Class 3 (ATEMEC)',                                          1150,  9775],
      ['Majors en activités de langage Maternelle 2ème année (ASVA)',              1000,  7500],
      ['Majors en Sciences SIL (ASVA)',                                            1500, 12000],
      ['Majors en Sciences CP (ASVA)',                                             1500, 11550],
      ['English CM1 (ASVA)',                                                       1900, 15200],
      ['English wb CM1 (ASVA)',                                                    1150,  9775],
      ['Majors en Mathématique 1ere A (ASVA)',                                     3500, 13475],
      ['Majors en Philosophie Tle SES (ASVA)',                                     5000,  7700],
      ['Majors en Mathématique Tle A (ASVA)',                                      3900, 15015],
      ['Mon Cahier de Graphisme CP (COSMOS)',                                      1200,  9600],
      ['Anglais CE1 (COSMOS)',                                                     1800, 14400],
      ['Sciences et technologies CM2 (COSMOS)',                                    1800, 14400],
      ['Champions en Francais CP Livret (Edicef)',                                 1300, 10140],
      // ── Page 3 ─────────────────────────────────────────────────────────────
      ['Syllabaire SIL-CP (Afric Educ)',                                           1500, 12000],
      ['Mathematiques 4eme (Afric Educ)',                                          4500, 36000],
      ['Coeur du Sahel. Litterature 4eme (Proximite)',                             2500, 20000],
      ["L'art de Partager un Mari (PROXIMITE)",                                    3000,  7200],
      ["L'Attachement au Sol Natal Litterature 4e 4ed (IFRIKIYA)",                 1900, 15200],
      ['Mathématiques 1ère D&TI (CEPER)',                                          5500, 22000],
      ['English wb Class 5 (LONGHORN)',                                            1150,  9775],
      ['Physics for Secondary Schools Form 2 (LONGHORN)',                          3500, 28000],
      ['Integrated Secondary Chemistry Form 2 (DOMINION)',                         3000, 24000],
      ['An Integrated History Since 1850 For G.C.E. O Level 3, 4 & 5 (Quality Print)', 6000, 45000],
      ['Standard Ordinary Level Physics (DOMINION)',                               5000, 20000],
      ['Science and Technology Class 6 (CATWA)',                                   1800, 14400],
      ['Fireside Tales (PENG Edition)',                                             2000, 16000],
      ['A Time to Reconcile Litterature form 2 (PEACOCK)',                         1200,  9600],
      ['My Cameroon & Other Poems (PENG Edition)',                                 1800, 14400],
      ['Inclusive Education, Literature form 3 (NYAA)',                            1800, 14400],
      ['Macbeth (New Swan Edith)',                                                  2000, 15000],
      ['Lord of the Flies (GRACE)',                                                 2000,  8000],
      // ── Page 4 ─────────────────────────────────────────────────────────────
      ['French Form 4 (Mondoux)',                                                   3500, 28000],
      ['Integrated Secondary Mathematics Form 2 (SHILOH)',                          3500, 28000],
      ['Success in Commerce for Form 3, 4 and 5',                                  7000, 56000],
      ['Introductory Ordinary Level Physics Form 3 (GRACE)',                        4500,  7200],
      ['Elementary Chemistry Forms 1 (TEWA)',                                       3000, 24000],
      ['Elementary Mathematics N2 (DOVE)',                                          1000,  8000],
      ['The Essentials of Logic for Ordinary Level Forms 3, 4 & 5 (Grassroots)',   2500, 19250],
      ["Geography for Competency Dev't Book 1 New 3rd ed. (GREENWORLD)",            3000, 24000],
      ['The Patriotic Citizen Book 1 (GREENWORLD)',                                  4000, 32000],
      ["Geography for Competency Dev't Book 2 New 3rd ed. (GREENWORLD)",            4000, 32000],
      ['Understanding Biology for Intermediate Form 3 New 2nd ed. (GREENWORLD)',    6500, 52000],
      ['Understanding Biology Form 4&5 Vol 1 New 4th ed. (GREENWORLD)',             8000, 64000],
      ['Understanding Biology for Human Biology New Forms 4&5 Vol 2 (GREENWORLD)',  6500, 52000],
      ['Citizenship Education Form 3 (CATWA)',                                      3000, 24000],
      ['Economics For GCE O Level and ITVE Forms 3, 4 & 5 (CATWA)',               7000, 56000],
      ['Basic Geology for Colleges Form 4 and 5 (TEWA)',                            5000, 40000],
      // ── Page 5 (NMI — ISBN prefixes stripped by norm()) ────────────────────
      ['Winners in English Class 4 wb (NMI)',                                       1150,  9660],
      ['Winners in Social Studies Class 4 (NMI)',                                   1800, 14400],
      ['Winners in Science & Tech Class 5 (NMI)',                                   1800, 11520],
      ['Winners in Social Studies Class 6 (NMI)',                                   1850, 14800],
      ['Les Brillants en Anglais CP Livret (NMI)',                                  1200, 10080],
      ['Les Brillants en Anglais CE2 Livret (NMI)',                                 1150,  9660],
      ['Brillants Anglais CE2 (NMI)',                                               1800, 14400],
      ['Prime English Book 1 (NMI)',                                                3800, 30400],
      ['Prime Physics Book 1 (NMI)',                                                3200, 25600],
      ['Prime English Book 2 (NMI)',                                                3800, 30400],
      ['A Pen Kills, Litterature Form 3 (NMI)',                                     2500, 20000],
      ['Prime Mathematics Book 3 (NMI)',                                            4200, 33600],
      ['Prime Computer Science Book 3 (NMI)',                                       4000, 32000],
      ['Prime Mathematics Book 4 (NMI)',                                            5500, 44000],
      ['Prime English Book 4 (NMI)',                                                4200, 33600],
      ['Prime Physics O Level Book 5 (NMI)',                                        5000, 20000],
      // ── Page 6 (Afric Educ / Nathan) ───────────────────────────────────────
      ['French Class 5 (Afric Educ)',                                               1900, 15200],
      ['Je pratique le dessin et le coloriage 1 (Afric Educ)',                      1000,  8000],
      ['Je pratique le dessin et le coloriage 2 (Afric Educ)',                      1000,  8000],
      ['Litterature CE 1: Comment ca va Benjamin (Afric Educ)',                     1000,  8000],
      ['Mathematique Livret CM2 (Afric Educ)',                                      1200, 10200],
      ['French form 5 (Afric Educ)',                                                4000, 32000],
      ['Computer science form 5 (Afric Educ)',                                      5000, 40000],
      ['Anglais 6eme (Afric Educ)',                                                 5000, 40000],
      ['Sciences 6eme (Afric Educ)',                                                5000, 40000],
      ['Français 5eme (Afric Educ)',                                                4500, 36000],
      ['Francais 4eme (Afric Educ)',                                                5000, 40000],
      ['Francais 3eme (Afric Educ)',                                                5000, 40000],
      ['Mathematiques 3eme (Afric Educ)',                                           4500, 36000],
      ['SVTEEHB 3eme (Afric Educ)',                                                 5000, 40000],
      ['A Vos Maths sil (NATHAN)',                                                  1500, 11250],
      ['A Vos Maths Livret SIL (NATHAN)',                                           1000,  8000],
      ['Vivons Ensemble (sil/cp) (NATHAN)',                                         1500, 11550],
      ['A Vos Maths CP (NATHAN)',                                                   1500, 11250],
      // ── Page 7 (NMI advanced) ───────────────────────────────────────────────
      ['Mastering English Lower and Upper Sixth (NMI)',                             5500,  8800],
      ["L'Eveil Informatique 5ème (NMI)",                                           4000, 32000],
      ["Erwachen l'Eveil Deutsch 4ème (NMI)",                                       4500, 36000],
      ["L'Eveil Physique Chimie et Technologie 4ème (NMI)",                         4200, 33600],
      ["Erwachen l'Eveil Deutsch 3ème (NMI)",                                       4500, 36000],
      ["L'Eveil Anglais 3ème (NMI)",                                                4500, 36000],
      ["L'Excellence en Philosophie 2nde (NMI)",                                    4000, 32000],
      ["L'Excellence en Informatique 2nde A et C (NMI)",                            3100, 24800],
      ["L'Excellence en SVT 1ère C (NMI)",                                          6500, 52000],
      ["L'Excellence en Physique 1ère D et C (NMI)",                                5000, 40000],
      ["L'Excellence en Chimie 1ère D et C (NMI)",                                  4500, 36000],
      ["L'Excellence en Chimie Tle C et D (NMI)",                                   5500, 44000],
      ['French Class 3 (Afric Educ)',                                               1700, 13600],
      ['How are you Benjamin? (AFRICA EDUCATION)',                                  1000,  8000],
      ['Benjamin is not a little boy (AFRIC EDUC)',                                 1000,  8000],
      ['French Class 4 (Afric Educ)',                                               1700, 13600],
    ];

    // Normalize: strip ISBN prefix, lowercase, collapse spaces
    const norm = s => s.replace(/^\[[\d\-X]+\]\s*/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
    // Strip trailing publisher suffix "(PUBLISHER)" for fuzzy match
    const base = s => norm(s).replace(/\s*\([^)]+\)\s*$/, '').trim();

    const existing = db.prepare("SELECT id, name FROM products WHERE category='school_materials'").all()
      .map(p => ({ id: p.id, norm: norm(p.name), base: base(p.name) }));

    const upd = db.prepare('UPDATE products SET price=?, cost=? WHERE id=?');

    // guess grade from book name for newly inserted books
    const guessGrade = name => {
      const n = name.toLowerCase();
      if (/\bmaternelle\b/.test(n)) return 'Maternelle';
      if (/\bsil\b/.test(n) && !/\bsecondary\b/.test(n)) return 'Maternelle';
      if (/\bcp\b/.test(n) && !/computer/.test(n)) return 'CP';
      if (/\bce1\b/.test(n)) return 'CE1';
      if (/\bce2\b/.test(n)) return 'CE2';
      if (/\bcm1\b/.test(n)) return 'CM1';
      if (/\bcm2\b/.test(n)) return 'CM2';
      if (/6e?me|class 6|form 6|6e\/|\/6e|\b6eme\b|\bsixth\b/.test(n)) return '6ème';
      if (/5e?me|class 5|form 5|5e\/|\/5e/.test(n)) return '5ème';
      if (/4e?me|class 4|form 4|4e\/|\/4e/.test(n)) return '4ème';
      if (/3e?me|class 3|form 3/.test(n)) return '3ème';
      if (/2nde|seconde|form 2|class 2/.test(n)) return '2nde';
      if (/1.re|1ere|form 1|class 1/.test(n)) return '1ère';
      if (/terminale|tle /.test(n)) return 'Terminale';
      if (/universit/.test(n)) return 'Université';
      return null;
    };

    const ins = db.prepare(
      "INSERT INTO products (name,name_fr,category,grade,price,cost,discount,stock,sku,emoji,image) VALUES (?,?,?,?,?,?,0,0,?,?,null)"
    );

    const applyAll = db.transaction(() => {
      let updated = 0, inserted = 0, skipped = [];
      INV.forEach(([invName, price, cost]) => {
        const invNorm = norm(invName);
        const invBase = base(invName);

        // 1. Exact normalized match
        let hit = existing.find(p => p.norm === invNorm);
        // 2. Match on base name (both sides stripped of publisher)
        if (!hit) hit = existing.find(p => p.base === invBase && invBase.length > 5);
        // 3. Partial — invoice base contained in product norm or vice versa
        if (!hit && invBase.length > 8) {
          const candidates = existing.filter(p =>
            p.norm.includes(invBase) || invBase.includes(p.base)
          );
          if (candidates.length === 1) hit = candidates[0];
        }

        if (hit) {
          upd.run(price, cost, hit.id);
          updated++;
        } else {
          // Insert as new product
          const grade = guessGrade(invName);
          const sku = 'INV-' + norm(invName).slice(0, 6).replace(/\s/g, '').toUpperCase() + '-' + Date.now().toString(36).slice(-4);
          ins.run(invName, '', 'school_materials', grade, price, cost, sku, '📚');
          inserted++;
          skipped.push(invName);
        }
      });
      console.log(`• Invoice prices applied: ${updated} updated, ${inserted} new products added`);
      if (skipped.length) console.log('  New:', skipped.join('; '));
    });
    applyAll();
    db.prepare("INSERT INTO migrations VALUES (?)").run('invoice_prices_2026_07_29');
  }
} catch (e) {
  console.warn('Invoice price migration skipped:', e.message);
}

export default db;
