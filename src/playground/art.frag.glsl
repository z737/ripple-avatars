#version 300 es
precision highp float;

// ---------------------------------------------------------------------------
// One mesh-gradient material, embossed by a wave-generated height field.
//
//   mesh gradient (pigment)
//   + height field   H  = mix(additive, multiplicative, interference)
//   + analytic gradient of H  ->  surface normal
//   + one directional light   ->  diffuse, signed-slope highlight and shadow
//   + normal-driven chromatic refraction of the pigment
//   + grain
//
// The rule the whole shader is built around: DO NOT DRAW THE RIPPLES. Nothing
// here maps a wave value to a colour. The waves only displace a virtual
// surface, and the surface is visible solely because the light reads its slope.
// Set Chromatic and Grain to zero and the image is still dimensional; that is
// the test.
//
// Derivatives are analytic throughout — the wave equations are differentiated
// in closed form rather than sampled with dFdx/dFdy. That matters twice over:
// screen-space derivatives quantise to the pixel grid and fall apart exactly
// where the interference gets tight, and they cannot be evaluated at the three
// offset positions chromatic refraction needs.
// ---------------------------------------------------------------------------

#define MAX_SRC  4
#define MAX_MESH 6
#define MAX_INT  4

#define IDLE_WANDER 0.01

out vec4 fragColor;

uniform vec2  uResolution;
/** integrated wave clock — idle drift plus audio mids, advanced in JS so the
 *  shader never has to know the frame rate */
uniform float uWaveTime;

// --- permanent wave sources ---
uniform int   uSrcCount;
uniform vec4  uSrcA[MAX_SRC];  // xy position, z angular frequency, w phase
uniform vec4  uSrcB[MAX_SRC];  // x rotation, y radial power, z drift, w amplitude
uniform vec4  uSrcC[MAX_SRC];  // xy inverse anisotropic scale, z wander seed
uniform float uBreathe;        // slow global scaling of ring spacing

uniform float uMix;            // 0 = coherent complex field, 1 = multiplicative
uniform float uFringe;         // 0 = live displacement, 1 = standing envelope
uniform float uProfile;        // thickness: wave profile sharpness
uniform float uDepth;          // wave depth, pre-divided by the base frequency
uniform float uWarp;
uniform vec4  uWarpFreq;
uniform vec4  uWarpPhase;

// --- transient interaction ripples ---
uniform int   uIntCount;
uniform vec4  uInt0[MAX_INT];  // xy position, z age in seconds, w strength
uniform vec4  uInt1[MAX_INT];  // x frequency, y speed, z decay, w front width
uniform float uInteraction;

// --- material ---
uniform int   uMeshCount;
uniform vec3  uMeshLab[MAX_MESH];   // already in OKLab, converted on the CPU
uniform vec4  uMeshPos[MAX_MESH];   // xy position, z radius, w falloff
uniform vec3  uNeutralLab;
uniform vec3  uMatte;
uniform float uMesh;
uniform float uNeutralFloor;

// --- light ---
uniform vec3  uLightDir;
uniform float uLightIntensity;
uniform float uShadowDepth;
uniform float uAmbient;
uniform float uSpecular;
uniform float uMetallic;   // 0 matte, 0.4 glossy, 1 chrome

// --- material optics ---
uniform float uIridescence;   // thin-film colour from surface height
uniform float uTranslucency;  // light bleeding through and around
uniform float uAnisotropy;    // specular stretched along a tangent
uniform vec2  uAnisoDir;      // that tangent, unit length
uniform float uGranularity;   // static grain-scale relief

uniform float uChromatic;
uniform float uGrain;
uniform float uGrainScale;
uniform float uExposure;
uniform float uContrast;

uniform vec4  uAudio;          // x volume, y bass, z mid, w highs

uniform int   uShape;
uniform float uShapeSize;
uniform float uShapeSoft;

uniform int   uDebug;

// --- medium engine ---
uniform int       uEngine;         // 0 = analytic waves, 1 = oscillator medium
uniform sampler2D uMediumTex;      // r = the medium's displacement field
uniform vec2      uMediumTexel;    // one lattice texel, in field units
uniform vec2      uMediumMap;      // field -> lattice uv: p * x + y
uniform float     uMediumGain;
uniform vec2      uMediumStretch;  // global anisotropy, inverse scale

