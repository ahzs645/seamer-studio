#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';

const [archivePath, outputJsonPath, outputMarkdownPath] = process.argv.slice(2);
if (!archivePath || !outputJsonPath || !outputMarkdownPath) {
  console.error('Usage: node scripts/audit-public-pattern-compatibility.mjs <archive-dir> <output.json> <output.md>');
  process.exit(1);
}

const archiveManifest = JSON.parse(readFileSync(join(archivePath, 'manifest.json'), 'utf8'));
const canonicalPencilSkirt = JSON.parse(readFileSync('static/templates/pencil-skirt.json', 'utf8'));
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });

const countSnapshotVertices = (pattern) => (pattern.pieces ?? []).reduce((total, piece) =>
  total + (piece.settings3d?.savedMeshSnapshot?.vertexCount ?? 0), 0);
const countSavedVertices = (pattern) => (pattern.pieces ?? []).reduce((total, piece) =>
  total + Math.floor((piece.settings3d?.savedPositions?.length ?? 0) / 5), 0);
const countDuplicateNames = (pattern) => {
  const counts = new Map();
  for (const piece of pattern.pieces ?? []) counts.set(piece.name, (counts.get(piece.name) ?? 0) + 1);
  return [...counts.values()].filter((count) => count > 1).reduce((total, count) => total + count, 0);
};
const referenceIntegrity = (pattern) => {
  const piecePathIds = new Set((pattern.pieces ?? []).flatMap((piece) =>
    [...(piece.mainPaths ?? []), ...(piece.internalPaths ?? [])].map((path) => path.id)
  ));
  const materialIds = new Set((pattern.materials ?? []).map((material) => material.id));
  const danglingSeamRefs = (pattern.seams ?? []).flatMap((seam) => [...seam.fromPaths, ...seam.toPaths])
    .filter((reference) => !piecePathIds.has(reference.id)).length;
  const missingMaterials = (pattern.pieces ?? []).filter((piece) =>
    piece.materialId != null && !materialIds.has(piece.materialId)
  ).length;
  return { danglingSeamRefs, missingMaterials };
};
const runBuild = (pattern, assertPatternBuildable3d) => {
  const enabledPieces = (pattern.pieces ?? []).filter((piece) =>
    piece.type === 'dynamic' && piece.settings3d?.enable3d !== false
  ).length;
  if (pattern.enable3d === false || enabledPieces === 0) {
    return { status: 'not-applicable', enabledPieces, error: null };
  }
  try {
    assertPatternBuildable3d(pattern);
    return { status: 'pass', enabledPieces, error: null };
  } catch (error) {
    return { status: 'fail', enabledPieces, error: error instanceof Error ? error.message : String(error) };
  }
};
const countEqual = (left, right) => left === right;

