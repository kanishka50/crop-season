/*
 * Static checks on the app's HTML, for faults that have each cost a day.
 *
 * They all share a shape: the browser accepts the file, nothing throws, and the damage shows up
 * only as something quietly missing from the scene on a phone with no devtools attached.
 *
 *   1. DUPLICATE IDS. Asset items and ordinary entities share one id namespace, and
 *      getElementById returns the first match in document order. Eight fence sections were once
 *      built into <a-assets>, where nothing renders.
 *   2. ATTRIBUTES LEAKING INTO TEXT. An HTML comment between the attributes of a tag is not a
 *      comment. That is how ar-hit-test and vr-mode-ui vanished off <a-scene>, which removed the
 *      entire markerless mode with no error anywhere.
 *   3. BROKEN LOCAL REFERENCES. A missing model, script or font is a 404 the phone never shows.
 *   4. REMOTE FETCHES on the markerless page, which would break the offline claim.
 *   5. ANIMATION PROPERTIES written without the object3D prefix.
 *
 * Run from the app folder:
 *   node tools/html_check.js                 checks the three app pages
 *   node tools/html_check.js <file.html>...   checks the files given
 *
 * The second form exists so the checks can be pointed at a deliberately broken fixture. A check
 * that has never been seen to fail is not evidence of anything. See tools/html_check_test.js.
 *
 * No dependencies. A deliberately small scanner, not a spec-compliant HTML parser.
 */
'use strict';

var fs = require('fs');
var path = require('path');

var APP = path.join(__dirname, '..');

// Local references resolve against the page's own folder, so a fixture kept elsewhere is checked
// against its own neighbours rather than against the real app.
var base = APP;

var FILES = process.argv.length > 2
  ? process.argv.slice(2)
  : ['index.html', 'marker.html', 'markerless.html'];

var problems = 0;

function fail(file, message) {
  problems++;
  console.log('  FAIL  ' + file + ': ' + message);
}

function lineOf(html, index) {
  return html.slice(0, index).split('\n').length;
}

/*
 * One linear pass that separates tags from text the way a browser does.
 *
 * This started as a regex that stripped comments first, and that version passed its own tests
 * while failing to catch the comment-in-a-tag bug at all: it removed the comment wherever it
 * appeared, including between attributes, so the one fault the file existed for was erased before
 * any check ran.
 *
 * A comment is only a comment when it opens in the data state, outside a tag. Inside a tag the
 * opener is just characters, and the first unquoted `>` closes the tag whatever it was meant to
 * close. Tracking those two states is the whole difference.
 */
function scan(html) {
  var tags = [];
  var text = html.split('');       // data-state copy, tags and comments blanked out
  var i = 0;

  function blank(from, to) {
    for (var k = from; k < to && k < text.length; k++) {
      if (text[k] !== '\n') { text[k] = ' '; }
    }
  }

  while (i < html.length) {
    if (html.charAt(i) !== '<') { i++; continue; }

    // A real comment, because we are in the data state here.
    if (html.substr(i, 4) === '<!--') {
      var end = html.indexOf('-->', i + 4);
      end = end === -1 ? html.length : end + 3;
      blank(i, end);
      i = end;
      continue;
    }

    if (!/[a-zA-Z\/!?]/.test(html.charAt(i + 1))) { i++; continue; }

    // Tag state. Quotes are the only thing that stops `>` from closing the tag.
    var j = i + 1;
    var quote = '';

    while (j < html.length) {
      var ch = html.charAt(j);
      if (quote) {
        if (ch === quote) { quote = ''; }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j++;
    }

    var raw = html.slice(i, j + 1);
    var name = /^<\/?([a-zA-Z][-\w]*)/.exec(raw);
    if (name) {
      tags.push({ name: name[1], attrs: raw.slice(name[0].length, -1), index: i });
    }

    blank(i, j + 1);
    i = j + 1;
  }

  return { tags: tags, text: text.join('') };
}

/* ---------------------------------------------------------------- 1. duplicate ids */

function checkIds(file, html, doc) {
  var seen = {};

  doc.tags.forEach(function (tag) {
    var idMatch = /\bid\s*=\s*"([^"]*)"/.exec(tag.attrs);
    if (!idMatch) { return; }

    var id = idMatch[1];
    var at = tag.name + ' on line ' + lineOf(html, tag.index);

    if (seen[id]) {
      fail(file, 'duplicate id "' + id + '": ' + seen[id] + ' and ' + at +
        '. Asset ids and entity ids share one namespace');
    } else {
      seen[id] = at;
    }
  });
}

/* ---------------------------------------------------------------- 2. malformed tags */

