// canvas text doesn't trigger web font loading by itself; ask for the weights used (text falls back until it arrives)
for (const spec of ['bold 24px Fredoka', '22px Fredoka']) document.fonts.load(spec);

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

// theme: whites, creams, lavender, with purple highlights
const COLOR = {
  cream: '#fbf6ec',
  white: '#ffffff',
  lavender: '#e6dff5',
  track: '#b9aedb',   // unfilled bars, inactive outlines
  muted: '#8a7fb5',   // secondary text
  purple: '#7c4dff',  // highlight
  orb: '#a98bff',
  ink: '#3d2b6b',     // main text, player
};

// boss attacks are mud: dark brown edges, lighter brown centers
const MUD = { dark: '#3e2616', deep: '#5c3a22', mid: '#8b5a33', light: '#b8834f', pale: '#d9b48a' };

const FALLBACK_SONG_LENGTH = 30; // seconds, for a boss with no song (or one that fails to load)
const BAR = { w: (canvas.width - 80) / 4, y: 24, capH: 14 };
BAR.x = (canvas.width - BAR.w) / 2; // centered

const MAX_HP = 5;
const REGEN_INTERVAL = 5; // seconds per 1 hp (short for prototyping)
const REGEN_ANIM = 0.5;   // seconds of "lines burst outward" before the orb appears
const END_DELAY = 1.2;    // seconds of win/lose escape animation before the result panel

// boss attacks: a random one every SHOT.interval (placeholder scheduler until songs drive the patterns)
const SHOT = {
  interval: 1.2, speed: 280, r: 10,
  // mud balls the pig throws: launched fast, easing down to a slow cruise, and curving toward the player
  launchSpeed: 950, // px per second as it leaves the pig
  cruiseSpeed: 180, // px per second it settles to
  easeTime: 0.35,   // seconds for most of the extra speed to wear off
  curve: 0.4,       // max turn toward the player, radians per second (about 23 degrees a second)
};
const BOMB = {
  r: 14,
  minDist: 120,                 // shortest throw; the longest reaches the arena edge along the chosen direction
  drag: 1.4,                    // bombs skid to a stop (travel = launch speed / drag)
  fuse: 2.0,                    // seconds until it explodes (4 beats at 120 BPM)
  blastSpeed: 240,              // speed of the 8 projectiles it releases
  gravity: 110,                 // px/s^2 pulling those 8 down, slowly but steadily
  spread: 65 * Math.PI / 180,   // valid throw cone: +/- this from straight left
};
// vertical beam: outlined column charges, then a fast beam sweeps across it, then it dissipates into harmless sparks
const BEAM = {
  w: 56,
  charge: 1.0,  // seconds the outline warns of the column
  sweep: 0.08,  // seconds for the beam to shoot across the screen
  fire: 0.3,    // total seconds the beam is live (damaging)
  sparks: 40,
};
const shots = []; // { x, y, vx, vy }
const beams = []; // { x, dir (1 = down, -1 = up), t, hit }
const sparks = []; // { x, y, vx, vy, age, life, size, color }

// spinner: a purple orb is thrown into the arena, its white center flashes red faster and faster,
// then it fires a laser that spins around it. Only one can exist at a time.
const SPINNER = {
  r: 24, coreR: 10.4,
  drag: 2.5,          // skid to a stop (travel = launch speed / drag)
  margin: 120,        // it always lands at least this far from the left, top and bottom borders and the boss's column
  fuse: 2.0,          // seconds of flashing before the laser
  fadeIn: 0.25,       // the laser fades in and can't hurt until it's fully visible
  laser: 3.0,         // seconds the laser spins
  spin: 1.008,        // radians per second
  length: Math.hypot(canvas.width, canvas.height), // long enough to cross the whole arena from anywhere in it
  width: 18,
  hitCooldown: 0.8,   // after a hit, the laser can't hurt again for this long
  startSpread: 20 * Math.PI / 180, // the laser starts within this angle of pointing straight away from the player
};
let spinner = null; // { x, y, vx, vy, t, phase, firing, angle0, angle, dir, cool }

// taking a hit: the heart pops, the cat flashes red and is briefly invulnerable, the screen shakes, the combo shatters
const HIT = { invuln: 1.0, shake: 0.25, shakeMag: 8, comboBreak: 0.9 };
let screenShake = 0; // seconds left
let comboBreakFx = null; // { chars: [{ ch, w, x, y, vx, vy, rot, vr }], t }
const bombs = []; // { x, y, vx, vy, t, phase }
let attackTimer = 0;

// offense: type the prompt while dodging (right-side QWERTY letters only, never WASD)
const PROMPT = {
  pool: 'YUIOPHJKLNM',
  length: 5,
  time: 5,          // seconds before an untyped prompt disappears
  errorTime: 0.5,   // wrong key: prompt flashes red and shakes, input locked this long
  minGap: 3, maxGap: 8, // random pause between prompts
};
// a completed prompt makes the boss shake, then hold fire for a moment
const BOSS_STUN = { shake: 0.5, ceasefire: 1.5 };
const CALLOUT = { flash: 3, fade: 0.5 }; // combo callout flashes, then fades
// points for a completed prompt = 100 x the combo length it extends to (1st = 100, 2nd = 200, ...),
// so a combo of n prompts is worth 100 * n * (n + 1) / 2 in total
const POINTS_PER_PROMPT = 100;
const promptPoints = combo => POINTS_PER_PROMPT * combo;
const comboCallout = n => n === 2 ? 'Double!' : n === 3 ? 'TRIPLE!' : n === 4 ? 'QUADRUPLE!!!' : n > 4 ? `${n}x COMBO!!!` : null;

const BOSS_HOME_X = canvas.width - 120;
const BOSS_HOME_Y = canvas.height / 2;
const BOSS_BOB = 10; // px the boss floats up and down, one full bob every two beats
const BOSS_ROCK = 5 * Math.PI / 180; // how far the boss rocks side to side, leaning the other way on every beat
const BOSS_DRIFT = 14; // px the boss drifts left and right every four beats (with the bob, it traces a figure-eight)
const BOSS_SQUISH = 0.03; // how much the boss squashes wide and stretches tall, once per beat
const BOSS_ENTRANCE = { time: 1.5, from: 260 }; // at the start of a fight it fades in, sliding in from `from` px right
const BOSS_HOP = 10; // px the boss hops on a bass kick

// Whole-screen sway on beat-map tilts: the view rolls and slides toward each side, swinging smoothly between them
// on a spring, and settles back to level once the tilts stop.
const CAMERA = {
  roll: 2.5 * Math.PI / 180, // how far the view rolls to a side
  slide: 14,                 // px it slides sideways with the roll
  hold: 0.5,                 // seconds a tilt keeps pulling before the view drifts back to level (one beat)
  stiffness: 70,             // spring strength: higher swings over faster
  slowStiffness: 1.5,        // for the very slow lean against a `tiltScreen` spinner's laser
};
const camera = { sway: 0, vel: 0, target: 0, hold: 0, stiffness: CAMERA.stiffness, beat: 0 }; // sway: -1 (left) .. 1 (right)
// every other beat: a small sway (fraction of a full one) lasting `time` seconds. Its size follows how intense the song
// is right now: `min` in the calm parts (always there), up to `max` at its loudest, eased over `settle` seconds so it
// builds up and calms down smoothly.
const BEAT_NUDGE = { min: 0.12, max: 0.34, time: 0.35, settle: 1.2 };
let songIntensity = 0; // 0 (quietest) .. 1 (loudest), smoothed

// every other beat the view nudges to one side and eases back, alternating sides; `beats` = song position in beats
function updateBeatNudge(beats, dt) {
  const target = intensityAt(elapsed);
  songIntensity += (target - songIntensity) * Math.min(1, dt / BEAT_NUDGE.settle);
  const cycle = Math.floor(beats / 2), since = (beats - cycle * 2) * (beatmap ? 60 / beatmap.bpm : 0.5);
  const u = Math.min(1, since / BEAT_NUDGE.time);
  const size = BEAT_NUDGE.min + (BEAT_NUDGE.max - BEAT_NUDGE.min) * songIntensity;
  camera.beat = Math.sin(Math.PI * u) ** 2 * size * (cycle % 2 ? 1 : -1);
}

// how intense the song is at time t, from the beat-map's per-bar loudness: 0 in quiet parts .. 1 in the loudest
// (bars below INTENSITY_FLOOR count as calm)
const INTENSITY_FLOOR = 0.35;
function intensityAt(t) {
  const levels = beatmap?.intensity;
  if (!levels) return 0.5;
  const bar = Math.floor((t - beatmap.offset) / ((4 * 60) / beatmap.bpm));
  const v = levels[Math.max(0, Math.min(levels.length - 1, bar))];
  return Math.max(0, (v - INTENSITY_FLOOR) / (1 - INTENSITY_FLOOR));
}

function updateCamera(dt) {
  camera.hold -= dt;
  if (camera.hold <= 0) camera.target = 0;
  const damping = 2 * Math.sqrt(camera.stiffness); // critically damped: smooth, no wobble past the target
  camera.vel += ((camera.target - camera.sway) * camera.stiffness - camera.vel * damping) * dt;
  camera.sway += camera.vel * dt;
}

// rolls and slides the view about its center. A boss backdrop is drawn bigger than the view, so this only zooms in if
// the roll would reach past the backdrop's hidden strip below the view (or past the edges when there's no backdrop).
function applyCameraRoll() {
  const sway = camera.sway + camera.beat;
  if (Math.abs(sway) < 1e-4) return;
  const a = Math.abs(sway) * CAMERA.roll, W = canvas.width, H = canvas.height;
  const slide = sway * CAMERA.slide;
  const reach = (H / 2) * Math.cos(a) + (W / 2) * Math.sin(a); // how far down the rolled view's corners reach
  const zoom = fightBackdrop()
    ? Math.max(1, reach / (H / 2 + FIGHT_BG.belowView))
    : Math.cos(a) + (W / H) * Math.sin(a) + (2 * Math.abs(slide)) / W;
  ctx.translate(W / 2 + slide, H / 2);
  ctx.rotate(sway * CAMERA.roll);
  ctx.scale(zoom, zoom);
  ctx.translate(-W / 2, -H / 2);
}
const catImgs = {};
for (const pose of ['idle', 'up', 'down']) {
  catImgs[pose] = new Image();
  catImgs[pose].src = `assets/cat_${pose}.png`;
}
// space backdrop: scrolls right to left forever, with an occasional soft shake
const bgImg = new Image();
bgImg.src = 'assets/space_bg.png';
const BG = {
  speed: 25,            // px per second, right to left
  zoom: 1.04,           // drawn slightly oversized so the shake never shows the edges
  shakeEvery: [4, 9],   // seconds between shakes (random in this range)
  shakeTime: 0.9,       // how long a shake lasts
  shakeMag: 4,          // px at the peak of a shake
};
const bg = { scroll: 0, wait: 6, shakeT: 0, offX: 0, offY: 0 };

function updateBackground(dt) {
  bg.scroll += BG.speed * dt;
  if (bg.shakeT > 0) {
    // smooth in and out, slow wobble rather than jitter
    const u = 1 - bg.shakeT / BG.shakeTime;
    const a = BG.shakeMag * Math.sin(Math.PI * u);
    bg.offX = Math.sin(u * 40) * a;
    bg.offY = Math.sin(u * 55 + 1) * a;
    bg.shakeT = Math.max(0, bg.shakeT - dt);
    if (bg.shakeT === 0) bg.offX = bg.offY = 0;
  } else {
    bg.wait -= dt;
    if (bg.wait <= 0) {
      bg.shakeT = BG.shakeTime;
      bg.wait = BG.shakeEvery[0] + Math.random() * (BG.shakeEvery[1] - BG.shakeEvery[0]);
    }
  }
}

// The image is pre-scaled once onto a whole-pixel tile and drawn as a repeating pattern. Drawing separate scaled
// copies at fractional positions leaves a faint hairline between them; a pattern wraps with no seam at all.
let bgPattern = null, bgTileW = 0, bgTileH = 0;
function makeBgPattern() {
  bgTileH = Math.ceil(canvas.height * BG.zoom);
  bgTileW = Math.round(bgImg.naturalWidth * (bgTileH / bgImg.naturalHeight));
  const tile = document.createElement('canvas');
  tile.width = bgTileW;
  tile.height = bgTileH;
  tile.getContext('2d').drawImage(bgImg, 0, 0, bgTileW, bgTileH);
  bgPattern = ctx.createPattern(tile, 'repeat-x');
}

