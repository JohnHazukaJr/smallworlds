import { useEffect, useState } from 'react';
import {
  COST_BEAT, COST_IMAGE, COST_UTILITY, MONTHLY_CREDITS, PACK_CREDITS, STARTER_CREDITS
} from '../billing/plans';
import { ensureBilling, loadBilling, openBillingPortal, startCheckout, type BillingSnapshot } from '../billing/client';
import { deleteCloudAccount } from '../cloud/account';
import { formatUserError } from '../errors';
import { Mono } from '../ui/bits';
import { useLegal } from '../ui/legalNav';

export function BillingPanel({
  userId,
  onError
}: {
  userId: string;
  onError: (msg: string) => void;
}) {
  const [snap, setSnap] = useState<BillingSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const openLegal = useLegal((s) => s.open);

  const refresh = async () => {
    try {
      await ensureBilling();
    } catch {
      // Migration or function may be absent; loadBilling reports that.
    }
    setSnap(await loadBilling(userId));
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ensureBilling();
      } catch { /* surfaced by load */ }
      try {
        const next = await loadBilling(userId);
        if (!cancelled) setSnap(next);
      } catch (e) {
        if (!cancelled) onError(formatUserError(e));
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    onError('');
    try {
      await fn();
    } catch (e) {
      onError(formatUserError(e));
    } finally {
      setBusy(false);
    }
  };

  const status = snap?.status && snap.status !== 'none' ? snap.status : 'free';
  const period = snap?.periodEnd ? new Date(snap.periodEnd).toLocaleDateString() : null;

  return (
    <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Mono style={{ fontSize: 9 }}>hosted credits</Mono>
      <div style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--paper)' }}>
        {snap ? `${snap.balance} credits · ${status}` : 'Loading balance…'}
        {period ? ` · renews ${period}` : ''}
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-muted)' }}>
        Bring-your-own-key stays free. Hosted prose is {COST_BEAT} credits, short utility calls are {COST_UTILITY},
        images are {COST_IMAGE}. New accounts get {STARTER_CREDITS} starter credits once.
        A month adds {MONTHLY_CREDITS}; a pack adds {PACK_CREDITS}.
      </div>
      {snap?.note && (
        <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'oklch(0.78 0.06 195)' }}>{snap.note}</div>
      )}
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-muted)' }}>
        Subscribing or buying a pack means you agree to the{' '}
        <button type="button" className="btn-quiet" style={{ fontSize: 12.5, padding: 0 }} onClick={() => openLegal('terms')}>Terms</button>
        {' '}and{' '}
        <button type="button" className="btn-quiet" style={{ fontSize: 12.5, padding: 0 }} onClick={() => openLegal('privacy')}>Privacy</button>.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn-primary" disabled={busy || snap?.ready === false} onClick={() => void run(() => startCheckout('monthly'))}>
          Subscribe
        </button>
        <button className="btn-ghost" disabled={busy || snap?.ready === false} onClick={() => void run(() => startCheckout('pack'))}>
          Buy a pack
        </button>
        <button className="btn-ghost" disabled={busy || snap?.ready === false} onClick={() => void run(() => openBillingPortal())}>
          Manage billing
        </button>
        <button className="btn-quiet" disabled={busy} onClick={() => void run(refresh)}>Refresh</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button
          className="btn-quiet"
          style={{ color: 'oklch(0.4 0.12 25)', borderColor: 'oklch(0.4 0.1 25)', fontSize: 11 }}
          disabled={busy}
          onClick={() => {
            if (!confirm('Delete the cloud account and erase this device? Synced stories, secrets, and credits are removed. This cannot be undone.')) return;
            if (!confirm('Last chance — export a backup first if you need the stories. Continue?')) return;
            void run(() => deleteCloudAccount());
          }}
        >
          Delete cloud account
        </button>
      </div>
    </div>
  );
}
