/**
 * QA regression tests — ASR branch judgment (root cause) + all-failure red-text.
 *
 * The original Huawei "zero text / zero red text" bug was caused by:
 *   old:  useCloud = !recognition && !!getCloudTtsUrl()
 *         -> Android browsers LIE that window.SpeechRecognition exists, so
 *            useCloud became false and the code went down the native branch,
 *            which failed silently. The timeout guard `if (useCloud && !resolved)`
 *            also skipped red text when it DID time out.
 *
 * The fix under test:
 *   - useCloud (both in startRecording's capture setup AND in stopRecording) is
 *     now `!!getCloudTtsUrl()` — pure source-of-truth, never gated by native.
 *   - native SpeechRecognition creation/start is guarded by `!cloudUrlPresent`,
 *     so with a cloud URL it is NEVER created/started (no restart loop, no silent drop).
 *   - every failure path forces a red text via reportAsrError, with the exact
 *     copy promised by the fix; the timeout guard is now `if (!resolved)`.
 *
 * These tests drive the REAL startRecording()/stopRecording()/cloudAsr() with
 * mocked MediaRecorder / getUserMedia / fetch / window.SpeechRecognition.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startRecording,
  stopRecording,
  setCloudTtsUrl,
  setAsrErrorHandler,
  supportsVoiceInput,
  getAsrModeLabel,
} from './speech.js';

if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = (ms) => new AbortController().signal;
}

// --- error collector --------------------------------------------------------
let asrErrors = [];
function installAsrHandler() {
  asrErrors = [];
  setAsrErrorHandler((m) => asrErrors.push(m));
}

// --- native SpeechRecognition mock (to DETECT whether the native branch runs) -
let nativeStarted = 0;
let nativeConstructed = 0;
class MockNativeSpeechRecognition {
  constructor() {
    nativeConstructed++;
    this.continuous = false;
    this.interimResults = false;
    this.lang = '';
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
  }
  start() {
    nativeStarted++;
  }
  stop() {
    // intentionally does NOT fire onend, so the 3s native safety timeout triggers
  }
}

// --- MediaRecorder mock ------------------------------------------------------
let deliverData = true;
let constructorThrows = false;
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

function installGlobals({ deliver = true, throwCtor = false, fetchImpl, nativeStub = false } = {}) {
  deliverData = deliver;
  constructorThrows = throwCtor;
  vi.stubGlobal('MediaRecorder', MockMediaRecorder);
  const fakeStream = { getTracks: () => [{ stop: vi.fn() }] };
  setGetUserMedia(vi.fn().mockResolvedValue(fakeStream));
  if (nativeStub) {
    window.SpeechRecognition = MockNativeSpeechRecognition;
    window.webkitSpeechRecognition = undefined;
  } else {
    window.SpeechRecognition = undefined;
    window.webkitSpeechRecognition = undefined;
  }
  if (fetchImpl) vi.stubGlobal('fetch', fetchImpl);
  installAsrHandler();
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  asrErrors = [];
  nativeStarted = 0;
  nativeConstructed = 0;
  setCloudTtsUrl('https://asr.example.dev'); // enable the cloud ASR branch
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setAsrErrorHandler(null);
});

async function startThenStopCloud(fetchImpl, { deliver = true, throwCtor = false } = {}) {
  installGlobals({ fetchImpl, deliver, throwCtor });
  const p = startRecording('en-US', null);
  await flush();
  const result = await stopRecording();
  return result;
}

// ============================================================================
// A. BRANCH JUDGMENT — the root cause of the original "zero red text" bug
// ============================================================================
describe('A. branch judgment (root cause of "zero red text")', () => {
  it('A1: cloud URL set + native SpeechRecognition stubbed => cloud branch, native NEVER started', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'hello world' }),
    });
    installGlobals({ fetchImpl: fetchSpy, nativeStub: true });
    const p = startRecording('en-US', null);
    await flush();
    // KEY ASSERTION: native recognition must NOT be constructed or started,
    // because the cloud URL must make us bypass the native stub entirely.
    expect(nativeConstructed).toBe(0);
    expect(nativeStarted).toBe(0);
    const result = await stopRecording();
    expect(result.transcript).toBe('hello world');
    // And we must have gone through the cloud branch (raw Blob POST to ?action=asr).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain('action=asr');
  });

  it('A2: no cloud URL + no native support => supportsVoiceInput() is false (mic disabled)', () => {
    localStorage.clear();
    window.SpeechRecognition = undefined;
    window.webkitSpeechRecognition = undefined;
    expect(supportsVoiceInput()).toBe(false);
  });

  it('A3: no cloud URL + native stub present => native branch taken (desktop Chrome compatibility)', async () => {
    localStorage.clear(); // explicitly NO cloud URL
    installGlobals({ nativeStub: true });
    const p = startRecording('en-US', null);
    await flush();
    // Native recognition SHOULD be used when there is no cloud URL but the
    // browser exposes SpeechRecognition (desktop Chrome).
    expect(nativeConstructed).toBe(1);
    expect(nativeStarted).toBeGreaterThan(0);
    const result = await stopRecording();
    // The mock produces no text, so transcript is empty — that's fine, we only
    // verify the branch was taken.
    expect(result.transcript).toBe('');
  });

  it('A4: consistency — start (recordingUseCloud) and stop (useCloud) agree on the same source', async () => {
    // CLOUD mode: stopRecording must reach the cloud branch (action=asr) and
    // must NOT have started the native recognition.
    const cloudFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'hi' }),
    });
    installGlobals({ fetchImpl: cloudFetch, nativeStub: true });
    let p = startRecording('en-US', null);
    await flush();
    expect(nativeStarted).toBe(0);
    await stopRecording();
    expect(cloudFetch.mock.calls[0][0]).toContain('action=asr');

    // NATIVE mode: stopRecording must NOT reach the cloud branch (no fetch at all).
    localStorage.clear();
    nativeStarted = 0;
    const nativeFetch = vi.fn();
    installGlobals({ fetchImpl: nativeFetch, nativeStub: true });
    p = startRecording('en-US', null);
    await flush();
    expect(nativeStarted).toBeGreaterThan(0);
    await stopRecording();
    expect(nativeFetch).not.toHaveBeenCalled();
  });
});

// ============================================================================
// B. ALL FAILURE PATHS FORCE RED TEXT — the user's most painful symptom
// ============================================================================
describe('B. every failure path forces a red-text error (never silent)', () => {
  it('(a) mic permission denied => 麦克风不可用：请允许麦克风权限后重试', async () => {
    installGlobals({});
    setGetUserMedia(vi.fn().mockRejectedValue(new Error('Permission denied')));
    const res = await startRecording('en-US', null);
    expect(res).toEqual({ transcript: '', audioBlob: null });
    expect(asrErrors.some((m) => m === '麦克风不可用：请允许麦克风权限后重试')).toBe(true);
  });

  it('(b) MediaRecorder unsupported => 当前浏览器不支持录音（MediaRecorder 不可用）', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'x' }),
    });
    // throwCtor:true => every `new MediaRecorder(...)` throws => unsupported.
    await startThenStopCloud(fetchSpy, { throwCtor: true });
    expect(
      asrErrors.some((m) => m === '当前浏览器不支持录音（MediaRecorder 不可用）'),
    ).toBe(true);
  });

  it('(c) proxy connection failed (fetch network error) => 云端语音识别连接失败...', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await startThenStopCloud(fetchSpy);
    expect(asrErrors.some((m) => m.includes('云端语音识别连接失败'))).toBe(true);
    expect(
      asrErrors.some((m) => m.includes('请检查「云端TTS/ASR地址」设置')),
    ).toBe(true);
  });

  it('(d1) proxy HTTP 500 with backend error => 云端语音识别失败（<backend info>）', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'NLS gateway timeout' }),
    });
    await startThenStopCloud(fetchSpy);
    expect(
      asrErrors.some(
        (m) => m.includes('云端语音识别失败（') && m.includes('NLS gateway timeout'),
      ),
    ).toBe(true);
  });

  it('(d2) proxy HTTP 500 with no backend error => 云端语音识别失败（HTTP 500）', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('empty body');
      },
    });
    await startThenStopCloud(fetchSpy);
    expect(
      asrErrors.some((m) => m.includes('云端语音识别失败（HTTP 500）')),
    ).toBe(true);
  });

  it('(e) proxy returns empty result => 没听清，请再说一次（没识别到文字）', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: '' }),
    });
    await startThenStopCloud(fetchSpy);
    expect(
      asrErrors.some((m) => m === '没听清，请再说一次（没识别到文字）'),
    ).toBe(true);
  });

  it('(f) cloud 15s timeout (resolved still false) => 语音识别超时，请重试', async () => {
    vi.useFakeTimers();
    // Neutralize AbortSignal.timeout so our hanging fetch does not abort at 12s;
    // we want to prove the 15s SAFETY timeout (if (!resolved)) is what fires.
    vi.stubGlobal(
      'AbortSignal',
      Object.assign(Object.create(AbortSignal), {
        timeout: () => new AbortController().signal,
      }),
    );
    // fetch never settles -> the cloud branch hangs until the safety timeout.
    const fetchSpy = vi.fn(() => new Promise(() => {}));
    installGlobals({ fetchImpl: fetchSpy });
    const p = startRecording('en-US', null);
    await vi.advanceTimersByTimeAsync(0);
    stopRecording();
    await vi.advanceTimersByTimeAsync(16000); // fire the 15000ms safety timeout
    expect(asrErrors.some((m) => m === '语音识别超时，请重试')).toBe(true);
    vi.useRealTimers();
  });

  it('(g) native branch timeout (no cloud URL) => 原生语音识别失败... [if (!resolved) defense]', async () => {
    localStorage.clear(); // NO cloud URL => native branch
    vi.useFakeTimers();
    installGlobals({ nativeStub: true });
    const p = startRecording('en-US', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeStarted).toBeGreaterThan(0); // confirms we are in the native branch
    stopRecording();
    await vi.advanceTimersByTimeAsync(3500); // fire the 3000ms native safety timeout
    expect(
      asrErrors.some((m) => m === '原生语音识别失败，请改用云端识别或检查网络'),
    ).toBe(true);
    vi.useRealTimers();
  });
});

// ----------------------------------------------------------------------------
// Sanity: getAsrModeLabel reflects the configured mode (used by the diagnostic bar)
// ----------------------------------------------------------------------------
describe('getAsrModeLabel', () => {
  it('returns 云端识别模式 when a cloud URL is configured', () => {
    setCloudTtsUrl('https://asr.example.dev');
    expect(getAsrModeLabel()).toBe('云端识别模式');
  });
  it('returns 原生识别模式 when only native SpeechRecognition exists', () => {
    localStorage.clear();
    window.SpeechRecognition = MockNativeSpeechRecognition;
    expect(getAsrModeLabel()).toBe('原生识别模式');
  });
  it('returns 语音不可用 when neither is available', () => {
    localStorage.clear();
    window.SpeechRecognition = undefined;
    window.webkitSpeechRecognition = undefined;
    expect(getAsrModeLabel()).toBe('语音不可用');
  });
});
