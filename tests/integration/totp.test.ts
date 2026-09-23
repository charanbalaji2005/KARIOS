/**
 * TOTP tests.
 *
 * Includes the RFC 6238 test vectors, because an authenticator implementation
 * that is subtly wrong still produces six plausible digits and only fails once
 * someone is locked out of their account.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  base32Decode,
  base32Encode,
  currentStep,
  generateBackupCodes,
  generateSecret,
  normaliseBackupCode,
  provisioningUri,
  verifyTotp,
} from '../../services/api/src/lib/totp.js';

afterEach(() => vi.useRealTimers());

describe('base32', () => {
  it('round-trips', () => {
    const buffer = Buffer.from('12345678901234567890');
    expect(base32Decode(base32Encode(buffer)).equals(buffer)).toBe(true);
  });

  it('matches the known encoding of the RFC test key', () => {
    // "12345678901234567890" is the RFC 4226 test seed.
    expect(base32Encode(Buffer.from('12345678901234567890'))).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => base32Decode('ABC!DEF')).toThrow();
  });

  it('ignores padding and whitespace, which is how users paste secrets', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(`${secret} ===`).length).toBe(20);
  });
});

describe('verifyTotp', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  /** RFC 6238 Appendix B, SHA-1 rows. */
  const vectors: [number, string][] = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];

  for (const [epochSeconds, code] of vectors) {
    it(`matches the RFC vector at t=${epochSeconds}`, () => {
      vi.useFakeTimers();
      vi.setSystemTime(epochSeconds * 1000);
      expect(verifyTotp(secret, code).valid).toBe(true);
    });
  }

  it('rejects a wrong code', () => {
    vi.useFakeTimers();
    vi.setSystemTime(59_000);
    expect(verifyTotp(secret, '000000').valid).toBe(false);
  });

  it('rejects anything that is not six digits', () => {
    for (const bad of ['12345', '1234567', 'abcdef', '', '12 34 56 78']) {
      expect(verifyTotp(secret, bad).valid).toBe(false);
    }
  });

  it('accepts the previous step, for a code typed as the clock rolls over', () => {
    vi.useFakeTimers();
    vi.setSystemTime(59_000);
    const step = currentStep();
    // Code from the step before, submitted now.
    vi.setSystemTime((step + 1) * 30 * 1000 + 1000);
    expect(verifyTotp(secret, '287082').valid).toBe(true);
  });

  it('refuses a step that was already used', () => {
    // The replay guard. Without it, a code captured from a phishing page stays
    // valid for the rest of its window.
    vi.useFakeTimers();
    vi.setSystemTime(59_000);
    const first = verifyTotp(secret, '287082');
    expect(first.valid).toBe(true);
    expect(verifyTotp(secret, '287082', first.step).valid).toBe(false);
  });

  it('returns the step it matched, so the caller can record it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(59_000);
    const result = verifyTotp(secret, '287082');
    expect(result.step).toBe(1);
  });
});

describe('provisioningUri', () => {
  it('includes the issuer twice, because apps disagree about which to read', () => {
    const uri = provisioningUri('ABCDEF', 'user@example.com');
    expect(uri).toMatch(/^otpauth:\/\/totp\/Kairos%3Auser%40example\.com\?/);
    expect(uri).toContain('issuer=Kairos');
    expect(uri).toContain('secret=ABCDEF');
    expect(uri).toContain('period=30');
  });
});

describe('backup codes', () => {
  it('generates ten distinct grouped codes', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('excludes characters people confuse when transcribing', () => {
    // These get read off a printout in a hurry, often by someone already
    // locked out and irritated.
    const codes = generateBackupCodes(50).join('');
    for (const ambiguous of ['0', 'O', '1', 'I', 'L']) {
      expect(codes).not.toContain(ambiguous);
    }
  });

  it('normalises however the user types it back', () => {
    expect(normaliseBackupCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normaliseBackupCode('ABCD EFGH')).toBe('ABCDEFGH');
    expect(normaliseBackupCode('ABCDEFGH')).toBe('ABCDEFGH');
  });
});

describe('generateSecret', () => {
  it('produces a 160-bit secret', () => {
    expect(base32Decode(generateSecret()).length).toBe(20);
  });

  it('does not repeat', () => {
    const secrets = new Set(Array.from({ length: 100 }, generateSecret));
    expect(secrets.size).toBe(100);
  });
});