function drawBackground() {
  if (!(bgImg.complete && bgImg.naturalWidth)) return;
  if (!bgPattern) makeBgPattern();
  ctx.save();
  ctx.translate(-(bg.scroll % bgTileW) + bg.offX, -(bgTileH - canvas.height) / 2 + bg.offY);
  ctx.fillStyle = bgPattern;
  ctx.fillRect(-bgTileW, 0, canvas.width + 2 * bgTileW, bgTileH);
  ctx.restore();
}

const titleImg = new Image();
titleImg.src = 'assets/title.png';
const TITLE = {
  scale: 0.7,      // 1 = fill the canvas
  centerY: 207,    // where the wordmark's vertical center lands on the canvas
  wordmarkY: 253,  // where the wordmark's center sits within the full-size image (in canvas px)
};
const heartImg = new Image();
heartImg.src = 'assets/hearts.png';
const CAT_SIZE = 64; // drawn size in px
// scratch canvas used to make a red-tinted copy of the cat when it's hurt
const tintCanvas = document.createElement('canvas');
tintCanvas.width = tintCanvas.height = CAT_SIZE;
const tintCtx = tintCanvas.getContext('2d');
const CAT_MAX_TILT = 20 * Math.PI / 180; // lean at full horizontal speed (right = clockwise)
const CAT_HITBOX = 0.43; // hitbox radius as a fraction of the size (the helmet fills ~86% of the image)

const player = { x: 200, y: canvas.height / 2, vx: 0, vy: 0, tilt: 0, invuln: 0, r: CAT_SIZE * CAT_HITBOX, accel: 1600, friction: 6, maxSpeed: 320 };
const boss = { x: BOSS_HOME_X, y: canvas.height / 2, rx: 60, ry: 110, color: '#d65db1', name: '', shakeT: 0, ceaseT: 0,
  pulse: 0, rock: 0, squish: 0, homeX: BOSS_HOME_X, alpha: 1 };
// placeholder names and colors, one per boss/song
const BOSSES = [
  {
    name: 'Pixel Pig', color: '#d65db1', song: 'assets/audio/pixel_pig.mp3', beatmap: 'pixel_pig', // Di Young - Pixel Pig
    sprite: 'assets/pixel_pig.png', spriteBox: { cx: 93.5, cy: 124.5, h: 191 }, // visible part of the image: center + height
    // two same-size layers: the sky drifts, the grass (transparent above it) stays put
    background: { sky: 'assets/pixel_pig_sky.png', ground: 'assets/pixel_pig_grass.png' },
    spectrum: 'pixel_pig', // audio visualizer data, made by tools/spectrum.py
  },
  { name: 'Vacuum-9000', color: '#4f5bd5', locked: true },   // locked until a future update
  { name: 'Big Cucumber', color: '#e8a75d', locked: true },
];
for (const b of BOSSES) {
  if (b.sprite) b.img = Object.assign(new Image(), { src: b.sprite });
  if (b.background) {
    b.skyImg = Object.assign(new Image(), { src: b.background.sky });
    b.groundImg = Object.assign(new Image(), { src: b.background.ground });
  }
}

// The current boss's arena backdrop (plain cream if it has none): a sky that drifts right to left forever, with the
// still ground layer over it. Both are tiled sideways and drawn bigger than the view, so the camera can roll and slide
// around without showing an edge or needing to zoom in.
const FIGHT_BG = {
  scale: 0.42,      // image px -> canvas px (the 2500x1600 layers come out 1050x672)
  belowView: 25,    // px of the layers hidden below the bottom edge (the rest of the extra height is above the view)
  skySpeed: 15,     // px per second
};
let fightSkyScroll = 0;
const layerPatterns = new Map(); // image -> { pattern, w, h } pre-scaled to whole pixels, so tiles never show seams
const loaded = img => img && img.complete && img.naturalWidth;
const fightBackdrop = () => {
  const b = BOSSES[currentBoss];
  return loaded(b.skyImg) || loaded(b.groundImg) ? b : null;
};

function layerPattern(img) {
  let p = layerPatterns.get(img);
  if (!p) {
    const tile = document.createElement('canvas');
    tile.width = Math.round(img.naturalWidth * FIGHT_BG.scale);
    tile.height = Math.round(img.naturalHeight * FIGHT_BG.scale);
    tile.getContext('2d').drawImage(img, 0, 0, tile.width, tile.height);
    p = { pattern: ctx.createPattern(tile, 'repeat-x'), w: tile.width, h: tile.height };
    layerPatterns.set(img, p);
  }
  return p;
}

// fills a band of repeated tiles, `offset` px scrolled, wide enough to cover a rolled and slid view
function drawLayer(img, offset) {
  const { pattern, w, h } = layerPattern(img);
  const top = canvas.height + FIGHT_BG.belowView - h;
  ctx.save();
  ctx.translate(-(((offset % w) + w) % w) - w, top);
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, canvas.width + 3 * w, h);
  ctx.restore();
}

function drawFightBackground() {
  const b = fightBackdrop();
  if (!b) return;
  if (loaded(b.skyImg)) drawLayer(b.skyImg, fightSkyScroll);
  drawVisualizer(); // between the sky and the grass, so the grass hides the bars' feet
  if (loaded(b.groundImg)) {
    // centered, and still
    drawLayer(b.groundImg, (layerPattern(b.groundImg).w - canvas.width) / 2);
  }
}

// ---- audio visualizer: cava-style bars rising out of the grass, played back from the boss's pre-computed spectrum ----
const VIS = {
  baseY: 505,      // bars grow up from here (behind the grass)
  maxH: 300,       // tallest bar, px
  gap: 0.3,        // fraction of each bar slot left empty
  overscan: 40,    // px past each side so the camera sway never shows the row ending
  rise: 30,        // how quickly bars jump up to the music (per second, higher = snappier)
  gravity: 2.2,    // how quickly bars fall back down (bar heights per second squared)
};
const vis = { levels: null, vel: null }; // current smoothed bar heights 0..1, and each bar's falling speed

function spectrumFor(bossIndex) {
  const b = BOSSES[bossIndex], raw = b.spectrum && window.SPECTRA?.[b.spectrum];
  if (!raw) return null;
  if (!raw.bytes) raw.bytes = Uint8Array.from(atob(raw.data), c => c.charCodeAt(0)); // decoded once
  return raw;
}

function resetVisualizer() {
  const spec = spectrumFor(currentBoss);
  vis.levels = spec ? new Float32Array(spec.bands) : null;
  vis.vel = spec ? new Float32Array(spec.bands) : null;
}

// bars jump up to the music quickly and fall back down with gravity, like cava
function updateVisualizer(dt) {
  const spec = spectrumFor(currentBoss);
  if (!spec || !vis.levels) return;
  const pos = Math.min(elapsed * spec.fps, spec.frames - 1.001);
  const f = Math.max(0, Math.floor(pos)), u = pos - f;
  for (let i = 0; i < spec.bands; i++) {
    const a = spec.bytes[f * spec.bands + i], b = spec.bytes[(f + 1) * spec.bands + i];
    const target = (a + (b - a) * u) / 255;
    if (target >= vis.levels[i]) {
      vis.levels[i] += (target - vis.levels[i]) * Math.min(1, VIS.rise * dt);
      vis.vel[i] = 0;
    } else {
      vis.vel[i] += VIS.gravity * dt;
      vis.levels[i] = Math.max(target, vis.levels[i] - vis.vel[i] * dt);
    }
  }
}

function drawVisualizer() {
  const L = vis.levels;
  if (!L) return;
  const n = L.length, x0 = -VIS.overscan, slot = (canvas.width + 2 * VIS.overscan) / n;
  const w = slot * (1 - VIS.gap);
  const g = ctx.createLinearGradient(0, VIS.baseY - VIS.maxH, 0, VIS.baseY);
  g.addColorStop(0, 'rgba(255, 255, 255, 0.6)');
  g.addColorStop(1, 'rgba(190, 245, 225, 0.25)');
  ctx.save();
  ctx.fillStyle = g;
  for (let i = 0; i < n; i++) {
    // soften each bar with its neighbours so the row moves as a smooth wave
    const v = (L[Math.max(0, i - 1)] + 2 * L[i] + L[Math.min(n - 1, i + 1)]) / 4;
    const h = Math.max(4, v * VIS.maxH);
    roundRectPath(x0 + i * slot + (slot - w) / 2, VIS.baseY - h, w, h + 20, Math.min(w / 2, 6));
    ctx.fill();
  }
  ctx.restore();
}

const health = { hp: MAX_HP, regenTimer: 0 };
let regen = null; // { t, angle } while a health point is about to reappear
// orbs glide freely: they only get pulled in once they drift past the leash, and the farther out they are the faster they move
const ORBIT = {
  radius: 54,      // comfortable distance; inside this they mostly idle
  far: 130,        // distance at which orbs reach full speed
  minSpeed: 6,     // top speed right next to the player (nearly stationary)
  maxSpeed: 420,   // top speed when far behind
  pull: 26,        // acceleration toward the player per px beyond the radius
  wander: 22,      // idle drift acceleration
  padding: 3,      // guaranteed gap between orb edges
  spacing: 32,     // orbs start gently pushing apart inside this center distance
  drag: 2.5,
  r: 12,           // half the drawn size of a heart
};
const orbs = [];
function resetOrbs() {
  orbs.length = 0;
  for (let i = 0; i < MAX_HP; i++) {
    const a = Math.random() * Math.PI * 2, d = ORBIT.radius * (0.6 + Math.random() * 0.8);
    orbs.push({ x: player.x + Math.cos(a) * d, y: player.y + Math.sin(a) * d, vx: 0, vy: 0, phase: i * 2.4 + Math.random() * 6 });
  }
}
resetOrbs();

// WASD only, no arrow keys
const keys = new Set();
addEventListener('keydown', e => {
  keys.add(e.code);
  if (!e.repeat) onKey(e.code);
});
addEventListener('keyup', e => keys.delete(e.code));

// the song keeps playing in a background tab while the game loop stops, so pause the fight when the tab is hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden && scene === 'fight' && fightState === 'playing') fightState = 'paused';
});

let elapsed = 0;
let fightState = 'playing'; // 'playing' | 'paused' | 'won' | 'lost'
let endTimer = 0; // seconds since the fight ended
let score = 0;
let combo = 0;         // consecutive completed prompts since the last hit taken
let maxCombo = 0;      // highest combo reached this fight
let gotHit = false;    // whether the player took any damage this fight
let winStars = [false, false, false];
let currentBoss = 0;   // index into BOSSES for the fight in progress

// best star count per boss, kept across page reloads
const STARS_KEY = 'astrocat.stars';
const bestStars = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(STARS_KEY));
    if (Array.isArray(saved)) return BOSSES.map((_, i) => Math.min(3, Math.max(0, saved[i] | 0)));
  } catch (e) { /* storage unavailable or corrupt: start fresh */ }
  return BOSSES.map(() => 0);
})();
function saveStars() {
  try { localStorage.setItem(STARS_KEY, JSON.stringify(bestStars)); } catch (e) { /* ignore */ }
}

// saved objects: stored fields that are valid numbers override the defaults
function loadNumbers(key, defaults) {
  const out = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    for (const k in defaults) if (Number.isFinite(saved?.[k])) out[k] = saved[k];
  } catch (e) { /* storage unavailable or corrupt: use defaults */ }
  return out;
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

// lifetime records for the achievements page (time played counts only time spent actually fighting)
const STATS_KEY = 'astrocat.stats';
const stats = loadNumbers(STATS_KEY, { topCombo: 0, bestScore: 0, timePlayed: 0 });
const saveStats = () => saveJSON(STATS_KEY, stats);
addEventListener('pagehide', saveStats);

// volumes, 0..1 (sound effects are saved now for when the game gets sounds)
const SETTINGS_KEY = 'astrocat.settings';
const settings = loadNumbers(SETTINGS_KEY, { music: 0.7, sfx: 0.7 });
const saveSettings = () => saveJSON(SETTINGS_KEY, settings);
let callout = null;    // { text, t } combo text on screen
let typing = null;     // { chars, typed, t, errorT } the active prompt
let promptTimer = 0;   // seconds until the next prompt appears

