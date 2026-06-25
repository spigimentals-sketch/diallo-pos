// seed.js — fills the database with the original demo data.
// Run automatically on first boot (when tables are empty), or manually: npm run seed
import { db } from './db.js';
import { hashPin } from './auth.js';

const PRODUCTS = [];
const CUSTOMERS = [
  { name: 'Aminata Bakary', phone: '+237 6 78 12 34 56', points: 1840, tier: 'Gold', visits: 47, spent: 425000 },
  { name: 'Jean-Paul Mbarga', phone: '+237 6 99 22 11 33', points: 920, tier: 'Silver', visits: 28, spent: 198000 },
  { name: 'Fatou Diallo', phone: '+237 6 55 67 89 01', points: 3210, tier: 'Platinum', visits: 89, spent: 782000 },
  { name: 'Samuel Nkomo', phone: '+237 6 71 23 45 67', points: 340, tier: 'Bronze', visits: 12, spent: 67000 },
];

const SUPPLIERS = [
  { name: 'Beauty Central', contact: 'Pierre Etoga', phone: '+237 6 77 11 22 33', email: 'p.etoga@beautycentral.cm', productsCount: 0, lastOrder: '2026-05-20', status: 'active', category: 'Cosmetics' },
  { name: 'Cameroon Wine Co.', contact: 'Sylvie Manga', phone: '+237 6 91 88 77 66', email: 'contact@camwine.cm', productsCount: 0, lastOrder: '2026-05-24', status: 'active', category: 'Wines' },
  { name: 'Whiskey House', contact: 'Robert Nguele', phone: '+237 6 55 44 33 22', email: 'robert@whiskeyhouse.cm', productsCount: 0, lastOrder: '2026-05-25', status: 'active', category: 'Whiskey' },
  { name: 'School Supplies Pro', contact: 'Claudette Atangana', phone: '+237 6 78 99 88 77', email: 'claudette@schoolsupplies.cm', productsCount: 0, lastOrder: '2026-05-26', status: 'active', category: 'School materials' },
  { name: 'Fragrance World', contact: 'Marc Tcheunkam', phone: '+237 6 22 11 00 99', email: 'marc@fragranceworld.cm', productsCount: 0, lastOrder: '2026-05-18', status: 'active', category: 'Perfumes' },
  { name: 'Ice Cream Factory', contact: 'Aïcha Souley', phone: '+237 6 33 22 44 55', email: 'a.souley@icecreamfactory.cm', productsCount: 0, lastOrder: '2026-05-15', status: 'active', category: 'Ice cream' },
  { name: 'Shawarma Express', contact: 'Bruno Eyenga', phone: '+237 6 66 55 77 88', email: 'bruno@shawarmaexpress.cm', productsCount: 0, lastOrder: '2026-04-28', status: 'inactive', category: 'Shawarma' },
];

const PURCHASE_ORDERS = [];

const STOCK_MOVEMENTS = [];
const USERS = [
  { name: 'Joseph Diallo', username: 'joseph', role: 'admin', email: 'joseph@diallo.cm', lastActive: '2 min ago', store: 'All stores' },
  { name: 'Mariam Ndongo', username: 'mariam', role: 'manager', email: 'mariam@diallo.cm', lastActive: 'Just now', store: 'Central' },
  { name: 'Paul Atangana', username: 'paul', role: 'cashier', email: 'paul@diallo.cm', lastActive: '12 min ago', store: 'Central' },
  { name: 'Esther Ngo', username: 'esther', role: 'cashier', email: 'esther@diallo.cm', lastActive: '1 hour ago', store: 'Bastos' },
  { name: 'David Onana', username: 'david', role: 'manager', email: 'david@diallo.cm', lastActive: '3 hours ago', store: 'Akwa' },
];

const EMPLOYEES = [
  { name: 'Mariama Ndiaye', role: 'Cashier', initials: 'MN', color: 'from-amber-400 to-rose-500', rate: 1500 },
  { name: 'Ousmane Diallo', role: 'Manager', initials: 'OD', color: 'from-emerald-400 to-teal-600', rate: 2500 },
  { name: 'Awa Sow', role: 'Cashier', initials: 'AS', color: 'from-sky-400 to-indigo-600', rate: 1500 },
  { name: 'Ibrahim Bah', role: 'Stocker', initials: 'IB', color: 'from-fuchsia-400 to-purple-600', rate: 1200 },
];

