/* Plays the real Cento animations (exported from assets/mascot) on a canvas, pixel-perfect. */
export async function loadCento() { const r = await fetch('/cento.json'); return r.json(); }

export class Cento {
  constructor(canvas, data, { px = 6 } = {}) { this.c = canvas; this.d = data; this.px = px; this.name = null; this.i = 0; this.t = null; this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches; }
  set(name) {
    if (!this.d.anims[name] || name === this.name) return; this.name = name; this.i = 0; clearTimeout(this.t);
    const a = this.d.anims[name]; this.c.width = a.w * this.px; this.c.height = a.h * this.px; this.c.setAttribute('aria-label', 'Cento: ' + a.desc);
    this.draw(); if (!this.reduced) this.tick();
  }
  draw() {
    const a = this.d.anims[this.name], f = a.frames[this.i % a.frames.length], g = this.c.getContext('2d'); g.clearRect(0, 0, this.c.width, this.c.height);
    f.rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) { const ch = row[x]; if (ch !== '.' && this.d.palette[ch]) { g.fillStyle = this.d.palette[ch]; g.fillRect(x * this.px, y * this.px, this.px, this.px); } } });
  }
  tick() { const a = this.d.anims[this.name]; this.t = setTimeout(() => { this.i = (this.i + 1) % a.frames.length; this.draw(); this.tick(); }, a.frames[this.i % a.frames.length].d); }
  desc(name) { return this.d.anims[name]?.desc ?? ''; }
}
