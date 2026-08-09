jest.mock('server-only', () => ({}), { virtual: true });

import { randomBytes } from 'node:crypto';
import { decryptMetaToken, encryptMetaToken } from '@/lib/meta/token-crypto';

describe('Meta token encryption', () => {
	it('AES-256-GCMで暗号化したトークンを復号できる', () => {
		const key = randomBytes(32);
		const encrypted = encryptMetaToken('secret-access-token', key);
		expect(encrypted).not.toContain('secret-access-token');
		expect(decryptMetaToken(encrypted, key)).toBe('secret-access-token');
	});

	it('異なる鍵では復号できない', () => {
		const encrypted = encryptMetaToken('secret-access-token', randomBytes(32));
		expect(() => decryptMetaToken(encrypted, randomBytes(32))).toThrow();
	});
});