const fightEnded = () => fightState === 'won' || fightState === 'lost';
// pause panel shows immediately, win/lose panels wait for the escape animation
const overlayVisible = () => fightState === 'paused' || (fightEnded() && endTimer >= END_DELAY);

// The fight's song: its playback position drives the progress bar, and finishing it is the win condition.
let song = null; // Audio element while a fight is running
// (until the audio's length is known, the beat-map's copy of it keeps the progress bar and drop diamonds in place)
const songLength = () => song && isFinite(song.duration) ? song.duration : song && beatmap ? beatmap.duration : FALLBACK_SONG_LENGTH;

function startSong(path) {
  if (song) song.pause();
  song = null;
  if (!path) return;
  const s = new Audio(path);
  s.volume = settings.music;
  s.addEventListener('error', () => { if (song === s) song = null; }); // fall back to the timer if it can't load
  song = s;
  s.play().catch(() => {});
}

// keep playback in step with the game: plays only while fighting, pauses with the pause menu / end screens, stops in menus
function syncMusic() {
  if (!song) return;
  if (scene !== 'fight') { song.pause(); song = null; return; }
  song.volume = settings.music;
  const shouldPlay = fightState === 'playing';
  if (shouldPlay && song.paused && !song.ended) song.play().catch(() => {});
  else if (!shouldPlay && !song.paused) song.pause();
}

function startFight(bossIndex) {
  currentBoss = bossIndex;
  startSong(BOSSES[bossIndex].song);
  beatmap = window.BEATMAPS?.[BOSSES[bossIndex].beatmap] ?? null;
  beatQueue = beatmap ? [...beatmap.events].sort((a, b) => (a.t - windup(a)) - (b.t - windup(b))) : [];
  nextEvent = 0;
  const def = BOSSES[bossIndex];
  Object.assign(boss, { x: BOSS_HOME_X, homeX: BOSS_HOME_X, color: def.color, name: def.name, img: def.img ?? null, box: def.spriteBox });
  fightState = 'playing';
  endTimer = 0;
  score = 0;
  regen = null;
  shots.length = 0;
  bombs.length = 0;
  beams.length = 0;
  sparks.length = 0;
  spinner = null;
  attackTimer = 0;
  Object.assign(boss, { shakeT: 0, ceaseT: 0, pulse: 0 });
  Object.assign(camera, { sway: 0, vel: 0, target: 0, hold: 0, stiffness: CAMERA.stiffness, beat: 0 });
  combo = 0;
  maxCombo = 0;
  gotHit = false;
  winStars = [false, false, false];
  callout = null;
  typing = null;
  promptTimer = randomPromptGap();
  Object.assign(player, { x: 200, y: canvas.height / 2, vx: 0, vy: 0, tilt: 0, invuln: 0 });
  screenShake = 0;
  comboBreakFx = null;
  Object.assign(health, { hp: MAX_HP, regenTimer: 0 });
  resetOrbs();
  elapsed = 0;
  resetVisualizer();
  songIntensity = 0;
  scene = 'fight';
}

const STAR_COMBO = 5; // highest combo needed for the second star

function endFight(result) {
  // star tiers, each includes the ones below it: 1 = win, 2 = win with a big combo, 3 = win without being hit
  const tier = result !== 'won' ? 0 : !gotHit ? 3 : maxCombo >= STAR_COMBO ? 2 : 1;
  winStars = [tier >= 1, tier >= 2, tier >= 3];
  if (tier > bestStars[currentBoss]) {
    bestStars[currentBoss] = tier;
    saveStars();
  }
  stats.topCombo = Math.max(stats.topCombo, maxCombo);
  stats.bestScore = Math.max(stats.bestScore, score);
  saveStats();
  fightState = result;
  endTimer = 0;
  regen = null;
  typing = null;
}

// ---- offense: typing prompt ----
const randomPromptGap = () => PROMPT.minGap + Math.random() * (PROMPT.maxGap - PROMPT.minGap);

function spawnPrompt() {
  let chars = '';
  while (chars.length < PROMPT.length) {
    const c = PROMPT.pool[Math.floor(Math.random() * PROMPT.pool.length)];
    if (c !== chars[chars.length - 1]) chars += c; // no doubled letters
  }
  typing = { chars, typed: 0, t: 0, errorT: 0 };
}

function typePromptKey(code) {
  if (!typing || typing.errorT > 0 || !code.startsWith('Key')) return;
  const ch = code.slice(3);
  if (!PROMPT.pool.includes(ch)) return; // WASD and any other key are ignored
  if (ch === typing.chars[typing.typed]) {
    if (++typing.typed === typing.chars.length) completePrompt();
  } else {
    typing.errorT = PROMPT.errorTime; // progress is kept, input resumes after the lockout
  }
}

function completePrompt() {
  combo++;
  maxCombo = Math.max(maxCombo, combo);
  score += promptPoints(combo);
  const text = comboCallout(combo);
  callout = text ? { text, t: 0 } : null;
  boss.shakeT = BOSS_STUN.shake;
  boss.ceaseT = BOSS_STUN.ceasefire;
  typing = null;
  promptTimer = randomPromptGap();
}

// ---- boss attacks ----
// `thrown` = thrown by the boss (fast start, curves toward the player); `falls` = from a bomb burst (steady speed,
// pulled slowly down by gravity). Nothing else curves or falls.
function fireShot(x, y, vx, vy, { thrown = false, falls = false, straight = false } = {}) {
  shots.push({ x, y, vx, vy, trail: [], thrown, falls, straight, age: 0 });
}

function steerThrownShot(s, dt) {
  s.age += dt;
  const speed = SHOT.cruiseSpeed + (SHOT.launchSpeed - SHOT.cruiseSpeed) * Math.exp(-s.age / SHOT.easeTime);
  let heading = Math.atan2(s.vy, s.vx);
  if (fightState === 'playing' && !s.straight) {
    // turn a little toward the cat, but only while it's still ahead (so balls never boomerang back)
    let diff = Math.atan2(player.y - s.y, player.x - s.x) - heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    if (Math.abs(diff) < Math.PI / 2) heading += Math.max(-SHOT.curve * dt, Math.min(SHOT.curve * dt, diff));
  }
  s.vx = Math.cos(heading) * speed;
  s.vy = Math.sin(heading) * speed;
}

