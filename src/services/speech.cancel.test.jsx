/**
 * QA regression tests — "录音取消" (cancelRecording) feature in speech.js.
 *
 * Drives the REAL startRecording()/cancelRecording() with mocked
 * MediaRecorder / getUserMedia / fetch (same isolation strategy as the
 * repo's speech.asr.*.test.jsx files) and asserts the cancel contract:
 *
 *   A. startRecording()'s returned Promise resolves with an EMPTY payload
 *      ({ transcript: '', audioBlob: null }) so the UI treats it as "do not send".
 *   B. the microphone is released — every track of recordingStream.stop() is called.
 *   C. full state reset — a fresh startRecording() after cancel works again
 *      (no leaked state / no exception).
 *   D. calling cancelRecording() with NO active session is a safe no-op
 *      (no throw, no status/error reporting, no track.stop, no resolve).
 *   E. cancel surfaces a NEUTRAL diagnostic status (phase 待命, detail 已取消)
 *      and does NOT surface a red-text error.
 *   F. idempotent — cancelling twice only resolves/cleans once (no double-resolve).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startRecording,
  stopRecording,
  cancelRecording,
  setCloudTtsUrl,
  setAsrErrorHandler,
  setAsrStatusHandler,
} from './speech.js';

if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = (ms) => new AbortController().signal;
}

// --- collected status/error sink ---
const collected = { errors: [], statuses: [] };

// --- MediaRecorder mock ---
class MockMediaRecorder {
  constructor(stream, opts) {
    this.stream = stream;
    this.mimeType = (opts && opts.mimeType) || 'audio/webm';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
  }
  start() {
    this.state = 'recording';
    if (typeof this.ondataavailable === 'function') {
      this.ondataavailable({ data: new Blob(['chunk'], { type: this.mimeType }) });
    }
  }
  stop() {
    this.state = 'inactive';
    if (typeof this.onstop === 'function') this.onstop();
  }
}

// --- SpeechRecognition mock (for the native branch) ---
const recognitionInstances = [];
class MockSpeechRecognition {
  constructor() {
    this.lang = '';
    this.continuous = false;
    this.interimResults = false;
    this.onresult = null;
    this.onend = null;
    this.onerror = null;
    this.stop = vi.fn();
    recognitionInstances.push(this);
  }
  start() {}
}

// --- getUserMedia mock with per-call track.stop spy accounting ---
// mockImplementation (NOT mockResolvedValue) so every getUserMedia() call
// creates a FRESH stream with a FRESH track.stop spy — this lets scenario C
// assert that each recording session released exactly one mic track.
const trackStops = [];
function makeStream() {
  const stop = vi.fn();
  trackStops.push(stop);
  return { getTracks: () => [{ stop }] };
}

function setGetUserMedia(fn) {
  try {
    navigator.mediaDevices = { getUserMedia: fn };
  } catch {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      writable: true,
      value: { getUserMedia: fn },
    });
  }
}

function installGlobals({ fetchImpl, mode = 'cloud' } = {}) {
  vi.stubGlobal('MediaRecorder', MockMediaRecorder);
  setGetUserMedia(vi.fn().mockImplementation(() => Promise.resolve(makeStream())));
  recognitionInstances.length = 0;
  if (mode === 'cloud') {
    window.SpeechRecognition = undefined;
    window.webkitSpeechRecognition = undefined;
  } else {
    window.SpeechRecognition = MockSpeechRecognition;
    window.webkitSpeechRecognition = undefined;
  }
  if (fetchImpl) vi.stubGlobal('fetch', fetchImpl);
  collected.errors = [];
  collected.statuses = [];
  setAsrErrorHandler((m) => collected.errors.push(m));
  setAsrStatusHandler((s) => collected.statuses.push(s));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  trackStops.length = 0;
  collected.errors = [];
  collected.statuses = [];
  setCloudTtsUrl('https://asr.example.dev'); // cloud branch is the production default
  // Clean any dangling module-level recording state from a prior test so each
  // test starts from a known-good idle state. cancelRecording is idempotent and
  // safe to call when idle.
  cancelRecording();
  setAsrErrorHandler(null);
  setAsrStatusHandler(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setAsrErrorHandler(null);
  setAsrStatusHandler(null);
});

describe('cancelRecording — core cancel contract', () => {
  // --- Scenario A: the dangling startRecording() Promise resolves EMPTY ---
  it('A: startRecording promise resolves with EMPTY payload after cancel (UI does not send)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ result: 'hi' }),
    });
    installGlobals({ fetchImpl: fetchSpy });

    const recordPromise = startRecording('en-US', null);
    await flush(); // let startRecording finish setting up recordingResolve
    cancelRecording();
    const result = await recordPromise;

    // Critical: payload is empty => the UI must treat it as "do not send".
    expect(result).toEqual({ transcript: '', audioBlob: null });
    // A cancel must NOT trigger an upload/send (the cloud fetch is never called).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // --- Scenario B: the microphone is released ---
  it('B: cancel releases the microphone (recordingStream tracks are stopped)', async () => {
    installGlobals({});

    const recordPromise = startRecording('en-US', null);
    await flush();
    cancelRecording();
    await recordPromise; // let the await + cleanup settle

    // Exactly one session => exactly one track.stop, invoked once.
    expect(trackStops.length).toBe(1);
    expect(trackStops[0]).toHaveBeenCalledTimes(1);
  });

  // --- Scenario C: full state reset, no leak across re-record ---
  it('C: a second startRecording works after cancel (no leaked state)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ result: 'hi' }),
    });
    installGlobals({ fetchImpl: fetchSpy });

    // First session
    let p1 = startRecording('en-US', null);
    await flush();
    cancelRecording();
    const r1 = await p1;
    expect(r1).toEqual({ transcript: '', audioBlob: null });

    // Second session — must start cleanly and cancel the same way.
    let p2 = startRecording('en-US', null);
    await flush();
    cancelRecording();
    const r2 = await p2;
    expect(r2).toEqual({ transcript: '', audioBlob: null });

    // Two sessions => two distinct streams, each released exactly once.
    expect(trackStops.length).toBe(2);
    expect(trackStops[0]).toHaveBeenCalledTimes(1);
    expect(trackStops[1]).toHaveBeenCalledTimes(1);
  });

  // --- Scenario D: no-op when idle ---
  it('D: cancel with no active session is a safe no-op (no report, no mic release)', () => {
    installGlobals({});
    const statusCountBefore = collected.statuses.length;
    const errorCountBefore = collected.errors.length;

    let threw = false;
    try {
      cancelRecording();
    } catch {
      threw = true;
    }

    expect(threw).toBe(false); // never throws on idle
    expect(collected.statuses.length).toBe(statusCountBefore); // no diagnostic emitted
    expect(collected.errors.length).toBe(errorCountBefore);    // no red text
    expect(trackStops.length).toBe(0);                          // no mic release (no stream)
  });

  // --- Scenario E: neutral diagnostic, no red text ---
  it('E: cancel reports a NEUTRAL status (待命 / 已取消) and NO red error', async () => {
    installGlobals({ fetchImpl: vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ result: 'hi' }),
    }) });

    const recordPromise = startRecording('en-US', null);
    await flush();
    cancelRecording();
    await recordPromise;

    // The LAST status pushed is the neutral cancel status.
    const last = collected.statuses.at(-1);
    expect(last).toBeTruthy();
    expect(last.phase).toBe('待命');
    expect(last.detail).toContain('已取消');
    // Crucially: a cancel must NOT surface red text.
    expect(collected.errors).toEqual([]);
  });

  // --- Scenario F: idempotent double cancel ---
  it('F: cancelling twice is idempotent (no double-resolve, no extra side effects)', async () => {
    installGlobals({});

    const recordPromise = startRecording('en-US', null);
    await flush();
    cancelRecording();
    // Second cancel must be a harmless no-op.
    let threw = false;
    try {
      cancelRecording();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    const result = await recordPromise;
    expect(result).toEqual({ transcript: '', audioBlob: null });
    // Only the first session's mic was released (no second stream existed).
    expect(trackStops.length).toBe(1);
    expect(trackStops[0]).toHaveBeenCalledTimes(1);
    // The second (no-op) cancel must not surface red text either.
    expect(collected.errors).toEqual([]);
  });
});

describe('cancelRecording — native recognition branch', () => {
  it('A-native: cancel resolves EMPTY in the native (no-cloud) branch too', async () => {
    // Native branch: no cloud URL set, but a real SpeechRecognition is available.
    localStorage.clear();
    setCloudTtsUrl(''); // disable cloud path => native branch
    installGlobals({ mode: 'native' });

    const recordPromise = startRecording('en-US', null);
    await flush();
    cancelRecording();
    const result = await recordPromise;

    expect(result).toEqual({ transcript: '', audioBlob: null });
    // recognition.stop() was called (engine detached)
    expect(recognitionInstances.length).toBeGreaterThan(0);
    expect(recognitionInstances[0].stop).toHaveBeenCalled();
    // mic released
    expect(trackStops.length).toBe(1);
    expect(trackStops[0]).toHaveBeenCalledTimes(1);
  });
});
