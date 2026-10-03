// WebGL2: textured quads drawn instanced. A quad is one record of FLOATS numbers:
// centre (x, y), its 2x2 matrix (a, b, c, d: world = centre + M * local), its local
// rect (x0, y0, x1, y1, y up), the texture rect (u0, v0 top, u1, v1 bottom) and a
// tint (r, g, b, a, multiplied in, premultiplied).
export const FLOATS = 18;

const VS = `#version 300 es
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_mat;
layout(location = 2) in vec4 a_rect;
layout(location = 3) in vec4 a_uv;
layout(location = 4) in vec4 a_tint;
uniform vec2 u_cam;
uniform vec2 u_scale;
out vec2 v_uv;
out vec4 v_tint;
void main() {
  float cx = float(gl_VertexID & 1), cy = float(gl_VertexID >> 1);
  vec2 local = vec2(mix(a_rect.x, a_rect.z, cx), mix(a_rect.y, a_rect.w, cy));
  vec2 world = a_pos + vec2(a_mat.x * local.x + a_mat.y * local.y, a_mat.z * local.x + a_mat.w * local.y);
  gl_Position = vec4((world - u_cam) * u_scale, 0.0, 1.0);
  v_uv = vec2(mix(a_uv.x, a_uv.z, cx), mix(a_uv.w, a_uv.y, cy));
  v_tint = a_tint;
}`;

const FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv;
in vec4 v_tint;
out vec4 color;
void main() { color = texture(u_tex, v_uv) * v_tint; }`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
  return s;
}

export class GL {
  static supported() {
    try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
  }

  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(p));
    this.program = p;
    this.uCam = gl.getUniformLocation(p, 'u_cam');
    this.uScale = gl.getUniformLocation(p, 'u_scale');
    this.uTex = gl.getUniformLocation(p, 'u_tex');
    this.scratch = this.batch();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  }

  // An image or canvas as a texture: { tex, w, h }.
  texture(img, { mip = false } = {}) {
    const gl = this.gl, tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (mip) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    return { tex, w: img.width, h: img.height };
  }
  dropTexture(t) { if (t?.tex) this.gl.deleteTexture(t.tex); }

  // A vertex array and buffer for a run of quads; fill() it, draw() it.
  batch() {
    const gl = this.gl, vao = gl.createVertexArray(), buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const stride = FLOATS * 4;
    [[0, 2, 0], [1, 4, 2], [2, 4, 6], [3, 4, 10], [4, 4, 14]].forEach(([loc, n, off]) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    });
    gl.bindVertexArray(null);
    return { vao, buf, count: 0, cap: 0 };
  }
  fill(b, data, count = data.length / FLOATS, usage = this.gl.STATIC_DRAW) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
    const bytes = count * FLOATS;
    if (usage === gl.DYNAMIC_DRAW && b.cap >= bytes) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, bytes);
    else { gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, bytes), usage); b.cap = bytes; }
    b.count = count;
  }
  dropBatch(b) { if (!b) return; this.gl.deleteBuffer(b.buf); this.gl.deleteVertexArray(b.vao); }

  begin(w, h, cam, bg) {
    const gl = this.gl;
    gl.viewport(0, 0, w, h);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.uCam, cam.x, cam.y);
    gl.uniform2f(this.uScale, (2 * cam.scale) / w, (2 * cam.scale) / h);
    gl.uniform1i(this.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
  }
  draw(b, texture, from = 0, count = b.count) {
    if (!count || !texture) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture.tex);
    gl.bindVertexArray(b.vao);
    if (from) {
      // Instanced attributes start at `from`: point them past it.
      gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
      const stride = FLOATS * 4, base = from * stride;
      [[0, 2, 0], [1, 4, 2], [2, 4, 6], [3, 4, 10], [4, 4, 14]].forEach(([loc, n, off]) => gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride, base + off * 4));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      [[0, 2, 0], [1, 4, 2], [2, 4, 6], [3, 4, 10], [4, 4, 14]].forEach(([loc, n, off]) => gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride, off * 4));
    } else gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  }
  // Quads made this frame (sprites, texts): written into the shared scratch batch and drawn.
  drawNow(data, count, texture) {
    if (!count) return;
    this.fill(this.scratch, data, count, this.gl.DYNAMIC_DRAW);
    this.draw(this.scratch, texture);
  }
}

// Writes one quad into `out` at quad index `i`.
export function quad(out, i, x, y, m, x0, y0, x1, y1, u0, v0, u1, v1, r = 1, g = 1, b = 1, a = 1) {
  const o = i * FLOATS;
  out[o] = x; out[o + 1] = y;
  out[o + 2] = m[0]; out[o + 3] = m[1]; out[o + 4] = m[2]; out[o + 5] = m[3];
  out[o + 6] = x0; out[o + 7] = y0; out[o + 8] = x1; out[o + 9] = y1;
  out[o + 10] = u0; out[o + 11] = v0; out[o + 12] = u1; out[o + 13] = v1;
  out[o + 14] = r * a; out[o + 15] = g * a; out[o + 16] = b * a; out[o + 17] = a;
}
