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

const SONG_LENGTH = 30; // seconds, placeholder until real audio exists
const BAR = { w: (canvas.width - 80) / 4, y: 24, capH: 14 };
BAR.x = (canvas.width - BAR.w) / 2; // centered

const MAX_HP = 5;
const REGEN_INTERVAL = 5; // seconds per 1 hp (short for prototyping)
const REGEN_ANIM = 0.5;   // seconds of "lines burst outward" before the orb appears
const END_DELAY = 1.2;    // seconds of win/lose escape animation before the result panel

// boss attacks: a random one every SHOT.interval (placeholder scheduler until songs drive the patterns)
const SHOT = { interval: 1.2, speed: 280, r: 10 };
const BOMB = {
  r: 14,
  minDist: 120,                 // shortest throw; the longest reaches the arena edge along the chosen direction
  drag: 1.4,                    // bombs skid to a stop (travel = launch speed / drag)
  fuse: 2.2,                    // seconds until it explodes
  blastSpeed: 240,              // speed of the 8 projectiles it releases
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
};
let spinner = null; // { x, y, vx, vy, t, phase, firing, angle0, angle, dir, cool }
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
const catImgs = {};
for (const pose of ['idle', 'up', 'down']) {
  catImgs[pose] = new Image();
  catImgs[pose].src = `assets/cat_${pose}.png`;
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
const CAT_MAX_TILT = 20 * Math.PI / 180; // lean at full horizontal speed (right = clockwise)
const CAT_HITBOX = 0.43; // hitbox radius as a fraction of the size (the helmet fills ~86% of the image)

const player = { x: 200, y: canvas.height / 2, vx: 0, vy: 0, tilt: 0, r: CAT_SIZE * CAT_HITBOX, accel: 1600, friction: 6, maxSpeed: 320 };
const boss = { x: BOSS_HOME_X, y: canvas.height / 2, rx: 60, ry: 110, color: '#d65db1', name: '', shakeT: 0, ceaseT: 0 };
// placeholder names and colors, one per boss/song
const BOSSES = [
  { name: 'Sir Woofington', color: '#d65db1' },
  { name: 'Vacuum-9000', color: '#4f5bd5' },
  { name: 'Big Cucumber', color: '#e8a75d' },
];

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
let callout = null;    // { text, t } combo text on screen
let typing = null;     // { chars, typed, t, errorT } the active prompt
let promptTimer = 0;   // seconds until the next prompt appears

const fightEnded = () => fightState === 'won' || fightState === 'lost';
// pause panel shows immediately, win/lose panels wait for the escape animation
const overlayVisible = () => fightState === 'paused' || (fightEnded() && endTimer >= END_DELAY);

function startFight(bossIndex) {
  currentBoss = bossIndex;
  Object.assign(boss, { x: BOSS_HOME_X, color: BOSSES[bossIndex].color, name: BOSSES[bossIndex].name });
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
  Object.assign(boss, { shakeT: 0, ceaseT: 0 });
  combo = 0;
  maxCombo = 0;
  gotHit = false;
  winStars = [false, false, false];
  callout = null;
  typing = null;
  promptTimer = randomPromptGap();
  Object.assign(player, { x: 200, y: canvas.height / 2, vx: 0, vy: 0, tilt: 0 });
  Object.assign(health, { hp: MAX_HP, regenTimer: 0 });
  resetOrbs();
  elapsed = 0;
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
function fireShot(x, y, vx, vy) {
  shots.push({ x, y, vx, vy });
}

// out of the boss's center, heading left, tilted by `degrees` (0 = horizontal, + = up, - = down)
// snapped to 15 degree steps and limited to +/-75 so it always heads into the arena
const SHOOT_STEP = 15, SHOOT_MAX = 75;
function shoot(degrees = 0) {
  const snapped = Math.max(-SHOOT_MAX, Math.min(SHOOT_MAX, Math.round(degrees / SHOOT_STEP) * SHOOT_STEP));
  const rad = snapped * Math.PI / 180;
  fireShot(boss.x, boss.y, -Math.cos(rad) * SHOT.speed, -Math.sin(rad) * SHOT.speed);
}
const shootRandomAngle = () => shoot((Math.floor(Math.random() * (2 * SHOOT_MAX / SHOOT_STEP + 1)) - SHOOT_MAX / SHOOT_STEP) * SHOOT_STEP);

// vertical shots sweep a column of the arena: up from the bottom edge, down from the top edge
const randomLane = () => 40 + Math.random() * (BOSS_HOME_X - boss.rx - 80);
function shootBeam(dir, x = randomLane()) {
  beams.push({ x, dir, t: 0, hit: false });
}
const shootDown = x => shootBeam(1, x);  // sweeps from the top edge down
const shootUp = x => shootBeam(-1, x);   // sweeps from the bottom edge up

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
      color: Math.random() < 0.5 ? COLOR.purple : COLOR.orb,
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
  bombs.push({ x: boss.x, y: boss.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, t: 0, phase: 0 });
}

// bursts into projectiles in all 8 compass directions
function explodeBomb(b) {
  for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 4;
    fireShot(b.x, b.y, Math.cos(a) * BOMB.blastSpeed, Math.sin(a) * BOMB.blastSpeed);
  }
}

