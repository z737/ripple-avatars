#version 300 es
precision highp float;

// ---------------------------------------------------------------------------
// 16 components, merged with a smooth minimum.
//
// The gooey effect is the reason this is a distance field rather than 16 divs.
// The usual web technique — blur the shapes, then push the result through a
// contrast curve so the blur's soft shoulder snaps back to a hard edge — needs
// an offscreen pass, costs fill rate every frame, and softens the corners that
// are the whole point of this mark.
//
// A smooth minimum does it exactly. Where two fields come within `k` of each
// other they blend with a fillet, and that fillet *is* the goo: a neck of
// surface forms between two components and thins as they part. No blur, no
// threshold, no second render target, and the corner radii stay razor sharp
// everywhere the merge is not happening.
//
// Colour rides the same blend factor the distance uses, so a merged neck reads
// as a gradient between the two components instead of one colour winning.
//
// No background: the canvas is transparent and the mark composites onto the
// page, so the components displace against nothing at all.
// ---------------------------------------------------------------------------

#define N 16
#define PI 3.14159265359

out vec4 fragColor;

uniform vec2  uResolution;
/** square: (cx, cy, halfW, halfH) · circle: (rMid, aMid, rHalf, aHalf) */
uniform vec4  uTile[N];
uniform vec4  uRadii[N];  // per-corner radius, as a fraction of the half-extent
uniform vec3  uColor[N];  // display-ready sRGB, built in OKLCH on the CPU
uniform int   uLayout;    // 0 square, 1 circle, 2 abstract
uniform float uGoo;       // smooth-min radius, in uv units
uniform int   uSelected;

// --- abstract only ---------------------------------------------------------
/** r = component id + 1, g = fused-cluster id + 1; 0 for an empty cell.
 *  Integer texture, fetched by index: no filtering, so no ambiguity at a cell
 *  boundary. */
uniform highp usampler2D uMask;
uniform int   uGridN;      // cells per side
uniform float uCellHalf;   // half-extent of one cell, gutter already removed
uniform float uAbsRadius;  // one radius for all four corners of every cell
uniform int   uReach;      // cells to search either side, from the goo radius
uniform vec2  uPointer;
uniform float uHover;      // 0 at rest, 1 under the pointer, sprung
uniform float uHoverR;     // radius of the pointer's influence, uv
uniform float uHoverGoo;   // extra smooth-min radius at the pointer
uniform float uHoverGrow;  // extra cell size at the pointer

/** Rounded box with four different corner radii.
 *
 *  The standard rounded-box SDF takes one radius; the corner is chosen first by
 *  quadrant and then fed into the same formula. Radii are a fraction of the
 *  smaller half-extent, clamped, because a radius past the half extent inverts
 *  the corner and turns the shape inside out. */
float sdBoxCorners(vec2 p, vec2 b, vec4 r) {
  vec2 pair = (p.x > 0.0) ? vec2(r.y, r.z) : vec2(r.x, r.w); // (top, bottom)
  float rad = (p.y > 0.0) ? pair.x : pair.y;
  rad = clamp(rad, 0.0, 1.0) * min(b.x, b.y);

  vec2 q = abs(p) - b + rad;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - rad;
}

/** One component's field.
 *
 *  In circle mode the point is unrolled into the cell's own frame: the angular
 *  offset scaled by the mid radius becomes an arc length, so an annular sector
 *  is measured as if it were a straight box. That is an approximation — arc
 *  length is not constant across the band — but it is continuous, and exact
 *  along the mid radius where the eye reads the edge. The centre disc has no
 *  angular extent, so it is flagged and handled as a plain circle. */
float sdComponent(vec2 uv, vec4 A, vec4 r) {
  if (uLayout == 0) {
    return sdBoxCorners(uv - A.xy, A.zw, r);
  }

  vec2 q = uv - 0.5;

  if (A.w >= PI - 0.001) return length(q) - A.z;   // centre disc

  float rad = length(q);
  float d = atan(q.y, q.x) - A.y;
  d = atan(sin(d), cos(d));                        // wrap to [-PI, PI]

  return sdBoxCorners(vec2(d * A.x, rad - A.x), vec2(A.w * A.x, A.z), r);
}

/** Polynomial smooth minimum, returning the blend factor so colour can follow
 *  the same mix the distance does. */
vec2 sminBlend(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return vec2(mix(b, a, h) - k * h * (1.0 - h), h);
}

/** Gaussian bump under the pointer. Everything the hover does in abstract mode
 *  is a function of this one field, so the reach-out and the swell stay in step
 *  instead of drifting apart at the edges of the influence. */
float hoverBump(vec2 p) {
  vec2 q = p - uPointer;
  return exp(-dot(q, q) / (uHoverR * uHoverR)) * uHover;
}

