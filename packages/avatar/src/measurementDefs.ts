// Canonical measurement metadata for the parametric body model.
// COLUMN_NAMES is the 69-dimensional statistical-model space (must match the order in the
// gender model JSON's `columnNames`). COEFFICIENT_NAMES (17) is the subset that directly drives
// per-vertex shape reconstruction (matches base_model.json `coefficientNames`).

export type MeasurementUnitKind = 'age' | 'weight' | 'length';

export const COLUMN_NAMES: readonly string[] = [
  'age', 'height', 'weightCbrt', 'neckGirth', 'chestGirth', 'waistGirth', 'shoulderWidth',
  'armLength', 'bicepGirth', 'wristGirth', 'hipGirth', 'neckToWaistBack', 'crotchHeight',
  'thighGirth', 'kneeGirth', 'calfGirth', 'ankleGirth', 'acrossShoulderFront', 'acrossChest',
  'bustSpan', 'neckToWaistFront', 'neckSideToWaistFront', 'nackSideToWaistBack',
  'neckSideToSideWaist', 'neckSideToWaistOverBustFront', 'shoulderToWaistFront',
  'shoulderToWaistBack', 'overArmLength', 'underArmLength', 'elbowBent', 'elbowStraight',
  'waistHeight', 'waistToKnee', 'kneeToAnkle', 'footInstepGirth', 'waistArcFront', 'waistArcBack',
  'highHipGirth', 'highHipArcFront', 'highHipArcBack', 'bustArcFront', 'bustArcBack', 'neckArcBack',
  'neckArcFront', 'bodyTorsoGirth', 'armpitToWaistSide', 'waistToHipsFront', 'waistToHipsBack',
  'waistToHipsSide', 'neckSideToShoulder', 'acrossBack', 'neckBackToShoulder', 'bustPointToLowBust',
  'bustPointToWaistFront', 'bustPointToBustPointHalter', 'neckFrontToWaistSide',
  'neckSideToWaistSide', 'armUpperGirth', 'midThighGirth', 'ankleDiagionalGirth',
  'waistSideToAnkle', 'crotchLength', 'riseLengthFront', 'hipArcFront', 'hipArcBack',
  'riseLengthSideSitting', 'neckMidGirth', 'armscyeLength', 'neckBackToHighBustBack'
];

// The 17 vertex-basis coefficients (order matters: matches base_model.json coefficientNames).
export const COEFFICIENT_NAMES: readonly string[] = [
  'age', 'height', 'weightHeightSqrtRatio', 'neckGirth', 'chestGirth', 'waistGirth',
  'shoulderWidth', 'armLength', 'bicepGirth', 'wristGirth', 'hipGirth', 'neckToWaistBack',
  'crotchHeight', 'thighGirth', 'kneeGirth', 'calfGirth', 'ankleGirth'
];

export function unitKind(name: string): MeasurementUnitKind {
  if (name === 'age') return 'age';
  if (name === 'weight' || name === 'weightCbrt') return 'weight';
  return 'length';
}

export interface MeasurementDef {
  name: string; // field key stored in body.fields
  label: string;
  kind: MeasurementUnitKind;
  primary?: boolean; // shown by default in the body panel
}

const LABELS: Record<string, string> = {
  age: 'Age',
  height: 'Height',
  weight: 'Weight',
  neckGirth: 'Neck',
  chestGirth: 'Bust / Chest',
  waistGirth: 'Waist',
  shoulderWidth: 'Shoulder width',
  armLength: 'Arm length',
  bicepGirth: 'Bicep',
  wristGirth: 'Wrist',
  hipGirth: 'Hip',
  neckToWaistBack: 'Neck to waist (back)',
  crotchHeight: 'Crotch height',
  thighGirth: 'Thigh',
  kneeGirth: 'Knee',
  calfGirth: 'Calf',
  ankleGirth: 'Ankle'
};

// User-facing measurement list: age/height/weight + the 14 measured girths/lengths.
// (weightHeightSqrtRatio is derived from height+weight, not entered directly.)
export const BODY_FIELDS: MeasurementDef[] = [
  { name: 'age', label: LABELS.age, kind: 'age', primary: true },
  { name: 'height', label: LABELS.height, kind: 'length', primary: true },
  { name: 'weight', label: LABELS.weight, kind: 'weight', primary: true },
  { name: 'chestGirth', label: LABELS.chestGirth, kind: 'length', primary: true },
  { name: 'waistGirth', label: LABELS.waistGirth, kind: 'length', primary: true },
  { name: 'hipGirth', label: LABELS.hipGirth, kind: 'length', primary: true },
  { name: 'neckGirth', label: LABELS.neckGirth, kind: 'length' },
  { name: 'shoulderWidth', label: LABELS.shoulderWidth, kind: 'length' },
  { name: 'armLength', label: LABELS.armLength, kind: 'length' },
  { name: 'bicepGirth', label: LABELS.bicepGirth, kind: 'length' },
  { name: 'wristGirth', label: LABELS.wristGirth, kind: 'length' },
  { name: 'neckToWaistBack', label: LABELS.neckToWaistBack, kind: 'length' },
  { name: 'crotchHeight', label: LABELS.crotchHeight, kind: 'length' },
  { name: 'thighGirth', label: LABELS.thighGirth, kind: 'length' },
  { name: 'kneeGirth', label: LABELS.kneeGirth, kind: 'length' },
  { name: 'calfGirth', label: LABELS.calfGirth, kind: 'length' },
  { name: 'ankleGirth', label: LABELS.ankleGirth, kind: 'length' }
];

export function unitSuffix(kind: MeasurementUnitKind, imperial: boolean): string {
  if (kind === 'age') return 'yr';
  if (kind === 'weight') return imperial ? 'lb' : 'kg';
  return imperial ? 'in' : 'cm';
}