// throws the spinner to a random spot at least SPINNER.margin from the borders (skips if one is already out)
function launchSpinner() {
  if (spinner) return;
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
    dir: Math.random() < 0.5 ? 1 : -1, cool: 0,
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
  if (fightState === 'playing' && s.cool <= 0 && Math.hypot(s.x - player.x, s.y - player.y) < SPINNER.r + player.r) {
    damagePlayer();
    s.cool = SPINNER.hitCooldown;
  }

  if (s.t < SPINNER.fuse) {
    const u = s.t / SPINNER.fuse;
    s.phase += (2 + 16 * u * u) * dt; // flashes per second, ramping up
    return;
  }

  if (!s.firing) {
    // laser starts somewhere the player isn't, and sweeps toward where they were
    s.firing = true;
    s.vx = s.vy = 0;
    const toPlayer = Math.atan2(player.y - s.y, player.x - s.x);
    s.angle0 = toPlayer - s.dir * (0.9 + Math.random() * (Math.PI - 0.9));
  }
  const lt = s.t - SPINNER.fuse;
  if (lt >= SPINNER.laser) {
    spinner = null;
    return;
  }
  s.angle = s.angle0 + s.dir * SPINNER.spin * lt;
  if (fightState === 'playing' && lt >= SPINNER.fadeIn && s.cool <= 0 && laserHitsPlayer(s)) {
    damagePlayer();
    s.cool = SPINNER.hitCooldown;
  }
}

// player circle vs the laser segment
function laserHitsPlayer(s) {
  const ex = Math.cos(s.angle) * SPINNER.length, ey = Math.sin(s.angle) * SPINNER.length;
  const px = player.x - s.x, py = player.y - s.y;
  const t = Math.max(0, Math.min(1, (px * ex + py * ey) / (ex * ex + ey * ey)));
  return Math.hypot(px - ex * t, py - ey * t) < player.r + SPINNER.width / 2;
}

const ATTACKS = [shootRandomAngle, shootUp, shootDown, throwBomb, launchSpinner];

function damagePlayer() {
  health.hp = Math.max(0, health.hp - 1);
  health.regenTimer = 0; // regen clock restarts on a hit
  gotHit = true;
  combo = 0;
  callout = null;
}

