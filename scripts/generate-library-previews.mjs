// Regenerate deterministic outline thumbnails from the shipped native SSP documents.
// These depict saved draft outlines, not garment fit or simulation results.
import { createServer } from 'vite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const model = await server.ssrLoadModule('@seamer/pattern-model');
  const { referenceSspTemplates } = await server.ssrLoadModule('/src/lib/data/referenceSspTemplates.ts');
  mkdirSync('static/templates/previews', { recursive: true });
  for (const sample of referenceSspTemplates) {
    const pattern = JSON.parse(gunzipSync(readFileSync(`static/templates/${sample.file}`)).toString());
    const paths = model.indexPaths(pattern), points = model.indexPoints(pattern);
    const polygons = pattern.pieces.map(piece => model.pieceWorldOutline(pattern, piece, paths, points)).filter(poly => poly.length > 2);
    const all = polygons.flat();
    if (!all.length) throw new Error(`Sample ${sample.key} has no outline for its preview.`);
    const xs = all.map(point => point.x), ys = all.map(point => point.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const width = maxX - minX + 40, height = maxY - minY + 40, stroke = Math.max(width, height) / 350;
    const outlines = polygons.map(poly => `<path d="${poly.map((point, index) => `${index ? 'L' : 'M'}${(point.x - minX + 20).toFixed(2)},${(maxY - point.y + 20).toFixed(2)}`).join(' ')}Z"/>`).join('');
    writeFileSync(`static/templates/previews/${sample.key}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(2)} ${height.toFixed(2)}"><rect width="100%" height="100%" fill="#f8fafc"/><g fill="#cbd5e1" fill-opacity=".55" stroke="#334155" stroke-width="${stroke.toFixed(2)}" stroke-linejoin="round">${outlines}</g></svg>`);
  }
  process.stdout.write(`Generated ${referenceSspTemplates.length} native pattern outline previews.\n`);
} finally { await server.close(); }
