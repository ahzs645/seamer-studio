#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync, inflateSync } from 'node:zlib';
import { createServer } from 'vite';

const [archivePathArg, convertedPathArg, downloadsPathArg, outputPathArg] = process.argv.slice(2);
if (!archivePathArg || !convertedPathArg || !downloadsPathArg || !outputPathArg) {
  console.error(
    'Usage: node scripts/build-complete-ssp-reference.mjs ' +
    '<public-archive-dir> <converted-dir> <downloads-dir> <output-dir>'
  );
  process.exit(1);
}

const archivePath = resolve(archivePathArg);
const convertedPath = resolve(convertedPathArg);
const downloadsPath = resolve(downloadsPathArg);
const outputPath = resolve(outputPathArg);

if (existsSync(outputPath)) {
  throw new Error(`Refusing to overwrite existing reference folder: ${outputPath}`);
}

const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const slug = (value) => normalize(value)
  .normalize('NFKD')
  .replace(/[^a-zA-Z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .toLowerCase() || 'project';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
const writeJson = (path, value) => writeFileSync(path, jsonText(value));
const toPosix = (value) => value.split(sep).join('/');

const decodeSsp = (bytes) => {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return gunzipSync(bytes).toString('utf8');
  if (bytes[0] === 0x78) return inflateSync(bytes).toString('utf8');
  return bytes.toString('utf8');
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};
const semanticSha = (value) => sha256(Buffer.from(JSON.stringify(canonicalize(value))));

const fileRecord = (path, decoded = null) => {
  const bytes = readFileSync(path);
  return {
    file: basename(path),
    bytes: bytes.length,
    sha256: sha256(bytes),
    ...(decoded ? { semanticSha256: semanticSha(decoded) } : {})
  };
};

const collectMediaUrls = (value, found = new Set()) => {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) && /\.(?:avif|gif|jpe?g|png|webp)(?:\?|$)/i.test(value)) found.add(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMediaUrls(item, found);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectMediaUrls(item, found);
  }
  return found;
};

const projectCounts = (project) => ({
  points: project.points?.length ?? 0,
  paths: project.paths?.length ?? 0,
  pieces: project.pieces?.length ?? 0,
  seams: project.seams?.length ?? 0,
  materials: project.materials?.length ?? 0,
  variables: project.variables?.length ?? 0,
  layers: project.layers?.length ?? 0,
  images: project.images?.length ?? 0,
  texts: project.texts?.length ?? 0,
  cached3dVertices: (project.pieces ?? []).reduce((total, piece) => total + (
    piece.settings3d?.savedMeshSnapshot?.vertexCount ??
    Math.floor((piece.settings3d?.savedPositions?.length ?? 0) / 5)
  ), 0)
});

const csvValue = (value) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const manifest = JSON.parse(readFileSync(join(archivePath, 'manifest.json'), 'utf8'));
const canonicalPencilSkirt = JSON.parse(readFileSync('static/templates/pencil-skirt.json', 'utf8'));
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });

mkdirSync(outputPath);
const projectsPath = join(outputPath, 'projects');
mkdirSync(projectsPath);

const reference = {
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  generatedWithCommit: null,
  sourceFolders: {
    publicArchive: archivePath,
    priorConvertedExports: convertedPath,
    looseDownloads: downloadsPath
  },
  completenessDefinition: [
    'The original compressed SeamScape project parses successfully.',
    'A losslessly decoded source JSON copy is included.',
    'The paired sampled-outline Raw JSON migration export is included.',
    'A fresh Seamer-native JSON and compressed SSP are generated with the current importer.',
    'Every source-3D project passes the native 3D buildability assertion.',
    'Referenced image and material media are bundled locally when present in the repository archive.',
    'Every delivered file is covered by SHA-256 checksums.'
  ],
  projects: []
};

