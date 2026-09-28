'use strict';

const { RISK, ToolError } = require('./registry');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const TIMEOUT = 15000;

async function fetchText(url, opts) {
  const options = opts || {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeout || TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': options.ua || UA,
        'Accept': options.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    return { res, body: await res.text() };
  } finally { clearTimeout(timer); }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function stripHtml(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = function registerWebTools(registry) {
  registry.register({
    name: 'web_search',
    category: 'web',
    risk: RISK.READ,
    description: 'Search the web and return ranked results with titles, URLs and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 25, description: 'Default 8.' }
      },
      required: ['query']
    },
    async handler({ query, maxResults }) {
      const cap = Math.min(maxResults || 8, 25);
      const q = String(query).trim();
      if (!q) throw new ToolError('A query is required.', 'E_INPUT');

      const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
      let body;
      try {
        const { body: b } = await fetchText(url);
        body = b;
      } catch (err) {
        throw new ToolError(`Search request failed: ${err.message}`, 'E_NETWORK');
      }

      const results = [];
      const blocks = body.split('result results_links').slice(1);
      for (const block of blocks) {
        if (results.length >= cap) break;
        const linkMatch = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
          || block.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
        if (!linkMatch) continue;
        let href = decodeEntities(linkMatch[1]);
        const title = stripHtml(linkMatch[2]);
        const snipMatch = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
          || block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        let snippet = snipMatch ? stripHtml(snipMatch[1]) : '';
        const uddg = href.match(/uddg=([^&]+)/);
        if (uddg) href = decodeURIComponent(uddg[1]);
        if (!/^https?:/i.test(href)) continue;
        results.push({ title, url: href, snippet: snippet.slice(0, 400) });
      }

      return {
        query: q, engine: 'duckduckgo', count: results.length,
        results: results.length ? results : [{ note: 'No results were returned. Try rephrasing the query.' }]
      };
    }
  });

  registry.register({
    name: 'web_fetch',
    category: 'web',
    risk: RISK.READ,
    description: 'Retrieve a web page and return its readable text content.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Must be http or https.' },
        maxChars: { type: 'integer', minimum: 200, maximum: 200000, description: 'Default 12000.' }
      },
      required: ['url']
    },
    async handler({ url, maxChars }) {
      let parsed;
      try { parsed = new URL(url); } catch (_) { throw new ToolError('That is not a valid URL.', 'E_URL'); }
      if (!/^https?:$/.test(parsed.protocol)) throw new ToolError('Only http and https URLs are supported.', 'E_URL_SCHEME');
      const cap = Math.min(maxChars || 12000, 200000);
      let res; let body;
      try { ({ res, body } = await fetchText(parsed.toString())); }
      catch (err) { throw new ToolError(`Could not retrieve the page: ${err.message}`, 'E_NETWORK'); }
      const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      return {
        url: res.url || parsed.toString(), status: res.status,
        contentType: res.headers.get('content-type'),
        title: titleMatch ? stripHtml(titleMatch[1]) : null,
        text: stripHtml(body).slice(0, cap), truncated: stripHtml(body).length > cap
      };
    }
  });

  registry.register({
    name: 'web_open',
    category: 'web',
    risk: RISK.SYSTEM,
    description: 'Open a URL in the default browser.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    async handler(args, ctx) { return registry.get('apps_open_url').handler(args, ctx); }
  });
};

module.exports.stripHtml = stripHtml;
module.exports.decodeEntities = decodeEntities;
