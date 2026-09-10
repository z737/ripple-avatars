#version 300 es
precision highp float;

// ---------------------------------------------------------------------------
// 16 tiles, each a quad with four independently rounded corners.
//
// Every tile is evaluated for every pixel and the nearest one wins. That is 16
// signed-distance evaluations per fragment, which is nothing — and it is the
// reason overlap works: tiles move when hovered, so a pixel cannot be assigned
// to a cell by its coordinates alone. Picking by distance instead of by cell
// handles the moment two tiles slide over each other for free.
// ---------------------------------------------------------------------------

#define N 16

out vec4 fragColor;

uniform vec2  uResolution;
uniform vec4  uTile[N];   // xy centre, z half-size, w unused
uniform vec4  uRadii[N];  // per-corner radius in half-size units: tl, tr, br, bl
uniform vec3  uColor[N];  // display-ready sRGB, built in OKLCH on the CPU
uniform vec3  uBg;
uniform int   uSelected;  // tile being edited, -1 for none

/** Rounded box with four different corner radii.
 *
 *  The standard rounded-box SDF takes one radius; the corner is chosen first by
 *  quadrant and then fed into the same formula. Radii arrive as a fraction of
 *  the half-size and are clamped to it, because a radius larger than the half
 *  extent inverts the corner and the shape turns inside out. */
float sdTile(vec2 p, float hs, vec4 r) {
  // pick this quadrant's radius: x>0 chooses right, y>0 chooses top
  vec2 pair = (p.x > 0.0) ? vec2(r.y, r.z) : vec2(r.x, r.w); // (top, bottom)
  float rad = (p.y > 0.0) ? pair.x : pair.y;
  rad = clamp(rad, 0.0, 1.0) * hs;   // `half` is a reserved word in GLSL ES

  vec2 q = abs(p) - hs + rad;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - rad;
}

void main() {
  // y down, so tile 0 is top-left in both the shader and the editor
  vec2 uv = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) / uResolution;

  // One pixel in uv, for antialiasing. The SDF is exact, so a single fwidth of
  // the *coordinate* is enough — no need to differentiate the distance itself.
  float px = 1.0 / uResolution.y;

  vec3 col = uBg;
  float bestD = 1e9;
  vec3 bestC = uBg;
  float bestRing = 0.0;

  for (int i = 0; i < N; i++) {
    float d = sdTile(uv - uTile[i].xy, uTile[i].z, uRadii[i]);
    if (d < bestD) {
      bestD = d;
      bestC = uColor[i];
      bestRing = (i == uSelected) ? 1.0 : 0.0;
    }
  }

  // 1.5px of feather: enough to kill the stair-step on a near-flat edge without
  // visibly softening the corners.
  float cov = 1.0 - smoothstep(-0.75 * px, 0.75 * px, bestD);
  col = mix(col, bestC, cov);

  // Selection marker for the radius editor — an outline just outside the tile,
  // so it never hides the corner being adjusted.
  if (bestRing > 0.5) {
    float ring = smoothstep(2.6 * px, 1.2 * px, abs(bestD + 2.4 * px));
    col = mix(col, vec3(0.13), ring * 0.85);
  }

  fragColor = vec4(col, 1.0);
}
