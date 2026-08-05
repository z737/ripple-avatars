#version 300 es
precision highp float;

// ---------------------------------------------------------------------------
// Chromatic ripple field.
//
// Pipeline (see PLAN.md §1):
//   warp coords -> N anisotropic radial sources -> interference (product|sum)
//   -> isoline extraction with fwidth() AA -> per-layer chroma offsets
//   -> OKLab mesh gradient ink over paper field -> derivative lighting
//   -> per-channel grain -> SDF shape mask -> tonemap
//
// The isoline step is the important one: line width is expressed in units of
// fwidth(field), so when the field's gradient outruns the pixel rate the
// contour coverage self-cancels and dense regions fade to flat tone instead
// of aliasing into moire speckle. That degradation *is* the look.
// ---------------------------------------------------------------------------

#define MAX_SRC    4
#define MAX_LAYERS 5
#define MAX_INK    5

out vec4 fragColor;

uniform vec2  uResolution;
uniform float uTime;
uniform float uSpeed;

// --- wave field ---
uniform int   uSourceCount;
uniform vec4  uSrcA[MAX_SRC];   // xy = position, zw = anisotropic scale
uniform vec4  uSrcB[MAX_SRC];   // x = rotation, y = frequency, z = phase, w = radial power
uniform vec4  uSrcC[MAX_SRC];   // x = phase drift, y = amplitude
uniform float uInterference;    // 0 = multiplicative (cells), 1 = additive (beats)
uniform float uDensity;
uniform float uLineWidth;
uniform float uBleed;

// --- domain warp ---
uniform float uWarpAmount;
uniform float uWarpScale;
uniform int   uWarpOctaves;

// --- chromatic layers ---
uniform int   uLayers;
uniform float uChromaSplit;
uniform float uChromaPhase;
uniform vec2  uChromaDir;
uniform float uHueSpread;       // how far apart layers sample the ink gradient
uniform float uCoreGlow;        // brightening where layers coincide

// --- colour ---
uniform int   uInkCount;
uniform vec3  uInk[MAX_INK];    // sRGB
uniform vec2  uInkPos[MAX_INK];
uniform vec3  uPaperA;
uniform vec3  uPaperB;
uniform vec3  uMatte;           // colour outside the shape mask
uniform float uExposure;
uniform float uContrast;

// --- surface ---
uniform float uLight;
uniform vec2  uLightDir;

// --- texture ---
uniform float uGrain;
uniform float uGrainScale;

// --- shape ---
uniform int   uShape;           // 0 full, 1 circle, 2 square, 3 capsule, 4 drop
uniform float uShapeSize;
uniform float uShapeSoft;

// ===========================================================================
// hash / noise
// ===========================================================================
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p, int oct) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    if (i >= oct) break;
    s += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

// ===========================================================================
// colour space — OKLab, so mesh gradients don't go grey at the midpoint.
// An sRGB lerp between cyan and orange (reference image 7) muddies badly.
// ===========================================================================
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 toSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec3 linToOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  vec3 k = pow(max(vec3(l, m, s), 0.0), vec3(1.0 / 3.0));
  return vec3(
    0.2104542553 * k.x + 0.7936177850 * k.y - 0.0040720468 * k.z,
    1.9779984951 * k.x - 2.4285922050 * k.y + 0.4505937099 * k.z,
    0.0259040371 * k.x + 0.7827717662 * k.y - 0.8086757660 * k.z
  );
}

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

// Inverse-distance-weighted mesh gradient, blended in OKLab.
vec3 meshInk(vec2 p) {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < MAX_INK; i++) {
    if (i >= uInkCount) break;
    float d = distance(p, uInkPos[i]);
    float w = 1.0 / (pow(d, 2.4) + 0.006);
    acc += linToOklab(toLinear(uInk[i])) * w;
    wsum += w;
  }
  return oklabToLin(acc / max(wsum, 1e-5));
}

