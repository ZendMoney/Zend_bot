import crypto from 'crypto';

export async function encryptPrivateKey(secretKey: Uint8Array): Promise<string> {
  const key = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(process.env.ENCRYPTION_KEY || 'zend-dev-key', 'salt', 32, (err, derived) => {
      if (err) reject(err); else resolve(derived);
    });
  });
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}

export async function decryptPrivateKey(encryptedKey: string): Promise<Uint8Array> {
  const key = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(process.env.ENCRYPTION_KEY || 'zend-dev-key', 'salt', 32, (err, derived) => {
      if (err) reject(err); else resolve(derived);
    });
  });
  const parts = encryptedKey.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted key format');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return new Uint8Array(decrypted);
}
