import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { clientFetch } from '@/lib/client-fetch';

type ConnectionData = {
	configured: boolean;
	missing: string[];
	connected: boolean;
	connection: {
		instagram_username: string | null;
		ad_account_id: string | null;
		ad_account_name: string | null;
		token_expires_at: string | null;
		last_synced_at: string | null;
		last_sync_status: 'success' | 'partial' | 'failed' | null;
		last_sync_message: string | null;
	} | null;
};

type MetaKpiConnectionProps = {
	season: string;
	onSynced: () => void;
};

export function MetaKpiConnection({ season, onSynced }: MetaKpiConnectionProps) {
	const [data, setData] = useState<ConnectionData | null>(null);
	const [isWorking, setIsWorking] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	const fetchStatus = useCallback(async () => {
		const response = await clientFetch('/api/admin/kpi/meta', { cache: 'no-store' });
		if (!response.ok) return;
		const payload = await response.json() as { data: ConnectionData };
		setData(payload.data);
	}, []);

	useEffect(() => { void fetchStatus(); }, [fetchStatus]);

	const handleSync = async () => {
		setIsWorking(true);
		setMessage(null);
		try {
			const response = await clientFetch('/api/admin/kpi/meta/sync', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ season }),
			});
			if (!response.ok) throw new Error('同期に失敗しました。Metaの権限とアクセストークンを確認してください。');
			setMessage('Instagram・広告データを月次KPIへ反映しました。');
			await fetchStatus();
			onSynced();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : '同期に失敗しました。');
		} finally {
			setIsWorking(false);
		}
	};

	const handleDisconnect = async () => {
		if (!window.confirm('Instagram・Meta広告との連携を解除しますか？')) return;
		setIsWorking(true);
		await clientFetch('/api/admin/kpi/meta', { method: 'DELETE' });
		await fetchStatus();
		setIsWorking(false);
	};

	if (!data) return null;
	const lastSynced = data.connection?.last_synced_at
		? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tokyo' }).format(new Date(data.connection.last_synced_at))
		: '未同期';

	return (
		<div className="rounded-lg border border-[#d4d4d4] bg-[#fafafa] p-3" aria-label="Instagram・Meta広告連携">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="min-w-0">
					<p className="font-acumin text-xs font-medium text-black">Instagram・Meta広告連携</p>
					{!data.configured ? (
						<p className="mt-1 font-acumin text-[11px] text-[#8a4b00]">環境変数が未設定です: {data.missing.join(', ')}</p>
					) : data.connected ? (
						<p className="mt-1 font-acumin text-[11px] text-[#555555]">
							@{data.connection?.instagram_username || 'Instagram'} ／ {data.connection?.ad_account_name || data.connection?.ad_account_id || '広告アカウント未選択'} ／ 最終同期 {lastSynced}
						</p>
					) : (
						<p className="mt-1 font-acumin text-[11px] text-[#555555]">未接続です。Meta Businessアカウントで認証してください。</p>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{data.connected ? (
						<>
							<Button variant="secondary" size="3xs" className="font-acumin" disabled={isWorking || !season} onClick={() => void handleSync()}>
								{isWorking ? '同期中...' : '今すぐ同期'}
							</Button>
							<Button variant="outline" size="3xs" className="font-acumin" disabled={isWorking} onClick={() => void handleDisconnect()}>解除</Button>
						</>
					) : (
						<Button variant="secondary" size="3xs" className="font-acumin" disabled={!data.configured} onClick={() => window.location.assign('/api/admin/kpi/meta/connect')}>
							Metaと接続
						</Button>
					)}
				</div>
			</div>
			{message ? <p role="status" className="mt-2 font-acumin text-[11px] text-[#474747]">{message}</p> : null}
		</div>
	);
}
