import * as THREE from '../vendor/three.module.js';

/**
 * GLYPH ATLAS
 * ===========
 * The face is drawn with characters, not dots. This builds a texture atlas of
 * binary digits, decimal digits, hex letters and a few mathematical marks.
 *
 * Cell 0 and cell 1 are '0' and '1': the shader routes ~78% of points to those
 * two, and lets the rest sample the wider character set, which is what gives
 * the surface its "data" texture rather than a uniform dot pattern.
 */

const CHARS = [
  '0', '1', '2', '3', '4', '5', '6', '7',
  '8', '9', 'A', 'B', 'C', 'D', 'E', 'F',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h',
  'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p',
  'q', 'r', 's', 't', 'u', 'v', 'w', 'x',
  'y', 'z', '2', '5', '7', 'E', 'A', '0',
  '+', '-', '=', ':', '.', '/', '<', '>',
  '*', '#', '%', 'Σ', 'π', '√', '·', 'Δ'
];

export const GLYPH_COUNT = CHARS.length;
export const ATLAS_GRID = 8;
const CELL = 128;
const PAD = 20;

export function buildGlyphAtlas(renderer) {
  const size = ATLAS_GRID * CELL;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  ctx.clearRect(0, 0, size, size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';

  for (let i = 0; i < CHARS.length; i++) {
    const cx = (i % ATLAS_GRID) * CELL;
    const cy = Math.floor(i / ATLAS_GRID) * CELL;
    const fontSize = CELL - PAD * 2;
    ctx.font = `600 ${fontSize}px "Cascadia Mono", "Consolas", "SF Mono", "Roboto Mono", ui-monospace, monospace`;
    // Nudge to optical centre: digits and capitals sit slightly high in most
    // monospace metrics.
    ctx.fillText(CHARS[i], cx + CELL / 2, cy + CELL / 2 + fontSize * 0.04);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.premultiplyAlpha = false;
  texture.flipY = false;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  texture.needsUpdate = true;

  return texture;
}

export const GLYPH_CHARS = CHARS;
