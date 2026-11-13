/*
 * The 64 Brother PEC colours and the colour matching rules, typed from blueprint/pes-spec.md section 4 (the table
 * and the prose), not from js/engine/embwriter.js. Used to predict which palette byte a thread colour must get.
 */
'use strict';

// index 1..64 -> [r, g, b, name]
const TABLE = [null,
  [14, 31, 124, 'Prussian Blue'], [10, 85, 163, 'Blue'], [0, 135, 119, 'Teal Green'], [75, 107, 175, 'Cornflower Blue'],
  [237, 23, 31, 'Red'], [209, 92, 0, 'Reddish Brown'], [145, 54, 151, 'Magenta'], [228, 154, 203, 'Light Lilac'],
  [145, 95, 172, 'Lilac'], [158, 214, 125, 'Mint Green'], [232, 169, 0, 'Deep Gold'], [254, 186, 53, 'Orange'],
  [255, 255, 0, 'Yellow'], [112, 188, 31, 'Lime Green'], [186, 152, 0, 'Brass'], [168, 168, 168, 'Silver'],
  [125, 111, 0, 'Russet Brown'], [255, 255, 179, 'Cream Brown'], [79, 85, 86, 'Pewter'], [0, 0, 0, 'Black'],
  [11, 61, 145, 'Ultramarine'], [119, 1, 118, 'Royal Purple'], [41, 49, 51, 'Dark Gray'], [42, 19, 1, 'Dark Brown'],
  [246, 74, 138, 'Deep Rose'], [178, 118, 36, 'Light Brown'], [252, 187, 197, 'Salmon Pink'], [254, 55, 15, 'Vermilion'],
  [240, 240, 240, 'White'], [106, 28, 138, 'Violet'], [168, 221, 196, 'Seacrest'], [37, 132, 187, 'Sky Blue'],
  [254, 179, 67, 'Pumpkin'], [255, 243, 107, 'Cream Yellow'], [208, 166, 96, 'Khaki'], [209, 84, 0, 'Clay Brown'],
  [102, 186, 73, 'Leaf Green'], [19, 74, 70, 'Peacock Blue'], [135, 135, 135, 'Gray'], [216, 204, 198, 'Warm Gray'],
  [67, 86, 7, 'Dark Olive'], [253, 217, 222, 'Flesh Pink'], [249, 147, 188, 'Pink'], [0, 56, 34, 'Deep Green'],
  [178, 175, 212, 'Lavender'], [104, 106, 176, 'Wisteria Violet'], [239, 227, 185, 'Beige'], [247, 56, 102, 'Carmine'],
  [181, 75, 100, 'Amber Red'], [19, 43, 26, 'Olive Green'], [199, 1, 86, 'Dark Fuchsia'], [254, 158, 50, 'Tangerine'],
  [168, 222, 235, 'Light Blue'], [0, 103, 62, 'Emerald Green'], [78, 41, 144, 'Purple'], [47, 126, 32, 'Moss Green'],
  [255, 204, 204, 'Flesh Pink'], [255, 217, 17, 'Harvest Gold'], [9, 91, 166, 'Electric Blue'], [240, 249, 112, 'Lemon Yellow'],
  [227, 243, 91, 'Fresh Green'], [255, 153, 0, 'Orange'], [255, 240, 141, 'Cream Yellow'], [255, 200, 200, 'Applique'],
];
const RGB = TABLE.map(t => (t ? [t[0], t[1], t[2]] : null));

const hex = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
// "redmean" distance in integers; the mean of the two reds rounds half to even
function distance(a, b) {
  const sum = a[0] + b[0], mean = sum % 2 === 0 ? sum / 2 : ((sum - 1) / 2) % 2 === 0 ? (sum - 1) / 2 : (sum + 1) / 2;
  const r = a[0] - b[0], g = a[1] - b[1], bl = a[2] - b[2];
  return Math.floor(((512 + mean) * r * r) / 256) + 4 * g * g + Math.floor(((767 - mean) * bl * bl) / 256);
}
// ties go to the highest index; null entries are skipped
function nearest(rgb, list) {
  let best = null, bd = Infinity;
  list.forEach((v, i) => { if (!v) return; const d = distance(rgb, v); if (d <= bd) { bd = d; best = i; } });
  return best;
}
// colours: ['#rrggbb'] in sewing order -> the palette byte of every colour block (spec 4, buildUniquePalette)
function uniquePalette(colours) {
  const free = RGB.slice(), chart = RGB.map(() => null), seen = new Set();
  for (const c of colours) {
    if (seen.has(c)) continue; seen.add(c);
    const i = nearest(hex(c), free);
    if (i === null) break;
    free[i] = null; chart[i] = hex(c);
  }
  return colours.map(c => nearest(hex(c), chart));
}
const plain = c => nearest(hex(c), RGB);
const nameOf = i => (TABLE[i] ? TABLE[i][3] : '?');
const hexOf = i => '#' + RGB[i].map(v => ('0' + v.toString(16)).slice(-2)).join('');

module.exports = { TABLE, RGB, hex, distance, nearest, uniquePalette, plain, nameOf, hexOf };
