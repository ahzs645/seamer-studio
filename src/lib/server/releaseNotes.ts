export interface ReleaseNote {
  version: string;
  date: string;
  content: string;
}

// Newest first. The first entry's version is reported by /api/user/latest-version
// and drives the studio "What's new" splash.
export const releaseNotes: ReleaseNote[] = [
  {
    version: '1.0.0',
    date: '2026-06-02',
    content: [
      '## Seamer 1.0',
      '',
      '- GPU cloth simulation with improved loop management',
      '- PDF and HPGL export, autosave settings',
      '- Mirror constraints for bezier handles and a categorized formula picker',
      '- Material shrinkage scaling and history management',
      '- Seamly2D / Valentina importer (.val / .sm2d / .xml)',
      '- Marker nesting with left/right cut counts and tiled multi-page print',
      '- Per-edge variable-width seam allowance'
    ].join('\n')
  },
  {
    version: '0.9.0',
    date: '2026-05-15',
    content: [
      '## Public preview',
      '',
      '- 2D pattern drafting with parametric formulas and constraints',
      '- 3D try-on with avatar measurements',
      '- DXF, SVG and PNG export'
    ].join('\n')
  }
];

export const latestVersion = releaseNotes[0].version;
