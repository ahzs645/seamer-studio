// Built-in template registry shared by the flow template browser (/flow/templates) and the
// template editor (/flow/templates/edit/[[slug]]). Files live in static/templates/.

export interface BuiltinTemplate {
  slug: string;
  name: string;
  description: string;
  file: string;
}

const tpl = (name: string, description: string, file: string): BuiltinTemplate => ({
  slug: file.replace(/\.raw\.json$|\.json$/i, ''),
  name,
  description,
  file
});

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  tpl('Parametric Skirt', 'Truly parametric: waist/hip/length variables re-draft the geometry; grades by size', 'parametric-skirt.json'),
  tpl('Trousers', 'Simple pants in 3D (full 3D data)', 'simple-pants-3d.json'),
  tpl('Fit & Flare Dress', 'Sleeveless fit and flare dress — converted from a 2D export', 'flare-dress.raw.json'),
  tpl('Pencil Skirt (3D)', 'Pencil skirt with waistband, multi-seam (full 3D data)', 'pencil-skirt.json'),
  tpl('Pencil Skirt (2D)', '2D skirt block that updates with the body', 'pencil-skirt-2d-bodydouble.json'),
  tpl('Pencil Skirt (2D, tutorial)', '2D pencil skirt from the video tutorial', 'pencil-skirt-2d-tutorial.json'),
  tpl('Skirt Block', 'Basic skirt block (Grundschnitt Rock)', 'grundschnitt-rock.json'),
  tpl('Panty Block', 'Basic highwaisted panty block', 'panty-block.json'),
  tpl('Russ Pants', "Norwegian 'russ' party pants", 'russ-pants.json'),
  tpl('T-Shirt (Basic)', 'Front and back pieces with many variables', 'tshirt-basic.json'),
  tpl('Long Sleeve Shirt', 'Long sleeve shirt with collar and cuffs', 'long-sleeve-shirt.json'),
  tpl('Parametric Shirt', 'Long sleeve shirt controlled by measurements', 'parametric-shirt.json'),
  tpl('Shirt with Pocket', 'Shirt with a front chest pocket', 'shirt-with-pocket.json'),
  tpl('Test Shirt (3D)', 'Demo shirt in 3D', 'test-shirt-3d.json'),
  tpl('Tailored Shirt', 'Classic tailored shirt drafted from a drafting book', 'tailored-shirt.json'),
  tpl("Women's Jacket", "Ladies' basic jacket with two-piece sleeves", 'womens-jacket.json'),
  tpl('Oversized Blazer', 'Oversized longline blazer base (work in progress)', 'oversized-blazer.json'),
  tpl('Black Dress', 'Little black dress, simple', 'black-dress.json'),
  tpl('Flared Midi Dress', 'Snug at bust and waist with maxi flared lower part', 'flared-midi-dress.json'),
  tpl('Nightwing Logo', 'Chest logo applique', 'nightwing-logo.json')
];

export const builtinBySlug = (slug: string): BuiltinTemplate | undefined =>
  BUILTIN_TEMPLATES.find((t) => t.slug === slug);
