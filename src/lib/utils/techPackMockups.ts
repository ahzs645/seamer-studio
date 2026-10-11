import { artworkPlacementProblem, artworkSourceProblem, captureColorwayPieces, type NamedColorway, type Pattern } from '@seamer/pattern-model';
import { indexPaths, indexPoints, pieceOutline } from '@seamer/pattern-model/utils/patternGeometry';
import { artworkRepeatTiles, artworkSurfaceProblem } from './artworkSurface';
import { textureUrlCandidates } from '$lib/scene/textureUrl';
import { checkedTechPackCapture } from './techPackCapture';
import { artworkImageMatchesSource } from '$lib/scene/pieceTextureImages';
import { drawPieceArtwork } from '$lib/scene/pieceArtworkTexture';

export interface TechPackMockup { name: string; dataUrl: string; warnings: string[]; }
const color = (value: string | undefined) => /^#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?$/i.test(value ?? '') ? value! : '#d4d4d8';
/** Match variant activation: geometry added after a saved variant retains its live fabric.
 * Explicit saved overrides still win, including missing/unassigned fabric references. */
export function resolveTechPackColorwayPieces(pattern: Pattern, variant: NamedColorway): NamedColorway['pieces'] {
  const current = captureColorwayPieces(pattern);
  return variant.id === pattern.colorways?.activeId ? { ...variant.pieces, ...current } : { ...current, ...variant.pieces };
}
/** Fresh flat production references. No saved project thumbnail or simulated fit is substituted. */
export async function renderTechPackMockups(pattern: Pattern): Promise<TechPackMockup[]> {
  const images = new Map<string, HTMLImageElement>();
  const sourceWarnings: string[] = [];
  for (const artwork of pattern.artwork ?? []) {
    const problem = artworkSourceProblem(artwork) ?? artworkPlacementProblem(artwork) ?? artworkSurfaceProblem(artwork);
    if (problem) { sourceWarnings.push(`${artwork.name}: ${problem}`); continue; }
    try {
      const image = new Image(); image.src = artwork.dataUrl; await image.decode();
      if (!artworkImageMatchesSource(image, artwork)) throw Error('Decoded image dimensions do not match.');
      images.set(artwork.dataUrl, image);
    } catch { sourceWarnings.push(`${artwork.name}: image unavailable or dimensions do not match.`); }
  }
  const fabricImages = new Map<string, HTMLImageElement>();
  const textureProblems = new Map<string, string>();
  const { base } = await import('$app/paths');
  for (const url of new Set(pattern.materials.map(material => material.frontTexture?.url).filter((url): url is string => !!url))) {
    for (const candidate of textureUrlCandidates(url, base)) {
      let objectUrl: string | undefined;
      try {
        const embedded = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(candidate);
        const local = new URL(candidate, window.location.origin);
        if (!embedded && !['http:', 'https:'].includes(local.protocol)) continue;
        let source = candidate;
        if (embedded) { if (candidate.length > 4_000_000 || candidate.startsWith('data:image/png;') && !checkedTechPackCapture(candidate)) continue; }
        else {
          const response = await fetch(local, { signal: AbortSignal.timeout(3000), credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
          if (!response.ok || !/^image\/(?:png|jpeg|webp)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) continue;
          if (Number(response.headers.get('content-length')) > 3_000_000 || !response.body) { await response.body?.cancel(); continue; }
          const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
          try {
            while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 3_000_000) { await reader.cancel(); throw Error('Fabric source exceeds 3 MB.'); } chunks.push(next.value); }
          } finally { reader.releaseLock(); }
          const joined = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; } const bytes = joined.buffer;
          if (/^image\/png(?:;|$)/i.test(response.headers.get('content-type') ?? '')) { const header = new Uint8Array(bytes).slice(0, 33); if (!checkedTechPackCapture(`data:image/png;base64,${btoa(String.fromCharCode(...header))}`)) continue; }
          objectUrl = URL.createObjectURL(new Blob([bytes], { type: response.headers.get('content-type')! })); source = objectUrl;
        }
        const image = new Image(); image.src = source; await image.decode();
        if (image.naturalWidth < 1 || image.naturalHeight < 1 || image.naturalWidth > 8192 || image.naturalHeight > 8192 || image.naturalWidth * image.naturalHeight > 16 * 1024 * 1024) continue;
        fabricImages.set(url, image); break;
      } catch { /* Try the next documented source; linked remote rasters require CORS and never receive credentials or a referrer. */ }
      finally { if (objectUrl) URL.revokeObjectURL(objectUrl); }
    }
    if (!fabricImages.has(url)) textureProblems.set(url, 'Diffuse fabric texture unavailable in this document, deployment or linked provider (including CORS restrictions). Flat tint shown; download/embed the raster fabric source before export.');
  }
  const current = captureColorwayPieces(pattern);
  const variants = pattern.colorways?.variants.length ? pattern.colorways.variants.map(variant => ({
    name: variant.name, treatments: resolveTechPackColorwayPieces(pattern, variant)
  })) : [{ name: 'Current appearance', treatments: current }];
  const points = indexPoints(pattern), paths = indexPaths(pattern);
  return variants.map(variant => {
    const warnings = [...sourceWarnings, ...Object.keys(variant.treatments).filter(id => !pattern.pieces.some(piece => piece.id === id)).map(id => `Missing colorway piece: ${id}`)];
    const canvas = document.createElement('canvas');
    canvas.width = 1200; canvas.height = Math.max(350, Math.ceil(pattern.pieces.length / 3) * 350);
    const context = canvas.getContext('2d'); if (!context) throw Error('Canvas rendering is unavailable.');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    pattern.pieces.forEach((piece, index) => {
      const boundary = pieceOutline(pattern, piece, paths, points, 3);
      const outline = boundary.length >= 3 ? boundary : (piece.legacyGeometry?.boundary ?? []).flat().map(([x, y]) => ({ x, y }));
      const x0 = (index % 3) * 400, y0 = Math.floor(index / 3) * 350;
      context.fillStyle = '#172033'; context.font = '16px sans-serif'; context.fillText(piece.name.slice(0, 45), x0 + 18, y0 + 28);
      if (outline.length < 3 || !outline.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) { warnings.push(`${piece.name}: no valid outline.`); return; }
      const minX = Math.min(...outline.map(p => p.x)), maxX = Math.max(...outline.map(p => p.x));
      const minY = Math.min(...outline.map(p => p.y)), maxY = Math.max(...outline.map(p => p.y));
      const w = maxX - minX, h = maxY - minY;
      if (!(w > 0 && h > 0)) { warnings.push(`${piece.name}: degenerate outline.`); return; }
      const scale = Math.min(350 / w, 270 / h), width = w * scale, height = h * scale;
      const left = x0 + (400 - width) / 2, top = y0 + 50 + (270 - height) / 2;
      const treatment = variant.treatments[piece.id];
      const material = pattern.materials.find(m => m.id === treatment?.materialId);
      if (material?.frontTexture?.url && textureProblems.has(material.frontTexture.url)) warnings.push(`${piece.name}: ${textureProblems.get(material.frontTexture.url)}`);
      if (!treatment || !material) warnings.push(`${piece.name}: missing colorway fabric assignment.`);
      context.save(); context.translate(left, top);
      context.beginPath(); outline.forEach((p, i) => { const x = (p.x - minX) * scale, y = height - (p.y - minY) * scale; if (!i) context.moveTo(x, y); else context.lineTo(x, y); }); context.closePath();
      context.fillStyle = color(treatment?.frontColor ?? material?.frontTexture?.color); context.fill(); context.clip();
      const printCanvas = document.createElement('canvas'); printCanvas.width = Math.max(1, Math.round(width)); printCanvas.height = Math.max(1, Math.round(height));
      const printContext = printCanvas.getContext('2d');
      if (printContext) {
        printContext.fillStyle = color(treatment?.frontColor ?? material?.frontTexture?.color); printContext.fillRect(0, 0, printCanvas.width, printCanvas.height);
        const fabric = material?.frontTexture?.url ? fabricImages.get(material.frontTexture.url) : undefined;
        if (fabric && material?.frontTexture) {
          const tiled = printContext.createPattern(fabric, 'repeat');
          if (tiled) {
            const origin = points.get(piece.originPoint), pixelsPerMm = printCanvas.width / w;
            const tileMm = material.frontTexture.scale > 0 ? material.frontTexture.scale : 100;
            const factor = tileMm * pixelsPerMm / fabric.naturalWidth;
            const grainDeg = Math.atan2(piece.grainVector.y, piece.grainVector.x) * 180 / Math.PI;
            tiled.setTransform(new DOMMatrix().translateSelf(((origin?.x ?? 0) - minX) * pixelsPerMm, printCanvas.height - ((origin?.y ?? 0) - minY) * pixelsPerMm).rotateSelf(90 - grainDeg).scaleSelf(factor));
            printContext.fillStyle = tiled; printContext.fillRect(0, 0, printCanvas.width, printCanvas.height);
            printContext.globalCompositeOperation = 'multiply'; printContext.fillStyle = color(treatment?.frontColor ?? material.frontTexture.color); printContext.fillRect(0, 0, printCanvas.width, printCanvas.height); printContext.globalCompositeOperation = 'source-over';
          }
        }
        for (const artwork of (pattern.artwork ?? []).filter(a => a.pieceId === piece.id)) { try { artworkRepeatTiles(artwork, { minX, maxX, minY, maxY }); } catch (error) { warnings.push(`${artwork.name}: ${error instanceof Error ? error.message : 'Repeat unavailable.'}`); } }
        drawPieceArtwork(printContext, (pattern.artwork ?? []).filter(a => a.pieceId === piece.id), images, { uMin: minX, vMin: minY, wMM: w, hMM: h }, printCanvas.width, printCanvas.height);
        context.drawImage(printCanvas, 0, 0, width, height);
      }

      context.restore();
      context.fillStyle = '#596579'; context.font = '12px sans-serif'; context.fillText(`${Math.round(w)} × ${Math.round(h)} mm · front face`, x0 + 18, y0 + 335);
    });
    return { name: variant.name, dataUrl: canvas.toDataURL('image/png'), warnings };
  });
}
