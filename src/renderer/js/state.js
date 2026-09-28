/**
 * Renderer-side state mirror.
 *
 * The main process is the single authority for state (boot, listening,
 * processing, speaking, alert, error, offline) and broadcasts transitions.
 * This module only mirrors what it is told, plus the transient fields the
 * interface owns locally, such as which panel is open and the current caption.
 */

const STATES = ['OFFLINE', 'BOOTING', 'IDLE', 'LISTENING', 'PROCESSING', 'SPEAKING', 'ALERT', 'ERROR'];

export class StateStore extends EventTarget {
  constructor() {
    super();
    this.state = 'BOOTING';
    this.detail = '';
    this.error = null;
    this.panel = null;
    this.caption = '';
    this.captionInterim = false;
    this.streaming = '';
  }

  /**
   * Dispatch a store event. `change` listeners read the store itself, so an
   * absent payload defaults to `this`; the typed events pass their own payload
   * through. Passing the payload is what makes `state` deliver
   * { prev, next, note } to the shell instead of silently handing over the
   * store and leaving `next` undefined.
   */
  #emit(type, payload) {
    this.dispatchEvent(new CustomEvent(type, { detail: payload === undefined ? this : payload }));
  }
  #emitChange() { this.#emit('change'); }

  setState(next, detail) {
    if (!STATES.includes(next) || next === this.state) {
      if (detail !== undefined && detail !== this.detail) this.detail = detail || '';
      this.#emitChange();
      return false;
    }
    const prev = this.state;
    this.state = next;
    this.detail = detail || '';
    if (next === 'ERROR') this.error = detail || 'Unknown error';
    this.#emit('state', { prev, next, note: this.detail });
    this.#emitChange();
    return true;
  }

  setDetail(detail) {
    if (this.detail === detail) return;
    this.detail = detail || '';
    this.#emitChange();
  }

  setPanel(panel) {
    if (this.panel === panel) return;
    this.panel = panel;
    document.body.classList.toggle('panel-open', !!panel);
    this.#emit('panel', panel);
    this.#emitChange();
  }

  setCaption(text, interim) {
    this.caption = text || '';
    this.captionInterim = !!interim;
    this.#emit('caption', { text: this.caption, interim: this.captionInterim });
    this.#emitChange();
  }

  setStreaming(text) {
    this.streaming = text || '';
    this.#emit('streaming', this.streaming);
    this.#emitChange();
  }

  clearError() { this.error = null; this.detail = ''; this.#emitChange(); }

  get busy() { return this.state === 'PROCESSING' || this.state === 'SPEAKING'; }
  get speaking() { return this.state === 'SPEAKING'; }
  get listening() { return this.state === 'LISTENING'; }
}

export { STATES };
