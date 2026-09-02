// The model's files, and how to read them.
//
//   base_model.json            bones, symmetry, poses, cylinders, landmarks, measurements
//   <gender>_model.json        means, covariances, min and max of the 17 coefficients
//   indices.bin                Float32 ×(numTris*3)  face indices stored as floats
//   skin_indices.bin           Uint16  ×(numVerts*4) bone indices
//   skin_weights.bin           Float32 ×(numVerts*4) skin weights (each quad sums to 1)
//   <gender>_coefficients.bin  Float32 [vertexInOrder][axis 0..2][value 0..17]
//       vertexInOrder = symmetry.centeredIndices then symmetry.pairs; 18 = 17 weights + 1 intercept
//
// All little-endian. Parsers are pure so they can be tested on bytes.

const modelFiles = {
  baseModel: "base_model.json",
  indices: "indices.bin",
  skinIndices: "skin_indices.bin",
  skinWeights: "skin_weights.bin",
  coefficients: (gender) => `${gender}_coefficients.bin`,
  statistics: (gender) => `${gender}_model.json`,
};

function parseIndices(buffer) {
  const floats = new Float32Array(buffer);
  const indices = new Uint32Array(floats.length);
  for (let index = 0; index < floats.length; index++) {
    indices[index] = floats[index];
  }
  return indices;
}

function parseSkinIndices(buffer) {
  return new Uint16Array(buffer);
}

function parseSkinWeights(buffer) {
  return new Float32Array(buffer);
}

function parseCoefficients(buffer) {
  return new Float32Array(buffer);
}

// Everything the skeleton and skinning need, fetched from one folder. `fetchBytes`
// and `fetchJson` are injected so the same loader serves a browser (fetch) and
// Node (readFile).
async function loadBodyModel(folder, { fetchJson, fetchBytes, gender = null } = {}) {
  const base = folder.endsWith("/") ? folder : `${folder}/`;
  const [baseModel, indices, skinIndices, skinWeights] = await Promise.all([
    fetchJson(`${base}${modelFiles.baseModel}`),
    fetchBytes(`${base}${modelFiles.indices}`).then(parseIndices),
    fetchBytes(`${base}${modelFiles.skinIndices}`).then(parseSkinIndices),
    fetchBytes(`${base}${modelFiles.skinWeights}`).then(parseSkinWeights),
  ]);
  const model = { baseModel, indices, skin: { indices: skinIndices, weights: skinWeights } };
  if (gender) {
    const [coefficients, statistics] = await Promise.all([
      fetchBytes(`${base}${modelFiles.coefficients(gender)}`).then(parseCoefficients),
      fetchJson(`${base}${modelFiles.statistics(gender)}`),
    ]);
    model.coefficients = coefficients;
    model.statistics = statistics;
  }
  return model;
}

export { modelFiles, parseIndices, parseSkinIndices, parseSkinWeights, parseCoefficients, loadBodyModel };