// mud trails: each ball remembers where it was for the last TRAIL_TIME seconds and drags a fading smear behind it
const TRAIL_TIME = 0.28; // about 80px behind a normal shot
function recordTrail(o, dt) {
  for (const p of o.trail) p.age += dt;
  while (o.trail.length && o.trail[0].age > TRAIL_TIME) o.trail.shift();
  o.trail.push({ x: o.x, y: o.y, age: 0 });
}
function drawTrail(o, r) {
  const pts = o.trail;
  if (pts.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = MUD.mid;
  for (let i = 1; i < pts.length; i++) {
    const u = 1 - pts[i].age / TRAIL_TIME; // 1 at the ball, 0 at the tail end
    ctx.globalAlpha = 0.65 * u;
    ctx.lineWidth = Math.max(1, 1.7 * r * u);
    ctx.beginPath();
    ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
    ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  ctx.restore();
}

// out of the boss's center, heading left, tilted by `degrees` (0 = horizontal, + = up, - = down)
// snapped to 15 degree steps and limited to +/-75 so it always heads into the arena
const SHOOT_STEP = 15, SHOOT_MAX = 75;
// `straight`: no curving toward the player, and thrown from the exact middle height of the arena
function shoot(degrees = 0, straight = false) {
  const snapped = Math.max(-SHOOT_MAX, Math.min(SHOOT_MAX, Math.round(degrees / SHOOT_STEP) * SHOOT_STEP));
  const rad = snapped * Math.PI / 180;
  fireShot(boss.x, straight ? BOSS_HOME_Y : boss.y, -Math.cos(rad) * SHOT.speed, -Math.sin(rad) * SHOT.speed,
    { thrown: true, straight });
}
const shootRandomAngle = () => shoot((Math.floor(Math.random() * (2 * SHOOT_MAX / SHOOT_STEP + 1)) - SHOOT_MAX / SHOOT_STEP) * SHOOT_STEP);

// vertical shots sweep a column of the arena: up from the bottom edge, down from the top edge
const randomLane = () => 40 + Math.random() * (BOSS_HOME_X - boss.rx - 80);
// `shake` (optional): when it fires, the screen swings that hard (1 = a full beam-run sway) toward the beam's side
function shootBeam(dir, x = randomLane(), shake = 0) {
  beams.push({ x, dir, t: 0, hit: false, fired: false, shake });
}
const shootDown = (x, shake) => shootBeam(1, x, shake);  // sweeps from the top edge down
const shootUp = (x, shake) => shootBeam(-1, x, shake);   // sweeps from the bottom edge up

// leftover energy drifting off the column once a beam ends
function spawnBeamSparks(b) {
  for (let i = 0; i < BEAM.sparks; i++) {
    const x = b.x + (Math.random() - 0.5) * BEAM.w;
    sparks.push({
      x, y: Math.random() * canvas.height,
      vx: ((x - b.x) / (BEAM.w / 2)) * 70 + (Math.random() - 0.5) * 60,
      vy: (Math.random() - 0.5) * 80,
      age: 0, life: 0.8 + Math.random() * 0.6,
      size: 3 + Math.random() * 4,
      color: Math.random() < 0.5 ? MUD.mid : MUD.light,
    });
  }
}

// circle (player) vs the part of the beam that has been swept so far
function beamHitsPlayer(b) {
  const p = Math.min(1, (b.t - BEAM.charge) / BEAM.sweep);
  const y0 = b.dir === 1 ? 0 : canvas.height * (1 - p);
  const y1 = b.dir === 1 ? canvas.height * p : canvas.height;
  const cx = Math.max(b.x - BEAM.w / 2, Math.min(b.x + BEAM.w / 2, player.x));
  const cy = Math.max(y0, Math.min(y1, player.y));
  return Math.hypot(player.x - cx, player.y - cy) < player.r;
}

// a valid direction is anywhere in the cone pointing left, into the arena (never behind or into the boss)
function throwBomb() {
  const angle = Math.PI + (Math.random() * 2 - 1) * BOMB.spread;
  const dx = Math.cos(angle), dy = Math.sin(angle);

  // distance to the arena edge along this direction (left wall, and the top or bottom wall)
  const top = BAR.y + BAR.capH + BOMB.r, bottom = canvas.height - BOMB.r;
  const toWall = Math.min(
    (boss.x - BOMB.r) / -dx,
    dy > 0 ? (bottom - boss.y) / dy : dy < 0 ? (boss.y - top) / -dy : Infinity,
  );

  // throw anywhere from minDist up to the wall; the launch speed is chosen so drag stops it exactly there,
  // so it can never reach an edge (no bouncing, no clamping)
  const dist = Math.min(toWall, BOMB.minDist + Math.random() * (toWall - BOMB.minDist));
  const speed = dist * BOMB.drag;
  bombs.push({ x: boss.x, y: boss.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, t: 0, phase: 0, angle, trail: [] });
}

// bursts into projectiles in all 8 compass directions
function explodeBomb(b) {
  for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 4;
    fireShot(b.x, b.y, Math.cos(a) * BOMB.blastSpeed, Math.sin(a) * BOMB.blastSpeed, { falls: true });
  }
}

// throws the spinner to a random spot at least SPINNER.margin from the borders (skips if one is already out)
// optional: `dur` = laser seconds, `rev` = seconds into the laser when it reverses direction (a number, or a list to
// reverse several times), `spin` = radians/sec, `tiltScreen` = the screen leans very slowly against the laser's turn,
// `aim` = degrees: start that far to one side of the player and sweep toward them (default: start pointing away),
// `doubleSided` = the laser shoots out both sides of the orb
function launchSpinner({
  dur = SPINNER.laser, rev = [], spin = SPINNER.spin, tiltScreen = false, aim = null, doubleSided = false,
} = {}) {
  if (spinner) return;
  rev = [].concat(rev ?? []).sort((a, b) => a - b);
  const m = SPINNER.margin;
  const top = BAR.y + BAR.capH + m;
  const tx = m + Math.random() * (BOSS_HOME_X - boss.rx - 2 * m);
  const ty = top + Math.random() * (canvas.height - m - top);
  const dx = tx - boss.x, dy = ty - boss.y;
  const dist = Math.hypot(dx, dy);
  const speed = dist * SPINNER.drag; // drag stops it at the target
  spinner = {
    x: boss.x, y: boss.y, vx: (dx / dist) * speed, vy: (dy / dist) * speed,
    t: 0, phase: 0, firing: false, angle0: 0, angle: 0,
    dir: Math.random() < 0.5 ? 1 : -1, cool: 0, dur, rev, spin, tiltScreen, aim, doubleSided,
  };
}

function updateSpinner(dt) {
  const s = spinner;
  s.t += dt;
  const drag = Math.exp(-SPINNER.drag * dt);
  s.vx *= drag; s.vy *= drag;
  s.x += s.vx * dt; s.y += s.vy * dt;

  // the orb itself hurts on contact (shares the laser's hit cooldown)
  s.cool = Math.max(0, s.cool - dt);
  if (canHit() && s.cool <= 0 && Math.hypot(s.x - player.x, s.y - player.y) < SPINNER.r + player.r) {
    damagePlayer();
    s.cool = SPINNER.hitCooldown;
  }

  if (s.t < SPINNER.fuse) {
    const u = s.t / SPINNER.fuse;
    s.phase += (2 + 16 * u * u) * dt; // flashes per second, ramping up
    return;
  }

  if (!s.firing) {
    // laser starts pointing directly away from the player (give or take SPINNER.startSpread; a double-sided one
    // starts crosswise instead, so neither end is on them), or, with `aim`, that many degrees beside the player,
    // turning toward them
    s.firing = true;
    s.vx = s.vy = 0;
    const toPlayer = Math.atan2(player.y - s.y, player.x - s.x);
    const spread = (Math.random() * 2 - 1) * SPINNER.startSpread;
    s.angle0 = s.aim !== null ? toPlayer - s.dir * (s.aim * Math.PI / 180)
      : s.doubleSided ? toPlayer + Math.PI / 2 + spread
      : toPlayer + Math.PI + spread;
  }
  const lt = s.t - SPINNER.fuse;
  if (lt >= s.dur) {
    spinner = null;
    return;
  }
  // sweeps one way, and at each reverse point swings back the way it came
  let swept = 0, sign = 1, from = 0;
  for (const r of s.rev) {
    if (lt <= r) break;
    swept += sign * (r - from);
    sign = -sign;
    from = r;
  }
  swept += sign * (lt - from);
  s.angle = s.angle0 + s.dir * s.spin * swept;
  if (s.tiltScreen) {
    // lean the opposite way to the laser's turn (positive = clockwise), flipping each time it reverses
    camera.target = -s.dir * sign;
    camera.hold = 0.1; // released shortly after the laser ends, then eases back to level just as slowly
    camera.stiffness = CAMERA.slowStiffness;
  }
  if (canHit() && lt >= SPINNER.fadeIn && s.cool <= 0 && laserHitsPlayer(s)) {
    damagePlayer();
    s.cool = SPINNER.hitCooldown;
  }
}

// player circle vs the laser segment
// player circle vs the laser (a segment out from the orb, or through it both ways when double-sided)
function laserHitsPlayer(s) {
  const ex = Math.cos(s.angle) * SPINNER.length, ey = Math.sin(s.angle) * SPINNER.length;
  const px = player.x - s.x, py = player.y - s.y;
  const t = Math.max(s.doubleSided ? -1 : 0, Math.min(1, (px * ex + py * ey) / (ex * ex + ey * ey)));
  return Math.hypot(px - ex * t, py - ey * t) < player.r + SPINNER.width / 2;
}

const ATTACKS = [shootRandomAngle, shootUp, shootDown, throwBomb, launchSpinner];

// ---- beat-map: attacks placed on the song's beats (generated by tools/beatmap.py) ----
// Each event's `t` is when the attack lands (a beam fires, a bomb bursts, a spinner's laser starts), so attacks with
// a wind-up are started that much earlier to hit on the beat.
const laneX = x => x === undefined ? undefined : 40 + x * (BOSS_HOME_X - boss.rx - 80);
const BEAT_ATTACKS = {
  shoot: e => shoot(e.deg ?? 0, e.straight),
  fan: e => {
    for (let d = Math.min(e.from, e.to); d <= Math.max(e.from, e.to); d += SHOOT_STEP) shoot(d, e.straight);
  },
  beamUp: e => shootUp(laneX(e.x), e.shake),
  beamDown: e => shootDown(laneX(e.x), e.shake),
  bomb: () => throwBomb(),
  spinner: e => launchSpinner({
    dur: e.dur, rev: e.rev, spin: e.spin, tiltScreen: e.tiltScreen, aim: e.aim, doubleSided: e.doubleSided,
  }),
  // boss movement cues (not attacks)
  tilt: e => { camera.target = e.dir; camera.hold = CAMERA.hold; camera.stiffness = CAMERA.stiffness; }, // screen sways
  pulse: e => { boss.pulse = Math.max(boss.pulse, e.power ?? 1); },
};
const MOTION_EVENTS = new Set(['tilt', 'pulse']); // not attacks: still happen while the boss is stunned
const windup = e => ({ beamUp: BEAM.charge, beamDown: BEAM.charge, bomb: BOMB.fuse, spinner: SPINNER.fuse })[e.a] ?? 0;
const STALE_EVENT = 0.25; // seconds late before an event is dropped (e.g. after the tab was in the background)

let beatmap = null;  // the current boss's beat-map, if it has one
let beatQueue = [];  // its events ordered by when they have to START (landing time minus wind-up)
let nextEvent = 0;   // index of the next event to start

function runBeatmap() {
  const events = beatQueue;
  while (nextEvent < events.length && events[nextEvent].t - windup(events[nextEvent]) <= elapsed) {
    const e = events[nextEvent++];
    const late = elapsed - (e.t - windup(e));
    if (late > STALE_EVENT || (boss.ceaseT > 0 && !MOTION_EVENTS.has(e.a))) continue; // stunned boss holds fire
    BEAT_ATTACKS[e.a]?.(e);
  }
}

// the build-up before a drop the song is currently in, if any
const currentDrop = () => beatmap?.drops.find(d => elapsed >= d.build && elapsed < d.drop) ?? null;

// hits only land while playing and not already invulnerable from the last hit
const canHit = () => fightState === 'playing' && player.invuln <= 0;

function damagePlayer() {
  popHeart(orbs[health.hp - 1]); // the heart that's about to disappear
  health.hp = Math.max(0, health.hp - 1);
  health.regenTimer = 0; // regen clock restarts on a hit
  gotHit = true;
  if (combo > 0) spawnComboBreak(combo);
  combo = 0;
  callout = null;
  player.invuln = HIT.invuln;
  screenShake = HIT.shake;
}

// the lost heart bursts into pink bits
function popHeart(o) {
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2, sp = 90 + Math.random() * 130;
    sparks.push({
      x: o.x, y: o.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      age: 0, life: 0.5 + Math.random() * 0.4,
      size: 4 + Math.random() * 3,
      color: Math.random() < 0.5 ? '#f48fb1' : '#ffc1d9',
    });
  }
}

// the "Combo xN" HUD text breaks into letters that fall away
function spawnComboBreak(n) {
  const text = `Combo x${n}`;
  ctx.font = 'bold 24px Fredoka, sans-serif';
  const chars = [];
  for (let i = 0; i < text.length; i++) {
    chars.push({
      ch: text[i], w: ctx.measureText(text[i]).width,
      x: 24 + ctx.measureText(text.slice(0, i)).width, y: 52,
      vx: (Math.random() - 0.5) * 160, vy: -80 - Math.random() * 120,
      rot: 0, vr: (Math.random() - 0.5) * 8,
    });
  }
  comboBreakFx = { chars, t: 0 };
}

function updateComboBreak(dt) {
  comboBreakFx.t += dt;
  if (comboBreakFx.t >= HIT.comboBreak) { comboBreakFx = null; return; }
  for (const c of comboBreakFx.chars) {
    c.vy += 700 * dt;
    c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.vr * dt;
  }
}

