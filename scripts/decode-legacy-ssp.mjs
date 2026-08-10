#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, inflateSync } from 'node:zlib';
import { basename } from 'node:path';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/decode-legacy-ssp.mjs input.ssp output.json');
  process.exitCode = 1;
} else {
  const compressed = readFileSync(inputPath);
  const isGzip = compressed[0] === 0x1f && compressed[1] === 0x8b;
  const decoded = isGzip ? gunzipSync(compressed) : inflateSync(compressed);
  const pattern = JSON.parse(decoded.toString('utf8'));
  writeFileSync(outputPath, `${JSON.stringify(pattern, null, 2)}\n`);
  console.log(`Decoded ${basename(inputPath)}: ${pattern.pieces?.length ?? 0} pieces, ${pattern.seams?.length ?? 0} seams → ${outputPath}`);
}
