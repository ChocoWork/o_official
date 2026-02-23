'use client';

import React from 'react';
import { clientFetch } from '@/lib/client-fetch';

type UserRoleValue = 'admin' | 'supporter' | 'user';
type UserRoleLabel = 'Admin' | 'Support' | 'User';
type UserStatus = 'アクティブ' | '非アクティブ';

type UserItem = {
	id: string;
	name: string;
	email: string;
	role: UserRoleLabel;
	roleValue: UserRoleValue;
	lastLogin: string;
	status: UserStatus;
};

const roleLabelMap: Record<UserRoleValue, UserRoleLabel> = {
	admin: 'Admin',
	supporter: 'Support',
	user: 'User',
};

const roleOrderMap: Record<UserRoleValue, number> = {
	admin: 0,
	supporter: 1,
	user: 2,
};

const roleSelectClassMap: Record<UserRoleValue, string> = {
	admin: 'bg-black text-white border-black',
	supporter: 'bg-gray-300 text-black border-gray-400',
	user: 'bg-white text-black border-black/20',
};

const statusClassMap: Record<UserStatus, string> = {
	アクティブ: 'bg-green-100 text-green-800',
	非アクティブ: 'bg-gray-100 text-gray-500',
};

export default function UserSection() {
	const [users, setUsers] = React.useState<UserItem[]>([]);
	const [isLoading, setIsLoading] = React.useState(true);
	const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
	const [savingUserId, setSavingUserId] = React.useState<string | null>(null);

	const fetchUsers = React.useCallback(async () => {
		try {
			setIsLoading(true);
			setErrorMessage(null);

			const response = await clientFetch('/api/admin/users', { cache: 'no-store' });
			if (!response.ok) {
				if (response.status === 401) {
					throw new Error('認証が必要です。再ログインしてください。');
				}

				if (response.status === 403) {
					throw new Error('この操作を実行する権限がありません。');
				}

				throw new Error('ユーザー一覧の取得に失敗しました。');
			}

			const json = (await response.json()) as { data: UserItem[] };
			setUsers(json.data ?? []);
		} catch (error) {
			console.error('Failed to load admin users:', error);
			setErrorMessage(error instanceof Error ? error.message : 'ユーザー一覧の取得に失敗しました。');
		} finally {
			setIsLoading(false);
		}
	}, []);

	React.useEffect(() => {
		fetchUsers();
	}, [fetchUsers]);

	const sortedUsers = React.useMemo(() => {
		return [...users].sort((a, b) => {
			const roleOrderDiff = roleOrderMap[a.roleValue] - roleOrderMap[b.roleValue];
			if (roleOrderDiff !== 0) {
				return roleOrderDiff;
			}

			return a.name.localeCompare(b.name, 'ja');
		});
	}, [users]);

	const handleRoleChange = async (userId: string, nextRole: UserRoleValue) => {
		const previousUsers = users;

		setUsers((currentUsers) =>
			currentUsers.map((user) =>
				user.id === userId
					? {
						...user,
						roleValue: nextRole,
						role: roleLabelMap[nextRole],
					}
					: user,
			),
		);

		setSavingUserId(userId);

		try {
			const response = await clientFetch('/api/admin/users', {
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ userId, role: nextRole }),
			});

			if (!response.ok) {
				if (response.status === 403) {
					throw new Error('権限変更は管理者のみ実行できます。');
				}

				if (response.status === 401) {
					throw new Error('認証が必要です。再ログインしてください。');
				}

				throw new Error('権限の更新に失敗しました。');
			}
		} catch (error) {
			console.error('Failed to update role:', error);
			setUsers(previousUsers);
			setErrorMessage(error instanceof Error ? error.message : '権限の更新に失敗しました。');
		} finally {
			setSavingUserId(null);
		}
	};

	if (isLoading) {
		return (
			<section>
				<p className="text-sm text-[#474747] font-acumin">ユーザー一覧を読み込み中です...</p>
			</section>
		);
	}

	return (
		<section>
			{errorMessage && <p className="mb-4 text-sm text-red-700 font-acumin">{errorMessage}</p>}

			<div className="border border-[#d5d0c9] overflow-hidden overflow-x-auto">
				<table className="w-full min-w-[980px]">
					<thead className="bg-[#f5f5f5]">
						<tr>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">名前</th>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">メールアドレス</th>
							<th className="w-[180px] px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">権限</th>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">最終ログイン</th>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">ステータス</th>
						</tr>
					</thead>
					<tbody>
						{sortedUsers.map((user) => (
							<tr key={user.id} className="border-t border-[#d5d0c9]">
								<td className="px-6 py-4 text-sm text-black font-acumin">{user.name}</td>
								<td className="px-6 py-4 text-sm text-[#474747] font-acumin">{user.email}</td>
								<td className="w-[180px] px-6 py-4">
									<select
										className={`w-[140px] border px-3 py-2 text-xs tracking-widest font-acumin focus:outline-none focus:border-black ${roleSelectClassMap[user.roleValue]}`}
										value={user.roleValue}
										onChange={(event) => handleRoleChange(user.id, event.target.value as UserRoleValue)}
										disabled={savingUserId === user.id}
									>
										<option value="admin">Admin</option>
										<option value="supporter">Support</option>
										<option value="user">User</option>
									</select>
								</td>
								<td className="px-6 py-4 text-sm text-[#474747] font-acumin">{user.lastLogin}</td>
								<td className="px-6 py-4">
									<span className={`px-3 py-1 text-xs tracking-widest font-acumin ${statusClassMap[user.status]}`}>
										{user.status}
									</span>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}
