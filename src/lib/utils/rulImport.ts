// Gerber/AccuMark RUL grade-rule-table importer. A .RUL file is plain text:
//   GRADE RULE TABLE: <name>
//   <NUMERIC | ALPHANUMERIC>            (sizing scheme)
//   UNITS: <INCHES | CM | MM>           (optional; Gerber default is inches)
//   SIZE LIST: <size> <size> ...
//   SAMPLE SIZE: <size>                 (the base size the pattern is drafted in)
//   RULE <n>                            (numbered rules referenced by graded DXF points)
//     dx dy                             (one X/Y offset per size *break*, i.e. between each
//     dx dy                              consecutive pair in the size list — sizes-1 lines)
// Offsets are parsed into millimeters regardless of the file's units.

import type { Pattern, GradeSize } from '@seamer/pattern-model';

export interface RulSizeBreak {
  dx: number; // mm
  dy: number; // mm
}

export interface RulTable {
  name: string;
  isNumeric: boolean;
  units: 'inch' | 'cm' | 'mm';
  sizes: string[];
  sampleSize: string;
  /** rule number -> offsets per size break (break i = sizes[i] → sizes[i+1]). */
  rules: Map<number, RulSizeBreak[]>;
}

const COMMENT_RE = /^(\*|#|\/\/|REM\b)/i;
const RULE_RE = /^RULE\s*:?\s*(\d+)\s*$/i;

function unitToMm(token: string): { units: RulTable['units']; mm: number } | null {
  const t = token.toLowerCase();
  if (t.startsWith('in')) return { units: 'inch', mm: 25.4 };
  if (t.startsWith('cm') || t.startsWith('centi')) return { units: 'cm', mm: 10 };
  if (t.startsWith('mm') || t.startsWith('milli')) return { units: 'mm', mm: 1 };
  return null;
}

/** Parse RUL text. Tolerant of comments, blank lines and varying whitespace; throws on malformed input. */
export function parseRul(text: string): RulTable {
  const lines = String(text ?? '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !COMMENT_RE.test(l));
  if (!lines.length) throw new Error('Empty RUL file');

  let name: string | null = null;
  let isNumeric = true;
  let units: RulTable['units'] = 'inch';
  let mmPerUnit = 25.4;
  let sizes: string[] = [];
  let sampleSize: string | null = null;
  const rules = new Map<number, RulSizeBreak[]>();
  let currentRule: RulSizeBreak[] | null = null;

  for (const line of lines) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^GRADE\s+RULE\s+TABLE\s*:?\s*(.*)$/i))) {
      name = m[1].trim() || 'Untitled';
    } else if ((m = line.match(RULE_RE))) {
      if (name === null) throw new Error('RUL: rule body before "GRADE RULE TABLE:" header');
      const num = parseInt(m[1], 10);
      currentRule = [];
      rules.set(num, currentRule);
    } else if ((m = line.match(/^SIZE\s+LIST\s*:?\s*(.*)$/i))) {
      sizes = m[1].split(/[\s,]+/).filter(Boolean);
      if (!sizes.length) throw new Error('RUL: "SIZE LIST:" line has no sizes');
    } else if ((m = line.match(/^SAMPLE\s+SIZE\s*:?\s*(\S+)/i))) {
      sampleSize = m[1];
    } else if ((m = line.match(/^UNITS?\s*:?\s*(\S+)/i))) {
      const u = unitToMm(m[1]);
      if (!u) throw new Error(`RUL: unknown unit "${m[1]}" (expected inches, cm or mm)`);
      units = u.units;
      mmPerUnit = u.mm;
    } else if (/ALPHA\s*NUMERIC/i.test(line)) {
      isNumeric = false;
    } else if (/^NUMERIC\b/i.test(line)) {
      isNumeric = true;
    } else if (currentRule) {
      // offset line(s) inside a rule: an even count of numbers = one or more dx/dy pairs
      const nums = line.split(/[\s,]+/).map(Number);
      if (nums.some((n) => Number.isNaN(n)) || nums.length % 2 !== 0) {
        throw new Error(`RUL: malformed offset line "${line}" (expected dx dy pairs)`);
      }
      for (let i = 0; i + 1 < nums.length; i += 2) {
        currentRule.push({ dx: nums[i] * mmPerUnit, dy: nums[i + 1] * mmPerUnit });
      }
    }
    // unknown header keywords outside a rule body are ignored (tolerant)
  }

  if (name === null) throw new Error('Not a RUL grade rule table (missing "GRADE RULE TABLE:" header)');
  if (!sizes.length) throw new Error('RUL: missing "SIZE LIST:" line');
  if (sampleSize === null) sampleSize = sizes[0];
  if (!sizes.includes(sampleSize)) {
    throw new Error(`RUL: sample size "${sampleSize}" is not in the size list (${sizes.join(', ')})`);
  }
  return { name, isNumeric, units, sizes, sampleSize, rules };
}

/**
 * Cumulative X/Y offset (mm) a point governed by `ruleNumber` moves going from the sample size to
 * `sizeName` — the sum of the size-break deltas between them (negated when grading down).
 */
