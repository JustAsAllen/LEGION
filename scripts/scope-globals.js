'use strict';

/**
 * Globals that are legitimately read without a local declaration, split by
 * environment. The renderer (renderer/*) is a web worker + DOM context; the
 * main process (main/*) is CommonJS Node with Electron; preload runs in a
 * Node webview context.
 */

const BROWSER = `
  window document navigator console location history sessionStorage localStorage
  screen innerWidth innerHeight outerWidth outerHeight devicePixelRatio visualViewport
  Math JSON Promise Date Array Object Number String Boolean Symbol BigInt
  RegExp Error TypeError RangeError ReferenceError SyntaxError URIError EvalError
  WeakMap WeakSet Map Set WeakRef FinalizationRegistry Proxy Reflect
  undefined NaN Infinity globalThis
  ArrayBuffer DataView SharedArrayBuffer BigInt64Array BigUint64Array
  Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array
  Uint32Array Float32Array Float64Array
  fetch Request Response Headers FormData Blob File FileReader URL URLSearchParams
  URLPattern AbortController AbortSignal TextDecoder TextEncoder atob btoa
  setTimeout clearTimeout setInterval clearInterval queueMicrotask
  requestAnimationFrame cancelAnimationFrame requestIdleCallback cancelIdleCallback
  performance crypto CustomEvent Event EventTarget NodeList
  Document HTMLElement HTMLDivElement HTMLSpanElement HTMLCanvasElement
  HTMLInputElement HTMLButtonElement HTMLSelectElement HTMLOptionElement
  HTMLTextAreaElement HTMLAudioElement HTMLVideoElement HTMLStyleElement
  MediaRecorder Audio AudioContext webkitAudioContext AnalyserNode OscillatorNode
  MediaStream DeviceMotionEvent matchMedia addEventListener removeEventListener
  getComputedStyle getComputedStyle2 isFinite isNaN parseFloat parseInt
  encodeURI decodeURI encodeURIComponent decodeURIComponent Intl structuredClone
  MutationObserver ResizeObserver IntersectionObserver Worker MessageChannel
  MessagePort WebSocket Image WebGLRenderingContext WebGL2RenderingContext
  requestIdleCallback cancelIdleCallback CSS DOMException FileList
  TextEncoder TextDecoder queueMicrotask
`.split(/\s+/).filter(Boolean);

const NODE = `
  process Buffer require module exports __dirname __filename global
  setImmediate clearImmediate console setTimeout clearTimeout setInterval clearInterval
  queueMicrotask TextDecoder TextEncoder URL URLSearchParams
`.split(/\s+/).filter(Boolean);

const ELECTRON = `
  contextBridge ipcRenderer webUtils loadFile unreferenced
`.split(/\s+/).filter(Boolean);

const WORKER = `
  self postMessage onmessage onerror close importScripts
  caches indexedDB
`.split(/\s+/).filter(Boolean);

const SPEECH = `
  SpeechRecognition webkitSpeechRecognition speechSynthesis SpeechSynthesisUtterance
  SpeechSynthesisVoice SpeechSynthesisEvent
`.split(/\s+/).filter(Boolean);

const GLOBALS = new Set([...BROWSER, ...NODE, ...ELECTRON, ...WORKER, ...SPEECH]);

module.exports = { GLOBALS };