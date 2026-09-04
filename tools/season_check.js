/*
 * Plays whole seasons through the real rules in crops.js and checks the outcomes.
 *
 * Balance numbers are logic, and logic that only runs on a phone is logic nobody reads. This kind
 * of bug produces no error and no wrong pixel, it just quietly teaches the player the opposite of
 * the lesson. Three that really happened:
 *
 *   - Water capped at 100 with a drain of 20 settled at exactly 80 forever, so the danger line at
 *     85 could never be crossed and over-watering was impossible.
 *   - Feeding only ever appeared as a penalty, so the best strategy was to ignore the bag.
 *   - `plant.bad` was never set true, so the crowding rule was unreachable dead code.
 *
 * It imports the real functions from crops.js rather than reimplementing them, because a test
 * that reimplements the thing it is testing tests nothing.
 *
 * Run from the app folder:  node tools/season_check.js
 */
'use strict';

var path = require('path');
var C = require(path.join(__dirname, '..', 'js', 'crops.js'));

var S = C.SEASON;
var problems = 0;

var WATER = 'can';
var FEED = 'bag';
var REST = null;

// Play one season. `actions` is one entry per week: 'can', 'bag', or null for doing nothing.
// Every plant is assumed to be reached by the tool, because this tests the rule, not the sweep.
function play(actions, label, expectHarvest) {
  var p = C.freshSeasonStats({});
  var lines = [];
  var endedOn = actions.length;
  var i, action, tool, trouble, weeksLeft;

  for (i = 0; i < actions.length; i++) {
    action = actions[i];
    p.treated = null;

    if (action) {
      tool = C.applyTool(p, action);
      if (!tool) { throw new Error('unknown tool: ' + action); }
    }

    trouble = C.tickPlant(p);
    weeksLeft = actions.length - (i + 1);

    lines.push('        wk' + (i + 1) + '  ' + (action ? C.toolById(action).label : 'rest')
      .toLowerCase().padEnd(11) +
      'water ' + p.water + '   food ' + p.food + '   life ' + p.life +
      '   grown ' + p.growth + (trouble.length ? '   ' + trouble.join(', ') : ''));

    // The season stops as soon as a harvest is out of reach. This is what makes three of the same
    // action in a row fatal, without any rule that mentions repeats.
    if (!C.stillPossible(p, weeksLeft)) { endedOn = i + 1; break; }
  }

  var harvested = C.isHarvestable(p);
  var ok = harvested === expectHarvest;

  if (!ok) { problems++; }

  console.log((ok ? 'ok    ' : 'FAIL  ') + label);
  console.log('        ' + (harvested
    ? 'harvest, grown ' + p.growth + ' of ' + S.weeks
    : 'crop failed on week ' + endedOn + ', grown ' + p.growth + ' of ' + S.weeks));
  lines.forEach(function (l) { console.log(l); });
  console.log('');
}

/* ---------------------------------------------------------------- structural checks */

function assert(ok, label, detail) {
  if (!ok) { problems++; }
  console.log((ok ? 'ok    ' : 'FAIL  ') + label + (detail ? '\n        ' + detail : ''));
}

console.log('Season rules, water and food 0 to ' + S.max + ', danger at ' + S.tooMuchAt + '\n');

// Headroom first, because it is the one that failed silently. If the ceiling sits at or below the
// danger mark, topping a supply up converges below the line and the danger can never be reached.
assert(S.max > S.tooMuchAt,
  'the danger mark is reachable',
  'max ' + S.max + ' sits above tooMuchAt ' + S.tooMuchAt + ', so a supply can actually get there');

C.TOOLS.forEach(function (t) {
  assert(t.amount > S.drain,
    t.label.toLowerCase() + ' outpaces the weekly drain',
    'adds ' + t.amount + ' against a drain of ' + S.drain +
    ', so using it every week accumulates rather than holding steady');
});

assert(S.growNeeded < S.weeks,
  'one wasted week is survivable',
  'needs ' + S.growNeeded + ' growing weeks out of ' + S.weeks);

console.log('');

/* ---------------------------------------------------------------- whole seasons */

play([WATER, FEED, WATER, FEED, WATER], 'water and feed, turn about, brings in a harvest', true);
play([FEED, WATER, FEED, WATER, FEED], 'starting with food works just as well', true);
play([WATER, WATER, FEED, FEED, WATER], 'one doubled-up week is survivable', true);

play([WATER, WATER, WATER, FEED, FEED], 'watering three weeks running loses the season', false);
play([FEED, FEED, FEED, WATER, WATER], 'feeding three weeks running loses the season', false);
play([REST, REST, REST, WATER, FEED], 'doing nothing three weeks running loses the season', false);

// The one that matters most. This scenario used to bring in a full harvest, because nothing in
// the rules rewarded feeding, which made the fertiliser bag decorative.
play([WATER, REST, WATER, REST, WATER], 'water alone never grows a crop, however well watered',
  false);

console.log('');

if (problems) {
  console.log(problems + ' check' + (problems === 1 ? '' : 's') + ' failed');
  process.exit(1);
}

console.log('all checks passed');
