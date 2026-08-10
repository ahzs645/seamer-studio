export type SampleDimension = '2D' | '3D';

export interface ReferenceSspTemplate {
  key: string;
  name: string;
  sourceName: string;
  description: string;
  author: string;
  file: string;
  dimension: SampleDimension;
  pieces: number;
  seams: number;
  materials: number;
  cached3dVertices: number;
}

/**
 * Complete native SSP projects recovered from SeamScape's public pattern library.
 *
 * Keep this list ordered like the archived source catalog. The metadata is also used by the
 * Templates menu, so people can distinguish similarly named projects before loading them.
 */
export const referenceSspTemplates: readonly ReferenceSspTemplate[] = [
  {
    key: 'toobigpants-madi-moss',
    name: 'TOOBIGPANTS — Madi Moss',
    sourceName: 'TOOBIGPANTS',
    description: 'Most recent public TOOBIGPANTS project.',
    author: 'Madi Moss',
    file: 'reference-ssp/01-toobigpants-madi-moss.seamer.ssp',
    dimension: '3D', pieces: 10, seams: 22, materials: 6, cached3dVertices: 13448
  },
  {
    key: 'toobigpants-rosemary-stjacques',
    name: 'TOOBIGPANTS — Rosemary StJacques',
    sourceName: 'TOOBIGPANTS',
    description: 'Public TOOBIGPANTS project shared by Rosemary StJacques.',
    author: 'Rosemary StJacques',
    file: 'reference-ssp/02-toobigpants-rosemary-stjacques.seamer.ssp',
    dimension: '3D', pieces: 10, seams: 22, materials: 6, cached3dVertices: 16850
  },
  {
    key: 'flare-dress',
    name: 'Sleeveless Fit & Flare Dress',
    sourceName: 'Sleeveless fit and flare dress',
    description: 'V-neck dress with a circular flounce.',
    author: 'chife peter',
    file: 'reference-ssp/03-sleeveless-fit-and-flare-dress.seamer.ssp',
    dimension: '3D', pieces: 10, seams: 12, materials: 4, cached3dVertices: 0
  },
  {
    key: 'panty-block',
    name: 'Panty Block',
    sourceName: 'Panty Block',
    description: 'Basic high-waisted panty block.',
    author: 'Aasiyah Muhammad',
    file: 'reference-ssp/04-panty-block.seamer.ssp',
    dimension: '2D', pieces: 3, seams: 0, materials: 0, cached3dVertices: 0
  },
  {
    key: 'oversized-blazer',
    name: 'My Oversized Blazer (WIP)',
    sourceName: 'My Oversized Blazer (WIP)',
    description: 'Oversized longline blazer base with a two-piece sleeve.',
    author: 'Goutham',
    file: 'reference-ssp/05-my-oversized-blazer-wip.seamer.ssp',
    dimension: '2D', pieces: 14, seams: 5, materials: 7, cached3dVertices: 0
  },
  {
    key: 'flared-midi-dress',
    name: 'Flared Midi Dress',
    sourceName: 'Flared midi dress',
    description: 'UK 12 fitted bodice and flared midi skirt.',
    author: 'chife peter',
    file: 'reference-ssp/06-flared-midi-dress.seamer.ssp',
    dimension: '2D', pieces: 10, seams: 0, materials: 0, cached3dVertices: 0
  },
  {
    key: 'nightwing-logo',
    name: 'Nightwing Logo',
    sourceName: 'Nightwing Logo',
    description: 'Nightwing chest-logo applique.',
    author: 'Wesley Whaits',
    file: 'reference-ssp/07-nightwing-logo.seamer.ssp',
    dimension: '2D', pieces: 1, seams: 0, materials: 0, cached3dVertices: 0
  },
  {
    key: 'womens-jacket',
    name: "Women's Jacket",
    sourceName: "Women's jacket",
    description: "Ladies' basic jacket with two-piece sleeves.",
    author: 'chife peter',
    file: 'reference-ssp/08-women-s-jacket.seamer.ssp',
    dimension: '3D', pieces: 14, seams: 0, materials: 7, cached3dVertices: 0
  },
  {
    key: 'black-dress',
    name: 'Black Dress',
    sourceName: 'Black Dress',
    description: 'Simple little black dress.',
    author: 'Ash Walker Pallister',
    file: 'reference-ssp/09-black-dress.seamer.ssp',
    dimension: '3D', pieces: 7, seams: 13, materials: 1, cached3dVertices: 0
  },
  {
    key: 'pencil-skirt',
    name: 'Pencil skirt - 3D',
    sourceName: 'Pencil skirt - 3D',
    description: 'Pencil skirt with waistband and multiple seams.',
    author: 'Illumetric',
    file: 'pencil-skirt.seamer.ssp',
    dimension: '3D', pieces: 4, seams: 12, materials: 2, cached3dVertices: 0
  },
  {
    key: 'russ-pants',
    name: 'Russ Pants',
    sourceName: 'russ pants',
    description: 'Basic Norwegian russ party pants.',
    author: 'xkmhs x',
    file: 'reference-ssp/11-russ-pants.seamer.ssp',
    dimension: '3D', pieces: 6, seams: 9, materials: 2, cached3dVertices: 0
  },
  {
    key: 'parametric-shirt',
    name: 'The Parametric Shirt',
    sourceName: 'The parametric shirt',
    description: 'Long-sleeve shirt controlled by measurements.',
    author: 'Illumetric',
    file: 'reference-ssp/12-the-parametric-shirt.seamer.ssp',
    dimension: '3D', pieces: 7, seams: 16, materials: 2, cached3dVertices: 0
  },
  {
    key: 'long-sleeve-shirt',
    name: 'Long Sleeve Shirt',
    sourceName: 'Long sleeve shirt',
    description: 'Long-sleeve shirt with collar and cuffs.',
    author: 'Illumetric',
    file: 'reference-ssp/13-long-sleeve-shirt.seamer.ssp',
    dimension: '3D', pieces: 7, seams: 21, materials: 2, cached3dVertices: 0
  },
  {
    key: 'shirt-with-pocket',
    name: 'Shirt with a Pocket',
    sourceName: 'Shirt with a pocket',
    description: 'Shirt test project with a front chest pocket.',
    author: 'Illumetric',
    file: 'reference-ssp/14-shirt-with-a-pocket.seamer.ssp',
    dimension: '3D', pieces: 5, seams: 19, materials: 2, cached3dVertices: 0
  },
  {
    key: 'test-shirt-3d',
    name: 'Test Shirt — 3D',
    sourceName: 'Test shirt in 3D',
    description: 'Textured 3D demo shirt.',
    author: 'Illumetric',
    file: 'reference-ssp/15-test-shirt-in-3d.seamer.ssp',
    dimension: '3D', pieces: 4, seams: 15, materials: 1, cached3dVertices: 0
  },
  {
    key: 'simple-pants',
    name: 'Simple Pants — 3D',
    sourceName: 'Simple Pants in 3D',
    description: 'Simple six-piece pants draft prepared for simulation.',
    author: 'Illumetric',
    file: 'reference-ssp/16-simple-pants-in-3d.seamer.ssp',
    dimension: '3D', pieces: 6, seams: 14, materials: 2, cached3dVertices: 0
  },
  {
    key: 'pencil-skirt-2d-tutorial',
    name: 'Pencil Skirt — 2D Tutorial',
    sourceName: 'Pencil skirt - YouTube tutorial',
    description: 'Pencil-skirt draft from the SeamScape video tutorial.',
    author: 'Illumetric',
    file: 'reference-ssp/17-pencil-skirt-2d-youtube-tutorial.seamer.ssp',
    dimension: '2D', pieces: 2, seams: 0, materials: 0, cached3dVertices: 0
  },
  {
    key: 'pencil-skirt-2d',
    name: 'Pencil Skirt — 2D BodyDouble',
    sourceName: 'Pencil skirt - With BodyDouble',
    description: 'Body-driven 2D pencil-skirt draft.',
    author: 'Illumetric',
    file: 'reference-ssp/18-pencil-skirt-2d-with-bodydouble.seamer.ssp',
    dimension: '2D', pieces: 2, seams: 0, materials: 0, cached3dVertices: 0
  },
  {
    key: 'tshirt-basic',
    name: 'T-Shirt — Basic',
    sourceName: 'T-shirt - basic',
    description: 'Variable-driven front and back T-shirt draft.',
    author: 'Illumetric',
    file: 'reference-ssp/19-t-shirt-basic.seamer.ssp',
    dimension: '2D', pieces: 4, seams: 0, materials: 0, cached3dVertices: 0
  },
  {
    key: 'tailored-shirt',
    name: 'The Tailored Shirt',
    sourceName: 'The tailored shirt',
    description: "Sample shirt pattern from Aldrich's book.",
    author: 'Illumetric',
    file: 'reference-ssp/20-the-tailored-shirt.seamer.ssp',
    dimension: '2D', pieces: 6, seams: 0, materials: 0, cached3dVertices: 0
  },
  {
    key: 'toobigpants-downloads-variant',
    name: 'TOOBIGPANTS — Downloads Variant',
    sourceName: 'TOOBIGPANTS',
    description: 'Distinct TOOBIGPANTS project recovered from Downloads.',
    author: 'Madi Moss',
    file: 'reference-ssp/21-toobigpants-downloads-variant-1.seamer.ssp',
    dimension: '3D', pieces: 10, seams: 22, materials: 6, cached3dVertices: 13448
  }
];