try {
  try {
    const { execFileSync } = await import('node:child_process');
    reference.generatedWithCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    reference.generatedWithCommit = null;
  }

  const imports = await server.ssrLoadModule('/src/lib/utils/importSimplePattern.ts');

  for (const archived of manifest.patterns) {
    const sourceFolder = join(archivePath, archived.folder);
    const legacySspPath = join(sourceFolder, 'project.ssp');
    const legacy = JSON.parse(readFileSync(join(sourceFolder, 'project.json'), 'utf8'));
    const raw = JSON.parse(readFileSync(join(sourceFolder, 'raw.json'), 'utf8'));
    const authorSuffix = normalize(archived.name).toLowerCase() === 'toobigpants'
      ? `-${slug(archived.author)}`
      : '';
    const folderName = `${String(archived.order).padStart(2, '0')}-${slug(archived.name)}${authorSuffix}`;
    const projectPath = join(projectsPath, folderName);
    mkdirSync(projectPath);

    const canonical = imports.isCanonicalPencilSkirtExport(raw) ? canonicalPencilSkirt : undefined;
    const native = imports.convertSimplePatternWithLegacyProject(raw, legacy, canonical);
    const source3dEnabled = legacy.enable3d !== false;
    if (source3dEnabled) imports.assertPatternBuildable3d(native);

    const legacySspTarget = join(projectPath, 'legacy-project.ssp');
    const legacyJsonTarget = join(projectPath, 'legacy-project.json');
    const rawTarget = join(projectPath, 'raw-pattern.json');
    const nativeJsonTarget = join(projectPath, 'seamer-project.json');
    const nativeSspTarget = join(projectPath, 'seamer-project.ssp');
    copyFileSync(legacySspPath, legacySspTarget);
    writeFileSync(legacyJsonTarget, jsonText(legacy));
    writeFileSync(rawTarget, jsonText(raw));
    const nativeText = jsonText(native);
    writeFileSync(nativeJsonTarget, nativeText);
    writeFileSync(nativeSspTarget, gzipSync(nativeText, { level: 9, mtime: 0 }));

    const assets = [];
    const mediaUrls = [...collectMediaUrls(legacy)].sort();
    if (mediaUrls.length || archived.files?.thumbnail?.file) {
      const assetsPath = join(projectPath, 'assets');
      mkdirSync(assetsPath);
      if (mediaUrls.length) {
        const texturesPath = join(assetsPath, 'textures');
        mkdirSync(texturesPath);
        for (const url of mediaUrls) {
          const mediaName = basename(new URL(url).pathname);
          const candidates = [
            join('static/templates/textures', mediaName),
            join('static/textures', mediaName)
          ];
          const source = candidates.find(existsSync);
          if (source) {
            const target = join(texturesPath, mediaName);
            copyFileSync(source, target);
            assets.push({
              kind: 'project-media',
              sourceUrl: url,
              file: `assets/textures/${mediaName}`,
              bytes: statSync(target).size,
              sha256: sha256(readFileSync(target)),
              status: 'bundled'
            });
          } else {
            assets.push({ kind: 'project-media', sourceUrl: url, file: null, status: 'missing' });
          }
        }
      }
      if (archived.files?.thumbnail?.file) {
        const thumbnailSource = join(sourceFolder, archived.files.thumbnail.file);
        if (existsSync(thumbnailSource)) {
          const extension = extname(thumbnailSource) || '.jpg';
          const target = join(assetsPath, `thumbnail${extension}`);
          copyFileSync(thumbnailSource, target);
          assets.push({
            kind: 'listing-thumbnail',
            sourceUrl: archived.files.thumbnail.sourceUrl ?? null,
            file: `assets/thumbnail${extension}`,
            bytes: statSync(target).size,
            sha256: sha256(readFileSync(target)),
            status: 'bundled'
          });
        }
      }
    }

    const record = {
      order: archived.order,
      name: archived.name,
      author: archived.author,
      description: archived.description,
      folder: `projects/${folderName}`,
      source3dEnabled,
      validation: {
        legacyProject: 'pass',
        rawPattern: 'pass',
        nativeConversion: 'pass',
        native3dBuildability: source3dEnabled ? 'pass' : 'not-applicable',
        media: assets.some((asset) => asset.status === 'missing') ? 'incomplete' : 'pass'
      },
      counts: {
        legacy: projectCounts(legacy),
        rawPieces: raw.pieces?.length ?? 0,
        native: projectCounts(native)
      },
      files: {
        legacyProject: fileRecord(legacySspTarget, legacy),
        decodedLegacyProject: fileRecord(legacyJsonTarget, legacy),
        rawPattern: fileRecord(rawTarget, raw),
        nativeProject: fileRecord(nativeSspTarget, native),
        decodedNativeProject: fileRecord(nativeJsonTarget, native)
      },
      assets
    };
    writeJson(join(projectPath, 'project-manifest.json'), record);
    reference.projects.push(record);
  }

  // Preserve any semantically distinct, complete legacy SSP variants found loose in Downloads.
  // The public archive remains the canonical 20-project set, but a separately saved view/version
  // can contain real project-state differences even when its display name and description match.
  const canonicalProjectCount = reference.projects.length;
  const canonicalLegacySemantics = new Set(reference.projects.map((project) =>
    project.files.decodedLegacyProject.semanticSha256
  ));
  const addedVariantSemantics = new Set();
  const looseLegacyCandidates = readdirSync(downloadsPath).sort().filter((filename) =>
    /\.ssp$/i.test(filename) && !/\.seamer\.ssp$/i.test(filename)
  );
  for (const filename of looseLegacyCandidates) {
    const sourcePath = join(downloadsPath, filename);
    let legacy;
    try {
      legacy = JSON.parse(decodeSsp(readFileSync(sourcePath)));
    } catch {
      continue;
    }
    if (!Array.isArray(legacy?.points) || !Array.isArray(legacy?.paths) || !Array.isArray(legacy?.pieces)) continue;
    const legacySemantic = semanticSha(legacy);
    if (canonicalLegacySemantics.has(legacySemantic) || addedVariantSemantics.has(legacySemantic)) continue;

    const canonicalProject = reference.projects.find((project) =>
      normalize(project.description) === normalize(legacy.description)
    );
    if (!canonicalProject) continue;
    const rawCandidates = readdirSync(downloadsPath).sort().filter((rawFilename) => /\.json$/i.test(rawFilename));
    let rawSourcePath = null;
    let raw = null;
    for (const rawFilename of rawCandidates) {
      try {
        const candidate = JSON.parse(readFileSync(join(downloadsPath, rawFilename), 'utf8'));
        if (
          Array.isArray(candidate?.pieces) && candidate.pieces[0]?.boundary &&
          normalize(candidate.description) === normalize(legacy.description)
        ) {
          rawSourcePath = join(downloadsPath, rawFilename);
          raw = candidate;
          break;
        }
      } catch {
        // Not a project-shaped JSON export.
      }
    }
    if (!raw || !rawSourcePath) continue;

    const variantNumber = reference.projects.filter((project) =>
      project.variantOfOrder === canonicalProject.order
    ).length + 1;
    const order = reference.projects.length + 1;
    const folderName = `${String(order).padStart(2, '0')}-${slug(legacy.name)}-downloads-variant-${variantNumber}`;
    const projectPath = join(projectsPath, folderName);
    mkdirSync(projectPath);
    const canonical = imports.isCanonicalPencilSkirtExport(raw) ? canonicalPencilSkirt : undefined;
    const native = imports.convertSimplePatternWithLegacyProject(raw, legacy, canonical);
    const source3dEnabled = legacy.enable3d !== false;
    if (source3dEnabled) imports.assertPatternBuildable3d(native);

    const legacySspTarget = join(projectPath, 'legacy-project.ssp');
    const legacyJsonTarget = join(projectPath, 'legacy-project.json');
    const rawTarget = join(projectPath, 'raw-pattern.json');
    const nativeJsonTarget = join(projectPath, 'seamer-project.json');
    const nativeSspTarget = join(projectPath, 'seamer-project.ssp');
    copyFileSync(sourcePath, legacySspTarget);
    writeFileSync(legacyJsonTarget, jsonText(legacy));
    writeFileSync(rawTarget, jsonText(raw));
    const nativeText = jsonText(native);
    writeFileSync(nativeJsonTarget, nativeText);
    writeFileSync(nativeSspTarget, gzipSync(nativeText, { level: 9, mtime: 0 }));

    const canonicalAssetsPath = join(outputPath, canonicalProject.folder, 'assets');
    const variantAssetsPath = join(projectPath, 'assets');
    if (existsSync(canonicalAssetsPath)) cpSync(canonicalAssetsPath, variantAssetsPath, { recursive: true });
    const assets = canonicalProject.assets.map((asset) => ({ ...asset }));
    const record = {
      order,
      name: `${legacy.name} (Downloads variant ${variantNumber})`,
      author: canonicalProject.author,
      description: legacy.description,
      folder: `projects/${folderName}`,
      source3dEnabled,
      variantOfOrder: canonicalProject.order,
      variantSourceFiles: {
        legacyProject: filename,
        rawPattern: basename(rawSourcePath)
      },
      validation: {
        legacyProject: 'pass',
        rawPattern: 'pass',
        nativeConversion: 'pass',
        native3dBuildability: source3dEnabled ? 'pass' : 'not-applicable',
        media: assets.some((asset) => asset.status === 'missing') ? 'incomplete' : 'pass'
      },
      counts: {
        legacy: projectCounts(legacy),
        rawPieces: raw.pieces?.length ?? 0,
        native: projectCounts(native)
      },
      files: {
        legacyProject: fileRecord(legacySspTarget, legacy),
        decodedLegacyProject: fileRecord(legacyJsonTarget, legacy),
        rawPattern: fileRecord(rawTarget, raw),
        nativeProject: fileRecord(nativeSspTarget, native),
        decodedNativeProject: fileRecord(nativeJsonTarget, native)
      },
      assets
    };
    writeJson(join(projectPath, 'project-manifest.json'), record);
    reference.projects.push(record);
    addedVariantSemantics.add(legacySemantic);
  }

  // Also provide flat, descriptively named SSP collections for file-picker workflows. The project
  // folders remain the authoritative bundles; these are verified convenience copies.
  const importReadyPath = join(outputPath, 'IMPORT-READY-SEAMER-SSP');
  const legacySspPath = join(outputPath, 'SOURCE-LEGACY-SEAMSCAPE-SSP');
  mkdirSync(importReadyPath);
  mkdirSync(legacySspPath);
  for (const project of reference.projects) {
    const stem = basename(project.folder);
    const nativeFlatName = `${stem}.seamer.ssp`;
    const legacyFlatName = `${stem}.seamscape.ssp`;
    copyFileSync(join(outputPath, project.folder, 'seamer-project.ssp'), join(importReadyPath, nativeFlatName));
    copyFileSync(join(outputPath, project.folder, 'legacy-project.ssp'), join(legacySspPath, legacyFlatName));
    project.flatFiles = {
      importReadySeamerSsp: `IMPORT-READY-SEAMER-SSP/${nativeFlatName}`,
      sourceLegacySeamScapeSsp: `SOURCE-LEGACY-SEAMSCAPE-SSP/${legacyFlatName}`
    };
    writeJson(join(outputPath, project.folder, 'project-manifest.json'), project);
  }

  const semanticReferences = new Map();
  for (const project of reference.projects) {
    for (const [role, file] of Object.entries(project.files)) {
      if (!file.semanticSha256) continue;
      const key = `${role}:${file.semanticSha256}`;
      if (!semanticReferences.has(key)) {
        semanticReferences.set(key, { order: project.order, folder: project.folder, role });
      }
    }
  }

  const classifyLoose = (data, filename) => {
    if (filename.includes('.seamer.')) return 'native-project';
    if (Array.isArray(data?.pieces) && data.pieces[0]?.boundary) return 'raw-pattern';
    if (Array.isArray(data?.pieces) && data.pieces.some((piece) => piece?.legacyGeometry)) return 'native-project';
    if (Array.isArray(data?.points) && Array.isArray(data?.paths) && Array.isArray(data?.pieces)) return 'legacy-project';
    return 'unrelated-json';
  };
  const canonicalRole = (role) => role === 'raw-pattern'
    ? 'rawPattern'
    : role === 'native-project'
      ? 'decodedNativeProject'
      : role === 'legacy-project'
        ? 'decodedLegacyProject'
        : null;

  const looseInventory = [];
  for (const [sourceSet, folder] of [['prior-converted', convertedPath], ['downloads-root', downloadsPath]]) {
    for (const filename of readdirSync(folder).sort()) {
      if (!/\.(?:json|ssp)$/i.test(filename)) continue;
      const path = join(folder, filename);
      if (!statSync(path).isFile()) continue;
      const bytes = readFileSync(path);
      let data;
      try {
        data = JSON.parse(decodeSsp(bytes));
      } catch (error) {
        looseInventory.push({
          sourceSet,
          file: filename,
          bytes: bytes.length,
          sha256: sha256(bytes),
          role: 'unreadable',
          status: 'excluded',
          reason: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      const role = classifyLoose(data, filename);
      const semanticSha256 = semanticSha(data);
      const referenceRole = canonicalRole(role);
      const exact = referenceRole ? semanticReferences.get(`${referenceRole}:${semanticSha256}`) : null;
      const identity = reference.projects.filter((project) =>
        normalize(project.description) === normalize(data.description) ||
        normalize(project.name) === normalize(data.name)
      );
      const matched = exact
        ? reference.projects.find((project) => project.order === exact.order)
        : identity.length === 1
          ? identity[0]
          : identity.find((project) => normalize(project.description) === normalize(data.description));
      looseInventory.push({
        sourceSet,
        file: filename,
        bytes: bytes.length,
        sha256: sha256(bytes),
        semanticSha256,
        role,
        status: exact ? 'identical-to-reference' : matched ? 'superseded-or-different' : 'excluded',
        matchedProjectOrder: matched?.order ?? null,
        matchedProject: matched?.name ?? null,
        referenceFolder: matched?.folder ?? null,
        reason: role === 'unrelated-json'
          ? 'Not a SeamScape or Seamer project export.'
          : exact
            ? 'The standardized reference contains the same decoded project data.'
            : matched
              ? 'Same project identity, but the standardized reference was freshly generated from the canonical archive.'
              : 'No canonical public-project identity matched.'
      });
    }
  }

  writeJson(join(outputPath, 'loose-file-inventory.json'), { files: looseInventory });
  reference.summary = {
    projects: reference.projects.length,
    canonicalPublicProjects: canonicalProjectCount,
    completeDownloadsVariants: reference.projects.length - canonicalProjectCount,
    source3dProjects: reference.projects.filter((project) => project.source3dEnabled).length,
    source2dProjects: reference.projects.filter((project) => !project.source3dEnabled).length,
    nativeConversionsPassed: reference.projects.filter((project) => project.validation.nativeConversion === 'pass').length,
    native3dBuildabilityPassed: reference.projects.filter((project) => project.validation.native3dBuildability === 'pass').length,
    mediaFilesBundled: reference.projects.reduce((total, project) =>
      total + project.assets.filter((asset) => asset.status === 'bundled').length, 0),
    missingMediaFiles: reference.projects.reduce((total, project) =>
      total + project.assets.filter((asset) => asset.status === 'missing').length, 0),
    looseFilesInspected: looseInventory.length,
    looseFilesIdentical: looseInventory.filter((file) => file.status === 'identical-to-reference').length,
    looseFilesSupersededOrDifferent: looseInventory.filter((file) => file.status === 'superseded-or-different').length,
    looseFilesExcluded: looseInventory.filter((file) => file.status === 'excluded').length
  };
  writeJson(join(outputPath, 'manifest.json'), reference);

  const csvRows = reference.projects.map((project) => [
    project.order,
    project.name,
    project.author,
    project.source3dEnabled ? '3D' : '2D',
    project.counts.native.pieces,
    project.counts.native.seams,
    project.counts.native.materials,
    project.counts.native.cached3dVertices,
    project.assets.filter((asset) => asset.status === 'bundled').length,
    project.folder
  ].map(csvValue).join(','));
  writeFileSync(join(outputPath, 'catalog.csv'), [
    'order,name,author,source_mode,native_pieces,native_seams,native_materials,cached_3d_vertices,bundled_assets,folder',
    ...csvRows,
    ''
  ].join('\n'));

  const projectRows = reference.projects.map((project) =>
    `| ${project.order} | ${project.name.replaceAll('|', '\\|')} | ${project.source3dEnabled ? '3D' : '2D'} | ` +
    `${project.counts.native.pieces} | ${project.counts.native.seams} | ${project.counts.native.materials} | ` +
    `${project.counts.native.cached3dVertices} | ${project.assets.filter((asset) => asset.status === 'bundled').length} |`
  ).join('\n');
  writeFileSync(join(outputPath, 'README.md'), `# Complete SeamScape / Seamer SSP reference\n\n` +
    `Generated ${reference.generatedAt} from the 20-project public archive, the prior converted set, ` +
    `and loose project exports in Downloads. Original source folders were not modified.\n\n` +
    `## What each project folder contains\n\n` +
    `- \`legacy-project.ssp\`: original complete compressed SeamScape project\n` +
    `- \`legacy-project.json\`: losslessly decoded source project\n` +
    `- \`raw-pattern.json\`: paired sampled-outline migration geometry\n` +
    `- \`seamer-project.ssp\`: freshly generated current Seamer-native import file\n` +
    `- \`seamer-project.json\`: readable native project\n` +
    `- \`project-manifest.json\`: identity, validation, counts, assets, and hashes\n` +
    `- \`assets/\`: listing thumbnail and referenced textures/images when available\n\n` +
    `The flat \`IMPORT-READY-SEAMER-SSP/\` directory contains descriptively named copies of every ` +
    `current native SSP for quick file-picker imports. \`SOURCE-LEGACY-SEAMSCAPE-SSP/\` does the ` +
    `same for the original source SSPs.\n\n` +
    `Use \`seamer-project.ssp\` for importing into the current Seamer Studio. Keep the legacy SSP, ` +
    `decoded project, and Raw JSON together when researching or rebuilding the original source.\n\n` +
    `## Audit summary\n\n` +
    `- Complete project bundles: ${reference.summary.projects}\n` +
    `- Canonical public projects: ${reference.summary.canonicalPublicProjects}\n` +
    `- Additional complete Downloads variants: ${reference.summary.completeDownloadsVariants}\n` +
    `- Source 3D projects validated: ${reference.summary.native3dBuildabilityPassed}/${reference.summary.source3dProjects}\n` +
    `- Native conversions generated: ${reference.summary.nativeConversionsPassed}/${reference.summary.projects}\n` +
    `- Referenced media bundled: ${reference.summary.mediaFilesBundled}\n` +
    `- Missing referenced media: ${reference.summary.missingMediaFiles}\n` +
    `- Loose converted/Downloads files inspected: ${reference.summary.looseFilesInspected}\n` +
    `- Byte-independent decoded matches: ${reference.summary.looseFilesIdentical}\n` +
    `- Older/different exports replaced by the canonical fresh build: ${reference.summary.looseFilesSupersededOrDifferent}\n` +
    `- Non-project JSON files excluded: ${reference.summary.looseFilesExcluded}\n\n` +
    `See \`loose-file-inventory.json\` for the decision on every inspected root-level SSP/JSON file.\n\n` +
    `| # | Project | Source mode | Pieces | Seams | Materials | Cached 3D vertices | Assets |\n` +
    `|---:|---|---|---:|---:|---:|---:|---:|\n${projectRows}\n`);

  const inventoryRows = looseInventory.map((item) =>
    `| ${item.sourceSet} | ${item.file.replaceAll('|', '\\|')} | ${item.role} | ${item.status} | ` +
    `${item.matchedProjectOrder ?? '—'} | ${item.matchedProject?.replaceAll('|', '\\|') ?? '—'} |`
  ).join('\n');
  writeFileSync(join(outputPath, 'LOOSE-FILE-AUDIT.md'), `# Loose SSP/JSON file audit\n\n` +
    `This table records how every root-level SSP/JSON candidate in the prior converted folder and ` +
    `Downloads was handled. Files marked identical are semantic matches after decoding, even when ` +
    `gzip metadata or JSON formatting changed their byte hash. Superseded files share a project ` +
    `identity but differ from the freshly generated canonical reference.\n\n` +
    `| Source | File | Role | Decision | Project # | Project |\n` +
    `|---|---|---|---|---:|---|\n${inventoryRows}\n`);

  const checksumFiles = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name !== 'checksums.sha256') checksumFiles.push(path);
    }
  };
  visit(outputPath);
  checksumFiles.sort((a, b) => toPosix(relative(outputPath, a)).localeCompare(toPosix(relative(outputPath, b))));
  writeFileSync(join(outputPath, 'checksums.sha256'), checksumFiles.map((path) =>
    `${sha256(readFileSync(path))}  ${toPosix(relative(outputPath, path))}`
  ).join('\n') + '\n');

  console.log(JSON.stringify({ outputPath, summary: reference.summary }, null, 2));
} finally {
  await server.close();
}
