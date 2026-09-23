/**
 * TOTP (RFC 6238) and backup codes.
 *
 * Implemented directly rather than pulled from a dependency: the algorithm is
 * forty lines of HMAC, and the parts that actually matter for security — the
 * replay window, constant-time comparison, how backup codes are stored — are
 * decisions this file should make visibly rather than inherit.
 *
 * What it deliberately does:
 *
 *  - accepts a ±1 step window, so a code typed as the clock rolls over still
 *    works. Wider windows are a common "fix" for clock skew and each extra
 *    step is another 30 seconds an intercepted code stays valid.
 *  - refuses a step that has already been used. Without that, a code captured
 *    from a phishing page is good for the remainder of its window, which is
 *    the whole attack.
 *  - compares in constant time.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;
/** ±1 step. See the note above before widening this. */
const WINDOW = 1;

/* ------------------------------------------------------------------ base32 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/[=\s]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('That is not a valid authenticator secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/* -------------------------------------------------------------------- TOTP */

/** A fresh 160-bit secret, the size RFC 4226 recommends for HMAC-SHA1. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer. Node's writeBigUInt64BE avoids the
  // 2^53 precision cliff a naive two-word split would hit in about 2255 AD —
  // not urgent, but free to get right.
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', secret).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function currentStep(at: number = Date.now()): number {
  return Math.floor(at / 1000 / STEP_SECONDS);
}

export interface VerifyResult {
  valid: boolean;
  /** The step the code matched, so the caller can reject a replay of it. */
  step?: number;
}

/**
 * Verify a code.
 *
 * `lastStep` is the most recent step this user already authenticated with.
 * Passing it is what makes each code single-use; omitting it reduces this to
 * "is this code currently valid", which is not the same guarantee.
 */
export function verifyTotp(secretBase32: string, code: string, lastStep?: number | null): VerifyResult {
  const cleaned = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return { valid: false };

  const secret = base32Decode(secretBase32);
  const now = currentStep();

  for (let offset = -WINDOW; offset <= WINDOW; offset += 1) {
    const step = now + offset;
    if (lastStep != null && step <= lastStep) continue; // already used
    const expected = hotp(secret, step);
    const a = Buffer.from(expected);
    const b = Buffer.from(cleaned);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { valid: true, step };
    }
  }
  return { valid: false };
}

/**
 * The otpauth:// URI an authenticator app scans.
 *
 * The issuer appears twice by convention — in the label and as a parameter —
 * because different apps read different one, and getting it wrong shows the
 * user an entry called "unknown".
 */
export function provisioningUri(secret: string, account: string, issuer = 'Kairos'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ----------------------------------------------------------- backup codes */

/**
 * Ten single-use codes.
 *
 * Grouped as `xxxx-xxxx` because people transcribe these by hand off a printout
 * at the worst possible moment, and an unbroken ten-character string is how
 * transcription errors happen. Ambiguous characters are excluded from the
 * alphabet for the same reason.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O, 1/I/L

export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let code = '';
    for (let c = 0; c < 8; c += 1) {
      code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}

export function normaliseBackupCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}
