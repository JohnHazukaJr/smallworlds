import { COPYRIGHT_HOLDER, COPYRIGHT_YEAR } from '../legal';
import { useLegal } from '../ui/legalNav';
import { Mono, phoneChrome, useViewport } from '../ui/bits';

export function LegalLinks() {
  const open = useLegal((s) => s.open);
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
      <button className="btn-quiet" style={{ fontSize: 12 }} onClick={() => open('privacy')}>Privacy</button>
      <button className="btn-quiet" style={{ fontSize: 12 }} onClick={() => open('terms')}>Terms</button>
    </div>
  );
}

export function LegalOverlay() {
  const doc = useLegal((s) => s.doc);
  const close = useLegal((s) => s.close);
  const { band } = useViewport();
  const phone = phoneChrome(band);
  if (!doc) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 80, overflow: 'auto',
      background: 'var(--ink)', color: 'var(--paper)'
    }}>
      <div style={{
        maxWidth: 720,
        paddingTop: phone ? 'calc(28px + env(safe-area-inset-top))' : 48,
        paddingRight: phone ? 20 : 40,
        paddingBottom: phone ? 'calc(28px + env(safe-area-inset-bottom))' : 64,
        paddingLeft: phone ? 20 : 40
      }}>
        <button className="btn-ghost" style={{ marginBottom: 22 }} onClick={close}>Back</button>
        <Mono style={{ letterSpacing: '0.16em', marginBottom: 10 }}>{doc === 'privacy' ? 'privacy' : 'terms'}</Mono>
        <h1 className="serif" style={{ fontWeight: 300, fontSize: phone ? 32 : 42, margin: '0 0 8px', color: 'var(--ink-heading)' }}>
          {doc === 'privacy' ? 'Privacy' : 'Terms'}
        </h1>
        <div style={{ fontSize: 12.5, color: 'var(--ink-muted)', marginBottom: 22 }}>
          {COPYRIGHT_HOLDER} · {COPYRIGHT_YEAR}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontSize: 15, lineHeight: 1.65, color: 'rgba(236,234,230,0.82)', maxWidth: '68ch' }}>
          {(doc === 'privacy' ? PRIVACY : TERMS).map((block) => (
            <section key={block.title}>
              <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--ink-heading)', margin: '0 0 6px' }}>{block.title}</h2>
              {block.body.map((p) => <p key={p} style={{ margin: '0 0 8px' }}>{p}</p>)}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

const PRIVACY: Array<{ title: string; body: string[] }> = [
  {
    title: 'What stays on this device',
    body: [
      'Stories, cast, places, and continuity are stored in IndexedDB in this browser. Settings and API keys are stored in localStorage. Small Worlds does not run analytics, advertising, or third-party tracking.',
      'While the passphrase lock is on, stories, cast, places, and continuity are encrypted at rest in this browser (AES-256-GCM). A few index fields stay readable so the app can find a world; the prose is ciphertext. The passphrase is not recoverable. If the lock is off, story text is stored in plaintext. Use your operating system’s disk encryption if the device is shared.',
      'Fonts ship with the app. The app does not load type from Google or any other font host.'
    ]
  },
  {
    title: 'What leaves the device',
    body: [
      'When you write with your own API key, the prompt is sent only to the endpoint you configured (OpenRouter, Z.ai, Anthropic, OpenAI, a local server, or another URL you enter). That provider’s privacy policy applies to the prompt and the reply. Small Worlds does not sit in the middle of those calls, except the optional CORS relay.',
      'The CORS relay (for Z.ai and BigModel) is available only after you sign in. It forwards your request and your key to the allowlisted host and does not store the key or the story.',
      'If you turn on Small Worlds hosted models, prompts and image requests are sent to our relay. We use them to call a model provider with our key, meter credits, and stream the reply back. We do not use your stories to train models.'
    ]
  },
  {
    title: 'Accounts and cloud sync',
    body: [
      'Sign-in is optional. If you sign in, Supabase stores your account (email, phone, or Google identity, whichever you use) and the worlds you sync. Synced rows are tied to your user id and protected by row-level security.',
      'API keys uploaded from Profile are encrypted on this device before they are stored. The server holds ciphertext only. That upload can also carry the wrapped story key, still ciphertext. The secrets passphrase is not your account password and is not sent to the server.',
      'While the lock is on, synced story rows are the sealed form. Another device reads them only after you enter the same passphrase.',
      'Billing, if you subscribe or buy credits, is handled by Stripe. We store a Stripe customer id, subscription status, and a credit ledger. We do not store your card number.'
    ]
  },
  {
    title: 'Export, erase, and delete',
    body: [
      'Profile → Back up this device exports worlds, settings, and the encrypted key vault, including the wrapped story key. While the lock is on, exported worlds are sealed. Worlds can also be exported on their own. A sealed file imported while the lock is off is refused until you unlock.',
      'Settings → Erase all data deletes stories, settings, and keys on this device only. It does not delete a cloud account.',
      'Settings or Profile → Delete cloud account deletes the signed-in user, synced stories, encrypted secrets, and billing rows, then erases this device. Export a backup first if you want to keep the stories.'
    ]
  }
];

const TERMS: Array<{ title: string; body: string[] }> = [
  {
    title: 'The service',
    body: [
      `${COPYRIGHT_HOLDER} is a writing app. You can use your own model providers at no charge from us, or buy hosted credits. Local stories and bring-your-own-key use do not require an account.`,
      'Hosted credits are a prepaid balance for model calls we make on your behalf. A monthly plan refills credits each paid period. A credit pack adds a one-time balance. Unused credits are not cash and are not transferred. Starter credits, when granted, are a one-time allowance for a new account.',
      'Prices and credit amounts are shown before you pay. Stripe processes the charge. You can cancel a subscription in the billing portal; access continues through the period you already paid.'
    ]
  },
  {
    title: 'Your stories',
    body: [
      'Stories, characters, and worlds you create belong to you. The license on the software does not cover your content.',
      'Stories are encrypted at rest only while the app lock is on. The passphrase cannot be recovered if you lose it.',
      'You are responsible for the content you write and for complying with the terms of any model provider you connect. Do not use the app to harm people or to break the law.'
    ]
  },
  {
    title: 'The software',
    body: [
      `The app is proprietary. Copyright © ${COPYRIGHT_YEAR} ${COPYRIGHT_HOLDER}. You receive a license to use the hosted app. You do not receive a license to copy, modify, or redistribute the software.`,
      'The service is provided as is, without warranty. Model output can be wrong, incomplete, or unavailable. We can suspend hosted access for abuse, non-payment, or to protect the service.',
      'These terms and the privacy page are the agreement for using the hosted app. If a store later distributes a native build, that store’s terms apply to the download, and these terms still apply to the service.'
    ]
  }
];
