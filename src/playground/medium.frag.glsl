#version 300 es
precision highp float;

// ---------------------------------------------------------------------------
// The medium: one physical scalar field on a lattice of coupled oscillators.
//
//   du/dt = v
//   dv/dt = c^2 * laplacian(u)  -  W0(p)^2 * u  -  g * v  +  F(p,t)
//
// A damped Klein-Gordon equation: a membrane on an elastic foundation. The
// -W0^2*u term is what makes every point of the field a resonator in its own
// spring rather than a bead on a string, and it gives the medium a dispersion
// relation
//
//   W^2 = W0^2 + c^2 * |k|^2
//
// so the per-point frequency decides whether energy propagates or stays put,
// and a spatially varying W0 refracts waves toward the slacker regions.
//
// ONE FIELD, NOT FOUR. Every origin, every pointer touch and every syllable
// injects into the same u. That is the whole point of the change: interference
// here is genuine linear superposition, with real beats between detuned sources,
// real nodal lines, and real reflection off the boundary. The previous version
// ran four independent fields and multiplied them at render time, which produced
// convincing moiré but is not something a medium can do — multiplication is an
// operator applied to two fields, not an interaction between them.
//
// STATE IS (u, v), which is complete, so this ping-pongs between two textures.
// The earlier leapfrog needed u(n-1) as well, and reading that from the texture
// being rendered into is exactly the feedback loop GL forbids.
//
// Units are real: seconds, and UV per second. Nothing here is expressed per
// frame, so the physics is identical at any display rate.
// ---------------------------------------------------------------------------

#define MAX_SRC 4
#define MAX_IMP 4

out vec4 fragColor;

uniform sampler2D uState;    // rg = (displacement, velocity)
uniform vec2  uTexel;
uniform float uDt;           // seconds per step
uniform float uC2H2;         // c^2 / h^2, so the raw 5-point stencil is enough
uniform float uGamma;        // velocity damping, 1/s
uniform vec2  uAbsorb;       // x: layer width in uv, y: extra damping at the edge
uniform vec4  uOmega0;       // x centre rad/s, y spread rad/s, z unused, w map scale
uniform vec2  uFreqPhase;

uniform int   uSrcCount;
uniform vec4  uDrive[MAX_SRC];  // xy position, z tap phase in radians, w amplitude
uniform float uDriveSigma;
uniform float uTapWidth;        // pulse duration, as a fraction of a tap period

uniform int   uImpCount;
uniform vec4  uImp[MAX_IMP];    // xy position, z radius, w amplitude

/** Per-point natural frequency, rad/s.
 *
 *  Smooth and low-frequency by design: a noisy map would scatter every wave
 *  within a texel or two and the field would read as grain rather than as
 *  structure. Two sinusoids give a slowly undulating landscape of stiffer and
 *  slacker regions, which is what produces trapped pockets and neighbours that
 *  beat against each other.
 *
 *  Resonance closes the spread: at 1 every point agrees on a frequency and the
 *  field pulses as one; at 0 they disagree, and those differences are what put
 *  waves in the frame. Mirrored exactly by omega0At() in mapping.ts, which the
 *  panel's frequency map draws — the two must not drift apart. */
float omega0(vec2 uv) {
  float s = uOmega0.w;
  float n = sin(uv.x * s + uFreqPhase.x) * sin(uv.y * s * 0.87 + uFreqPhase.y)
          + 0.5 * sin((uv.x + uv.y) * s * 0.61 - uFreqPhase.x);
  return max(uOmega0.x + n * uOmega0.y * 0.4, 0.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;

  vec2 st = texture(uState, uv).rg;
  float u = st.x;
  float v = st.y;

  float lap =
      texture(uState, uv + vec2(uTexel.x, 0.0)).r
    + texture(uState, uv - vec2(uTexel.x, 0.0)).r
    + texture(uState, uv + vec2(0.0, uTexel.y)).r
    + texture(uState, uv - vec2(0.0, uTexel.y)).r
    - 4.0 * u;

  float w0 = omega0(uv);
  float acc = uC2H2 * lap - w0 * w0 * u;

  // --- forcing -------------------------------------------------------------
  // The origins *tap* the surface rather than holding it at a frequency. This is
  // the whole reason the per-point frequency is visible: a continuously driven
  // medium settles at the drive frequency regardless of what its points prefer,
  // so W0 would only affect amplitude and wavelength. Struck instead, each region
  // rings at its own natural frequency between taps.
  //
  // The pulse is short so it is broadband — it has to contain energy across the
  // whole spread of W0 for every point to find its own resonance in it.
  //
  // Every origin taps the same field. Their ripples meet and superpose; nothing
  // combines them afterwards.
  for (int i = 0; i < MAX_SRC; i++) {
    if (i >= uSrcCount) break;
    vec2 d = uv - uDrive[i].xy;
    float g = exp(-dot(d, d) / (uDriveSigma * uDriveSigma));
    float t = fract(uDrive[i].z / 6.2831853);
    float dd = min(t, 1.0 - t) / max(uTapWidth, 1e-4);
    acc += uDrive[i].w * exp(-dd * dd) * g;
  }

  // Pointer and transient excitation, into the same field.
  for (int i = 0; i < MAX_IMP; i++) {
    if (i >= uImpCount) break;
    vec2 d = uv - uImp[i].xy;
    float r2 = max(uImp[i].z * uImp[i].z, 1e-6);
    acc += uImp[i].w * exp(-dot(d, d) / r2);
  }

  // --- absorbing boundary --------------------------------------------------
  // Damping ramps up through a margin outside the visible frame, so a wave is
  // dissipated before it can reach the lattice edge and reflect. Without this the
  // boundary is free: waves bounced and came back through the frame as
  // criss-crossing standing structure.
  //
  // Squared and smoothstepped because a sharp rise in damping is itself an
  // impedance discontinuity and reflects nearly as much as the hard edge did.
  vec2 toEdge = min(uv, 1.0 - uv);
  float edge = min(toEdge.x, toEdge.y);
  float sponge = 1.0 - smoothstep(0.0, uAbsorb.x, edge);
  float gamma = uGamma + uAbsorb.y * sponge * sponge;

  // Semi-implicit (symplectic) Euler: damp the velocity, then advance position
  // with the new velocity. Stable for oscillators as long as dt*W < 2, and it
  // does not bleed energy the way explicit Euler does. Damping as exp(-g*dt) is
  // unconditionally stable for any g, which is what lets the sponge be strong.
  v = (v + acc * uDt) * exp(-gamma * uDt);
  u = u + v * uDt;

  fragColor = vec4(clamp(u, -8.0, 8.0), clamp(v, -400.0, 400.0), 0.0, 1.0);
}
