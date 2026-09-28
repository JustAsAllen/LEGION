/**
 * Panel renderers.
 *
 * Each panel gets a container and an app handle. They re-render on demand and
 * subscribe to the store so live state shows up without polling.
 */

import { fmtBytes, fmtPct, fmtClock, esc } from './format.js';

/* ================================================================
   CONVERSATION
   ================================================================ */

export function conversationPanel(host, app) {
  host.innerHTML = `
    <div class="conv">
      <div class="conv-list" id="conv-list"></div>
      <form class="conv-compose" id="conv-form">
        <input id="conv-input" type="text" placeholder="Type a message..." autocomplete="off" spellcheck="false" />
        <button class="mic-btn" id="conv-mic" type="button" title="Hold to talk">
          <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="2" width="6" height="11" rx="3"/><path d="M4 9.5a6 6 0 0 0 12 0M10 15.5V18"/></svg>
        </button>
        <button class="btn primary sm" type="submit" style="height:34px;padding:0 16px;border-radius:17px">Send</button>
      </form>
    </div>`;

  const list = host.querySelector('#conv-list');
  const form = host.querySelector('#conv-form');
  const input = host.querySelector('#conv-input');
  const mic = host.querySelector('#conv-mic');

  function paint() {
    const msgs = app.memory.session;
    if (!msgs.length) {
      list.innerHTML = `<div class="empty">
        <strong>No conversation yet</strong>
        Hold <b>Space</b> to talk, or type a message above.<br/>
        LEGION answers once a provider is configured.
      </div>`;
      return;
    }
    list.innerHTML = msgs.map((m) => {
      const cls = m.role === 'user' ? 'user' : m.role === 'tool' ? 'tool' : m.role === 'error' ? 'error' : 'assistant';
      const who = m.role === 'user' ? 'You' : m.role === 'tool' ? 'Tool' : m.role === 'error' ? 'Error' : 'LEGION';
      return `<article class="msg ${cls}">
        <header class="msg-head"><span class="who">${esc(who)}</span><span class="when">${esc(fmtClock(m.at))}</span></header>
        <div class="msg-body">${md(m.text)}</div>
      </article>`;
    }).join('');
    list.scrollTop = list.scrollHeight;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    app.sendText(text);
  });

  mic.addEventListener('pointerdown', (e) => { e.preventDefault(); app.pushToTalkStart(); });
  mic.addEventListener('pointerup', () => app.pushToTalkEnd());
  mic.addEventListener('pointerleave', () => { if (app.pttActive) app.pushToTalkEnd(); });
  mic.addEventListener('pointercancel', () => app.pushToTalkEnd());

  app.on('memory:session', paint);
  app.on('state', () => { mic.classList.toggle('is-hot', app.pttActive); });
  paint();
  setTimeout(() => input.focus(), 60);
  return { refresh: paint, focus: () => input.focus() };
}

/* ================================================================
   TOOLS + SYSTEM
   ================================================================ */

const CATEGORY_BLURB = {
  system: 'Read hardware and operating system state. None of these change anything.',
  files: 'Search, read and write inside your user profile only. Writes and deletes always ask first.',
  apps: 'Launch applications that are already installed, and manage the ones LEGION starts.',
  web: 'Search the web and fetch pages. Outbound requests are the only network traffic you authorise.',
  productivity: 'Notes, history, memory and other local records LEGION maintains for you.',
  dev: 'Run allowlisted developer tools. Every execution is confirmed before it starts.'
};

