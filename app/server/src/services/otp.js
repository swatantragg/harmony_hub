// One passcode per calendar day.
//
// The rule the library wants: sign in once in the morning, stay signed in until
// midnight, prove yourself again the next day. Two mechanisms carry it.
//
//  · The **day key** — `2026-08-29` in OTP_TIMEZONE — is stamped on the session
//    family and on every access token minted from it. `authenticate` compares
//    the token's stamp with today and refuses a stale one, so the cut-off is
//    immediate at midnight rather than "whenever the 15-minute token expires".
//
//  · A stale-but-otherwise-valid refresh cookie is not thrown away. It is worth
//    exactly one thing: the right to be asked for a passcode instead of a
//    password. That is what makes the next morning one field, not two.
//
// The code itself is stored as an HMAC under the server secret, never as a bare
// hash. Six digits is a millionth of a search space; a plain SHA-256 of it falls
// to a laptop in seconds if the collection ever leaks, and an HMAC does not fall
// at all without the secret.

import crypto from 'node:crypto';
import { models } from '../db/models.js';
import { JWT_SECRET, OTP } from '../config.js';
import { uuid } from '../util/crypto.js';

export const PURPOSES = { LOGIN: 'login', RESUME: 'resume', RESET: 'reset' };

// ── The day boundary ────────────────────────────────────────────────────────

/** `YYYY-MM-DD` in the configured zone. Intl does the DST and offset work. */
export function dayKey(at = new Date(), timeZone = OTP.timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at);
  } catch {
    // An unparseable OTP_TIMEZONE must not take sign-in down with it.
    return at.toISOString().slice(0, 10);
  }
}

/** When today ends, as an ISO instant — used to tell people how long they have. */
export function endOfDay(at = new Date(), timeZone = OTP.timezone) {
  const today = dayKey(at, timeZone);
  for (let hours = 0; hours <= 50; hours += 1) {
    const probe = new Date(at.getTime() + hours * 3_600_000);
    if (dayKey(probe, timeZone) !== today) {
      // Walk the last hour back a minute at a time for the exact boundary.
      for (let m = 60; m >= 0; m -= 1) {
        const back = new Date(probe.getTime() - m * 60_000);
        if (dayKey(back, timeZone) === today) return new Date(back.getTime() + 60_000).toISOString();
      }
      return probe.toISOString();
    }
  }
  return new Date(at.getTime() + 86_400_000).toISOString();
}

export const isToday = (key) => Boolean(key) && key === dayKey();

export const enabled = () => OTP.enabled;

// ── Challenges ──────────────────────────────────────────────────────────────

const digest = (code, salt) =>
  crypto.createHmac('sha256', JWT_SECRET).update(`otp:${salt}:${code}`).digest('hex');

/** Uniform over 10^length. `randomInt` rejects modulo bias for us. */
function generate(length = OTP.length) {
  const max = 10 ** length;
  return String(crypto.randomInt(0, max)).padStart(length, '0');
}

const ticketKey = () => crypto.createHmac('sha256', JWT_SECRET).update('otp-ticket-v1').digest();

/** An opaque, signed handle for "this person is mid-verification". Carries no code. */
export function mintTicket({ challengeId, userId, purpose }) {
  const payload = Buffer.from(JSON.stringify({
    c: challengeId,
    u: userId,
    p: purpose,
    e: Math.floor(Date.now() / 1000) + OTP.ticketTtlSec,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', ticketKey()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function readTicket(value) {
  const [payload, signature] = String(value || '').split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', ticketKey()).update(payload).digest('base64url');
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (Math.floor(Date.now() / 1000) > Number(claims.e)) return null;
    return { challengeId: String(claims.c), userId: String(claims.u), purpose: String(claims.p) };
  } catch {
    return null;
  }
}

/**
 * Opens a challenge and returns the plain code for the caller to deliver.
 * The code exists in memory here and nowhere else — after this returns, only
 * its HMAC is recoverable.
 */
export async function open({ userId, purpose, familyId = null, meta = {} }) {
  const recent = await models.otpChallenges
    .findOne({ userId, purpose, consumedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ createdAt: -1 })
    .lean();

  if (recent && Date.now() - Date.parse(recent.createdAt) < OTP.resendCooldownSec * 1000) {
    return {
      ok: false,
      reason: 'cooldown',
      retryAfterSec: Math.ceil((OTP.resendCooldownSec * 1000 - (Date.now() - Date.parse(recent.createdAt))) / 1000),
    };
  }

  // One live challenge per person per purpose. A second request replaces the
  // first rather than giving an attacker two valid codes to guess against.
  await models.otpChallenges.updateMany(
    { userId, purpose, consumedAt: null },
    { $set: { consumedAt: new Date(), outcome: 'superseded' } },
  );

  const code = generate();
  const salt = crypto.randomBytes(12).toString('base64url');
  const _id = uuid();

  await models.otpChallenges.create({
    _id,
    userId,
    purpose,
    familyId,
    salt,
    codeHash: digest(code, salt),
    attempts: 0,
    maxAttempts: OTP.maxAttempts,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + OTP.ttlSec * 1000),
    consumedAt: null,
    outcome: null,
    ip: meta.ip ?? null,
    userAgent: String(meta.userAgent || '').slice(0, 200),
  });

  return { ok: true, code, challengeId: _id, ttlSec: OTP.ttlSec };
}

/**
 * Consumes a challenge. Every outcome that is not `ok` is terminal for that
 * code — a wrong guess burns an attempt, and running out burns the challenge.
 */
export async function verify({ challengeId, userId, purpose, code }) {
  const row = await models.otpChallenges.findOne({ _id: challengeId }).lean();
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.userId !== userId || row.purpose !== purpose) return { ok: false, reason: 'unknown' };
  if (row.consumedAt) return { ok: false, reason: 'spent' };
  if (Date.parse(row.expiresAt) < Date.now()) return { ok: false, reason: 'expired' };
  if (Number(row.attempts ?? 0) >= Number(row.maxAttempts ?? OTP.maxAttempts)) {
    return { ok: false, reason: 'exhausted' };
  }

  const supplied = String(code ?? '').replace(/\D/g, '');
  const expected = Buffer.from(row.codeHash, 'hex');
  const actual = Buffer.from(digest(supplied, row.salt), 'hex');
  const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!matches) {
    const attempts = Number(row.attempts ?? 0) + 1;
    const exhausted = attempts >= Number(row.maxAttempts ?? OTP.maxAttempts);
    await models.otpChallenges.updateOne({ _id: challengeId }, {
      $set: {
        attempts,
        ...(exhausted ? { consumedAt: new Date(), outcome: 'exhausted' } : {}),
      },
    });
    return {
      ok: false,
      reason: exhausted ? 'exhausted' : 'mismatch',
      attemptsLeft: Math.max(0, Number(row.maxAttempts ?? OTP.maxAttempts) - attempts),
    };
  }

  await models.otpChallenges.updateOne(
    { _id: challengeId },
    { $set: { consumedAt: new Date(), outcome: 'verified' } },
  );
  return { ok: true, familyId: row.familyId ?? null };
}

export async function sweep() {
  const out = await models.otpChallenges.deleteMany({
    expiresAt: { $lt: new Date(Date.now() - 86_400_000) },
  });
  return out.deletedCount ?? 0;
}
