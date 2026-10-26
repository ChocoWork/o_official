'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { fetchSwapCandidates, postAllocationSwap } from '@/lib/inventory/allocation-swap-client';
import { ALLOCATION_SWAP_ERRORS, ALLOCATION_SWAP_TEXT, type AllocationSwapCandidate, type AllocationSwapInput, type AllocationSwapResult } from '@/lib/inventory/allocation-swap-types';
import type { AdminOrderDetail } from '@/lib/orders/admin-orders/admin-order-types';
import { toOrderNumber } from '@/lib/orders/order-number';
import { useDeliverySubmission } from '@/lib/orders/tracking/delivery-client';

type Props = { orderId: string; orderNumber: string; row: AdminOrderDetail['rows'][number]; onClose: () => void; onSwapped: () => void; onStale?: () => void };
const field = 'block w-full min-w-0 max-w-full border border-black/30 p-2';
const maxOf = (candidate: AllocationSwapCandidate): number => Math.min(candidate.swappableQuantity, candidate.takerQuantity);
const dateOf = (value: string): string => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', dateStyle: 'short' }).format(new Date(value));

export default function AllocationSwapDialog({ orderId, orderNumber, row, onClose, onSwapped, onStale }: Props): React.JSX.Element {
  const [candidates, setCandidates] = useState<AllocationSwapCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [donorOrderItemId, setDonor] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    let active = true;
    void fetchSwapCandidates(orderId, row.orderItemId).then((result) => {
      if (!active) return;
      if (result.kind === 'error') { setLoadError(result.message); return; }
      setCandidates(result.data);
      if (result.data[0]) { setDonor(result.data[0].donorOrderItemId); setQuantity(String(maxOf(result.data[0]))); }
    });
    return () => { active = false; };
  }, [orderId, row.orderItemId]);
  const submission = useDeliverySubmission<AllocationSwapInput, AllocationSwapResult>({
    send: async (input) => {
      const result = await postAllocationSwap(orderId, input);
      if (result.kind === 'unknown' || result.kind === 'refused') onStale?.();
      return result;
    },
    onSucceeded: onSwapped, onClose,
  });
  const selected = candidates?.find((candidate) => candidate.donorOrderItemId === donorOrderItemId);
  const locked = submission.busy || submission.uncertain;
  const submit = (): void => {
    if (!reason.trim()) { submission.setMessage(ALLOCATION_SWAP_ERRORS.GROUP_G_SWAP_REASON_REQUIRED[2]); return; }
    const count = Number(quantity);
    if (!selected || !Number.isSafeInteger(count) || count < 1 || count > maxOf(selected) || reason.trim().length > 200) { submission.setMessage(ALLOCATION_SWAP_ERRORS.GROUP_G_ARGUMENT_INVALID[2]); return; }
    submission.submit((requestKey) => ({ takerOrderItemId: row.orderItemId, donorOrderItemId, quantity: count, reason: reason.trim(), requestKey }));
  };
  return (
    <Dialog open fullScreenOnMobile title={ALLOCATION_SWAP_TEXT.title(orderNumber)} description={ALLOCATION_SWAP_TEXT.description} onClose={submission.close}>
      <div className="min-w-0 space-y-4">
        {!candidates && !loadError ? <p>{ALLOCATION_SWAP_TEXT.candidatesLoading}</p> : null}
        {loadError ? <p role="alert">{loadError}</p> : null}
        {candidates?.length === 0 ? <p>{ALLOCATION_SWAP_TEXT.candidatesEmpty}</p> : null}
        {candidates && candidates.length > 0 ? <>
          <label className="block">{ALLOCATION_SWAP_TEXT.donorLabel}<select className={field} disabled={locked} value={donorOrderItemId} onChange={(event) => { const candidate = candidates.find((value) => value.donorOrderItemId === event.target.value); setDonor(event.target.value); setQuantity(candidate ? String(maxOf(candidate)) : ''); }}>{candidates.map((candidate) => <option key={candidate.donorOrderItemId} value={candidate.donorOrderItemId}>{`${toOrderNumber(candidate.donorOrderId)}（${dateOf(candidate.orderCreatedAt)}）発送準備中 ${candidate.swappableQuantity}`}</option>)}</select></label>
          <label className="block">{ALLOCATION_SWAP_TEXT.quantityLabel}<input type="number" min={1} max={selected ? maxOf(selected) : undefined} step={1} value={quantity} disabled={locked} className={field} onChange={(event) => setQuantity(event.target.value)} /></label>
          <label className="block">{ALLOCATION_SWAP_TEXT.reasonLabel}<textarea value={reason} disabled={locked} maxLength={200} aria-describedby="allocation-swap-reason-help" className={field} onChange={(event) => setReason(event.target.value)} /></label>
          <p id="allocation-swap-reason-help">{ALLOCATION_SWAP_TEXT.reasonHelp}</p>
        </> : null}
        {submission.message ? <p role="alert">{submission.message}</p> : null}
        {submission.uncertain ? <p role="alert">{ALLOCATION_SWAP_TEXT.unknown}</p> : null}
        <div className="flex flex-wrap gap-3">
          {submission.uncertain ? <Button type="button" disabled={submission.busy} onClick={submission.checkAgain}>{ALLOCATION_SWAP_TEXT.checkAgain}</Button> : candidates && candidates.length > 0 ? <Button type="button" disabled={submission.busy} onClick={submit}>{ALLOCATION_SWAP_TEXT.submit}</Button> : null}
          <Button type="button" variant="secondary" disabled={submission.busy} onClick={submission.close}>{ALLOCATION_SWAP_TEXT.back}</Button>
        </div>
      </div>
    </Dialog>
  );
}
