"""Generate a boss beat-map from a song.

    python tools/beatmap.py <song.mp3> <config.json> <out.js>

Needs numpy and soundfile (pip install numpy soundfile).

The audio analysis finds the tempo and beat grid, how loud each bar is, and how strong each beat hits. Attacks are
then placed on beats: sparse in quiet parts, denser in loud parts. The config is the manual input:

    id        beat-map name the game looks up (BOSSES[i].beatmap)
    seed      random seed, so the same config always gives the same map
    bpm       optional, skips tempo detection
    offset    optional, time of the first beat in seconds (only used with bpm)
    drops     [{"build": s, "drop": s, "spinner": bool, "spinnerAim": deg}]: the build-up runs from `build` to
              `drop`. The build gets a rising barrage, a quiet break before the drop is left empty (the boss charges
              up) unless "spinner" is true (then a spinner's laser sweeps through the break and reverses halfway;
              "spinnerAim" starts it that many degrees beside the player, turning toward them), and the drop lands a
              burst.
              Shown as diamonds on the progress bar.
    remove    [s, ...]: delete generated attacks that land at these times (within 0.05s)
    add       [{"t": s, "a": attack, ...}, ...]: extra hand-placed attacks

Attacks (`t` is when the attack lands, the game starts wind-ups early so they hit on the beat):
    shoot {deg, straight?}   shot from the boss, deg in 15 degree steps (+ = up); `straight` = from the exact
                     middle height, without curving toward the player
    fan {from, to, straight?}   one shot per 15 degree step between the two angles (`straight`: see shoot)
    beamUp / beamDown {x?, shake?}   vertical beam, x = 0..1 across the arena (random if left out); lands when it
                     fires. `shake` swings the screen toward the beam's side as it fires (1 = a full beam-run sway)
    bomb             lands when it explodes
    spinner {dur?, rev?, spin?, tiltScreen?, aim?, doubleSided?}   lands when the laser starts; optional laser
                     length, seconds into the laser when it reverses (a number or a list), spin speed (radians per
                     second), whether the screen leans very slowly against the laser's turn, degrees beside the player
                     to start (turning toward them), and whether the laser shoots out both sides of the orb
    tilt {dir}       the whole screen sways left (-1) or right (1), then settles back (not an attack)
    pulse {power}    boss bounces to a bass kick, power 0..1 (not an attack)

Bars whose bass pattern matches the first drop's bar (config "quad_match", correlation 0..1, default 0.97) get a
sequence of four beams on the four kicks, marching right to left, with the screen swaying left/right on each. Config
"quad_add": [s, ...] adds the same sequence to the bars at those times.
"""

import json
import random
import sys

import numpy as np
import soundfile as sf

HOP = 512
N_FFT = 2048


