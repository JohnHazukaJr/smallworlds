// WebCrypto helpers: AES-256-GCM with keys derived from a passphrase via PBKDF2-SHA256.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface CipherPayload {
  /** base64 12-byte IV */
  iv: string;
  /** base64 ciphertext (includes GCM auth tag) */
  ct: string;
}

const PBKDF2_ITERATIONS = 600_000;

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomSalt(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(16)));
}

export async function deriveKey(passphrase: string, saltB64: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: fromB64(saltB64) as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptString(key: CryptoKey, plain: string): Promise<CipherPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, encoder.encode(plain));
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/** Throws if the key is wrong or the payload was tampered with (GCM auth failure). */
export async function decryptString(key: CryptoKey, payload: CipherPayload): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(payload.iv) as BufferSource },
    key,
    fromB64(payload.ct) as BufferSource
  );
  return decoder.decode(plain);
}
