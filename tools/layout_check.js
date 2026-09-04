/*
 * Does the field actually fit together?
 *
 * crops.js declares sizes as intentions in metres and planner.js measures each model on load and
 * makes them true. That leaves one question only the real model files can answer: given what
 * these models actually are, do the pieces fit inside the bed and clear of each other?
 *
 * Nothing in the browser would tell you they do not. A tool standing through the fence, or two
 * tools intersecting, renders perfectly happily. Both have shipped.
 *
 * So this reads the .glb files, applies exactly the same normalisation planner.js applies, and
 * checks the geometry off-device, before spending a phone test on it.
 *
 * Run from the app folder:  node tools/layout_check.js
 */
'use strict';

var fs = require('fs');
var path = require('path');

var APP = path.join(__dirname, '..');
var C = require(path.join(APP, 'js', 'crops.js'));

var problems = 0;

function check(ok, label, detail) {
  if (ok) {
    console.log('  ok    ' + label + (detail ? '\n          ' + detail : ''));
  } else {
    problems++;
    console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : ''));
  }
}

/* ---------------------------------------------------------------- reading a .glb */

function gltfJson(file) {
  var b = fs.readFileSync(file);
  var off = 12;                                  // past the 12 byte header

  while (off < b.length) {
    var len = b.readUInt32LE(off);
    var type = b.readUInt32LE(off + 4);
    if (type === 0x4E4F534A) {                   // 'JSON'
      return JSON.parse(b.slice(off + 8, off + 8 + len).toString('utf8'));
    }
    off += 12 + len - 4;
  }
  throw new Error('no JSON chunk in ' + file);
}

function mul(a, b) {
  var r = new Array(16).fill(0);
  for (var c = 0; c < 4; c++) {
    for (var row = 0; row < 4; row++) {
      var s = 0;
      for (var k = 0; k < 4; k++) { s += a[k * 4 + row] * b[c * 4 + k]; }
      r[c * 4 + row] = s;
    }
  }
  return r;
}

function nodeMatrix(n) {
  if (n.matrix) { return n.matrix.slice(); }

  var t = n.translation || [0, 0, 0];
  var q = n.rotation || [0, 0, 0, 1];
  var s = n.scale || [1, 1, 1];
  var x = q[0], y = q[1], z = q[2], w = q[3];
  var x2 = x + x, y2 = y + y, z2 = z + z;
  var xx = x * x2, xy = x * y2, xz = x * z2;
  var yy = y * y2, yz = y * z2, zz = z * z2;
  var wx = w * x2, wy = w * y2, wz = w * z2;

  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1
  ];
}

// The model's box in the coordinates it actually renders at, node transforms applied. This is the
// measurement `gltf-transform inspect` does not give you: its numbers are raw vertex extents, so
// it reported 0.002 for a bag whose own node scales it by 100.
function sceneBox(file) {
  var j = gltfJson(file);
  var min = [Infinity, Infinity, Infinity];
  var max = [-Infinity, -Infinity, -Infinity];

  function walk(i, parent) {
    var n = j.nodes[i];
    var m = mul(parent, nodeMatrix(n));

    if (n.mesh !== undefined) {
      j.meshes[n.mesh].primitives.forEach(function (p) {
        var a = j.accessors[p.attributes.POSITION];
        if (!a || !a.min) { return; }

        for (var corner = 0; corner < 8; corner++) {
          var v = [
            corner & 1 ? a.max[0] : a.min[0],
            corner & 2 ? a.max[1] : a.min[1],
            corner & 4 ? a.max[2] : a.min[2]
          ];
          var w = [
            m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
            m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
            m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]
          ];
          for (var k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], w[k]);
            max[k] = Math.max(max[k], w[k]);
          }
        }
      });
    }

    (n.children || []).forEach(function (c) { walk(c, m); });
  }

  var identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  j.scenes[j.scene || 0].nodes.forEach(function (i) { walk(i, identity); });

  return { min: min, max: max, size: max.map(function (v, i) { return v - min[i]; }) };
}

// The same rule as normaliseModel() in planner.js. If that changes, change this with it.
function normalised(file, sizeM, fit) {
  var box = sceneBox(file);
  var measured = fit === 'width' ? Math.max(box.size[0], box.size[2]) : box.size[1];
  var s = sizeM / measured;

  return {
    scale: s,
    size: box.size.map(function (v) { return v * s; }),
    raw: box
  };
}

/* ---------------------------------------------------------------- the checks */

console.log('Layout checks\n');
console.log('  bed ' + C.PLOT_SIZE_M + ' m, edges at +/-' + (C.PLOT_SIZE_M / 2).toFixed(3) +
  ', grid ' + C.FIELD.cols + 'x' + C.FIELD.rows + ' to +/-' + C.gridHalfSpanM().toFixed(3) + '\n');

var half = C.PLOT_SIZE_M / 2;

// Footprint as it lands in the bed, resting yaw applied. The sack is turned a quarter turn to lie
// along its edge, which swaps its long and short sides, and that swap is the difference between
// fitting and standing through the fence.
var fitted = C.TOOLS.map(function (t) {
  var n = normalised(path.join(APP, t.model.replace('./', '')), t.sizeM, 'height');
  var quarter = Math.abs(Math.round((t.yaw || 0) / 90)) % 2 === 1;
  var size = quarter ? [n.size[2], n.size[1], n.size[0]] : n.size;

  return { def: t, size: size, scale: n.scale, turned: quarter };
});

