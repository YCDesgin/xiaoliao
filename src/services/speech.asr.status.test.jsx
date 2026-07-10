/**
 * QA regression tests — always-on ASR diagnostic status bar (reportAsrStatus).
 *
 * The fix added a persistent diagnostic bar so the user can SEE which mode/phase
 * ASR is in even when no text ever comes back. This is driven by:
 *   - setAsrStatusHandler(fn)  — registers the app-layer status sink (mirrors
 *                                setAsrErrorHandler).
 *   - reportAsrStatus({ mode, phase, detail }) — pushed at key nodes:
 *       待命 (mode) -> 录音中 -> 上传中 -> 识别中 -> 成功/失败
 *   - getAsrModeLabel() — the human-readable mode string.
 *
 * NOTE on `mode`: only the "待命" event (startRecording) and the stopRecording
 * mode-event carry an explicit `mode`; the subsequent 录音中/上传中/识别中/成功
 * events rely on the app merging them into the previous state (prev spread).
 * So this test asserts `mode` is present on the events that actually send it,
 * and asserts phase ordering + field shape for all events.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startRecording,
  stopRecording,
  setCloudTtsUrl,
  setAsrErrorHandler,
  setAsrStatusHandler,
  getAsrModeLabel,
} from './speech.js';

if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = (ms) => new AbortController().signal;
}

const collected = { errors: [], statuses: [] };

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

function installGlobals({ fetchImpl } = {}) {
  vi.stubGlobal('MediaRecorder', MockMediaRecorder);
  const fakeStream = { getTracks: () => [{ stop: vi.fn() }] };
  setGetUserMedia(vi.fn().mockResolvedValue(fakeStream));
  window.SpeechRecognition = undefined;
  window.webkitSpeechRecognition = undefined;
  if (fetchImpl) vi.stubGlobal('fetch', fetchImpl);
  collected.errors = [];
  collected.statuses = [];
  setAsrErrorHandler((m) => collected.errors.push(m));
  setAsrStatusHandler((s) => collected.statuses.push(s));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  setCloudTtsUrl('https://asr.example.dev');
  collected.errors = [];
  collected.statuses = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  setAsrErrorHandler(null);
  setAsrStatusHandler(null);
});

describe('C. diagnostic status bar (setAsrStatusHandler / reportAsrStatus)', () => {
  it('setAsrStatusHandler is exported as a function', () => {
    expect(typeof setAsrStatusHandler).toBe('function');
  });

  it('getAsrModeLabel returns 云端识别模式 when a cloud URL is set', () => {
    expect(getAsrModeLabel()).toBe('云端识别模式');
  });

  it('the initial 待命 status carries the cloud mode label', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'hi' }),
    });
    installGlobals({ fetchImpl: fetchSpy });
    const p = startRecording('en-US', null);
    await flush();
    const standby = collected.statuses.find((s) => s.phase === '待命');
    expect(standby).toBeTruthy();
    expect(standby.mode).toBe('云端识别模式');
    await stopRecording();
  });

  it('cloud happy path pushes 待命 -> 录音中 -> 上传中 -> 识别中 -> 成功 in order', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'hello world' }),
    });
    installGlobals({ fetchImpl: fetchSpy });
    const p = startRecording('en-US', null);
    await flush();
    await stopRecording();

    const phases = collected.statuses.map((s) => s.phase);
    expect(phases).toContain('待命');
    expect(phases).toContain('录音中');
    expect(phases).toContain('上传中');
    expect(phases).toContain('识别中');
    expect(phases).toContain('成功');

    const order = ['待命', '录音中', '上传中', '识别中', '成功'];
    const idx = order.map((o) => phases.indexOf(o));
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    }

    // Every pushed status carries at least a mode or a phase. Some events
    // (e.g. the 待命 event, the stop-time mode heartbeat) omit `detail`, and
    // some omit `mode` (the app merges them into previous state) — so we only
    // require that each event is a non-empty {mode?,phase?,detail?} object.
    for (const s of collected.statuses) {
      expect(s.mode !== undefined || s.phase !== undefined).toBe(true);
    }
    // no red text on the happy path
    expect(collected.errors).toEqual([]);
  });

  it('the 上传中 / 识别中 / 成功 events carry descriptive detail', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'hello' }),
    });
    installGlobals({ fetchImpl: fetchSpy });
    const p = startRecording('en-US', null);
    await flush();
    await stopRecording();

    const uploading = collected.statuses.find((s) => s.phase === '上传中');
    expect(uploading.detail).toContain('上传');

    const recognizing = collected.statuses.find((s) => s.phase === '识别中');
    expect(recognizing.detail).toContain('识别');

    const success = collected.statuses.find((s) => s.phase === '成功');
    expect(success.detail).toContain('识别到');
  });

  it('failure path pushes a 失败 status with the failure detail', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: '' }), // empty => 没听清
    });
    installGlobals({ fetchImpl: fetchSpy });
    const p = startRecording('en-US', null);
    await flush();
    await stopRecording();

    const fail = collected.statuses.find((s) => (s.phase || '').startsWith('失败'));
    expect(fail).toBeTruthy();
    expect(fail.detail).toContain('没识别到文字');
  });

  it('mic permission denied pushes a 失败 status with mode + detail', async () => {
    installGlobals({});
    setGetUserMedia(vi.fn().mockRejectedValue(new Error('Permission denied')));
    await startRecording('en-US', null);
    const fail = collected.statuses.find((s) => (s.phase || '').startsWith('失败'));
    expect(fail).toBeTruthy();
    expect(fail.mode).toBe('云端识别模式');
    expect(fail.detail).toContain('麦克风');
  });
});