function updateFight(dt) {
  const playing = fightState === 'playing';
  if (playing) {
    elapsed = Math.min(elapsed + dt, SONG_LENGTH);
    if (elapsed >= SONG_LENGTH) endFight('won');
  } else {
    endTimer += dt;
  }

  // win: the boss flees off the right edge
  if (fightState === 'won') boss.x += 800 * endTimer * dt;

  boss.shakeT = Math.max(0, boss.shakeT - dt);
  boss.ceaseT = Math.max(0, boss.ceaseT - dt);
  if (callout) {
    callout.t += dt;
    if (callout.t >= CALLOUT.flash + CALLOUT.fade) callout = null;
  }

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

  // attacks: pick a random one on a timer (held while the boss is stunned)
  if (playing && boss.ceaseT <= 0) {
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
    if (b.t >= BEAM.charge + BEAM.fire) {
      spawnBeamSparks(b);
      beams.splice(i, 1);
    } else if (playing && !b.hit && b.t >= BEAM.charge && beamHitsPlayer(b)) {
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
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    if (playing && Math.hypot(s.x - player.x, s.y - player.y) < SHOT.r + player.r) {
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

function drawFight() {
  // progress bar (top): |-------■------|
  const midY = BAR.y;
  ctx.strokeStyle = COLOR.track;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(BAR.x, midY - BAR.capH / 2); ctx.lineTo(BAR.x, midY + BAR.capH / 2);
  ctx.moveTo(BAR.x + BAR.w, midY - BAR.capH / 2); ctx.lineTo(BAR.x + BAR.w, midY + BAR.capH / 2);
  ctx.moveTo(BAR.x, midY); ctx.lineTo(BAR.x + BAR.w, midY);
  ctx.stroke();
  const markX = BAR.x + BAR.w * (elapsed / SONG_LENGTH);
  ctx.fillStyle = COLOR.purple;
  ctx.fillRect(markX - 5, midY - 5, 10, 10);

  drawBeams();
  drawSpinner();

  // bombs: black, flashing red (drawn before the boss so they emerge from behind it)
  for (const b of bombs) {
    const glow = (Math.sin(b.phase * Math.PI * 2) + 1) / 2;
    ctx.fillStyle = `rgb(${Math.round(20 + 235 * glow)}, 20, 20)`;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BOMB.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // projectiles
  ctx.fillStyle = COLOR.white;
  ctx.strokeStyle = COLOR.ink;
  ctx.lineWidth = 3;
  for (const s of shots) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, SHOT.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // boss (shakes and flashes white when a prompt lands)
  const hit = boss.shakeT > 0;
  ctx.fillStyle = hit && Math.floor(boss.shakeT * 20) % 2 === 0 ? COLOR.white : boss.color;
  ctx.beginPath();
  ctx.ellipse(boss.x + (hit ? Math.sin(boss.shakeT * 90) * 8 : 0), boss.y, boss.rx, boss.ry, 0, 0, Math.PI * 2);
  ctx.fill();

  // player (hitbox is a circle of radius player.r fitted to the sprite)
  // thrusters follow the vertical keys: W = up sprite, S = down sprite, otherwise idle
  const up = keys.has('KeyW'), down = keys.has('KeyS');
  const catImg = fightState === 'playing' && up !== down ? catImgs[up ? 'up' : 'down'] : catImgs.idle;
  if (catImg.complete && catImg.naturalWidth) {
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.tilt);
    ctx.drawImage(catImg, -CAT_SIZE / 2, -CAT_SIZE / 2, CAT_SIZE, CAT_SIZE);
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

  drawHud();
  if (callout) drawCallout();
  if (typing) drawPrompt();
}

function drawBeams() {
  const H = canvas.height;
  for (const b of beams) {
    const x0 = b.x - BEAM.w / 2;
    if (b.t < BEAM.charge) {
      // warning: dashed outline of the column, filling in and pulsing faster as it charges
      const p = b.t / BEAM.charge;
      ctx.fillStyle = COLOR.purple;
      ctx.globalAlpha = 0.04 + 0.1 * p;
      ctx.fillRect(x0, 0, BEAM.w, H);
      ctx.globalAlpha = 0.5 + 0.4 * Math.sin(b.t * (10 + 20 * p));
      ctx.strokeStyle = COLOR.purple;
      ctx.lineWidth = 2;
      ctx.setLineDash([12, 8]);
      ctx.strokeRect(x0, 1, BEAM.w, H - 2);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    } else {
      // live beam: purple edges, lavender core, swept across the column almost instantly
      const p = Math.min(1, (b.t - BEAM.charge) / BEAM.sweep);
      const g = ctx.createLinearGradient(x0, 0, x0 + BEAM.w, 0);
      g.addColorStop(0, COLOR.purple);
      g.addColorStop(0.5, COLOR.lavender);
      g.addColorStop(1, COLOR.purple);
      ctx.save();
      ctx.shadowColor = COLOR.purple;
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
    // spinning laser: purple edges, lavender core, fades in
    const W = SPINNER.width;
    const g = ctx.createLinearGradient(0, -W / 2, 0, W / 2);
    g.addColorStop(0, COLOR.purple);
    g.addColorStop(0.5, COLOR.lavender);
    g.addColorStop(1, COLOR.purple);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.angle);
    ctx.globalAlpha = Math.min(1, lt / SPINNER.fadeIn);
    ctx.shadowColor = COLOR.purple;
    ctx.shadowBlur = 20;
    ctx.fillStyle = g;
    ctx.fillRect(0, -W / 2, SPINNER.length, W);
    ctx.restore();
  }

  // purple orb with a white center that flashes red (solid red once the laser is out)
  const glow = lt >= 0 ? 1 : (Math.sin(s.phase * Math.PI * 2) + 1) / 2;
  const gb = Math.round(255 * (1 - glow));
  ctx.fillStyle = COLOR.purple;
  ctx.beginPath();
  ctx.arc(s.x, s.y, SPINNER.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgb(255, ${gb}, ${gb})`;
  ctx.beginPath();
  ctx.arc(s.x, s.y, SPINNER.coreR, 0, Math.PI * 2);
  ctx.fill();
}

function drawHud() {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillStyle = COLOR.ink;
  ctx.fillText(`Points ${score}`, 24, 20);
  if (combo > 0) {
    ctx.fillStyle = COLOR.purple;
    ctx.fillText(`Combo x${combo}`, 24, 52);
  }
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
  ctx.font = 'bold 64px sans-serif';
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
  ctx.font = 'bold 36px sans-serif';
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

const PLAY_BTN = { w: 220, h: 64, x: (canvas.width - 220) / 2, y: 330 };
const BANNER = { w: 200, h: 320, gap: 60, y: 110, point: 0.72 }; // point: where the bottom taper starts
BANNER.x0 = (canvas.width - (BOSSES.length * BANNER.w + (BOSSES.length - 1) * BANNER.gap)) / 2;
const bannerX = i => BANNER.x0 + i * (BANNER.w + BANNER.gap);

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
const bannerAt = p => BOSSES.findIndex((_, i) => inRect({ x: bannerX(i), y: BANNER.y, w: BANNER.w, h: BANNER.h }, p));
const playHovered = () => inRect(PLAY_BTN, mouse);

function onKey(code) {
  const confirm = code === 'Enter' || code === 'Space';
  if (scene === 'title') {
    if (confirm) scene = 'select';
  } else if (scene === 'select') {
    if (code === 'KeyA') sel = (sel + BOSSES.length - 1) % BOSSES.length;
    else if (code === 'KeyD') sel = (sel + 1) % BOSSES.length;
    else if (confirm) startFight(sel);
    else if (code === 'Escape') scene = 'title';
  } else if (scene === 'fight') {
    if (code === 'Escape' && fightState === 'playing') fightState = 'paused';
    else if (code === 'Escape' && fightState === 'paused') fightState = 'playing';
    else if (confirm && overlayVisible()) activateOverlayButton();
    else if (fightState === 'playing') typePromptKey(code);
  }
}

// Enter/Space press the first (primary) button: PLAY when paused, LOBBY after a win or loss
function activateOverlayButton() {
  overlayButtons()[0].action();
}

function mousePos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
}
canvas.addEventListener('mousemove', e => {
  Object.assign(mouse, mousePos(e));
  if (scene === 'select') {
    const i = bannerAt(mouse);
    if (i >= 0) sel = i;
  }
});
canvas.addEventListener('click', e => {
  Object.assign(mouse, mousePos(e));
  if (scene === 'title' && playHovered()) scene = 'select';
  else if (scene === 'select') {
    const i = bannerAt(mouse);
    if (i >= 0) startFight(sel = i);
  } else if (scene === 'fight' && overlayVisible()) {
    overlayButtons().find(b => inRect(b.r, mouse))?.action();
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
    ctx.font = 'bold 130px sans-serif';
    ctx.fillText('AstroCat', canvas.width / 2, 200);
  }

  drawButton(PLAY_BTN, 'PLAY');
}

function drawButton(r, label) {
  const hot = inRect(r, mouse);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = hot ? COLOR.purple : COLOR.white;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = COLOR.purple;
  ctx.lineWidth = 3;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = hot ? COLOR.white : COLOR.ink;
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 2);
}

// pause / win / lose panel drawn over the frozen fight
const PANEL = { w: 460, h: 450, x: (canvas.width - 460) / 2, y: 45 };
// the win panel is taller to make room for the star row
const PANEL_WIN = { w: 460, h: 510, x: (canvas.width - 460) / 2, y: 15 };
const btnAt = (y, panel = PANEL) => ({ w: 220, h: 64, x: (canvas.width - 220) / 2, y: panel.y + y });
const resumeFight = () => { fightState = 'playing'; };
const goLobby = () => { scene = 'title'; };
const PAUSE_BUTTONS = [
  { r: btnAt(290), label: 'PLAY', action: resumeFight },
  { r: btnAt(366), label: 'LOBBY', action: goLobby },
];
const END_BUTTONS = [{ r: btnAt(PANEL.h - 90), label: 'LOBBY', action: goLobby }];
const WIN_BUTTONS = [{ r: btnAt(PANEL_WIN.h - 80, PANEL_WIN), label: 'LOBBY', action: goLobby }];
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
    ctx.fillStyle = i < filled ? COLOR.purple : COLOR.lavender;
    ctx.fill();
    ctx.strokeStyle = i < filled ? COLOR.ink : COLOR.track;
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
    ctx.fillStyle = COLOR.lavender;
    ctx.fill();
    ctx.strokeStyle = COLOR.track;
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
      ctx.fillStyle = COLOR.purple;
      ctx.fill();
      ctx.strokeStyle = COLOR.ink;
      ctx.stroke();
      ctx.restore();
    }
    ctx.lineJoin = 'miter';
  }
}

function drawOverlay() {
  const won = fightState === 'won';
  const P = won ? PANEL_WIN : PANEL;
  const cx = canvas.width / 2;
  const progress = elapsed / SONG_LENGTH;

  ctx.fillStyle = 'rgba(61, 43, 107, 0.35)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = COLOR.white;
  ctx.fillRect(P.x, P.y, P.w, P.h);
  ctx.strokeStyle = boss.color;
  ctx.lineWidth = 4;
  ctx.strokeRect(P.x, P.y, P.w, P.h);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = won ? COLOR.purple : COLOR.ink;
  ctx.font = 'bold 38px sans-serif';
  ctx.fillText(won ? 'Boss scared away!' : fightState === 'lost' ? 'Defeated!' : 'PAUSED', cx, P.y + 50);

  // boss portrait + name
  ctx.fillStyle = boss.color;
  ctx.beginPath();
  ctx.ellipse(cx, P.y + 125, 30, 40, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COLOR.ink;
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(boss.name, cx, P.y + 185);

  // progress: |=====■------|
  const bw = 320, bx = cx - bw / 2, by = P.y + 225, capH = 20;
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLOR.track;
  ctx.beginPath();
  ctx.moveTo(bx, by); ctx.lineTo(bx + bw, by);
  ctx.moveTo(bx, by - capH / 2); ctx.lineTo(bx, by + capH / 2);
  ctx.moveTo(bx + bw, by - capH / 2); ctx.lineTo(bx + bw, by + capH / 2);
  ctx.stroke();
  ctx.strokeStyle = boss.color;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(bx, by); ctx.lineTo(bx + bw * progress, by);
  ctx.stroke();
  ctx.fillStyle = COLOR.ink;
  ctx.fillRect(bx + bw * progress - 6, by - 6, 12, 12);
  ctx.fillStyle = COLOR.muted;
  ctx.font = '22px sans-serif';
  ctx.fillText(`${Math.floor(progress * 100)}%`, cx, by + 32);

  if (won) {
    ctx.fillStyle = COLOR.purple;
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText(`Points: ${score}`, cx, P.y + 295);
    ctx.fillStyle = COLOR.ink;
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(`Highest combo: x${maxCombo}`, cx, P.y + 332);
    drawStars(cx, P.y + 385, endTimer - END_DELAY);
  }

  for (const b of overlayButtons()) drawButton(b.r, b.label);
}

function drawSelect() {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLOR.muted;
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText('Choose your fight', canvas.width / 2, 55);

  BOSSES.forEach((b, i) => {
    const active = i === sel;
    const x = bannerX(i), y = BANNER.y + (active ? -12 : 0);
    bannerPath(x, y);
    ctx.fillStyle = b.color;
    ctx.globalAlpha = active ? 1 : 0.65;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = active ? COLOR.ink : COLOR.track;
    ctx.lineWidth = active ? 5 : 3;
    ctx.stroke();

    ctx.font = 'bold 72px sans-serif';
    ctx.lineWidth = 6;
    ctx.strokeStyle = COLOR.ink;
    ctx.strokeText(String(i + 1), x + BANNER.w / 2, y + BANNER.h * 0.4);
    ctx.fillStyle = COLOR.white;
    ctx.fillText(String(i + 1), x + BANNER.w / 2, y + BANNER.h * 0.4);

    // best stars earned against this boss, empty slots included
    drawStarRow(x + BANNER.w / 2, BANNER.y + BANNER.h + 40, 14, 38, bestStars[i]);
  });
}

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05); // clamp after tab switches
  last = now;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (scene === 'title') drawTitle();
  else if (scene === 'select') drawSelect();
  else {
    if (fightState !== 'paused') updateFight(dt);
    drawFight();
    if (overlayVisible()) drawOverlay();
  }
  canvas.style.cursor = scene === 'fight' && !overlayVisible() ? 'none' : 'default'; // no cursor while fighting
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