export function toolsPanel(host, app) {
  host.innerHTML = `
    <div class="sec">
      <h3 class="sec-title">Live system</h3>
      <div class="sys-grid" id="sys-grid"></div>
    </div>
    <div class="sec">
      <h3 class="sec-title">Available tools</h3>
      <div id="tool-list"></div>
    </div>
    <div class="sec">
      <h3 class="sec-title">Recent tool activity</h3>
      <div id="tool-log"></div>
    </div>`;

  const grid = host.querySelector('#sys-grid');
  const list = host.querySelector('#tool-list');
  const log = host.querySelector('#tool-log');

  function paintSys() {
    const m = app.metrics;
    const cells = [
      ['CPU', fmtPct(m.cpu), `${m.cpuCores || '--'} cores`],
      ['Memory', fmtBytes(m.memUsed), `of ${fmtBytes(m.memTotal)}`],
      ['GPU', esc(trunc(m.gpuModel || '--', 20)), m.gpuTemp ? `${Math.round(m.gpuTemp)} C` : '--'],
      ['Uptime', esc(m.uptime || '--'), esc(m.osName || '')],
      ['Battery', (m.battery === null || m.battery === undefined) ? '--' : `${Math.round(m.battery)}%`, m.charging ? 'On AC' : ''],
      ['Disk', fmtBytes(m.disk?.used), `of ${fmtBytes(m.disk?.total)}`]
    ];
    grid.innerHTML = cells.map(([k, v, s]) =>
      `<div class="sys-cell"><span class="k">${k}</span><span class="v">${v}</span><span class="v" style="font-size:10.5px;color:var(--ink-3)">${s || ''}</span></div>`
    ).join('');
  }

  function paintTools() {
    const tools = app.tools || [];
    if (!tools.length) { list.innerHTML = `<div class="empty">Tool registry unavailable.</div>`; return; }
    const byCat = new Map();
    for (const t of tools) {
      if (!byCat.has(t.category)) byCat.set(t.category, []);
      byCat.get(t.category).push(t);
    }
    list.innerHTML = [...byCat.entries()].map(([cat, items]) => `
      <details class="tool-group"${cat === 'system' ? ' open' : ''}>
        <summary>${esc(cat)}<span class="count">${items.length}</span></summary>
        <p class="tool-desc">${esc(CATEGORY_BLURB[cat] || '')}</p>
        ${items.map((t) => `
          <div class="tool-row">
            <div class="n">${esc(t.name)}<span class="tag-risk risk-${esc(t.risk || 'low')}">${esc(t.risk || 'low')}</span></div>
            <p class="d">${esc(t.description || '')}</p>
            <div class="toggles">
              <button class="chip ${t.enabled ? 'is-on' : ''}" data-tool-toggle="${esc(t.name)}">${t.enabled ? 'Enabled' : 'Disabled'}</button>
            </div>
          </div>`).join('')}
      </details>`).join('');
  }

  function paintLog() {
    const entries = app.toolLog.slice(0, 40);
    if (!entries.length) { log.innerHTML = `<div class="empty">No tool activity in this session yet.</div>`; return; }
    log.innerHTML = entries.map((e) => `
      <div class="tool-row">
        <div class="n">${esc(e.name)}<span class="tag-risk risk-${esc(e.risk || 'low')}">${e.ok ? 'ok' : 'failed'}</span></div>
        <p class="d">${esc(trunc(e.summary || e.error || '', 160))}</p>
        <div class="m-meta" style="font-family:var(--mono);font-size:9.5px;color:var(--ink-3)">${esc(fmtClock(e.at))} ${e.ms ? ' - ' + e.ms + ' ms' : ''}</div>
      </div>`).join('');
  }

  list.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tool-toggle]');
    if (!b) return;
    const on = !b.classList.contains('is-on');
    const res = await app.setToolEnabled(b.dataset.toolToggle, on);
    if (!res.ok) app.toast('error', 'Could not change tool', res.error);
  });

  app.on('metrics', paintSys);
  app.on('tools', () => { paintTools(); paintLog(); });
  app.on('toollog', paintLog);
  paintSys(); paintTools(); paintLog();
  return { refresh: () => { paintSys(); paintTools(); paintLog(); } };
}

/* ================================================================
   MEMORY
   ================================================================ */