export function cumulativeRuleOffset(table: RulTable, ruleNumber: number, sizeName: string): RulSizeBreak {
  const breaks = table.rules.get(ruleNumber);
  if (!breaks) throw new Error(`RUL: no rule ${ruleNumber} in table "${table.name}"`);
  const from = table.sizes.indexOf(table.sampleSize);
  const to = table.sizes.indexOf(sizeName);
  if (to < 0) throw new Error(`RUL: size "${sizeName}" is not in the size list`);
  let dx = 0, dy = 0;
  // break i sits between sizes[i] and sizes[i+1]
  for (let i = Math.min(from, to); i < Math.max(from, to); i++) {
    const b = breaks[i] ?? { dx: 0, dy: 0 };
    dx += b.dx;
    dy += b.dy;
  }
  return to < from ? { dx: -dx, dy: -dy } : { dx, dy };
}

const SIZE_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

export interface ApplyRulOptions {
  /** size to load as the current/base size (defaults to the table's sample size) */
  chosenSize?: string;
}

/**
 * Populate pattern.gradingProfile.sizes from the table's size list and set the chosen size as the
 * pattern's current (base) size.
 *
 * Limitation: the Seamer schema grades via per-size variable overrides / proportional scale /
 * alteration tracks — there is no per-point "grade rule number" field, and the DXF importer does
 * not carry AAMA grade-rule references onto points. So rule offsets cannot be mapped onto graded
 * point geometry here; we store the size labels (scale 1 = same shape until graded) and leave the
 * parsed rules available via `cumulativeRuleOffset` for a future point→rule assignment UI.
 */
export function applyRulToPattern(pattern: Pattern, table: RulTable, opts: ApplyRulOptions = {}): Pattern {
  const base = opts.chosenSize ?? table.sampleSize;
  if (!table.sizes.includes(base)) {
    throw new Error(`RUL: chosen size "${base}" is not in the size list (${table.sizes.join(', ')})`);
  }
  const sizes: GradeSize[] = table.sizes
    .filter((s) => s !== base)
    .map((s, i) => ({
      id: `GradeSize_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`,
      name: s,
      scale: 1,
      color: SIZE_COLORS[i % SIZE_COLORS.length]
    }));
  // persist the parsed table (serializable form) so per-point grade anchors preview live
  pattern.gradingProfile = {
    ...(pattern.gradingProfile ?? {}),
    sizes,
    rulTable: toStoredRul({ ...table, sampleSize: base })
  };
  pattern.currentSize = base;
  pattern.hasChanged = true;
  return pattern;
}

// ---- persistent grading profile (the original's GradingProfile + grade anchors) -------------------

export type StoredRulTable = NonNullable<NonNullable<Pattern['gradingProfile']>['rulTable']>;

export function toStoredRul(table: RulTable): StoredRulTable {
  return {
    name: table.name,
    isNumeric: table.isNumeric,
    units: table.units,
    sizes: table.sizes,
    sampleSize: table.sampleSize,
    rules: Object.fromEntries([...table.rules.entries()].map(([k, v]) => [String(k), v]))
  };
}

export function fromStoredRul(s: StoredRulTable): RulTable {
  return {
    name: s.name,
    isNumeric: s.isNumeric,
    units: s.units as RulTable['units'],
    sizes: s.sizes,
    sampleSize: s.sampleSize,
    rules: new Map(Object.entries(s.rules).map(([k, v]) => [Number(k), v]))
  };
}

/**
 * Live per-size geometry from the stored RUL table: every point bound to a rule (gradingProfile.
 * rulAnchors) shifts by that rule's cumulative offset from the sample size to `sizeName`.
 * No-op when the profile has no table/anchors or the size isn't in the table.
 */
export function applyRulOffsetsToPattern(pattern: Pattern, sizeName: string): Pattern {
  const gp = pattern.gradingProfile;
  if (!gp?.rulTable || !gp.rulAnchors?.length) return pattern;
  const table = fromStoredRul(gp.rulTable);
  if (!table.sizes.includes(sizeName) || sizeName === table.sampleSize) return pattern;
  const byPoint = new Map<string, RulSizeBreak>();
  for (const a of gp.rulAnchors) {
    try {
      byPoint.set(a.pointId, cumulativeRuleOffset(table, a.ruleNumber, sizeName));
    } catch { /* unknown rule/size: skip the anchor */ }
  }
  if (byPoint.size === 0) return pattern;
  return {
    ...pattern,
    points: pattern.points.map((p) => {
      const o = byPoint.get(p.id);
      return o ? { ...p, x: p.x + o.dx, y: p.y + o.dy } : p;
    })
  };
}

/** One-call helper for the studio import flow: parse the RUL text and apply it to the pattern. */
export function importRulFile(text: string, pattern: Pattern, chosenSize?: string): { pattern: Pattern; table: RulTable } {
  const table = parseRul(text);
  return { pattern: applyRulToPattern(pattern, table, { chosenSize }), table };
}