def analyze(path, bpm=None, offset=None):
    audio, sr = sf.read(path)
    x = audio.mean(axis=1) if audio.ndim > 1 else audio
    duration = len(x) / sr

    frames = 1 + (len(x) - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(frames)[:, None]
    spec = np.abs(np.fft.rfft(x[idx] * np.hanning(N_FFT), axis=1))
    fps = sr / HOP
    freqs = np.fft.rfftfreq(N_FFT, 1 / sr)

    # onset strength: how much the spectrum jumps up from one frame to the next
    flux = np.concatenate([[0], np.maximum(0, np.diff(np.log1p(100 * spec), axis=0)).sum(axis=1)])
    flux = np.maximum(0, flux - np.convolve(flux, np.ones(16) / 16, 'same'))
    rms = np.sqrt((x[idx] ** 2).mean(axis=1))
    bass = spec[:, freqs < 150].sum(axis=1)

    def grid_score(period, phase):
        f = np.round(np.arange(phase, duration, period) * fps).astype(int)
        f = f[f < frames - 1]
        return flux[f].sum() + 0.5 * (flux[f - 1].sum() + flux[f + 1].sum())

    if bpm is None:
        # autocorrelation picks the rough tempo, then a fine search fits tempo and phase to the onsets
        ac = np.correlate(flux, flux, 'full')[len(flux) - 1:]
        lags = np.arange(1, len(ac))
        tempos = 60 * fps / lags
        ok = (tempos >= 90) & (tempos <= 180)
        rough = tempos[ok][np.argmax(ac[1:][ok])]
        best = max(
            (grid_score(60 / b, p), b, p)
            for b in np.arange(rough - 0.5, rough + 0.5, 0.01)
            for p in np.arange(0, 60 / b, 0.005)
        )
        bpm, offset = best[1], best[2]
        # snap to a round tempo when it's that close (most produced music is on an exact tempo)
        if abs(bpm - round(bpm)) < 0.05:
            bpm = float(round(bpm))
            offset = max((grid_score(60 / bpm, p), p) for p in np.arange(0, 60 / bpm, 0.002))[1]
    offset = offset or 0.0

    beat = 60 / bpm
    beats = np.arange(offset, duration, beat)

    def window(t0, t1, arr):
        a, b = int(t0 * fps), max(int(t0 * fps) + 1, int(t1 * fps))
        return arr[a:min(b, frames)]

    strength = np.array([window(t - 0.03, t + 0.03, flux).max(initial=0) for t in beats])
    strength /= np.percentile(strength, 95) or 1
    bars = [(beats[i], beats[i] + 4 * beat) for i in range(0, len(beats) - 3, 4)]
    bar_rms = np.array([window(a, b, rms).mean() for a, b in bars])
    bar_bass = np.array([window(a, b, bass).mean() for a, b in bars])

    # sub-bass (kick drum) level in every 16th note: each bar's 16 values are its bass "fingerprint",
    # and a beat whose 16th is much louder than the one before it is a kick
    sub = spec[:, freqs < 120].sum(axis=1)
    sixteenth = beat / 4
    grid = np.array([window(t, t + sixteenth, sub).mean() for t in np.arange(offset, duration, sixteenth)])
    grid /= np.percentile(grid, 99) or 1
    bar_bass_shape = [grid[i * 16:(i + 1) * 16] for i in range(len(bars))]
    kick = np.zeros(len(beats))
    for i in range(len(beats)):
        j = i * 4
        if 0 < j < len(grid):
            kick[i] = grid[j] if grid[j] > 1.3 * grid[j - 1] else 0

    return {
        'duration': duration, 'bpm': float(bpm), 'offset': float(offset), 'beats': beats, 'strength': strength,
        'bars': bars, 'bar_level': bar_rms / bar_rms.max(), 'bar_bass': bar_bass,
        'bar_bass_shape': bar_bass_shape, 'kick': kick,
    }


def level_of(v):
    return 'silent' if v < 0.12 else 'low' if v < 0.47 else 'mid' if v < 0.75 else 'high'


def generate(song, cfg):
    rng = random.Random(cfg.get('seed', 1))
    beat = 60 / song['bpm']
    beats, strength = song['beats'], song['strength']
    events = []
    last_spinner = -99.0

    def add(t, a, **kw):
        events.append({'t': round(float(t), 3), 'a': a, **kw})

    def rand_deg(limit=60):
        return rng.choice(range(-limit, limit + 1, 15))

    drops = []
    for d in cfg.get('drops', []):
        build, drop = d['build'], d['drop']
        # the quiet break: the last bar before the drop, if the bass drops out there
        in_build = [i for i, (a, b) in enumerate(song['bars']) if build - 0.01 <= a < drop - 0.01]
        brk = drop
        if in_build:
            last = in_build[-1]
            rest = in_build[:-1] or in_build
            if song['bar_bass'][last] < 0.3 * np.mean([song['bar_bass'][i] for i in rest]):
                brk = song['bars'][last][0]
        drops.append({'build': build, 'break': round(float(brk), 3), 'drop': drop, 'spinner': d.get('spinner', False),
                      'aim': d.get('spinnerAim')})

    def drop_zone(t):
        return next((d for d in drops if d['build'] - 0.01 <= t < d['drop'] - 0.01), None)

    # "four big kicks" bars: every bar whose bass fingerprint matches the first drop's bar gets a 4-beam sequence
    shapes = song['bar_bass_shape']
    quad_bars = set()
    if drops:
        ref_i = min(range(len(song['bars'])), key=lambda i: abs(song['bars'][i][0] - drops[0]['drop']))
        ref = shapes[ref_i]
        for i, sh in enumerate(shapes):
            if len(sh) == 16 and sh.std() > 0 and np.corrcoef(ref, sh)[0, 1] >= cfg.get('quad_match', 0.97)                     and abs(sh.mean() - ref.mean()) < 0.15 * ref.mean():
                quad_bars.add(i)
    for t in cfg.get('quad_add', []):  # hand-picked extra bars (by time)
        quad_bars.add(min(range(len(song['bars'])), key=lambda i: abs(song['bars'][i][0] - t)))
    # beam lanes (0..1 across the arena) for the 4 beats: they march from right to left
    quad_lanes = [0.88, 0.62, 0.38, 0.12]

    heavy = ['bomb', 'beam', 'spinner', 'fan']
    mid_cycle = ['shoot', 'beam', 'shoot', 'bomb']
    heavy_i = mid_i = 0
    sections = []

    for bar_i, (bar_t, _) in enumerate(song['bars']):
        level = level_of(song['bar_level'][bar_i])
        zone = drop_zone(bar_t)
        kind = 'build' if zone and bar_t < zone['break'] - 0.01 else 'break' if zone else level
        if sections and sections[-1]['kind'] == kind:
            sections[-1]['end'] = round(float(bar_t + 4 * beat), 3)
        else:
            sections.append({'start': round(float(bar_t), 3), 'end': round(float(bar_t + 4 * beat), 3), 'kind': kind})

        b = [bar_t + k * beat for k in range(4)]
        s = [strength[min(bar_i * 4 + k, len(strength) - 1)] for k in range(4)]

        # around the drops (build-ups and loud sections) the boss bounces on every kick
        if kind in ('build', 'high'):
            for k in range(4):
                kv = song['kick'][min(bar_i * 4 + k, len(song['kick']) - 1)]
                if kv > 0.35:
                    add(b[k], 'pulse', power=round(float(min(1.0, kv)), 2))

        if bar_i in quad_bars:
            # four beams, one per kick, down / up / down / up; the boss tilts left, right, left, right with them
            for k in range(4):
                add(b[k], 'beamDown' if k % 2 == 0 else 'beamUp', x=quad_lanes[k])
                add(b[k], 'tilt', dir=-1 if k % 2 == 0 else 1)
            continue

        if kind == 'build':
            # rising barrage: a shot every beat sweeping the arena, every half beat in the last bar before the break
            last_bar = bar_t + 4 * beat >= zone['break'] - 0.01
            steps = [b[0] + k * beat / 2 for k in range(8)] if last_bar else b
            sweep = [60, 30, 0, -30, -60, -30, 0, 30]
            for k, t in enumerate(steps):
                add(t, 'shoot', deg=sweep[k % len(sweep)])
            continue
        if kind == 'break':
            # silence before the drop: the boss charges up (drawn by the game). Optionally a spinner's laser runs
            # through the whole break: one way through the first half, reversing halfway, ending right on the drop.
            if zone['spinner'] and abs(bar_t - zone['break']) < 0.01:
                length = zone['drop'] - zone['break']
                extra = {'aim': zone['aim']} if zone['aim'] is not None else {}
                add(zone['break'], 'spinner', dur=round(length, 3), rev=round(length / 2, 3), spin=1.6, **extra)
                last_spinner = zone['break']
            continue

        if level == 'low' and bar_i % 2 == 0:
            add(b[0], 'shoot', deg=rand_deg())
        elif level == 'mid':
            a = mid_cycle[mid_i % len(mid_cycle)]
            mid_i += 1
            if a == 'shoot':
                add(b[0], 'shoot', deg=rand_deg())
            elif a == 'beam':
                add(b[0], rng.choice(['beamUp', 'beamDown']))
            else:
                add(b[0], 'bomb')
            if s[2] > 0.6:
                add(b[2], 'shoot', deg=rand_deg())
        elif level == 'high':
            # the drop burst already covers the first beat of the drop
            if not any(abs(b[0] - d['drop']) < 0.01 for d in drops):
                a = heavy[heavy_i % len(heavy)]
                heavy_i += 1
                if a == 'spinner' and b[0] - last_spinner < 8:
                    a = 'fan'
                if a == 'spinner':
                    last_spinner = b[0]
                    add(b[0], 'spinner')
                elif a == 'beam':
                    add(b[0], rng.choice(['beamUp', 'beamDown']))
                elif a == 'fan':
                    c = rand_deg(30)
                    add(b[0], 'fan', **{'from': c - 15, 'to': c + 15})
                else:
                    add(b[0], 'bomb')
            add(b[2], 'shoot', deg=rand_deg())
            for k in (1, 3):
                if s[k] > 0.75:
                    add(b[k], 'shoot', deg=rand_deg())

    for d in drops:
        # the drop: a full fan of shots on the beat (plus two beams, unless the drop bar already has its 4-beam run)
        add(d['drop'], 'fan', **{'from': -75, 'to': 75}, straight=True)  # no curving, so the beams stay the focus
        drop_bar = min(range(len(song['bars'])), key=lambda i: abs(song['bars'][i][0] - d['drop']))
        if drop_bar not in quad_bars:
            add(d['drop'], 'beamUp', x=0.3)
            add(d['drop'], 'beamDown', x=0.7)

    removes = cfg.get('remove', [])
    events = [e for e in events if not any(abs(e['t'] - r) < 0.05 for r in removes)]
    events += [dict(e) for e in cfg.get('add', [])]
    events.sort(key=lambda e: e['t'])

    return {
        'id': cfg['id'], 'bpm': song['bpm'], 'offset': round(song['offset'], 3),
        'duration': round(song['duration'], 3), 'drops': drops, 'sections': sections,
        # how loud each bar is, 0..1 (1 = the loudest bar), for effects that follow the song's energy
        'intensity': [round(float(v), 2) for v in song['bar_level']],
        'events': events,
    }


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    song_path, cfg_path, out_path = sys.argv[1:]
    with open(cfg_path) as f:
        cfg = json.load(f)
    song = analyze(song_path, cfg.get('bpm'), cfg.get('offset'))
    beatmap = generate(song, cfg)

    with open(out_path, 'w', newline='\n') as f:
        f.write(f'// Generated by tools/beatmap.py from {song_path} and {cfg_path}.\n')
        f.write('// Edit the config (drops, remove, add) and regenerate instead of editing this file.\n')
        f.write('window.BEATMAPS = window.BEATMAPS || {};\n')
        f.write(f'window.BEATMAPS[{json.dumps(cfg["id"])}] = {{\n')
        # one entry per line so the file stays easy to read and diff
        fields = []
        for key, val in beatmap.items():
            if key == 'intensity':
                fields.append(f'  {json.dumps(key)}: {json.dumps(val)}')
            elif isinstance(val, list):
                rows = ',\n'.join('    ' + json.dumps(v) for v in val)
                fields.append(f'  {json.dumps(key)}: [\n{rows}\n  ]')
            else:
                fields.append(f'  {json.dumps(key)}: {json.dumps(val)}')
        f.write(',\n'.join(fields))
        f.write('\n};\n')

    print('four-kick beam bars at:', sorted({e['t'] for e in beatmap['events'] if e['a'] == 'tilt' and e['dir'] == -1}))
    counts = {}
    for e in beatmap['events']:
        counts[e['a']] = counts.get(e['a'], 0) + 1
    print(f"{beatmap['bpm']} BPM, first beat at {beatmap['offset']}s, {beatmap['duration']:.1f}s long")
    for s in beatmap['sections']:
        print(f"  {s['start']:7.2f} - {s['end']:7.2f}  {s['kind']}")
    print('drops:', beatmap['drops'])
    print(len(beatmap['events']), 'attacks:', counts)


if __name__ == '__main__':
    main()
