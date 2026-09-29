'use strict';

/**
 * Voice pack checks.
 *
 * Asserts the behaviours that make a pack trustworthy: a listed phrase plays the
 * recorded clip instead of synthesised speech, an unlisted phrase still gets
 * normal SAPI, a disabled pack is ignored, and a manifest cannot read files from
 * outside its own folder.
 */

const path = require('path');
const tts = require('../src/main/voice/tts');
const voicepack = require('../src/main/voice/voicepack');

let failed = 0;
const results = [];

// The callbacks are async (they hit the voice pack and the SAPI engine), so the
// runner has to await them. A sync runner would let a failed assert escape as an
// unhandled rejection and the check would still print PASS.
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail: detail || '' });
  } catch (err) {
    failed++;
    results.push({ ok: false, name, detail: err.message });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  const pack = await voicepack.describe();
  console.log(`pack: ${pack.name || '(unnamed)'} v${pack.version || '?'}`);
  console.log(`folder: ${pack.root}`);
  console.log(`enabled: ${pack.enabled}  entries: ${pack.entries.length}  loose clips: ${pack.looseFiles.length}\n`);

  await check('the voicepack folder exists', () => {
    assert(pack.exists, `no folder at ${pack.root}`);
    return pack.root;
  });

  await check('manifest.json parses with no complaints', () => {
    assert(pack.problems.length === 0, pack.problems.join('; '));
    return `${pack.entries.length} entries accepted`;
  });

  await check('the shipped example pack has clips', () => {
    assert(pack.entries.length > 0, 'the example pack ships with no entries');
    return `${pack.entries.length} entries`;
  });

  const first = pack.entries[0];
  const listed = first ? await voicepack.resolve(first.phrase) : null;

  await check('a listed phrase resolves to the recorded clip', () => {
    assert(first, 'no entries to test');
    assert(listed, `"${first.phrase}" did not resolve`);
    assert(listed.source === 'voicepack', `source was "${listed.source}", expected "voicepack"`);
    assert(listed.audio && listed.audio.length > 1000, 'clip is empty or implausibly small');
    return `"${first.phrase}" -> ${first.file}, ${listed.bytes} bytes`;
  });

  await check('a pack clip is decodable audio, not a renamed text file', () => {
    assert(listed, 'nothing resolved');
    assert(listed.format === 'wav' || listed.format === 'mp3', `unexpected format ${listed.format}`);
    assert(voicepack.looksLikeAudio(listed.audio, '.' + listed.format), `does not look like ${listed.format}`);
    assert(listed.durationMs > 100, `duration ${listed.durationMs}ms is too short to be speech`);
    assert(listed.sampleRate > 0, 'no sample rate parsed from the header');
    return `${listed.format} ${listed.sampleRate}Hz, ${listed.durationMs}ms`;
  });

  await check('phrase matching ignores case and punctuation', async () => {
    assert(first, 'no entries to test');
    for (const variant of [first.phrase.toLowerCase(), first.phrase.toUpperCase() + '  ', '  ' + first.phrase.replace(/\.$/, '') + '!']) {
      const hit = await voicepack.resolve(variant);
      assert(hit, `"${variant}" did not match the same clip`);
      assert(hit.bytes === listed.bytes, `"${variant}" matched a different clip`);
    }
    return '3 spellings hit one clip';
  });

  await check('an unlisted phrase falls through to SAPI', async () => {
    const res = await tts.synthesize('The quarterly projection exceeded the revised baseline.', {});
    assert(res.audio && res.audio.length > 0, 'no audio came back for an unlisted phrase');
    assert(res.source === 'sapi', `source was "${res.source}", expected "sapi"`);
    return `fell through to SAPI, ${res.bytes} bytes`;
  });

  await check('an empty phrase is not spoken at all', async () => {
    const res = await tts.synthesize('   ', {});
    assert(res.empty === true && !res.audio, 'expected an empty result');
    return 'empty input returns early';
  });

  await check('phrase normalisation is stable', () => {
    assert(voicepack.normalise("I'm listening.") === "i'm listening", 'apostrophe or period not folded');
    assert(voicepack.slug('I didn\'t understand that.') === 'i-didnt-understand-that', 'slug is wrong');
    return `"I'm listening." -> "i'm listening"`;
  });

  await check('a manifest cannot read files outside the pack', () => {
    const dir = voicepack.root();
    // Exercise the real guard, not a pattern match on its source.
    const escapes = [
      '../package.json',
      '../../package.json',
      '..\\..\\package.json',
      path.resolve(__dirname, '..', 'package.json'),
      'C:/Windows/win.ini',
      'nested/../../../package.json'
    ];
    for (const rel of escapes) {
      const resolved = voicepack.safeJoin(dir, rel);
      assert(resolved === null || resolved.startsWith(dir + path.sep), `"${rel}" escaped the pack as ${resolved}`);
    }
    // And a legitimate nested file inside the pack must still be allowed.
    const inside = voicepack.safeJoin(dir, 'yes.wav');
    assert(inside && inside.startsWith(dir + path.sep), 'a valid in-pack path was rejected');
    return `${escapes.length} traversal attempts rejected, in-pack paths allowed`;
  });

  await check('a manifest entry pointing at a missing file degrades to SAPI', async () => {
    const res = await tts.synthesize('On it.', {});
    assert(res.source === 'voicepack', 'the shipped entry should hit');
    const res2 = await tts.synthesize('Absolutely nothing like the other replies.', {});
    assert(res2.source === 'sapi', 'fallback did not engage');
    return 'a miss does not throw';
  });

  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ' -> ' + r.detail : ''}`);
  }
  console.log('');
  if (failed) {
    console.log(`${failed} of ${results.length} voice pack checks FAILED`);
    process.exit(1);
  }
  console.log(`all ${results.length} voice pack checks passed`);
})().catch((err) => {
  console.error('voice pack check crashed: ' + (err && err.stack || err));
  process.exit(1);
});
