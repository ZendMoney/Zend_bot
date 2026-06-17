import crypto from 'crypto';

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await new Promise<Buffer>((resolve, reject) => {
    crypto.pbkdf2(pin, salt, 100000, 32, 'sha256', (err, derived) => {
      if (err) reject(err); else resolve(derived);
    });
  });
  return salt + ':' + hash.toString('hex');
}

export async function verifyPin(pin: string, stored: string): Promise<{ valid: boolean; isLegacy: boolean }> {
  if (!stored.includes(':')) {
    return { valid: stored === pin, isLegacy: true };
  }
  const parts = stored.split(':');
  if (parts.length !== 2) return { valid: false, isLegacy: false };
  const [salt, hash] = parts;
  const computed = await new Promise<Buffer>((resolve, reject) => {
    crypto.pbkdf2(pin, salt, 100000, 32, 'sha256', (err, derived) => {
      if (err) reject(err); else resolve(derived);
    });
  });
  return { valid: computed.toString('hex') === hash, isLegacy: false };
}