import type { Pattern, TextureSlot } from '@seamer/pattern-model';
import { textureUrlCandidates } from '$lib/scene/textureUrl';

export const SSP_FORMAT = 'seamer-project' as const;
export const SSP_SCHEMA_VERSION = 2 as const;

const ASSET_SCHEME = 'ssp-asset://';

export interface SSPEmbeddedAsset {
  id: string;
  mimeType: string;
  byteLength: number;
  data: string;
  originalUrl: string;
}

export interface SSPManifest {
  schemaVersion: typeof SSP_SCHEMA_VERSION;
  minimumReaderSchemaVersion: number;
  createdAt: string;
  generator: {
    name: 'Seamer Studio';
    version: string;
  };
  source: {
    patternVersion: string;
    softwareVersion: string;
  };
  workspace: {
    viewMode: Pattern['viewMode'];
    lightingMode: string;
    cameraPosition: [number, number, number];
    controlsTarget: [number, number, number];
    cameraFov: number;
  };
  checkpoint: {
    kind: 'particle-positions';
    resumePolicy: 'zero-velocity';
    capturedAt: string;
    pieceCount: number;
    particleCount: number;
  };
  previewAssetId: string | null;
  assetCount: number;
  unresolvedAssets: string[];
  migrations: string[];
}

export interface SSPProjectEnvelope {
  format: typeof SSP_FORMAT;
  manifest: SSPManifest;
  pattern: Pattern;
  assets: SSPEmbeddedAsset[];
}

export interface SSPExportOptions {
  /** Current 3D viewport capture. Falls back to pattern.thumbnailUrl when omitted. */
  previewDataUrl?: string | null;
  /** SvelteKit base path used when resolving archived SeamScape texture mirrors. */
  basePath?: string;
  fetcher?: typeof fetch;
  /** Per-candidate timeout for remote/local asset capture. */
  assetFetchTimeoutMs?: number;
  now?: () => Date;
}

export interface SSPArchiveResult {
  blob: Blob;
  manifest: SSPManifest;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function dataUrlToAsset(url: string): Pick<SSPEmbeddedAsset, 'mimeType' | 'byteLength' | 'data'> | null {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma < 0) return null;
  const header = url.slice(5, comma);
  const mimeType = header.split(';')[0] || 'application/octet-stream';
  const payload = url.slice(comma + 1);
  try {
    if (header.split(';').includes('base64')) {
      return { mimeType, byteLength: atob(payload).length, data: payload };
    }
    const bytes = new TextEncoder().encode(decodeURIComponent(payload));
    return { mimeType, byteLength: bytes.byteLength, data: bytesToBase64(bytes) };
  } catch {
    return null;
  }
}

async function responseToAsset(response: Response): Promise<Pick<SSPEmbeddedAsset, 'mimeType' | 'byteLength' | 'data'>> {
  const blob = await response.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    mimeType: blob.type || response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
    byteLength: bytes.byteLength,
    data: bytesToBase64(bytes)
  };
}

function embeddedDataUrl(asset: SSPEmbeddedAsset): string {
  return `data:${asset.mimeType};base64,${asset.data}`;
}

function isEnvelope(value: unknown): value is SSPProjectEnvelope {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SSPProjectEnvelope>;
  return candidate.format === SSP_FORMAT && !!candidate.manifest && !!candidate.pattern && Array.isArray(candidate.assets);
}

function normalizeImportedPattern(pattern: Pattern): Pattern {
  const hasLegacySettledMesh = (pattern.pieces ?? []).some((piece) => {
    const settings = piece.settings3d as typeof piece.settings3d & { savedMeshSnapshot?: unknown };
    return settings?.savedMeshSnapshot != null;
  });
  if (hasLegacySettledMesh && pattern.body) {
    // The source Studio displays its model-pack mean avatar for these imported snapshots. Retain
    // the measurements for round-trip/export, but mark the display behavior so the same saved
    // surface is not hidden inside a newly reconstructed, measurement-driven body.
    pattern.body = { ...pattern.body, useLegacyDefaultAvatar: true };
  }
  pattern.pieces = (pattern.pieces ?? []).map((piece) => ({
    ...piece,
    settings3d: {
      ...piece.settings3d,
      savedPositions: piece.settings3d?.savedPositions ?? []
    }
  }));
  return pattern;
}