// ===========================================================================
// wave field
// ===========================================================================
float sourceField(int i, vec2 uv) {
  vec2  pos   = uSrcA[i].xy;
  vec2  scale = uSrcA[i].zw;
  float rot   = uSrcB[i].x;
  float freq  = uSrcB[i].y;
  float phase = uSrcB[i].z;
  float power = uSrcB[i].w;
  float drift = uSrcC[i].x;
  float amp   = uSrcC[i].y;

  float c = cos(rot), s = sin(rot);
  vec2 q = mat2(c, -s, s, c) * (uv - pos);
  q /= max(scale, vec2(1e-3));

  // power > 1 compresses the centre and opens the outer rings -> "tunnel"
  float r = pow(max(length(q), 1e-4), power);

  return amp * sin(r * freq * uDensity + phase + uTime * uSpeed * drift);
}

// Product of sources gives true moire cells: sin(a)*sin(b) = k traces Lame
// curves (rounded squares) where the fringe families cross, and hyperbolic
// arcs away from that region. That is exactly reference images 3, 6 and 7.
// Sum gives soft beating instead. Blend between them.
float field(vec2 uv) {
  float prod = 1.0;
  float sum  = 0.0;
  for (int i = 0; i < MAX_SRC; i++) {
    if (i >= uSourceCount) break;
    float v = sourceField(i, uv);
    prod *= v;
    sum  += v;
  }
  return mix(prod, sum / float(max(uSourceCount, 1)), uInterference);
}

// Isoline with analytic antialiasing. `w` is line half-width in pixels.
float contour(float v, float level, float w) {
  float d  = abs(v - level);
  float aa = max(fwidth(v), 1e-6) * 0.7071;
  return 1.0 - smoothstep(w * aa, (w + 1.0) * aa, d);
}

// Cell spacing scales with render resolution but a pixel line width does not,
// so a fixed value covers a much larger fraction of each cell in a 384px
// thumbnail than in a 2048px export — same parameters, different artwork.
// Scaling the width with resolution keeps ink coverage, and therefore how much
// paper shows through, consistent across preview, thumbnail and export.
float scaledLineWidth() {
  return uLineWidth * max(uResolution.y / 640.0, 0.35);
}

// ===========================================================================
// shape masks
// ===========================================================================
float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

float sdCapsule(vec2 p, float h, float r) {
  p.y -= clamp(p.y, -h, h);
  return length(p) - r;
}

float sdDrop(vec2 p, float r) {
  // teardrop: circle whose radius tapers with height
  p.y += r * 0.15;
  float k = 1.0 - 0.42 * clamp(p.y / r + 0.5, 0.0, 1.6);
  return length(vec2(p.x / max(k, 0.2), p.y)) - r;
}

float shapeSD(vec2 p) {
  float s = uShapeSize;
  if (uShape == 1) return length(p) - s;
  if (uShape == 2) return sdRoundedBox(p, vec2(s), s * 0.22);
  if (uShape == 3) return sdCapsule(p, s * 0.45, s * 0.72);
  if (uShape == 4) return sdDrop(p, s);
  return -1.0; // full bleed
}

