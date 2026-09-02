import type { Character, Location, ProviderConfig, World } from '../types';
import { characterPortraits } from '../worldOps';
import { AIError } from './client';
import { isZaiProvider, providerFetch } from './providerFetch';

export interface SceneImageRef {
  name: string;
  dataUrl: string;
  kind: 'face' | 'place';
}

export interface SceneImageResult {
  dataUrl: string;
  warning?: string;
}

const FACE_REF_CAP = 3;
const REF_MAX_PX = 384;

/**
 * Build a short image prompt from the active location sheet.
 * When matching cast photos, name each ref instead of banning people.
 */
export function sceneImagePrompt(
  world: World,
  location: Location,
  atmosphereNote?: string,
  refs?: SceneImageRef[]
): string {
  const faces = (refs ?? []).filter((r) => r.kind === 'face');
  const places = (refs ?? []).filter((r) => r.kind === 'place');
  const identity = faces.length > 0
    ? faces.map((r, i) => `Image ${i + 1} is ${r.name} — keep their face, hair, and coloring.`).join(' ')
    : '';
  const placeRef = places.length > 0
    ? `Image ${faces.length + 1} is the place "${location.name}" — match architecture and palette, not as a face.`
    : '';
  const peopleLine = faces.length > 0
    ? 'People in frame must match the named reference faces. No extra invented faces.'
    : 'cinematic lighting, no people, no text, no watermark, painterly environment art';
  const bits = [
    `Atmospheric wide establishing shot of "${location.name}"`,
    location.tagline,
    location.atmosphere || location.summary,
    location.features,
    atmosphereNote,
    world.line,
    identity,
    placeRef,
    peopleLine
  ].filter((s) => s && String(s).trim());
  return bits.join('. ').slice(0, 1600);
}

/** Primary portraits of in-scene cast (player first), max 3, plus optional location place-ref. */
export function collectSceneImageRefs(opts: {
  characters: Character[];
  castIds: string[];
  location?: Location | null;
}): SceneImageRef[] {
  const { characters, castIds, location } = opts;
  const inScene = characters.filter((c) => castIds.includes(c.id) || c.isPlayer);
  const player = inScene.filter((c) => c.isPlayer);
  const others = inScene.filter((c) => !c.isPlayer);
  const ordered = [...player, ...others];
  const faces: SceneImageRef[] = [];
  for (const c of ordered) {
    const face = characterPortraits(c)[0];
    if (!face) continue;
    faces.push({ name: c.name || 'someone', dataUrl: face, kind: 'face' });
    if (faces.length >= FACE_REF_CAP) break;
  }
  const refs = [...faces];
  if (location?.portrait) {
    refs.push({ name: location.name || 'this place', dataUrl: location.portrait, kind: 'place' });
  }
  return refs;
}

export function sceneHasPortraitRefs(characters: Character[], castIds: string[]): boolean {
  return collectSceneImageRefs({ characters, castIds }).some((r) => r.kind === 'face');
}

/**
 * Official Z.ai `glm-image` /images/generations is text-in only.
 * OpenRouter-style multimodal chat models can take reference images.
 */
export function imageModelAcceptsRefs(provider: ProviderConfig, model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes('glm-image')) return false;
  if (isZaiProvider(provider) && (m === 'glm-image' || m.endsWith('/glm-image'))) return false;
  return true;
}

function zaiLandscapeSize(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('glm-image')) return '1728x960';
  return '1792x1024';
}

/**
 * Generate a scene backdrop. When matchCast is on, condition on uploaded portraits
 * via multimodal chat (or generations `images` if the gateway accepts them).
 */
export async function generateSceneImage(opts: {
  provider: ProviderConfig;
  model: string;
  world: World;
  location: Location;
  atmosphereNote?: string;
  matchCast?: boolean;
  refs?: SceneImageRef[];
  signal?: AbortSignal;
}): Promise<SceneImageResult> {
  if (opts.provider.kind !== 'openai') {
    throw new AIError('Scene image generation needs an OpenAI-compatible provider (OpenRouter or Z.ai).');
  }
  const wantedRefs = opts.matchCast ? await prepareSceneImageRefs(opts.refs ?? []) : [];
  const canRef = wantedRefs.length > 0 && imageModelAcceptsRefs(opts.provider, opts.model);
  const refs = canRef ? wantedRefs : [];
  const prompt = sceneImagePrompt(opts.world, opts.location, opts.atmosphereNote, refs);
  const url = await requestImage({
    provider: opts.provider,
    model: opts.model,
    prompt,
    refs,
    signal: opts.signal
  });
  const dataUrl = await urlToJpegDataUrl(url);
  let warning: string | undefined;
  if (opts.matchCast && wantedRefs.some((r) => r.kind === 'face') && !canRef) {
    warning =
      'This image model cannot take portrait references (Z.ai glm-image is text-only). ' +
      'Generated a place-only shot. Use an OpenRouter image model to match cast photos.';
  }
  return { dataUrl, warning };
}

