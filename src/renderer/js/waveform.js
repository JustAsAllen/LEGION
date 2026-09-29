/**
 * Waveform / spectrum strip.
 *
 * Draws the measured spectrum from the audio engine. During SPEAKING it shows
 * the TTS output; during LISTENING it shows the microphone; otherwise it
 * settles into a slow idle breath so the strip never looks frozen.
 */

export class Waveform {
  constructor(canvas, audio) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.audio = audio;
    this.bars = 56;
    this.smooth = new Float32Array(this.bars);
    this.idle = 0;
    this.mode = 'idle';
    this.accent = [53, 200, 255];
    this.visible = true;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.resize();
  }

  resize() {
    const c = this.canvas;
    const rect = c.getBoundingClientRect();
    const w = Math.max(1, Math.round((rect.width || 520) * this.dpr));
    const h = Math.max(1, Math.round((rect.height || 64) * this.dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }

  setAccent(rgb) { this.accent = rgb; }

  /**
   * The `showWaveform` setting reached nothing, so the strip was always drawn.
   * When it is off the canvas is hidden and the draw call is skipped entirely
   * rather than clearing a 520x64 surface every frame for no visible result.
   */
  setVisible(on) {
    const show = on !== false;
    this.visible = show;
    this.canvas.hidden = !show;
    if (!show && this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(state, dt) {
    if (this.visible === false) return;
    this.resize();
    const g = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.clearRect(0, 0, W, H);

    const active = state === 'LISTENING' || state === 'SPEAKING';
    const [r, gg, b] = this.accent;

    // Idle breath: a low, slow travelling wave so the strip always lives.
    this.idle += dt * (state === 'PROCESSING' ? 3.4 : 1.15);
    let levels = this.audio.spectrum();
    let peakSum = 0;
    for (let i = 0; i < levels.length; i++) peakSum += levels[i];
    const mean = peakSum / levels.length;

    if (!active) {
      for (let i = 0; i < this.bars; i++) {
        const phase = this.idle + i * 0.32;
        const v = 0.10 + 0.05 * Math.sin(phase) + 0.03 * Math.sin(phase * 2.3);
        this.smooth[i] += (v - this.smooth[i]) * Math.min(1, dt * 4);
      }
    } else {
      const span = mean > 0.01;
      for (let i = 0; i < this.bars; i++) {
        const raw = span ? levels[Math.min(levels.length - 1, Math.floor(Math.pow(i / this.bars, 1.4) * levels.length))] : 0;
        const target = Math.min(1, raw);
        const k = target > this.smooth[i] ? Math.min(1, dt * 26) : Math.min(1, dt * 11);
        this.smooth[i] += (target - this.smooth[i]) * k;
      }
    }

    const bw = W / this.bars;
    const barW = Math.max(1.5, bw * 0.52);
    const midY = H / 2;
    const maxH = H * 0.46;

    for (let i = 0; i < this.bars; i++) {
      const v = this.smooth[i];
      const h = Math.max(1.5 * this.dpr, v * maxH);
      const x = i * bw + (bw - barW) / 2;
      const alpha = active ? 0.35 + v * 0.65 : 0.22 + v * 0.4;
      const grad = g.createLinearGradient(0, midY - h, 0, midY + h);
      grad.addColorStop(0, `rgba(${r}, ${gg}, ${b}, ${alpha})`);
      grad.addColorStop(0.5, `rgba(${r}, ${gg}, ${b}, ${alpha * 0.85})`);
      grad.addColorStop(1, `rgba(${r}, ${gg}, ${b}, ${alpha})`);
      g.fillStyle = grad;
      const rr = Math.min(barW / 2, 2.5 * this.dpr);
      roundRect(g, x, midY - h, barW, h * 2, rr);
      g.fill();
    }

    // Centre line
    g.fillStyle = active ? `rgba(${r}, ${gg}, ${b}, 0.22)` : 'rgba(126,158,200,0.12)';
    g.fillRect(0, midY - 0.5 * this.dpr, W, this.dpr);
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
