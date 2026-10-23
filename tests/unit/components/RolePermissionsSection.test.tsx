import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RolePermissionsSection from '@/components/RolePermissionsSection';
import { clientFetch } from '@/lib/client-fetch';
import { ROLE_PERMISSION_CATALOG } from '@/lib/auth/role-permission-catalog';
import type { PermissionCode } from '@/lib/auth/admin-rbac';
import type { PermissionsMatrix, RolePermissionChange, PermissionRoleState } from '@/lib/auth/role-permission-types';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
const fetchMock = jest.mocked(clientFetch);
const uuidMock = jest.fn();
const KEY1 = 'b6c640e3-70c1-46b1-8016-3d07310bab01';
const KEY2 = 'b6c640e3-70c1-46b1-8016-3d07310bab02';
const READ = '注文一覧・詳細・CSV・履歴・要対応の閲覧';
const SHIP = 'サポーター：荷作り・発送票閲覧';
const UNKNOWN = '保存結果を確認できませんでした。同じ変更を再送するか、現在の設定を読み直してください。';
const SUPPORTER_CODES: PermissionCode[] = [
  'admin.users.read', 'admin.orders.read', 'admin.orders.manage', 'admin.contact.read',
  'admin.contact.manage', 'admin.orders.return', 'admin.shipping.read', 'admin.shipping.manage',
];

function matrix(supporterCodes: PermissionCode[] = SUPPORTER_CODES, version = '9007199254740993'): PermissionsMatrix {
  return {
    permissions: [...ROLE_PERMISSION_CATALOG],
    roles: [
      { code: 'admin', label: '店長', version: '8', permissionCodes: ROLE_PERMISSION_CATALOG.map((p) => p.code) },
      { code: 'supporter', label: 'サポーター', version, permissionCodes: [...supporterCodes] },
    ],
  };
}

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function hold() {
  let release: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => { release = resolve; });
  return { promise, release };
}

async function loaded(data = matrix()) {
  fetchMock.mockResolvedValueOnce(json({ data }));
  render(<RolePermissionsSection />);
  await screen.findByRole('table');
}

function postCalls() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
}

function body(index = 0): RolePermissionChange {
  return JSON.parse(String(postCalls()[index][1]?.body)) as RolePermissionChange;
}

function open(name = SHIP) {
  const toggle = screen.getByRole('switch', { name });
  toggle.focus();
  fireEvent.click(toggle);
  return screen.getByRole('dialog', { name: '権限を変更する' });
}

function confirm() {
  fireEvent.click(screen.getByRole('button', { name: '変更する' }));
}

function savedRole(permissionCodes: PermissionCode[], version = '9007199254740994'): PermissionRoleState {
  return { code: 'supporter', label: 'サポーター', version, permissionCodes };
}

beforeEach(() => {
  fetchMock.mockReset();
  uuidMock.mockReset().mockReturnValueOnce(KEY1).mockReturnValue(KEY2);
  Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value: uuidMock });
});

