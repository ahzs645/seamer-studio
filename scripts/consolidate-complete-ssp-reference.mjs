#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

const [referenceArg, convertedArg, downloadsArg] = process.argv.slice(2);
if (!referenceArg || !convertedArg || !downloadsArg) {
  console.error('Usage: node scripts/consolidate-complete-ssp-reference.mjs <reference-dir> <prior-converted-dir> <downloads-dir>');
  process.exit(1);
}

const referencePath = resolve(referenceArg);
const convertedPath = resolve(convertedArg);
const downloadsPath = resolve(downloadsArg);
if (!existsSync(join(referencePath, 'manifest.json')) || !existsSync(join(referencePath, 'loose-file-inventory.json'))) {
  throw new Error(`Not a complete SSP reference folder: ${referencePath}`);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
const toPosix = (value) => value.split(sep).join('/');
const inventory = JSON.parse(readFileSync(join(referencePath, 'loose-file-inventory.json'), 'utf8')).files;
const historical = inventory.filter((file) => file.status === 'superseded-or-different' && file.role === 'native-project');
const historicalRoot = join(referencePath, 'HISTORICAL-SEAMER-EXPORTS');
mkdirSync(historicalRoot, { recursive: true });

const sourceFolders = {
  'prior-converted': convertedPath,
  'downloads-root': downloadsPath
};
const copied = [];
for (const record of historical) {
  const sourceFolder = sourceFolders[record.sourceSet];
  if (!sourceFolder) throw new Error(`Unknown source set: ${record.sourceSet}`);
  const source = join(sourceFolder, record.file);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Missing historical export: ${source}`);
  const bytes = readFileSync(source);
  const actualSha = sha256(bytes);
  if (actualSha !== record.sha256) throw new Error(`Source changed since the audit: ${source}`);
  const destinationFolder = join(historicalRoot, record.sourceSet);
  const destination = join(destinationFolder, record.file);
  mkdirSync(destinationFolder, { recursive: true });
  if (existsSync(destination)) {
    if (sha256(readFileSync(destination)) !== actualSha) throw new Error(`Refusing to overwrite a different file: ${destination}`);
  } else {
    copyFileSync(source, destination);
  }
  copied.push({
    sourceSet: record.sourceSet,
    file: record.file,
    role: record.role,
    bytes: bytes.length,
    sha256: actualSha,
    matchedProjectOrder: record.matchedProjectOrder,
    matchedProject: record.matchedProject,
    referenceFolder: record.referenceFolder,
    archivedAs: `HISTORICAL-SEAMER-EXPORTS/${record.sourceSet}/${record.file}`,
    status: 'preserved-historical-export'
  });
}

const coverage = [
  {
    source: 'Downloads root SSP/JSON files',
    decision: 'accounted-for',
    detail: 'Original legacy SSP and Raw JSON exports are semantic matches to the 21 complete project bundles. Distinct older Seamer exports are copied under HISTORICAL-SEAMER-EXPORTS.'
  },
  {
    source: 'SeamScape Converted SSP 2026-08-09',
    decision: 'historical-exports-preserved',
    detail: 'All 12 older Seamer SSP/JSON conversion pairs are retained separately from the freshly generated canonical files.'
  },
  {
    source: 'SeamScape Public Patterns 2026-08-09',
    decision: 'already-canonical-source',
    detail: 'This is the 20-project public archive used to build the complete project bundles.'
  },
  {
    source: 'SeamScape Public Patterns 2026-08-09.zip',
    decision: 'duplicate-container',
    detail: 'ZIP duplicates the public-pattern folder; extra SSP/JSON entries are macOS AppleDouble metadata.'
  },
  {
    source: 'SeamScape Native SSP Comparison 2026-08-09',
    decision: 'comparison-media-only',
    detail: 'Contains screenshots/comparison media and no SSP or JSON projects.'
  },
  {
    source: 'seamscape.com and seamscape.com.zip',
    decision: 'site-runtime-reference',
    detail: 'Contains the mirrored application/runtime model JSON, not standalone pattern-project exports.'
  },
  {
    source: 'Reference',
    decision: 'unrelated-reference-data',
    detail: 'The JSON files belong to TCG scanner datasets/sessions; no SeamScape pattern projects were found.'
  },
  {
    source: 'Unrelated MP4',
    decision: 'excluded',
    detail: 'Not project or reference data.'
  }
];

const completedAt = new Date().toISOString();
const consolidation = {
  formatVersion: 1,
  completedAt,
  policy: 'Keep canonical legacy/raw/current-native bundles authoritative; preserve semantically different older Seamer outputs as historical exports; do not copy byte/semantic duplicates or unrelated files.',
  summary: {
    historicalFilesPreserved: copied.length,
    historicalSspFilesPreserved: copied.filter((file) => /\.ssp$/i.test(file.file)).length,
    historicalJsonFilesPreserved: copied.filter((file) => /\.json$/i.test(file.file)).length,
    sourceGroupsAudited: coverage.length
  },
  coverage,
  files: copied
};
writeFileSync(join(referencePath, 'consolidation-inventory.json'), jsonText(consolidation));

const coverageRows = coverage.map((item) =>
  `| ${item.source.replaceAll('|', '\\|')} | ${item.decision} | ${item.detail.replaceAll('|', '\\|')} |`
).join('\n');
const fileRows = copied.map((item) =>
  `| ${item.sourceSet} | ${item.file.replaceAll('|', '\\|')} | ${item.matchedProjectOrder ?? '—'} | ${item.matchedProject?.replaceAll('|', '\\|') ?? '—'} | ${item.sha256} |`
).join('\n');
writeFileSync(join(referencePath, 'CONSOLIDATION-AUDIT.md'), `# SSP consolidation audit\n\n` +
  `Completed ${completedAt}. Canonical project bundles were not changed. Older/different Seamer ` +
  `conversion outputs are retained under \`HISTORICAL-SEAMER-EXPORTS/\` for regression research.\n\n` +
  `## Source coverage\n\n| Source | Decision | Detail |\n|---|---|---|\n${coverageRows}\n\n` +
  `## Historical files preserved (${copied.length})\n\n` +
  `| Source set | File | Project # | Project | SHA-256 |\n|---|---|---:|---|---|\n${fileRows}\n`);

const manifestPath = join(referencePath, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.consolidation = {
  completedAt,
  audit: 'CONSOLIDATION-AUDIT.md',
  inventory: 'consolidation-inventory.json',
  historicalExportsFolder: 'HISTORICAL-SEAMER-EXPORTS',
  ...consolidation.summary
};
manifest.summary = { ...manifest.summary, ...consolidation.summary };
writeFileSync(manifestPath, jsonText(manifest));

const readmePath = join(referencePath, 'README.md');
let readme = readFileSync(readmePath, 'utf8');
const marker = '## Consolidated historical exports';
if (!readme.includes(marker)) {
  readme += `\n${marker}\n\n` +
    `The ${consolidation.summary.historicalSspFilesPreserved} older Seamer SSP files and their ` +
    `${consolidation.summary.historicalJsonFilesPreserved} readable JSON counterparts that differ ` +
    `from the current canonical conversions are preserved under \`HISTORICAL-SEAMER-EXPORTS/\`. ` +
    `They are regression references, not the recommended import files. See ` +
    `\`CONSOLIDATION-AUDIT.md\` for the decision covering every named Downloads source.\n`;
  writeFileSync(readmePath, readme);
}

const checksumFiles = [];
const visit = (folder) => {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.name !== 'checksums.sha256') checksumFiles.push(path);
  }
};
visit(referencePath);
checksumFiles.sort((a, b) => toPosix(relative(referencePath, a)).localeCompare(toPosix(relative(referencePath, b))));
writeFileSync(join(referencePath, 'checksums.sha256'), checksumFiles.map((path) =>
  `${sha256(readFileSync(path))}  ${toPosix(relative(referencePath, path))}`
).join('\n') + '\n');

console.log(JSON.stringify({ referencePath, summary: consolidation.summary }, null, 2));
