/*
 * Markerless mode: place a planting bed on a real floor, tend it for five weeks, harvest it.
 *
 *   scanning   move the phone, ar-hit-test looks for a surface
 *   ready      reticle solid, tap to drop the field
 *   season     five weeks. Drag the can and the bag over the field. Only plants under the tool
 *              are treated, which is the collision test
 *   result     harvest, or crop failure with the reason
 *
 * The tools reach 24 to 30 cm and the field is 1.2 m, so no single position covers it and the
 * user has to physically move around the bed. That reach is the reason this is AR rather than a
 * web page, and it is why the tool radius in crops.js matters more than any other number here.
 *
 * No network calls anywhere, so the app runs in airplane mode once loaded.
 */
(function () {
  'use strict';

  var sceneEl = document.getElementById('scene');
  var plotEl = document.getElementById('plot');
  var plantsEl = document.getElementById('plants');
  var groundEl = document.getElementById('plotGround');
  var bedEl = document.getElementById('bed');
  var fenceEl = document.getElementById('fence');
  var toolsEl = document.getElementById('tools');

  var statusEl = document.getElementById('status');
  var enterEl = document.getElementById('enter');
  var diagnoseEl = document.getElementById('diagnose');
  var debugEl = document.getElementById('debug');
  var hudEl = document.getElementById('hud');

  var replaceEl = document.getElementById('replace');
  var stagesEl = document.getElementById('stages');
  var seasonEl = document.getElementById('season');
  var weekEl = document.getElementById('week');
  var coverEl = document.getElementById('cover');

  var backEl = document.getElementById('back');
  var scoreEl = document.getElementById('score');
  var dotsWaterEl = document.getElementById('dotsWater');
  var dotsFoodEl = document.getElementById('dotsFood');
  var dotsLifeEl = document.getElementById('dotsLife');
  var dotsGrownEl = document.getElementById('dotsGrown');
  var noteWaterEl = document.getElementById('noteWater');
  var noteFoodEl = document.getElementById('noteFood');
  var noteLifeEl = document.getElementById('noteLife');
  var noteGrownEl = document.getElementById('noteGrown');

  var handEl = document.getElementById('hand');
  var harvestEl = document.getElementById('harvest');
  var briefEl = document.getElementById('brief');
  var pickedEl = document.getElementById('picked');
  var finishEl = document.getElementById('finish');
  var starsEl = document.getElementById('stars');
  var rowPickedEl = document.getElementById('rowPicked');
  var rowFullEl = document.getElementById('rowFull');
  var rowWeeksEl = document.getElementById('rowWeeks');
  var rowLivesEl = document.getElementById('rowLives');
  var nextEl = document.getElementById('next');
  var resultEl = document.getElementById('result');
  var resultTitleEl = document.getElementById('resultTitle');
  var resultDetailEl = document.getElementById('resultDetail');

  var state = 'idle';
  var plants = [];            // { el, ring, model, x, z, water, food, life, growth, treated, ... }
  var tools = [];             // { def, el, ring, model }
  var dragging = null;        // the tool currently in the user's hand
  var lastSessionError = 'none';

  var week = 0;               // 0 before the season starts, then 1 to SEASON.weeks
  var usedThisWeek = null;    // tool id, because one tool a week is the whole tension
  var resolving = false;

  var picked = 0;             // plants gathered in the harvest stage
  var toPick = 0;             // how many were ripe when the harvest opened
  var harvesting = false;     // the finger is down and sweeping the field

  var raycaster = new THREE.Raycaster();
  var pointer = new THREE.Vector2();
  var tmpVec = new THREE.Vector3();

  var HALF = PLOT_SIZE_M / 2;

  // ---------------------------------------------------------------- status and feedback

  function say(text, tone) {
    statusEl.textContent = text;
    statusEl.dataset.state = tone || 'idle';
  }

  function buzz(pattern) {
    if (navigator.vibrate) { navigator.vibrate(pattern); }
  }

  // Interface sounds. Plant sounds are positional and live on the plant entity itself, so they
  // arrive from the direction of the plant. Week 2, spatialised audio.
  function cue(id) {
    var a = document.getElementById(id);
    if (!a) { return; }
    try {
      a.currentTime = 0;
      a.play();
    } catch (e) { /* autoplay policy, not worth interrupting the session over */ }
  }

  function playOn(el, name) {
    var c = el.components['sound__' + name];
    if (c) { c.playSound(); }
  }

  // ---------------------------------------------------------------- state machine

  function setState(next) {
    state = next;

    seasonEl.hidden = (state !== 'season');
    harvestEl.hidden = (state !== 'harvest');
    resultEl.hidden = (state !== 'result');
    enterEl.hidden = (state !== 'idle');
    briefEl.hidden = (state !== 'idle');
    stagesEl.hidden = (state === 'idle' || state === 'scanning' || state === 'ready');

    // The hand circle only exists while there is something to pick.
    handEl.setAttribute('visible', false);

    // Back and Move field take turns, because three buttons in one row is too many on a phone and
    // the two are never useful at the same moment. The phone's own AR exit still works either way.
    backEl.hidden = (state === 'season' || state === 'placing');

    // Harvest and the score both sit under the bar's third step, which is labelled Harvest.
    markStage(state === 'season' ? 'season'
      : (state === 'harvest' || state === 'result') ? 'result'
      : 'place');

    if (state === 'scanning') {
      // ARCore finds a floor from parallax, so moving sideways helps and turning on the spot does
      // not. The instruction names the action that actually works.
      say('Point at the floor a step ahead, and move the phone slowly side to side');
    } else if (state === 'ready') {
      // The marker is exactly the field's footprint, so it can be described as such honestly.
      say('Floor found. The field fills the marker. Tap to drop it', 'found');
    } else if (state === 'placing') {
      say('Tap to put the field down again');
    } else if (state === 'harvest') {
      say('The gold plants are ready. Sweep your hand across them', 'found');
    }
  }

  // Mark stages done, current or still to come, rather than only highlighting the current one.
  function markStage(current) {
    var order = ['place', 'season', 'result'];
    var at = order.indexOf(current);

    Array.prototype.forEach.call(stagesEl.children, function (li, i) {
      li.dataset.mark = i < at ? 'done' : (i === at ? 'now' : 'todo');
    });
  }

  // ---------------------------------------------------------------- building the scene

  // Seeded, so the field's scatter is identical every run and two screenshots can be compared.
  function seededRandom(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /*
   * Make a downloaded model behave.
   *
   * The rest of this file assumes a model hangs from a pin at its own bottom centre and that its
   * scale means something in metres. Downloaded models do not agree: can.glb sits 1.1 m from its
   * own origin, and bag.glb carries a node that already scales itself by 100. Both were invisible
   * on device for two days with no error anywhere.
   *
   * So measure the mesh on load, scale it to the size crops.js asked for, centre it on x and z,
   * and sit its base on y = 0. After this the assumption above is true for every model, including
   * the next one downloaded.
   *
   * `fit` picks which measurement the size refers to: tools by height, plants by their widest
   * horizontal extent, because that is what has to fit inside the spacing circle.
   */
  function normaliseModel(el, sizeM, fit) {
    function apply() {
      var mesh = el.getObject3D('mesh');
      if (!mesh) { return; }

      // Neutralise this wrapper before measuring. A world-space box would fold in wherever the
      // anchor put the bed, so the same model would measure differently depending on where the
      // user stood.
      mesh.matrixAutoUpdate = true;
      mesh.scale.set(1, 1, 1);
      mesh.position.set(0, 0, 0);
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);

      var toLocal = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
      var rel = new THREE.Matrix4();
      var corner = new THREE.Vector3();
      var box = new THREE.Box3();

      mesh.traverse(function (n) {
        if (!n.isMesh || !n.geometry) { return; }
        if (!n.geometry.boundingBox) { n.geometry.computeBoundingBox(); }

        rel.multiplyMatrices(toLocal, n.matrixWorld);
        var b = n.geometry.boundingBox;
        var i;

        // All eight corners, transformed. A rotated child would otherwise report the box of its
        // own axes rather than the space it actually occupies.
        for (i = 0; i < 8; i++) {
          corner.set(i & 1 ? b.max.x : b.min.x,
                     i & 2 ? b.max.y : b.min.y,
                     i & 4 ? b.max.z : b.min.z).applyMatrix4(rel);
          box.expandByPoint(corner);
        }
      });

      if (box.isEmpty()) { return; }

      var size = box.getSize(new THREE.Vector3());
      var measured = fit === 'width' ? Math.max(size.x, size.z) : size.y;
      if (!(measured > 0)) { return; }

      var s = sizeM / measured;
      mesh.scale.setScalar(s);
      mesh.position.set(
        -((box.min.x + box.max.x) / 2) * s,
        -box.min.y * s,
        -((box.min.z + box.max.z) / 2) * s
      );
      mesh.updateMatrix();
    }

    // Already loaded when reused from cache, otherwise wait. Both happen in practice.
    if (el.getObject3D('mesh')) { apply(); } else { el.addEventListener('model-loaded', apply); }
  }

  // The bed. Soil surface at BED_HEIGHT_M, with the drag plane and the plants lifted to meet it.
  // Only y moves, so none of the drag maths changes.
  function buildBed() {
    // 3 mm, to keep the drag plane off the soil box's top face. Two coplanar surfaces make the
    // depth buffer flicker between them, which looks like a broken texture rather than like this.
    var LIFT = 0.003;

    // The drag plane is what the drag raycast hits, so it must be exactly the bed. A plane wider
    // than the bed is an invisible apron the user can pull a tool out onto.
    groundEl.setAttribute('width', PLOT_SIZE_M);
    groundEl.setAttribute('height', PLOT_SIZE_M);

    groundEl.object3D.position.y = BED_HEIGHT_M + LIFT;
    plantsEl.object3D.position.y = BED_HEIGHT_M + LIFT;

    var soil = document.createElement('a-box');
    soil.setAttribute('width', PLOT_SIZE_M);
    soil.setAttribute('depth', PLOT_SIZE_M);
    soil.setAttribute('height', BED_HEIGHT_M);
    soil.setAttribute('position', '0 ' + (BED_HEIGHT_M / 2) + ' 0');
    soil.setAttribute('material', 'color: #4a3524; roughness: 1; metalness: 0');
    soil.setAttribute('shadow', 'cast: true; receive: true');
    bedEl.appendChild(soil);
  }

  // Fence, two sections a side so the model is scaled uniformly rather than stretched.
  function buildFence() {
    var sectionW = PLOT_SIZE_M / FENCE.sectionsPerSide;

    // Width follows the bed, height does not, so changing the bed size cannot shrink the fence.
    var scaleW = sectionW / FENCE.sourceWidth;
    var scaleH = FENCE.heightM / FENCE.sourceHeight;
    var offsets = [];
    var i;

    for (i = 0; i < FENCE.sectionsPerSide; i++) {
      offsets.push(-HALF + sectionW * (i + 0.5));
    }

    [
      { fixed: -HALF, axis: 'z', rot: 0 },
      { fixed: HALF, axis: 'z', rot: 180 },
      { fixed: -HALF, axis: 'x', rot: 90 },
      { fixed: HALF, axis: 'x', rot: -90 }
    ].forEach(function (side) {
      offsets.forEach(function (o) {
        var sec = document.createElement('a-gltf-model');
        var x = side.axis === 'z' ? o : side.fixed;
        var z = side.axis === 'z' ? side.fixed : o;

        sec.setAttribute('src', FENCE.asset);
        sec.setAttribute('position', x + ' ' + BED_HEIGHT_M + ' ' + z);
        sec.setAttribute('rotation', '0 ' + side.rot + ' 0');
        sec.setAttribute('scale', scaleW + ' ' + scaleH + ' ' + scaleW);
        sec.setAttribute('shadow', 'cast: true; receive: false');
        fenceEl.appendChild(sec);
      });
    });
  }

  // The planted field, laid out on the crop's own spacing with a little seeded jitter so it reads
  // as planted rather than as wallpaper.
  function buildField() {
    var crop = CROPS[0];                       // paddy. One crop, decision D14
    var step = crop.spacingCm / 100;
    var rnd = seededRandom(FIELD.seed);
    var originX = -((FIELD.cols - 1) * step) / 2;
    var originZ = -((FIELD.rows - 1) * step) / 2;
    var r, c, jx, jz;

    for (r = 0; r < FIELD.rows; r++) {
      for (c = 0; c < FIELD.cols; c++) {
        jx = (rnd() - 0.5) * 2 * FIELD.jitter * step;
        jz = (rnd() - 0.5) * 2 * FIELD.jitter * step;
        addPlant(crop, originX + c * step + jx, originZ + r * step + jz);
      }
    }
  }

  function addPlant(crop, x, z) {
    var el = document.createElement('a-entity');
    el.setAttribute('position', { x: x, y: 0, z: z });

    // Coverage ring. It answers the one question the sweep mechanic creates: did I get this
    // plant? Without it the user only finds out a week later, which is too late to act on.
    var ring = document.createElement('a-circle');
    ring.classList.add('ring');
    ring.setAttribute('radius', 0.09);
    ring.setAttribute('rotation', '-90 0 0');
    ring.setAttribute('position', '0 0.006 0');
    ring.setAttribute('material',
      'color: #ffffff; opacity: 0.08; transparent: true; side: double; shader: flat');
    el.appendChild(ring);

    var model = document.createElement('a-gltf-model');
    model.classList.add('model');
    model.setAttribute('src', '#cropA');
    model.setAttribute('shadow', 'cast: true; receive: false');
    el.appendChild(model);

    // Normalise to one metre wide, so afterwards this entity's scale IS the plant's real width in
    // metres and applyVisuals can work in the same units as spacingCm.
    normaliseModel(model, 1, 'width');

    el.setAttribute('sound__warn', 'src: #sWarn; positional: true; volume: 0.9');
    el.setAttribute('sound__grow', 'src: #sGrow; positional: true; volume: 0.8');

    plantsEl.appendChild(el);

    var p = freshSeasonStats({
      el: el, ring: ring, model: model, crop: crop, x: x, z: z
    });
    plants.push(p);
    applyVisuals(p, false);

    // And again once the mesh exists. The first call has no glTF to tint yet, so it silently sets
    // the scale only and the field would otherwise stand in the model's own green all season.
    model.addEventListener('model-loaded', function () { applyVisuals(p, false); });
  }

  // The two tools. Each carries a ground ring the size of its own reach, so the user can see how
  // much of the field the can covers before committing to a sweep.
  function buildTools() {
    TOOLS.forEach(function (def) {
      var el = document.createElement('a-entity');
      el.setAttribute('position', def.home);

      var ring = document.createElement('a-ring');
      ring.setAttribute('radius-inner', def.radiusM - 0.02);
      ring.setAttribute('radius-outer', def.radiusM);
      ring.setAttribute('rotation', '-90 0 0');
      ring.setAttribute('position', '0 0.01 0');
      ring.setAttribute('material',
        'color: ' + def.tint + '; opacity: 0.5; transparent: true; side: double; shader: flat');
      ring.setAttribute('visible', false);
      el.appendChild(ring);

      var model = document.createElement('a-gltf-model');
      model.setAttribute('src', def.asset);
      model.setAttribute('shadow', 'cast: true; receive: false');

      // The resting turn goes on the model, not the entity, so the label stays upright and the
      // drag code can tip the tool without undoing a rotation first.
      model.setAttribute('rotation', '0 ' + def.yaw + ' 0');
      el.appendChild(model);

      normaliseModel(model, def.sizeM, 'height');

      // A name and a slow bob, because a watering can seen from two metres is a small brown shape
      // among other small brown shapes. Week 4: a virtual object gives the hand no feedback, so
      // every affordance has to be designed in.
      var label = document.createElement('a-entity');
      label.setAttribute('text',
        'value: ' + def.label + '; align: center; width: 0.9; color: #ffffff;' +
        ' shader: msdf; negate: false');
      // Just clear of the top of the tool, whatever size it was declared to be.
      label.setAttribute('position', '0 ' + (def.sizeM + 0.08).toFixed(3) + ' 0');
      label.setAttribute('rotation', '-90 0 0');
      el.appendChild(label);

      toolsEl.appendChild(el);

      // returnAt is 0 when the tool is at rest, or the time the user let go of it.
      tools.push({
        def: def, el: el, ring: ring, model: model, label: label,
        returnAt: 0, returnFrom: new THREE.Vector3()
      });
    });
  }

  // ---------------------------------------------------------------- where a tool sits

  /*
   * A tool that is not in the user's hand is at its home position. Every frame, no exceptions.
   *
   * This used to be two A-Frame animations set on release. Setting a component to a string it
   * already holds leaves dataChanged false, so update() never runs and the animation replayed
   * exactly once. The tools stayed wherever they were dropped, which after a few weeks of play is
   * a heap in the middle of the field. So the rest position is asserted rather than requested.
   */
  var RETURN_MS = 320;
  var BOB_M = 0.04;
  var BOB_MS = 1600;

  function restTools(time) {
    tools.forEach(function (t) {
      if (dragging === t) { return; }

      var home = t.def.home;
      var p = t.el.object3D.position;

      if (t.returnAt) {
        // Released on the last frame. Start the clock here, so this code never has to know which
        // clock onUp was reading.
        if (t.returnAt < 0) { t.returnAt = time || 0.0001; }

        var k = Math.min(1, (time - t.returnAt) / RETURN_MS);
        var e = 1 - Math.pow(1 - k, 3);        // easeOutCubic, the feel the animation had

        p.x = t.returnFrom.x + (home.x - t.returnFrom.x) * e;
        p.y = t.returnFrom.y + (home.y - t.returnFrom.y) * e;
        p.z = t.returnFrom.z + (home.z - t.returnFrom.z) * e;

        if (k < 1) { return; }
        t.returnAt = 0;
      }

      // The bob rises from home rather than swinging either side of it, so the tool never dips
      // below the soil. It is the only thing in the scene that moves on its own.
      p.x = home.x;
      p.z = home.z;
      p.y = home.y + (1 - Math.cos(time / BOB_MS * Math.PI * 2)) * 0.5 * BOB_M;
    });
  }

  // Driven from A-Frame's tick, which runs off the XR session's frame loop. window.requestAnimationFrame
  // is not the loop that draws an immersive session, which is also why the fps counter lives here.
  if (window.AFRAME && !AFRAME.components['tool-rest']) {
    AFRAME.registerComponent('tool-rest', {
      tick: function (time) {
        frames++;
        restTools(time);
      }
    });
  }

  // ---------------------------------------------------------------- season visuals

  // Walk a list of colour stops and blend between the two either side of `t`.
  function rampColour(stops, t) {
    var i, lo, hi, k;

    for (i = 0; i < stops.length - 1; i++) {
      lo = stops[i];
      hi = stops[i + 1];
      if (t <= hi.at) {
        k = (t - lo.at) / (hi.at - lo.at);
        return mixHex(lo.color, hi.color, Math.max(0, Math.min(1, k)));
      }
    }
    return stops[stops.length - 1].color;
  }

  /*
   * A plant's colour, from two things at once.
   *
   * Ripeness follows growth, so it moves every week the plant grows: light green, deep green,
   * yellow, gold. Sickness then drains that towards brown, counting only lives lost below the
   * starting number so a fresh field shows its true green.
   *
   * They read together because they move different parts of the colour, so a struggling young
   * plant and a healthy young plant still look different.
   */
  function plantColour(p) {
    var ripeness = SEASON.weeks ? (p.growth / SEASON.weeks) : 0;
    var base = rampColour(SEASON.ripeness, Math.max(0, Math.min(1, ripeness)));
    var sick = Math.max(0, (SEASON.life.start - p.life) / SEASON.life.start);

    return sick > 0 ? mixHex(base, SEASON.sickColour, Math.min(1, sick)) : base;
  }

  function mixHex(a, b, t) {
    function part(hex, i) { return parseInt(hex.substr(1 + i * 2, 2), 16); }
    var out = '#', i, v;
    for (i = 0; i < 3; i++) {
      v = Math.round(part(a, i) + (part(b, i) - part(a, i)) * t);
      out += ('0' + v.toString(16)).slice(-2);
    }
    return out;
  }

  /*
   * Push a plant's numbers onto what the user can see: its size and its colour.
   *
   * normaliseModel made every plant exactly one metre wide, so this entity's scale is the plant's
   * width in metres and a mature plant is spacingCm wide by construction. Width interpolates from
   * seedling to mature across the season, so a plant that lost weeks ends visibly shorter than
   * one beside it that did not, with no text required.
   */
  function applyVisuals(p, animate) {
    var full = matureWidthM(p.crop);
    var small = seedlingWidthM(p.crop);
    var s = small + (full - small) * (p.growth / SEASON.weeks);
    var colour = plantColour(p);

    if (animate) {
      // easeOutBack overshoots and settles, which punctuates the change. A plain ease-out of the
      // same size reads as the camera moving rather than the plant growing.
      p.model.setAttribute('animation__grow',
        'property: scale; to: ' + s + ' ' + s + ' ' + s +
        '; dur: ' + GROW_MS + '; easing: easeOutBack');
    } else {
      p.model.setAttribute('scale', s + ' ' + s + ' ' + s);
    }

    // Tint the loaded glTF rather than replacing its material. three.js multiplies the map by
    // `color`, so this yellows the existing texture instead of discarding it.
    var obj = p.model.getObject3D('mesh');
    if (obj) {
      obj.traverse(function (n) {
        if (n.isMesh && n.material && n.material.color) { n.material.color.set(colour); }
      });
    }
  }

  // Coverage rings: lit in the tool's colour once that plant has been treated this week.
  function paintCoverage() {
    plants.forEach(function (p) {
      var tool = p.treated ? toolById(p.treated) : null;
      p.ring.setAttribute('material', 'color', tool ? tool.tint : '#ffffff');
      p.ring.setAttribute('material', 'opacity', tool ? 0.55 : 0.08);
    });

    var done = plants.filter(function (p) { return p.treated; }).length;
    coverEl.textContent = usedThisWeek
      ? done + ' of ' + plants.length + ' covered'
      : 'Pick up the can or the bag at the field edge';

    paintScore();
  }

  // ---------------------------------------------------------------- the scoreboard

  /*
   * Four rows of dots: water, food, life and growth.
   *
   * Six dots is a state you read without parsing, and a supply climbing towards the danger mark
   * is visible a week before it bites. The dots are the field average, because plants diverge
   * when the user misses some with the sweep, and the note beside them counts the exceptions.
   *
   * `dangerFrom` marks where the red band starts, as a dot index, or -1 for a row with no danger.
   * Marking those dots is how the user learns what filling a row costs, before they fill it, and
   * it is why there is no rule anywhere about repeating a tool.
   */
  function dotsInto(el, filled, total, tone, dangerFrom) {
    var want = total;
    var i, dot;

    // Build once, then only flip the fill. Rebuilding every frame would fight the CSS transition
    // and churn the DOM inside an XR session for no reason.
    while (el.children.length > want) { el.removeChild(el.lastChild); }
    while (el.children.length < want) { el.appendChild(document.createElement('i')); }

    for (i = 0; i < want; i++) {
      dot = el.children[i];
      dot.dataset.on = i < filled ? '1' : '0';
      dot.dataset.danger = (dangerFrom >= 0 && i >= dangerFrom) ? '1' : '0';
    }

    el.parentNode.dataset.state = tone;
  }

  // How a supply reads: fine, one step from trouble, or in it. Both danger lines sit one step
  // outside the happy range, so every way of losing a season gives a full week of amber first.
  function supplyTone(value) {
    if (value <= SEASON.emptyAt || value >= SEASON.tooMuchAt) { return 'bad'; }
    if (value <= SEASON.emptyAt + 1 || value >= SEASON.tooMuchAt - 1) { return 'warn'; }
    return 'ok';
  }

  function fieldAverage(key) {
    if (!plants.length) { return 0; }
    var total = plants.reduce(function (sum, p) { return sum + p[key]; }, 0);
    return Math.round(total / plants.length);
  }

  function countWhere(test) {
    return plants.filter(test).length;
  }

  function paintScore() {
    if (!scoreEl || !plants.length) { return; }

    var n = plants.length;
    var dry = countWhere(function (p) { return p.life > 0 && p.water <= SEASON.emptyAt; });
    var wet = countWhere(function (p) { return p.life > 0 && p.water >= SEASON.tooMuchAt; });
    var hungry = countWhere(function (p) { return p.life > 0 && p.food <= SEASON.emptyAt; });
    var burnt = countWhere(function (p) { return p.life > 0 && p.food >= SEASON.tooMuchAt; });
    var alive = countWhere(function (p) { return p.life > 0; });
    var ready = countWhere(isHarvestable);

    var water = fieldAverage('water');
    var food = fieldAverage('food');
    var life = fieldAverage('life');

    // Water. Too wet and too dry are both fatal, so both are red.
    dotsInto(dotsWaterEl, water, SEASON.max,
      (wet || dry) ? 'bad' : supplyTone(water), SEASON.tooMuchAt);

    noteWaterEl.textContent = wet ? wet + ' too wet'
      : dry ? dry + ' too dry'
      : water >= SEASON.tooMuchAt - 1 ? 'nearly too wet'
      : water <= SEASON.emptyAt + 1 ? 'nearly dry'
      : 'ok';

    // Food. Running out is amber, not red, because it costs no life, it stops the plant growing.
    // That distinction is the whole point of the fertiliser bag, so the colour has to carry it.
    dotsInto(dotsFoodEl, food, SEASON.max,
      burnt ? 'bad' : hungry ? 'warn' : supplyTone(food), SEASON.tooMuchAt);

    noteFoodEl.textContent = burnt ? burnt + ' burnt'
      : hungry ? hungry + ' not growing'
      : food >= SEASON.tooMuchAt - 1 ? 'nearly burnt'
      : food <= SEASON.emptyAt + 1 ? 'nearly out'
      : 'ok';

    // Life has no upper danger, so no red band on its scale. Losing it is the danger.
    dotsInto(dotsLifeEl, life, SEASON.life.max,
      alive < n ? 'bad' : life <= 2 ? 'warn' : 'ok', -1);

    noteLifeEl.textContent = alive < n ? alive + ' of ' + n + ' alive' : 'all alive';

    // Growth is a count towards a target rather than a level, so its row is never red. Falling
    // behind is reported by the season ending.
    dotsInto(dotsGrownEl, fieldAverage('growth'), SEASON.weeks,
      ready >= Math.ceil(n * SEASON.passFraction) ? 'ok' : 'warn', -1);
    noteGrownEl.textContent = ready + ' of ' + n + ' ready';
  }

  // Droplets, built from spheres rather than a downloaded mesh. At 2 cm on a phone the shape of
  // one drop is invisible; the animation is what sells watering.
  function spatter(tool, fromY) {
    var i, n = 7;

    for (i = 0; i < n; i++) {
      makeDroplet(tool, fromY);
    }
  }

  function makeDroplet(tool, fromY) {
    var d = document.createElement('a-sphere');
    var a = Math.random() * Math.PI * 2;
    var r = Math.random() * tool.def.radiusM * 0.5;

    d.setAttribute('radius', 0.015);
    d.setAttribute('segments-width', 5);
    d.setAttribute('segments-height', 4);
    d.setAttribute('material',
      'color: ' + tool.def.tint + '; opacity: 0.85; transparent: true; shader: flat');
    d.setAttribute('position', {
      x: tool.el.object3D.position.x + Math.cos(a) * r,
      y: fromY,
      z: tool.el.object3D.position.z + Math.sin(a) * r
    });
    // The object3D prefix is required. Without it A-Frame writes through setAttribute on a
    // single-property vec3 component, which corrupts the whole vector and moves the entity to the
    // origin. Every droplet used to jump to the centre of the bed as it started falling.
    d.setAttribute('animation__fall',
      'property: object3D.position.y; to: ' + BED_HEIGHT_M + '; dur: 420; easing: easeInQuad');
    d.setAttribute('animation__fade',
      'property: material.opacity; to: 0; dur: 420; easing: linear');

    plotEl.appendChild(d);

    setTimeout(function () {
      if (d.parentNode) { d.parentNode.removeChild(d); }
    }, 480);
  }

  // ---------------------------------------------------------------- the season

  function startSeason() {
    week = 0;
    picked = 0;
    toPick = 0;
    harvesting = false;

    plants.forEach(function (p) {
      // Undo everything the harvest did, so Plant again gives a real fresh field rather than a
      // bed of invisible picked plants that were only scaled to nothing.
      ['animation__sway', 'animation__pick', 'animation__grow'].forEach(function (a) {
        p.model.removeAttribute(a);
      });
      p.el.removeAttribute('animation__up');
      p.ring.removeAttribute('animation__fade');

      p.model.setAttribute('rotation', '0 0 0');

      // The whole position from the plant's own stored coordinates, not just y, so a future
      // mistake of the object3D kind cannot survive a replant.
      p.el.object3D.position.set(p.x, 0, p.z);
      p.harvested = false;

      freshSeasonStats(p);
      applyVisuals(p, false);
    });

    setState('season');
    nextWeek();
  }

  function nextWeek() {
    week++;
    usedThisWeek = null;
    resolving = false;
    plants.forEach(function (p) { p.treated = null; });

    weekEl.textContent = 'Week ' + week + ' of ' + SEASON.weeks;
    nextEl.textContent = 'Skip this week';

    // Short, because the scoreboard says the rest.
    say('Water or feed, then end the week', 'found');
    paintCoverage();
  }

  /*
   * Treat every plant the tool is currently over. This is the collision test: distance from the
   * tool to each plant against the tool's reach. The `treated` flag inside applyTool stops a slow
   * sweep dosing the same plant twenty times.
   */
  function applyAt(tool) {
    var hit = 0;
    var tx = tool.el.object3D.position.x;
    var tz = tool.el.object3D.position.z;

    plants.forEach(function (p) {
      if (p.life <= 0) { return; }

      var dx = p.x - tx;
      var dz = p.z - tz;
      if (Math.sqrt(dx * dx + dz * dz) > tool.def.radiusM) { return; }

      if (applyTool(p, tool.def.id)) { hit++; }
    });

    if (hit) {
      spatter(tool, BED_HEIGHT_M + 0.22);
      cue(tool.def.sound);
      buzz(14);
      paintCoverage();
    }

    return hit;
  }

  /*
   * Put the field back on the reticle so it can be dropped somewhere else. Without this, a field
   * that lands inside the sofa strands the user: hit testing is off after the first placement, so
   * a tap plants nothing and there is no way back. Week 4 heuristic 3, a marked exit.
   *
   * The season is not restarted. Moving the field is a camera problem, not a farming decision.
   */
  function movePlot() {
    if (state !== 'season') { return; }

    setState('placing');
    plotEl.setAttribute('visible', false);
    sceneEl.setAttribute('ar-hit-test', 'enabled', true);
    say('Point at the floor about a step in front of you, then tap');
    cue('sTick');
  }

  function endWeek() {
    if (state !== 'season' || resolving) { return; }
    resolving = true;
    nextEl.disabled = true;
    tickWeek();
  }

  function tickWeek() {
    var lost = 0;

    plants.forEach(function (p) {
      var alive = p.life > 0;
      var trouble = tickPlant(p);          // the rule itself lives in crops.js

      p.note = trouble.length ? trouble[0] : '';
      if (alive && p.life <= 0) { lost++; }

      applyVisuals(p, true);
    });

    reportWeek(lost);
    paintScore();

    setTimeout(function () {
      nextEl.disabled = false;

      // The season ends as soon as a full harvest is out of reach, rather than playing out weeks
      // whose result is already decided. Three of the same action in a row always costs two
      // growing weeks, so that behaviour falls out of stillPossible() with no rule about repeats.
      if (week >= SEASON.weeks || !fieldCanStillPass()) { endSeason(); } else { nextWeek(); }
    }, SEASON.tickMs);
  }

  // Could enough of the field still be harvested with the weeks that are left?
  function fieldCanStillPass() {
    var left = SEASON.weeks - week;
    var possible = plants.filter(function (p) { return stillPossible(p, left); }).length;

    return possible >= Math.ceil(plants.length * SEASON.passFraction);
  }

  // One short line about the week just resolved. The detail is on the scoreboard and in the
  // colour of the plants, so this only names the most important thing that happened.
  function reportWeek(lost) {
    var sick = plants.filter(function (p) { return p.note; });

    if (lost > 0) {
      say(lost + (lost === 1 ? ' plant died' : ' plants died'), 'error');
      plants.forEach(function (p) { if (p.life <= 0) { playOn(p.el, 'warn'); } });
      buzz([40, 60, 40]);
    } else if (sick.length) {
      say(sick.length + ' in trouble: ' + sick[0].note, 'error');
      playOn(sick[0].el, 'warn');
      buzz([28, 60, 28]);
    } else {
      say('Every plant grew', 'found');
      if (plants[0]) { playOn(plants[0].el, 'grow'); }
      buzz(30);
    }
  }

  // Why the season ended, counted from the field, so a user who watered every week reads about
  // drowning. "Crop failed" on its own teaches nothing, and this is the last thing on screen.
  function failureReason() {
    var starved = plants.filter(function (p) { return p.food <= SEASON.emptyAt; }).length;
    var drowned = plants.filter(function (p) { return p.water >= SEASON.tooMuchAt; }).length;
    var dry = plants.filter(function (p) { return p.water <= SEASON.emptyAt; }).length;
    var burnt = plants.filter(function (p) { return p.food >= SEASON.tooMuchAt; }).length;
    var half = plants.length / 2;

    if (drowned > half) {
      return 'Too much water. Watering every week drowns the roots, and a drowned plant cannot grow.';
    }
    if (burnt > half) {
      return 'Too much fertiliser. Feeding every week burns the roots, and it left no week for water.';
    }
    if (dry > half) {
      return 'Not enough water. Water keeps a plant alive, and these ran dry.';
    }
    if (starved > half) {
      return 'Not enough food. Water keeps a plant alive, but only food makes it grow, so these ' +
        'stayed as seedlings.';
    }
    return 'Take it in turns. Water one week, feed the next, and never do the same thing three ' +
      'weeks running.';
  }

  // A crop worth picking goes to the harvest stage. A failed one goes straight to the score,
  // because there would be nothing under the hand to pick.
  function endSeason() {
    var ok = plants.filter(isHarvestable);
    var passed = ok.length >= Math.ceil(plants.length * SEASON.passFraction);

    if (passed) { startHarvest(ok.length); } else { showScore(false); }
  }

  // ---------------------------------------------------------------- the harvest

  /*
   * Ripe plants are already gold, because the ripeness ramp walked them there over five weeks.
   * They sway, and the user sweeps a hand across the field to pick them, which is the same
   * distance-against-radius test the watering can uses, at the climax instead of in the middle.
   */
  function startHarvest(readyCount) {
    picked = 0;
    toPick = readyCount;

    setState('harvest');
    cue('sOk');
    buzz([30, 40, 30]);

    plants.forEach(function (p) {
      p.ring.setAttribute('material', 'color', isHarvestable(p) ? HARVEST.tint : '#ffffff');
      p.ring.setAttribute('material', 'opacity', isHarvestable(p) ? 0.5 : 0.06);

      if (!isHarvestable(p)) { return; }

      // Only the ripe ones move. A field where everything sways says nothing about what is ready.
      p.model.setAttribute('animation__sway',
        'property: object3D.rotation.z; from: -4; to: 4; dur: 1200; dir: alternate; loop: true;' +
        ' easing: easeInOutSine');
    });

    paintPicked();
  }

  function paintPicked() {
    pickedEl.textContent = picked + ' of ' + toPick + ' picked';
  }

  // Pick every ripe plant under the hand. Same shape as applyAt: distance against a radius, per
  // plant. A plant is picked once.
  function pickAt(x, z) {
    var got = 0;

    plants.forEach(function (p) {
      if (p.harvested || !isHarvestable(p)) { return; }

      var dx = p.x - x;
      var dz = p.z - z;
      if (Math.sqrt(dx * dx + dz * dz) > HARVEST.reachM) { return; }

      p.harvested = true;
      got++;
      pickOne(p);
    });

    if (got) {
      picked += got;
      cue('sGrow');
      buzz(18);
      paintPicked();

      if (picked >= toPick) {
        // A short beat before the score, so the last plant is seen leaving rather than being
        // covered instantly by a card.
        setTimeout(function () { if (state === 'harvest') { showScore(true); } }, 620);
      }
    }

    return got;
  }

  // One plant leaving the field: it lifts, shrinks away, and a grain rises from where it stood.
  // Animated rather than removed outright, because a plant that vanishes reads as a bug.
  function pickOne(p) {
    var lift = BED_HEIGHT_M + 0.28;

    p.model.removeAttribute('animation__sway');
    p.model.setAttribute('animation__pick',
      'property: scale; to: 0.001 0.001 0.001; dur: ' + HARVEST.pickMs + '; easing: easeInCubic');

    p.el.setAttribute('animation__up',
      'property: object3D.position.y; to: 0.12; dur: ' + HARVEST.pickMs + '; easing: easeOutQuad');

    p.ring.setAttribute('animation__fade',
      'property: material.opacity; to: 0; dur: ' + HARVEST.pickMs + '; easing: linear');

    var grain = document.createElement('a-sphere');
    grain.setAttribute('radius', 0.022);
    grain.setAttribute('segments-width', 6);
    grain.setAttribute('segments-height', 5);
    grain.setAttribute('material',
      'color: ' + HARVEST.tint + '; opacity: 0.95; transparent: true; shader: flat');
    grain.setAttribute('position', { x: p.x, y: BED_HEIGHT_M + 0.08, z: p.z });
    grain.setAttribute('animation__rise',
      'property: object3D.position.y; to: ' + lift + '; dur: 520; easing: easeOutQuad');
    grain.setAttribute('animation__gone',
      'property: material.opacity; to: 0; dur: 520; easing: linear');

    plotEl.appendChild(grain);
    setTimeout(function () {
      if (grain.parentNode) { grain.parentNode.removeChild(grain); }
    }, 560);
  }

  // ---------------------------------------------------------------- the score

  // Rows arrive one at a time with their numbers counting up, then the stars, then the verdict.
  // Staged because a number that counts up is read, where one that is simply present is glanced at.
  function showScore(won) {
    var ready = plants.filter(isHarvestable).length;
    var full = plants.filter(function (p) { return p.growth >= SEASON.weeks; }).length;
    var livesLost = plants.reduce(function (t, p) {
      return t + Math.max(0, SEASON.life.max - p.life);
    }, 0);

    var share = plants.length ? ready / plants.length : 0;
    var stars = !won ? 0 : share >= 1 ? 3 : share >= 0.8 ? 2 : 1;

    setState('result');

    resultTitleEl.textContent = won
      ? 'Harvest'
      : (week >= SEASON.weeks ? 'Crop failed' : 'Crop lost in week ' + week);

    resultDetailEl.textContent = won ? VERDICTS[stars] : failureReason();
    resultEl.querySelector('.result-card').setAttribute('data-outcome', won ? 'win' : 'lose');

    countRows([
      { el: rowPickedEl, value: won ? picked : 0, of: plants.length },
      { el: rowFullEl, value: full, of: plants.length },
      { el: rowWeeksEl, value: Math.min(week, SEASON.weeks), of: SEASON.weeks },
      { el: rowLivesEl, value: livesLost, of: null }
    ], function () { showStars(stars); });

    cue(won ? 'sOk' : 'sWarn');
    buzz(won ? [40, 40, 120] : [60, 80, 60]);
    say(won ? 'Harvest' : 'Crop failed', won ? 'found' : 'error');
  }

  var VERDICTS = [
    'The field did not come through this season.',
    'A thin harvest. More of the field needed reaching.',
    'A good season. Most of the field came in.',
    'A perfect season. Every plant reached full size.'
  ];

  // Reveal each row in turn, counting its number up from zero. setTimeout rather than CSS,
  // because a transition cannot count. Four rows, about 2.4 seconds in total.
  function countRows(rows, done) {
    var ROW_MS = 460;
    var STEP_MS = 40;

    rows.forEach(function (row, i) {
      row.el.dataset.shown = '0';
      row.el.querySelector('.score-value').textContent = row.of === null ? '0' : '0 of ' + row.of;
    });

    rows.forEach(function (row, i) {
      setTimeout(function () {
        row.el.dataset.shown = '1';
        cue('sTick');

        var n = 0;
        var valueEl = row.el.querySelector('.score-value');
        var step = Math.max(1, Math.round(row.value / 8));

        (function up() {
          n = Math.min(row.value, n + step);
          valueEl.textContent = row.of === null ? String(n) : n + ' of ' + row.of;
          if (n < row.value) { setTimeout(up, STEP_MS); }
        }());
      }, i * ROW_MS);
    });

    setTimeout(done, rows.length * ROW_MS + 200);
  }

  function showStars(n) {
    var i, star;

    starsEl.innerHTML = '';
    for (i = 0; i < 3; i++) {
      star = document.createElement('i');
      star.dataset.on = i < n ? '1' : '0';
      starsEl.appendChild(star);
    }

    // Each star lands separately, so three stars is three moments rather than one.
    Array.prototype.forEach.call(starsEl.children, function (el, i) {
      if (el.dataset.on !== '1') { return; }
      setTimeout(function () {
        el.dataset.land = '1';
        cue('sOk');
        buzz(24);
      }, i * 220);
    });
  }

  // ---------------------------------------------------------------- pointer handling

  function isUi(target) {
    return !!(target && target.closest && target.closest('.hud-bottom, .debug, .result'));
  }

  /* Screen point to a position on the soil surface, in plot-local metres. */
  function toLocal(clientX, clientY) {
    var cam = sceneEl.camera;
    var mesh = groundEl.getObject3D('mesh');
    if (!cam || !mesh) { return null; }

    pointer.x = (clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, cam);

    var hits = raycaster.intersectObject(mesh, false);
    if (!hits.length) { return null; }

    tmpVec.copy(hits[0].point);
    plotEl.object3D.worldToLocal(tmpVec);
    return { x: tmpVec.x, z: tmpVec.z };
  }

  // Which tool did the user grab? Ray against the geometry first, then a generous screen-space
  // fallback. A can seen from two metres is a small target and a thumb is imprecise, and Week 4
  // is explicit that AR targets need to be more forgiving than screen targets, not less.
  var GRAB_PX = 90;

  function toolUnder(clientX, clientY) {
    var cam = sceneEl.camera;
    if (!cam || !tools.length) { return null; }

    pointer.x = (clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, cam);

    var hits = raycaster.intersectObject(toolsEl.object3D, true);
    var obj, found;

    if (hits.length) {
      obj = hits[0].object;
      while (obj) {
        found = matchTool(obj);
        if (found) { return found; }
        obj = obj.parent;
      }
    }

    // Fallback: nearest tool within GRAB_PX of the tap, measured on screen.
    var best = null;
    var bestD = GRAB_PX;

    tools.forEach(function (t) {
      t.el.object3D.getWorldPosition(tmpVec);
      tmpVec.project(cam);
      var sx = (tmpVec.x + 1) / 2 * window.innerWidth;
      var sy = (-tmpVec.y + 1) / 2 * window.innerHeight;
      var d = Math.sqrt((sx - clientX) * (sx - clientX) + (sy - clientY) * (sy - clientY));
      if (d < bestD) { bestD = d; best = t; }
    });

    return best;
  }

  function matchTool(obj) {
    return tools.filter(function (t) { return t.el.object3D === obj; })[0] || null;
  }

  // Harvesting reuses the drag without a tool in the hand. Same raycast, same distance test,
  // different verb. Anywhere on the soil works, because there is nothing to pick up first.
  function handAt(clientX, clientY) {
    var local = toLocal(clientX, clientY);
    if (!local) { return false; }

    handEl.setAttribute('visible', true);
    handEl.object3D.position.set(local.x, BED_HEIGHT_M + 0.012, local.z);
    pickAt(local.x, local.z);
    return true;
  }

  function onDown(e) {
    if (isUi(e.target)) { return; }

    var t = e.touches ? e.touches[0] : e;

    if (state === 'harvest') {
      harvesting = handAt(t.clientX, t.clientY);
      return;
    }

    if (state !== 'season' || resolving) { return; }

    var tool = toolUnder(t.clientX, t.clientY);
    if (!tool) { return; }

    // One tool a week. Refused with a message rather than by hiding the other tool, because a
    // tool that vanishes leaves the user wondering where it went. Week 4 heuristic 1.
    if (usedThisWeek && usedThisWeek !== tool.def.id) {
      say('One tool a week. You already used the ' + toolById(usedThisWeek).label.toLowerCase(),
        'error');
      cue('sWarn');
      buzz([30, 50, 30]);
      return;
    }

    dragging = tool;
    tool.returnAt = 0;                  // cancel a return still in flight
    tool.ring.setAttribute('visible', true);
    tool.label.setAttribute('visible', false);
    cue('sTick');
    buzz(12);
  }

  function onMove(e) {
    var h = e.touches ? e.touches[0] : e;

    if (state === 'harvest') {
      if (!harvesting) { return; }
      handAt(h.clientX, h.clientY);
      if (e.cancelable) { e.preventDefault(); }
      return;
    }

    if (!dragging) { return; }
    var t = e.touches ? e.touches[0] : e;

    var local = toLocal(t.clientX, t.clientY);
    if (!local) { return; }

    // Clamp to the bed rather than refusing the move. Week 4 heuristic 5, error prevention: an
    // edge the user can feel beats the drag dropping when their finger strays.
    var lim = HALF - 0.02;

    dragging.el.object3D.position.x = Math.max(-lim, Math.min(lim, local.x));
    dragging.el.object3D.position.z = Math.max(-lim, Math.min(lim, local.z));
    dragging.el.object3D.position.y = BED_HEIGHT_M + 0.18;

    // Tip the can toward its spout while it is pouring, keeping its resting turn.
    dragging.model.setAttribute('rotation', '0 ' + dragging.def.yaw + ' -28');

    usedThisWeek = dragging.def.id;
    applyAt(dragging);

    if (e.cancelable) { e.preventDefault(); }
  }

  function onUp() {
    if (state === 'harvest') {
      harvesting = false;
      handEl.setAttribute('visible', false);
      return;
    }

    if (!dragging) { return; }

    var tool = dragging;
    dragging = null;

    tool.ring.setAttribute('visible', false);
    tool.model.setAttribute('rotation', '0 ' + tool.def.yaw + ' 0');
    tool.label.setAttribute('visible', true);

    // Hand the tool to restTools, which slides it home from wherever it was let go. Recording the
    // release point rather than setting an animation is what makes this work more than once.
    tool.returnFrom.copy(tool.el.object3D.position);
    tool.returnAt = -1;             // -1 means "released", restTools starts the clock next frame

    if (usedThisWeek) { nextEl.textContent = 'End week ' + week; }
    paintCoverage();
  }

  // ---------------------------------------------------------------- session probe

  /*
   * isSessionSupported('immersive-ar') answers a question about the class of device, not about
   * whether the next session will be granted, and A-Frame reports every refusal with one sentence
   * that names no cause. So call requestSession directly, one configuration at a time, and read
   * the DOMException the browser actually throws. Each configuration adds exactly one thing to
   * the one before it, so the first failure names the culprit.
   *
   * One probe per tap. An immersive request consumes the page's transient user activation, so a
   * loop would fail every probe after the first for the wrong reason.
   */
  var PROBES = [
    { label: 'bare session', init: {} },
    { label: 'hit-test', init: { requiredFeatures: ['hit-test'] } },
    { label: 'local-floor', init: { requiredFeatures: ['local-floor'] } },
    { label: 'everything we ask for',
      init: { requiredFeatures: ['hit-test'],
              optionalFeatures: ['anchors', 'dom-overlay', 'local-floor'] } }
  ];

  var probeIndex = 0;
  var probeLog = [];

  function labelProbeButton() {
    if (probeIndex >= PROBES.length) {
      diagnoseEl.textContent = 'Copy the results';
      return;
    }
    diagnoseEl.textContent = 'Test ' + (probeIndex + 1) + ' of ' + PROBES.length +
      ': ' + PROBES[probeIndex].label;
  }

  function runProbe() {
    if (probeIndex >= PROBES.length) { debugEl.hidden = false; renderDebug(); return; }

    var probe = PROBES[probeIndex];
    var init = probe.init;

    if (init.optionalFeatures && init.optionalFeatures.indexOf('dom-overlay') !== -1) {
      init = Object.assign({}, init, { domOverlay: { root: hudEl } });
    }

    say('Testing: ' + probe.label);

    navigator.xr.requestSession('immersive-ar', init)
      .then(function (session) {
        probeLog.push('PASS  ' + probe.label);
        probeIndex++;
        return session.end().catch(function () { /* some devices reject a same-tick end */ });
      })
      .catch(function (err) {
        if (probeLog.length === probeIndex) {
          probeLog.push('FAIL  ' + probe.label + '\n        ' +
            (err && err.name ? err.name : 'Error') + ': ' +
            (err && err.message ? err.message : 'no detail'));
          probeIndex++;
        }
      })
      .then(function () {
        debugEl.hidden = false;
        renderDebug();
        labelProbeButton();
        say('Probe ' + probeIndex + ' of ' + PROBES.length +
            ' done. Read the panel, then tap again',
          probeIndex >= PROBES.length ? 'idle' : 'error');
      });
  }

  // ---------------------------------------------------------------- session wiring

  function bindSession() {
    diagnoseEl.addEventListener('click', runProbe);
    labelProbeButton();

    // A session that starts retires the diagnostic, so it is not sitting inside the running
    // session inviting a tap that would tear it down.
    sceneEl.addEventListener('enter-vr', function () {
      diagnoseEl.hidden = true;
      probeIndex = 0;
      probeLog.length = 0;
      labelProbeButton();

      /*
       * Hit testing must be switched back ON for every new session. It is switched off after the
       * first placement so later taps tend the field, and that flag used to survive the session
       * ending: leave AR, press Start, and the marker appears exactly as normal but tapping does
       * nothing forever. A-Frame recreates the hit test on enter-vr without consulting `enabled`,
       * so the marker is live while only the tap handlers are disabled.
       */
      sceneEl.setAttribute('ar-hit-test', 'enabled', true);
    });

    sceneEl.addEventListener('ar-hit-test-start', function () {
      if (state === 'idle' || state === 'scanning') { setState('scanning'); }
    });

    sceneEl.addEventListener('ar-hit-test-achieved', function () {
      if (state === 'scanning') {
        setState('ready');
        cue('sTick');
        buzz(18);
      }
    });

    sceneEl.addEventListener('ar-hit-test-select', function () {
      if (state !== 'ready' && state !== 'placing') { return; }

      plotEl.setAttribute('visible', true);
      sceneEl.setAttribute('ar-hit-test', 'enabled', false);

      cue('sPlace');
      buzz([30, 40, 30]);

      // Moving an existing field keeps the season running. Only a first placement starts one.
      if (state === 'placing') {
        setState('season');
        say('Field moved. Week ' + week + ' of ' + SEASON.weeks, 'found');
        paintCoverage();
      } else {
        startSeason();
      }
    });

    sceneEl.addEventListener('exit-vr', function () {
      setState('idle');
      say('Session ended. Press Start to plant again');
    });
  }

  function bindControls() {
    nextEl.addEventListener('click', endWeek);
    replaceEl.addEventListener('click', movePlot);
    document.getElementById('again').addEventListener('click', startSeason);

    // Stop early. The last plant is often the one in the corner you have to walk round for, and
    // insisting on it would turn a reward into a chore.
    finishEl.addEventListener('click', function () {
      if (state === 'harvest') { showScore(true); }
    });

    // Taps on the overlay controls must not also count as an XR select.
    ['season', 'harvest', 'result', 'enter', 'diagnose', 'replace', 'finish'].forEach(function (id) {
      var el = document.getElementById(id);
      el.addEventListener('beforexrselect', function (e) { e.preventDefault(); });
    });

    // A-Frame reports every session failure with the same sentence, which names no cause. The
    // real DOMException is on the Error's `cause`, so read that instead.
    enterEl.addEventListener('click', function () {
      sceneEl.enterAR().catch(function (err) {
        var root = (err && err.cause) ? err.cause : err;
        var name = (root && root.name) ? root.name : 'Error';
        var text = (root && root.message) ? root.message : 'no detail given';

        say('Could not start AR. ' + name + ': ' + text, 'error');
        lastSessionError = name + ': ' + text;
        if (!debugEl.hidden) { renderDebug(); }
        if (window.console) { console.error('enterAR failed', name, text, err); }

        diagnoseEl.hidden = false;
      });
    });

    window.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp, { passive: true });

    // Mouse equivalents, so the whole flow can be exercised in the desktop emulator.
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // ---------------------------------------------------------------- debug readout

  /*
   * Which phone this is. The panel gets screenshotted whenever something fails, and a screenshot
   * that cannot name its own device is close to worthless as testing evidence.
   *
   * Do not read the model out of navigator.userAgent. Since Chrome 110 the Android version and
   * device model are frozen to the literal string "Android 10; K" on every phone, so a first
   * attempt reported a device that did not exist.
   */
  var deviceText = 'reading';

  (function readDevice() {
    var chrome = navigator.userAgent.match(/Chrome\/(\d+)/);
    var chromeVer = 'Chrome ' + (chrome ? chrome[1] : '?');

    if (!navigator.userAgentData || !navigator.userAgentData.getHighEntropyValues) {
      deviceText = 'model withheld by browser, ' + chromeVer;
      return;
    }

    navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion'])
      .then(function (d) {
        deviceText = (navigator.userAgentData.platform || 'unknown') +
          ' ' + (d.platformVersion || '?') +
          '  ' + (d.model || 'model withheld') +
          '  ' + chromeVer;
      })
      .catch(function () { deviceText = 'device lookup failed, ' + chromeVer; });
  }());

  // Counted in the tool-rest component's tick, not from window.requestAnimationFrame, which is
  // not the loop that draws an immersive session.
  var frames = 0, fps = 0;

  setInterval(function () {
    fps = frames;
    frames = 0;
    if (!debugEl.hidden) { renderDebug(); }
  }, 1000);

  /*
   * Did a model actually arrive, and where is it drawn?
   *
   * A model can fail four ways that look identical on a phone: it never loaded, it is parented
   * somewhere that does not render, its scale is so far out that it is a speck or a wall, or it
   * is the right size in the wrong place because it hangs off its own origin.
   *
   * So this reports where the mesh is actually drawn, in bed coordinates, rather than where the
   * code put its container. An earlier version printed the container and called the fourth case
   * healthy while the watering can was being drawn a metre outside the fence.
   */
  function placeOf(el) {
    var mesh = el && el.getObject3D('mesh');
    if (!mesh) { return 'NO MESH'; }

    // World-space box, so a yaw-rotated bed inflates the size slightly. Being a few centimetres
    // generous costs nothing next to telling apart 0.3 m from 20 m.
    var box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) { return 'EMPTY'; }

    var v = box.getSize(new THREE.Vector3());
    var c = plotEl.object3D.worldToLocal(box.getCenter(new THREE.Vector3()));

    return v.x.toFixed(2) + ' x ' + v.y.toFixed(2) + ' x ' + v.z.toFixed(2) + ' m' +
      '  drawn at ' + c.x.toFixed(2) + ',' + c.y.toFixed(2) + ',' + c.z.toFixed(2);
  }

  function sceneReport() {
    var lines = [];
    var firstFence = fenceEl.children[0];
    var half = HALF.toFixed(2);

    lines.push('bed          ' + PLOT_SIZE_M + ' m, edges at +/-' + half +
      ', grid to +/-' + gridHalfSpanM().toFixed(3));

    lines.push('fence        ' + fenceEl.children.length + ' sections, ' +
      (firstFence ? placeOf(firstFence) : 'NONE BUILT'));

    // Both numbers, deliberately. `home` is where the code believes the tool is and the reach
    // test measures from it; `drawn at` is where the user can see it.
    tools.forEach(function (t) {
      var pos = t.el.object3D.position;
      lines.push(('tool ' + t.def.id + '        ').slice(0, 13) + placeOf(t.model));
      lines.push('             home ' + pos.x.toFixed(2) + ',' + pos.y.toFixed(2) + ',' +
        pos.z.toFixed(2) + '  reach ' + t.def.radiusM + ' m');
    });

    lines.push('plants       ' + plants.length + ' built, first ' +
      (plants[0] ? placeOf(plants[0].model) : 'NONE'));

    return lines.join('\n');
  }

  /*
   * Anchor state. The field is anchored by A-Frame's own ar-hit-test, which calls
   * anchorFromLastHitTestResult() on the target when you tap and copies the anchor pose onto the
   * plot every tick, including after hit testing is switched off.
   *
   * It is reported rather than assumed because `anchors` is requested as an OPTIONAL feature, so
   * the browser may grant the session and refuse the feature without telling us, and the drift
   * claim needs evidence that an anchor existed at the time of the test.
   */
  function xrFeatureLine() {
    var r = sceneEl.renderer;
    var session = r && r.xr && r.xr.getSession();
    if (!session) { return 'no session'; }
    if (!session.enabledFeatures) { return 'granted list not reported by this browser'; }
    return Array.prototype.slice.call(session.enabledFeatures).join(', ');
  }

  function anchorLine() {
    var frame = sceneEl.frame;
    if (!frame) { return 'no xr frame yet'; }
    if (!frame.trackedAnchors) { return 'trackedAnchors not exposed by this browser'; }
    return frame.trackedAnchors.size + ' tracked';
  }

  function renderDebug() {
    var hit = sceneEl.getAttribute('ar-hit-test');
    var alive = plants.filter(function (p) { return p.life > 0; }).length;
    var covered = plants.filter(function (p) { return p.treated; }).length;

    debugEl.textContent = [
      'device       ' + deviceText,
      'fps          ' + fps,
      'state        ' + state,
      'xr session   ' + (sceneEl.is('ar-mode') ? 'active' : 'none'),
      'xr granted   ' + xrFeatureLine(),
      'hit test     ' + (hit ? hit.enabled : 'COMPONENT NOT ATTACHED'),
      'anchors      ' + anchorLine(),
      'last xr err  ' + lastSessionError,
      'week         ' + (week ? week + ' of ' + SEASON.weeks : 'not started'),
      'tool used    ' + (usedThisWeek || 'none'),
      'covered      ' + covered + ' of ' + plants.length,
      'alive        ' + alive + ' of ' + plants.length,
      'field avg    water ' + fieldAverage('water') + '/' + SEASON.max +
        '  food ' + fieldAverage('food') + '/' + SEASON.max +
        '  life ' + fieldAverage('life') + '/' + SEASON.life.max +
        '  grown ' + fieldAverage('growth') + '/' + SEASON.weeks,
      'harvestable  ' + plants.filter(isHarvestable).length + ' of ' + plants.length +
        ', need ' + Math.ceil(plants.length * SEASON.passFraction),
      'dragging     ' + (dragging ? dragging.def.id : 'no'),
      '',
      sceneReport()
    ].join('\n');

    // The probe results are written from here, not from the probe itself. The fps timer above
    // redraws this panel every second, so anything written elsewhere is overwritten a second later.
    if (probeLog.length) {
      debugEl.textContent += '\n\nWEBXR SESSION PROBE\n' + probeLog.join('\n');
    }
  }

  statusEl.addEventListener('click', function () {
    debugEl.hidden = !debugEl.hidden;
    if (!debugEl.hidden) { renderDebug(); }
  });

  // ---------------------------------------------------------------- boot

  // The capability check runs immediately and deliberately does not wait for the scene. Telling
  // someone their phone is unsupported is the one message that must never queue behind a download.
  function showUnsupported(reason) {
    document.getElementById('unsupportedDetail').textContent = reason;
    document.getElementById('unsupported').hidden = false;
    document.body.classList.add('no-xr');
    say('Not supported on this device', 'error');
  }

  function checkSupport() {
    if (!navigator.xr) {
      showUnsupported('This browser does not provide WebXR at all.');
      return Promise.resolve(false);
    }

    return navigator.xr.isSessionSupported('immersive-ar')
      .then(function (ok) {
        if (!ok) {
          showUnsupported(
            'WebXR is present, but this device cannot start an immersive AR session.');
        }
        return ok;
      })
      .catch(function (err) {
        showUnsupported('The AR support check failed: ' +
          (err && err.name ? err.name : 'unknown error') + '.');
        return false;
      });
  }

  say('Checking this device');

  checkSupport().then(function (supported) {
    if (!supported) { return; }

    function ready() {
      // The placement marker is exactly the field's footprint, taken from PLOT_SIZE_M. A marker
      // that lies about where the field will land is worse than a large honest one.
      sceneEl.setAttribute('ar-hit-test', 'mapSize', PLOT_SIZE_M + ' ' + PLOT_SIZE_M);

      buildBed();
      buildFence();
      buildField();
      buildTools();

      // The hand circle is exactly the area it picks, from the same constant the pick test uses.
      handEl.setAttribute('radius-outer', HARVEST.reachM);
      handEl.setAttribute('radius-inner', Math.max(0.01, HARVEST.reachM - 0.04));

      // Keeps both tools at their resting places every frame, and counts frames for the panel.
      sceneEl.setAttribute('tool-rest', '');

      bindControls();
      bindSession();
      setState('idle');
      say('Ready. Press Start, then move your phone slowly across the ground');
    }

    if (sceneEl.hasLoaded) { ready(); } else { sceneEl.addEventListener('loaded', ready); }
  });
}());