function drawComboBreak() {
  const fx = comboBreakFx;
  ctx.font = 'bold 24px Fredoka, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e53935';
  ctx.globalAlpha = 1 - Math.max(0, (fx.t - 0.3) / (HIT.comboBreak - 0.3)); // hold, then fade
  for (const c of fx.chars) {
    ctx.save();
    ctx.translate(c.x + c.w / 2, c.y + 12);
    ctx.rotate(c.rot);
    ctx.fillText(c.ch, 0, 0);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function updateFight(dt) {
  const playing = fightState === 'playing';
  if (playing) {
    stats.timePlayed += dt;
    // the song's own clock, or a plain timer when there's no song
    elapsed = Math.min(song ? song.currentTime : elapsed + dt, songLength());
    if (song ? song.ended : elapsed >= songLength()) {
      elapsed = songLength();
      endFight('won');
    }
  } else {
    endTimer += dt;
  }
  updateVisualizer(dt);

  // win: the boss flees off the right edge
  if (fightState === 'won') boss.homeX += 800 * endTimer * dt;

  // in time with the music (and still while it flees): floats up and down every two beats, and rocks side to side,
  // leaning fully one way on each beat and the other way on the next. Attacks come from where it is.
  const beat = beatmap ? 60 / beatmap.bpm : 0.5;
  const beats = (elapsed + endTimer - (beatmap?.offset ?? 0)) / beat;
  // entrance: over the song's first moments it fades in and glides in from the right, slowing as it arrives
  const enter = Math.min(1, elapsed / BOSS_ENTRANCE.time);
  boss.alpha = enter;
  boss.x = boss.homeX + Math.sin((Math.PI * beats) / 2) * BOSS_DRIFT + (1 - enter) ** 3 * BOSS_ENTRANCE.from;
  boss.y = BOSS_HOME_Y + Math.sin(Math.PI * beats) * BOSS_BOB;
  boss.rock = Math.cos(Math.PI * beats) * BOSS_ROCK;
  boss.squish = Math.cos(2 * Math.PI * beats) * BOSS_SQUISH; // + = wide and short, on each beat
  updateBeatNudge(beats, dt);

  updateCamera(dt);
  boss.pulse *= Math.exp(-9 * dt); // kick bounces fade out

  boss.shakeT = Math.max(0, boss.shakeT - dt);
  boss.ceaseT = Math.max(0, boss.ceaseT - dt);
  if (callout) {
    callout.t += dt;
    if (callout.t >= CALLOUT.flash + CALLOUT.fade) callout = null;
  }
  player.invuln = Math.max(0, player.invuln - dt);
  screenShake = Math.max(0, screenShake - dt);
  if (comboBreakFx) updateComboBreak(dt);

  // typing prompt: appears at random, disappears if not finished in time
  if (playing) {
    if (!typing) {
      promptTimer -= dt;
      if (promptTimer <= 0) spawnPrompt();
    } else {
      typing.t += dt;
      typing.errorT = Math.max(0, typing.errorT - dt);
      if (typing.t >= PROMPT.time) {
        typing = null;
        promptTimer = randomPromptGap();
      }
    }
  }

  // attacks: follow the song's beat-map, or pick a random one on a timer for bosses without one
  if (playing && beatmap) runBeatmap();
  else if (playing && boss.ceaseT <= 0) {
    attackTimer += dt;
    if (attackTimer >= SHOT.interval) {
      attackTimer = 0;
      const pool = spinner ? ATTACKS.filter(a => a !== launchSpinner) : ATTACKS; // never two spinners at once
      pool[Math.floor(Math.random() * pool.length)]();
    }
  }

  // bombs (harmless until they burst): skid to a stop, flash faster and faster, then explode
  for (let i = bombs.length - 1; i >= 0; i--) {
    const b = bombs[i];
    b.t += dt;
    const drag = Math.exp(-BOMB.drag * dt);
    b.vx *= drag; b.vy *= drag;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (Math.hypot(b.vx, b.vy) > 5) b.angle = Math.atan2(b.vy, b.vx); // keeps the last heading once it stops
    recordTrail(b, dt); // the trail shrinks away on its own as the bomb skids to a stop
    const urgency = b.t / BOMB.fuse;
    b.phase += (2 + 16 * urgency * urgency) * dt; // flashes per second, ramping up
    if (b.t >= BOMB.fuse) {
      explodeBomb(b);
      bombs.splice(i, 1);
    }
  }

  if (spinner) updateSpinner(dt);

  // beams: charge (outline only), fire (damaging, once per beam), then dissipate into sparks
  for (let i = beams.length - 1; i >= 0; i--) {
    const b = beams[i];
    b.t += dt;
    if (!b.fired && b.t >= BEAM.charge) {
      b.fired = true;
      if (b.shake) {
        camera.target = (b.x < canvas.width / 2 ? -1 : 1) * b.shake;
        camera.hold = CAMERA.hold;
        camera.stiffness = CAMERA.stiffness;
      }
    }
    if (b.t >= BEAM.charge + BEAM.fire) {
      spawnBeamSparks(b);
      beams.splice(i, 1);
    } else if (canHit() && !b.hit && b.t >= BEAM.charge && beamHitsPlayer(b)) {
      b.hit = true;
      damagePlayer();
    }
  }

  // sparks: drift and fade, never damaging
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.age += dt;
    if (s.age >= s.life) { sparks.splice(i, 1); continue; }
    const drag = Math.exp(-1.5 * dt);
    s.vx *= drag; s.vy *= drag;
    s.x += s.vx * dt; s.y += s.vy * dt;
  }

  // projectiles: move, collide with the player (they keep flying after the fight ends)
  const margin = SHOT.r * 2;
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i];
    if (s.thrown) steerThrownShot(s, dt);
    if (s.falls) s.vy += BOMB.gravity * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    recordTrail(s, dt);
    if (canHit() && Math.hypot(s.x - player.x, s.y - player.y) < SHOT.r + player.r) {
      damagePlayer();
      shots.splice(i, 1);
    } else if (s.x < -margin || s.x > canvas.width + margin || s.y < -margin || s.y > canvas.height + margin) {
      shots.splice(i, 1);
    }
  }
  if (health.hp <= 0 && fightState === 'playing') endFight('lost');

  // slidey movement: accelerate toward input, exponential friction when coasting
  // lose: the cat runs off the left edge on its own
  let dx = 0, dy = 0;
  if (fightState === 'playing') {
    dx = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    dy = (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0);
  } else if (fightState === 'lost') {
    dx = -1;
  }
  const len = Math.hypot(dx, dy) || 1; // normalize so diagonals aren't faster
  player.vx += (dx / len) * player.accel * dt;
  player.vy += (dy / len) * player.accel * dt;

  const damp = Math.exp(-player.friction * dt);
  player.vx *= damp;
  player.vy *= damp;

  const speed = Math.hypot(player.vx, player.vy);
  if (speed > player.maxSpeed) {
    player.vx *= player.maxSpeed / speed;
    player.vy *= player.maxSpeed / speed;
  }
  if (dx === 0 && dy === 0 && speed < 8) player.vx = player.vy = 0; // snap to a full stop

  player.x += player.vx * dt;
  player.y += player.vy * dt;

  // lean into horizontal movement, eased so it doesn't snap
  const tiltTarget = Math.max(-1, Math.min(1, player.vx / player.maxSpeed)) * CAT_MAX_TILT;
  player.tilt += (tiltTarget - player.tilt) * (1 - Math.exp(-12 * dt));

  // keep the player inside the arena, and out of the boss's column (not while escaping)
  if (fightState !== 'lost') {
    const minY = BAR.y + BAR.capH + player.r;
    const maxX = BOSS_HOME_X - boss.rx - player.r;
    if (player.x < player.r) { player.x = player.r; player.vx = 0; }
    if (player.x > maxX) { player.x = maxX; player.vx = 0; }
    if (player.y < minY) { player.y = minY; player.vy = 0; }
    if (player.y > canvas.height - player.r) { player.y = canvas.height - player.r; player.vy = 0; }
  }

  // regen: 1 hp every REGEN_INTERVAL while damaged, with a short burst before the orb appears
  if (playing) {
    if (!regen && health.hp < MAX_HP) {
      health.regenTimer += dt;
      if (health.regenTimer >= REGEN_INTERVAL) {
        health.regenTimer = 0;
        regen = { t: 0, angle: Math.random() * Math.PI * 2 };
      }
    } else if (!regen) {
      health.regenTimer = 0;
    }
    if (regen) {
      regen.t += dt;
      if (regen.t >= REGEN_ANIM) {
        const o = orbs[health.hp];
        const p = regenSpot();
        Object.assign(o, { x: p.x, y: p.y, vx: 0, vy: 0 });
        health.hp++;
        regen = null;
      }
    }
  }

  // health orbs: loose tether, no fixed slots, so they drift and settle wherever they end up
  for (let i = 0; i < health.hp; i++) {
    const o = orbs[i];
    const ox = o.x - player.x, oy = o.y - player.y;
    const d = Math.hypot(ox, oy) || 1;
    const nx = ox / d, ny = oy / d;
    let ax = 0, ay = 0;

    // slow lazy wander (different phase per orb), fades out as the orb gets pulled in
    const calm = 1 - Math.min(1, Math.max(0, (d - ORBIT.radius) / ORBIT.radius));
    ax += Math.cos(elapsed * 0.9 + o.phase) * ORBIT.wander * calm;
    ay += Math.sin(elapsed * 1.3 + o.phase * 1.7) * ORBIT.wander * calm;

    // leash: pull toward the player once outside the radius, stronger the farther out
    if (d > ORBIT.radius) {
      const excess = d - ORBIT.radius;
      ax -= nx * excess * ORBIT.pull;
      ay -= ny * excess * ORBIT.pull;
    } else if (d < player.r + ORBIT.r + 4) {
      ax += nx * 200; ay += ny * 200; // don't sit on top of the player
    }

    // keep orbs from stacking on each other
    for (let j = 0; j < health.hp; j++) {
      if (j === i) continue;
      const sx = o.x - orbs[j].x, sy = o.y - orbs[j].y;
      const sd = Math.hypot(sx, sy) || 1;
      if (sd < ORBIT.spacing) {
        const push = (ORBIT.spacing - sd) * 40;
        ax += (sx / sd) * push; ay += (sy / sd) * push;
      }
    }

    o.vx += ax * dt; o.vy += ay * dt;
    const drag = Math.exp(-ORBIT.drag * dt);
    o.vx *= drag; o.vy *= drag;

    // speed cap scales with distance to the player: close = crawl, far = zoom
    const f = Math.min(1, d / ORBIT.far);
    const cap = ORBIT.minSpeed + (ORBIT.maxSpeed - ORBIT.minSpeed) * f * f;
    const sp = Math.hypot(o.vx, o.vy);
    if (sp > cap) { o.vx *= cap / sp; o.vy *= cap / sp; }

    o.x += o.vx * dt; o.y += o.vy * dt;
  }

  // hard separation: orbs can never touch, they always keep the padding between their edges
  const minDist = ORBIT.r * 2 + ORBIT.padding;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < health.hp; i++) {
      for (let j = i + 1; j < health.hp; j++) {
        const a = orbs[i], b = orbs[j];
        let sx = b.x - a.x, sy = b.y - a.y;
        let sd = Math.hypot(sx, sy);
        if (sd >= minDist) continue;
        if (sd < 1e-6) { sx = 1; sy = 0; sd = 1; }
        const nx = sx / sd, ny = sy / sd;
        const shift = (minDist - sd) / 2;
        a.x -= nx * shift; a.y -= ny * shift;
        b.x += nx * shift; b.y += ny * shift;
        const closing = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny; // cancel velocity toward each other
        if (closing < 0) {
          a.vx += nx * closing / 2; a.vy += ny * closing / 2;
          b.vx -= nx * closing / 2; b.vy -= ny * closing / 2;
        }
      }
    }
  }
}

// where the next health orb will appear: on the ring around the player, tracking the player
const regenSpot = () => ({
  x: player.x + Math.cos(regen.angle) * ORBIT.radius,
  y: player.y + Math.sin(regen.angle) * ORBIT.radius,
});

