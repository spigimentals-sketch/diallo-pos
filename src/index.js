// index.js — the server entrypoint.
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import { seedIfEmpty } from './seed.js';
import { db } from './db.js';
import { hashPin } from './auth.js';
import api from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());                              // allow the web app to call us
app.use(express.json({ limit: '15mb' }));     // parse JSON bodies (large enough for base64 photos)

// Serve uploaded product photos from /uploads.
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
app.use('/uploads', express.static(uploadDir));

// Seed demo data on first boot.
seedIfEmpty();

// Safety net for existing databases: make sure every user can log in.
// Backfill a username (from email/name) and a default PIN (1234) where missing.
try {
  const slug = (s) => (s || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'user';
  const users = db.prepare('SELECT id, name, username, email, pin_hash FROM users').all();
  const setUser = db.prepare('UPDATE users SET username=? WHERE id=?');
  const setPin = db.prepare('UPDATE users SET pin_hash=?, pin_salt=? WHERE id=?');
  let fixedNames = 0, fixedPins = 0;
  for (const u of users) {
    if (!u.username) {
      let base = slug(u.email ? u.email.split('@')[0] : u.name);
      let candidate = base, n = 1;
      while (db.prepare('SELECT 1 FROM users WHERE username=? AND id<>?').get(candidate, u.id)) candidate = `${base}${++n}`;
      setUser.run(candidate, u.id); fixedNames++;
    }
    if (!u.pin_hash) { const { hash, salt } = hashPin('1234'); setPin.run(hash, salt, u.id); fixedPins++; }
  }
  if (fixedNames) console.log(`• Backfilled usernames for ${fixedNames} user(s)`);
  if (fixedPins) console.log(`• Set default PIN (1234) for ${fixedPins} user(s)`);
} catch (e) { console.warn('user backfill skipped:', e.message); }

// One-time cleanup: remove any shift not belonging to a real user account
// (e.g. old demo shifts for "Ousmane Diallo" etc.). Real shifts carry a user's name.
try {
  const res = db.prepare('DELETE FROM shifts WHERE name NOT IN (SELECT name FROM users)').run();
  if (res.changes) console.log(`• Removed ${res.changes} shift(s) not linked to a user account`);
} catch (e) { console.warn('shift cleanup skipped:', e.message); }

// Health check (useful for hosting platforms).
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// All API endpoints live under /api.
app.use('/api', api);

// --- Optional: serve the built front-end in production ---
// If you copy the web build into server/public, the API and UI run on one server.
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(publicDir, 'index.html'), (err) => { if (err) next(); });
});

app.listen(PORT, () => {
  console.log(`\n  Diallo POS API running on http://localhost:${PORT}`);
  console.log(`  Health:  http://localhost:${PORT}/health`);
  console.log(`  API:     http://localhost:${PORT}/api/products\n`);
});