export function memoryPanel(host, app) {
  host.innerHTML = `
    <div class="sec">
      <div class="row between" style="margin-bottom:12px">
        <h3 class="sec-title" style="margin:0">What LEGION remembers</h3>
        <label class="toggle" style="margin:0">
          <input type="checkbox" id="mem-enabled" />
          <span class="sw"></span>
        </label>
      </div>
      <p class="tool-desc" style="padding-left:0">
        Off by default. When enabled, LEGION may store facts you explicitly ask it to keep. Every entry below is visible, searchable and deletable. Nothing is ever sent anywhere.
      </p>
      <div class="row" style="margin-top:12px">
        <input type="text" id="mem-search" placeholder="Search memory..." style="flex:1;height:32px;padding:0 11px;border:1px solid var(--line-2);border-radius:8px;background:rgba(0,0,0,.32);color:var(--ink);font-size:12.5px;user-select:text" />
        <button class="btn sm ghost" id="mem-clear">Clear all</button>
      </div>
    </div>
    <div class="sec">
      <h3 class="sec-title">Stored facts <span id="mem-count"></span></h3>
      <div id="mem-list"></div>
    </div>
    <div class="sec">
      <h3 class="sec-title">Session transcript</h3>
      <div class="row">
        <button class="btn sm ghost" id="mem-export">Export to file</button>
        <span class="fr-hint" id="mem-export-hint">Saved as JSON in your data folder.</span>
      </div>
    </div>`;

  const toggle = host.querySelector('#mem-enabled');
  const list = host.querySelector('#mem-list');
  const count = host.querySelector('#mem-count');
  const search = host.querySelector('#mem-search');
  let filter = '';

  async function paint() {
    toggle.checked = !!app.config?.memory?.longTermEnabled;
    let items = app.memory.longTerm || [];
    if (filter) {
      const f = filter.toLowerCase();
      items = items.filter((i) => String(i.text || '').toLowerCase().includes(f));
    }
    count.textContent = items.length ? `(${items.length})` : '';
    if (!items.length) {
      list.innerHTML = `<div class="empty">${filter ? 'Nothing matches that search.' : '<strong>No long-term memory</strong>Ask LEGION to remember something, or enable it above.'}</div>`;
      return;
    }
    list.innerHTML = items.map((i) => `
      <div class="mem-item" data-id="${esc(i.id)}">
        <div class="m-body">
          <div class="m-text">${esc(i.text)}</div>
          <div class="m-meta"><span>${esc(fmtClock(i.createdAt))}</span><span>${esc(i.source || 'conversation')}</span></div>
        </div>
        <button class="m-x" data-mem-del="${esc(i.id)}" title="Forget this">
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>
        </button>
      </div>`).join('');
  }

  toggle.addEventListener('change', async () => {
    const res = await app.setConfig({ memory: { longTermEnabled: toggle.checked } });
    if (!res.ok) { toggle.checked = !toggle.checked; app.toast('error', 'Could not save', res.error); return; }
    app.toast('ok', toggle.checked ? 'Long-term memory on' : 'Long-term memory off', null);
    paint();
  });

  search.addEventListener('input', () => { filter = search.value.trim(); paint(); });

  list.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-mem-del]');
    if (!b) return;
    const res = await app.forget(b.dataset.memDel);
    if (!res.ok) app.toast('error', 'Could not forget that', res.error);
    paint();
  });

  host.querySelector('#mem-clear').addEventListener('click', async () => {
    if (!app.memory.longTerm.length) { app.toast('info', 'Nothing stored yet', null); return; }
    const ok = await app.confirm({
      tool: 'memory',
      impact: `permanently delete ${app.memory.longTerm.length} stored fact(s)`,
      message: 'This permanently deletes every long-term memory LEGION holds. Your conversation history is not affected.'
    });
    if (!ok) return;
    const res = await app.forgetAll();
    if (!res.ok) app.toast('error', 'Could not clear memory', res.error);
    else app.toast('ok', 'Long-term memory cleared', null);
    paint();
  });

  host.querySelector('#mem-export').addEventListener('click', async () => {
    const res = await app.exportSession();
    const hint = host.querySelector('#mem-export-hint');
    hint.textContent = res.ok ? `Saved: ${res.path}` : (res.error || 'Export failed');
    hint.className = res.ok ? 'fr-hint ok' : 'fr-hint bad';
  });

  app.on('memory:longterm', paint);
  app.on('config', paint);
  paint();
  return { refresh: paint };
}

