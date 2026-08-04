import type { Location, ProviderConfig, World } from '../types';
import { AIError } from './client';

/**
 * Build a short image prompt from the active location sheet.
 * Avoids character faces / text so the result works as a story backdrop.
 */
export function sceneImagePrompt(world: World, location: Location, atmosphereNote?: string): string {
  const bits = [
    `Atmospheric wide establishing shot of "${location.name}"`,
    location.tagline,
    location.atmosphere || location.summary,
    location.features,
    atmosphereNote,
    world.line,
    'cinematic lighting, no people, no text, no watermark, painterly environment art'
  ].filter((s) => s && String(s).trim());
  return bits.join('. ').slice(0, 1200);
}

/**
 * Generate a scene backdrop via an OpenAI-compatible images API
 * (OpenRouter and similar). Returns a JPEG data URL.
 */
export async function generateSceneImage(opts: {
  provider: ProviderConfig;
  model: string;
  world: World;
  location: Location;
  atmosphereNote?: string;
  signal?: AbortSignal;
}): Promise<string> {
  if (opts.provider.kind !== 'openai') {
    throw new AIError('Scene image generation needs an OpenAI-compatible provider (OpenRouter works well).');
  }
  const prompt = sceneImagePrompt(opts.world, opts.location, opts.atmosphereNote);
  const url = await requestImage({
    provider: opts.provider, model: opts.model, prompt, signal: opts.signal
  });
  return urlToJpegDataUrl(url);
}

async function requestImage(opts: {
  provider: ProviderConfig;
  model: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.provider.apiKey) headers['Authorization'] = `Bearer ${opts.provider.apiKey}`;
  if (opts.provider.baseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://smallworlds.local';
    headers['X-Title'] = 'Small Worlds AI';
  }

  // Prefer the images endpoint; fall back to chat with modalities for OpenRouter-style models.
  const imagesUrl = `${opts.provider.baseUrl.replace(/\/$/, '')}/images/generations`;
  try {
    const res = await fetch(imagesUrl, {
      method: 'POST',
      headers,
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        prompt: opts.prompt,
        n: 1,
        size: '1792x1024',
        response_format: 'b64_json'
      })
    });
    if (res.ok) {
      const data = await res.json();
      const b64 = data?.data?.[0]?.b64_json as string | undefined;
      const url = data?.data?.[0]?.url as string | undefined;
      if (b64) return `data:image/png;base64,${b64}`;
      if (url) return url;
    }
  } catch {
    // fall through to chat modalities
  }

  const chatUrl = `${opts.provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(chatUrl, {
    method: 'POST',
    headers,
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: 'You generate a single atmospheric scene image. Return only the image.' },
        { role: 'user', content: opts.prompt }
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
      `Image generation failed (${res.status}). Try an image-capable model on OpenRouter, or upload a scene image instead.${detail ? ` ${detail}` : ''}`,
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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new AIError('Could not load the generated image.'));
    img.src = src;
  });
}
