import * as THREE from '../vendor/three.module.js';
import { buildGlyphAtlas } from './glyph-atlas.js';
import { ParticleField } from './particle-field.js';

/**
 * STAGE
 * =====
 * Owns the WebGL context, the framing, and the mapping from LEGION's state
 * machine onto visual parameters. Every value below is a *target*; the render
 * loop eases the live uniforms toward those targets, which is what makes state
 * changes feel like a continuous physical process rather than a cut.
 */

const QUALITY_TIERS = {
  low:    { instances: 2000, size: 0.30, energyScale: 0.75 },
  medium: { instances: 4000, size: 0.29, energyScale: 0.88 },
  high:   { instances: 7000, size: 0.28, energyScale: 1.0 },
  ultra:  { instances: 11000, size: 0.27, energyScale: 1.0 }
};
const TIER_ORDER = ['low', 'medium', 'high', 'ultra'];

const PALETTE = {
  base:    new THREE.Color(0.58, 0.74, 0.96),
  feature: new THREE.Color(0.84, 0.91, 1.00),
  accent:  new THREE.Color(0.20, 0.76, 1.00),
  alert:   new THREE.Color(1.00, 0.40, 0.30),
  amber:   new THREE.Color(1.00, 0.66, 0.20)
};

/**
 * `themeAccent: true` marks a state that follows the user's chosen theme colour.
 * ALERT and ERROR deliberately keep fixed colours: an amber/red warning that
 * recoloured into a pale blue or mint theme would stop reading as a warning.
 */
const STATE_TARGETS = {
  OFFLINE:    { energy: 0.10, form: 0.00, intensity: 0.10, size: 0.26, scan: 0.00, dissolve: 0.00, accent: PALETTE.base, alertMix: 0, themeAccent: true },
  BOOTING:    { energy: 1.00, form: 0.00, intensity: 0.55, size: 0.34, scan: 0.30, dissolve: 0.10, accent: PALETTE.accent, alertMix: 0, themeAccent: true },
  IDLE:       { energy: 0.30, form: 1.00, intensity: 1.00, size: 0.32, scan: 0.00, dissolve: 0.00, accent: PALETTE.accent, alertMix: 0, themeAccent: true },
  LISTENING:  { energy: 0.60, form: 1.00, intensity: 1.30, size: 0.32, scan: 0.12, dissolve: 0.00, accent: PALETTE.accent, alertMix: 0, themeAccent: true },
  PROCESSING: { energy: 0.95, form: 1.00, intensity: 1.15, size: 0.33, scan: 0.42, dissolve: 0.13, accent: PALETTE.accent, alertMix: 0, themeAccent: true },
  SPEAKING:   { energy: 0.52, form: 1.00, intensity: 1.20, size: 0.32, scan: 0.00, dissolve: 0.00, accent: PALETTE.accent, alertMix: 0, themeAccent: true },
  ALERT:      { energy: 0.72, form: 1.00, intensity: 1.22, size: 0.33, scan: 0.16, dissolve: 0.04, accent: PALETTE.amber, alertMix: 0.55, themeAccent: false },
  ERROR:      { energy: 0.38, form: 0.92, intensity: 0.90, size: 0.33, scan: 0.10, dissolve: 0.28, accent: PALETTE.alert, alertMix: 0.85, themeAccent: false }
};

function damp(current, target, lambda, dt) {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));
}
function dampColor(cur, target, lambda, dt) {
  const t = 1 - Math.exp(-lambda * dt);
  cur.r += (target.r - cur.r) * t;
  cur.g += (target.g - cur.g) * t;
  cur.b += (target.b - cur.b) * t;
}

export class FaceStage {
  constructor(container, options) {
    this.container = container;
    this.opts = Object.assign({ quality: 'high', particleScale: 1, reducedMotion: false, themeIntensity: 1, bloom: true }, options || {});

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,
      powerPreference: 'high-performance',
      stencil: false,
      depth: false
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'legion-canvas';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 400);
    this.camera.position.set(0, 0.4, 44);
    this.lookTarget = new THREE.Vector3(0, 0.4, 0);

