import { resolveMailProvider } from '@/lib/mail';

describe('メールの送り方の決め方', () => {
  it('普段の開発（next dev）では、MAIL_PROVIDER が resend でも手元のメール受けに送る', () => {
    expect(resolveMailProvider({ NODE_ENV: 'development', MAIL_PROVIDER: 'resend' })).toBe('local');
  });

  it('本番の作り方で起動した E2E は MAIL_PROVIDER=local に従う', () => {
    expect(resolveMailProvider({ NODE_ENV: 'production', MAIL_PROVIDER: 'local' })).toBe('local');
  });

  it('本番は MAIL_PROVIDER に従う', () => {
    expect(resolveMailProvider({ NODE_ENV: 'production', MAIL_PROVIDER: 'resend' })).toBe('resend');
  });

  it('MAIL_PROVIDER が無ければ今までどおり ses', () => {
    expect(resolveMailProvider({ NODE_ENV: 'test' })).toBe('ses');
  });

  it('知らない送り方は断る', () => {
    expect(() => resolveMailProvider({ NODE_ENV: 'production', MAIL_PROVIDER: 'smtp' })).toThrow(
      'Unsupported mail provider: smtp',
    );
  });
});
