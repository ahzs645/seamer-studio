#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createServer } from 'vite';

const [archivePath, outputPath] = process.argv.slice(2);
if (!archivePath || !outputPath) {
  console.error('Usage: node scripts/export-seamscape-archive.mjs <archive-dir> <output-dir>');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(archivePath, 'manifest.json'), 'utf8'));
const canonicalPencilSkirt = JSON.parse(readFileSync('static/templates/pencil-skirt.json', 'utf8'));
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
mkdirSync(outputPath, { recursive: true });

try {
  const imports = await server.ssrLoadModule('/src/lib/utils/importSimplePattern.ts');
  const exported = [];
  for (const archived of manifest.patterns) {
    const folder = join(archivePath, archived.folder);
    const legacy = JSON.parse(readFileSync(join(folder, 'project.json'), 'utf8'));
    if (legacy.enable3d === false) continue;
    const raw = JSON.parse(readFileSync(join(folder, 'raw.json'), 'utf8'));
    const canonical = imports.isCanonicalPencilSkirtExport(raw) ? canonicalPencilSkirt : undefined;
    const pattern = imports.convertSimplePatternWithLegacyProject(raw, legacy, canonical);
    imports.assertPatternBuildable3d(pattern);
    const stem = basename(archived.folder).replace(/--$/, '');
    const filename = `${stem}.seamer.json`;
    const sspFilename = `${stem}.seamer.ssp`;
    const serialized = `${JSON.stringify(pattern, null, 2)}\n`;
    writeFileSync(join(outputPath, filename), serialized);
    writeFileSync(join(outputPath, sspFilename), gzipSync(serialized));
    exported.push({
      order: archived.order,
      name: archived.name,
      filename,
      sspFilename,
      pieces: pattern.pieces.length,
      seams: pattern.seams.length
    });
  }
  writeFileSync(join(outputPath, 'manifest.json'), `${JSON.stringify({ exported }, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, exported }, null, 2));
} finally {
  await server.close();
}