function checkTags(file, html, doc) {
  doc.tags.forEach(function (tag) {
    var line = lineOf(html, tag.index);

    // A comment opener inside a tag. Quoted values are excluded, so a legitimate
    // `content="a -- b"` does not trip it.
    var bare = tag.attrs.replace(/"[^"]*"|'[^']*'/g, '');

    if (bare.indexOf('<!--') !== -1 || bare.indexOf('--') !== -1) {
      fail(file, '<' + tag.name + '> on line ' + line +
        ' has comment syntax between its attributes. Move the comment above the tag');
    } else if (bare.indexOf('<') !== -1) {
      // A stray `<` also means the tag closed earlier than intended, just less obviously.
      fail(file, '<' + tag.name + '> on line ' + line + ' contains a "<" in its attribute list');
    }
  });

  // Attribute-looking text loose in the document. If a tag closed early, its remaining attributes
  // end up as text content, which is exactly what the a-scene failure produced. This is the check
  // that catches that bug from the file alone, with no phone and no session.
  doc.text.split('\n').forEach(function (raw, i) {
    var text = raw.trim();
    if (/^[a-zA-Z][-\w]*\s*=\s*["']/.test(text)) {
      fail(file, 'line ' + (i + 1) + ' of the text content looks like a stranded attribute: ' +
        text.slice(0, 60));
    }
  });

  /*
   * An orphan comment terminator, meaning one found in the data state with no comment open.
   *
   * A comment ends at the FIRST closing marker, so writing that marker inside a comment ends it
   * early and dumps the remainder onto the page as visible text. That shipped: the comment above
   * <a-scene> explaining this very hazard quoted the marker, ended itself two lines in, and
   * printed twenty lines of prose above the scene on every load.
   *
   * scan() has already blanked every properly closed comment, so anything left here is orphaned.
   */
  var stray = doc.text.indexOf('--' + '>');
  if (stray !== -1) {
    fail(file, 'line ' + lineOf(html, stray) + ' has a comment terminator outside any comment. ' +
      'A comment above it ended early, and everything between there and here is on the page as ' +
      'visible text. Describe the marker in words instead of typing it inside a comment');
  }
}

/* ---------------------------------------------------------------- 3. local references */

function checkRefs(file, html, doc) {
  doc.tags.forEach(function (tag) {
    var m = /\b(?:src|href)\s*=\s*"([^"]+)"/.exec(tag.attrs);
    if (!m) { return; }

    var ref = m[1];

    // Only local files. Remote URLs, ids, data URIs and anchors are somebody else's problem.
    if (/^(https?:)?\/\//.test(ref) || ref.charAt(0) === '#' || ref.indexOf('data:') === 0) {
      return;
    }

    var target = path.join(base, ref.split('?')[0].split('#')[0]);
    if (!fs.existsSync(target)) {
      fail(file, 'line ' + lineOf(html, tag.index) + ' references "' + ref + '", which is missing');
    }
  });
}

/* ---------------------------------------------------------------- 4. offline check */

/*
 * Markerless mode is claimed to run with no internet. That is a claim about every fetch the page
 * makes, and it was untrue twice over: the A-Frame bundle itself, and the msdf font its `text`
 * component pulls from a CDN for any label in the scene.
 *
 * Marker mode is exempt. It loads A-Frame and MindAR from their CDNs by design.
 */
function checkOffline(file, html, doc) {
  if (path.basename(file) !== 'markerless.html') { return; }

  doc.tags.forEach(function (tag) {
    var m = /\b(?:src|href)\s*=\s*"((?:https?:)?\/\/[^"]+)"/.exec(tag.attrs);
    if (m) {
      fail(file, 'line ' + lineOf(html, tag.index) +
        ' loads from the network, so airplane mode will not work: ' + m[1]);
    }
  });

  if (html.indexOf('AFRAME_CDN_ROOT') === -1) {
    fail(file, 'does not set window.AFRAME_CDN_ROOT, so A-Frame will fetch fonts from ' +
      'cdn.aframe.io the moment any text is rendered');
  }

  ['vendor/aframe-cdn/fonts/Roboto-msdf.json',
   'vendor/aframe-cdn/fonts/Roboto-msdf.png'].forEach(function (f) {
    if (!fs.existsSync(path.join(base, f))) {
      fail(file, 'missing vendored font ' + f + ', needed by the tool labels offline');
    }
  });
}

/* ---------------------------------------------------------------- 5. script ids */

// Every id the page's script fetches must exist in the page. getElementById returns null for a
// name that is not there, and the failure lands later, on whichever line first touches the
// result: a scene that half-builds with nothing on screen to say why.
var SCRIPTS = { 'markerless.html': 'js/planner.js', 'marker.html': null };

