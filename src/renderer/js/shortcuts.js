/**
 * Keyboard control.
 *
 * Push to talk is edge-triggered on Space: the recogniser starts on keydown and
 * is told to stop on keyup, so releasing the key returns the transcript
 * captured so far. Escape always wins — it stops speech and cancels a capture
 * regardless of what else is happening.
 */

const EDITABLE = /^(input|textarea|select)$/i;

export class Shortcuts {
  constructor(app) {
    this.app = app;
    this.spaceDown = false;
    window.addEventListener('keydown', (e) => this.#down(e));
    window.addEventListener('keyup', (e) => this.#up(e));
    window.addEventListener('blur', () => { if (this.spaceDown) { this.spaceDown = false; this.app.pushToTalkEnd(); } });
  }

  #typing(e) {
    const t = e.target;
    return t && (EDITABLE.test(t.tagName) || t.isContentEditable);
  }

  #down(e) {
    const app = this.app;
    if (e.key === 'Escape') {
      if (app.closeTopmost()) { e.preventDefault(); return; }
    }

    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === ',') { e.preventDefault(); app.togglePanel('settings'); return; }
      if (k === 'h') { e.preventDefault(); app.togglePanel('conversation'); return; }
      if (k === 'p') { e.preventDefault(); app.cyclePanel(); return; }
      if (k === 'm') { e.preventDefault(); app.toggleMic(); return; }
      if (k === 'k') { e.preventDefault(); app.togglePanel('tools'); return; }
      if (k === 'l') { e.preventDefault(); app.bringToFront(); return; }
      return;
    }

    if (this.#typing(e)) return;

    if (e.code === 'Space') {
      e.preventDefault();
      if (this.spaceDown) return;
      this.spaceDown = true;
      app.pushToTalkStart();
      return;
    }

    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
      e.preventDefault();
      app.toggleShortcuts();
    }
  }

  #up(e) {
    if (e.code === 'Space' && this.spaceDown) {
      this.spaceDown = false;
      this.app.pushToTalkEnd();
    }
  }
}
