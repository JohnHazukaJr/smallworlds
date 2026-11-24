import type { Character, Location, ProviderConfig, World } from '../types';
import { PORTRAIT_JPEG_QUALITY, PORTRAIT_MAX_PX } from '../ui/image';
import { characterPortraits } from '../worldOps';
import { AIError, providerTagFor } from './client';
import { allLooksText } from '../looks';
import { readAge } from './ageRead';
import { configuredImageModel, configuredMatureImageModel } from './models';
import {
  buildCharacterPortraitPrompt,
  characterLookLine,
  minorRefusalMessage,
  portraitStyleLine,
  subjectAgeReading,
  textLooksSexual,
  wantsFullBody,
  type PortraitFraming,
  type PortraitStyle
} from './portrait';
import { isZaiProvider, providerFetch } from './providerFetch';
import { isOpenRouterHost, VENICE_ADULT_EDIT_MODEL, VENICE_ADULT_GENERATE_MODEL } from './providers';

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
  refs?: SceneImageRef[],
  style?: PortraitStyle
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
    : style === 'comic'
      ? `${portraitStyleLine('comic')}. No people, no text, no watermark`
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

function nameInPrompt(name: string, prompt: string): boolean {
  const n = name.trim().toLowerCase();
  if (n.length < 2) return false;
  const hay = prompt.toLowerCase();
  let from = 0;
  while (from <= hay.length - n.length) {
    const at = hay.indexOf(n, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : hay[at - 1];
    const after = hay[at + n.length] ?? '';
    const edge = (ch: string) => ch === '' || !/[a-z0-9]/i.test(ch);
    if (edge(before) && edge(after)) return true;
    from = at + n.length;
  }
  return false;
}

function namesOverlap(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** People the picture is about: names in the prompt, otherwise everyone in the chapter. */
export function chapterPictureSubjects(opts: {
  characters: Character[];
  castIds: string[];
  prompt: string;
}): Character[] {
  const named = opts.characters
    .filter((c) => nameInPrompt(c.name, opts.prompt))
    .sort((a, b) => b.name.trim().length - a.name.trim().length);
  const picked: Character[] = [];
  for (const character of named) {
    if (picked.some((have) => namesOverlap(have.name, character.name))) continue;
    picked.push(character);
  }
  if (picked.length > 0) return picked;
  const inScene = opts.characters.filter((c) => opts.castIds.includes(c.id) || c.isPlayer);
  return [...inScene.filter((c) => c.isPlayer), ...inScene.filter((c) => !c.isPlayer)];
}

/** Main photos for the picture, at most three, in subject order. */
export function chapterPictureFaces(opts: {
  characters: Character[];
  castIds: string[];
  prompt: string;
}): SceneImageRef[] {
  const faces: SceneImageRef[] = [];
  for (const character of chapterPictureSubjects(opts)) {
    const face = characterPortraits(character)[0];
    if (!face) continue;
    faces.push({ name: character.name.trim() || 'someone', dataUrl: face, kind: 'face' });
    if (faces.length >= FACE_REF_CAP) break;
  }
  return faces;
}

const PICTURE_PROMPT_MAX = 1600;
/** A look shorter than this says too little to be worth sending. */
const LOOK_MIN = 60;

/** One subject's written look. `look` is a characterLookLine. */
export interface PictureLook {
  name: string;
  look: string;
}

export function chapterPicturePrompt(opts: {
  userPrompt: string;
  refs: SceneImageRef[];
  style: PortraitStyle;
  contentNotes: string;
  mature: boolean;
  minor: boolean;
  /** How each subject looks. A photo keeps the face; this keeps the body, build, and clothes. */
  looks?: PictureLook[];
  /** Ask for the whole figure, head to feet. */
  fullBody?: boolean;
}): string {
  const identity = opts.refs
    .map((ref, i) => `Image ${i + 1} is ${ref.name}. Keep their face, hair, and coloring from that photo.`)
    .join(' ');
  const audience = opts.minor || !opts.mature
    ? 'Fully clothed, non-sexual, no nudity, no suggestive pose'
    : '';
  const looks = (opts.looks ?? []).filter((l) => l.look.trim());
  const head = [
    opts.userPrompt.trim(),
    opts.fullBody ? 'Show the whole figure, head to feet' : '',
    identity
  ];
  const tail = [
    looks.length > 0
      ? 'Everyone named must match their description: no invented outfits, builds, or faces.'
      : opts.refs.length > 0 ? 'People in frame must match the named reference photos. No extra invented faces.' : '',
    opts.contentNotes.trim() ? `Boundaries: ${opts.contentNotes.trim()}` : '',
    portraitStyleLine(opts.style),
    audience,
    'No text, no watermark'
  ];
  const join = (parts: string[]) => parts.filter((part) => part && part.trim()).join('. ');
  const fixed = join([...head, ...tail]);
  // The written looks give way first, so the user's own words are never cut.
  const room = PICTURE_PROMPT_MAX - fixed.length - looks.length * 2 - 2;
  const each = looks.length > 0 ? Math.floor(room / looks.length) : 0;
  const lookLines = each >= LOOK_MIN
    ? looks.map((l) => {
      const hasPhoto = opts.refs.some((ref) => ref.kind === 'face' && ref.name === l.name);
      const prefix = hasPhoto ? 'Body, build, and clothing — ' : 'Looks — ';
      const text = `${prefix}${l.look}`;
      return text.length > each ? `${text.slice(0, each - 1).trimEnd()}…` : text;
    })
    : [];
  return join([...head, ...lookLines, ...tail]).slice(0, PICTURE_PROMPT_MAX);
}

export type ChapterPicturePlan =
  | { ok: false; error: string }
  | { ok: true; prompt: string; refs: SceneImageRef[] };

/**
 * Subjects' written looks, in the same order (and cap) as their photos.
 * The intimate section rides along only for an adult in an adult world.
 */
export function chapterPictureLooks(subjects: Character[], mature = false): PictureLook[] {
  return subjects
    .slice(0, FACE_REF_CAP)
    .map((c) => ({
      name: c.name.trim() || 'someone',
      look: characterLookLine(c, undefined, { adult: mature && !subjectAgeReading(c).minor })
    }))
    .filter((l) => l.look);
}

/**
 * Decide the prompt and photo refs before any request.
 * Photos are required when the people already have them; a text-only model must not drop them.
 */
export function prepareChapterPicture(opts: {
  characters: Character[];
  castIds: string[];
  userPrompt: string;
  style: PortraitStyle;
  contentNotes: string;
  mature: boolean;
  provider: ProviderConfig | null;
  model: string | null;
  /** Ask for the whole figure even when the prompt does not say so. */
  fullBody?: boolean;
}): ChapterPicturePlan {
  const userPrompt = opts.userPrompt.trim();
  if (!userPrompt) return { ok: false, error: 'Say what the picture should show.' };
  if (!opts.provider || !opts.model) {
    return { ok: false, error: 'Set an image model in Settings before making a picture.' };
  }
  const subjects = chapterPictureSubjects({
    characters: opts.characters,
    castIds: opts.castIds,
    prompt: userPrompt
  });
  if (textLooksSexual(userPrompt) && subjects.some((c) => subjectAgeReading(c).minor)) {
    return { ok: false, error: minorRefusalMessage(subjects) };
  }
  const refs = chapterPictureFaces({
    characters: opts.characters,
    castIds: opts.castIds,
    prompt: userPrompt
  });
  if (refs.length > 0 && !imageModelAcceptsRefs(opts.provider, opts.model)) {
    return {
      ok: false,
      error: 'This image model can’t use character photos. Choose an image model that accepts reference images.'
    };
  }
  return {
    ok: true,
    refs,
    prompt: chapterPicturePrompt({
      userPrompt,
      refs,
      style: opts.style,
      contentNotes: opts.contentNotes,
      mature: opts.mature,
      minor: subjects.some((c) => subjectAgeReading(c).minor),
      looks: chapterPictureLooks(subjects, opts.mature),
      fullBody: !!opts.fullBody
    })
  };
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

export type ImageSizeKind = 'portrait' | 'landscape' | 'square' | 'tall';

/** Conservative sizes most image APIs accept. Unsized `{ model, prompt }` is tried first. */
export function imageSizeCandidates(kind: ImageSizeKind = 'square'): string[] {
  if (kind === 'portrait') return ['1024x1024', '1024x1536'];
  // A whole figure needs the height: tall first, square if the model refuses it.
  if (kind === 'tall') return ['1024x1536', '1024x1024'];
  if (kind === 'landscape') return ['1024x1024', '1792x1024'];
  return ['1024x1024'];
}

/** OpenRouter’s Image API is `/images`; OpenAI-compatible hosts use `/images/generations`. */
export function imageGenerationsUrls(baseUrl: string): string[] {
  const base = baseUrl.replace(/\/$/, '');
  const generations = `${base}/images/generations`;
  if (isOpenRouterHost(baseUrl)) return [`${base}/images`, generations];
  return [generations];
}

/** Minimal body first. Extra fields (`quality`, `response_format`) are what get 400s. */
export function imageGenerationsBodies(opts: {
  model: string;
  prompt: string;
  refs?: SceneImageRef[];
  sizes?: string[];
}): Record<string, unknown>[] {
  const base: Record<string, unknown> = { model: opts.model, prompt: opts.prompt };
  const refs = opts.refs ?? [];
  if (refs.length > 0) {
    const urls = refs.map((r) => r.dataUrl);
    base.image = urls[0];
    base.images = urls;
  }
  const bodies: Record<string, unknown>[] = [{ ...base }];
  for (const size of opts.sizes ?? []) {
    if (!size) continue;
    bodies.push({ ...base, size });
  }
  return bodies;
}

/** Chat + `modalities: image` — Gemini/GPT image models, not Flux-style generators. */
export function imageModelUsesChatFallback(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes('gemini') && m.includes('image')) return true;
  if (m.includes('gpt-image') || (m.includes('gpt') && m.includes('image'))) return true;
  return false;
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
  style?: PortraitStyle;
  signal?: AbortSignal;
}): Promise<SceneImageResult> {
  if (opts.provider.kind !== 'openai') {
    throw new AIError('Scene image generation needs an OpenAI-compatible provider (OpenRouter or Z.ai).');
  }
  const wantedRefs = opts.matchCast ? await prepareSceneImageRefs(opts.refs ?? []) : [];
  const canRef = wantedRefs.length > 0 && imageModelAcceptsRefs(opts.provider, opts.model);
  const refs = canRef ? wantedRefs : [];
  const prompt = sceneImagePrompt(opts.world, opts.location, opts.atmosphereNote, refs, opts.style);
  const url = await requestImage({
    provider: opts.provider,
    model: opts.model,
    prompt,
    refs,
    signal: opts.signal,
    sizes: imageSizeCandidates('landscape')
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

/** Generate a place photo from the location sheet and return a JPEG data URL. */
export async function generateLocationPhoto(opts: {
  world: World;
  location: Location;
  style?: PortraitStyle;
  signal?: AbortSignal;
}): Promise<string> {
  const resolved = configuredImageModel(opts.world);
  if (!resolved) {
    throw new AIError('Set an image model in Settings before generating a place photo.');
  }
  if (resolved.provider.kind !== 'openai') {
    throw new AIError('Place photo generation needs an OpenAI-compatible provider (OpenRouter or Z.ai).');
  }
  const result = await generateSceneImage({
    provider: resolved.provider,
    model: resolved.model,
    world: opts.world,
    location: opts.location,
    style: opts.style,
    signal: opts.signal
  });
  return result.dataUrl;
}

/**
 * A picture of one character from their sheet, as a JPEG data URL.
 * Head and shoulders by default. A full figure or a typed scene keeps their
 * main photo's face when the model can take it, and their written look always.
 */
export async function generateCharacterPortrait(opts: {
  world: World;
  character: Character;
  style: PortraitStyle;
  framing?: PortraitFraming;
  /** A scene or pose to put them in. */
  scene?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const framing = opts.framing ?? 'head';
  const scene = opts.scene?.trim() ?? '';
  if (scene) {
    // A scene is a one-person chapter picture: same face photo, same safety checks.
    const who = opts.character.name.trim();
    return generateChapterPicture({
      world: opts.world,
      characters: [opts.character],
      castIds: [opts.character.id],
      userPrompt: who && !scene.toLowerCase().includes(who.toLowerCase()) ? `${who}, ${scene}` : scene,
      style: opts.style,
      fullBody: framing === 'full',
      signal: opts.signal
    });
  }
  const resolvedFirst = configuredImageModel(opts.world);
  const face = framing === 'full' ? characterPortraits(opts.character)[0] : undefined;
  const useFace = !!face && !!resolvedFirst && imageModelAcceptsRefs(resolvedFirst.provider, resolvedFirst.model);
  const built = buildCharacterPortraitPrompt({
    framing,
    faceRef: useFace,
    name: opts.character.name,
    age: opts.character.age,
    appearance: opts.character.appearance,
    looks: opts.character.looks,
    mannerisms: opts.character.mannerisms,
    role: opts.character.role,
    contentNotes: opts.world.ai.contentNotes ?? '',
    mature: !!opts.world.ai.mature,
    style: opts.style
  });
  if (!built.ok) throw new AIError(built.error);

  // An adult, explicitly described character in an adult world goes to the adult
  // image route, the same as a chapter picture would. Anyone under 18 never does.
  const venice = veniceAdultProvider();
  const reading = subjectAgeReading(opts.character);
  const described = [allLooksText(opts.character), opts.character.mannerisms, opts.character.role].join('\n');
  // The adult route is photoreal. A comic portrait stays on the configured model unless there is none.
  const comicOnConfigured = opts.style === 'comic' && !!resolvedFirst && resolvedFirst.provider.kind === 'openai';
  if (venice && !comicOnConfigured && opts.world.ai.mature && reading.adult && !reading.minor && textLooksSexual(described)) {
    if (framing === 'full' && face) {
      const kept = buildCharacterPortraitPrompt({
        framing, faceRef: true,
        name: opts.character.name, age: opts.character.age, appearance: opts.character.appearance,
        looks: opts.character.looks,
        mannerisms: opts.character.mannerisms, role: opts.character.role,
        contentNotes: opts.world.ai.contentNotes ?? '', mature: true, style: opts.style
      });
      if (!kept.ok) throw new AIError(kept.error);
      const refs = await prepareSceneImageRefs([{ name: opts.character.name.trim() || 'them', dataUrl: face, kind: 'face' }]);
      const url = await requestVeniceFaceEdit({ provider: venice.provider, prompt: kept.prompt, refs, signal: opts.signal });
      return urlToJpegDataUrl(url, 1280, 0.8);
    }
    const request = veniceGenerateRequest({ baseUrl: venice.provider.baseUrl, prompt: built.prompt, tall: framing === 'full' });
    const res = await providerFetch(request.url, {
      method: 'POST',
      headers: imageHeaders(venice.provider),
      signal: opts.signal,
      body: JSON.stringify(request.body)
    });
    if (!res.ok) throw await imageHttpError(res, venice.provider);
    const url = await responseBytesToDataUrl(res);
    return framing === 'full'
      ? urlToJpegDataUrl(url, 1280, 0.8)
      : urlToJpegDataUrl(url, PORTRAIT_MAX_PX, PORTRAIT_JPEG_QUALITY);
  }

  const resolved = configuredImageModel(opts.world);
  if (!resolved) {
    throw new AIError('Set an image model in Settings before generating a portrait.');
  }
  if (resolved.provider.kind !== 'openai') {
    throw new AIError('Portrait generation needs an OpenAI-compatible provider (OpenRouter or Z.ai).');
  }
  const refs = useFace && face
    ? await prepareSceneImageRefs([{ name: opts.character.name.trim() || 'them', dataUrl: face, kind: 'face' }])
    : [];
  const url = await requestImage({
    provider: resolved.provider,
    model: resolved.model,
    prompt: built.prompt,
    refs,
    signal: opts.signal,
    sizes: imageSizeCandidates(framing === 'full' ? 'tall' : 'portrait')
  });
  return framing === 'full'
    ? urlToJpegDataUrl(url, 1280, 0.8)
    : urlToJpegDataUrl(url, PORTRAIT_MAX_PX, PORTRAIT_JPEG_QUALITY);
}

export const ADULT_PORTRAIT_ERROR = 'Generate a portrait first. This picture keeps that face.';

/**
 * True when the age line states an adult age (a number, a decade like
 * "thirties", or a plain word like "adult") and nothing in it reads as under 18.
 */
export function clearAdultAge(age: string): boolean {
  const reading = readAge(age);
  return reading.adult && !reading.minor;
}

export type AdultFaceEditPlan =
  | { action: 'current' }
  | { action: 'refuse'; error: string }
  | { action: 'edit' }
  | { action: 'generate' };

/**
 * Adult chapter pictures with a Venice key: edit existing portraits to keep
 * the faces, or write the picture from text when nobody has a portrait yet.
 * Anyone who reads as under 18 refuses a sexual prompt. Anything else stays
 * on the image model already configured.
 */
export function planAdultFaceEdit(opts: {
  mature: boolean;
  userPrompt: string;
  subjects: { name?: string; age: string; appearance?: string; role?: string; looks?: Character['looks'] }[];
  faceCount: number;
  veniceConfigured: boolean;
  /** A comic picture stays on the configured model: the adult route only draws photos. */
  style?: PortraitStyle;
}): AdultFaceEditPlan {
  // Sexual when the prompt says so, or when the people in it are described that way.
  const sexual = textLooksSexual(opts.userPrompt)
    || opts.subjects.some((subject) => textLooksSexual([allLooksText(subject), subject.role ?? ''].join('\n')));
  if (!opts.mature || !sexual || !opts.veniceConfigured) {
    return { action: 'current' };
  }
  const readings = opts.subjects.map((subject) => subjectAgeReading(subject));
  if (readings.some((r) => r.minor)) {
    return { action: 'refuse', error: minorRefusalMessage(opts.subjects) };
  }
  if (opts.style === 'comic') return { action: 'current' };
  if (opts.subjects.length === 0 || readings.some((r) => !r.adult)) {
    return { action: 'current' };
  }
  return opts.faceCount < 1 ? { action: 'generate' } : { action: 'edit' };
}

/** Venice text-to-image body. Explicit size, unblurred, raw JPEG back. */
export function veniceGenerateRequest(opts: {
  baseUrl: string;
  prompt: string;
  tall: boolean;
}): { url: string; body: Record<string, unknown> } {
  const base = opts.baseUrl.replace(/\/$/, '');
  return {
    url: `${base}/image/generate`,
    body: {
      model: VENICE_ADULT_GENERATE_MODEL,
      prompt: opts.prompt.slice(0, 7500),
      width: opts.tall ? 832 : 1024,
      height: opts.tall ? 1216 : 1024,
      format: 'jpeg',
      return_binary: true,
      safe_mode: false
    }
  };
}

export function stripImageDataUrl(src: string): string {
  const comma = src.indexOf(',');
  if (src.startsWith('data:') && comma >= 0) return src.slice(comma + 1);
  return src;
}

/** Venice edit body. One portrait uses /image/edit. More than one uses /image/multi-edit. */
export function veniceFaceEditRequest(opts: {
  baseUrl: string;
  prompt: string;
  images: string[];
}): { url: string; body: Record<string, unknown> } {
  const base = opts.baseUrl.replace(/\/$/, '');
  const raw = opts.images.map(stripImageDataUrl);
  if (raw.length <= 1) {
    return {
      url: `${base}/image/edit`,
      body: {
        model: VENICE_ADULT_EDIT_MODEL,
        prompt: opts.prompt,
        image: raw[0],
        safe_mode: false
      }
    };
  }
  return {
    url: `${base}/image/multi-edit`,
    body: {
      modelId: VENICE_ADULT_EDIT_MODEL,
      prompt: opts.prompt,
      images: raw,
      safe_mode: false
    }
  };
}

function veniceAdultProvider(): { provider: ProviderConfig; model: string } | null {
  const resolved = configuredMatureImageModel();
  if (!resolved || !isVeniceProvider(resolved.provider)) return null;
  return resolved;
}

function isVeniceProvider(provider: ProviderConfig): boolean {
  try {
    return new URL(provider.baseUrl).hostname.toLowerCase() === 'api.venice.ai';
  } catch {
    return false;
  }
}

/** A picture for the chapter. Uses main photos when the image model can take them. */
export async function generateChapterPicture(opts: {
  world: World;
  characters: Character[];
  castIds: string[];
  userPrompt: string;
  style: PortraitStyle;
  /** Ask for the whole figure even when the prompt does not say so. */
  fullBody?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const fullBody = !!opts.fullBody || wantsFullBody(opts.userPrompt);
  const subjects = chapterPictureSubjects({
    characters: opts.characters,
    castIds: opts.castIds,
    prompt: opts.userPrompt
  });
  const faces = chapterPictureFaces({
    characters: opts.characters,
    castIds: opts.castIds,
    prompt: opts.userPrompt
  });
  const venice = veniceAdultProvider();
  const adult = planAdultFaceEdit({
    mature: !!opts.world.ai.mature,
    userPrompt: opts.userPrompt,
    subjects,
    faceCount: faces.length,
    veniceConfigured: !!venice,
    style: opts.style
  });
  if (adult.action === 'refuse') throw new AIError(adult.error);
  if (adult.action === 'generate' && venice) {
    const plan = prepareChapterPicture({
      characters: opts.characters,
      castIds: opts.castIds,
      userPrompt: opts.userPrompt,
      style: opts.style,
      contentNotes: opts.world.ai.contentNotes ?? '',
      mature: true,
      provider: venice.provider,
      model: VENICE_ADULT_GENERATE_MODEL,
      fullBody
    });
    if (!plan.ok) throw new AIError(plan.error);
    const request = veniceGenerateRequest({ baseUrl: venice.provider.baseUrl, prompt: plan.prompt, tall: fullBody });
    const res = await providerFetch(request.url, {
      method: 'POST',
      headers: imageHeaders(venice.provider),
      signal: opts.signal,
      body: JSON.stringify(request.body)
    });
    if (!res.ok) throw await imageHttpError(res, venice.provider);
    return urlToJpegDataUrl(await responseBytesToDataUrl(res), 1280, 0.8);
  }
  if (adult.action === 'edit' && venice) {
    const plan = prepareChapterPicture({
      characters: opts.characters,
      castIds: opts.castIds,
      userPrompt: opts.userPrompt,
      style: opts.style,
      contentNotes: opts.world.ai.contentNotes ?? '',
      mature: true,
      provider: venice.provider,
      model: VENICE_ADULT_EDIT_MODEL,
      fullBody
    });
    if (!plan.ok) throw new AIError(plan.error);
    const refs = await prepareSceneImageRefs(plan.refs);
    const url = await requestVeniceFaceEdit({
      provider: venice.provider,
      prompt: plan.prompt,
      refs,
      signal: opts.signal
    });
    return urlToJpegDataUrl(url, 1280, 0.8);
  }

  const resolved = configuredImageModel(opts.world);
  const plan = prepareChapterPicture({
    characters: opts.characters,
    castIds: opts.castIds,
    userPrompt: opts.userPrompt,
    style: opts.style,
    contentNotes: opts.world.ai.contentNotes ?? '',
    mature: !!opts.world.ai.mature,
    provider: resolved?.provider ?? null,
    model: resolved?.model ?? null,
    fullBody
  });
  if (!plan.ok) throw new AIError(plan.error);
  if (!resolved) throw new AIError('Set an image model in Settings before making a picture.');
  if (resolved.provider.kind !== 'openai') {
    throw new AIError('Pictures need an OpenAI-compatible provider (OpenRouter or Z.ai).');
  }
  const refs = await prepareSceneImageRefs(plan.refs);
  const url = await requestImage({
    provider: resolved.provider,
    model: resolved.model,
    prompt: plan.prompt,
    refs,
    signal: opts.signal,
    sizes: imageSizeCandidates(fullBody ? 'tall' : 'square')
  });
  return urlToJpegDataUrl(url, 1280, 0.8);
}

async function requestVeniceFaceEdit(opts: {
  provider: ProviderConfig;
  prompt: string;
  refs: SceneImageRef[];
  signal?: AbortSignal;
}): Promise<string> {
  const request = veniceFaceEditRequest({
    baseUrl: opts.provider.baseUrl,
    prompt: opts.prompt,
    images: opts.refs.map((ref) => ref.dataUrl)
  });
  const res = await providerFetch(request.url, {
    method: 'POST',
    headers: imageHeaders(opts.provider),
    signal: opts.signal,
    body: JSON.stringify(request.body)
  });
  if (!res.ok) throw await imageHttpError(res, opts.provider);
  return responseBytesToDataUrl(res);
}

async function responseBytesToDataUrl(res: Response): Promise<string> {
  const blob = await res.blob();
  const type = blob.type || '';
  if (!blob.size || type.includes('json') || type.startsWith('text/')) {
    throw new AIError('The model did not return an image.');
  }
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new AIError('Could not read the generated image.'));
    reader.readAsDataURL(blob);
  });
}

async function imageHttpError(res: Response, provider?: ProviderConfig): Promise<AIError> {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message ?? body?.message ?? '';
  } catch { /* ignore */ }
  return new AIError(
    detail || `Image request failed (${res.status}).`,
    res.status,
    provider ? providerTagFor(provider) : undefined
  );
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

async function requestImage(opts: {
  provider: ProviderConfig;
  model: string;
  prompt: string;
  refs: SceneImageRef[];
  signal?: AbortSignal;
  sizes?: string[];
}): Promise<string> {
  const headers = imageHeaders(opts.provider);
  const urls = imageGenerationsUrls(opts.provider.baseUrl);
  const sizes = opts.sizes?.length ? opts.sizes : imageSizeCandidates('square');
  const bodies = imageGenerationsBodies({
    model: opts.model,
    prompt: opts.prompt,
    refs: opts.refs,
    sizes
  });

  let lastError: AIError | null = null;
  for (const imagesUrl of urls) {
    for (const body of bodies) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        const res = await providerFetch(imagesUrl, {
          method: 'POST',
          headers,
          signal: opts.signal,
          body: JSON.stringify(body)
        });
        if (res.status === 401 || res.status === 402 || res.status === 429) {
          throw await imageHttpError(res, opts.provider);
        }
        if (res.ok) {
          const parsed = await readImagePayload(res);
          if (parsed) return parsed;
          lastError = new AIError('The model did not return an image. Pick an image-capable model or upload one.');
          continue;
        }
        lastError = await imageHttpError(res, opts.provider);
      } catch (e) {
        if (e instanceof AIError && (e.status === 401 || e.status === 402 || e.status === 429)) throw e;
        if (isAbortError(e)) throw e;
        lastError = e instanceof AIError
          ? e
          : new AIError(e instanceof Error ? e.message : 'Image request failed.');
      }
    }
  }

  if (imageModelUsesChatFallback(opts.model)) {
    try {
      return await requestImageViaChat(opts);
    } catch (e) {
      if (isAbortError(e)) throw e;
      if (e instanceof AIError && (e.status === 401 || e.status === 402 || e.status === 429)) throw e;
      lastError = e instanceof AIError
        ? e
        : new AIError(e instanceof Error ? e.message : 'Image request failed.');
    }
  }

  if (lastError) throw lastError;
  throw new AIError('The model did not return an image. Pick an image-capable model or upload one.');
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
        { role: 'system', content: 'You generate a single image. Return only the image.' },
        { role: 'user', content: userContent }
      ],
      modalities: ['image', 'text'],
      max_tokens: 4096
    })
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 402 || res.status === 429) {
      throw await imageHttpError(res, opts.provider);
    }
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message ?? body?.message ?? '';
    } catch { /* ignore */ }
    throw new AIError(
      detail
        ? `Image generation failed (${res.status}). ${detail}`
        : `Image generation failed (${res.status}). Pick an image-capable model in Settings, or upload a photo instead.`,
      res.status,
      providerTagFor(opts.provider)
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
  if (isOpenRouterHost(provider.baseUrl)) {
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
  const item = data?.data?.[0] as { b64_json?: string; url?: string; media_type?: string } | undefined;
  const b64 = item?.b64_json;
  const url = item?.url;
  const media = item?.media_type?.startsWith('image/') ? item.media_type : 'image/png';
  if (b64) return `data:${media};base64,${b64}`;
  if (url) return url;
  return null;
}

async function urlToJpegDataUrl(src: string, maxDim = 1920, quality = 0.85): Promise<string> {
  if (src.startsWith('data:image/jpeg') && maxDim >= 1920) return src;
  const img = await loadImage(src);
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new AIError('Image processing is not available in this browser.');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
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