    this.atlas = buildGlyphAtlas(this.renderer);
    // Always size the buffers for the largest tier. A fixed capacity means a
    // quality change is a single instanceCount write and never a reallocation,
    // and it cannot silently clip a cloud if the tier was raised later.
    this.field = new ParticleField(this.atlas, Math.ceil(QUALITY_TIERS.ultra.instances * 1.6));

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.group.add(this.field.mesh);

    /* live / target parameter pairs */
    this.state = 'BOOTING';
    this.live = { energy: 1.0, form: 0.0, intensity: 0.2, size: 0.32, scan: 0.0, dissolve: 0.0, alertMix: 0.0 };
    this.target = Object.assign({}, STATE_TARGETS.BOOTING);
    this.accentLive = new THREE.Color().copy(PALETTE.accent);
    this.accentTarget = PALETTE.accent;
    // The user's chosen theme colour and glow, applied to whichever states
    // opt in via themeAccent. Kept separate from the live/target pair so a
    // theme change re-derives the current accent instead of overwriting it.
    this.themeAccent = PALETTE.accent.clone();
    this.themeGlow = 1;
    this.scanlineAlpha = 0.5;

    this.audio = { low: 0, mid: 0, high: 0, mouth: 0, energy: 0 };
    this.mouthOpen = 0;
    this.browRaise = 0;
    this.blink = 0;
    this.nextBlink = 2 + Math.random() * 4;
    this.blinkPhase = 0;
    this.gaze = new THREE.Vector2(0, 0);
    this.gazeTarget = new THREE.Vector2(0, 0);
    this.nextSaccade = 1.5 + Math.random() * 3;

    this.pointer = new THREE.Vector2(0, 0);
    this.pointerSmooth = new THREE.Vector2(0, 0);
    this.panelShift = 0;
    this.panelShiftTarget = 0;

    this.quality = this.opts.quality;
    // Seed the user's explicit choice, otherwise a persisted tier looks
    // unpinned and adaptive quality is free to climb past what was asked for.
    this.userQuality = this.opts.quality;
    // Read the persisted policy from options rather than assuming defaults, so
    // a returning launch starts in the state the user left it in. The boot
    // path does not re-apply these, so anything ignored here is ignored all
    // session until the setting is touched.
    this.adaptive = this.opts.adaptive !== false;
    this.scanlines = this.opts.scanlines !== false;
    this.particleScale = this.opts.particleScale;
    this.themeIntensity = this.opts.themeIntensity;
    this.reducedMotion = this.opts.reducedMotion;

    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.running = false;
    this.bootStart = 0;
    this.fps = 60;
    this._frames = 0;
    this._fpsAccum = 0;
    this._sinceQualityChange = 0;
    this._goodWindows = 0;

    this._resize = this._resize.bind(this);
    this._frame = this._frame.bind(this);
    this._onPointer = this._onPointer.bind(this);