/* ================================================================
   SETTINGS
   ================================================================ */

export function settingsPanel(host, app) {
  host.innerHTML = `
    <div class="sec">
      <h3 class="sec-title">AI provider</h3>
      <label class="field">
        <span>Provider</span>
        <select id="set-provider">
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="ollama">Ollama (local)</option>
          <option value="none">None</option>
        </select>
      </label>
      <label class="field" id="set-url-field">
        <span>Base URL</span>
        <input type="text" id="set-url" placeholder="https://api.anthropic.com" spellcheck="false" />
        <span class="hint">Leave the default unless you are using a compatible gateway or a local Ollama host.</span>
      </label>
      <label class="field" id="set-model-field">
        <span>Model</span>
        <input type="text" id="set-model" placeholder="claude-sonnet-4-5" spellcheck="false" />
      </label>
      <div class="field">
        <span>API key</span>
        <div class="row">
          <input type="password" id="set-key" placeholder="Not stored" autocomplete="off" spellcheck="false" style="flex:1" />
          <button class="btn sm ghost" id="set-key-save">Save</button>
          <button class="btn sm ghost" id="set-key-clear">Clear</button>
        </div>
        <span class="hint" id="set-key-hint">Stored locally in your user data folder. Never exposed to this interface.</span>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn sm" id="set-probe">Test connection</button>
        <span class="fr-hint" id="set-probe-hint">Sends one short request.</span>
      </div>
    </div>

    <div class="sec">
      <h3 class="sec-title">Voice</h3>
      <label class="field">
        <span>Speech voice</span>
        <select id="set-voice"><option>Loading...</option></select>
      </label>
      <label class="field">
        <span>Speech rate</span>
        <div class="row">
          <input type="range" id="set-rate" min="-8" max="8" step="1" style="flex:1" />
          <span class="fr-hint" id="set-rate-val" style="min-width:3.4em;text-align:right">0</span>
        </div>
      </label>
      <label class="field">
        <span>Speech volume</span>
        <div class="row">
          <input type="range" id="set-vol" min="0" max="100" step="1" style="flex:1" />
          <span class="fr-hint" id="set-vol-val" style="min-width:3.4em;text-align:right">100</span>
        </div>
      </label>
      <div class="row wrap" style="margin-top:4px">
        <button class="btn sm ghost" id="set-test-voice">Test voice</button>
        <button class="btn sm ghost" id="set-list-devices">List microphones</button>
        <span class="fr-hint" id="set-device-hint"></span>
      </div>
    </div>

    <div class="sec">
      <h3 class="sec-title">Microphone</h3>
      <label class="field">
        <span>Input device</span>
        <select id="set-mic"><option value="default">System default</option></select>
      </label>
      <p class="hint" id="set-mic-scope" style="margin:2px 0 0">This device drives the level meter.</p>
      <div class="row wrap">
        <button class="btn sm ghost" id="set-test-mic">Test microphone</button>
        <span class="fr-hint" id="set-mic-hint">Not tested</span>
      </div>
      <label class="toggle" style="margin-top:14px">
        <input type="checkbox" id="set-mic-autostart" />
        <span class="sw"></span>
        <span class="t-body">
          <span class="t-label">Open the microphone on launch</span>
          <span class="t-hint">Off by default. LEGION never opens a microphone without you asking.</span>
        </span>
      </label>
      <label class="toggle">
        <input type="checkbox" id="set-push-to-talk" />
        <span class="sw"></span>
        <span class="t-body">
          <span class="t-label">Require push to talk</span>
          <span class="t-hint">When on, LEGION only listens while you hold the key. Turn this off for continuous listening.</span>
        </span>
      </label>
      <label class="toggle" id="set-continuous-row" hidden>
        <input type="checkbox" id="set-continuous" />
        <span class="sw"></span>
        <span class="t-body">
          <span class="t-label">Continuous conversation</span>
          <span class="t-hint">Keeps the microphone open and listens again after each reply, so you can talk back and forth without touching the keyboard. It only turns on when push to talk is off.</span>
        </span>
      </label>
    </div>

    <div class="sec">
      <h3 class="sec-title">Appearance and performance</h3>
      <div class="field">
        <span>Theme</span>
        <div class="chips" id="set-themes">
          <button class="chip" data-theme="abyss">Abyss</button>
          <button class="chip" data-theme="ember">Ember</button>
          <button class="chip" data-theme="mint">Mint</button>
          <button class="chip" data-theme="mono">Mono</button>
        </div>
      </div>
      <label class="field">
        <span>Face quality</span>
        <select id="set-quality">
          <option value="low">Low - about 2,000 elements</option>
          <option value="medium">Medium - about 4,000</option>
          <option value="high">High - about 7,000</option>
          <option value="ultra">Ultra - about 11,000</option>
        </select>
        <span class="hint">Quality regenerates the face once. Adaptive mode can lower it automatically if the frame rate drops.</span>
      </label>
      <div class="field">
        <span>Panel position</span>
        <div class="chips" id="set-panelpos">
          <button class="chip" data-pos="right">Right</button>
          <button class="chip" data-pos="left">Left</button>
        </div>
      </div>
      <label class="toggle">
        <input type="checkbox" id="set-adaptive" />
        <span class="sw"></span>
        <span class="t-body">
          <span class="t-label">Adaptive quality</span>
          <span class="t-hint">Lower the face quality automatically when the frame rate falls below target.</span>
        </span>
      </label>
      <label class="toggle">
        <input type="checkbox" id="set-reduced" />
        <span class="sw"></span>
        <span class="t-body">
          <span class="t-label">Reduced motion</span>
          <span class="t-hint">Calm particle drift, scanning and blinking. The face still responds to your voice.</span>
        </span>
      </label>
    </div>

    <div class="sec">
      <h3 class="sec-title">Privacy and data</h3>
      <label class="toggle">
        <input type="checkbox" id="set-store-history" />
        <span class="sw"></span>
        <span class="t-body">
          <span class="t-label">Store conversation history</span>
          <span class="t-hint">Keeps a local transcript of this session so you can scroll back through it.</span>
        </span>
      </label>
      <label class="toggle">
        <input type="checkbox" id="set-allow-web" />
        <span class="sw"></span>
        <span class="t-body">
          <span class="t-label">Allow the AI to use web tools</span>
          <span class="t-hint">When off, the AI cannot search or fetch pages even if the tools are enabled.</span>
        </span>
      </label>
      <label class="toggle">
        <input type="checkbox" id="set-allow-dev" />
        <span class="sw"></span>
        <span class="t-body">
          <span class="t-label">Allow developer commands</span>
          <span class="t-hint">Runs allowlisted CLI tools. Every run is confirmed before it starts. Off by default.</span>
        </span>
      </label>
      <label class="toggle">
        <input type="checkbox" id="set-startup" />
        <span class="sw"></span>
        <span class="t-body">
          <span class="t-label">Launch LEGION at sign-in</span>
          <span class="t-hint">Starts hidden in the tray when you sign in to Windows.</span>
        </span>
      </label>
      <div class="row wrap" style="margin-top:6px">
        <button class="btn sm ghost" id="set-open-data">Open data folder</button>
        <button class="btn sm ghost danger" id="set-reset">Reset all settings</button>
      </div>
      <p class="tool-desc" style="padding-left:0;margin-top:10px" id="set-paths"></p>
    </div>`;

  const $ = (s) => host.querySelector(s);
  const save = (patch) => app.setConfig(patch);

  function fill() {
    const c = app.config || {};
    const ai = c.ai || {};
    const voice = c.voice || {};

    $('#set-provider').value = ai.provider || 'none';
    $('#set-model').value = ai.model || '';
    $('#set-url').value = ai.baseUrl || '';
    syncProviderFields();

    const sel = $('#set-voice');
    if (!sel.dataset.loaded) {
      sel.innerHTML = '<option>Loading...</option>';
      app.loadVoices().then((voices) => {
        if (!voices.length) { sel.innerHTML = '<option>No voices installed</option>'; sel.dataset.loaded = '1'; return; }
        sel.innerHTML = voices.map((v) =>
          `<option value="${esc(v.name)}">${esc(v.name)}${v.gender ? ' - ' + esc(v.gender) : ''}</option>`
        ).join('');
        sel.dataset.loaded = '1';
        const want = app.config?.voice?.voiceName;
        sel.value = voices.some((v) => v.name === want) ? want : (voices[0].name);
      });
    }

    $('#set-rate').value = voice.rate ?? 0;
    $('#set-vol').value = voice.volume ?? 100;
    $('#set-rate-val').textContent = String(voice.rate ?? 0);
    $('#set-vol-val').textContent = String(voice.volume ?? 100);
    $('#set-mic-autostart').checked = !!c.app?.autoListenOnLaunch;
    $('#set-push-to-talk').checked = voice.pushToTalk !== false;
    // Continuous mode is only meaningful when push to talk is off, so its row
    // appears once that toggle is cleared. Both are written to config so the
    // pair can never disagree.
    $('#set-continuous-row').hidden = voice.pushToTalk !== false;
    $('#set-continuous').checked = !!voice.continuous;
    const micSel = $('#set-mic');
    if (!micSel.dataset.loaded) {
      micSel.innerHTML = '<option value="default">System default</option>';
      micSel.dataset.loaded = '1';
    }
    if (voice.micDeviceId && [...micSel.options].some((o) => o.value === voice.micDeviceId)) micSel.value = voice.micDeviceId;

    $('#set-quality').value = c.visual?.quality || 'high';
    $('#set-adaptive').checked = c.visual?.adaptiveQuality !== false;
    $('#set-reduced').checked = !!c.visual?.reducedMotion;
    for (const b of host.querySelectorAll('#set-themes .chip')) b.classList.toggle('is-on', b.dataset.theme === (c.ui?.theme || 'abyss'));
    for (const b of host.querySelectorAll('#set-panelpos .chip')) b.classList.toggle('is-on', b.dataset.pos === (c.ui?.panelPosition || 'right'));

    $('#set-store-history').checked = c.privacy?.storeConversations !== false;
    $('#set-allow-web').checked = c.tools?.allowWeb !== false;
    $('#set-allow-dev').checked = !!c.tools?.allowDev;
    $('#set-startup').checked = !!c.app?.launchAtStartup;

    $('#set-key').value = '';
    refreshKeyHint();
  }

  function syncProviderFields() {
    const p = $('#set-provider').value;
    $('#set-url-field').hidden = p === 'none';
    $('#set-model-field').hidden = p === 'none';
  }

  function refreshKeyHint() {
    const p = $('#set-provider').value;
    const have = app.secrets?.[p];
    const env = p === 'anthropic' ? 'ANTHROPIC_API_KEY' : p === 'openai' ? 'OPENAI_API_KEY' : 'the environment';
    $('#set-key-hint').textContent = have && have.configured
      ? 'A key is available to the main process. Leave the field empty to keep using it.'
      : `No key stored. You can also provide one through ${env}.`;
  }

  $('#set-provider').addEventListener('change', async () => {
    syncProviderFields(); refreshKeyHint();
    const provider = $('#set-provider').value;
    const model = provider === 'anthropic' ? 'claude-sonnet-4-5' : provider === 'openai' ? 'gpt-4o' : provider === 'ollama' ? 'llama3.1' : '';
    const baseUrl = provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
    $('#set-model').value = model;
    $('#set-url').value = baseUrl;
    const r = await save({ ai: { provider, model, baseUrl } });
    if (!r.ok) app.toast('error', 'Could not save provider', r.error);
  });

  $('#set-url').addEventListener('change', (e) => save({ ai: { baseUrl: e.target.value.trim() } }));
  $('#set-model').addEventListener('change', (e) => save({ ai: { model: e.target.value.trim() } }));

  $('#set-key-save').addEventListener('click', async () => {
    const p = $('#set-provider').value;
    const key = $('#set-key').value.trim();
    if (!key) { app.toast('info', 'Paste a key first', null); return; }
    if (p !== 'anthropic' && p !== 'openai') { app.toast('error', 'No key needed', `The ${p} provider does not use an API key.`); return; }
    const res = await app.setKey(p, key);
    if (res.ok) { $('#set-key').value = ''; app.toast('ok', 'Key stored', 'Kept in your local data folder.'); refreshKeyHint(); }
    else app.toast('error', 'Could not store the key', res.error);
  });

  $('#set-key-clear').addEventListener('click', async () => {
    const p = $('#set-provider').value;
    if (p !== 'anthropic' && p !== 'openai') return;
    const res = await app.setKey(p, '');
    if (res.ok) { app.toast('ok', 'Key removed', null); refreshKeyHint(); }
    else app.toast('error', 'Could not remove the key', res.error);
  });

  $('#set-probe').addEventListener('click', async () => {
    const hint = $('#set-probe-hint');
    hint.className = 'fr-hint';
    hint.textContent = 'Testing...';
    const res = await app.testProvider();
    hint.className = res.ok ? 'fr-hint ok' : 'fr-hint bad';
    hint.textContent = res.ok ? (res.detail || 'Reachable.') : (res.error || 'Unreachable.');
  });

  $('#set-voice').addEventListener('change', (e) => save({ voice: { voiceName: e.target.value } }));
  $('#set-rate').addEventListener('input', (e) => { $('#set-rate-val').textContent = e.target.value; });
  $('#set-rate').addEventListener('change', (e) => save({ voice: { rate: Number(e.target.value) } }));
  $('#set-vol').addEventListener('input', (e) => { $('#set-vol-val').textContent = e.target.value; app.audio.setSpeakingGain(Number(e.target.value)); });
  $('#set-vol').addEventListener('change', (e) => save({ voice: { volume: Number(e.target.value) } }));

  $('#set-test-voice').addEventListener('click', () => app.speak('This is LEGION. Voice output is working.'));

  $('#set-list-devices').addEventListener('click', async () => {
    const hint = $('#set-device-hint');
    hint.className = 'fr-hint';
    hint.textContent = 'Requesting permission...';
    const devs = await app.listMicDevices();
    if (!devs.length) { hint.className = 'fr-hint bad'; hint.textContent = 'No input devices. Check Windows sound settings.'; return; }
    const sel = $('#set-mic');
    sel.innerHTML = '<option value="default">System default</option>' +
      devs.map((d) => `<option value="${esc(d.deviceId)}">${esc(d.label)}</option>`).join('');
    sel.dataset.loaded = '1';
    hint.className = 'fr-hint ok';
    hint.textContent = `${devs.length} input device(s).`;
  });

  $('#set-mic').addEventListener('change', (e) => save({ voice: { micDeviceId: e.target.value } }));

  $('#set-test-mic').addEventListener('click', async () => {
    const hint = $('#set-mic-hint');
    hint.className = 'fr-hint';
    hint.textContent = 'Requesting...';
    try {
      await app.audio.startMic(app.micDeviceId);
      hint.className = 'fr-hint ok';
      hint.textContent = 'Microphone is open and reporting levels.';
    } catch (err) {
      hint.className = 'fr-hint bad';
      hint.textContent = err.message;
    }
  });

  // The dictation engine has no capture-device API, so the choice here only
  // reaches the analyser. Say so rather than implying the recogniser follows.
  (async () => {
    const note = $('#set-mic-scope');
    let caps = null;
    try { caps = await app.voiceCaps(); } catch (_) { /* keep the default note */ }
    if (caps && caps.selectableCaptureDevice === false) {
      note.textContent = 'This device drives the level meter only. Dictation uses the Windows default input, because the speech engine cannot be pointed at a chosen microphone.';
    } else if (caps && caps.selectableCaptureDevice) {
      note.textContent = 'This device drives the level meter and dictation.';
    } else {
      note.textContent = 'This device drives the level meter.';
    }
  })();

  $('#set-mic-autostart').addEventListener('change', (e) => save({ app: { autoListenOnLaunch: e.target.checked } }));
  $('#set-push-to-talk').addEventListener('change', (e) => {
    const on = e.target.checked;
    // Re-enabling push to talk turns continuous mode off in the same write, so
    // the two settings cannot end up contradicting each other.
    save({ voice: on ? { pushToTalk: true, continuous: false } : { pushToTalk: false } });
    $('#set-continuous-row').hidden = on;
    if (on) $('#set-continuous').checked = false;
    // Config alone is not enough: the live session has to drop continuous mode
    // and close the microphone the mode was holding open.
    if (on) app.setContinuousMode(false);
  });

  $('#set-continuous').addEventListener('change', (e) => {
    const on = e.target.checked;
    save({ voice: { continuous: on, pushToTalk: !on } });
    if (on) {
      $('#set-push-to-talk').checked = false;
      $('#set-continuous-row').hidden = false;
      app.setContinuousMode(true);
    } else {
      app.setContinuousMode(false);
    }
  });

  $('#set-quality').addEventListener('change', async (e) => {
    const q = e.target.value;
    const r = await save({ visual: { quality: q } });
    if (!r.ok) { app.toast('error', 'Could not save quality', r.error); return; }
    await app.rebuildFace(q);
  });
  $('#set-adaptive').addEventListener('change', (e) => save({ visual: { adaptiveQuality: e.target.checked } }));
  $('#set-reduced').addEventListener('change', (e) => save({ visual: { reducedMotion: e.target.checked } }));

  host.querySelector('#set-themes').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-theme]');
    if (!b) return;
    const r = await save({ ui: { theme: b.dataset.theme } });
    if (!r.ok) return app.toast('error', 'Could not save theme', r.error);
    for (const x of host.querySelectorAll('#set-themes .chip')) x.classList.toggle('is-on', x === b);
  });

  host.querySelector('#set-panelpos').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pos]');
    if (!b) return;
    const r = await save({ ui: { panelPosition: b.dataset.pos } });
    if (!r.ok) return app.toast('error', 'Could not save', r.error);
    for (const x of host.querySelectorAll('#set-panelpos .chip')) x.classList.toggle('is-on', x === b);
    app.setPanelPosition(b.dataset.pos);
  });

  $('#set-store-history').addEventListener('change', (e) => save({ privacy: { storeConversations: e.target.checked } }));
  $('#set-allow-web').addEventListener('change', (e) => save({ tools: { allowWeb: e.target.checked } }));
  $('#set-allow-dev').addEventListener('change', (e) => save({ tools: { allowDev: e.target.checked } }));
  $('#set-startup').addEventListener('change', (e) => save({ app: { launchAtStartup: e.target.checked } }));

  $('#set-open-data').addEventListener('click', () => app.openDataFolder());
  $('#set-reset').addEventListener('click', async () => {
    const ok = await app.confirm({
      tool: 'settings', impact: 'reset every setting to its default',
      message: 'All settings return to their defaults. Stored API keys, conversation history and long-term memory are deleted. This cannot be undone.'
    });
    if (!ok) return;
    const r = await app.resetAll();
    if (r.ok) { app.toast('ok', 'Settings reset', 'Reloading...'); setTimeout(() => location.reload(), 900); }
    else app.toast('error', 'Could not reset', r.error);
  });

  app.on('config', fill);
  fill();
  return { refresh: fill };
}

/* -- helpers ---------------------------------------------------- */

function trunc(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '...' : s; }

function md(text) {
  return esc(text || '')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}
