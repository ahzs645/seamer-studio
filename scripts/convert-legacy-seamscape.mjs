#!/usr/bin/env node
import { gunzipSync, gzipSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const [legacyPath, rawPath, outputPath] = process.argv.slice(2);
if (!legacyPath || !rawPath || !outputPath) {
  console.error('Usage: node scripts/convert-legacy-seamscape.mjs <legacy.ssp|json> <raw.json> <output.seamer.json>');
  process.exit(1);
}

const legacyBytes = readFileSync(legacyPath);
let legacyText;
if (legacyBytes[0] === 0x1f && legacyBytes[1] === 0x8b) legacyText = gunzipSync(legacyBytes).toString('utf8');
else if (legacyBytes[0] === 0x78) legacyText = inflateSync(legacyBytes).toString('utf8');
else legacyText = legacyBytes.toString('utf8');

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const module = await server.ssrLoadModule('/src/lib/utils/importSimplePattern.ts');
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  const canonical = module.isCanonicalPencilSkirtExport(raw)
    ? JSON.parse(readFileSync('static/templates/pencil-skirt.json', 'utf8'))
    : undefined;
  const pattern = module.convertSimplePatternWithLegacyProject(
    raw,
    JSON.parse(legacyText),
    canonical
  );
  module.assertPatternBuildable3d(pattern);
  const json = `${JSON.stringify(pattern, null, 2)}\n`;
  writeFileSync(outputPath, json);
  const sspPath = outputPath.replace(/(?:\.seamer)?\.json$/i, '.seamer.ssp');
  writeFileSync(sspPath, gzipSync(json));
  console.log(`Wrote ${outputPath}`);
  console.log(`Wrote ${sspPath}`);
  console.log(`${pattern.pieces.length} pieces, ${pattern.seams.length} seams, ${pattern.materials.length} materials`);
  console.log(`${pattern.pieces.reduce((total, piece) => total + piece.settings3d.savedPositions.length / 5, 0)} cached 3D vertices`);
} finally {
  await server.close();
}