    window.addEventListener('resize', this._resize);
    window.addEventListener('pointermove', this._onPointer, { passive: true });
    this._resize();
  }

  /* ------------------------------------------------------------- */

  _onPointer(e) {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    this.pointer.set((e.clientX / w - 0.5) * 2, (e.clientY / h - 0.5) * 2);
  }

  _resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality === 'ultra' ? 2 : 1.5);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.field.uniforms.uPixelRatio.value = dpr;
    this.camera.aspect = w / h;
    this._fit();
  }

  _fit() {
    const aspect = this.camera.aspect || 1;
    const fov = this.camera.fov * Math.PI / 180;
    // Frame the head: ~24 units of vertical space, and never less than 21 wide.
    const needH = Math.max(24.5, 21.5 / Math.max(aspect, 0.35));
    const dist = needH / (2 * Math.tan(fov / 2));
    this.baseDistance = dist;
    this.lookTarget.set(0, 0.4, 0);
  }

  setState(next) {
    if (!STATE_TARGETS[next]) return;
    this.state = next;
    this.target = Object.assign({}, STATE_TARGETS[next]);
    this._retargetAccent();
    if (next === 'BOOTING') this.bootStart = this.elapsed;
  }

  /**
   * Recompute the accent the field is easing toward. States flagged
   * themeAccent follow the user's theme; the rest use their fixed colour.
   */
  _retargetAccent() {
    this.accentTarget = this.target.themeAccent ? this.themeAccent : this.target.accent;
  }

  /** Boot: converge the cloud into the face over a few seconds. */
  runBootSequence(durationMs) {
    this.bootStart = this.elapsed;
    this.bootDuration = (durationMs || 3400) / 1000;
  }

  /**
   * Hand a freshly sampled cloud to the field.
   *
   * The stage is the renderer-facing surface, so the upload lives here rather
   * than in the renderer: the cloud is generated once at full size, and the
   * quality tier then decides how much of it is drawn. `_applyQuality` runs
   * after the upload so the tier's instance count wins over the raw cloud size.
   */
  setCloud(data) {
    if (!data || !data.positions || !data.count) {
      throw new Error('setCloud: the sampler returned no usable point cloud');
    }
    this.field.setCloud(data);
    this.cloudCount = this.field.total;
    this._applyQuality();
    return this.cloudCount;
  }

  setQuality(tier) {
    if (!QUALITY_TIERS[tier]) return;
    this.userQuality = tier;
    this.quality = tier;
    this._applyQuality();
  }

  setParticleScale(scale) {
    this.particleScale = Math.max(0.2, Math.min(2.5, Number(scale) || 1));
    this._applyQuality();
  }

  setThemeIntensity(v) { this.themeIntensity = Math.max(0.15, Math.min(1.6, Number(v) || 1)); }
  setReducedMotion(v) {
    this.reducedMotion = !!v;
    this.field.uniforms.uReducedMotion.value = v ? 1 : 0;
  }

  /** Adaptive quality is a stage-level policy, not a per-frame decision. */
  setAdaptive(v) {
    this.adaptive = v !== false;
    if (!this.adaptive) {
      // Pin the tier the user asked for and stop the drift.
      this.setQuality(this.userQuality || this.quality);
    }
  }

  /**
   * Scanlines are the CSS overlay, not a shader uniform: the field shader has
   * no uScanlines, so toggling one did nothing visible. The flag is kept for
   * callers that read it, and the overlay is driven from a body class the same
   * way reduced-motion already is.
   */
  setScanlines(on) {
    this.scanlines = !!on;
    document.body.classList.toggle('no-scanlines', !this.scanlines);
  }

  /**
   * Per-theme scanline strength. The overlay is a CSS layer, so the value is
   * published as a custom property rather than stored and never read.
   */
  setScanlineAlpha(v) {
    this.scanlineAlpha = Math.max(0, Math.min(1, Number(v) || 0));
    document.documentElement.style.setProperty('--scan-alpha', String(this.scanlineAlpha));
  }

  /**
   * Apply a theme. The uniform is written every frame from `accentLive`, which
   * eases toward `accentTarget`, so the correct sink is the theme colour plus a
   * retarget — writing `uColorAccent` directly here would be overwritten on the
   * next frame and the theme would never stick.
   *
   * @param {string} hex  theme accent colour
   * @param {number} glow per-theme glow multiplier
   */
  setAccent(hex, glow) {
    this.themeAccent.set(hex || '#28e0c8');
    this.themeGlow = glow === undefined || glow === null ? 1 : Math.max(0.3, Math.min(1.8, Number(glow) || 1));
    this._retargetAccent();
    return this.themeAccent;
  }

  _applyQuality() {
    const tier = QUALITY_TIERS[this.quality] || QUALITY_TIERS.high;
    const n = Math.round(tier.instances * this.particleScale);
    const applied = this.field.setQuality(n);
    this.currentInstances = applied;
    this._sinceQualityChange = 0;
    this._goodWindows = 0;
    return applied;
  }

  setPanelShift(v) { this.panelShiftTarget = v; }

  /** Feed real audio. All five values are 0..1 measured, never invented. */
  setAudio(a, mode) {
    this.audio.low = a.low || 0;
    this.audio.mid = a.mid || 0;
    this.audio.high = a.high || 0;
    this.audio.energy = a.energy || 0;
    if (mode) this.audio.mode = mode;
  }

  setSpeakingLevel(v) { this.audio.mouth = Math.max(0, Math.min(1, v || 0)); }
  setBrowRaise(v) { this.browRaise = v || 0; }
  setReducedIdle(v) { this.live.energy = v === undefined ? this.live.energy : v; }

  /* ------------------------------------------------------------- */

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this._applyQuality();
    this.renderer.setAnimationLoop(this._frame);
  }

  stop() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  /**
   * Advance and render exactly one frame.
   *
   * This is the public entry point for the renderer's loop, which owns the
   * clock and passes its own delta. When no delta is supplied the stage falls
   * back to its own clock, which is what the Three.js loop path uses.
   */
  frame(dt) {
    const step = dt === undefined
      ? Math.min(this.clock.getDelta(), 0.05)
      : Math.min(Math.max(dt, 0), 0.05);
    this.elapsed += step;
    this._step(step);
  }

  /**
   * Three.js animation-loop callback. It must drop its arguments: the loop
   * hands over a high-resolution timestamp, which is not a delta.
   */
  _frame() {
    this.frame();
  }

  _step(dt) {
    const u = this.field.uniforms;
    const T = this.target;

    /* ---- adaptive quality ------------------------------------- */
    this._frames++;
    this._fpsAccum += dt;
    this._sinceQualityChange += dt;
    if (this._fpsAccum >= 1) {
      this.fps = this._frames / this._fpsAccum;
      this._frames = 0;
      this._fpsAccum = 0;
      if (this.adaptive && this.field.built && this._sinceQualityChange > 2.5) {
        const idx = TIER_ORDER.indexOf(this.quality);
        // The tier the user picked is the ceiling: adaptive may drop below it
        // under load, but never climbs past what was explicitly requested.
        const ceiling = TIER_ORDER.indexOf(this.userQuality || this.quality);
        if (this.fps < 42 && idx > 0) {
          this.quality = TIER_ORDER[idx - 1];
          this._applyQuality();
        } else if (this.fps > 58 && idx < Math.min(ceiling, TIER_ORDER.length - 1)) {
          this._goodWindows++;
          if (this._goodWindows >= 4) {
            this.quality = TIER_ORDER[idx + 1];
            this._applyQuality();
          }
        } else {
          this._goodWindows = 0;
        }
      }
    }

    /* ---- state easing ----------------------------------------- */
    const lam = this.state === 'BOOTING' ? 4.5 : 3.2;
    let formTarget = T.form;

    if (this.state === 'BOOTING') {
      const dur = this.bootDuration || 3.4;
      const p = Math.min(1, (this.elapsed - this.bootStart) / dur);
      // Converge, hold, settle.
      const eased = p < 0.78 ? 1 - Math.pow(1 - p / 0.78, 2.4) : 1;
      formTarget = eased;
      T.intensity = 0.35 + 0.75 * eased;
      T.scan = 0.30 * (1 - eased) + 0.05;
      T.energy = 0.55 + 0.55 * (1 - eased);
      if (p >= 1) this.setState('IDLE');
    }

    this.live.energy = damp(this.live.energy, T.energy, lam, dt);
    this.live.form = damp(this.live.form, formTarget, this.state === 'BOOTING' ? 30 : lam, dt);
    this.live.intensity = damp(this.live.intensity, T.intensity, lam, dt);
    this.live.size = damp(this.live.size, T.size, lam, dt);
    this.live.scan = damp(this.live.scan, T.scan, lam, dt);
    this.live.dissolve = damp(this.live.dissolve, T.dissolve, lam, dt);
    this.live.alertMix = damp(this.live.alertMix, T.alertMix, lam, dt);
    dampColor(this.accentLive, this.accentTarget, lam, dt);

    /* ---- expression ------------------------------------------- */
    // Blink.
    if (!this.reducedMotion) {
      this.nextBlink -= dt;
      if (this.nextBlink <= 0 && this.blinkPhase === 0) { this.blinkPhase = 0.001; }
      if (this.blinkPhase > 0) {
        this.blinkPhase += dt / 0.16;
        this.blink = Math.sin(Math.min(1, this.blinkPhase) * Math.PI);
        if (this.blinkPhase >= 1) { this.blinkPhase = 0; this.blink = 0; this.nextBlink = 2.4 + Math.random() * 4.5; }
      }
    } else {
      this.blink = 0;
    }

    // Saccades.
    if (!this.reducedMotion) {
      this.nextSaccade -= dt;
      if (this.nextSaccade <= 0) {
        this.gazeTarget.set((Math.random() - 0.5) * 0.55, (Math.random() - 0.5) * 0.35);
        this.nextSaccade = 1.4 + Math.random() * 3.2;
      }
    }
    this.gaze.x = damp(this.gaze.x, this.gazeTarget.x, 9, dt);
    this.gaze.y = damp(this.gaze.y, this.gazeTarget.y, 9, dt);

    // Mouth follows measured speech amplitude, heavily smoothed so it never
    // snaps open. Formants shape which band drives it.
    const formant = this.audio.low * 0.55 + this.audio.mid * 0.9 + this.audio.high * 0.35;
    const mouthTarget = Math.min(1, this.audio.mouth * 0.7 + formant * 0.8) * (0.45 + 0.55 * this.audio.mouth);
    this.mouthOpen = damp(this.mouthOpen, mouthTarget, 16, dt);
    this.mouthOpen = Math.min(this.mouthOpen, 1);

    const breathe = Math.sin(this.elapsed * 0.62) * 0.5 + Math.sin(this.elapsed * 0.31 + 1.2) * 0.5;

    /* ---- push uniforms ---------------------------------------- */
    const tier = QUALITY_TIERS[this.quality] || QUALITY_TIERS.high;
    u.uTime.value = this.elapsed;
    u.uForm.value = this.live.form;
    u.uEnergy.value = this.live.energy * tier.energyScale;
    u.uSize.value = this.live.size;
    u.uIntensity.value = this.live.intensity * this.themeIntensity;
    u.uDissolve.value = this.live.dissolve;
    u.uBreathe.value = breathe;
    u.uMouthOpen.value = this.mouthOpen;
    u.uBrowRaise.value = this.browRaise;
    u.uGaze.value.copy(this.gaze);
    u.uBlink.value = this.blink;
    u.uScanStrength.value = this.live.scan;
    u.uScanY.value = ((this.elapsed * 9.0) % 34) - 15;
    u.uGlow.value = (this.opts.bloom ? 1 : 0.35) * this.themeGlow;
    u.uAudio.value.set(this.audio.low, this.audio.mid, this.audio.high);
    u.uColorAccent.value.copy(this.accentLive);
    u.uColorBase.value.copy(PALETTE.base).lerp(PALETTE.alert, this.live.alertMix * 0.7);
    u.uColorAlert.value.copy(PALETTE.alert);

    /* ---- camera ------------------------------------------------ */
    this.pointerSmooth.x = damp(this.pointerSmooth.x, this.pointer.x, 3.5, dt);
    this.pointerSmooth.y = damp(this.pointerSmooth.y, this.pointer.y, 3.5, dt);
    this.panelShift = damp(this.panelShift, this.panelShiftTarget, 5, dt);

    const dist = this.baseDistance || 44;
    const par = this.reducedMotion ? 0 : 1;
    this.camera.position.x = this.pointerSmooth.x * 1.5 * par + this.panelShift;
    this.camera.position.y = 0.4 - this.pointerSmooth.y * 1.1 * par;
    this.camera.position.z = dist;
    this.lookTarget.set(this.panelShift * 0.55, 0.4, 0);
    this.camera.lookAt(this.lookTarget);

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._resize);
    window.removeEventListener('pointermove', this._onPointer);
    this.field.dispose();
    this.atlas.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
  }
}

export { QUALITY_TIERS, TIER_ORDER };
