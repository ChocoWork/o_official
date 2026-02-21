type UserRole = 'Admin' | 'Support' | 'User';

type UserStatus = 'アクティブ' | '非アクティブ';

type UserItem = {
	name: string;
	email: string;
	role: UserRole;
	lastLogin: string;
	status: UserStatus;
};

export default function UserSection() {
	const users: UserItem[] = [
		{ name: '山田 太郎', email: 'yamada@example.com', role: 'Admin', lastLogin: '2025-01-15 14:30', status: 'アクティブ' },
		{ name: '佐藤 花子', email: 'sato@example.com', role: 'Support', lastLogin: '2025-01-15 10:15', status: 'アクティブ' },
		{ name: '鈴木 一郎', email: 'suzuki@example.com', role: 'Support', lastLogin: '2025-01-14 18:45', status: 'アクティブ' },
		{ name: '田中 美咲', email: 'tanaka@example.com', role: 'User', lastLogin: '2025-01-13 09:20', status: 'アクティブ' },
		{ name: '高橋 健太', email: 'takahashi@example.com', role: 'User', lastLogin: '2025-01-10 16:00', status: '非アクティブ' },
		{ name: '伊藤 さくら', email: 'ito@example.com', role: 'User', lastLogin: '2025-01-08 11:30', status: 'アクティブ' },
	];

	const roleClassMap: Record<UserRole, string> = {
		Admin: 'bg-black text-white',
		Support: 'bg-[#474747] text-white',
		User: 'border border-black text-black',
	};

	const statusClassMap: Record<UserStatus, string> = {
		アクティブ: 'bg-green-100 text-green-800',
		非アクティブ: 'bg-gray-100 text-gray-500',
	};

	return (
		<section>
			<div className="flex justify-between items-center mb-8">
			</div>

			<div className="border border-[#d5d0c9] overflow-hidden">
				<table className="w-full">
					<thead className="bg-[#f5f5f5]">
						<tr>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">名前</th>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">メールアドレス</th>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">権限</th>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">最終ログイン</th>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">ステータス</th>
							<th className="px-6 py-4 text-left text-xs tracking-widest text-[#474747] font-acumin">操作</th>
						</tr>
					</thead>
					<tbody>
						{users.map((user) => (
							<tr key={user.email} className="border-t border-[#d5d0c9]">
								<td className="px-6 py-4 text-sm text-black font-acumin">{user.name}</td>
								<td className="px-6 py-4 text-sm text-[#474747] font-acumin">{user.email}</td>
								<td className="px-6 py-4">
									<div className="relative">
										<button className={`px-4 py-2 text-xs tracking-widest cursor-pointer flex items-center gap-2 font-acumin ${roleClassMap[user.role]}`}>
											{user.role}
											<i className="ri-arrow-down-s-line" />
										</button>
									</div>
								</td>
								<td className="px-6 py-4 text-sm text-[#474747] font-acumin">{user.lastLogin}</td>
								<td className="px-6 py-4">
									<span className={`px-3 py-1 text-xs tracking-widest font-acumin ${statusClassMap[user.status]}`}>
										{user.status}
									</span>
								</td>
								<td className="px-6 py-4">
									<button className="w-8 h-8 flex items-center justify-center text-[#474747] hover:text-black transition-colors cursor-pointer">
										<i className="ri-more-2-fill" />
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}