describe('DB由来の読み込みと権限表', () => {
  test('GET成功前は表なし、読み込み中を表示する', async () => {
    const request = hold();
    fetchMock.mockReturnValueOnce(request.promise);
    render(<RolePermissionsSection />);
    expect(screen.getByText('読み込み中...')).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    await act(async () => request.release(json({ data: matrix() })));
    expect(screen.getByRole('table')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/permissions', { cache: 'no-store' });
  });

  test('全30コード・2役割を分野別の行見出しで表示し、固定2行にswitchを置かない', async () => {
    await loaded();
    expect(screen.getByRole('heading', { level: 1, name: '権限' })).toBeVisible();
    expect(screen.getByText('役割ごとに、できる操作を設定します。')).toBeVisible();
    expect(screen.getByText('管理メニューの表示は、権限の設定ではなく役割名で決まります。')).toBeVisible();
    for (const name of ['操作', '店長', 'サポーター']) expect(screen.getByRole('columnheader', { name })).toHaveAttribute('scope', 'col');
    for (const area of new Set(ROLE_PERMISSION_CATALOG.map((p) => p.area))) {
      expect(screen.getAllByRole('rowheader', { name: area }).find((header) => header.getAttribute('scope') === 'rowgroup')).toBeInTheDocument();
    }
    for (const p of ROLE_PERMISSION_CATALOG) {
      const name = p.upcoming ? `${p.label} この権限は、対応する画面の公開後に使われます。` : p.label;
      const heading = screen.getAllByRole('rowheader', { name }).find((header) => header.getAttribute('scope') === 'row');
      if (!heading) throw new Error('row header missing');
      const row = heading.closest('tr');
      if (!row) throw new Error('row missing');
      expect(within(row).getAllByText(p.label, { exact: true })).toHaveLength(1);
      if (p.fixed) {
        expect(within(row).queryByRole('switch')).not.toBeInTheDocument();
        expect(within(row).getByRole('cell', { name: '店長のみ・変更不可' })).toHaveAttribute('colspan', '2');
      } else {
        expect(within(row).getByRole('switch', { name: `店長：${p.label}` })).toBeChecked();
        expect(within(row).getByRole('switch', { name: `サポーター：${p.label}` })).toHaveAttribute('aria-checked', String(SUPPORTER_CODES.includes(p.code)));
      }
    }
    expect(screen.getAllByRole('switch')).toHaveLength(56);
    expect(screen.getAllByText('この権限は、対応する画面の公開後に使われます。')).toHaveLength(9);
    const region = screen.getByRole('region', { name: '権限の表' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveClass('overflow-x-auto', 'max-w-full');
    expect(within(region).getByRole('table')).toHaveClass('min-w-[52rem]');
  });

  test.each(['通信例外', '500'])('読み込み失敗（%s）は固定文・再読み込み、表なし', async (kind) => {
    if (kind === '通信例外') fetchMock.mockRejectedValueOnce(new Error('private detail'));
    else fetchMock.mockResolvedValueOnce(json({ error: 'private detail', code: 'PERMISSION_LOAD_FAILED' }, 500));
    render(<RolePermissionsSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^権限を読み込めませんでした。$/);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(json({ data: matrix() }));
    fireEvent.click(screen.getByRole('button', { name: '再読み込み' }));
    expect(await screen.findByRole('table')).toBeVisible();
    expect(screen.queryByText('private detail')).not.toBeInTheDocument();
  });
});

describe('確認と1変更の保存', () => {
  test('確認前と戻るではPOST・UUID生成なし、値は変わらず焦点を戻す', async () => {
    await loaded();
    const dialog = open();
    expect(within(dialog).getByText('サポーターの「荷作り・発送票閲覧」を解除します。変更しますか？')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: '戻る' })).toHaveFocus();
    expect(postCalls()).toHaveLength(0);
    expect(uuidMock).not.toHaveBeenCalled();
    expect(screen.getByRole('switch', { name: SHIP })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: SHIP })).toHaveFocus();
    expect(postCalls()).toHaveLength(0);
  });

  test.each(['Escape', '閉じる', '背景'])('保存前の%sは閉じ、POSTしない', async (action) => {
    await loaded();
    const dialog = open();
    if (action === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
    else if (action === '閉じる') fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    else fireEvent.click(screen.getByRole('presentation'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(postCalls()).toHaveLength(0);
    expect(uuidMock).not.toHaveBeenCalled();
  });

  test('保存中の全閉じ操作を遮断し、1コード差分・期待版・UUIDを1回だけPOST、応答role/版を採用する', async () => {
    const initial = matrix();
    await loaded(initial);
    const request = hold();
    fetchMock.mockReturnValueOnce(request.promise);
    const dialog = open();
    expect(dialog.parentElement).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
    confirm();
    confirm();
    expect(screen.getByText('保存しています...')).toBeVisible();
    expect(within(dialog).getByRole('status')).toHaveTextContent('保存しています...');
    for (const toggle of screen.getAllByRole('switch')) expect(toggle).toBeDisabled();
    for (const name of ['変更する', '戻る']) expect(within(dialog).getByRole('button', { name })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(dialog).toBeVisible();
    fireEvent.click(screen.getByRole('presentation'));
    expect(dialog).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));
    expect(dialog).toBeVisible();
    expect(postCalls()).toHaveLength(1);
    expect(uuidMock).toHaveBeenCalledTimes(1);
    expect(postCalls()[0][0]).toBe('/api/admin/role-permissions');
    const codes = SUPPORTER_CODES.filter((c) => c !== 'admin.shipping.read');
    expect(body()).toEqual({ roleCode: 'supporter', permissionCodes: codes, expectedVersion: '9007199254740993', requestKey: KEY1 });
    expect(postCalls()[0][1]).toEqual({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
    expect(screen.getByRole('switch', { name: SHIP })).toBeChecked();
    // 応答の一覧を採用し、ローカルのトグル反転だけで成功を代用しない。
    const returned = codes.filter((c) => c !== 'admin.contact.manage');
    await act(async () => request.release(json({ data: { role: savedRole(returned), changedCount: 1 } })));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('権限を保存しました。');
    expect(screen.getByRole('switch', { name: SHIP })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'サポーター：問い合わせの管理' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: '店長：問い合わせの管理' })).toBeChecked();
    expect(screen.getByRole('switch', { name: SHIP })).toHaveFocus();
    open();
    fetchMock.mockResolvedValueOnce(json({ data: { role: savedRole([...returned, 'admin.shipping.read'], '9007199254740995'), changedCount: 1 } }));
    confirm();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(body(1).expectedVersion).toBe('9007199254740994');
    expect(body(1).requestKey).toBe(KEY2);
  });

  test('キーボードで開き、Tabをdialog内で循環し、Escapeで焦点を戻す', async () => {
    const user = userEvent.setup();
    await loaded();
    const toggle = screen.getByRole('switch', { name: SHIP });
    toggle.focus();
    await user.keyboard(' ');
    const dialog = screen.getByRole('dialog', { name: '権限を変更する' });
    expect(within(dialog).getByRole('button', { name: '戻る' })).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole('button', { name: '変更する' })).toHaveFocus();
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
    expect(postCalls()).toHaveLength(0);
  });
});

