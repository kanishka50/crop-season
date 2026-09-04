/*
 * Crop data, bed layout and the season rules. Shared by both modes, so marker mode and the plot
 * planner can never disagree about spacing. Sizes are stated in real metres; planner.js measures
 * each model on load and scales it to match.
 */
var CROPS = [
  {
    id: 'crop-a',
    name: 'Paddy',

    // Required distance between plant centres, in centimetres.
    spacingCm: 25,

    // The markerless field is sixteen of these.
    model: './models/crop-a.glb'
  },
  {
    id: 'crop-b',
    name: 'Pineapple',

    spacingCm: 45,

    // How big the model is drawn on its marker card. A card is one unit wide however large it is
    // printed, so this is unrelated to real world size. Only marker.html reads it.
    markerScale: 0.13,

    model: './models/crop-b.glb'
  }
];

// Side length of the square bed, in metres. Every other measurement is worked out from it.
var PLOT_SIZE_M = 1.2;

// Height of the raised bed, in metres. Tall enough to read as an object rather than a sticker.
var BED_HEIGHT_M = 0.4;

// The bed arrives already planted in a correct grid, at the crop's own spacing.
var FIELD = {
  rows: 4,
  cols: 4,

  // A few centimetres of wobble so the grid does not read as wallpaper. Seeded, so it repeats.
  jitter: 0.12,
  seed: 20260904
};

// Derived geometry. Worked out rather than typed, so changing the bed size cannot leave a stale
// number behind.

// How far the planted grid reaches from the bed centre, before jitter.
function gridHalfSpanM() {
  return ((FIELD.cols - 1) * (CROPS[0].spacingCm / 100)) / 2;
}

// Where the tools rest: the middle of the clear margin between the outer row and the fence.
function toolEdgeM() {
  return (gridHalfSpanM() + PLOT_SIZE_M / 2) / 2;
}

// How far apart the two tools sit along their shared edge, as a fraction of the bed.
var TOOL_GAP_FRACTION = 0.375;

function toolSpreadM() {
  return PLOT_SIZE_M * TOOL_GAP_FRACTION / 2;
}

/*
 * Which edge the tools rest on, as a direction from the bed centre.
 *   { x: -1, z: 0 } left    { x: 1, z: 0 } right    { x: 0, z: 1 } near    { x: 0, z: -1 } far
 */
var TOOL_EDGE = { x: -1, z: 0 };

// A mature plant is exactly as wide as its spacing, so correctly spaced plants just touch.
function matureWidthM(crop) { return crop.spacingCm / 100; }

// How big a seedling is compared with its full size.
var SEEDLING_FRACTION = 0.20;

function seedlingWidthM(crop) { return matureWidthM(crop) * SEEDLING_FRACTION; }

/*
 * The two tools. Drag one over the field and it treats the plants it passes over.
 *
 * radiusM is the important number. It is well under half the bed, so no single position covers
 * the field and the user has to physically move around it. That is the reason this is AR.
 */
var TOOLS = [
  {
    id: 'can',
    label: 'Water',
    model: './models/can.glb',

    // Asset ids are prefixed because asset ids and entity ids share one namespace.
    asset: '#mCan',

    stat: 'water',

    // How much one pass adds, on the 0 to 6 scale.
    amount: 2,

    // How far the spray reaches, in metres.
    radiusM: 0.3,

    // Real world height in metres. Kept under a life sized can so it fits its 22.5 cm margin.
    sizeM: 0.18,

    // x and z are filled in from TOOL_EDGE below. The tools rest on the soil, not on the floor
    // beside the bed, because the floor is rarely in shot on a phone.
    home: { x: 0, y: 0.4, z: 0 },
    side: -1,

    // Roughly square in plan, so it does not care which way its edge runs.
    lieAlongEdge: false,

    tint: '#3fa9f5',        // droplets and the coverage ring
    sound: 'sPlace'
  },
  {
    id: 'bag',
    label: 'Fertilise',
    model: './models/bag.glb',
    asset: '#mBag',

    stat: 'food',

    amount: 2,

    radiusM: 0.24,          // a scoop reaches less far than a spray

    sizeM: 0.13,

    home: { x: 0, y: 0.4, z: 0 },
    side: 1,

    // Longer than it is wide, so it must lie along its edge or it points out through the fence.
    lieAlongEdge: true,

    tint: '#c9a227',
    sound: 'sTick'
  }
];

