import type { TextureAssetSourceMode, TextureSlot } from '@seamer/pattern-model';
import { textureUrlCandidates } from '$lib/scene/textureUrl';

export type TextureMapKind = 'base' | 'normal' | 'opacity';

export const TEXTURE_MAP_FIELDS = {
  base: { url: 'url', mode: 'sourceMode', source: 'sourceUrl', scale: 'scale' },
  normal: { url: 'normalUrl', mode: 'normalSourceMode', source: 'normalSourceUrl', scale: 'normalMapScale' },
  opacity: { url: 'opacityUrl', mode: 'opacitySourceMode', source: 'opacitySourceUrl', scale: 'opacityMapScale' }
} as const;

export function textureMapMode(slot: TextureSlot, kind: TextureMapKind): TextureAssetSourceMode | 'none' {
  const fields = TEXTURE_MAP_FIELDS[kind];
  if (!slot[fields.url]) return 'none';
  const explicit = slot[fields.mode];
  if (explicit) return explicit;
  return slot[fields.url]?.startsWith('data:') ? 'uploaded' : 'downloaded';
}

export function textureMapSourceUrl(slot: TextureSlot, kind: TextureMapKind): string {
  const fields = TEXTURE_MAP_FIELDS[kind];
  return slot[fields.source] || (slot[fields.url]?.startsWith('data:') ? '' : slot[fields.url]) || '';
}

export function linkedTexturePatch(kind: TextureMapKind, url: string): Partial<TextureSlot> {
  const fields = TEXTURE_MAP_FIELDS[kind];
  return { [fields.url]: url.trim(), [fields.mode]: 'linked', [fields.source]: url.trim() } as Partial<TextureSlot>;
}

export function storedTexturePatch(
  kind: TextureMapKind,
  dataUrl: string,
  mode: Extract<TextureAssetSourceMode, 'uploaded' | 'downloaded'>,
  sourceUrl = ''
): Partial<TextureSlot> {
  const fields = TEXTURE_MAP_FIELDS[kind];
  return {
    [fields.url]: dataUrl,
    [fields.mode]: mode,
    [fields.source]: sourceUrl.trim()
  } as Partial<TextureSlot>;
}

export function clearTexturePatch(kind: TextureMapKind): Partial<TextureSlot> {
  const fields = TEXTURE_MAP_FIELDS[kind];
  return { [fields.url]: '', [fields.mode]: undefined, [fields.source]: undefined } as Partial<TextureSlot>;
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

/** Download an image through the same local-mirror fallback used by the renderer. */
export async function downloadTextureUrl(
  url: string,
  options: { basePath?: string; timeoutMs?: number; maxBytes?: number; fetcher?: typeof fetch } = {}
): Promise<string> {
  const source = url.trim();
  if (!source) throw new Error('Enter an image URL first.');
  const fetcher = options.fetcher ?? globalThis.fetch;
  const errors: string[] = [];
  for (const candidate of textureUrlCandidates(source, options.basePath ?? '')) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
    try {
      const response = await fetcher(candidate, { signal: controller.signal });
      if (!response.ok) { errors.push(`${response.status} ${candidate}`); continue; }
      const blob = await response.blob();
      const mime = blob.type.split(';')[0];
      if (mime && !mime.startsWith('image/')) throw new Error(`URL returned ${mime}, not an image.`);
      if (blob.size > (options.maxBytes ?? 25 * 1024 * 1024)) throw new Error('Image is larger than 25 MB.');
      return await blobToDataUrl(blob);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Could not download that image${errors[0] ? ` (${errors[0]})` : ''}.`);
}