// ===========================================================================
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 res  = uResolution;

  // centred, aspect-corrected, ~[-1,1] on the short axis
  vec2 uv = (frag - 0.5 * res) / min(res.x, res.y) * 2.0;

  // --- domain warp, computed ONCE (not per chromatic layer). Warping per
  // layer costs layers x octaves noise evaluations for a difference nobody
  // can see. ~4x saving on the dominant cost.
  vec2 wuv = uv;
  if (uWarpAmount > 0.0001) {
    vec2 n = vec2(
      fbm(uv * uWarpScale + vec2(0.0, uTime * uSpeed * 0.05), uWarpOctaves),
      fbm(uv * uWarpScale + vec2(5.2, 1.3 - uTime * uSpeed * 0.04), uWarpOctaves)
    ) - 0.5;
    wuv += n * uWarpAmount;
  }

  // --- chromatic ink layers ---------------------------------------------
  vec3  ink  = vec3(0.0);
  float cov  = 0.0;   // max coverage: is there ink here at all
  float wsum = 0.0;   // total coverage: how many layers overlap here
  float hsum = 0.0;   // sharpened weight, for hue selection
  float bleed = 0.0;

  float lw = scaledLineWidth();
  float denom = float(max(uLayers - 1, 1));
  for (int L = 0; L < MAX_LAYERS; L++) {
    if (L >= uLayers) break;
    float t = float(L) / denom - 0.5;

    // Split is scaled by 1/density so it stays a constant fraction of the cell
    // spacing. As an absolute offset it would exceed a whole cell at high
    // density and flood the paper.
    vec2  luv = wuv + uChromaDir * (uChromaSplit / max(uDensity, 0.1)) * t;
    float v   = field(luv);
    float m   = contour(v, uChromaPhase * t, lw);

    // each layer reads the mesh gradient at a slightly different place, so
    // neighbouring contours land in different hues -> the chromatic edges
    vec2 mp = uv * 0.5 + 0.5 + uChromaDir.yx * uHueSpread * t;
    vec3 c  = meshInk(mp);

    // Hue is picked by a sharpened weight so the dominant layer wins rather
    // than all overlapping layers averaging into a pastel mid-hue. A plain
    // mean is what turns saturated strokes into washed-out mush.
    float hw = m * m * m;
    ink  += c * hw;
    hsum += hw;
    cov   = max(cov, m);
    wsum += m;
    bleed = max(bleed, contour(v, uChromaPhase * t, lw + 5.0));
  }

  // Brighten only by how much the layers actually overlap. Plain additive
  // blows straight to white as soon as two layers touch; this keeps a lone
  // stroke fully saturated and reserves the pale cores for genuine crossings,
  // as in references 2 and 5.
  vec3 inkHue = ink / max(hsum, 1e-4);
  float overlap = clamp(wsum - cov, 0.0, 2.5);
  ink = inkHue * (1.0 + overlap * uCoreGlow);

  // --- paper field -------------------------------------------------------
  float pn = fbm(uv * 1.1 + 3.7, 2);
  float env = 0.5 + 0.5 * field(wuv * 0.35);
  vec3 paper = mix(toLinear(uPaperA), toLinear(uPaperB), clamp(pn * 0.75 + env * 0.35, 0.0, 1.0));

  // --- composite. Additive ink over paper: where several layers coincide
  // the sum brightens to a pale core, where one covers you get its hue.
  // Matches the white cores in the dense regions of references 2 and 5.
  vec3 col = mix(paper, ink, clamp(cov, 0.0, 1.0));
  col += ink * bleed * uBleed * 0.22;

  // --- fake surface from the height field's derivatives ------------------
  if (uLight > 0.001) {
    float h = field(wuv);
    vec2  g = vec2(dFdx(h), dFdy(h));
    vec3  nrm = normalize(vec3(-g * 8.0, 1.0));
    vec3  ldir = normalize(vec3(uLightDir, 0.85));
    float lit = 0.5 + 0.5 * dot(nrm, ldir);
    float spec = pow(max(lit, 0.0), 24.0);
    col *= mix(1.0, lit * 1.35, uLight);
    col += spec * uLight * 0.25;
  }

  // --- tonemap -----------------------------------------------------------
  col *= uExposure;
  col = (col - 0.5) * uContrast + 0.5;
  col = toSrgb(col);

  // --- grain. Three tiers: static paper, pigment-in-colour, slow temporal.
  // Per-channel and independent, which is what produces the RGB speckle
  // visible in the flat areas of references 5-7.
  if (uGrain > 0.0001) {
    vec2 gp = floor(frag / max(uGrainScale, 0.5));
    vec3 s1 = vec3(hash21(gp + 1.7), hash21(gp + 11.3), hash21(gp + 23.9)) - 0.5;
    vec3 s2 = vec3(hash21(gp * 0.5 + 71.1), hash21(gp * 0.5 + 37.7), hash21(gp * 0.5 + 91.3)) - 0.5;
    float tq = floor(uTime * 3.0);
    vec3 s3 = vec3(hash21(gp + tq * 13.1), hash21(gp + tq * 29.3), hash21(gp + tq * 47.7)) - 0.5;

    col += s1 * uGrain;                                  // paper
    col += s2 * uGrain * 0.5 * clamp(cov + 0.35, 0.0, 1.0); // pigment
    col += s3 * uGrain * 0.18 * uSpeed;                  // temporal, subtle
  }

  // --- shape mask --------------------------------------------------------
  float sd = shapeSD(uv);
  float mask = 1.0 - smoothstep(-uShapeSoft, uShapeSoft, sd);
  col = mix(uMatte, col, mask);

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
