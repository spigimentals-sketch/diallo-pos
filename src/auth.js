// auth.js — PIN hashing and signed session tokens, using only Node's built-in
// crypto (no extra npm packages). This is right-sized security for a POS:
//   • PINs are stored as a salted scrypt hash, never in plain text.
//   • Login returns a signed token (like a mini-JWT). The server verifies the
//     signature on every protected request, so tokens can't be forged.
import crypto from 'crypto';

// In production set AUTH_SECRET as an environment variable. The fallback lets
// it run locally out of the box; tokens are only as secret as this value.
const SECRET = process.env.AUTH_SECRET || 'diallo-pos-dev-secret-change-me';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// ---- PIN hashing ----
export function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return { hash, salt };
}

export function verifyPin(pin, hash, salt) {
  if (!hash || !salt) return false;
  const test = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  // constant-time compare to avoid timing leaks
  const a = Buffer.from(test, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Tokens (compact, signed) ----
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

export function issueToken(user) {
  const payload = { id: user.id, name: user.name, role: user.role, exp: Date.now() + TOKEN_TTL_MS };
  const body = b64(payload);
  return `${body}.${sign(body)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (sign(body) !== sig) return null;            // bad signature
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); }
  catch { return null; }
  if (!payload.exp || payload.exp < Date.now()) return null; // expired
  return payload;
}

// Express middleware: rejects requests without a valid token.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Not authenticated' });
  req.user = payload;
  next();
}

// Middleware factory: require a specific role (e.g. admin or manager).
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not allowed for your role' });
    }
    next();
  };
}