// A tool may reach the fence line but not past it by more than the rail's own thickness. The rail
// straddles the edge, so anything within half its depth is inside the fence rather than through
// it. That is where the tolerance comes from, not from a round number that makes the check pass.
var fenceHalfDepth = C.FENCE.sourceDepth *
  (C.PLOT_SIZE_M / C.FENCE.sectionsPerSide / C.FENCE.sourceWidth) / 2;

console.log('  fence line at +/-' + half.toFixed(3) + ', rail half-depth ' +
  fenceHalfDepth.toFixed(4) + ' m\n');

fitted.forEach(function (f) {
  var d = f.def;
  var outX = Math.abs(d.home.x) + f.size[0] / 2 - half;
  var outZ = Math.abs(d.home.z) + f.size[2] / 2 - half;
  var worst = Math.max(outX, outZ);

  console.log('  ' + d.id + '  ' + f.size.map(function (v) { return v.toFixed(3); }).join(' x ') +
    ' m   home ' + d.home.x.toFixed(3) + ', ' + d.home.z.toFixed(3) +
    (f.turned ? '   turned ' + d.yaw + ' deg' : ''));

  check(worst <= fenceHalfDepth,
    d.id + ' stays within the fence',
    worst > fenceHalfDepth
      ? 'stands through it by ' + (worst - fenceHalfDepth).toFixed(3) +
        ' m. Reduce its sizeM, or turn it with yaw so its long side runs along the edge'
      : worst > 0
        ? 'reaches the fence line and overlaps the rail by ' + worst.toFixed(3) +
          ' m, inside the rail itself'
        : (-worst).toFixed(3) + ' m short of the fence line');
});

// Two footprints overlap only if they overlap on BOTH axes.
var a = fitted[0], b = fitted[1];
var gapX = Math.abs(a.def.home.x - b.def.home.x) - (a.size[0] + b.size[0]) / 2;
var gapZ = Math.abs(a.def.home.z - b.def.home.z) - (a.size[2] + b.size[2]) / 2;

// Report whichever axis actually separates them, not just x. This once printed "they intersect"
// underneath an "ok", which is worse than useless: a wrong explanation gets believed over a right
// verdict.
var gap = Math.max(gapX, gapZ);

check(gap > 0,
  'the two tools do not overlap each other',
  gap > 0
    ? gap.toFixed(3) + ' m of clear space between them, along ' + (gapX > gapZ ? 'x' : 'z')
    : 'they intersect. Widen TOOL_GAP_FRACTION or reduce sizeM');

// A mature plant is exactly as wide as its required spacing. That is the whole spacing lesson, so
// it is asserted rather than trusted.
var crop = C.CROPS[0];
var plant = normalised(path.join(APP, crop.model.replace('./', '')), 1, 'width');
var matureW = C.matureWidthM(crop);

check(Math.abs(matureW - crop.spacingCm / 100) < 1e-9,
  'a mature plant is exactly one spacing wide',
  matureW.toFixed(3) + ' m against a ' + crop.spacingCm + ' cm spacing, height ' +
  (plant.size[1] * matureW).toFixed(3) + ' m');

// The why-WebXR claim, as a check rather than a sentence in the report. If one position ever
// covered the whole field, the app would work as well as a web page with a WATER button on it.
var step = crop.spacingCm / 100;
var reached = 0;
var total = C.FIELD.rows * C.FIELD.cols;

for (var r = 0; r < C.FIELD.rows; r++) {
  for (var col = 0; col < C.FIELD.cols; col++) {
    var px = -C.gridHalfSpanM() + col * step;
    var pz = -C.gridHalfSpanM() + r * step;
    if (Math.sqrt(px * px + pz * pz) <= C.TOOLS[0].radiusM) { reached++; }
  }
}

// The harvest hand has to reach less far than one spacing, or one touch clears a plant and all
// four of its neighbours. It was set to 1.4 spacings once and a single touch took five plants.
var spacingM = crop.spacingCm / 100;

check(C.HARVEST.reachM <= spacingM / 2,
  'the harvest hand picks one plant at a time',
  C.HARVEST.reachM > spacingM / 2
    ? 'reaches ' + C.HARVEST.reachM.toFixed(3) + ' m, more than half the ' + spacingM.toFixed(2) +
      ' m spacing, so one touch clears a plant and its neighbours'
    : 'reaches ' + C.HARVEST.reachM.toFixed(3) + ' m, exactly one mature plant wide across, ' +
      'against a ' + spacingM.toFixed(2) + ' m spacing');

check(reached < total,
  'the field cannot be watered from one position',
  'the can reaches ' + reached + ' of ' + total + ' plants from the bed centre, so the user has ' +
  'to move around a real object. This is the argument for the app being AR at all');

console.log('');

if (problems) {
  console.log(problems + ' problem' + (problems === 1 ? '' : 's') + ' found');
  process.exit(1);
}

console.log('all checks passed');
