import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

export function encryptMetaToken(token: string, key: Buffer): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv(ALGORITHM, key, iv);
	const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [iv, tag, ciphertext].map((value) => value.toString('base64url')).join('.');
}

export function decryptMetaToken(payload: string, key: Buffer): string {
	const parts = payload.split('.');
	if (parts.length !== 3) {
		throw new Error('Invalid encrypted Meta token');
	}
	const [iv, tag, ciphertext] = parts.map((value) => Buffer.from(value, 'base64url'));
	const decipher = createDecipheriv(ALGORITHM, key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
