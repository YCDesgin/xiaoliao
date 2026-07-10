/**
 * Problem 1 regression test — "回听自己语音听到的是 AI 变音，不是原声".
 *
 * Root cause: stopRecording()'s CLOUD branch never assigned `audioBlob`, so the
 * user's own message carried audioBlob=null and playback fell back to TTS
 * (the AI voice reading the text). The fix adds `audioBlob = wavBytes;` in the
 * cloud branch, so the recorded blob is returned and playback uses the original.
 *
 * This test drives the REAL startRecording()/stopRecording() with a mocked
 * MediaRecorder / getUserMedia / fetch (the same isolation strategy the repo's
 * existing speech.asr.branch.test.jsx uses) and asserts that the resolved
 * result — and the promise handed to the caller via recordingResolve — carries
 * a non-null audioBlob when the cloud ASR path returns audio.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startRecording,
  stopRecording,
  setCloudTtsUrl,
} from './speech.js';

if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = (ms) => new AbortController().signal;
}

// --- MediaRecorder mock: records one chunk on start, fires onstop on stop -----
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
      // a non-empty chunk so cloudStopAndEncode returns a real Blob
      this.ondataavailable({ data: new Blob(['recorded-audio-bytes'], { type: this.mimeType }) });
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

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('MediaRecorder', MockMediaRecorder);
  const fakeStream = { getTracks: () => [{ stop: vi.fn() }] };
  setGetUserMedia(vi.fn().mockResolvedValue(fakeStream));
  // enable the cloud ASR branch
  setCloudTtsUrl('https://asr.example.dev');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Problem 1 — cloud branch records a non-null audioBlob', () => {
  it('resolves with a non-null audioBlob (and correct transcript) on the cloud path', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'hello from cloud' }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const recordPromise = startRecording('en-US', null);
    await flush(); // let startRecording finish setting up mediaRecorder + audioChunks

    const stopPromise = stopRecording();
    const result = await recordPromise; // resolves via recordingResolve({ transcript, audioBlob })
    await stopPromise;

    // Problem 1 assertion: the user's own message must keep its original audio.
    expect(result).toBeDefined();
    expect(result.audioBlob).not.toBeNull();
    expect(result.audioBlob).toBeInstanceOf(Blob);
    expect(result.audioBlob.size).toBeGreaterThan(0);
    // sanity: cloud ASR still produced the transcript
    expect(result.transcript).toBe('hello from cloud');
    // and the cloud branch was actually exercised (raw Blob POST to ?action=asr)
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain('action=asr');
  });
});
