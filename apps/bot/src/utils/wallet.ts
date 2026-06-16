import crypto from 'crypto';

const SCRYPT_SALT_LEN = 16;

function requireEncryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('ENCRYPTION_KEY is required — set a 64-character hex key in .env');
  }
  return key;
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/** v2 format: v2:<salt_hex>:<iv_hex>:<authTag_hex>:<ciphertext_hex> */
export async function encryptPrivateKey(secretKey: Uint8Array): Promise<string> {
  const password = requireEncryptionKey();
  const salt = crypto.randomBytes(SCRYPT_SALT_LEN);
  const key = await deriveKey(password, salt);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    'v2',
    salt.toString('hex'),
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

export async function decryptPrivateKey(encryptedKey: string): Promise<Uint8Array> {
  const parts = encryptedKey.split(':');

  // v2: per-wallet random salt
  if (parts[0] === 'v2' && parts.length === 5) {
    const password = requireEncryptionKey();
    const salt = Buffer.from(parts[1], 'hex');
    const iv = Buffer.from(parts[2], 'hex');
    const authTag = Buffer.from(parts[3], 'hex');
    const encrypted = Buffer.from(parts[4], 'hex');
    const key = await deriveKey(password, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return new Uint8Array(decrypted);
  }

  // Legacy: static salt "salt" — iv:authTag:ciphertext (3 parts)
  if (parts.length === 3) {
    const password = process.env.ENCRYPTION_KEY || 'zend-dev-key';
    const legacySalt = Buffer.from('salt');
    const key = await deriveKey(password, legacySalt);
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return new Uint8Array(decrypted);
  }

  throw new Error('Invalid encrypted key format');
}