#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';

const [listingHtmlPath, downloadsPath, outputPath] = process.argv.slice(2);
if (!listingHtmlPath || !downloadsPath || !outputPath) {
  console.error('Usage: node scripts/archive-public-patterns.mjs <listing.html> <downloads-dir> <output-dir>');
  process.exit(1);
}

const decodeHtml = (value) => value
  .replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .trim();
const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const slug = (value) => normalize(value)
  .normalize('NFKD')
  .replace(/[^a-zA-Z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .toLowerCase() || 'pattern';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const listingHtml = readFileSync(listingHtmlPath, 'utf8');
const entryExpression = /<div class="font-semibold text-md">(.*?)<\/div>.*?<p class="text-sm[^>]*">(.*?)<\/p>.*?<span>By (.*?)<\/span>.*?<span>Updated: (.*?)<\/span>/gs;
const entries = [...listingHtml.matchAll(entryExpression)].map((match, index) => ({
  index,
  name: decodeHtml(match[1]),
  description: decodeHtml(match[2]),
  author: decodeHtml(match[3]),
  updatedAtDisplay: decodeHtml(match[4]),
  has3d: /<span class="badge badge-secondary[^>]*">3D<\/span>/.test(match[0])
}));
if (entries.length !== 20) throw new Error(`Expected 20 public entries, found ${entries.length}`);

const thumbnailQueues = new Map();
for (const match of listingHtml.matchAll(/<img[^>]+src="([^"]+)"[^>]+alt="([^"]+) thumbnail"/g)) {
  const name = decodeHtml(match[2]);
  const queue = thumbnailQueues.get(name) ?? [];
  queue.push(match[1]);
  thumbnailQueues.set(name, queue);
}
for (const entry of entries) entry.thumbnailUrl = thumbnailQueues.get(entry.name)?.shift() ?? null;

const decodeSsp = (bytes) => {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return gunzipSync(bytes).toString('utf8');
  if (bytes[0] === 0x78) return inflateSync(bytes).toString('utf8');
  return bytes.toString('utf8');
};
const sspCutoff = new Date('2026-08-09T19:16:00-07:00').getTime();
const rawCutoff = new Date('2026-08-09T19:22:30-07:00').getTime();
const files = readdirSync(downloadsPath).map((name) => ({
  name,
  path: join(downloadsPath, name),
  mtimeMs: statSync(join(downloadsPath, name)).mtimeMs
}));

const projects = files
  .filter((file) => extname(file.name).toLowerCase() === '.ssp' && file.mtimeMs >= sspCutoff && !file.name.includes('.seamer.'))
  .flatMap((file) => {
    try {
      const bytes = readFileSync(file.path);
      const text = decodeSsp(bytes);
      return [{ ...file, bytes, text, data: JSON.parse(text) }];
    } catch {
      return [];
    }
  });
const rawExports = files
  .filter((file) => extname(file.name).toLowerCase() === '.json' && file.mtimeMs >= rawCutoff && !file.name.includes('.seamer'))
  .flatMap((file) => {
    try {
      const bytes = readFileSync(file.path);
      const data = JSON.parse(bytes.toString('utf8'));
      return Array.isArray(data?.pieces) && data.pieces[0]?.boundary ? [{ ...file, bytes, data }] : [];
    } catch {
      return [];
    }
  });

// Public display names occasionally add a presentation-only "2D (...)" qualifier that both file
// exporters omit. Descriptions are unique in this listing (including the two TOOBIGPANTS records),
// so use the lossless project description as the stable join key.
const matches = (entry, data) => normalize(data?.description) === normalize(entry.description);
const takeMatch = (pool, entry, label) => {
  const index = pool.findIndex((candidate) => matches(entry, candidate.data));
  if (index < 0) throw new Error(`No ${label} matched ${entry.name} — ${entry.description}`);
  return pool.splice(index, 1)[0];
};

mkdirSync(outputPath, { recursive: true });
const patternsPath = join(outputPath, 'patterns');
mkdirSync(patternsPath, { recursive: true });

const manifest = {
  formatVersion: 1,
  source: 'https://seamscape.com/studio',
  archivedAt: new Date().toISOString(),
  listingCount: entries.length,
  notes: [
    'project.ssp is the complete legacy SeamScape project.',
    'project.json is the losslessly decompressed project for inspection.',
    'raw.json is the complementary sampled-outline export used for migration.',
    'thumbnail files are copied from the public listing when provided.'
  ],
  patterns: []
};

for (const entry of entries) {
  const project = takeMatch(projects, entry, '.ssp project');
  const raw = takeMatch(rawExports, entry, 'Raw JSON export');
  const projectId = project.data.id ?? project.data.versionId ?? `entry-${entry.index + 1}`;
  const folderName = `${String(entry.index + 1).padStart(2, '0')}-${slug(entry.name)}--${projectId}`;
  const patternPath = join(patternsPath, folderName);
  mkdirSync(patternPath, { recursive: true });

  const sspTarget = join(patternPath, 'project.ssp');
  const projectJsonTarget = join(patternPath, 'project.json');
  const rawTarget = join(patternPath, 'raw.json');
  copyFileSync(project.path, sspTarget);
  writeFileSync(projectJsonTarget, `${JSON.stringify(project.data, null, 2)}\n`);
  copyFileSync(raw.path, rawTarget);

  let thumbnail = null;
  if (entry.thumbnailUrl) {
    const response = await fetch(entry.thumbnailUrl);
    if (!response.ok) throw new Error(`Thumbnail download failed (${response.status}): ${entry.thumbnailUrl}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const extension = new URL(entry.thumbnailUrl).pathname.match(/\.[a-z0-9]+$/i)?.[0] ?? '.jpg';
    const target = join(patternPath, `thumbnail${extension}`);
    writeFileSync(target, bytes);
    thumbnail = { file: basename(target), bytes: bytes.length, sha256: sha256(bytes), sourceUrl: entry.thumbnailUrl };
  }

  const snapshotVertices = (project.data.pieces ?? []).reduce((total, piece) =>
    total + (piece.settings3d?.savedMeshSnapshot?.vertexCount ?? 0), 0);
  const record = {
    order: entry.index + 1,
    name: entry.name,
    description: entry.description,
    author: entry.author,
    updatedAtDisplay: entry.updatedAtDisplay,
    listingHas3dBadge: entry.has3d,
    projectId,
    versionId: project.data.versionId ?? null,
    versionName: project.data.versionName ?? null,
    softwareVersion: project.data.softwareVersion ?? null,
    folder: `patterns/${folderName}`,
    sourceFiles: {
      projectDownloadName: project.name,
      rawDownloadName: raw.name
    },
    counts: {
      points: project.data.points?.length ?? 0,
      paths: project.data.paths?.length ?? 0,
      pieces: project.data.pieces?.length ?? 0,
      seams: project.data.seams?.length ?? 0,
      materials: project.data.materials?.length ?? 0,
      variables: project.data.variables?.length ?? 0,
      layers: project.data.layers?.length ?? 0,
      images: project.data.images?.length ?? 0,
      texts: project.data.texts?.length ?? 0,
      rawPieces: raw.data.pieces?.length ?? 0,
      cached3dVertices: snapshotVertices
    },
    files: {
      project: { file: 'project.ssp', bytes: project.bytes.length, sha256: sha256(project.bytes) },
      decodedProject: { file: 'project.json', bytes: Buffer.byteLength(JSON.stringify(project.data, null, 2) + '\n') },
      raw: { file: 'raw.json', bytes: raw.bytes.length, sha256: sha256(raw.bytes) },
      thumbnail
    }
  };
  writeFileSync(join(patternPath, 'metadata.json'), `${JSON.stringify(record, null, 2)}\n`);
  manifest.patterns.push(record);
}

writeFileSync(join(outputPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const rows = manifest.patterns.map((pattern) =>
  `| ${pattern.order} | ${pattern.name.replace(/\|/g, '\\|')} | ${pattern.author.replace(/\|/g, '\\|')} | ${pattern.counts.pieces} | ${pattern.counts.seams} | ${pattern.counts.cached3dVertices} |`
).join('\n');
writeFileSync(join(outputPath, 'README.md'), `# SeamScape public pattern archive\n\n` +
  `Archived ${manifest.patterns.length} public patterns from ${manifest.source} on ${manifest.archivedAt}.\n\n` +
  `Each pattern folder contains the complete compressed project, a readable decoded copy, the sampled Raw JSON migration export, listing metadata, and its thumbnail when available.\n\n` +
  `| # | Pattern | Author | Pieces | Seams | Cached 3D vertices |\n|---:|---|---|---:|---:|---:|\n${rows}\n`);

console.log(`Archived ${manifest.patterns.length} patterns to ${outputPath}`);
console.log(`Projects: ${manifest.patterns.reduce((sum, pattern) => sum + pattern.counts.pieces, 0)} pieces, ${manifest.patterns.reduce((sum, pattern) => sum + pattern.counts.seams, 0)} seams`);
console.log(`3D cache: ${manifest.patterns.reduce((sum, pattern) => sum + pattern.counts.cached3dVertices, 0)} vertices`);
