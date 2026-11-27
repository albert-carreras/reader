// Background sounds, made in code: each is a seamless stereo loop, the same every time (seeded), so nothing is
// downloaded and they work offline. app.js runs this in a worker when a sound is first played (well under a second).
//
// Everything in a loop repeats exactly at its end:
//   - noise is filtered "around the circle": each filter runs twice over the loop and keeps the second pass, so it
//     starts the loop in the state it ends it in
//   - events (drops, crackles, waves) that run past the end continue at the start
//   - tones and slow swells complete a whole number of cycles in the loop
// So there is no seam to hear. Each sound comes out at -23 LUFS (K-weighted, ungated); app.js sets the level.

export const LOOP = 60;      // seconds
const TARGET = -23;          // LUFS

export const KINDS = ["rain", "fire", "waves", "space", "focus", "brown"];
const SEEDS = { rain: 11, fire: 23, waves: 37, space: 41, focus: 53, brown: 67 };

export function makeSound(kind, sr, seconds = LOOP) {
  const g = { rain, fire, waves, space, focus, brown }[kind];
  if (!g) throw new Error(`no sound "${kind}"`);
  const N = Math.round(sr * seconds);
  const [L, R] = g({ sr, N, T: N / sr, r: rng(SEEDS[kind]) });
  return normalize(L, R, sr);
}

// in a worker: {kind, sr} in, {kind, L, R} (transferred) out
if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage = ({ data: { kind, sr } }) => {
    try {
      const t0 = performance.now(), [L, R] = makeSound(kind, sr);
      postMessage({ kind, L, R, ms: Math.round(performance.now() - t0) }, [L.buffer, R.buffer]);
    } catch (e) { postMessage({ kind, error: String(e?.message || e) }); }
  };
}

// ------------------------------------------------------------------ building blocks