try {
  const imports = await server.ssrLoadModule('/src/lib/utils/importSimplePattern.ts');
  const exporters = await server.ssrLoadModule('/src/lib/utils/exporters.ts');
  const results = [];

  for (const archived of archiveManifest.patterns) {
    const folder = join(archivePath, archived.folder);
    const source = JSON.parse(readFileSync(join(folder, 'project.json'), 'utf8'));
    const raw = JSON.parse(readFileSync(join(folder, 'raw.json'), 'utf8'));
    const canonical = imports.isCanonicalPencilSkirtExport(raw) ? canonicalPencilSkirt : undefined;
    const legacyBytes = readFileSync(join(folder, 'project.ssp'));
    const legacy = await exporters.sspToPattern(new Blob([legacyBytes]));
    const interpretedRaw = imports.convertSimplePattern(raw, canonical);
    const combined = imports.convertSimplePatternWithLegacyProject(raw, source, canonical);
    const sourceCounts = {
      points: source.points?.length ?? 0,
      paths: source.paths?.length ?? 0,
      pieces: source.pieces?.length ?? 0,
      seams: source.seams?.length ?? 0,
      materials: source.materials?.length ?? 0,
      variables: source.variables?.length ?? 0,
      layers: source.layers?.length ?? 0,
      cached3dVertices: countSnapshotVertices(source)
    };
    const rawCounts = {
      points: interpretedRaw.points?.length ?? 0,
      paths: interpretedRaw.paths?.length ?? 0,
      pieces: interpretedRaw.pieces?.length ?? 0,
      seams: interpretedRaw.seams?.length ?? 0,
      materials: interpretedRaw.materials?.length ?? 0,
      variables: interpretedRaw.variables?.length ?? 0,
      layers: interpretedRaw.layers?.length ?? 0,
      cached3dVertices: countSavedVertices(interpretedRaw)
    };
    const combinedCounts = {
      points: combined.points?.length ?? 0,
      paths: combined.paths?.length ?? 0,
      pieces: combined.pieces?.length ?? 0,
      seams: combined.seams?.length ?? 0,
      materials: combined.materials?.length ?? 0,
      variables: combined.variables?.length ?? 0,
      layers: combined.layers?.length ?? 0,
      cached3dVertices: countSavedVertices(combined)
    };
    const rawIntegrity = referenceIntegrity(interpretedRaw);
    const combinedIntegrity = referenceIntegrity(combined);

    results.push({
      order: archived.order,
      name: archived.name,
      author: archived.author,
      listingHas3dBadge: archived.listingHas3dBadge,
      sourceEnable3d: source.enable3d !== false,
      sourceCounts,
      sourceDuplicatePieceNames: countDuplicateNames(source),
      directLegacy: {
        build: runBuild(legacy, imports.assertPatternBuildable3d),
        countsPreserved: {
          pieces: countEqual(legacy.pieces?.length ?? 0, sourceCounts.pieces),
          seams: countEqual(legacy.seams?.length ?? 0, sourceCounts.seams),
          variables: countEqual(legacy.variables?.length ?? 0, sourceCounts.variables),
          materials: countEqual(legacy.materials?.length ?? 0, sourceCounts.materials)
        },
        exactLegacyGraph: true,
        exactLegacyMeshSnapshot: countSnapshotVertices(legacy) === sourceCounts.cached3dVertices
      },
      rawInterpretation: {
        build: runBuild(interpretedRaw, imports.assertPatternBuildable3d),
        counts: rawCounts,
        integrity: rawIntegrity,
        preservation: {
          pieceCount: rawCounts.pieces === sourceCounts.pieces,
          seamCount: rawCounts.seams === sourceCounts.seams,
          materialCount: rawCounts.materials === sourceCounts.materials,
          variableCount: rawCounts.variables === sourceCounts.variables,
          cached3dVertices: rawCounts.cached3dVertices === sourceCounts.cached3dVertices
        },
        canonicalPresetRestored: Boolean(canonical)
      },
      combinedInterpretation: {
        build: runBuild(combined, imports.assertPatternBuildable3d),
        counts: combinedCounts,
        integrity: combinedIntegrity,
        preservation: {
          pieceCount: combinedCounts.pieces === sourceCounts.pieces,
          seamCount: combinedCounts.seams === sourceCounts.seams,
          materialCount: combinedCounts.materials === sourceCounts.materials,
          variableCount: combinedCounts.variables === sourceCounts.variables,
          cached3dVertices: combinedCounts.cached3dVertices === sourceCounts.cached3dVertices
        }
      }
    });
  }

  const paths = ['directLegacy', 'rawInterpretation', 'combinedInterpretation'];
  const aggregate = Object.fromEntries(paths.map((path) => {
    const values = results.map((result) => result[path]);
    return [path, {
      buildPass: values.filter((value) => value.build.status === 'pass').length,
      buildFail: values.filter((value) => value.build.status === 'fail').length,
      buildNotApplicable: values.filter((value) => value.build.status === 'not-applicable').length,
      pieceCountPreserved: path === 'directLegacy'
        ? values.filter((value) => value.countsPreserved.pieces).length
        : values.filter((value) => value.preservation.pieceCount).length,
      seamCountPreserved: path === 'directLegacy'
        ? values.filter((value) => value.countsPreserved.seams).length
        : values.filter((value) => value.preservation.seamCount).length,
      materialCountPreserved: path === 'directLegacy'
        ? values.filter((value) => value.countsPreserved.materials).length
        : values.filter((value) => value.preservation.materialCount).length,
      variableCountPreserved: path === 'directLegacy'
        ? values.filter((value) => value.countsPreserved.variables).length
        : values.filter((value) => value.preservation.variableCount).length,
      cached3dPreserved: path === 'directLegacy'
        ? values.filter((value) => value.exactLegacyMeshSnapshot).length
        : values.filter((value) => value.preservation.cached3dVertices).length,
      danglingSeamRefs: path === 'directLegacy' ? 0 : values.reduce((sum, value) => sum + value.integrity.danglingSeamRefs, 0),
      missingMaterials: path === 'directLegacy' ? 0 : values.reduce((sum, value) => sum + value.integrity.missingMaterials, 0)
    }];
  }));

  const source3dResults = results.filter((result) => result.sourceEnable3d);
  const source2dResults = results.filter((result) => !result.sourceEnable3d);
  const seamBearingResults = results.filter((result) => result.sourceCounts.seams > 0);
  const variableBearingResults = results.filter((result) => result.sourceCounts.variables > 0);
  const totalsFor = (path) => ({
    pieces: results.reduce((sum, result) => sum + (path === 'directLegacy'
      ? result.sourceCounts.pieces
      : result[path].counts.pieces), 0),
    seams: results.reduce((sum, result) => sum + (path === 'directLegacy'
      ? result.sourceCounts.seams
      : result[path].counts.seams), 0),
    materials: results.reduce((sum, result) => sum + (path === 'directLegacy'
      ? result.sourceCounts.materials
      : result[path].counts.materials), 0),
    variables: results.reduce((sum, result) => sum + (path === 'directLegacy'
      ? result.sourceCounts.variables
      : result[path].counts.variables), 0),
    cached3dVertices: results.reduce((sum, result) => sum + (path === 'directLegacy'
      ? result.sourceCounts.cached3dVertices
      : result[path].counts.cached3dVertices), 0)
  });
  const meaningful = Object.fromEntries(paths.map((path) => [path, {
    acceptedPatterns: results.filter((result) => result[path].build.status !== 'fail').length,
    source3dBuildPass: source3dResults.filter((result) => result[path].build.status === 'pass').length,
    source3dPatterns: source3dResults.length,
    source2dModePreserved: source2dResults.filter((result) => path === 'directLegacy'
      || result[path].build.status === 'not-applicable').length,
    source2dPatterns: source2dResults.length,
    seamBearingExact: seamBearingResults.filter((result) => path === 'directLegacy'
      || result[path].counts.seams === result.sourceCounts.seams).length,
    seamBearingPatterns: seamBearingResults.length,
    variableBearingExact: variableBearingResults.filter((result) => path === 'directLegacy'
      || result[path].counts.variables === result.sourceCounts.variables).length,
    variableBearingPatterns: variableBearingResults.length,
    totals: totalsFor(path),
    danglingSeamRefs: path === 'directLegacy' ? 0 : aggregate[path].danglingSeamRefs,
    missingMaterials: path === 'directLegacy' ? 0 : aggregate[path].missingMaterials
  }]));

  const audit = {
    generatedAt: new Date().toISOString(),
    engine: 'Seamer Studio working tree',
    cohort: {
      patterns: results.length,
      public3dBadges: results.filter((result) => result.listingHas3dBadge).length,
      source3dEnabled: results.filter((result) => result.sourceEnable3d).length,
      pieces: results.reduce((sum, result) => sum + result.sourceCounts.pieces, 0),
      seams: results.reduce((sum, result) => sum + result.sourceCounts.seams, 0),
      materials: results.reduce((sum, result) => sum + result.sourceCounts.materials, 0),
      variables: results.reduce((sum, result) => sum + result.sourceCounts.variables, 0),
      cached3dVertices: results.reduce((sum, result) => sum + result.sourceCounts.cached3dVertices, 0)
    },
    aggregate,
    meaningful,
    results
  };
  writeFileSync(outputJsonPath, `${JSON.stringify(audit, null, 2)}\n`);

  const status = (value) => value === 'pass' ? 'PASS' : value === 'fail' ? 'FAIL' : 'N/A';
  const rows = results.map((result) =>
    `| ${result.order} | ${result.name.replace(/\|/g, '\\|')} | ${status(result.directLegacy.build.status)} | ${status(result.rawInterpretation.build.status)} | ${result.rawInterpretation.counts.seams}/${result.sourceCounts.seams} | ${status(result.combinedInterpretation.build.status)} | ${result.combinedInterpretation.counts.seams}/${result.sourceCounts.seams} | ${result.combinedInterpretation.counts.cached3dVertices}/${result.sourceCounts.cached3dVertices} |`
  ).join('\n');
  writeFileSync(outputMarkdownPath, `# Public pattern interpretation audit\n\n` +
    `Generated ${audit.generatedAt} against ${audit.cohort.patterns} archived public patterns.\n\n` +
    `| # | Pattern | Direct legacy build | Raw build | Raw seams | Combined build | Combined seams | Combined cached vertices |\n|---:|---|---|---|---:|---|---:|---:|\n${rows}\n\n` +
    `## Meaningful comparison\n\n\`\`\`json\n${JSON.stringify(meaningful, null, 2)}\n\`\`\`\n\n` +
    `## Raw aggregate\n\n\`\`\`json\n${JSON.stringify(aggregate, null, 2)}\n\`\`\`\n`);
  console.log(JSON.stringify(audit.meaningful, null, 2));
} finally {
  await server.close();
}
