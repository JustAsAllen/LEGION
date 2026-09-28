import * as THREE from '../vendor/three.module.js';
import { REGION } from './face-model.js';

/**
 * PARTICLE FIELD
 * ==============
 * Every visible element of LEGION's face is one instance of a single quad,
 * drawn in one draw call. The CPU uploads a static point cloud once; all
 * motion, expression, audio response and state colour live in the shaders.
 *
 * Quality changes are a single `instanceCount` write, so switching from HIGH
 * to LOW costs nothing. That works because the cloud is uniformly random:
 * any prefix of it is a fair random subset of the whole face.
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
uniform float uMouthOpen;
uniform float uBrowRaise;
uniform vec2  uGaze;
uniform float uScanY;
uniform float uScanStrength;
uniform float uDissolve;
uniform float uReducedMotion;
uniform float uIntensity;
uniform float uBlink;
uniform float uBreathe;
uniform vec3  uColorBase;
uniform vec3  uColorFeature;
uniform vec3  uColorAccent;
uniform vec3  uColorAlert;

varying vec2  vUv;
varying float vGlyph;
varying vec3  vColor;
varying float vAlpha;

const float R_FACE = 0.0;
const float R_BROW = 1.0;
const float R_SOCKET = 2.0;
const float R_NOSE = 3.0;
const float R_MOUTH = 4.0;
const float R_CHEEK = 5.0;
const float R_JAW = 6.0;
const float R_EAR = 7.0;
const float R_HAIR = 8.0;
const float R_LIPU = 12.0;
const float R_LIPL = 13.0;
const float R_EYE  = 14.0;
const float R_IRIS = 16.0;
const float R_PUPIL = 17.0;

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

  bool isPupil  = aRegion > 16.5;
  bool isIris   = aRegion > 15.5 && aRegion < 16.5;
  bool isEye    = aRegion > 13.5 && aRegion < 15.5;
  bool isEyeAll = aRegion > 13.5;
  bool isMouth  = abs(aRegion - R_MOUTH) < 0.5;
  bool isLip    = (aRegion > 11.5 && aRegion < 12.5) || (aRegion > 12.5 && aRegion < 13.5);
  bool isBrow   = abs(aRegion - R_BROW) < 0.5;
  bool isHair   = abs(aRegion - R_HAIR) < 0.5;
  bool isJaw    = abs(aRegion - R_JAW) < 0.5;
  bool isNose   = abs(aRegion - R_NOSE) < 0.5;
  bool isCheek  = abs(aRegion - R_CHEEK) < 0.5;
  bool isSocket = abs(aRegion - R_SOCKET) < 0.5;
  bool isEar    = abs(aRegion - R_EAR) < 0.5;
  bool isShoulder = aRegion > 9.5 && aRegion < 10.5;

  float motion = uEnergy * (1.0 - uReducedMotion * 0.78);

  /* ---- home position with expression applied ----------------- */
  vec3 home = aTarget;

  // Breathing: a slow, shallow vertical swell of the whole head.
  home.y *= 1.0 + uBreathe * 0.006;
  home.x *= 1.0 + uBreathe * 0.004;

  // Blink: the upper lid sweeps down over the eye.
  if (isEyeAll) {
    home.y -= uBlink * 0.34;
    home.y += uBlink * 0.10 * step(0.0, home.y - 1.95);
  }

  // Mouth opening, and the jaw that carries it.
  // Region tests are booleans, and GLSL has no implicit bool-to-float
  // conversion, so the masks used as multipliers are built explicitly.
  float lipW = (isMouth || isLip) ? 1.0 : 0.0;
  home.y -= uMouthOpen * lipW * 0.92;
  home.z += uMouthOpen * lipW * 0.34;

  float belowMouth = smoothstep(-3.8, -6.4, aTarget.y);
  home.y -= uMouthOpen * belowMouth * 0.40;
  home.z += uMouthOpen * belowMouth * 0.15;

  // Brow raise / furrow.
  float browW = isBrow ? 1.0 : 0.0;
  home.y += uBrowRaise * browW * 0.34;
  home.z -= abs(uBrowRaise) * browW * 0.10;

  // Gaze. Eyes only.
  if (isEyeAll) {
    home.x += uGaze.x * 0.17;
    home.y += uGaze.y * 0.14;
  }

  /* ---- formation: staggered convergence ---------------------- */
  vec3 h3 = hash31(seed * 311.7 + 1.7);
  vec3 scatter = home + (h3 - 0.5) * vec3(30.0, 34.0, 22.0);

  float wave = 0.5 + 0.5 * sin(seed * 6.2831 + uTime * 0.35);
  float local = clamp(uForm * 1.45 - wave * 0.42, 0.0, 1.0);
  local = local * local * (3.0 - 2.0 * local);

  vec3 pos = mix(scatter, home, local);

  /* ---- motion ------------------------------------------------- */
  vec3 d = drift(aTarget * 0.5, uTime * speed, seed);
  pos += d * (0.075 + 0.16 * motion) * (1.0 - local * 0.30);

  // A slow lateral data sweep travelling up the face.
  float sweep = sin(aTarget.y * 0.42 - uTime * 0.9 + seed * 2.0);
  pos += aNormal * sweep * 0.055 * motion * (0.4 + local * 0.8);

  // Real audio: low band swells the mass, high band shimmers the surface.
  float low  = uAudio.x;
  float high = uAudio.z;
  pos += aNormal * (low * 0.26 + high * 0.13) * (isEyeAll ? 0.5 : 1.0);

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

  float audioScale = 1.0 + (low + high) * 0.45 + uMouthOpen * 0.12;
  float sz = uSize * sizeM * audioScale * uPixelRatio * persp;
  sz *= isEyeAll ? 0.80 : 1.0;
  sz *= mix(1.9, 1.0, local);

  mv.xy += position.xy * sz;
  gl_Position = projectionMatrix * mv;

  /* ---- glyph, colour, alpha ---------------------------------- */
  float churn = uTime * (0.5 + 1.7 * motion);
  float g;
  if (isEyeAll) {
    g = -1.0;
  } else if (isHair) {
    g = floor(fract(seed * 53.0 + churn * 0.07) * 48.0);
  } else if (seed > 0.80) {
    g = floor(fract(seed * 53.0 + churn * 0.13) * 64.0);
  } else {
    g = mod(floor(seed * 2.0 + churn), 2.0);
  }
  vGlyph = g;

  vec3 nView = normalize(normalMatrix * aNormal);
  float facing = smoothstep(-0.45, 0.15, -nView.z);

  vec3 col = uColorBase;
  float glow = 0.0;

  if (isEyeAll)       { col = isIris ? uColorAccent : mix(uColorFeature, vec3(1.0), 0.55); glow = 0.9; }
  else if (isBrow)    { col = mix(uColorBase, uColorFeature, 0.65); glow = 0.25; }
  else if (isNose)    { col = mix(uColorBase, uColorFeature, 0.45); glow = 0.20; }
  else if (isMouth || isLip) { col = uColorFeature; glow = 0.35; }
  else if (isSocket)  { col = uColorBase * 0.72; }
  else if (isCheek)   { col = mix(uColorBase, uColorFeature, 0.20); }
  else if (isHair)    { col = uColorBase * 0.42; glow = 0.0; }
  else if (isEar)     { col = uColorBase * 0.62; }
  else if (isShoulder){ col = uColorBase * 0.50; }
  else if (isJaw)     { col = mix(uColorBase, uColorFeature, 0.14); }

  col = mix(col, uColorAlert, glow * 0.25);
  col += uColorAccent * band * uScanStrength * 0.6;
  col *= 0.85 + 0.45 * (low * 0.7 + high * 0.5);

  float alpha = bright * facing * uIntensity;
  if (isPupil)    alpha = 0.0;
  if (isHair)     alpha *= 0.42;
  if (isShoulder) alpha *= 0.55;
  if (isEar)      alpha *= 0.72;
  if (isEyeAll)   alpha *= mix(0.0, 1.0, step(0.5, 1.0 - uBlink * 0.85));
  if (isIris)     alpha *= 1.0;

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

  // Eye elements are solid forms, not characters.
  if (vGlyph < -0.5) {
    vec2 p = vUv - 0.5;
    float d = length(p);
    if (d > 0.5) discard;
    float e = smoothstep(0.5, 0.30, d);
    gl_FragColor = vec4(vColor, e * vAlpha);
    return;
  }

  float cellId = floor(vGlyph);
  vec2 cell = vec2(mod(cellId, uGrid), floor(cellId / uGrid));
  vec2 local = clamp(vUv, 0.055, 0.945);
  vec2 auv = (cell + local) / uGrid;

  float a = texture2D(uAtlas, auv, -0.55).a;
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
      uMouthOpen:    { value: 0 },
      uBrowRaise:    { value: 0 },
      uGaze:         { value: new THREE.Vector2(0, 0) },
      uScanY:        { value: 40 },
      uScanStrength: { value: 0 },
      uDissolve:     { value: 0 },
      uReducedMotion:{ value: 0 },
      uIntensity:    { value: 1 },
      uBlink:        { value: 0 },
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

export { REGION };
