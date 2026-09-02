// Per-vertex parametric reconstruction.
//
// position = Σ coefficient_i · basis_i + intercept, per vertex and axis. The
// coefficient buffer is written for the centred vertices once and for each
// mirrored pair once, and the mirror vertex gets the same y and z with x
// negated. Output is in metres, +Y up, mirror plane x = 0.

const coefficientCount = 17;
const stride = coefficientCount + 1;

function reconstructVertices(baseModel, coefficients, values, numVertices) {
  if (!Array.isArray(values) && !(values instanceof Float32Array)) {
    throw new Error("reconstructVertices: values must be the 17 coefficient values in coefficientNames order");
  }
  if (values.length !== coefficientCount) {
    throw new Error(`reconstructVertices: ${values.length} values for ${coefficientCount} coefficients`);
  }
  const { centeredIndices, pairs } = baseModel.symmetry;
  const count = numVertices ?? centeredIndices.length + pairs.length * 2;
  const out = new Float32Array(count * 3);
  let at = 0;
  const next = () => {
    let sum = 0;
    for (let index = 0; index < coefficientCount; index++) {
      sum += values[index] * coefficients[at + index];
    }
    sum += coefficients[at + coefficientCount];
    at += stride;
    return sum;
  };
  for (const vertex of centeredIndices) {
    out[vertex * 3] = next();
    out[vertex * 3 + 1] = next();
    out[vertex * 3 + 2] = next();
  }
  for (const [vertex, mirror] of pairs) {
    for (let axis = 0; axis < 3; axis++) {
      const value = next();
      out[vertex * 3 + axis] = value;
      out[mirror * 3 + axis] = value;
    }
    out[mirror * 3] = -out[vertex * 3];
  }
  return out;
}

// The seventeen coefficients for a full row of measurements (the statistics'
// 69 columns, in columnNames order). Sixteen are columns; the seventeenth,
// weightHeightSqrtRatio, is derived: the statistics carry the cube root of
// the weight in kilograms, and the ratio is sqrt(weight / height in cm).
function coefficientsFrom(baseModel, statistics, row) {
  const columns = statistics.columnNames;
  const get = (name) => {
    const column = columns.indexOf(name);
    if (column < 0) {
      throw new Error(`coefficientsFrom: the statistics have no column "${name}"`);
    }
    return row[column];
  };
  const heightCm = get("height");
  const weightKg = Math.pow(get("weightCbrt"), 3);
  return baseModel.coefficientNames.map((name) =>
    name === "weightHeightSqrtRatio" ? (heightCm > 0 ? Math.sqrt(weightKg / heightCm) : 0) : get(name)
  );
}

// The seventeen values a gender's statistics start from: the population means.
function meanCoefficients(baseModel, statistics) {
  return coefficientsFrom(baseModel, statistics, statistics.means);
}

export { coefficientCount, reconstructVertices, coefficientsFrom, meanCoefficients };
