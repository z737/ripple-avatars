#version 300 es

// Fullscreen triangle. No attributes, no buffers — position is derived from
// gl_VertexID, so the whole "scene" is a 3-vertex drawArrays call.
void main() {
  vec2 p = vec2(
    (gl_VertexID == 1) ? 3.0 : -1.0,
    (gl_VertexID == 2) ? 3.0 : -1.0
  );
  gl_Position = vec4(p, 0.0, 1.0);
}