/** Abstract: sixteen clusters of small squares, merged.
 *
 *  The 16-component loop above cannot be reused here — a 64x64 grid is 4096
 *  cells, far past any uniform array, and evaluating all of them per fragment
 *  would be absurd anyway. Instead the mask lives in a texture and only the
 *  cells that can actually reach this fragment are evaluated.
 *
 *  That bound is exact, not a guess: sminBlend clamps h, so a field further
 *  than k away contributes precisely nothing. uReach is computed on the CPU
 *  from the current cell size and goo radius, which is why the cost is flat in
 *  the grid resolution — nine fetches at rest whether the grid is 16 or 64. */
void abstractField(vec2 uv, out float d, out vec3 col) {
  d = 1e9;
  col = vec3(0.0);

  float cw = 1.0 / float(uGridN);
  ivec2 base = ivec2(floor(uv / cw));
  float bump = hoverBump(uv);

  // Two fillet radii, and the split is what makes Bonding mean anything.
  //
  // `inner` fuses cells that belong to the same cluster, and has to be close to
  // a whole cell wide or the cluster keeps the staircase outline of the squares
  // it was cut from. But the channel left between two unbonded clusters is only
  // about one cell wide too, so one radius for everything would weld the entire
  // disc into a single mass however Bonding was set.
  //
  // `outer` is therefore zero at rest — clusters meet with a hard minimum,
  // which never bulges, so the channels stay exactly as wide as the geometry
  // makes them. The pointer is the only thing that opens it, and that *is* the
  // interaction: hovering is what attaches one component to the one beside it.
  float inner = max(uGoo + uHoverGoo * bump, 1e-5);
  float outer = max(uHoverGoo * bump, 1e-5);

  uint grpAcc = 0u;
  bool first = true;

  for (int dy = -uReach; dy <= uReach; dy++) {
    for (int dx = -uReach; dx <= uReach; dx++) {
      ivec2 c = base + ivec2(dx, dy);
      if (c.x < 0 || c.y < 0 || c.x >= uGridN || c.y >= uGridN) continue;

      uvec2 s = texelFetch(uMask, c, 0).rg;
      uint id = s.r;
      uint grp = s.g;
      if (id == 0u) continue;

      vec2 ctr = (vec2(c) + 0.5) * cw;
      // Cells swell toward the pointer, which is what lets a blob reach across
      // a gap and take hold of the one next to it. Sizing the swell by the cell
      // centre rather than by the fragment keeps each square a square.
      float hs = uCellHalf * (1.0 + uHoverGrow * hoverBump(ctr));

      float di = sdBoxCorners(uv - ctr, vec2(hs), vec4(uAbsRadius));
      vec3 ci = uColor[int(id) - 1];

      if (first) {
        d = di;
        col = ci;
        grpAcc = grp;
        first = false;
      } else {
        float k = (grp == grpAcc) ? inner : outer;
        vec2 m = sminBlend(d, di, k);
        // The nearer of the two fields owns the accumulator's cluster, so the
        // comparison has to happen before d is replaced.
        if (di < d) grpAcc = grp;
        d = m.x;
        col = mix(ci, col, m.y);
      }
    }
  }
}

void main() {
  // y down, so component 0 is top-left in both the shader and the editor
  vec2 uv = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) / uResolution;
  float px = 1.0 / uResolution.y;

  float d;
  vec3 col;
  float sel = 0.0;

  if (uLayout == 2) {
    // No selection ring: abstract has no per-corner radii to point at.
    abstractField(uv, d, col);
  } else {
    float k = max(uGoo, 1e-5);

    d = sdComponent(uv, uTile[0], uRadii[0]);
    col = uColor[0];
    sel = (uSelected == 0) ? 1.0 : 0.0;

    for (int i = 1; i < N; i++) {
      float di = sdComponent(uv, uTile[i], uRadii[i]);
      vec2 m = sminBlend(d, di, k);
      d = m.x;
      // h is 1 where the accumulator dominates, 0 where the new component does
      col = mix(uColor[i], col, m.y);
      sel = mix((uSelected == i) ? 1.0 : 0.0, sel, m.y);
    }
  }

  // 1.5px of feather: enough to kill the stair-step without visibly softening
  // the corners this mark is built from.
  float a = 1.0 - smoothstep(-0.75 * px, 0.75 * px, d);

  // Selection marker for the radius editor, drawn just outside the component so
  // it never covers the corner being adjusted.
  float ring = smoothstep(2.6 * px, 1.2 * px, abs(d + 2.4 * px)) * step(0.5, sel);
  col = mix(col, vec3(0.13), ring * 0.85);
  a = max(a, ring * 0.85);

  // Premultiplied: WebGL composites the canvas that way by default, and without
  // it the feathered edge picks up a dark fringe against a light page.
  fragColor = vec4(col * a, a);
}
