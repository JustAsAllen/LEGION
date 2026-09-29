import * as THREE from '../vendor/three.module.js';

/**
 * PARTICLE FIELD
 * ==============
 * Every visible element of LEGION's mark is one instance of a single quad,
 * drawn in one draw call. The CPU uploads a static point cloud once; all
 * motion, audio response and state colour live in the shaders.
 *
 * Quality changes are a single `instanceCount` write, so switching from HIGH
 * to LOW costs nothing. That works because the cloud is uniformly random:
 * any prefix of it is a fair random subset of the whole mark.
 */

const VERT = /* glsl */`
precision highp float;

attribute vec3  aTarget;
attribute vec3  aNormal;
attribute vec4  aAttr;
attribute float aRegion;

uniform float uTime;
uniform float uForm;
uniform float uEnergy;
uniform float uSize;
uniform float uPixelRatio;
uniform vec3  uAudio;
uniform float uSpread;
uniform float uLift;
uniform float uScanY;
uniform float uScanStrength;
uniform float uDissolve;
uniform float uReducedMotion;
uniform float uIntensity;
uniform float uBreathe;
uniform vec3  uColorBase;
uniform vec3  uColorFeature;
uniform vec3  uColorAccent;
uniform vec3  uColorAlert;

varying vec2  vUv;
varying float vGlyph;
varying vec3  vColor;
varying float vAlpha;

const float R_BAND     = 0.0;
const float R_CAP      = 1.0;
const float R_RIM_OUT  = 2.0;
const float R_RIM_IN   = 3.0;

const float SEG_SPAN = 2.0943951;   // 120 degrees
const float SEG_CENTRE_0 = 1.5707963; // 12 o'clock, straight up

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

vec3 hash31(float p) {
  vec3 q = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yzz) * q.zyx);
}

vec3 drift(vec3 p, float t, float seed) {
  vec3 h = hash31(seed * 97.0 + 3.1);
  float s = t * (0.30 + h.x * 0.45);
  return vec3(
    sin(p.y * 0.55 + s * 1.30 + h.x * 6.283),
    sin(p.z * 0.47 + s * 1.05 + h.y * 6.283),
    sin(p.x * 0.51 + s * 0.87 + h.z * 6.283)
  );
}

void main() {
  float seed  = aAttr.x;
  float sizeM = aAttr.y;
  float speed = aAttr.z;
  float bright= aAttr.w;

  bool isCap    = abs(aRegion - R_CAP) < 0.5;
  bool isRimOut = abs(aRegion - R_RIM_OUT) < 0.5;
  bool isRimIn  = abs(aRegion - R_RIM_IN) < 0.5;

  float motion = uEnergy * (1.0 - uReducedMotion * 0.78);

  /* ---- home position ------------------------------------------- */
  vec3 home = aTarget;

  // Which arc is this element on? Taken from its own angle rather than from a
  // region id, so the three arcs can be driven apart independently without the
  // sampler spending one of its four labels on saying which arc it is.
  float ang  = atan(aTarget.y, aTarget.x);
  float cell = floor((ang - SEG_CENTRE_0) / SEG_SPAN + 0.5);
  float segCentre = SEG_CENTRE_0 + cell * SEG_SPAN;
  float relN = clamp((ang - segCentre) / (SEG_SPAN * 0.5), -1.0, 1.0);

  // Breathing: a slow radial swell. A ring breathes this way, not up and down.
  home.xy *= 1.0 + uBreathe * 0.010;

  // Speaking: the slices drift apart at their open ends. Scaling the angular
  // offset away from each arc's own centre widens all three gaps at once while
  // leaving the arc centres where they are, which is what a segmented mark
  // does when it talks.
  home.xy *= 1.0 + uSpread * 0.22 * abs(relN);
  float flare = uSpread * 0.09 * relN;
  float cf = cos(flare), sf = sin(flare);
  home.xy = vec2(home.x * cf - home.y * sf, home.x * sf + home.y * cf);

  // "Brow raise" becomes the cut faces lifting out along their own normal, so
  // the mark gains weight while LEGION is thinking.
  home += aNormal * uLift * (isCap ? 1.0 : 0.0) * 0.9;

  /* ---- formation: staggered convergence ---------------------- */
  vec3 h3 = hash31(seed * 311.7 + 1.7);
  vec3 scatter = home + (h3 - 0.5) * vec3(30.0, 30.0, 9.0);

  float wave = 0.5 + 0.5 * sin(seed * 6.2831 + uTime * 0.35);
  float local = clamp(uForm * 1.45 - wave * 0.42, 0.0, 1.0);
  local = local * local * (3.0 - 2.0 * local);

  vec3 pos = mix(scatter, home, local);

  /* ---- motion ------------------------------------------------- */
  vec3 d = drift(aTarget * 0.5, uTime * speed, seed);
  pos += d * (0.075 + 0.16 * motion) * (1.0 - local * 0.30);

  // A data sweep travelling around the ring rather than up a face.
  float sweep = sin(length(aTarget.xy) * 0.62 - uTime * 0.9 + seed * 2.0);
  pos += aNormal * sweep * 0.055 * motion * (0.4 + local * 0.8);

  // Real audio: low band swells the mass, high band shimmers the surface.
  float low  = uAudio.x;
  float high = uAudio.z;
  pos += aNormal * (low * 0.26 + high * 0.13) * (isCap ? 0.6 : 1.0);

  // Scan pass.
  float band = exp(-pow((aTarget.y - uScanY) * 1.45, 2.0));
  pos += aNormal * band * uScanStrength * 0.75;
  pos.y  += band * uScanStrength * 0.45;

  // Local dissolve.
  pos += (hash31(seed * 77.0 + 9.4) - 0.5) * uDissolve * 7.0 * (0.35 + motion);

  /* ---- billboard --------------------------------------------- */
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  float depth = max(-mv.z, 0.001);
  float persp = 1.0 / max(depth * 0.055, 0.30);

  float audioScale = 1.0 + (low + high) * 0.45 + uSpread * 0.10;
  float sz = uSize * sizeM * audioScale * uPixelRatio * persp;
  sz *= (isRimOut || isRimIn) ? 0.88 : 1.0;
  sz *= mix(1.9, 1.0, local);

  mv.xy += position.xy * sz;
  gl_Position = projectionMatrix * mv;

  /* ---- glyph, colour, alpha ---------------------------------- */
  float churn = uTime * (0.5 + 1.7 * motion);
  float g;
  if (isCap) {
    // The cut ends churn slowly through a narrow set of glyphs, so they read as
    // one continuous accent element instead of as more of the same texture.
    g = floor(fract(seed * 53.0 + churn * 0.18) * 24.0);
  } else if (seed > 0.80) {
    g = floor(fract(seed * 53.0 + churn * 0.13) * 64.0);
  } else {
    g = mod(floor(seed * 2.0 + churn), 2.0);
  }
  vGlyph = g;

  vec3 nView = normalize(normalMatrix * aNormal);
  // A surface facing the camera has a normal pointing back along +Z in view
  // space. The sign here used to be negated, which kept the *back* of the head
  // and threw away the entire front of it; every element that faced the viewer
  // was discarded before it reached the fragment shader.
  float facing = smoothstep(-0.35, 0.25, nView.z);

  vec3 col = uColorBase;
  float glow = 0.0;

  if (isCap)         { col = mix(uColorFeature, uColorAccent, 0.72); glow = 0.85; }
  else if (isRimOut) { col = mix(uColorBase, uColorFeature, 0.55); glow = 0.20; }
  else if (isRimIn)  { col = uColorBase * 0.80;               glow = 0.10; }
  else               { col = mix(uColorBase, uColorFeature, 0.30); }

  // A pulse running around the ring, so the mark is alive even while the state
  // machine is idle. This is where the theme colour is read on every element,
  // which is what makes a theme change visible in the logo and not only in the
  // window chrome.
  float chase = 0.5 + 0.5 * sin(ang * 1.5 - uTime * 1.6);
  col += uColorAccent * pow(chase, 6.0) * (0.10 + 0.34 * motion);

  col = mix(col, uColorAlert, glow * 0.25);
  col += uColorAccent * band * uScanStrength * 0.6;
  col *= 0.85 + 0.45 * (low * 0.7 + high * 0.5);

  float alpha = bright * facing * uIntensity;
  if (isRimOut) alpha *= 0.72;
  if (isRimIn)  alpha *= 0.86;

  vColor = col;
  vAlpha = alpha;
  vUv = uv;
}
`;