function restoreAssetReferences(pattern: Pattern, assets: SSPEmbeddedAsset[]): Pattern {
  const byId = new Map(assets.map((asset) => [asset.id, embeddedDataUrl(asset)]));
  const restore = (url: string | null | undefined): string => {
    if (!url) return '';
    if (!url.startsWith(ASSET_SCHEME)) return url;
    return byId.get(url.slice(ASSET_SCHEME.length)) ?? url;
  };
  const restoreSlot = (slot: TextureSlot | null): TextureSlot | null => slot && ({
    ...slot,
    url: restore(slot.url),
    normalUrl: restore(slot.normalUrl),
    opacityUrl: restore(slot.opacityUrl)
  });
  return {
    ...pattern,
    materials: (pattern.materials ?? []).map((material) => ({
      ...material,
      frontTexture: restoreSlot(material.frontTexture),
      backTexture: restoreSlot(material.backTexture)
    })),
    images: (pattern.images ?? []).map((image) => ({ ...image, url: restore(image.url) })),
    thumbnailUrl: pattern.thumbnailUrl ? restore(pattern.thumbnailUrl) : pattern.thumbnailUrl
  };
}

async function gzipJson(value: unknown): Promise<Blob> {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'));
  return await new Response(stream).blob();
}

async function readCompressedJson(blob: Blob): Promise<unknown> {
  const signature = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const format: CompressionFormat = signature[0] === 0x1f && signature[1] === 0x8b ? 'gzip' : 'deflate';
  const text = await new Response(blob.stream().pipeThrough(new DecompressionStream(format))).text();
  return JSON.parse(text) as unknown;
}

/** Build a versioned, self-contained SSP v2 archive. Unfetchable URLs remain linked and are listed
 *  in manifest.unresolvedAssets so callers can disclose that the archive is only partially offline. */
export async function createSSPArchive(pattern: Pattern, options: SSPExportOptions = {}): Promise<SSPArchiveResult> {
  const archived = structuredClone(pattern);
  const assets: SSPEmbeddedAsset[] = [];
  const unresolvedAssets = new Set<string>();
  const refs = new Map<string, string>();
  const contentRefs = new Map<string, string>();
  const fetcher = options.fetcher ?? globalThis.fetch;
  const fetchTimeoutMs = options.assetFetchTimeoutMs ?? 8_000;

  const embed = async (url: string | null | undefined): Promise<string> => {
    if (!url) return '';
    if (url.startsWith(ASSET_SCHEME)) return url;
    const known = refs.get(url);
    if (known) return known;

    let body = dataUrlToAsset(url);
    if (!body && fetcher) {
      const candidates = url.startsWith('blob:')
        ? [url]
        : textureUrlCandidates(url, options.basePath ?? '');
      for (const candidate of candidates) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
        try {
          const response = await fetcher(candidate, { signal: controller.signal });
          if (!response.ok) continue;
          body = await responseToAsset(response);
          break;
        } catch {
          // Try the next local mirror/original URL. A final failure is recorded below.
        } finally {
          clearTimeout(timer);
        }
      }
    }
    if (!body) {
      unresolvedAssets.add(url);
      return url;
    }

    const contentKey = `${body.mimeType}\0${body.data}`;
    const duplicate = contentRefs.get(contentKey);
    if (duplicate) {
      refs.set(url, duplicate);
      return duplicate;
    }

    const id = `asset-${assets.length + 1}`;
    const asset: SSPEmbeddedAsset = { id, originalUrl: url, ...body };
    assets.push(asset);
    const ref = `${ASSET_SCHEME}${id}`;
    refs.set(url, ref);
    contentRefs.set(contentKey, ref);
    return ref;
  };

  const embedSlot = async (slot: TextureSlot | null): Promise<TextureSlot | null> => slot && ({
    ...slot,
    url: slot.sourceMode === 'linked' ? slot.url : await embed(slot.url),
    normalUrl: slot.normalSourceMode === 'linked' ? slot.normalUrl : await embed(slot.normalUrl),
    opacityUrl: slot.opacitySourceMode === 'linked' ? slot.opacityUrl : await embed(slot.opacityUrl)
  });
  for (const material of archived.materials ?? []) {
    material.frontTexture = await embedSlot(material.frontTexture);
    material.backTexture = await embedSlot(material.backTexture);
  }
  for (const image of archived.images ?? []) image.url = await embed(image.url);

  const preview = options.previewDataUrl ?? archived.thumbnailUrl ?? null;
  const previewRef = preview ? await embed(preview) : null;
  archived.thumbnailUrl = previewRef;

  const capturedAt = (options.now?.() ?? new Date()).toISOString();
  const particleCount = (archived.pieces ?? []).reduce(
    (count, piece) => count + Math.floor((piece.settings3d.savedPositions?.length ?? 0) / 5),
    0
  );
  const previewAssetId = previewRef?.startsWith(ASSET_SCHEME)
    ? previewRef.slice(ASSET_SCHEME.length)
    : null;
  const manifest: SSPManifest = {
    schemaVersion: SSP_SCHEMA_VERSION,
    minimumReaderSchemaVersion: 2,
    createdAt: capturedAt,
    generator: { name: 'Seamer Studio', version: archived.softwareVersion || '0.1.0' },
    source: {
      patternVersion: archived.versionName || String(archived.versionNumber ?? ''),
      softwareVersion: archived.softwareVersion || ''
    },
    workspace: {
      viewMode: archived.viewMode,
      lightingMode: archived.settings3d.lightingMode,
      cameraPosition: archived.settings3d.cameraPosition,
      controlsTarget: archived.settings3d.controlsTarget,
      cameraFov: archived.settings3d.cameraFov
    },
    checkpoint: {
      kind: 'particle-positions',
      resumePolicy: 'zero-velocity',
      capturedAt,
      pieceCount: archived.pieces.filter((piece) => piece.settings3d.savedPositions?.length).length,
      particleCount
    },
    previewAssetId,
    assetCount: assets.length,
    unresolvedAssets: [...unresolvedAssets],
    migrations: []
  };
  const envelope: SSPProjectEnvelope = { format: SSP_FORMAT, manifest, pattern: archived, assets };
  return { blob: await gzipJson(envelope), manifest };
}

