/**
 * 本物の Chromium の仮想の認証器（CDP の WebAuthn ドメイン）を、試験から使うための助け。Chromium だけで動く。
 *
 * ブラウザの `navigator.credentials` が本物の `toJSON()` の形（無い項目が `null`）で応答を作る。差し替えの偽物では確かめられない往復に使う。
 * 手元の GoTrue の RP は `localhost`（1a）。鍵の中身（秘密鍵・応答）は、この助けの戻り値にも失敗の文面にも出さない。
 * 試験の終わりで必ず `remove()` を呼ぶこと。
 */
import type { CDPSession, Page } from '@playwright/test';

export type VirtualAuthenticator = {
  authenticatorId: string;
  cdp: CDPSession;
  credentials(): Promise<Array<{ credentialId: string }>>;
  remove(): Promise<void>;
};

export async function addVirtualAuthenticator(
  page: Page,
  opts?: { userVerified?: boolean },
): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: opts?.userVerified ?? true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    authenticatorId,
    cdp,
    async credentials() {
      const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
      return credentials.map((credential) => ({ credentialId: credential.credentialId }));
    },
    async remove() {
      // すでにページが閉じていても、外す側は静かに終わる。
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => undefined);
      await cdp.send('WebAuthn.disable').catch(() => undefined);
    },
  };
}