function checkScriptIds(file, doc) {
  var script = SCRIPTS[path.basename(file)];
  if (!script) { return; }

  var full = path.join(base, script);
  if (!fs.existsSync(full)) { fail(file, 'its script ' + script + ' is missing'); return; }

  var defined = {};
  doc.tags.forEach(function (tag) {
    var m = /\bid\s*=\s*"([^"]+)"/.exec(tag.attrs);
    if (m) { defined[m[1]] = true; }
  });

  var js = fs.readFileSync(full, 'utf8');
  var re = /getElementById\(\s*'([^']+)'\s*\)/g;
  var seen = {};
  var m2;

  while ((m2 = re.exec(js))) {
    var id = m2[1];
    if (seen[id] || defined[id]) { continue; }
    seen[id] = true;
    fail(file, script + ' fetches #' + id + ', which this page does not define');
  }
}

/* ---------------------------------------------------------------- 6. animation properties */

/*
 * `property: position.y` is not what it looks like, and it has cost this project two visible bugs.
 *
 * A-Frame writes a property straight into the object path only when it starts with `object3D` or
 * `components`. Otherwise it goes through setAttribute(component, propertyName, value), and
 * position, rotation and scale are SINGLE-property vec3 components with no `y` in their schema.
 * So that call does not set y, it corrupts the whole vector and the entity lands on the origin.
 *
 * It produced two bugs that look nothing alike: the tools ending up stacked in the centre of the
 * field, and a replanted field containing one visible plant instead of sixteen. Neither threw.
 *
 * `material.opacity` is fine and is not flagged, because material is a multi-property component
 * and opacity really is in its schema.
 */
var VEC3_COMPONENTS = ['position', 'rotation', 'scale'];

/*
 * Blank out comments, keep string literals, keep line numbers.
 *
 * Needed because the first version of this check flagged the comment in planner.js that explains
 * the very bug it looks for. Comments in this project describe faults in detail, so any scanner
 * pointed at them has to tell prose from code.
 *
 * Not a JavaScript parser. It would misread a regex literal beginning with two slashes, and there
 * is no such regex in this project.
 */
function stripJsComments(js) {
  var out = js.split('');
  var i = 0;

  function blank(from, to) {
    for (var k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') { out[k] = ' '; }
    }
  }

  while (i < js.length) {
    var c = js.charAt(i);
    var next = js.charAt(i + 1);

    if (c === '"' || c === "'" || c === '`') {
      // Skip the whole literal, escapes included, so its contents survive intact.
      var q = c;
      i++;
      while (i < js.length) {
        if (js.charAt(i) === '\\') { i += 2; continue; }
        if (js.charAt(i) === q) { i++; break; }
        i++;
      }
      continue;
    }

    if (c === '/' && next === '/') {
      var eol = js.indexOf('\n', i);
      eol = eol === -1 ? js.length : eol;
      blank(i, eol);
      i = eol;
      continue;
    }

    if (c === '/' && next === '*') {
      var end = js.indexOf('*/', i + 2);
      end = end === -1 ? js.length : end + 2;
      blank(i, end);
      i = end;
      continue;
    }

    i++;
  }

  return out.join('');
}

function checkAnimationProperties(file) {
  var script = SCRIPTS[path.basename(file)];
  if (!script) { return; }

  var full = path.join(base, script);
  if (!fs.existsSync(full)) { return; }        // checkScriptIds already reported this

  var js = stripJsComments(fs.readFileSync(full, 'utf8'));
  var re = /property:\s*([a-zA-Z][\w.]*)/g;
  var m;

  while ((m = re.exec(js))) {
    var prop = m[1];
    var dot = prop.indexOf('.');
    if (dot === -1) { continue; }               // plain `scale` or `rotation` is fine

    var head = prop.slice(0, dot);
    if (VEC3_COMPONENTS.indexOf(head) === -1) { continue; }

    fail(file, script + ' line ' + lineOf(js, m.index) + ' animates "' + prop +
      '". Write "object3D.' + prop + '" instead, or A-Frame corrupts the whole vector and the ' +
      'entity jumps to the origin');
  }
}

/* ---------------------------------------------------------------- run */

console.log('HTML checks\n');

FILES.forEach(function (file) {
  var full = path.isAbsolute(file) || file.indexOf(path.sep) !== -1 || file.indexOf('/') !== -1
    ? path.resolve(file)
    : path.join(APP, file);
  base = path.dirname(full);
  if (!fs.existsSync(full)) { fail(file, 'not found'); return; }

  var html = fs.readFileSync(full, 'utf8');
  var doc = scan(html);
  var before = problems;

  checkIds(file, html, doc);
  checkTags(file, html, doc);
  checkRefs(file, html, doc);
  checkOffline(file, html, doc);
  checkScriptIds(file, doc);
  checkAnimationProperties(file);

  if (problems === before) { console.log('  ok    ' + file); }
});

console.log('');

if (problems) {
  console.log(problems + ' problem' + (problems === 1 ? '' : 's') + ' found');
  process.exit(1);
}

console.log('all checks passed');