// Place and turn each tool from TOOL_EDGE, so moving the tools to another edge cannot strand
// them outside the fence. `out` is towards the fence, `along` runs sideways down it.
TOOLS.forEach(function (t) {
  var out = toolEdgeM();
  var along = t.side * toolSpreadM();

  t.home.x = TOOL_EDGE.x * out + -TOOL_EDGE.z * along;
  t.home.z = TOOL_EDGE.z * out + TOOL_EDGE.x * along;
  t.home.y = BED_HEIGHT_M;

  t.yaw = (t.lieAlongEdge && TOOL_EDGE.z !== 0) ? 90 : 0;
});

// Fence, sized from its own bounding box. Two sections a side, so it is not stretched.
var FENCE = {
  model: './models/fence.glb',
  asset: '#mFence',
  sourceWidth: 5.8901,
  sectionsPerSide: 2,

  // Height is stated rather than scaled from the bed width, so the fence does not change every
  // time the bed does.
  heightM: 0.149,
  sourceHeight: 1.0971,

  // Rail thickness in model units, used to check a tool is beside the fence and not through it.
  sourceDepth: 0.1655
};

// How long the growth animation runs, in milliseconds.
var GROW_MS = 1500;

/*
 * The season. Five weeks, one action a week.
 *
 * Water keeps the plant alive, food makes it grow. Each plant carries water and food on a 0 to 6
 * scale. Both start at 2, drop by 1 a week, and gain 2 from their tool. The two differ only in
 * what running out means:
 *
 *   water 0        thirsty     loses a life
 *   water 5 or 6   drowned     loses a life
 *   food  0        no food     cannot grow, but loses no life
 *   food  5 or 6   burnt       loses a life
 *
 * A week with no trouble gains a life and grows the plant one step. So a plant given water and
 * never fed survives the season and finishes as a seedling.
 *
 * The scale needs room above the danger mark or the plant can never reach it. Run
 * season_check.js after changing any of these numbers.
 */
var SEASON = {
  weeks: 5,

  // Milliseconds the week's result animation is given before the next week opens.
  tickMs: 1400,

  max: 6,
  start: 2,
  drain: 1,

  // 0 is empty, tooMuchAt and above is too much. Everything between is the happy range.
  emptyAt: 0,
  tooMuchAt: 5,

  // Lives. A clean week gains one, each problem costs one, 0 is dead.
  life: { start: 3, max: 5 },

  // Growing weeks a plant needs to be worth harvesting. 4 of 5 makes one wasted week survivable.
  growNeeded: 4,

  // Fraction of the field that must be harvestable for the season to count as a win.
  passFraction: 0.6,

  // Colour by growth, so the plant changes every week it grows and looks ripe before the score
  // screen says it is.
  ripeness: [
    { at: 0.0, color: '#a9d977' },   // just transplanted, light green
    { at: 0.4, color: '#4f9d4f' },   // established, deep green
    { at: 0.7, color: '#c9c94a' },   // starting to turn
    { at: 1.0, color: '#e3a72c' }    // ripe, gold
  ],

  // A plant losing lives is pulled towards this brown on top of its ripeness colour.
  sickColour: '#6b4a2f'
};

// Ripe plants are picked by sweeping a hand over them.
var HARVEST = {
  // Half a spacing, so the hand is exactly one mature plant wide and takes one plant at a time.
  // Anything wider can catch two plants at once. Derived so a spacing change cannot break it.
  reachM: (CROPS[0].spacingCm / 100) / 2,

  // Milliseconds for one plant's picked animation: lift, shrink and fade.
  pickMs: 420,

  // Colour of the reach circle and the grain that flies up.
  tint: '#f2c14e'
};