function rng(seed) {      // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// white noise in -1..1 (xorshift32, seeded from r: fast, and plenty random for noise)
const white = (N, r) => {
  const x = new Float32Array(N);
  let s = (r() * 4294967295) | 1;
  for (let i = 0; i < N; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; x[i] = s * 4.656612873077393e-10; }
  return x;
};
const twoCh = (N) => [new Float32Array(N), new Float32Array(N)];

// filters work in place on a whole loop, around the circle (see the top). The first pass only needs the stretch
// before the end that the filter still "remembers" (12 time constants: what's older has decayed below 1e-5).
const warm = (N, sr, tc) => Math.max(0, N - Math.min(N, Math.ceil(12 * tc * sr)));
function lp1(x, fc, sr) {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / sr), N = x.length;
  let y = 0;
  for (let i = warm(N, sr, 1 / (2 * Math.PI * fc)); i < N; i++) y += a * (x[i] - y);
  for (let i = 0; i < N; i++) { y += a * (x[i] - y); x[i] = y; }
  return x;
}
function hp1(x, fc, sr) {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / sr), N = x.length;
  let y = 0;
  for (let i = warm(N, sr, 1 / (2 * Math.PI * fc)); i < N; i++) y += a * (x[i] - y);
  for (let i = 0; i < N; i++) { y += a * (x[i] - y); x[i] -= y; }
  return x;
}
function coeffs(type, f0, q, sr, gainDb = 0) {        // RBJ cookbook
  const w = (2 * Math.PI * f0) / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * q), A = 10 ** (gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === "lp") { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else if (type === "hp") { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else if (type === "bp") { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else {                    // high shelf
    const s = 2 * Math.sqrt(A) * al;
    b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s);
    a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function bq(x, type, f0, q, sr, gainDb, once = false) {    // transposed direct form II
  const [b0, b1, b2, a1, a2] = coeffs(type, f0, q, sr, gainDb), N = x.length;
  let z1 = 0, z2 = 0;
  for (let p = once ? 1 : 0; p < 2; p++) {
    for (let i = p ? 0 : warm(N, sr, Math.max(q, 0.5) / (Math.PI * f0)); i < N; i++) {
      const v = x[i], y = b0 * v + z1;
      z1 = b1 * v - a1 * y + z2; z2 = b2 * v - a2 * y;
      if (p) x[i] = y;
    }
  }
  return x;
}
function pink(x) {        // Paul Kellet's economy pink filter
  const N = x.length;
  let b0 = 0, b1 = 0, b2 = 0;
  for (let p = 0; p < 2; p++) {
    for (let i = p ? 0 : Math.max(0, N - 6000); i < N; i++) {      // slowest pole 0.99765: ~425 samples per time constant
      const w = x[i];
      b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
      if (p) x[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    }
  }
  return x;
}
const rms = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length) || 1; };
const scale = (x, k) => { for (let i = 0; i < x.length; i++) x[i] *= k; return x; };
const unit = (x) => scale(x, 1 / rms(x));
// add `x` into `out` at `db` relative to unit RMS
const mix = (out, x, db) => { const k = 10 ** (db / 20) / rms(x); for (let i = 0; i < out.length; i++) out[i] += x[i] * k; return out; };
// a slow random curve around 0 (unit RMS), smooth at `hz`, seamless
const wander = (N, sr, r, hz) => unit(lp1(lp1(lp1(white(N, r), hz, sr), hz, sr), hz, sr));
// a decaying ping (a drop, a crackle) added at sample i0, wrapping around the end. `amp` is in units of the bed's
// RMS; pan 0..1 is left..right; `noise` blends in a noise burst; `glide` drops the pitch as it rings
function ping(L, R, i0, sr, { f, tau, amp, pan = 0.5, glide = 0, noise = 0, r }) {
  const N = L.length, len = Math.min(Math.ceil(tau * 6 * sr), N), gl = Math.sqrt(1 - pan) * amp, gr = Math.sqrt(pan) * amp;
  const d = Math.exp(-1 / (tau * sr)), w0 = (2 * Math.PI * f) / sr, atk = Math.max(2, Math.round(sr * Math.min(tau / 4, 0.0004)));
  let env = 1, ph = r() * 6.283;
  for (let k = 0; k < len; k++) {
    ph += glide ? w0 * (1 - glide * Math.min(1, k / (tau * sr * 3))) : w0;
    const v = env * (k < atk ? k / atk : 1) * (Math.sin(ph) * (1 - noise) + (r() * 2 - 1) * noise);
    env *= d;
    const i = i0 + k < N ? i0 + k : (i0 + k) % N;
    L[i] += v * gl; R[i] += v * gr;
  }
}
// event times at a steady average rate over the whole loop (so the seam has the same density as anywhere else)
const times = (T, rate, r) => { const out = []; for (let t = -Math.log(1 - r()) / rate; t < T; t += -Math.log(1 - r()) / rate) out.push(t); return out; };
const logU = (r, a, b) => a * (b / a) ** r();
// a frequency with a whole number of cycles per loop
const per = (hz, T) => Math.max(1, Math.round(hz * T)) / T;
// add a sine (amplitude a, phase ph) into out; optional slow swell: depth, cycles per loop, phase
function sine(out, hz, a, ph, sr, swell = 0, cycles = 1, sph = 0) {
  const N = out.length, w = (2 * Math.PI * hz) / sr, c = Math.cos(w), s = Math.sin(w), ws = (2 * Math.PI * cycles) / N;
  const cs = Math.cos(ws), ss = Math.sin(ws);
  let x = Math.cos(ph), y = Math.sin(ph), lx = Math.cos(sph), ly = Math.sin(sph);
  for (let i = 0; i < N; i++) {
    out[i] += a * (1 - swell + swell * ly) * y;
    const nx = x * c - y * s; y = x * s + y * c; x = nx;            // rotate: no sin() per sample
    const mx = lx * cs - ly * ss; ly = lx * ss + ly * cs; lx = mx;
  }
}

// ------------------------------------------------------------------ the sounds

// steady rain: a soft hiss, many small drops all around, a few closer heavy drops, and a low body
function rain({ sr, N, T, r }) {
  const [L, R] = twoCh(N);
  const swell = wander(N, sr, r, 0.04);
  for (const out of [L, R]) {
    const bed = unit(bq(bq(pink(white(N, r)), "hp", 350, 0.7, sr), "lp", 7500, 0.7, sr));
    for (let i = 0; i < N; i++) out[i] = bed[i] * (1 + 0.18 * swell[i]);
    mix(out, hp1(lp1(lp1(white(N, r), 90, sr), 400, sr), 30, sr), -11);
  }
  for (const t of times(T, 90, r)) ping(L, R, Math.floor(t * sr), sr, { f: logU(r, 1800, 6500), tau: logU(r, 0.0008, 0.003), amp: 0.6 + 2.4 * r() ** 3, pan: r(), noise: 0.5, r });
  for (const t of times(T, 2.2, r)) ping(L, R, Math.floor(t * sr), sr, { f: logU(r, 700, 1900), tau: logU(r, 0.006, 0.016), amp: 0.8 + 1.2 * r(), pan: 0.15 + 0.7 * r(), glide: 0.25, noise: 0.15, r });
  return [L, R];
}

// a fireplace: a low flickering roar, clusters of crackles, now and then a pop
function fire({ sr, N, T, r }) {
  const [L, R] = twoCh(N);
  const slow = wander(N, sr, r, 0.25), fast = wander(N, sr, r, 2.5);
  for (const out of [L, R]) {
    const roar = unit(hp1(lp1(lp1(white(N, r), 70, sr), 300, sr), 25, sr));
    const breath = unit(bq(bq(pink(white(N, r)), "lp", 900, 0.7, sr), "hp", 120, 0.7, sr));
    const hiss = unit(bq(white(N, r), "hp", 4000, 0.7, sr));
    const kb = 10 ** (-9 / 20), kh = 10 ** (-30 / 20);
    for (let i = 0; i < N; i++) {
      const m = Math.max(0.15, 1 + 0.35 * slow[i] + 0.15 * fast[i]);
      out[i] = roar[i] * m + breath[i] * m * m * kb + hiss[i] * Math.max(0, 1 + 0.6 * fast[i]) * kh;
    }
  }
  for (const t0 of times(T, 1.3, r)) {                   // a cluster of crackles
    const pan = 0.2 + 0.6 * r(), n = 2 + Math.floor(r() ** 2 * 14);
    let t = t0;
    for (let j = 0; j < n; j++) {
      ping(L, R, Math.floor(t * sr), sr, { f: logU(r, 1500, 7000), tau: logU(r, 0.0002, 0.0012), amp: 0.5 + 4 * r() ** 2.5, pan: pan + (r() - 0.5) * 0.15, noise: 0.6, r });
      t += -Math.log(1 - r()) * 0.03;
    }
  }
  for (const t of times(T, 2.5, r)) ping(L, R, Math.floor(t * sr), sr, { f: logU(r, 1500, 6000), tau: logU(r, 0.0002, 0.0008), amp: 0.3 + 1.2 * r(), pan: r(), noise: 0.7, r });
  for (const t of times(T, 0.18, r)) ping(L, R, Math.floor(t * sr), sr, { f: logU(r, 250, 700), tau: logU(r, 0.006, 0.014), amp: 2 + 1.5 * r(), pan: 0.3 + 0.4 * r(), noise: 0.5, glide: 0.2, r });
  return [L, R];
}

// waves on a beach: a swell every 7-11 s that brightens as it breaks and hisses as it washes back, over a far surf
function waves({ sr, N, T, r }) {
  const [L, R] = twoCh(N);
  const K = Math.max(1, Math.round(T / 9));
  const eL = new Float32Array(N), eR = new Float32Array(N);
  for (let k = 0; k < K; k++) {
    const t0 = ((k + 0.5) * T) / K + (r() - 0.5) * 4.5, A = 0.4 + 0.6 * r(), rise = 2 + 2.4 * r(), fall = 3 + 4 * r(), pan = 0.25 + 0.5 * r();
    const len = Math.floor((rise + fall * 2.2) * sr), i0 = Math.floor((((t0 % T) + T) % T) * sr);
    const gl = Math.SQRT2 * Math.sqrt(1 - pan) * A, gr = Math.SQRT2 * Math.sqrt(pan) * A;
    for (let j = 0; j < len; j++) {
      const t = j / sr, e = t < rise ? Math.sin((Math.PI / 2) * (t / rise)) ** 2 : Math.exp(-(t - rise) / (fall / 2.2));
      const i = (i0 + j) % N;
      eL[i] += e * gl; eR[i] += e * gr;
    }
  }
  for (const [out, env] of [[L, eL], [R, eR]]) {
    // the breaking water: pink noise through a lowpass that opens with the swell (two poles, around the circle)
    const src = pink(white(N, r)), k = (-2 * Math.PI) / sr;
    let y1 = 0, y2 = 0;
    for (let p = 0; p < 2; p++) {
      for (let i = p ? 0 : warm(N, sr, 1 / (2 * Math.PI * 180)); i < N; i++) {
        const e = env[i], a = 1 - Math.exp(k * (180 + 2600 * e * e));
        y1 += a * (src[i] - y1); y2 += a * (y1 - y2);
        if (p) out[i] = y2 * (0.4 + e);
      }
    }
    unit(out);
    const foam = bq(white(N, r), "hp", 2500, 0.7, sr);
    for (let i = 0; i < N; i++) foam[i] *= 0.06 + env[i] ** 3;     // fizzing all the time, loudest as a wave breaks
    mix(out, foam, -16);
    mix(out, hp1(lp1(lp1(white(N, r), 60, sr), 350, sr), 25, sr), -7);
  }
  return [L, R];
}

// space: a slow, wide drone (an open chord of soft sines, each slowly beating) with a faint airy shimmer
function space({ sr, N, T, r }) {
  const [L, R] = twoCh(N);
  const partials = [[55, 1], [82.5, 0.7], [110, 0.55], [165, 0.33], [247.5, 0.18], [330, 0.1]];
  for (const out of [L, R]) {
    for (const [f, a] of partials) {
      const cyc = 1 + Math.floor(r() * 3), sph = r() * 6.283;
      for (let v = 0; v < 2; v++) sine(out, per(f, T) + (v ? 1 : -1) * (1 + Math.floor(r() * 4)) / T, a * 0.5, r() * 6.283, sr, 0.25, cyc, sph);
    }
    const air = bq(pink(white(N, r)), "bp", 1100, 0.9, sr);
    const ws = (2 * Math.PI * 2) / N, ph = r() * 6.283;
    for (let i = 0; i < N; i++) air[i] *= 0.65 + 0.35 * Math.sin(ws * i + ph);
    mix(out, air, 20 * Math.log10(rms(out)) - 6);   // ~6 dB under the drone
  }
  return [L, R];
}

// focus: binaural beats (200 Hz left, 212 Hz right: a 12 Hz beat, heard with headphones) over soft brown noise
function focus({ sr, N, T, r }) {
  const [L, R] = twoCh(N);
  for (const [out, f] of [[L, 200], [R, 212]]) {
    sine(out, per(f, T), 1, 0, sr);
    mix(out, hp1(lp1(lp1(white(N, r), 80, sr), 500, sr), 25, sr), 20 * Math.log10(rms(out)) - 4);
  }
  return [L, R];
}

// brown noise: deep, even, nothing happening
function brown({ sr, N, r }) {
  const [L, R] = twoCh(N);
  for (const out of [L, R]) mix(out, hp1(hp1(lp1(white(N, r), 70, sr), 20, sr), 20, sr), 0);
  return [L, R];
}

// ------------------------------------------------------------------ loudness

// BS.1770 K-weighting (as RBJ filters, so it works at any rate), mean square over both channels, no gating
export function lufs(L, R, sr) {
  let s = 0;
  for (const x of [L, R]) {
    const y = bq(bq(Float32Array.from(x), "hs", 1681.97445, 0.70717524, sr, 3.99984385, true), "hp", 38.1354709, 0.50032704, sr, 0, true);
    s += rms(y) ** 2;
  }
  return -0.691 + 10 * Math.log10(s || 1e-12);
}
function normalize(L, R, sr) {
  const k = 10 ** ((TARGET - lufs(L, R, sr)) / 20);
  scale(L, k); scale(R, k);
  return [L, R];
}
