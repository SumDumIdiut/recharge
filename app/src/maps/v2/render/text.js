// The level's TextMeshPro text, laid out with its own font atlases and baked to a canvas.
export class TextBaker {
  constructor(base, images) {
    this.fonts = base.scene.fonts || [];
    this.images = images;
    this.sizes = new WeakMap();
  }

  glyph(fontIdx, code) {
    const own = this.fonts[fontIdx];
    if (own && own.chars[code]) return [fontIdx, own.chars[code]];
    for (let i = 0; i < this.fonts.length; i++) if (this.fonts[i] && this.fonts[i].chars[code]) return [i, this.fonts[i].chars[code]];
    return null;
  }

  layout(t, fontSize) {
    const font = this.fonts[t.f] || this.fonts.find(Boolean);
    const unit = (fontSize * t.k) / font.point * (font.scale || 1);
    const lineStep = font.line * unit + t.ls * 0.01 * fontSize * t.k;
    const charSpace = t.cs * 0.01 * fontSize * t.k;
    const innerW = t.w - (t.m[0] + t.m[2]) * t.k, innerH = t.h - (t.m[1] + t.m[3]) * t.k;
    const advance = (ch) => { const g = this.glyph(t.f, ch.codePointAt(0)); return g ? g[1][6] * ((fontSize * t.k) / this.fonts[g[0]].point) + charSpace : fontSize * t.k * 0.3; };
    const lines = [];
    for (const para of t.t.split('\n')) {
      let line = '', width = 0;
      for (const word of para.split(/(?<= )/)) {
        const w = [...word].reduce((a, ch) => a + advance(ch), 0);
        if (t.wrap && line && width + w > innerW + 0.01) { lines.push([line, width]); line = word.trimStart(); width = [...line].reduce((a, ch) => a + advance(ch), 0); }
        else { line += word; width += w; }
      }
      lines.push([line, width]);
    }
    const ascent = font.ascent * unit, descent = Math.abs(font.descent || 0) * unit;
    return { lines, lineStep, ascent, blockH: ascent + descent + (lines.length - 1) * lineStep, widest: Math.max(...lines.map((l) => l[1])), innerW, innerH };
  }

  size(t) {
    let s = this.sizes.get(t);
    if (s !== undefined) return s;
    if (!t.auto) s = t.size;
    else {
      const fits = (size) => { const l = this.layout(t, size); return l.widest <= l.innerW + 0.01 && l.blockH <= l.innerH + 0.01; };
      let lo = t.auto[0], hi = Math.min(t.auto[1], 600);
      if (fits(hi)) s = hi;
      else { for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; } s = lo; }
    }
    this.sizes.set(t, s);
    return s;
  }

  // { canvas, x0, top, px }: the text's glyphs in its own units (y up), px canvas pixels a unit.
  bake(t) {
    if (!this.fonts.length) return null;
    const size = this.size(t), L = this.layout(t, size);
    const left = -t.w / 2 + t.m[0] * t.k, right = t.w / 2 - t.m[2] * t.k;
    const top = t.h / 2 - t.m[1] * t.k, bottom = -t.h / 2 + t.m[3] * t.k;
    const va = t.va & 256 ? 'top' : t.va & 1024 ? 'bottom' : 'middle';
    const blockTop = va === 'top' ? top : va === 'bottom' ? bottom + L.blockH : (top + bottom) / 2 + L.blockH / 2;
    const quads = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    L.lines.forEach(([line, width], i) => {
      const align = t.ha & 4 ? 'right' : t.ha & (2 | 32) ? 'center' : 'left';
      let pen = align === 'right' ? right - width : align === 'center' ? (left + right) / 2 - width / 2 : left;
      const baseline = blockTop - L.ascent - i * L.lineStep;
      for (const ch of line) {
        const g = this.glyph(t.f, ch.codePointAt(0));
        if (!g) { pen += size * t.k * 0.3; continue; }
        const [fi, [ax, ay, aw, ah, bx, by, adv, mw, mh]] = g;
        const u = (size * t.k) / this.fonts[fi].point;
        const q = { fi, ax, ay, aw, ah, x: pen + bx * u, y: baseline + by * u, w: mw * u, h: mh * u };
        if (q.w > 0 && q.h > 0) {
          quads.push(q);
          minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x + q.w); minY = Math.min(minY, q.y - q.h); maxY = Math.max(maxY, q.y);
        }
        pen += adv * u + t.cs * 0.01 * size * t.k;
      }
    });
    if (!quads.length) return null;
    const px = Math.min(3, 1024 / Math.max(maxX - minX, maxY - minY, 1));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil((maxX - minX) * px));
    cv.height = Math.max(1, Math.ceil((maxY - minY) * px));
    const g = cv.getContext('2d');
    for (const q of quads) { const img = this.images['font:' + q.fi]; if (img) g.drawImage(img, q.ax, q.ay, q.aw, q.ah, (q.x - minX) * px, (maxY - q.y) * px, q.w * px, q.h * px); }
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = t.c;
    g.fillRect(0, 0, cv.width, cv.height);
    return { canvas: cv, x0: minX, top: maxY, px };
  }
}
