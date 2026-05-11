const crypto = require('crypto');

const MASTER_KEY = process.env.MASTER_KEY || '';

if (!MASTER_KEY) {
  console.warn('Warning: MASTER_KEY not set. Encryption will fail.');
}

function genPseudoId() {
  return crypto.randomBytes(16).toString('hex');
}

function deriveKey() {
  // derive a 32-byte key from MASTER_KEY
  return crypto.createHash('sha256').update(MASTER_KEY).digest();
}

function encryptObject(jsonObj) {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(jsonObj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, nonce: iv, tag };
}

function decryptRecord(record) {
  const key = deriveKey();
  const iv = record.nonce;
  const ciphertext = record.ciphertext;
  const tag = record.tag;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

module.exports = { genPseudoId, encryptObject, decryptRecord };