// health point sprite, centered, `r` = half its drawn size (falls back to a circle until the image loads)
function drawHeart(x, y, r) {
  if (r < 0.5) return;
  if (heartImg.complete && heartImg.naturalWidth) {
    ctx.drawImage(heartImg, x - r, y - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = COLOR.orb;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawRegenBurst() {
  const p = regen.t / REGEN_ANIM; // 0..1
  const c = regenSpot();

  // heart swelling in the middle
  drawHeart(c.x, c.y, ORBIT.r * p);

  // short lines flying outward
  ctx.strokeStyle = COLOR.purple;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.globalAlpha = 1 - p * 0.7;
  const inner = 8 + 16 * p, outer = inner + 9;
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = regen.angle + (k / 8) * Math.PI * 2;
    ctx.moveTo(c.x + Math.cos(a) * inner, c.y + Math.sin(a) * inner);
    ctx.lineTo(c.x + Math.cos(a) * outer, c.y + Math.sin(a) * outer);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineCap = 'butt';
}

// Draws the boss's sprite with its visible part `h` tall, centered on (x, y); `flash` overlays a white silhouette.
// Returns false when the boss has no (loaded) sprite, so the caller can draw the placeholder oval.
const BOSS_SPRITE_H = 230;
const bossFlashCanvas = document.createElement('canvas');
const drawBossSprite = (x, y, h, flash = false) => drawSprite(boss.img, boss.box, x, y, h, flash);
function drawSprite(img, box, x, y, h, flash = false) {
  if (!(img && img.complete && img.naturalWidth)) return false;
  const s = h / box.h, w = img.naturalWidth * s, fullH = img.naturalHeight * s;
  const dx = x - box.cx * s, dy = y - box.cy * s;
  ctx.drawImage(img, dx, dy, w, fullH);
  if (flash) {
    const c = bossFlashCanvas, cc = c.getContext('2d');
    c.width = Math.ceil(w);
    c.height = Math.ceil(fullH);
    cc.drawImage(img, 0, 0, w, fullH);
    cc.globalCompositeOperation = 'source-atop';
    cc.fillStyle = COLOR.white;
    cc.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(c, dx, dy);
  }
  return true;
}

// DEBUG: song time next to the top progress bar, as m:ss.ss / total (turn off with DEBUG_TIME = false)
const DEBUG_TIME = true;
const DEBUG_KEYS = true; // Y = spawn a spinner
const clock = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
function drawDebugTime() {
  if (!DEBUG_TIME) return;
  ctx.font = 'bold 14px Fredoka, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLOR.muted;
  ctx.fillText(`${clock(elapsed)} / ${clock(songLength())}`, BAR.x + BAR.w + 14, BAR.y);
}

// the song progress bar: |-------■------| with the drop diamonds; `scale` sizes the caps, diamonds and marker
function drawProgressBar(x, y, w, scale) {
  const capH = BAR.capH * scale;
  ctx.strokeStyle = COLOR.track;
  ctx.lineWidth = 2 * scale;
  ctx.beginPath();
  ctx.moveTo(x, y - capH / 2); ctx.lineTo(x, y + capH / 2);
  ctx.moveTo(x + w, y - capH / 2); ctx.lineTo(x + w, y + capH / 2);
  ctx.moveTo(x, y); ctx.lineTo(x + w, y);
  ctx.stroke();
  drawDropMarkers(x, y, w, 5 * scale);
  const m = 5 * scale, markX = x + w * (elapsed / songLength());
  ctx.fillStyle = COLOR.purple;
  ctx.fillRect(markX - m, y - m, m * 2, m * 2);
}

// the arena: everything that shakes and rolls with the camera
function drawFight() {
  drawBeams();
  drawSpinner();

  // bombs: mud balls flashing red faster and faster (drawn before the boss so they emerge from behind it)
  for (const b of bombs) drawTrail(b, BOMB.r);
  for (const b of bombs) drawMudBall(b.x, b.y, BOMB.r, b.angle, (Math.sin(b.phase * Math.PI * 2) + 1) / 2);

  // projectiles: mud balls, trail streaming behind them
  for (const s of shots) drawTrail(s, SHOT.r);
  for (const s of shots) drawMudBall(s.x, s.y, SHOT.r, Math.atan2(s.vy, s.vx));

  // boss (shakes and flashes white when a prompt lands; trembles and glows while charging up for a drop)
  const hit = boss.shakeT > 0;
  const drop = fightState === 'playing' ? currentDrop() : null;
  const charge = drop && elapsed >= drop.break ? (elapsed - drop.break) / (drop.drop - drop.break) : 0;
  let bossX = boss.x + (hit ? Math.sin(boss.shakeT * 90) * 8 : 0), bossY = boss.y;
  if (charge > 0) {
    bossX += (Math.random() * 2 - 1) * (1 + 5 * charge);
    bossY += (Math.random() * 2 - 1) * (1 + 5 * charge);
  }
  ctx.save();
  if (charge > 0) {
    ctx.shadowColor = COLOR.white;
    ctx.shadowBlur = 10 + 40 * charge;
  }
  const flash = hit && Math.floor(boss.shakeT * 20) % 2 === 0;
  ctx.globalAlpha = boss.alpha;
  // beat rocking, plus a hop + swell on bass kicks, about the boss's center
  ctx.translate(bossX, bossY - BOSS_HOP * boss.pulse);
  ctx.rotate(boss.rock);
  ctx.scale((1 + 0.05 * boss.pulse) * (1 + boss.squish), (1 + 0.05 * boss.pulse) * (1 - boss.squish));
  bossX = bossY = 0;
  if (!drawBossSprite(bossX, bossY, BOSS_SPRITE_H, flash)) {
    ctx.fillStyle = flash ? COLOR.white : boss.color;
    ctx.beginPath();
    ctx.ellipse(bossX, bossY, boss.rx, boss.ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // player (hitbox is a circle of radius player.r fitted to the sprite)
  // thrusters follow the vertical keys: W = up sprite, S = down sprite, otherwise idle
  const up = keys.has('KeyW'), down = keys.has('KeyS');
  const catImg = fightState === 'playing' && up !== down ? catImgs[up ? 'up' : 'down'] : catImgs.idle;
  if (catImg.complete && catImg.naturalWidth) {
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.tilt);
    const hurt = player.invuln > 0;
    const blink = hurt && Math.floor(player.invuln * 12) % 2 === 1 ? 0.35 : 1;
    ctx.globalAlpha = blink;
    ctx.drawImage(catImg, -CAT_SIZE / 2, -CAT_SIZE / 2, CAT_SIZE, CAT_SIZE);
    if (hurt) {
      // red copy of the sprite (opaque pixels only), strongest right after the hit and fading with the invulnerability
      tintCtx.globalCompositeOperation = 'copy';
      tintCtx.drawImage(catImg, 0, 0, CAT_SIZE, CAT_SIZE);
      tintCtx.globalCompositeOperation = 'source-atop';
      tintCtx.fillStyle = '#ff2d2d';
      tintCtx.fillRect(0, 0, CAT_SIZE, CAT_SIZE);
      ctx.globalAlpha = blink * 0.75 * (player.invuln / HIT.invuln);
      ctx.drawImage(tintCanvas, -CAT_SIZE / 2, -CAT_SIZE / 2);
    }
    ctx.restore();
  } else {
    ctx.fillStyle = COLOR.ink;
    ctx.beginPath();
    ctx.arc(player.x, player.y, player.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // health orbs
  for (let i = 0; i < health.hp; i++) drawHeart(orbs[i].x, orbs[i].y, ORBIT.r);
  if (regen) drawRegenBurst();
}

// the HUD stays steady on top of the arena
function drawFightHud() {
  drawProgressBar(BAR.x, BAR.y, BAR.w, 1); // |-------■------|
  drawDebugTime();
  drawHud();
  if (callout) drawCallout();
  if (typing) drawPrompt();
}

// drops on a progress line: the build-up is a brighter stretch of the line ending in a diamond right at the drop.
// Diamonds are hollow until the song reaches them, then fill in.
function drawDropMarkers(x, y, w, size) {
  if (!beatmap) return;
  const len = songLength();
  ctx.save();
  for (const d of beatmap.drops) {
    const x0 = x + w * Math.min(1, d.build / len), x1 = x + w * Math.min(1, d.drop / len);
    ctx.strokeStyle = UI.soft;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x0, y); ctx.lineTo(x1, y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x1, y - size); ctx.lineTo(x1 + size, y); ctx.lineTo(x1, y + size); ctx.lineTo(x1 - size, y);
    ctx.closePath();
    ctx.fillStyle = elapsed >= d.drop ? UI.pink : COLOR.white;
    ctx.fill();
    ctx.strokeStyle = COLOR.ink;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}

// mud ball sprite: its round body is `r` (hitbox radius) across the middle, turned to face `heading` (its trail is drawn
// separately, see drawTrail);
// `red` (0..1) washes it red, for bombs about to burst. Falls back to a plain brown circle until the image loads.
const mudImg = Object.assign(new Image(), { src: 'assets/mud_ball.png' });
const MUD_BALL = { cx: 65.5, cy: 61, d: 78 }; // where the ball sits in the 128x128 image
const MUD_BALL_SIZE = 1.15; // body drawn slightly bigger than the hitbox since its edge is soft
let mudRed = null;           // red-tinted copy of the sprite, made once
function drawMudBall(x, y, r, heading = Math.PI, red = 0) {
  if (!(mudImg.complete && mudImg.naturalWidth)) {
    ctx.fillStyle = MUD.mid;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (!mudRed) {
    mudRed = document.createElement('canvas');
    mudRed.width = mudImg.naturalWidth;
    mudRed.height = mudImg.naturalHeight;
    const c = mudRed.getContext('2d');
    c.drawImage(mudImg, 0, 0);
    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = '#ff2a1a';
    c.fillRect(0, 0, mudRed.width, mudRed.height);
  }
  const s = (2 * r * MUD_BALL_SIZE) / MUD_BALL.d;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading);
  ctx.scale(s, s);
  ctx.drawImage(mudImg, -MUD_BALL.cx, -MUD_BALL.cy);
  if (red > 0) {
    ctx.globalAlpha = red * 0.85;
    ctx.drawImage(mudRed, -MUD_BALL.cx, -MUD_BALL.cy);
  }
  ctx.restore();
}

function drawBeams() {
  const H = canvas.height;
  for (const b of beams) {
    const x0 = b.x - BEAM.w / 2;
    if (b.t < BEAM.charge) {
      // warning: dashed outline of the column, filling in and pulsing faster as it charges
      const p = b.t / BEAM.charge;
      ctx.fillStyle = MUD.mid;
      ctx.globalAlpha = 0.06 + 0.12 * p;
      ctx.fillRect(x0, 0, BEAM.w, H);
      ctx.globalAlpha = 0.5 + 0.4 * Math.sin(b.t * (10 + 20 * p));
      ctx.strokeStyle = MUD.deep;
      ctx.lineWidth = 2;
      ctx.setLineDash([12, 8]);
      ctx.strokeRect(x0, 1, BEAM.w, H - 2);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    } else {
      // live beam: dark mud edges, lighter core, swept across the column almost instantly
      const p = Math.min(1, (b.t - BEAM.charge) / BEAM.sweep);
      const g = ctx.createLinearGradient(x0, 0, x0 + BEAM.w, 0);
      g.addColorStop(0, MUD.deep);
      g.addColorStop(0.5, MUD.pale);
      g.addColorStop(1, MUD.deep);
      ctx.save();
      ctx.shadowColor = MUD.mid;
      ctx.shadowBlur = 20;
      ctx.fillStyle = g;
      ctx.fillRect(x0, b.dir === 1 ? 0 : H * (1 - p), BEAM.w, H * p);
      ctx.restore();
    }
  }

  // dissipating sparks
  for (const s of sparks) {
    ctx.globalAlpha = 0.9 * Math.pow(1 - s.age / s.life, 0.6);
    ctx.fillStyle = s.color;
    ctx.fillRect(s.x - s.size / 2, s.y - s.size / 2, s.size, s.size);
  }
  ctx.globalAlpha = 1;
}

function drawSpinner() {
  const s = spinner;
  if (!s) return;
  const lt = s.t - SPINNER.fuse;

  if (lt >= 0) {
    // spinning laser: dark mud edges, lighter core, fades in
    const W = SPINNER.width;
    const g = ctx.createLinearGradient(0, -W / 2, 0, W / 2);
    g.addColorStop(0, MUD.deep);
    g.addColorStop(0.5, MUD.pale);
    g.addColorStop(1, MUD.deep);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.angle);
    ctx.globalAlpha = Math.min(1, lt / SPINNER.fadeIn);
    ctx.shadowColor = MUD.mid;
    ctx.shadowBlur = 20;
    ctx.fillStyle = g;
    ctx.fillRect(s.doubleSided ? -SPINNER.length : 0, -W / 2, SPINNER.length * (s.doubleSided ? 2 : 1), W);
    ctx.restore();
  }

  // mud orb with a white center that flashes red (solid red once the laser is out)
  const glow = lt >= 0 ? 1 : (Math.sin(s.phase * Math.PI * 2) + 1) / 2;
  const gb = Math.round(255 * (1 - glow));
  ctx.fillStyle = MUD.mid;
  ctx.beginPath();
  ctx.arc(s.x, s.y, SPINNER.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = MUD.dark;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = `rgb(255, ${gb}, ${gb})`;
  ctx.beginPath();
  ctx.arc(s.x, s.y, SPINNER.coreR, 0, Math.PI * 2);
  ctx.fill();
}

function drawHud() {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = 'bold 24px Fredoka, sans-serif';
  ctx.fillStyle = COLOR.ink;
  ctx.fillText(`Points ${score}`, 24, 20);
  if (combo > 0) {
    ctx.fillStyle = COLOR.purple;
    ctx.fillText(`Combo x${combo}`, 24, 52);
  }
  if (comboBreakFx) drawComboBreak();
}

// combo text: flashes for CALLOUT.flash seconds, then fades out
function drawCallout() {
  const t = callout.t;
  const pop = 1 + Math.max(0, 0.25 - t) * 2; // brief scale-in
  ctx.save();
  ctx.globalAlpha = t < CALLOUT.flash ? 1 : 1 - (t - CALLOUT.flash) / CALLOUT.fade;
  ctx.translate(canvas.width / 2, 100);
  ctx.scale(pop, pop);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 64px Fredoka, sans-serif';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 8;
  ctx.strokeStyle = COLOR.ink;
  ctx.strokeText(callout.text, 0, 0);
  ctx.fillStyle = Math.floor(t * 8) % 2 === 0 ? COLOR.purple : COLOR.white;
  ctx.fillText(callout.text, 0, 0);
  ctx.restore();
}

// typing prompt: one box per character, timer bar underneath
function drawPrompt() {
  const boxW = 56, boxH = 64, gap = 10, n = typing.chars.length;
  const w = n * boxW + (n - 1) * gap;
  const err = typing.errorT > 0;
  const flash = err && Math.floor(typing.errorT * 24) % 2 === 0;
  const x0 = (canvas.width - w) / 2 + (err ? Math.sin(typing.errorT * 90) * 6 : 0);
  const y0 = 420;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 36px Fredoka, sans-serif';
  for (let i = 0; i < n; i++) {
    const x = x0 + i * (boxW + gap);
    const done = i < typing.typed, cur = i === typing.typed;
    ctx.fillStyle = err ? (flash ? '#ff9a9a' : '#ffe3e3') : done ? COLOR.lavender : COLOR.white;
    ctx.fillRect(x, y0, boxW, boxH);
    ctx.strokeStyle = err ? '#e53935' : cur || done ? COLOR.purple : COLOR.track;
    ctx.lineWidth = cur && !err ? 4 : 2;
    ctx.strokeRect(x, y0, boxW, boxH);
    ctx.fillStyle = err ? '#c62828' : done ? COLOR.muted : COLOR.ink;
    ctx.fillText(typing.chars[i], x + boxW / 2, y0 + boxH / 2 + 2);
  }

  const by = y0 + boxH + 12;
  ctx.fillStyle = COLOR.lavender;
  ctx.fillRect(x0, by, w, 8);
  ctx.fillStyle = err ? '#e53935' : COLOR.purple;
  ctx.fillRect(x0, by, w * (1 - typing.t / PROMPT.time), 8);
}

// ---- menus: 'title' -> 'select' -> 'fight' ----
let scene = 'title';
let sel = 0; // selected banner on the select screen
const mouse = { x: -1, y: -1 };

// settings / achievements pages open on top of whatever screen is showing (so the paused fight stays paused underneath)
let page = null; // null | 'settings' | 'achievements'

// ---- round icon buttons: a big middle button with 15% smaller ones on either side ----
const iconImg = src => Object.assign(new Image(), { src });
const ICONS = {
  play: iconImg('assets/play.png'),
  settings: iconImg('assets/settings.png'),
  achievements: iconImg('assets/achievements.png'),
  lobby: iconImg('assets/lobby.png'),
  back: iconImg('assets/back.png'),
};
const ICON_CIRCLE = { cx: 446.5, cy: 434, d: 674 }; // where the drawn circle sits inside each 900x900 icon image
const SIDE_SCALE = 0.85;

// a centered row of round buttons; `specs` are { icon, big, action }, laid out left to right
function roundButtonRow(cy, bigD, gap, specs) {
  const ds = specs.map(s => (s.big ? bigD : bigD * SIDE_SCALE));
  let x = canvas.width / 2 - (ds.reduce((a, b) => a + b, 0) + gap * (specs.length - 1)) / 2;
  return specs.map((s, i) => {
    const b = { ...s, d: ds[i], x: x + ds[i] / 2, y: cy, grow: 0 };
    x += ds[i] + gap;
    return b;
  });
}
const roundButtonAt = (list, p) => list.find(b => Math.hypot(p.x - b.x, p.y - b.y) <= b.d / 2);

// buttons ease up in size while hovered
// (`active` = false while an on-top page covers these buttons)
function updateRoundButtons(list, dt, active = !page) {
  const hovered = active ? roundButtonAt(list, mouse) : null;
  const k = 1 - Math.exp(-16 * dt);
  for (const b of list) b.grow += ((b === hovered ? 1 : 0) - b.grow) * k;
}

function drawRoundButton(b) {
  const img = ICONS[b.icon];
  const grow = 1 + 0.08 * b.grow;
  // scale the image so its circle is b.d across and centered on the button
  const s = (b.d / ICON_CIRCLE.d) * grow;
  if (img.complete && img.naturalWidth) {
    ctx.drawImage(img, b.x - ICON_CIRCLE.cx * s, b.y - ICON_CIRCLE.cy * s, img.naturalWidth * s, img.naturalHeight * s);
  }
}

const TITLE_BUTTONS = roundButtonRow(390, 130, 30, [
  { icon: 'settings', action: () => { page = 'settings'; } },
  { icon: 'play', big: true, action: () => { scene = 'select'; } },
  { icon: 'achievements', action: () => { page = 'achievements'; } },
]);
const BANNER = { w: 200, h: 320, gap: 60, y: 110, point: 0.72 }; // point: where the bottom taper starts
// boss 1 is centered; bosses 2 and 3 flank it on the left and right, a little higher
const BANNER_SLOTS = [
  { dx: 0, dy: 0 },
  { dx: -(BANNER.w + BANNER.gap), dy: -30 },
  { dx: BANNER.w + BANNER.gap, dy: -30 },
];
const bannerPos = i => ({
  x: (canvas.width - BANNER.w) / 2 + BANNER_SLOTS[i].dx,
  y: BANNER.y + BANNER_SLOTS[i].dy,
});

// upside-down house: flat top, straight sides, point at the bottom
function bannerPath(x, y) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + BANNER.w, y);
  ctx.lineTo(x + BANNER.w, y + BANNER.h * BANNER.point);
  ctx.lineTo(x + BANNER.w / 2, y + BANNER.h);
  ctx.lineTo(x, y + BANNER.h * BANNER.point);
  ctx.closePath();
}

const inRect = (r, p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
// index of the banner under the point (locked ones included, so they can still react to hover), or -1
const bannerUnder = p => BOSSES.findIndex((_, i) => inRect({ ...bannerPos(i), w: BANNER.w, h: BANNER.h }, p));
// same, but only playable banners can be picked
const bannerAt = p => {
  const i = bannerUnder(p);
  return i >= 0 && !BOSSES[i].locked ? i : -1;
};

// move the selection to the next unlocked banner in a direction (+1 / -1)
function stepSel(dir) {
  for (let n = 1; n <= BOSSES.length; n++) {
    const i = (sel + dir * n + BOSSES.length * n) % BOSSES.length;
    if (!BOSSES[i].locked) { sel = i; return; }
  }
}

function onKey(code) {
  const confirm = code === 'Enter' || code === 'Space';
  if (page === 'settings') {
    if (code === 'KeyW' || code === 'KeyS') selSlider = (selSlider + 1) % SLIDERS.length;
    else if (code === 'KeyA' || code === 'KeyD') {
      const k = SLIDERS[selSlider].key;
      settings[k] = Math.round(Math.min(1, Math.max(0, settings[k] + (code === 'KeyD' ? 0.05 : -0.05))) * 100) / 100;
      saveSettings();
    } else if (confirm || code === 'Escape') page = null;
  } else if (page === 'achievements') {
    if (confirm || code === 'Escape') page = null;
  } else if (scene === 'title') {
    if (confirm) scene = 'select';
  } else if (scene === 'select') {
    if (code === 'KeyA') stepSel(-1);
    else if (code === 'KeyD') stepSel(1);
    else if (confirm) startFight(sel);
    else if (code === 'Escape') scene = 'title';
  } else if (scene === 'fight') {
    if (code === 'Escape' && fightState === 'playing') fightState = 'paused';
    else if (code === 'Escape' && fightState === 'paused') fightState = 'playing';
    else if (confirm && overlayVisible()) activateOverlayButton();
    else if (fightState === 'playing') {
      if (DEBUG_KEYS && code === 'KeyY') launchSpinner(); // DEBUG: spawn a spinner (still types Y into a prompt too)
      typePromptKey(code);
    }
  }
}

// Enter/Space press the primary button: play when paused, lobby after a win or loss
function activateOverlayButton() {
  const list = overlayButtons();
  (list.find(b => b.primary) ?? list[0]).action();
}

function mousePos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
}
canvas.addEventListener('mousedown', e => {
  Object.assign(mouse, mousePos(e));
  if (page === 'settings') {
    dragSlider = sliderAt(mouse);
    if (dragSlider) { selSlider = SLIDERS.indexOf(dragSlider); setSliderFromMouse(dragSlider); }
  }
});
addEventListener('mouseup', () => {
  if (dragSlider) saveSettings();
  dragSlider = null;
});
canvas.addEventListener('mousemove', e => {
  Object.assign(mouse, mousePos(e));
  if (dragSlider) setSliderFromMouse(dragSlider);
  if (scene === 'select') {
    const i = bannerAt(mouse);
    if (i >= 0) sel = i;
  }
});
canvas.addEventListener('click', e => {
  Object.assign(mouse, mousePos(e));
  if (page) {
    roundButtonAt(MENU_BACK, mouse)?.action();
  } else if (scene === 'title') roundButtonAt(TITLE_BUTTONS, mouse)?.action();
  else if (scene === 'select') {
    const i = bannerAt(mouse);
    if (i >= 0) startFight(sel = i);
  } else if (scene === 'fight' && overlayVisible()) {
    roundButtonAt(overlayButtons(), mouse)?.action();
  }
});

function drawTitle() {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (titleImg.complete && titleImg.naturalWidth) {
    // 16:9 image scaled about the wordmark's center, so it stays centered above the PLAY button
    const w = canvas.width * TITLE.scale, h = canvas.height * TITLE.scale;
    ctx.drawImage(titleImg, (canvas.width - w) / 2, TITLE.centerY - TITLE.wordmarkY * TITLE.scale, w, h);
  } else {
    ctx.fillStyle = COLOR.purple;
    ctx.font = 'bold 130px Fredoka, sans-serif';
    ctx.fillText('AstroCat', canvas.width / 2, 200);
  }

  for (const b of TITLE_BUTTONS) drawRoundButton(b);
}

function roundRectPath(x, y, w, h, rad) {
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

// chunky pill button in the title's colors: plum outline, purple face, pink highlight, cream lettering
function drawButton(r, label) {
  const hot = inRect(r, mouse);
  const lift = hot ? 4 : 0;          // hovered buttons rise off their base
  const rad = r.h / 2;
  const y = r.y - lift;

  ctx.save();
  ctx.lineJoin = 'round';

  // base / drop lip
  roundRectPath(r.x, r.y + 5, r.w, r.h, rad);
  ctx.fillStyle = '#3a0f2c';
  ctx.fill();

  // face, with a soft glow when hovered
  roundRectPath(r.x, y, r.w, r.h, rad);
  const g = ctx.createLinearGradient(0, y, 0, y + r.h);
  g.addColorStop(0, hot ? '#d88bc2' : '#b9689f');
  g.addColorStop(1, hot ? '#a85d95' : '#8a4a7a');
  ctx.shadowColor = hot ? '#e6a8d6' : 'transparent';
  ctx.shadowBlur = hot ? 18 : 0;
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#5c1a45';
  ctx.stroke();

  // glossy highlight along the top
  roundRectPath(r.x + 12, y + 7, r.w - 24, r.h * 0.32, r.h * 0.16);
  ctx.fillStyle = 'rgba(248, 208, 232, 0.35)';
  ctx.fill();

  // lettering: cream with a plum outline, like the wordmark
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 34px Fredoka, sans-serif';
  ctx.lineWidth = 7;
  ctx.strokeStyle = '#5c1a45';
  ctx.strokeText(label, r.x + r.w / 2, y + r.h / 2 + 2);
  ctx.fillStyle = '#fdeaf5';
  ctx.fillText(label, r.x + r.w / 2, y + r.h / 2 + 2);
  ctx.restore();
}

// pause / win / lose panel drawn over the frozen fight
const PANEL = { w: 460, h: 450, x: (canvas.width - 460) / 2, y: 45 };
// the win panel is taller to make room for the star row
const PANEL_WIN = { w: 460, h: 510, x: (canvas.width - 460) / 2, y: 15 };
const resumeFight = () => { fightState = 'playing'; };
const goLobby = () => { scene = 'title'; saveStats(); };
const PANEL_BTN_D = 110; // play button size on the panels; the side buttons are 15% smaller
const PAUSE_BUTTONS = roundButtonRow(PANEL.y + 355, PANEL_BTN_D, 25, [
  { icon: 'settings', action: () => { page = 'settings'; } },
  { icon: 'play', big: true, primary: true, action: resumeFight },
  { icon: 'lobby', action: goLobby },
]);
// win and lose panels: just the lobby button, at the side-button size
const lobbyOnly = y => roundButtonRow(y, PANEL_BTN_D, 0, [{ icon: 'lobby', primary: true, action: goLobby }]);
const END_BUTTONS = lobbyOnly(PANEL.y + 360); // clear of the bottom border, even while hover-grown
const WIN_BUTTONS = lobbyOnly(PANEL_WIN.y + 435); // just under the stars, clear of the panel's bottom border
const overlayButtons = () => fightState === 'paused' ? PAUSE_BUTTONS : fightState === 'won' ? WIN_BUTTONS : END_BUTTONS;

// 5-point star centered at (cx, cy) with outer radius R
function starPath(cx, cy, R) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? R : R * 0.45;
    ctx[i === 0 ? 'moveTo' : 'lineTo'](cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  }
  ctx.closePath();
}

// static row of three stars, the first `filled` of them lit
function drawStarRow(cx, cy, R, spacing, filled) {
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  for (let i = 0; i < 3; i++) {
    starPath(cx + (i - 1) * spacing, cy, R);
    ctx.fillStyle = i < filled ? UI.band : UI.pink;
    ctx.fill();
    ctx.strokeStyle = i < filled ? UI.plum : UI.soft;
    ctx.stroke();
  }
  ctx.lineJoin = 'miter';
}

// three slots; each earned star fills in left to right, `t` = seconds since the panel appeared
const easeOutBack = p => 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2);
function drawStars(cx, cy, t) {
  const R = 24, spacing = 64;
  for (let i = 0; i < 3; i++) {
    const x = cx + (i - 1) * spacing;
    starPath(x, cy, R);
    ctx.fillStyle = UI.pink;
    ctx.fill();
    ctx.strokeStyle = UI.soft;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.stroke();

    const p = Math.max(0, Math.min(1, (t - (0.35 + i * 0.55)) / 0.4));
    if (winStars[i] && p > 0) {
      const s = easeOutBack(p);
      ctx.save();
      ctx.translate(x, cy);
      ctx.scale(s, s);
      starPath(0, 0, R);
      ctx.fillStyle = UI.band;
      ctx.fill();
      ctx.strokeStyle = UI.plum;
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.restore();
    }
    ctx.lineJoin = 'miter';
  }
}

// ---- themed panels: built like the icon buttons (plum rim, purple band, soft pink face) with a bubbly title ----
const UI = {
  plum: '#5c1a45', lip: '#3a0f2c', band: '#9c5489', pink: '#f2c4e0',
  face: '#fdf0f7', line: '#e8bfd9', soft: '#b77aa6',
};

function drawThemePanel(P, title) {
  ctx.save();
  ctx.fillStyle = 'rgba(28, 8, 24, 0.55)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  roundRectPath(P.x, P.y + 8, P.w, P.h, 30); // drop lip, like the buttons
  ctx.fillStyle = UI.lip;
  ctx.fill();
  roundRectPath(P.x, P.y, P.w, P.h, 30);
  ctx.fillStyle = UI.plum;
  ctx.fill();
  roundRectPath(P.x + 7, P.y + 7, P.w - 14, P.h - 14, 24);
  ctx.fillStyle = UI.band;
  ctx.fill();
  roundRectPath(P.x + 17, P.y + 17, P.w - 34, P.h - 34, 16);
  ctx.fillStyle = UI.face;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = UI.plum;
  ctx.stroke();

  // little highlight dots on the band, echoing the dots on the icons
  ctx.fillStyle = UI.pink;
  for (const [dx, dy] of [[14, 14], [P.w - 14, 14], [14, P.h - 14], [P.w - 14, P.h - 14]]) {
    ctx.beginPath();
    ctx.arc(P.x + dx, P.y + dy, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  drawBubbleText(title, canvas.width / 2, P.y + 58, 40, P.w - 130);
}

// purple letters with a thick plum outline, like the title wordmark (shrunk to fit `maxW` if needed)
function drawBubbleText(text, x, y, size, maxW = Infinity) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${size}px Fredoka, sans-serif`;
  const w = ctx.measureText(text).width * 1.1; // room for the outline
  if (w > maxW) {
    size *= maxW / w;
    ctx.font = `bold ${size}px Fredoka, sans-serif`;
  }
  ctx.lineJoin = 'round';
  ctx.lineWidth = size * 0.22;
  ctx.strokeStyle = UI.plum;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = UI.band;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawOverlay() {
  const won = fightState === 'won';
  const P = won ? PANEL_WIN : PANEL;
  const cx = canvas.width / 2;
  const progress = elapsed / songLength();

  drawThemePanel(P, won ? 'Boss scared away!' : fightState === 'lost' ? 'Defeated!' : 'Paused');

  // boss portrait + name
  if (!drawBossSprite(cx, P.y + 128, 88)) {
    ctx.fillStyle = boss.color;
    ctx.beginPath();
    ctx.ellipse(cx, P.y + 128, 28, 38, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = UI.plum;
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = UI.plum;
  ctx.font = 'bold 28px Fredoka, sans-serif';
  ctx.fillText(boss.name, cx, P.y + 190);

  // progress: the same |-------■------| bar as the top of the screen, just bigger
  const bw = 320, bx = cx - bw / 2, by = P.y + 228;
  drawProgressBar(bx, by, bw, 1.4);
  ctx.fillStyle = UI.soft;
  ctx.font = 'bold 22px Fredoka, sans-serif';
  ctx.fillText(`${Math.floor(progress * 100)}%`, cx, by + 32);

  if (won) {
    ctx.fillStyle = UI.band;
    ctx.font = 'bold 28px Fredoka, sans-serif';
    ctx.fillText(`Points: ${score} (x${maxCombo} Combo)`, cx, P.y + 300);
    drawStars(cx, P.y + 358, endTimer - END_DELAY);
  }

  for (const b of overlayButtons()) drawRoundButton(b);
}

// banners glide up when hovered and settle back down when not
const BANNER_LIFT = 12;
const bannerLift = BOSSES.map(() => 0);
function updateSelect(dt) {
  const hovered = bannerUnder(mouse);
  const k = 1 - Math.exp(-18 * dt);
  BOSSES.forEach((_, i) => {
    bannerLift[i] += ((i === hovered ? BANNER_LIFT : 0) - bannerLift[i]) * k;
  });
}

function drawSelect() {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLOR.lavender;
  ctx.font = 'bold 28px Fredoka, sans-serif';
  ctx.fillText('Save the world!', canvas.width / 2, 55);

  const hovered = bannerUnder(mouse);
  BOSSES.forEach((b, i) => {
    const active = i === hovered; // dark outline (and lift) only while hovered, for every banner
    const pos = bannerPos(i);
    const x = pos.x, y = pos.y - bannerLift[i]; // lift is animated, and only from hovering (locked ones too)
    bannerPath(x, y);
    // locked bosses are grayed out
    ctx.fillStyle = b.locked ? '#d9d5e3' : b.color;
    ctx.globalAlpha = b.locked ? 0.8 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = active ? COLOR.ink : COLOR.track;
    ctx.lineWidth = active ? 5 : 3;
    ctx.stroke();

    // bosses with art show it on their banner, with the number moved up top; the rest keep the big number
    const art = !b.locked && b.img;
    const numY = y + BANNER.h * (art ? 0.13 : 0.4);
    ctx.font = `bold ${art ? 40 : 72}px Fredoka, sans-serif`;
    ctx.lineWidth = art ? 5 : 6;
    ctx.strokeStyle = b.locked ? COLOR.track : COLOR.ink;
    ctx.strokeText(String(i + 1), x + BANNER.w / 2, numY);
    ctx.fillStyle = COLOR.white;
    ctx.fillText(String(i + 1), x + BANNER.w / 2, numY);
    if (art) drawSprite(b.img, b.spriteBox, x + BANNER.w / 2, y + BANNER.h * 0.49, 150);

    if (b.locked) {
      ctx.fillStyle = COLOR.muted;
      ctx.font = 'bold 20px Fredoka, sans-serif';
      ctx.fillText('Coming soon', x + BANNER.w / 2, y + BANNER.h * 0.62);
    } else {
      // best stars earned against this boss, empty slots included
      drawStarRow(x + BANNER.w / 2, pos.y + BANNER.h + 40, 14, 38, bestStars[i]);
    }
  });
}

// ---- settings and achievements pages (opened from the title screen) ----
const MENU_PANEL = { w: 520, h: 450, x: (canvas.width - 520) / 2, y: 45 };
const MENU_BACK = roundButtonRow(MENU_PANEL.y + MENU_PANEL.h - 80, // clear of the bottom border, even while hover-grown
  PANEL_BTN_D, 0, [{ icon: 'back', action: () => { page = null; } }]);

function drawMenuPanel(title) {
  drawThemePanel(MENU_PANEL, title);
  for (const b of MENU_BACK) drawRoundButton(b);
}

// volume sliders: drag with the mouse, or W/S to pick one and A/D to adjust
const SLIDERS = [{ key: 'music', label: 'Music' }, { key: 'sfx', label: 'Sound effects' }].map((s, i) => ({
  ...s,
  x0: MENU_PANEL.x + 60, x1: MENU_PANEL.x + MENU_PANEL.w - 60, y: MENU_PANEL.y + 170 + i * 95,
}));
let selSlider = 0;
let dragSlider = null;
const sliderAt = p => SLIDERS.find(s => p.x >= s.x0 - 14 && p.x <= s.x1 + 14 && Math.abs(p.y - s.y) <= 18);
function setSliderFromMouse(s) {
  settings[s.key] = Math.round(Math.min(1, Math.max(0, (mouse.x - s.x0) / (s.x1 - s.x0))) * 100) / 100;
}

function drawSettings() {
  drawMenuPanel('Settings');
  SLIDERS.forEach((s, i) => {
    const v = settings[s.key], focused = i === selSlider;
    ctx.font = 'bold 24px Fredoka, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = focused ? UI.band : UI.plum;
    ctx.fillText(s.label, s.x0, s.y - 34);
    ctx.textAlign = 'right';
    ctx.fillStyle = UI.soft;
    ctx.fillText(`${Math.round(v * 100)}%`, s.x1, s.y - 34);

    // pill track in the panel's colors, filled purple up to the value
    roundRectPath(s.x0, s.y - 7, s.x1 - s.x0, 14, 7);
    ctx.fillStyle = UI.pink;
    ctx.fill();
    if (v > 0) {
      ctx.save();
      roundRectPath(s.x0, s.y - 7, s.x1 - s.x0, 14, 7);
      ctx.clip();
      ctx.fillStyle = UI.band;
      ctx.fillRect(s.x0, s.y - 7, (s.x1 - s.x0) * v, 14);
      ctx.restore();
    }
    roundRectPath(s.x0, s.y - 7, s.x1 - s.x0, 14, 7);
    ctx.lineWidth = 3;
    ctx.strokeStyle = UI.plum;
    ctx.stroke();

    // knob: a little version of the round buttons
    const kx = s.x0 + (s.x1 - s.x0) * v, kr = focused ? 16 : 14;
    ctx.beginPath();
    ctx.arc(kx, s.y, kr, 0, Math.PI * 2);
    ctx.fillStyle = UI.plum;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(kx, s.y, kr * 0.72, 0, Math.PI * 2);
    ctx.fillStyle = UI.pink;
    ctx.fill();
  });
}

const formatTime = secs => {
  const s = Math.floor(secs), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${r}s` : `${r}s`;
};

function drawAchievements() {
  drawMenuPanel('Achievements');
  const starsEarned = bestStars.reduce((a, b) => a + b, 0);
  const rows = [
    ['Top combo', `x${stats.topCombo}`],
    ['Stars earned', `${starsEarned} / ${BOSSES.length * 3}`],
    ['Most points', String(stats.bestScore)],
    ['Time played', formatTime(stats.timePlayed)],
  ];
  const x0 = MENU_PANEL.x + 60, x1 = MENU_PANEL.x + MENU_PANEL.w - 60;
  ctx.font = 'bold 26px Fredoka, sans-serif';
  ctx.textBaseline = 'middle';
  rows.forEach(([label, value], i) => {
    const y = MENU_PANEL.y + 125 + i * 55;
    ctx.textAlign = 'left';
    ctx.fillStyle = UI.plum;
    ctx.fillText(label, x0, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = UI.band;
    ctx.fillText(value, x1, y);
    if (i < rows.length - 1) {
      roundRectPath(x0, y + 26, x1 - x0, 3, 1.5);
      ctx.fillStyle = UI.line;
      ctx.fill();
    }
  });
}

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05); // clamp after tab switches
  last = now;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!(scene === 'fight' && fightState === 'paused')) { // backgrounds freeze while paused
    updateBackground(dt);
    fightSkyScroll += FIGHT_BG.skySpeed * dt;
  }
  ctx.save();
  if (scene !== 'fight') drawBackground(); // menus get the scrolling space scene
  else {                                   // fights get their boss's backdrop, rolling with the camera
    applyCameraRoll();
    drawFightBackground();
  }
  ctx.restore();
  if (scene === 'title') { updateRoundButtons(TITLE_BUTTONS, dt); drawTitle(); }
  else if (scene === 'select') { updateSelect(dt); drawSelect(); }
  else {
    if (fightState !== 'paused') updateFight(dt);
    // screen shake after a hit, fading out (held still while paused)
    ctx.save();
    applyCameraRoll();
    if (screenShake > 0 && fightState !== 'paused') {
      const mag = HIT.shakeMag * (screenShake / HIT.shake);
      ctx.translate((Math.random() * 2 - 1) * mag, (Math.random() * 2 - 1) * mag);
    }
    drawFight();
    ctx.restore();
    drawFightHud();
    if (overlayVisible()) {
      updateRoundButtons(overlayButtons(), dt);
      drawOverlay();
    }
  }
  if (page) updateRoundButtons(MENU_BACK, dt, true);
  if (page === 'settings') drawSettings();
  else if (page === 'achievements') drawAchievements();
  syncMusic();
  canvas.style.cursor = scene === 'fight' && !overlayVisible() ? 'none' : 'default'; // no cursor while fighting
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