const FRAG = /* glsl */`
precision highp float;

uniform sampler2D uAtlas;
uniform float uGrid;
uniform float uGlow;

varying vec2  vUv;
varying float vGlyph;
varying vec3  vColor;
varying float vAlpha;

void main() {
  if (vAlpha < 0.02) discard;

  float cellId = floor(vGlyph);
  vec2 cell = vec2(mod(cellId, uGrid), floor(cellId / uGrid));
  vec2 local = clamp(vUv, 0.055, 0.945);
  vec2 auv = (cell + local) / uGrid;

  float a = texture2D(uAtlas, auv).a;
  if (a < 0.10) discard;

  vec3 c = vColor * (1.0 + uGlow * 0.55);
  gl_FragColor = vec4(c, a * vAlpha);
}
`;

export class ParticleField {
  constructor(atlas, maxInstances) {
    this.maxInstances = maxInstances;
    this.time = 0;
    this.built = false;

    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;
    geo.attributes.uv = base.attributes.uv;
    base.dispose();

    // One slot per instance, sized once. These are written in full by
    // setCloud; allocating a single element here would silently clip every
    // upload down to the first particle.
    const cap = Math.max(1, maxInstances | 0);
    this.aTarget = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.aNormal = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.aAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.aRegion = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    for (const a of [this.aTarget, this.aNormal, this.aAttr, this.aRegion]) a.setUsage(THREE.StaticDrawUsage);

    geo.setAttribute('aTarget', this.aTarget);
    geo.setAttribute('aNormal', this.aNormal);
    geo.setAttribute('aAttr', this.aAttr);
    geo.setAttribute('aRegion', this.aRegion);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -1, 0), 26);

    this.uniforms = {
      uTime:         { value: 0 },
      uForm:         { value: 0 },
      uEnergy:       { value: 0.35 },
      uSize:         { value: 0.30 },
      uPixelRatio:   { value: 1 },
      uAudio:        { value: new THREE.Vector3(0, 0, 0) },
      uSpread:       { value: 0 },
      uLift:         { value: 0 },
      uScanY:        { value: 40 },
      uScanStrength: { value: 0 },
      uDissolve:     { value: 0 },
      uReducedMotion:{ value: 0 },
      uIntensity:    { value: 1 },
      uBreathe:      { value: 0 },
      uColorBase:    { value: new THREE.Color(0.62, 0.74, 0.92) },
      uColorFeature: { value: new THREE.Color(0.86, 0.92, 1.0) },
      uColorAccent:  { value: new THREE.Color(0.24, 0.78, 1.0) },
      uColorAlert:   { value: new THREE.Color(1.0, 0.42, 0.32) },
      uAtlas:        { value: atlas },
      uGrid:         { value: 8 },
      uGlow:         { value: 1 }
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.geometry = geo;
  }

  /** Upload a freshly sampled cloud. */
  setCloud(data) {
    const n = Math.min(data.count, this.maxInstances);
    this.aTarget.array.set(data.positions.subarray(0, n * 3));
    this.aNormal.array.set(data.normals.subarray(0, n * 3));
    this.aAttr.array.set(data.attributes.subarray(0, n * 4));
    this.aRegion.array.set(data.regions.subarray(0, n));

    this.aTarget.needsUpdate = true;
    this.aNormal.needsUpdate = true;
    this.aAttr.needsUpdate = true;
    this.aRegion.needsUpdate = true;

    this.total = n;
    this.geometry.instanceCount = n;
    this.built = true;
  }

  setQuality(instances) {
    const n = Math.max(600, Math.min(this.total || instances, instances | 0));
    this.geometry.instanceCount = n;
    return n;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