const DEFAULT_SETTINGS = {
  businessName: 'DIALLO Supermarché', currency: 'XAF', timezone: 'Africa/Douala', dateFormat: 'DD/MM/YYYY',
  address: 'Avenue Kennedy, Centre-Ville, Yaoundé', phone: '+237 6 77 00 00 00', email: 'contact@diallo.cm',
  website: 'www.diallo.cm', rccm: 'RC/YAO/2024/B/01234', niu: 'P012345678901G',
  receiptHeader: 'DIALLO Supermarché — Merci de votre visite', receiptFooter: 'Tous les retours sous 7 jours avec ticket de caisse',
  paperWidth: '80', showLogo: true, showQR: true, tvaRate: '19.25', tvaIncluded: false,
  taxIdPrint: true, acceptCash: true, acceptCard: true, acceptMobile: true, lowStockThreshold: '10',
  dailySummary: true, weeklySummary: true, paymentAlerts: true,
};

export function seedIfEmpty() {
  // Decide "first run" by whether the database has ever been initialized, using
  // the settings row (which is never removed by the Clear-all-data feature).
  // Using product count here was unsafe: clearing data empties products, which
  // would wrongly trigger a re-seed and crash on the existing settings row.
  const initialized = db.prepare("SELECT COUNT(*) AS n FROM settings").get().n > 0
    || db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0;
  if (initialized) {
    console.log('• Database already initialized — skipping seed.');
    return;
  }
  console.log('• Seeding database…');
  const tx = db.transaction(() => {
    const pIns = db.prepare('INSERT INTO products (name,name_fr,category,price,stock,sku,emoji) VALUES (@name,@name_fr,@category,@price,@stock,@sku,@emoji)');
    PRODUCTS.forEach(p => pIns.run(p));

    const cIns = db.prepare('INSERT INTO customers (name,phone,points,tier,visits,spent) VALUES (@name,@phone,@points,@tier,@visits,@spent)');
    CUSTOMERS.forEach(c => cIns.run(c));

    const sIns = db.prepare('INSERT INTO suppliers (name,contact,phone,email,productsCount,lastOrder,status,category) VALUES (@name,@contact,@phone,@email,@productsCount,@lastOrder,@status,@category)');
    SUPPLIERS.forEach(s => sIns.run(s));

    const poIns = db.prepare('INSERT INTO purchase_orders (id,supplierId,supplier,date,items,total,status) VALUES (@id,@supplierId,@supplier,@date,@items,@total,@status)');
    PURCHASE_ORDERS.forEach(po => poIns.run(po));

    const mIns = db.prepare('INSERT INTO stock_movements (productName,type,qty,source,date,user) VALUES (@productName,@type,@qty,@source,@date,@user)');
    STOCK_MOVEMENTS.forEach(m => mIns.run(m));

    // Each user gets a default PIN of 1234 (hashed). Change these in the app.
    const uIns = db.prepare('INSERT INTO users (name,username,role,email,lastActive,store,pin_hash,pin_salt) VALUES (@name,@username,@role,@email,@lastActive,@store,@pin_hash,@pin_salt)');
    USERS.forEach(u => {
      const { hash, salt } = hashPin('1234');
      uIns.run({ ...u, pin_hash: hash, pin_salt: salt });
    });

    const eIns = db.prepare('INSERT INTO employees (name,role,initials,color,rate) VALUES (@name,@role,@initials,@color,@rate)');
    EMPLOYEES.forEach(e => eIns.run(e));

    // Shifts start empty — created when real user accounts clock in.
    db.prepare('INSERT OR IGNORE INTO settings (id,json) VALUES (1,@json)').run({ json: JSON.stringify(DEFAULT_SETTINGS) });
  });
  tx();
  console.log('• Seed complete.');
}

// Allow running directly: `node src/seed.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  seedIfEmpty();
  process.exit(0);
}
