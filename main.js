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
  minSpeed: 220, maxSpeed: 340, // launch speed range
  drag: 1.4,                    // bombs skid to a stop (travel = speed / drag, at most ~240px)
  fuse: 2.2,                    // seconds until it explodes
  blastSpeed: 240,              // speed of the 8 projectiles it releases
  spread: 65 * Math.PI / 180,   // valid throw cone: +/- this from straight left
};
const shots = []; // { x, y, vx, vy }
const bombs = []; // { x, y, vx, vy, t, phase }
let attackTimer = 0;

const BOSS_HOME_X = canvas.width - 120;
const player = { x: 200, y: canvas.height / 2, vx: 0, vy: 0, r: 14, accel: 1600, friction: 6, maxSpeed: 320 };
const boss = { x: BOSS_HOME_X, y: canvas.height / 2, rx: 60, ry: 110, color: '#d65db1', name: '' };
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
  radius: 34,      // comfortable distance; inside this they mostly idle
  far: 130,        // distance at which orbs reach full speed
  minSpeed: 6,     // top speed right next to the player (nearly stationary)
  maxSpeed: 420,   // top speed when far behind
  pull: 26,        // acceleration toward the player per px beyond the radius
  wander: 22,      // idle drift acceleration
  padding: 3,      // guaranteed gap between orb edges
  spacing: 20,     // orbs start gently pushing apart inside this center distance
  drag: 2.5,
  r: 6,
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
let score = 0; // nothing awards points yet

const fightEnded = () => fightState === 'won' || fightState === 'lost';
// pause panel shows immediately, win/lose panels wait for the escape animation
const overlayVisible = () => fightState === 'paused' || (fightEnded() && endTimer >= END_DELAY);

function startFight(bossIndex) {
  Object.assign(boss, { x: BOSS_HOME_X, color: BOSSES[bossIndex].color, name: BOSSES[bossIndex].name });
  fightState = 'playing';
  endTimer = 0;
  score = 0;
  regen = null;
  shots.length = 0;
  bombs.length = 0;
  attackTimer = 0;
  Object.assign(player, { x: 200, y: canvas.height / 2, vx: 0, vy: 0 });
  Object.assign(health, { hp: MAX_HP, regenTimer: 0 });
  resetOrbs();
  elapsed = 0;
  scene = 'fight';
}

function endFight(result) {
  fightState = result;
  endTimer = 0;
  regen = null;
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
function shootUp(x = randomLane()) {
  fireShot(x, canvas.height + SHOT.r, 0, -SHOT.speed);
}
function shootDown(x = randomLane()) {
  fireShot(x, -SHOT.r, 0, SHOT.speed);
}

// a valid direction is anywhere in the cone pointing left, into the arena (never behind or into the boss)
function throwBomb() {
  const angle = Math.PI + (Math.random() * 2 - 1) * BOMB.spread;
  const speed = BOMB.minSpeed + Math.random() * (BOMB.maxSpeed - BOMB.minSpeed);
  bombs.push({ x: boss.x, y: boss.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, t: 0, phase: 0 });
}

// bursts into projectiles in all 8 compass directions
function explodeBomb(b) {
  for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 4;
    fireShot(b.x, b.y, Math.cos(a) * BOMB.blastSpeed, Math.sin(a) * BOMB.blastSpeed);
  }
}

