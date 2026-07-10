/**
 * QA regression tests for the cloud ASR fix in speech.js.
 *
 * The fix's promise: on Huawei / no-GMS Android, long-pressing the mic and
 * speaking English must (a) actually return recognized text, and (b) if anything
 * fails, surface a RED-TEXT error — NEVER silently disappear (the original bug).
 *
 * These tests drive the REAL startRecording()/stopRecording()/cloudAsr() code with
 * mocked MediaRecorder / getUserMedia / fetch, and assert:
 *   - cloudAsr POSTs the RAW Blob binary to ?action=asr (no client decode/WAV)
 *   - happy path returns the recognized text and shows NO red text
 *   - red-text fallback fires for EVERY failure path:
 *       (a) mic permission denied
 *       (a) MediaRecorder unsupported
 *       (b) empty recognition result  -> "没听清"
 *       (c) proxy HTTP 500          -> proxied error message
 *       (d) no audio captured       -> "没听到声音"
 *
 * jsdom notes: MediaRecorder/navigator.mediaDevices/fetch are stubbed per test.
 * AbortSignal.timeout is polyfilled defensively (Node 22 has it already).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startRecording,
  stopRecording,
  cloudAsr,
  setCloudTtsUrl,
  setAsrErrorHandler,
} from './speech.js';

if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = (ms) => new AbortController().signal;
}

// --- mock infrastructure ----------------------------------------------------

let asrErrors = [];

function installAsrHandler() {
  asrErrors = [];
  setAsrErrorHandler((m) => asrErrors.push(m));
}

let deliverData = true;       // does MediaRecorder.start() emit a chunk?
let constructorThrows = false; // does `new MediaRecorder` throw (unsupported)?

class MockMediaRecorder {
  constructor(stream, opts) {
    if (constructorThrows) throw new Error('MediaRecorder is not supported');
    this.stream = stream;
    this.mimeType = (opts && opts.mimeType) || 'audio/webm';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
  }
  start() {
    this.state = 'recording';
    if (deliverData && typeof this.ondataavailable === 'function') {
      this.ondataavailable({ data: new Blob(['chunk-bytes'], { type: this.mimeType }) });
    }
  }
  stop() {
    this.state = 'inactive';
    if (typeof this.onstop === 'function') this.onstop();
  }
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

function installGlobals({ deliver = true, throwCtor = false, fetchImpl } = {}) {
  deliverData = deliver;
  constructorThrows = throwCtor;
  vi.stubGlobal('MediaRecorder', MockMediaRecorder);
  setGetUserMedia(vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }));
  window.SpeechRecognition = undefined;
  window.webkitSpeechRecognition = undefined;
  if (fetchImpl) vi.stubGlobal('fetch', fetchImpl);
  installAsrHandler();
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  asrErrors = [];
  setCloudTtsUrl('https://asr.example.dev'); // enable the cloud ASR branch
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- 1. cloudAsr direct unit tests ----------------------------------------

describe('cloudAsr — raw Blob upload to ?action=asr', () => {
  it('POSTs the raw Blob binary and returns the recognized text', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'hello world' }),
    });
    installGlobals({ fetchImpl: fetchSpy });

    const blob = new Blob(['audio-bytes'], { type: 'audio/webm' });
    const text = await cloudAsr(blob);

    expect(text).toBe('hello world');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain('https://asr.example.dev');
    expect(url).toContain('action=asr');
    expect(opts.method).toBe('POST');
    // Critical: the body is the RAW Blob — no decodeAudioData / WAV encoding.
    expect(opts.body).toBeInstanceOf(Blob);
  });

  it('throws with the proxied error when the proxy returns HTTP 500', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'NLS gateway timeout' }),
    });
    installGlobals({ fetchImpl: fetchSpy });

    await expect(cloudAsr(new Blob(['x'], { type: 'audio/webm' }))).rejects.toThrow(/NLS gateway timeout/);
  });

  it('throws when no audio blob is supplied', async () => {
    installGlobals({});
    await expect(cloudAsr(null)).rejects.toThrow(/没有采集到音频数据/);
  });

  it('returns empty string (does NOT throw) on empty recognition result', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: '' }),
    });
    installGlobals({ fetchImpl: fetchSpy });

    const t = await cloudAsr(new Blob(['x'], { type: 'audio/webm' }));
    expect(t).toBe('');
  });
});

// --- 2. stopRecording cloud branch — red-text fallback ---------------------

async function startThenStop(fetchImpl, { deliver = true, throwCtor = false } = {}) {
  installGlobals({ fetchImpl, deliver, throwCtor });
  const p = startRecording('en-US', null); // fires; resolves on stopRecording
  await flush(); // let setupCloudWavCapture() finish & set recordingResolve
  const result = await stopRecording();
  return result;
}

describe('stopRecording cloud branch — red-text fallback (never silent)', () => {
  it('HAPPY path: returns recognized text and shows NO red text', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'hello world' }),
    });
    const result = await startThenStop(fetchSpy);
    expect(result.transcript).toBe('hello world');
    expect(asrErrors).toEqual([]);
  });

  it('(b) empty recognition result -> red text "没听清"', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: '' }),
    });
    await startThenStop(fetchSpy);
    expect(asrErrors.some((m) => m.includes('没听清'))).toBe(true);
  });

  it('(c) proxy HTTP 500 -> red text contains the proxied error', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'ffmpeg 转码失败' }),
    });
    await startThenStop(fetchSpy);
    expect(asrErrors.some((m) => m.includes('ffmpeg 转码失败'))).toBe(true);
  });

  it('(d) no audio captured (empty Blob) -> red text "没听到声音"', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'should not reach' }),
    });
    // deliver:false => MediaRecorder.start() emits nothing => audioChunks stays empty
    await startThenStop(fetchSpy, { deliver: false });
    expect(asrErrors.some((m) => m.includes('没听到声音'))).toBe(true);
  });

  it('(a) mic permission denied -> red text "麦克风不可用"', async () => {
    installGlobals({});
    setGetUserMedia(vi.fn().mockRejectedValue(new Error('Permission denied')));
    const res = await startRecording('en-US', null);
    expect(res).toEqual({ transcript: '', audioBlob: null });
    expect(asrErrors.some((m) => m.includes('麦克风不可用'))).toBe(true);
  });

  it('(a) MediaRecorder unsupported -> red text surfaces (no silent drop)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'x' }),
    });
    // throwCtor:true => every `new MediaRecorder(...)` throws => unsupported
    await startThenStop(fetchSpy, { throwCtor: true });
    expect(asrErrors.length).toBeGreaterThan(0);
    expect(asrErrors.some((m) => /不支持|没听到/.test(m))).toBe(true);
  });
});
