/*
 * Proof that tools/html_check.js actually catches things.
 *
 * A checker that has only ever printed "all checks passed" is not evidence. Each fixture below is
 * a small reconstruction of a fault that really happened in this project and really shipped to a
 * phone. The test asserts the checker rejects each one, and accepts a clean file.
 *
 * Run from the app folder:  node tools/html_check_test.js
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var child = require('child_process');

var CHECKER = path.join(__dirname, 'html_check.js');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'htmlcheck-'));

var CLEAN = [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8"><title>t</title>',
  '<script>window.AFRAME_CDN_ROOT = "./vendor/aframe-cdn/";</script>',
  '<script src="./vendor/aframe-1.8.0.min.js"></script>',
  '</head><body>',
  '<a-scene id="scene" ar-hit-test="target: #plot" vr-mode-ui="enabled: false">',
  '<a-assets><a-asset-item id="mFence" src="./models/fence.glb"></a-asset-item></a-assets>',
  '<a-entity id="fence"></a-entity>',
  '</a-scene>',
  '</body></html>'
].join('\n');

// The page's script, for the checks that read it as well as the page. It deliberately carries
// `property: position.y` inside two comments, because an earlier version of the animation check
// flagged exactly that: planner.js's own explanation of the bug the check exists to find.
var CLEAN_JS = [
  '// Never write `property: position.y` here, it corrupts the whole vector.',
  '/* The safe form is `property: object3D.position.y`. */',
  "var a = document.getElementById('scene');",
  "a.setAttribute('animation__x', 'property: object3D.position.y; to: 1');",
  "a.setAttribute('animation__y', 'property: material.opacity; to: 0');",
  "a.setAttribute('animation__z', 'property: scale; to: 1 1 1');",
  ''
].join('\n');

// Every fixture is CLEAN with one thing broken, so a failure can only come from that one change.
// Each `expect` is a fragment of the message the checker should produce.
var CASES = [
  {
    name: 'clean file passes',
    html: CLEAN,
    shouldFail: false
  },
  {
    name: 'duplicate id between an asset item and an entity',
    // Real: getElementById returned the asset item, so all eight fence sections were appended
    // inside <a-assets> and never rendered.
    html: CLEAN.replace('id="mFence"', 'id="fence"'),
    shouldFail: true,
    expect: 'duplicate id "fence"'
  },
  {
    name: 'HTML comment between the attributes of a tag',
    // Real: a comment inside <a-scene> turned every following attribute into text, which removed
    // ar-hit-test and with it the whole markerless mode.
    html: CLEAN.replace(
      '<a-scene id="scene" ar-hit-test="target: #plot"',
      '<a-scene id="scene" <!-- reticle sized to the plot --> ar-hit-test="target: #plot"'),
    shouldFail: true,
    expect: 'comment syntax between its attributes'
  },
  {
    name: 'attributes stranded in text content after a tag closed early',
    html: CLEAN.replace(
      'vr-mode-ui="enabled: false">',
      '>\n  shadow="type: pcfsoft"\n  vr-mode-ui="enabled: false">'),
    shouldFail: true,
    expect: 'stranded attribute'
  },
  {
    name: 'a local file that does not exist',
    html: CLEAN.replace('./models/fence.glb', './models/does-not-exist.glb'),
    shouldFail: true,
    expect: 'which is missing'
  },
  {
    name: 'markerless loading A-Frame from a CDN breaks the airplane-mode claim',
    html: CLEAN.replace('./vendor/aframe-1.8.0.min.js',
      'https://aframe.io/releases/1.8.0/aframe.min.js'),
    shouldFail: true,
    expect: 'airplane mode will not work'
  },
  {
    name: 'markerless without AFRAME_CDN_ROOT still fetches its font',
    html: CLEAN.replace('<script>window.AFRAME_CDN_ROOT = "./vendor/aframe-cdn/";</script>', ''),
    shouldFail: true,
    expect: 'AFRAME_CDN_ROOT'
  },
  {
    name: 'the script fetches an id the page does not define',
    // The fixture script asks for #scene. Rename it in the page and the script gets null, which
    // fails later and somewhere else, on a phone, with nothing on screen to say why.
    html: CLEAN.replace('<a-scene id="scene"', '<a-scene id="theScene"'),
    shouldFail: true,
    expect: 'which this page does not define'
  },
  {
    name: 'the script animates position.y without the object3D prefix',
    html: CLEAN,
    // The fault is in the script, not the page, so this case swaps the script instead.
    js: CLEAN_JS.replace("'property: object3D.position.y; to: 1'", "'property: position.y; to: 1'"),
    shouldFail: true,
    expect: 'Write "object3D.position.y" instead'
  },
  {
    name: 'a comment mentioning position.y is not mistaken for code',
    html: CLEAN,
    // The clean script already carries that prose in two comments. This asserts it stays quiet.
    js: CLEAN_JS,
    shouldFail: false
  },
  {
    name: 'a comment that quotes the closing marker and so ends itself early',
    // The real one, built here from pieces so this fixture cannot end its own comment by accident.
    html: CLEAN.replace('<body>',
      '<body>\n<!-- a note that mentions the ' + '--' + '>' + ' marker\n' +
      'and then keeps going for a while as visible page text -->'),
    shouldFail: true,
    expect: 'comment terminator outside any comment'
  },
  {
    name: 'rotation.z without the prefix is caught too',
    html: CLEAN,
    js: CLEAN_JS.replace("'property: scale; to: 1 1 1'", "'property: rotation.z; from: -4; to: 4'"),
    shouldFail: true,
    expect: 'Write "object3D.rotation.z" instead'
  }
];

fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
fs.writeFileSync(path.join(dir, 'js', 'planner.js'), CLEAN_JS);

fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
fs.mkdirSync(path.join(dir, 'vendor', 'aframe-cdn', 'fonts'), { recursive: true });
fs.writeFileSync(path.join(dir, 'models', 'fence.glb'), '');
fs.writeFileSync(path.join(dir, 'vendor', 'aframe-1.8.0.min.js'), '');
fs.writeFileSync(path.join(dir, 'vendor', 'aframe-cdn', 'fonts', 'Roboto-msdf.json'), '');
fs.writeFileSync(path.join(dir, 'vendor', 'aframe-cdn', 'fonts', 'Roboto-msdf.png'), '');

console.log('html_check self test\n');

var failed = 0;

CASES.forEach(function (c) {
  // Named markerless.html because the offline checks only apply to that page.
  var file = path.join(dir, 'markerless.html');
  fs.writeFileSync(file, c.html);

  // Some cases break the script rather than the page. Restore it afterwards for the next case.
  fs.writeFileSync(path.join(dir, 'js', 'planner.js'), c.js || CLEAN_JS);

  var run = child.spawnSync(process.execPath, [CHECKER, file], { encoding: 'utf8' });
  var out = (run.stdout || '') + (run.stderr || '');
  var didFail = run.status !== 0;
  var problems = [];

  if (didFail !== c.shouldFail) {
    problems.push('expected the checker to ' + (c.shouldFail ? 'reject' : 'accept') +
      ' this file, it did not');
  }
  if (c.expect && out.indexOf(c.expect) === -1) {
    problems.push('expected a message containing "' + c.expect + '"');
  }

  if (problems.length) {
    failed++;
    console.log('  FAIL  ' + c.name);
    problems.forEach(function (p) { console.log('          ' + p); });
    console.log(out.split('\n').map(function (l) { return '          | ' + l; }).join('\n'));
  } else {
    console.log('  ok    ' + c.name);
  }
});

fs.rmSync(dir, { recursive: true, force: true });

console.log('');

if (failed) {
  console.log(failed + ' of ' + CASES.length + ' checks did not behave as expected');
  process.exit(1);
}

console.log('all ' + CASES.length + ' checks behaved as expected');
