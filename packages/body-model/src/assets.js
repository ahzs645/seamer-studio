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

// The package carries its own copy of the files, so a caller that has no
// opinion about where they live does not need one.
const modelFolder = new URL("../models/", import.meta.url).href;

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
    indices[index] = Math.round(floats[index]);
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

// Everything the skeleton and skinning need, fetched from one folder --
// `modelFolder`, this package's own `models/`, unless a caller says otherwise
// (an app that serves the files from its own static route wants its own path).
// `fetchBytes` and `fetchJson` are injected so the same loader serves a browser
// (fetch) and Node (readFile); they default to `fetch`, which is what a browser
// and Node 18+ both have.
async function loadBodyModel(
  folder = modelFolder,
  { fetchJson = fetchJsonOverHttp, fetchBytes = fetchBytesOverHttp, gender = null } = {}
) {
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

async function fetchJsonOverHttp(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`body model: ${url} is ${response.status}`);
  }
  return response.json();
}

async function fetchBytesOverHttp(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`body model: ${url} is ${response.status}`);
  }
  return response.arrayBuffer();
}

export { modelFolder, modelFiles, parseIndices, parseSkinIndices, parseSkinWeights, parseCoefficients, loadBodyModel };
