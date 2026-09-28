/**
 * Face generation coordinator.
 *
 * Spawns the sampler worker, reports progress, and hands the cloud to the
 * stage. The cloud is generated once at the largest size we might need; lower
 * quality tiers are served by lowering the instance count, which is free.
 */

const MAX_CLOUD = 16000;

export class FaceLoader {
  constructor() {
    this.worker = null;
    this.pending = null;
  }

  /**
   * @param {(p:number)=>void} onProgress
   * @returns {Promise<{count:number, positions:Float32Array, normals:Float32Array, regions:Uint8Array, attributes:Float32Array}>}
   */
  generate(count, onProgress) {
    this.cancel();
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(new URL('./sampler.worker.js', import.meta.url), { type: 'module' });
      } catch (err) {
        reject(new Error('Could not start the face sampler: ' + err.message));
        return;
      }
      this.worker = worker;
      const token = {};
      this.pending = token;

      worker.onmessage = (ev) => {
        if (this.pending !== token) return;
        const d = ev.data || {};
        if (d.type === 'progress') {
          if (onProgress) onProgress(d.value);
        } else if (d.type === 'done') {
          this.pending = null;
          worker.terminate();
          resolve(d);
        }
      };
      worker.onerror = (e) => {
        if (this.pending !== token) return;
        this.pending = null;
        worker.terminate();
        reject(new Error('Face sampler failed: ' + (e.message || 'unknown error')));
      };

      const target = Math.max(1200, Math.min(MAX_CLOUD, count | 0 || 10000));
      worker.postMessage({ count: target, seed: 0x1E6107, quality: target });
    });
  }

  cancel() {
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this.pending = null;
  }
}

export { MAX_CLOUD };