describe('再送・競合・依存不足', () => {
  test.each(['通信例外', '500', '503'])('結果不明（%s）は完全同一本文を再送し、別トグルは変更できない', async (kind) => {
    await loaded();
    if (kind === '通信例外') fetchMock.mockRejectedValueOnce(new Error('private detail'));
    else fetchMock.mockResolvedValueOnce(json({ code: 'PERMISSION_UPDATE_FAILED', error: 'private detail' }, Number(kind)));
    open(); confirm();
    expect(await screen.findByRole('alert')).toHaveTextContent(UNKNOWN);
    const first = postCalls()[0][1]?.body;
    for (const toggle of screen.getAllByRole('switch')) expect(toggle).toBeDisabled();
    fireEvent.click(screen.getByRole('switch', { name: '店長：商品の閲覧' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(json({ data: { role: savedRole(SUPPORTER_CODES.filter((c) => c !== 'admin.shipping.read')), changedCount: 1 } }));
    fireEvent.click(screen.getByRole('button', { name: '同じ変更を再送' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('権限を保存しました。'));
    expect(postCalls()).toHaveLength(2);
    expect(postCalls()[1][1]?.body).toBe(first);
    expect(uuidMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('private detail')).not.toBeInTheDocument();
  });

  test.each(['ROLE_PERMISSION_VERSION_CONFLICT', 'ROLE_PERMISSION_REQUEST_KEY_CONFLICT', 'unknown'])('%sは再読込まで編集不可、新しい版/UUIDで再確認する', async (code) => {
    await loaded();
    fetchMock.mockResolvedValueOnce(json({ code }, 409));
    open(); confirm();
    await screen.findByRole('alert');
    for (const toggle of screen.getAllByRole('switch')) expect(toggle).toBeDisabled();
    expect(screen.queryByRole('button', { name: '同じ変更を再送' })).not.toBeInTheDocument();
    expect(postCalls()).toHaveLength(1);
    const latest = matrix(SUPPORTER_CODES.filter((c) => c !== 'admin.shipping.read'), '9007199254741000');
    fetchMock.mockResolvedValueOnce(json({ data: latest }));
    fireEvent.click(screen.getByRole('button', { name: '現在の設定を読み直す' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: SHIP })).toBeEnabled());
    expect(postCalls()).toHaveLength(1);
    open();
    expect(screen.getByText('サポーターの「荷作り・発送票閲覧」を許可します。変更しますか？')).toBeVisible();
    expect(postCalls()).toHaveLength(1);
    fetchMock.mockResolvedValueOnce(json({ data: { role: savedRole(SUPPORTER_CODES, '9007199254741001'), changedCount: 1 } }));
    confirm();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(body(1)).toMatchObject({ expectedVersion: '9007199254741000', requestKey: KEY2 });
  });

  test.each([
    ['通信例外', '同じ変更を再送'],
    ['ROLE_PERMISSION_VERSION_CONFLICT', '現在の設定を読み直す'],
    ['ROLE_PERMISSION_REQUEST_KEY_CONFLICT', '現在の設定を読み直す'],
  ])('保存が%sで止まったら、焦点を表示中の「%s」へ移す', async (kind, target) => {
    await loaded();
    if (kind === '通信例外') fetchMock.mockRejectedValueOnce(new Error('network'));
    else fetchMock.mockResolvedValueOnce(json({ code: kind }, 409));
    open(); confirm();
    await screen.findByRole('alert');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: target })).toHaveFocus();
  });

  test('再送中は前の失敗文を消して保存中だけを出し、読み直しは押せない。再び失敗したら失敗文と焦点を戻す', async () => {
    await loaded();
    fetchMock.mockRejectedValueOnce(new Error('network'));
    open(); confirm();
    await screen.findByRole('alert');
    const late = hold();
    fetchMock.mockReturnValueOnce(late.promise);
    fireEvent.click(screen.getByRole('button', { name: '同じ変更を再送' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/^保存しています\.\.\.$/);
    const reload = screen.getByRole('button', { name: '現在の設定を読み直す' });
    expect(reload).toBeDisabled();
    fireEvent.click(reload);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => late.release(json({ code: 'PERMISSION_UPDATE_FAILED' }, 500)));
    expect(screen.getByRole('alert')).toHaveTextContent(UNKNOWN);
    expect(screen.queryByText('保存しています...')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '現在の設定を読み直す' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '同じ変更を再送' })).toHaveFocus();
    expect(postCalls()).toHaveLength(2);
    expect(postCalls()[1][1]?.body).toBe(postCalls()[0][1]?.body);
  });

  test('再送中に「現在の設定を読み直す」を押してもGETせず、再送の応答を採用して次の版で保存する', async () => {
    await loaded();
    fetchMock.mockRejectedValueOnce(new Error('network'));
    open(); confirm();
    await screen.findByRole('alert');
    const late = hold();
    fetchMock.mockReturnValueOnce(late.promise);
    fireEvent.click(screen.getByRole('button', { name: '同じ変更を再送' }));
    fireEvent.click(screen.getByRole('button', { name: '現在の設定を読み直す' }));
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/admin/permissions')).toHaveLength(1);
    await act(async () => late.release(json({ data: { role: savedRole(SUPPORTER_CODES.filter((c) => c !== 'admin.shipping.read'), '9'), changedCount: 1 } })));
    expect(screen.getByRole('status')).toHaveTextContent('権限を保存しました。');
    expect(screen.getByRole('switch', { name: SHIP })).not.toBeChecked();
    open();
    fetchMock.mockResolvedValueOnce(json({ data: { role: savedRole(SUPPORTER_CODES, '10'), changedCount: 1 } }));
    confirm();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(body(2).expectedVersion).toBe('9');
  });

  test('再読込失敗では古い一覧で再編集できず、再読み込み成功後に解除される', async () => {
    await loaded();
    fetchMock.mockResolvedValueOnce(json({ code: 'ROLE_PERMISSION_VERSION_CONFLICT' }, 409));
    open(); confirm();
    await screen.findByRole('alert');
    fetchMock.mockResolvedValueOnce(json({}, 500));
    fireEvent.click(screen.getByRole('button', { name: '現在の設定を読み直す' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('権限を読み込めませんでした。');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(json({ data: matrix() }));
    fireEvent.click(screen.getByRole('button', { name: '再読み込み' }));
    expect(await screen.findByRole('table')).toBeVisible();
    expect(postCalls()).toHaveLength(1);
  });

  test('役割別に依存不足を表示し、確認した1コード以外を自動付与しない', async () => {
    await loaded(matrix(['admin.shipping.manage', 'admin.stock.manage']));
    expect(screen.getByText(`操作に必要な権限が不足しています：未入金取消・取消申請審査・要確認解消・メール再送、${READ}、荷作り・発送票閲覧、在庫一覧。`)).toBeVisible();
    expect(screen.getByRole('switch', { name: `サポーター：${READ}` })).not.toBeChecked();
    open('サポーター：確定後の出荷日訂正');
    fetchMock.mockResolvedValueOnce(json({ data: { role: savedRole(['admin.shipping.manage', 'admin.stock.manage', 'admin.shipping.correct_date']), changedCount: 1 } }));
    confirm();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(body().permissionCodes).toEqual(['admin.shipping.manage', 'admin.stock.manage', 'admin.shipping.correct_date']);
    expect(screen.getByRole('switch', { name: `サポーター：${READ}` })).not.toBeChecked();
  });
});

const errors: Array<[number, Record<string, unknown>, string]> = [
  [403, { code: 'ROLE_PERMISSION_FORBIDDEN' }, '権限を変更する権限がありません。'],
  [403, { code: 'ROLE_PERMISSION_FIXED', reason: 'MFA required' }, '権限管理と利用者管理は店長のみ・変更不可です。'],
  [403, { code: 'ROLE_PERMISSION_FIXED', reason: null }, '権限管理と利用者管理は店長のみ・変更不可です。'],
  [409, { code: 'LAST_ADMIN_REQUIRED' }, '店長を1人以上残してください。'],
  [403, { code: 'SELF_ROLE_CHANGE_FORBIDDEN' }, '自分自身の役割は変更できません。'],
  [400, { code: 'ROLE_PERMISSION_ARGUMENT_INVALID' }, '入力を確かめてください。'],
  [409, { code: 'ROLE_PERMISSION_VERSION_CONFLICT' }, 'ほかの人が権限を変更しました。現在の設定を読み直してください。'],
  [409, { code: 'ROLE_PERMISSION_REQUEST_KEY_CONFLICT' }, '同じ要求番号で異なる変更は保存できません。現在の設定を読み直してください。'],
  [403, { code: 'unknown', reason: 'MFA required' }, '2要素認証が必要です'],
  [403, { code: 'unknown', reason: 'CSRF validation failed' }, '安全確認に失敗しました。ページを開き直してください。'],
  [403, { code: null, reason: 'CSRF validation failed' }, '安全確認に失敗しました。ページを開き直してください。'],
  [401, { code: 'unknown', reason: 'unknown' }, 'ログインし直してください。'],
  [403, { code: 'unknown', reason: 'unknown' }, 'アクセス権限がありません'],
  [409, {}, '変更が競合しました。現在の設定を読み直してください。'],
  [429, {}, '操作が多すぎます。しばらく待ってから、もう一度お試しください。'],
  [422, {}, '入力を確かめてください。'],
];

describe.each(['GET', 'POST'] as const)('%sの表示優先 code → reason → status', (method) => {
  test.each(errors)('status=%s body=%j は固定文だけを表示する', async (status, error, message) => {
    if (method === 'POST') await loaded();
    fetchMock.mockResolvedValueOnce(json({ error: 'private detail', ...error }, status));
    if (method === 'GET') render(<RolePermissionsSection />);
    else { open(); confirm(); }
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByText('private detail')).not.toBeInTheDocument();
    expect(screen.queryByText('unknown')).not.toBeInTheDocument();
    if (method === 'GET') expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
