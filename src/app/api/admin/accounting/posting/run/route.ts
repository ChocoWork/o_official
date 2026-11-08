import { handlePostingRun } from '@/lib/accounting/posting-route';

// 計上係を最大20回まで繰り返すので、長めに待つ。
export const maxDuration = 120;

/** 計上係を今すぐ流す。admin.finance.manage。監査は件数だけ。 */
export async function POST(request: Request): Promise<Response> {
	return handlePostingRun(request);
}