// ===========================================================================
// colour
// ===========================================================================
vec3 oklabToLin(vec3 c) {
  float l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  vec3 k = vec3(l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
  return vec3(
     4.0767416621 * k.x - 3.3077115913 * k.y + 0.2309699292 * k.z,
    -1.2684380046 * k.x + 2.6097574011 * k.y - 0.3413193965 * k.z,
    -0.0041960863 * k.x - 0.7034186147 * k.y + 1.7076147010 * k.z
  );
}

vec3 toSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

/** The pigment. One continuous sheet for the whole canvas: gaussian attractors
 *  over a neutral base, blended in OKLab so a cyan-to-orange midpoint stays a
 *  colour instead of collapsing to grey. The neutral carries a floor weight, so
 *  cream and off-white regions survive between the attractors instead of the
 *  frame filling edge to edge with saturated colour. */
/** The raw attractor blend, in OKLab and *not* faded toward the neutral. The ink
 *  needs this: strokes have to stay saturated, while the paper they sit on is the
 *  faded version. Same gradient, two strengths. */
vec3 meshOklab(vec2 p) {
  // The neutral's floor weight scales with how many colours there are. A fixed
  // 0.25 was fine against five saturated attractors but dominated one or two
  // pastels, flattening the gradient to a single tone.
  float floorW = uNeutralFloor;
  vec3 acc = uNeutralLab * floorW;
  float wsum = floorW;

  for (int i = 0; i < MAX_MESH; i++) {
    if (i >= uMeshCount) break;
    // attractors wander by a hair, so the pigment is never quite frozen
    vec2 c = uMeshPos[i].xy + 0.006 * vec2(
      cos(uWaveTime * 0.11 + float(i) * 2.1),
      sin(uWaveTime * 0.13 + float(i) * 1.7)
    );
    vec2 d = p - c;
    float rad = max(uMeshPos[i].z, 1e-3);
    float w = exp(-dot(d, d) / (rad * rad) * uMeshPos[i].w);
    acc += uMeshLab[i] * w;
    wsum += w;
  }

  return acc / wsum;
}

/** The paper. Mesh strength fades the attractors back toward the neutral pigment
 *  rather than changing how many there are. */
vec3 meshLin(vec2 p) {
  return oklabToLin(mix(uNeutralLab, meshOklab(p), uMesh));
}

// ===========================================================================
// domain warp
// ===========================================================================
/** Smooth low-frequency warp, four sinusoids, with an exact Jacobian.
 *
 *  An fbm warp would need its Jacobian estimated, and the normals would then
 *  describe the *unwarped* surface — the lighting would disagree with the
 *  geometry exactly where the warp is strongest. Sinusoids differentiate in
 *  closed form, and being low-frequency they bend the moiré cells without
 *  shredding them. */
vec2 warpPos(vec2 p, out vec4 jac) {
  if (uWarp <= 0.0001) {
    jac = vec4(1.0, 0.0, 0.0, 1.0); // d1/dx, d1/dy, d2/dx, d2/dy
    return p;
  }

  float a = uWarpFreq.x, b = uWarpFreq.y, c = uWarpFreq.z, d = uWarpFreq.w;
  vec2 w = vec2(
    sin(a * p.y + uWarpPhase.x) + 0.5 * sin(b * p.x + uWarpPhase.y),
    sin(c * p.x + uWarpPhase.z) + 0.5 * sin(d * p.y + uWarpPhase.w)
  );

  jac = vec4(
    1.0 + uWarp * 0.5 * b * cos(b * p.x + uWarpPhase.y),
    uWarp * a * cos(a * p.y + uWarpPhase.x),
    uWarp * c * cos(c * p.x + uWarpPhase.z),
    1.0 + uWarp * 0.5 * d * cos(d * p.y + uWarpPhase.w)
  );

  return p + uWarp * w;
}

// ===========================================================================
// waves
// ===========================================================================
/** One circular source. Returns its height contribution and, through `g`, the
 *  exact gradient of that contribution in warped space.
 *
 *  phase = k * r^power + phase0 + t * drift,  r = |S R(-rot) (q - centre)|
 *  dphase/dq = k * power * r^(power-1) * R(rot) (S e / r) */
/** One monochromatic source, as a complex phasor.
 *
 *  This is the change that makes clean interference possible. A bare sin(kr)
 *  carries only the instantaneous displacement, so there is no way to ask where
 *  the nodes *are* — only where the surface happens to be right now. Carrying
 *  the real and imaginary parts gives both at once:
 *
 *    Re(psi)   the displacement, which oscillates
 *    |psi|     the envelope, which does not
 *
 *  Because the time term sits inside the phase and every source shares it at full
 *  Resonance, e^(iwt) factors out of the sum — so |psi| is genuinely constant in
 *  time and the nodal lines never move. That is Young's pattern.
 *
 *  Amplitude falls as 1/sqrt(r): cylindrical spreading in 2D. Without it the
 *  fringes have no envelope and the field reads as a flat plaid rather than as
 *  waves radiating from somewhere. */
void sourcePhasor(int i, vec2 q, out vec2 psi, out vec2 dRe, out vec2 dIm) {
  vec2  pos = uSrcA[i].xy;
  float k   = uSrcA[i].z * uBreathe;
  float ph  = uSrcA[i].w;
  float rot = uSrcB[i].x;
  float pw  = uSrcB[i].y;
  float dr  = uSrcB[i].z;
  float amp = uSrcB[i].w;
  vec2  inv = uSrcC[i].xy;
  float wnd = uSrcC[i].z;

  // idle wander — a tiny Lissajous, enough to feel alive, far too small to
  // change which avatar this is
  pos += IDLE_WANDER * vec2(
    cos(uWaveTime * 0.19 + wnd),
    sin(uWaveTime * 0.23 + wnd * 1.7)
  );

  float cr = cos(rot), sr = sin(rot);
  vec2 d = q - pos;
  vec2 e = vec2(cr * d.x + sr * d.y, -sr * d.x + cr * d.y) * inv;
  float r = max(length(e), 1e-4);

  float theta = k * pow(r, pw) + ph + uWaveTime * dr;
  float dtheta = k * pw * pow(r, pw - 1.0);          // dtheta/dr

  // softened at the origin: 1/sqrt(r) is singular there, and a source sitting
  // inside the frame would otherwise punch a spike through the surface
  float soft = r + 0.15;
  float a  = amp * inversesqrt(soft);
  float da = -0.5 * amp * pow(soft, -1.5);           // da/dr

  vec2 u = (e / r) * inv;
  vec2 drdq = vec2(cr * u.x - sr * u.y, sr * u.x + cr * u.y);

  float c = cos(theta), sn = sin(theta);
  psi = vec2(a * c, a * sn);
  dRe = (da * c  - a * sn * dtheta) * drdq;
  dIm = (da * sn + a * c  * dtheta) * drdq;
}

/** Travelling disturbances from pointer and audio.
 *
 *  These do NOT add height. They displace the coordinates the permanent waves
 *  are evaluated at, so the existing waveform itself bulges, compresses and
 *  flows as the front passes — the way a reflection deforms on rippled water —
 *  rather than a second set of concentric rings appearing on top of it. When the
 *  displacement decays the pattern is exactly where it started.
 *
 *  Returns the displacement and accumulates its Jacobian into `jac` (packed as
 *  d1/dx, d1/dy, d2/dx, d2/dy). For a radial field D = n * f(r):
 *
 *      dD/dp = f'(r) (n (x) n) + (f(r)/r) (I - n (x) n)
 *
 *  Without that term the normals would describe the undisturbed surface and the
 *  light would slide over the deformation without registering it. */
vec2 interactionDisplace(vec2 p, inout vec4 jac) {
  vec2 disp = vec2(0.0);

  for (int i = 0; i < MAX_INT; i++) {
    if (i >= uIntCount) break;

    vec2  c    = uInt0[i].xy;
    float age  = uInt0[i].z;
    float str  = uInt0[i].w;
    float freq = uInt1[i].x;
    float spd  = uInt1[i].y;
    float dec  = uInt1[i].z;
    float wid  = uInt1[i].w;

    vec2 d = p - c;
    float r = max(length(d), 1e-5);
    vec2  n = d / r;

    float front  = r - spd * age;          // expanding wavefront
    float ripple = sin(freq * front);
    float amp    = str * exp(-age * dec);  // temporal decay
    float sharp  = 1.0 / max(wid * wid, 1e-5);
    float env    = exp(-front * front * sharp);   // energy rides the front

    // Taper to zero at the centre. A radial field carries an f(r)/r term, so
    // without this the Jacobian blows up at the point the user touched.
    float taper = smoothstep(0.0, 0.04, r);
    float dTaper = r < 0.04 ? 6.0 * r * (0.04 - r) / (0.04 * 0.04 * 0.04) : 0.0;

    float f = amp * ripple * env * taper;
    // d/dr, product rule over ripple, envelope and taper
    float df = amp * (
        (cos(freq * front) * freq * env - ripple * 2.0 * front * sharp * env) * taper
      + ripple * env * dTaper
    );

    disp += n * f;

    // f'(r) along n, f(r)/r across it
    float fr = f / r;
    jac.x += df * n.x * n.x + fr * (1.0 - n.x * n.x);
    jac.y += df * n.x * n.y - fr * n.x * n.y;
    jac.z += df * n.y * n.x - fr * n.y * n.x;
    jac.w += df * n.y * n.y + fr * (1.0 - n.y * n.y);
  }

  return disp;
}

/** The full height field and its gradient.
 *  `add` and `mul` are returned for the debug views. */
float heightField(vec2 p, out vec2 grad, out float add, out float mul) {
  vec4 jac;
  vec2 q = warpPos(p, jac);

  // Transient disturbances displace the coordinates the waves are read at, so
  // the deformation happens *inside* the existing waveform. Their Jacobian goes
  // into the same `jac` the warp filled, and both are undone together below.
  // Magnitude is folded into each ripple's strength on the CPU, which keeps the
  // displacement and its derivative scaled by exactly the same factor.
  if (uInteraction > 0.0001 && uIntCount > 0) q += interactionDisplace(p, jac);

  float v[MAX_SRC];
  vec2  g[MAX_SRC];
  int n = max(uSrcCount, 1);

  // Complex superposition. The sum is over phasors, not over displacements, so
  // the envelope survives the summation — that is what makes the nodal geometry
  // available at all.
  vec2 psi = vec2(0.0);
  vec2 psiRe = vec2(0.0);
  vec2 psiIm = vec2(0.0);

  for (int i = 0; i < MAX_SRC; i++) {
    if (i >= uSrcCount) break;
    vec2 ph_, dRe, dIm;
    sourcePhasor(i, q, ph_, dRe, dIm);
    psi   += ph_;
    psiRe += dRe;
    psiIm += dIm;
    v[i] = ph_.x;      // this source's instantaneous displacement
    g[i] = dRe;
  }

  psi   /= float(n);
  psiRe /= float(n);
  psiIm /= float(n);

  // --- additive field: the live displacement, and the standing envelope -----
  // Fringes blends from one to the other. The envelope is what a screen records
  // in the double-slit: perfectly static, with the nodes as fixed dark curves.
  float disp = psi.x;
  vec2  dispG = psiRe;

  float env = length(psi);
  vec2  envG = (psi.x * psiRe + psi.y * psiIm) / max(env, 1e-4);
  // centred, so the emboss has a mid-surface to sit either side of
  env = env * 1.6 - 0.55;
  envG *= 1.6;

  add = mix(disp, env, uFringe);
  vec2 addG = mix(dispG, envG, uFringe);

  // --- multiplicative field: the moiré term --------------------------------
  // Multiplying sines produces sum and difference frequencies, which is what
  // turns overlapping rings into cells, capsules and hollow repeating
  // intersections. Differentiated with the exact product rule.
  mul = 1.0;
  for (int i = 0; i < MAX_SRC; i++) {
    if (i >= uSrcCount) break;
    mul *= v[i];
  }

  vec2 mulG = vec2(0.0);
  for (int i = 0; i < MAX_SRC; i++) {
    if (i >= uSrcCount) break;
    float others = 1.0;
    for (int j = 0; j < MAX_SRC; j++) {
      if (j >= uSrcCount) break;
      if (j != i) others *= v[j];
    }
    mulG += g[i] * others;
  }

  // A product of n sines has RMS (1/sqrt2)^n, so without this the surface would
  // flatten out every time a wave is added.
  float norm = pow(1.414, float(n));
  mul *= norm;
  mulG *= norm;

  float base = mix(add, mul, uMix);
  vec2  baseG = mix(addG, mulG, uMix);

  // --- profile (thickness) -------------------------------------------------
  // A bounded monotone remap: low thickness squares the profile off into flat
  // plateaus joined by narrow steep walls, and only the walls catch the light.
  float k = uProfile;
  float tk = tanh(k);
  float shaped = tanh(base * k) / tk;
  float t2 = shaped * tk;
  baseG *= k * (1.0 - t2 * t2) / tk;

  // --- back to undisplaced space ------------------------------------------
  // grad_p = J^T grad_q, where J covers the warp and the disturbances together
  grad = vec2(
    jac.x * baseG.x + jac.z * baseG.y,
    jac.y * baseG.x + jac.w * baseG.y
  );

  return shaped;
}

// ===========================================================================
// medium engine
// ===========================================================================
/** Shaped height of the medium at one point, including warp and stretch of the
 *  sampling coordinates so those controls still apply here too.
 *
 *  One channel, because the medium is one physical field. Every origin, every
 *  touch and every syllable is already superposed inside it, so there is nothing
 *  left to combine here — and that is the point. Interference in this engine is
 *  the real thing rather than an operator applied to separate fields afterwards.
 *  Interference now acts on the drive instead: see mediumSourceWeight. */
float mediumSample(vec2 p, out float add, out float mul) {
  vec4 jac;
  vec2 q = warpPos(p, jac);
  q = vec2(0.5) + (q - vec2(0.5)) * uMediumStretch;

  // The lattice spans the full origin range, so the visible frame is only its
  // middle. Both write and read use this same mapping, so the stored image being
  // vertically flipped relative to the screen never matters.
  float v = texture(uMediumTex, q * uMediumMap.x + uMediumMap.y).r * uMediumGain;

  add = v;
  mul = v;
  float k = uProfile;
  return tanh(v * k) / tanh(k);
}

float mediumHeight(vec2 p, out vec2 grad, out float add, out float mul) {
  vec2 e = uMediumTexel * 1.5;
  float a, m;

  float h   = mediumSample(p, add, mul);
  float hx1 = mediumSample(p + vec2(e.x, 0.0), a, m);
  float hx0 = mediumSample(p - vec2(e.x, 0.0), a, m);
  float hy1 = mediumSample(p + vec2(0.0, e.y), a, m);
  float hy0 = mediumSample(p - vec2(0.0, e.y), a, m);

  grad = vec2((hx1 - hx0) / (2.0 * e.x), (hy1 - hy0) / (2.0 * e.y));
  return h;
}

// ===========================================================================
// shape masks
// ===========================================================================
float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

float shapeSD(vec2 p) {
  float s = uShapeSize;
  if (uShape == 1) return length(p) - s;
  if (uShape == 2) return sdRoundedBox(p, vec2(s), s * 0.28);
  return -1.0;
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

/** Smooth value noise. Needed by granularity, which perturbs the *normal* and
 *  therefore has to be differentiable — hashed white noise would give a normal
 *  that changes completely between neighbouring pixels and read as static. */
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

/** Granular relief: bedforms plus grains, as a normal perturbation.
 *
 *  Applied to the normal rather than to the height field on purpose. Adding it
 *  to the height would put it through the wave equation's analytic gradient,
 *  where it is not differentiable in closed form, and it would feed the
 *  interference — grains are a property of the surface, not another wave.
 *
 *  Two scales, and the coarse one matters most. Sand ripples are *static
 *  bedforms*: they are shaped by wind over hours and then stay put. They are not
 *  travelling waves, and trying to get them out of the medium does not work —
 *  a granular material damps so hard that its waves die within a quarter of the
 *  frame, so unless an origin happens to sit inside the visible area there is
 *  nothing to see. Modelling the ripples as relief instead is both cheaper and
 *  closer to the real thing, and it makes the look independent of where the
 *  seed happened to put the origins.
 *
 *  The bedform is stretched along uAnisoDir, because ripples run perpendicular
 *  to the wind and a circular noise reads as gravel rather than as dune. */
float granularHeight(vec2 p) {
  vec2 t = uAnisoDir;
  vec2 q = vec2(dot(p, t) * 0.22, dot(p, vec2(-t.y, t.x)));  // 4.5x along the wind
  float dune = vnoise(q * 13.0) + 0.5 * vnoise(q * 27.0 + 4.1);
  float grit = vnoise(p * 210.0) + 0.5 * vnoise(p * 520.0 + 11.3);
  return dune * 0.85 + grit * 0.12;
}

vec3 granularNormal(vec2 uv, vec3 n) {
  if (uGranularity < 0.001) return n;
  const float E = 0.0016;
  float h0 = granularHeight(uv);
  float hx = granularHeight(uv + vec2(E, 0.0));
  float hy = granularHeight(uv + vec2(0.0, E));
  vec2 g = vec2(hx - h0, hy - h0) / E;
  return normalize(n + vec3(-g.x, 0.0, -g.y) * uGranularity * 0.06);
}

/** Thin-film interference: colour from optical path length, which on a height
 *  field is the height itself. A cosine palette offset per channel is the cheap
 *  standard for this and is what gives the oil-slick banding.
 *
 *  Fresnel is folded into the phase so the bands sweep as the surface turns
 *  away, rather than sitting on it like printed stripes. */
vec3 thinFilm(float h, float fres) {
  float phase = h * 3.4 + fres * 1.7;
  return 0.5 + 0.5 * cos(6.28318 * (phase + vec3(0.0, 0.33, 0.67)));
}

// ===========================================================================
void main() {
  // y down, so origins, mesh attractors and the pointer share one convention
  // with the DOM overlay that positions the handles
  vec2 uv = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) / uResolution;

  // --- geometry -----------------------------------------------------------
  vec2 grad;
  float add, mul;
  float h = uEngine == 1
    ? mediumHeight(uv, grad, add, mul)   // the field is a vibrating medium
    : heightField(uv, grad, add, mul);   // closed-form waves

  // Declared up here because the grain leans on surface steepness and the debug
  // views need these intermediates, both of which outlive the shading below.
  vec3 col;
  float steep = 0.0;
  vec3 normal = vec3(0.0, 1.0, 0.0);
  float diffuse = 0.0;
  float hl = 0.0;
  float sh = 0.0;
  vec2 refr = vec2(0.0);

  // Depth arrives pre-divided by the base frequency, so a denser pattern has
  // proportionally smaller ripples instead of ever-steeper walls — the light
  // stays readable as Density moves.
  vec2 slopeVec = grad * uDepth * (1.0 + uAudio.y * 0.6);
  normal = normalize(vec3(-slopeVec.x, 1.0, -slopeVec.y));
  // Grain-scale relief, added to the normal after the wave normal is built so
  // it textures the surface without entering the physics.
  normal = granularNormal(uv, normal);

  // --- pigment, refracted by the surface ----------------------------------
  // Offsetting along the normal means flat areas split by nothing at all and
  // only steep ridges fringe. A constant RGB offset over the whole frame would
  // read as a printing fault instead of as glass.
  refr = normal.xz * uChromatic * (1.0 + uAudio.w * 0.9);

  vec3 pigment;
  if (uChromatic > 0.0005) {
    // Three samples, wavelength-ordered: red bends least, blue most.
    //
    // The ratio spread has to be *wide*. What separates the channels is not the
    // offset itself but the distance between the red and blue sample points —
    // 1.4/1.0/0.6 spans only 0.8x the offset, and since the offset is already
    // scaled by normal.xz (typically ~0.35), the two ends landed about 0.05 UV
    // apart. The pigment is a gaussian mesh with radius ~0.6, so over 0.05 UV it
    // is essentially one colour and the slider did nothing: measured 1.4 levels
    // out of 255 across its whole range.
    pigment = vec3(
      meshLin(uv + refr * 1.8).r,
      meshLin(uv + refr * 1.0).g,
      meshLin(uv + refr * 0.2).b
    );
  } else {
    pigment = meshLin(uv);
  }

  // --- light --------------------------------------------------------------
  vec3 L = uLightDir;
  diffuse = max(dot(normal, L), 0.0);

  // Signed slope along the light's heading. Positive faces the light, negative
  // faces away, so every ridge gets a bright edge and a dark opposite edge —
  // this is what makes the surface read as embossed rather than as drawn lines.
  vec2 lh = normalize(L.xz + vec2(1e-6, 0.0));
  float facing = -dot(slopeVec, lh);
  hl = max(facing, 0.0);
  sh = max(-facing, 0.0);
  // soft-limit: a steep ridge should saturate, not blow out
  hl = hl / (1.0 + hl);
  sh = sh / (1.0 + sh);

  steep = length(slopeVec);
  steep = steep / (1.0 + steep);

  // Surface material. Metallic tightens the specular lobe and strengthens it —
  // a broad soft sheen becomes a hard narrow glint, which is most of what
  // separates a wet surface from a polished one.
  vec3 V = vec3(0.0, 1.0, 0.0);
  vec3 Hv = normalize(L + V);
  float specPow = mix(22.0, 220.0, uMetallic);
  float specAmt = mix(0.26, 1.9, uMetallic);

  float ndh = max(dot(normal, Hv), 0.0);
  float spec = pow(ndh, specPow)
             * uSpecular * specAmt * uLightIntensity * (0.25 + 0.75 * steep);

  // Anisotropic sheen: a Ward lobe with unequal roughness along and across the
  // grain. Wide along it, tight across it, which is what turns the round
  // specular dot of a smooth surface into the streak you get off brushed metal
  // or satin.
  //
  // Added alongside the isotropic term rather than replacing it, so a material
  // with the slider at zero renders exactly as it did before this existed.
  //
  // A first attempt tried to fake this by squashing the half-vector's
  // across-grain component and feeding it back into the Blinn exponent. It
  // measured 0.4 levels out of 255 across the slider's whole range — because
  // the squashed deviation exceeded 1 almost everywhere, the clamp took it to
  // zero, and the control was quietly *removing* the highlight instead of
  // stretching it.
  if (uAnisotropy > 0.001) {
    vec3 traw = vec3(uAnisoDir.x, 0.0, uAnisoDir.y);
    vec3 T = normalize(traw - normal * dot(normal, traw));
    vec3 B = cross(normal, T);
    float hn = max(dot(Hv, normal), 1e-4);
    float ht = dot(Hv, T);
    float hb = dot(Hv, B);
    float ax = 0.45;                                 // along the grain: broad
    // Across it: tight, but not arbitrarily so. At 14x the lobe was narrow
    // enough to resolve individual granular normals and the streak broke up
    // into glitter; 8x keeps it a streak on a textured surface.
    float ay = 0.45 / (1.0 + uAnisotropy * 8.0);
    float lobe = exp(-2.0 * ((ht * ht) / (ax * ax) + (hb * hb) / (ay * ay)) / (1.0 + hn));
    spec += lobe * uSpecular * specAmt * uLightIntensity * uAnisotropy * 2.2;
  }

  // Lambert, normalised so a flat surface returns the pigment unchanged. The
  // light is here to reveal slope, not to raise the exposure of the whole
  // frame — without this the pigment clips to white and the mesh gradient the
  // material is made of stops being visible at all.
  //
  // Translucency wraps that term around the terminator. In a scattering
  // material light enters, bounces below the surface and leaves somewhere it
  // was never directly lit, so the dark side is never fully dark and the falloff
  // is soft rather than a hard edge at dot(n,L) = 0. Wrapped diffuse is the
  // standard cheap stand-in and it is the whole difference between wax and
  // plastic.
  float wrap = uTranslucency * 0.9;
  float nl = (dot(normal, L) + wrap) / (1.0 + wrap);
  diffuse = max(nl, 0.0);
  float lambert = uAmbient + (1.0 - uAmbient) * diffuse / max(L.y, 0.15);

  // The signed-slope term: a bright edge and a dark opposite edge on every
  // ridge, which is what separates an embossed surface from drawn lines.
  float emboss = hl * 0.6 - sh * uShadowDepth * 0.9;

  // Flat sits below 1 so highlights have headroom to climb into. Chrome darkens
  // the diffuse floor: a metal takes almost none of its brightness from diffuse
  // scatter, so leaving it high is what makes fake chrome look like grey plastic.
  float base = mix(0.82, 0.42, uMetallic);
  float shade = base + (lambert - 1.0 + emboss) * uLightIntensity;

  // Highlights stay the hue of the pigment beneath them — turquoise becomes
  // lighter turquoise — with only a small neutral lift at the very brightest
  // edges. Shadows are darker pigment, never black.
  col = pigment * max(shade, 0.0);

  // Forward scatter: thin, steeply tilted parts of the surface glow with their
  // own pigment where the light is behind them. Steepness stands in for
  // thinness, which is what an edge-lit translucent material does.
  if (uTranslucency > 0.001) {
    float back = pow(max(dot(-normal, L), 0.0), 2.0);
    col += pigment * (back * 0.55 + steep * 0.22) * uTranslucency * uLightIntensity;
  }

  col += vec3(1.0, 0.99, 0.96) * (hl * hl * 0.09 + spec) * uLightIntensity;

  // Thin film. Applied after shading and scaled by the specular fresnel, so it
  // rides on the surface as a reflection would rather than tinting the body of
  // the material. Screen-blended: a film adds colour, it does not replace it.
  if (uIridescence > 0.001) {
    float fres0 = pow(1.0 - clamp(normal.y, 0.0, 1.0), 1.5);
    vec3 film = thinFilm(h, fres0);
    float amt = uIridescence * (0.25 + 0.75 * fres0);
    col = col + film * amt * (0.35 + 0.65 * max(shade, 0.0));
  }

  // --- restrained fake reflection -----------------------------------------
  // No environment map: the material reflects its own pigment, sampled through
  // the normal. Depth still comes from the directional light.
  // Fresnel-weighted, so it appears at grazing angles on the ridge flanks rather
  // than uniformly. Chrome leans on this heavily — with no environment to
  // reflect, the pigment sampled through the normal is what stands in for one.
  float fres = pow(1.0 - clamp(normal.y, 0.0, 1.0), 2.0);
  float reflAmt = mix(0.1, 0.72, uMetallic);
  float reflSpread = mix(0.3, 0.85, uMetallic);
  col = mix(col, meshLin(uv + normal.xz * reflSpread) * mix(1.05, 1.3, uMetallic),
            fres * reflAmt);

  // --- tonemap ------------------------------------------------------------
  col *= uExposure * (1.0 + 0.1 * uAudio.x);
  col = toSrgb(col);
  col = (col - 0.5) * uContrast + 0.5;

  // --- grain --------------------------------------------------------------
  // Stationary by design. A temporal term reads as video noise; this should
  // read as pigment, paper or a print screen.
  if (uGrain > 0.0001) {
    vec2 gp = floor(vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y)
                    / max(uGrainScale, 0.5));
    vec3 s1 = vec3(hash21(gp + 1.7), hash21(gp + 11.3), hash21(gp + 23.9)) - 0.5;
    vec3 s2 = vec3(hash21(gp * 0.5 + 71.1), hash21(gp * 0.5 + 37.7),
                   hash21(gp * 0.5 + 91.3)) - 0.5;
    col += s1 * uGrain;
    col += s2 * uGrain * 0.5 * (0.4 + 0.6 * steep);
  }

  // --- debug views --------------------------------------------------------
  if (uDebug != 0) {
    if (uDebug == 1) col = toSrgb(meshLin(uv));
    else if (uDebug == 2) col = vec3(add * 0.5 + 0.5);
    else if (uDebug == 3) col = vec3(mul * 0.5 + 0.5);
    else if (uDebug == 4) col = vec3(h * 0.5 + 0.5);
    else if (uDebug == 5) col = normal * 0.5 + 0.5;
    else if (uDebug == 6) col = vec3(diffuse);
    else if (uDebug == 7) col = vec3(hl);
    else if (uDebug == 8) col = vec3(sh);
    else if (uDebug == 9) col = vec3(length(refr) * 6.0);
  }

  // --- shape mask ---------------------------------------------------------
  vec2 cp = (uv - 0.5) * 2.0;
  float mask = 1.0 - smoothstep(-uShapeSoft, uShapeSoft, shapeSD(cp));
  col = mix(uMatte, col, mask);

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
