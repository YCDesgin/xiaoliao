/**
 * asr_qa_regression_test.js — standalone frontend ASR regression guard.
 *
 * Run with:  node asr_qa_regression_test.js   (from the project root)
 *
 * Two layers of verification (no browser / no vitest needed):
 *
 *   PART 1 — Static dead-chain check (prevents regression of the exact bug):
 *     The original Huawei silent-drop was caused by a 5-generation chain of
 *     broken mobile-audio hacks: extendable-media-recorder → AudioWorklet /
 *     ScriptProcessor → client-side decodeAudioData + WAV encoding → upload.
 *     We assert that chain is GONE and the new "native capture + raw Blob
 *     upload" design is in place (cloudAsr / cloudStopAndEncode /
 *     setAsrErrorHandler all present; reportAsrError covers every failure path).
 *
 *   PART 2 — Behavioral: actually import speech.js and exercise cloudAsr():
 *     with minimal node shims (localStorage + fetch + the global Blob that
 *     Node 22 already provides), prove cloudAsr POSTs the RAW Blob to
 *     ?action=asr, returns text on success, returns '' on empty result,
 *     and throws a proxied error on HTTP 500 / on missing audio.
 *
 * This file is the "asr_qa_regression_test.js" referenced in the QA plan and
 * is intended to be runnable directly via `node`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('  PASS  ' + name);
  } else {
    failures++;
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  }
}

console.log('\n=== PART 1: static dead-chain / wiring checks ===\n');

const speechRaw = fs.readFileSync(path.join(root, 'src/services/speech.js'), 'utf8');
// Strip comments before pattern checks: the file documents the *removed* dead
// chain in its header/inline comments, so matching raw text yields false
// positives. We only care about EXECUTABLE code references.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/\/\/[^\n]*/g, '');     // line comments
}
const speechSrc = stripComments(speechRaw);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});

check('package.json no longer depends on extendable-media-recorder',
  !('extendable-media-recorder' in deps));

check('speech.js does not import/reference extendable-media-recorder',
  !/extendable-media-recorder/.test(speechSrc));

check('speech.js has no ScriptProcessorNode fallback (dead chain removed)',
  !/ScriptProcessor/i.test(speechSrc));

check('speech.js has no AudioWorklet fallback (dead chain removed)',
  !/AudioWorklet/i.test(speechSrc));

check('speech.js no longer encodes WAV on the client (cloudStopAndEncode returns raw Blob)',
  !/function\s+encodeWav|encodeWav\(/i.test(speechSrc));

// Required symbols present in the new design.
check('speech.js exports cloudAsr (raw Blob upload)',
  /export\s+async\s+function\s+cloudAsr/.test(speechSrc));
check('speech.js exports setAsrErrorHandler (red-text reporter)',
  /export\s+function\s+setAsrErrorHandler/.test(speechSrc));
check('speech.js defines cloudStopAndEncode (returns Blob|null, no client decode)',
  /function\s+cloudStopAndEncode/.test(speechSrc));

// cloudStopAndEncode must NOT call decodeAudioData (that was the mobile-breaking bit).
const csae = speechSrc.match(/async function cloudStopAndEncode\(\)\s*\{[\s\S]*?\n\}/);
check('cloudStopAndEncode does NOT call decodeAudioData',
  !(csae && /decodeAudioData/.test(csae[0])));

// reportAsrError must cover all the failure paths the fix promised.
check('red-text: mic permission denied handled', /麦克风不可用/.test(speechSrc));
check('red-text: no audio captured handled', /没听到声音/.test(speechSrc));
check('red-text: empty recognition result handled', /没听清/.test(speechSrc));
check('red-text: network/HTTP errors classified', /classifyAsrError/.test(speechSrc));

console.log('\n=== PART 2: behavioral cloudAsr (real import, node shims) ===\n');

// Minimal browser-global shims so speech.js can run under plain node.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let lastReq = null;
function installFetch(impl) {
  globalThis.fetch = impl;
}

// Import AFTER shims are in place.
const { cloudAsr, setCloudTtsUrl, setAsrErrorHandler } = await import('./src/services/speech.js');

setCloudTtsUrl('https://asr.example.dev');
let asrErr = null;
setAsrErrorHandler((m) => { asrErr = m; });

// 2a) happy path
installFetch(async (url, opts) => {
  lastReq = { url, opts };
  return { ok: true, status: 200, json: async () => ({ result: 'hello from node' }) };
});
const text = await cloudAsr(new Blob(['audio'], { type: 'audio/webm' }));
check('cloudAsr returns recognized text', text === 'hello from node', 'got ' + JSON.stringify(text));
check('cloudAsr posts to ?action=asr', !!lastReq && lastReq.url.includes('action=asr'), lastReq && lastReq.url);
check('cloudAsr POSTs the RAW Blob (no decode/WAV)',
  !!lastReq && lastReq.opts && lastReq.opts.body instanceof Blob);
check('cloudAsr uses POST method', !!lastReq && lastReq.opts && lastReq.opts.method === 'POST');

// 2b) empty result -> returns '' (stopRecording then shows 没听清)
installFetch(async () => ({ ok: true, status: 200, json: async () => ({ result: '' }) }));
const empty = await cloudAsr(new Blob(['x'], { type: 'audio/webm' }));
check('cloudAsr returns empty string for empty result (feeds 没听清 path)', empty === '', 'got ' + JSON.stringify(empty));

// 2c) HTTP 500 -> throws with the proxied error message
installFetch(async () => ({ ok: false, status: 500, json: async () => ({ error: 'proxy down' }) }));
let threw = null;
try { await cloudAsr(new Blob(['x'], { type: 'audio/webm' })); }
catch (e) { threw = e.message; }
check('cloudAsr throws the proxied error on HTTP 500', /proxy down/.test(threw || ''), threw);

// 2d) missing audio blob -> throws 没有采集到音频数据
let threw2 = null;
try { await cloudAsr(null); }
catch (e) { threw2 = e.message; }
check('cloudAsr throws on missing audio blob', /没有采集到音频数据/.test(threw2 || ''), threw2);

console.log('\n' + (failures === 0 ? 'ASR REGRESSION: ALL PASS ✅' : 'ASR REGRESSION: ' + failures + ' FAILURE(S) ❌'));
process.exit(failures === 0 ? 0 : 1);