/** Whole pattern → SSP v2 gzip archive. Kept as the compact compatibility API for existing callers. */
export async function patternToSSP(pattern: Pattern, options: SSPExportOptions = {}): Promise<Blob> {
  return (await createSSPArchive(pattern, options)).blob;
}

/** Read SSP v2 plus gzip Pattern roots and legacy SeamScape zlib/deflate projects. */
export async function sspToPattern(blob: Blob): Promise<Pattern> {
  const decoded = await readCompressedJson(blob);
  if (!isEnvelope(decoded)) return normalizeImportedPattern(decoded as Pattern);
  const schemaVersion = Number(decoded.manifest.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error('This SSP has an invalid or missing schema version.');
  }
  if (schemaVersion > SSP_SCHEMA_VERSION) {
    throw new Error(`This project uses SSP schema ${decoded.manifest.schemaVersion}; this Studio supports up to ${SSP_SCHEMA_VERSION}.`);
  }
  const restored = restoreAssetReferences(decoded.pattern, decoded.assets);
  const workspace = decoded.manifest.workspace ?? {
    viewMode: restored.viewMode,
    lightingMode: restored.settings3d.lightingMode,
    cameraPosition: restored.settings3d.cameraPosition,
    controlsTarget: restored.settings3d.controlsTarget,
    cameraFov: restored.settings3d.cameraFov
  };
  return normalizeImportedPattern({
    ...restored,
    viewMode: workspace.viewMode ?? restored.viewMode,
    settings3d: {
      ...restored.settings3d,
      lightingMode: workspace.lightingMode ?? restored.settings3d.lightingMode,
      cameraPosition: workspace.cameraPosition ?? restored.settings3d.cameraPosition,
      controlsTarget: workspace.controlsTarget ?? restored.settings3d.controlsTarget,
      cameraFov: workspace.cameraFov ?? restored.settings3d.cameraFov
    }
  });
}

/** Test/diagnostic reader that exposes the v2 manifest without changing the normal import API. */
export async function readSSPEnvelope(blob: Blob): Promise<SSPProjectEnvelope | null> {
  const decoded = await readCompressedJson(blob);
  return isEnvelope(decoded) ? decoded : null;
}
