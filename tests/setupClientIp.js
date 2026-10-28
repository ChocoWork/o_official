// 送り元の IP を読む見出しを信じる旗（src/lib/request-ip.ts の getClientIp）。
// 試験は Vercel の外で動くので、旗を立てないと x-real-ip を読まず、回数の鍵と監査の IP が全部 null になる。
// request-ip.test.ts は自分で環境を差し替える。
process.env.CLIENT_IP_HEADER = 'x-real-ip';