const ATTACKS = [shootRandomAngle, shootUp, shootDown, throwBomb];

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

  // attacks: pick a random one on a timer
  if (playing) {
    attackTimer += dt;
    if (attackTimer >= SHOT.interval) {
      attackTimer = 0;
      ATTACKS[Math.floor(Math.random() * ATTACKS.length)]();
    }
  }

  // bombs (harmless until they burst): skid to a stop, flash faster and faster, then explode
  for (let i = bombs.length - 1; i >= 0; i--) {
    const b = bombs[i];
    b.t += dt;
    const drag = Math.exp(-BOMB.drag * dt);
    b.vx *= drag; b.vy *= drag;
    b.x = Math.max(BOMB.r, b.x + b.vx * dt);
    b.y = Math.min(canvas.height - BOMB.r, Math.max(BAR.y + BAR.capH + BOMB.r, b.y + b.vy * dt));
    const urgency = b.t / BOMB.fuse;
    b.phase += (2 + 16 * urgency * urgency) * dt; // flashes per second, ramping up
    if (b.t >= BOMB.fuse) {
      explodeBomb(b);
      bombs.splice(i, 1);
    }
  }

  // projectiles: move, collide with the player (they keep flying after the fight ends)
  const margin = SHOT.r * 2;
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i];
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    if (playing && Math.hypot(s.x - player.x, s.y - player.y) < SHOT.r + player.r) {
      health.hp = Math.max(0, health.hp - 1);
      health.regenTimer = 0; // regen clock restarts on a hit
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

function drawRegenBurst() {
  const p = regen.t / REGEN_ANIM; // 0..1
  const c = regenSpot();

  // orb swelling in the middle
  ctx.fillStyle = COLOR.orb;
  ctx.beginPath();
  ctx.arc(c.x, c.y, ORBIT.r * p, 0, Math.PI * 2);
  ctx.fill();

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
  // progress bar (top): |-------|------|
  const midY = BAR.y;
  ctx.strokeStyle = COLOR.track;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(BAR.x, midY - BAR.capH / 2); ctx.lineTo(BAR.x, midY + BAR.capH / 2);
  ctx.moveTo(BAR.x + BAR.w, midY - BAR.capH / 2); ctx.lineTo(BAR.x + BAR.w, midY + BAR.capH / 2);
  ctx.moveTo(BAR.x, midY); ctx.lineTo(BAR.x + BAR.w, midY);
  ctx.stroke();
  ctx.strokeStyle = COLOR.purple;
  ctx.lineWidth = 3;
  const markX = BAR.x + BAR.w * (elapsed / SONG_LENGTH);
  ctx.beginPath();
  ctx.moveTo(markX, midY - BAR.capH / 2); ctx.lineTo(markX, midY + BAR.capH / 2);
  ctx.stroke();

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

  // boss
  ctx.fillStyle = boss.color;
  ctx.beginPath();
  ctx.ellipse(boss.x, boss.y, boss.rx, boss.ry, 0, 0, Math.PI * 2);
  ctx.fill();

  // player
  ctx.fillStyle = COLOR.ink;
  ctx.beginPath();
  ctx.arc(player.x, player.y, player.r, 0, Math.PI * 2);
  ctx.fill();

  // health orbs
  ctx.fillStyle = COLOR.orb;
  for (let i = 0; i < health.hp; i++) {
    ctx.beginPath();
    ctx.arc(orbs[i].x, orbs[i].y, ORBIT.r, 0, Math.PI * 2);
    ctx.fill();
  }
  if (regen) drawRegenBurst();
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
  }
}

function activateOverlayButton() {
  if (fightState === 'paused') fightState = 'playing';
  else scene = 'title'; // won or lost: back to the lobby
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
  } else if (scene === 'fight' && overlayVisible() && inRect(OVERLAY_BTN, mouse)) activateOverlayButton();
});

function drawTitle() {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLOR.purple;
  ctx.font = 'bold 130px sans-serif';
  ctx.fillText('AstroCat', canvas.width / 2, 200);

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
const PANEL = { w: 460, h: 420, x: (canvas.width - 460) / 2, y: 60 };
const OVERLAY_BTN = { w: 220, h: 64, x: (canvas.width - 220) / 2, y: PANEL.y + PANEL.h - 90 };

function drawOverlay() {
  const won = fightState === 'won';
  const cx = canvas.width / 2;
  const progress = elapsed / SONG_LENGTH;

  ctx.fillStyle = 'rgba(61, 43, 107, 0.35)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = COLOR.white;
  ctx.fillRect(PANEL.x, PANEL.y, PANEL.w, PANEL.h);
  ctx.strokeStyle = boss.color;
  ctx.lineWidth = 4;
  ctx.strokeRect(PANEL.x, PANEL.y, PANEL.w, PANEL.h);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = won ? COLOR.purple : COLOR.ink;
  ctx.font = 'bold 38px sans-serif';
  ctx.fillText(won ? 'Boss scared away!' : fightState === 'lost' ? 'Defeated!' : 'PAUSED', cx, PANEL.y + 50);

  // boss portrait + name
  ctx.fillStyle = boss.color;
  ctx.beginPath();
  ctx.ellipse(cx, PANEL.y + 125, 30, 40, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COLOR.ink;
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(boss.name, cx, PANEL.y + 185);

  // progress: |=====|------|
  const bw = 320, bx = cx - bw / 2, by = PANEL.y + 225, capH = 20;
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
  ctx.strokeStyle = COLOR.ink;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(bx + bw * progress, by - capH / 2); ctx.lineTo(bx + bw * progress, by + capH / 2);
  ctx.stroke();
  ctx.fillStyle = COLOR.muted;
  ctx.font = '22px sans-serif';
  ctx.fillText(`${Math.floor(progress * 100)}%`, cx, by + 32);

  if (won) {
    ctx.fillStyle = COLOR.purple;
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText(`Points: ${score}`, cx, PANEL.y + 295);
  }

  drawButton(OVERLAY_BTN, fightState === 'paused' ? 'PLAY' : 'LOBBY');
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
