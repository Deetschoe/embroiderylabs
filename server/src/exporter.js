// The machine file, made by the SAME engine the browser runs (js/engine/*.js, UMD scripts).
// wrangler bundles these CommonJS files into the Worker; node's ESM loader imports them as CommonJS.

import Engine from '../../js/engine/engine.js';

export { Engine };

export const FORMAT_IDS = Engine.FORMATS.map(f => f.id);      // pes, dst, pec, pes6
export const MAX_OBJECTS = 5000;

// A quick sanity check of the request before the engine sees it. The engine itself
// never throws for bad design data; it reports warnings instead.
export function checkDesign(design) {
  if (!design || typeof design !== 'object' || Array.isArray(design)) return 'Send the design.';
  if (!Array.isArray(design.objects) || !design.objects.length) return 'Nothing to export yet. Draw a shape first.';
  if (design.objects.length > MAX_OBJECTS) return 'That design has too many shapes for one file.';
  return '';
}

// Exactly what the editor does: Engine.generate(design), then Engine.export(result, { format, name }).
export function generate(design) {
  return Engine.generate(design);
}
export function exportFile(result, format, name) {
  return Engine.export(result, { format, name });
}