async function requestImage(opts: {
  provider: ProviderConfig;
  model: string;
  prompt: string;
  refs: SceneImageRef[];
  signal?: AbortSignal;
}): Promise<string> {
  const headers = imageHeaders(opts.provider);
  const base = opts.provider.baseUrl.replace(/\/$/, '');
  const imagesUrl = `${base}/images/generations`;
  const size = zaiLandscapeSize(opts.model);

  const generationsBodies: Record<string, unknown>[] = [
    {
      model: opts.model,
      prompt: opts.prompt,
      n: 1,
      size,
      quality: 'hd',
      response_format: 'b64_json'
    }
  ];
  if (opts.refs.length > 0) {
    const urls = opts.refs.map((r) => r.dataUrl);
    generationsBodies.unshift({
      model: opts.model,
      prompt: opts.prompt,
      n: 1,
      size,
      image: urls[0],
      images: urls,
      response_format: 'b64_json'
    });
  }

  for (const body of generationsBodies) {
    try {
      const res = await providerFetch(imagesUrl, {
        method: 'POST',
        headers,
        signal: opts.signal,
        body: JSON.stringify(body)
      });
      if (res.ok) {
        const parsed = await readImagePayload(res);
        if (parsed) return parsed;
      }
    } catch {
      // try next body / chat path
    }
  }

  return requestImageViaChat(opts);
}

async function requestImageViaChat(opts: {
  provider: ProviderConfig;
  model: string;
  prompt: string;
  refs: SceneImageRef[];
  signal?: AbortSignal;
}): Promise<string> {
  const headers = imageHeaders(opts.provider);
  const chatUrl = `${opts.provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const userContent: Array<Record<string, unknown>> = [];
  for (const ref of opts.refs) {
    userContent.push({ type: 'image_url', image_url: { url: ref.dataUrl } });
  }
  userContent.push({ type: 'text', text: opts.prompt });

  const res = await providerFetch(chatUrl, {
    method: 'POST',
    headers,
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: 'You generate a single atmospheric scene image. Return only the image.' },
        { role: 'user', content: userContent }
      ],
      modalities: ['image', 'text'],
      max_tokens: 1024
    })
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message ?? body?.message ?? '';
    } catch { /* ignore */ }
    throw new AIError(
      `Image generation failed (${res.status}). Try glm-image on Z.ai or an image-capable model on OpenRouter, or upload a scene image instead.${detail ? ` ${detail}` : ''}`,
      res.status
    );
  }
  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  const images = message?.images as Array<{ image_url?: { url?: string } }> | undefined;
  const fromImages = images?.[0]?.image_url?.url;
  if (fromImages) return fromImages;
  const content = message?.content;
  if (typeof content === 'string') {
    const m = content.match(/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/);
    if (m) return m[0];
    const urlMatch = content.match(/https?:\/\/\S+\.(?:png|jpg|jpeg|webp)/i);
    if (urlMatch) return urlMatch[0];
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === 'image_url' && part?.image_url?.url) return part.image_url.url as string;
      if (part?.image_url?.url) return part.image_url.url as string;
    }
  }
  throw new AIError('The model did not return an image. Pick an image-capable model or upload one.');
}

function imageHeaders(provider: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  if (provider.baseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://smallworlds.local';
    headers['X-Title'] = 'Small Worlds AI';
  }
  if (isZaiProvider(provider)) {
    headers['Accept-Language'] = 'en-US,en';
  }
  return headers;
}

async function readImagePayload(res: Response): Promise<string | null> {
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json as string | undefined;
  const url = data?.data?.[0]?.url as string | undefined;
  if (b64) return `data:image/png;base64,${b64}`;
  if (url) return url;
  return null;
}

async function urlToJpegDataUrl(src: string): Promise<string> {
  if (src.startsWith('data:image/jpeg')) return src;
  const img = await loadImage(src);
  const maxDim = 1920;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new AIError('Image processing is not available in this browser.');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function downscaleRef(src: string): Promise<string> {
  const img = await loadImage(src);
  const scale = Math.min(1, REF_MAX_PX / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return src;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.82);
}

export async function prepareSceneImageRefs(refs: SceneImageRef[]): Promise<SceneImageRef[]> {
  const out: SceneImageRef[] = [];
  for (const ref of refs) {
    try {
      out.push({ ...ref, dataUrl: await downscaleRef(ref.dataUrl) });
    } catch {
      out.push(ref);
    }
  }
  return out;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new AIError('Could not load the generated image.'));
    img.src = src;
  });
}