/*
 * The season rules live here, next to the numbers they enforce, and use no A-Frame or DOM. A
 * plant here is just an object carrying water, food, life and growth, so season_check.js can run
 * whole seasons through these exact functions without a browser.
 */
function clampSupply(v) { return Math.max(0, Math.min(SEASON.max, v)); }
function clampLife(v) { return Math.max(0, Math.min(SEASON.life.max, v)); }

// Look a tool up by id. `null` and 'rest' both mean the user did nothing this week.
function toolById(id) {
  return TOOLS.filter(function (t) { return t.id === id; })[0] || null;
}

// Treat one plant with one tool. The caller does the distance test. `treated` stops a slow sweep
// dosing the same plant more than once a week.
function applyTool(plant, toolId) {
  var tool = toolById(toolId);
  if (!tool) { return null; }
  if (plant.treated === toolId) { return null; }
  if (plant.life <= 0) { return null; }

  plant[tool.stat] = clampSupply(plant[tool.stat] + tool.amount);
  plant.treated = toolId;
  return tool;
}

// Resolve one week for one plant. Returns what went wrong, empty for a clean week. Drain runs
// first, so what the user just gave is measured against what is left. Costs stack.
function tickPlant(plant) {
  var trouble = [];

  if (plant.life <= 0) { return trouble; }

  plant.water = clampSupply(plant.water - SEASON.drain);
  plant.food = clampSupply(plant.food - SEASON.drain);

  if (plant.water <= SEASON.emptyAt) { plant.life--; trouble.push('thirsty'); }
  if (plant.water >= SEASON.tooMuchAt) { plant.life--; trouble.push('drowned'); }
  if (plant.food >= SEASON.tooMuchAt) { plant.life--; trouble.push('burnt'); }

  // No food blocks growth but costs no life, so starving stalls a plant rather than killing it.
  if (plant.food <= SEASON.emptyAt) { trouble.push('no food'); }

  if (trouble.length === 0) {
    plant.life = clampLife(plant.life + 1);
    plant.growth++;
  }

  plant.life = clampLife(plant.life);
  return trouble;
}

// Could this plant still be worth harvesting? Assumes every remaining week is perfect, so it
// only says no when nothing could rescue the plant. This is what ends a lost season early.
function stillPossible(plant, weeksLeft) {
  return plant.life > 0 && (plant.growth + weeksLeft) >= SEASON.growNeeded;
}

// Is this plant worth harvesting at the end of the season?
function isHarvestable(plant) {
  return plant.life > 0 && plant.growth >= SEASON.growNeeded;
}

// A fresh plant's season numbers. Used when the field is placed and when a season restarts.
function freshSeasonStats(plant) {
  plant.water = SEASON.start;
  plant.food = SEASON.start;
  plant.life = SEASON.life.start;
  plant.growth = 0;
  plant.note = '';
  plant.treated = null;
  return plant;
}

// Exported for the checkers in tools/, which run this file under Node. Only what they actually
// read is listed. toolEdgeM, toolSpreadM, TOOL_EDGE, clampSupply and clampLife are used inside
// this file and nowhere else, so they stay private.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CROPS: CROPS,
    PLOT_SIZE_M: PLOT_SIZE_M,
    BED_HEIGHT_M: BED_HEIGHT_M,
    GROW_MS: GROW_MS,
    SEASON: SEASON,
    FIELD: FIELD,
    TOOLS: TOOLS,
    FENCE: FENCE,
    HARVEST: HARVEST,
    gridHalfSpanM: gridHalfSpanM,
    matureWidthM: matureWidthM,
    seedlingWidthM: seedlingWidthM,
    toolById: toolById,
    stillPossible: stillPossible,
    isHarvestable: isHarvestable,
    applyTool: applyTool,
    tickPlant: tickPlant,
    freshSeasonStats: freshSeasonStats
  };
}
