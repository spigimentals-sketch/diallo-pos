// webauthn.js — fingerprint/biometric clock-in via the WebAuthn standard.
// The browser's platform authenticator (Windows Hello, Touch ID, Android
// fingerprint) signs a server-issued challenge with a private key that never
// leaves the device; we verify the signature against the public key recorded
// at registration. The actual fingerprint image/template never reaches this
// server — only cryptographic proof that the device's sensor verified the
// person holding it.
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { db } from './db.js';

export const RP_NAME = 'Diallo POS';
// These MUST match where the front-end is actually served from. The
// localhost defaults only work for local dev — set WEBAUTHN_RP_ID (bare
// domain, no scheme/port) and WEBAUTHN_ORIGIN (full origin URL, comma-
// separate if there's more than one) as env vars in production.
export const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
export const ORIGINS = (process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Up to 3 separate fingerprints per person — registering each one is its own
// WebAuthn ceremony, so scanning a different finger each time gives 3
// independent credentials (handy as backups if one finger doesn't read well).
export const MAX_CREDENTIALS = 3;

// Registration/authentication challenges are random one-time values with a
// short lifetime — an in-memory map keyed by user id is enough, no need to
// persist them past the few seconds the ceremony takes.
const challenges = new Map();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const putChallenge = (userId, challenge) => challenges.set(userId, { challenge, expires: Date.now() + CHALLENGE_TTL_MS });
const takeChallenge = (userId) => {
  const entry = challenges.get(userId);
  challenges.delete(userId);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.challenge;
};

const rowToCredential = (row) => ({
  id: row.credentialId,
  publicKey: Buffer.from(row.publicKey, 'base64url'),
  counter: row.counter,
  transports: row.transports ? JSON.parse(row.transports) : undefined,
});

export const credentialsForUser = (userId) =>
  db.prepare('SELECT id, deviceLabel, createdAt, credentialId, publicKey, counter, transports FROM webauthn_credentials WHERE userId=? ORDER BY createdAt DESC').all(userId);

export const publicCredentialList = (userId) =>
  credentialsForUser(userId).map(({ id, deviceLabel, createdAt }) => ({ id, deviceLabel, createdAt }));

export async function getRegistrationOptions(user) {
  const existing = credentialsForUser(user.id);
  if (existing.length >= MAX_CREDENTIALS) throw new Error(`You can register up to ${MAX_CREDENTIALS} fingerprints — remove one first`);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: user.username || user.name,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(String(user.id)),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.credentialId })),
    // No authenticatorAttachment restriction — that would silently exclude
    // external sensors (USB/Bluetooth keyboards with a built-in fingerprint
    // reader) that register as a "cross-platform" authenticator instead of
    // a "platform" one. userVerification: 'required' is what actually
    // matters: it forces a real biometric/PIN check, whichever kind of
    // sensor performs it, rather than just "tap to confirm presence".
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  putChallenge(user.id, options.challenge);
  return options;
}

export async function verifyRegistration(user, response) {
  const expectedChallenge = takeChallenge(user.id);
  if (!expectedChallenge) throw new Error('Registration timed out — try again');
  const existing = credentialsForUser(user.id);
  if (existing.length >= MAX_CREDENTIALS) throw new Error(`You can register up to ${MAX_CREDENTIALS} fingerprints — remove one first`);
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
  });
  if (!verification.verified || !verification.registrationInfo) throw new Error('Could not verify fingerprint registration');
  const { credential, userVerified } = verification.registrationInfo;
  if (!userVerified) throw new Error('That device did not confirm a fingerprint/biometric check');
  db.prepare(
    'INSERT INTO webauthn_credentials (userId,credentialId,publicKey,counter,transports,deviceLabel,createdAt) VALUES (?,?,?,?,?,?,?)'
  ).run(
    user.id, credential.id, Buffer.from(credential.publicKey).toString('base64url'), credential.counter,
    credential.transports ? JSON.stringify(credential.transports) : null,
    `Fingerprint ${existing.length + 1}`,
    new Date().toISOString()
  );
  return db.prepare('SELECT id, deviceLabel, createdAt FROM webauthn_credentials WHERE userId=? ORDER BY id DESC LIMIT 1').get(user.id);
}

export async function getClockInOptions(user) {
  const existing = credentialsForUser(user.id);
  if (!existing.length) throw new Error('No fingerprint registered yet — set one up first');
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    userVerification: 'required',
  });
  putChallenge(user.id, options.challenge);
  return options;
}

export async function verifyClockIn(user, response) {
  const expectedChallenge = takeChallenge(user.id);
  if (!expectedChallenge) throw new Error('Fingerprint check timed out — try again');
  const row = db.prepare('SELECT * FROM webauthn_credentials WHERE userId=? AND credentialId=?').get(user.id, response.id);
  if (!row) throw new Error('Unrecognized fingerprint credential');
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
    credential: rowToCredential(row),
    requireUserVerification: true,
  });
  if (!verification.verified) throw new Error('Fingerprint check failed');
  if (!verification.authenticationInfo.userVerified) throw new Error('Fingerprint was not confirmed by the device');
  db.prepare('UPDATE webauthn_credentials SET counter=? WHERE id=?').run(verification.authenticationInfo.newCounter, row.id);
  return true;
}

export function removeCredential(userId, credentialRowId) {
  const info = db.prepare('DELETE FROM webauthn_credentials WHERE id=? AND userId=?').run(credentialRowId, userId);
  if (!info.changes) throw new Error('Credential not found');
}
