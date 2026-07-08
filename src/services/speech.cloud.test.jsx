/**
 * Tests for the Cloud TTS feature added to speech.js.
 *
 * Covers:
 *   1. getCloudTtsUrl()  — returns '' when unset, the stored URL otherwise.
 *   2. setCloudTtsUrl()  — writes / trims / clears the stored URL.
 *   3. cloudTtsSpeak()   — fetches `/tts?text=...&voice=...` and plays audio.
 *   4. speakText() priority — cloud URL routes through cloudTtsSpeak;
 *                             no cloud URL falls back to the default engine.
 *
 * jsdom notes:
 *   - `window.speechSynthesis` / `SpeechSynthesisUtterance` are stubbed so the
 *     browser fallback can run.
 *   - `Audio` and `URL.createObjectURL/revokeObjectURL` are stubbed so the mp3
 *     playback Promise settles (Audio.onended is fired after play()).
 *   - `global.fetch` is mocked with vi.fn() (the "spy") to observe calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCloudTtsUrl,
  setCloudTtsUrl,
  cloudTtsSpeak,
  speakText,
} from './speech.js';

// jsdom / older Node may lack AbortSignal.timeout — polyfill defensively.
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = (ms) => new AbortController().signal;
}

// --- helpers ---------------------------------------------------------------

const ORIGINAL_HOSTNAME = window.location.hostname;

function setHostname(name) {
  try {
    Object.defineProperty(window.location, 'hostname', {
      value: name,
      configurable: true,
      writable: true,
    });
  } catch {
    vi.stubGlobal('location', { hostname: name, href: `https://${name}/` });
  }
}

function restoreHostname() {
  try {
    Object.defineProperty(window.location, 'hostname', {
      value: ORIGINAL_HOSTNAME,
      configurable: true,
      writable: true,
    });
  } catch {
    vi.stubGlobal('location', {
      hostname: ORIGINAL_HOSTNAME,
      href: `https://${ORIGINAL_HOSTNAME}/`,
    });
  }
}

// Stub <audio> so playback resolves via onended after play().
function installAudioStub() {
  class MockAudio {
    constructor(src) {
      this.src = src;
      this.onended = null;
      this.onerror = null;
    }
    pause() {}
    play() {
      return Promise.resolve().then(() => {
        if (typeof this.onended === 'function') this.onended();
      });
    }
  }
  vi.stubGlobal('Audio', MockAudio);
}

// Stub object URLs.
function installUrlStub() {
  const create = vi.fn(() => 'blob:mock');
  const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
  return { create, revoke };
}

// Stub speechSynthesis so the browser fallback can run; speak() fires onend.
function installSpeechSynthesisStub() {
  const stub = {
    cancel: vi.fn(),
    speak: vi.fn((utterance) => {
      if (utterance && typeof utterance.onend === 'function') utterance.onend();
    }),
    getVoices: vi.fn().mockReturnValue([]),
  };
  vi.stubGlobal('speechSynthesis', stub);
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      constructor(text) {
        this.text = text;
        this.lang = '';
        this.rate = 1.0;
        this.pitch = 1.0;
        this.voice = null;
      }
    },
  );
  return stub;
}

// A mock fetch that returns an mp3 blob.
function mp3FetchStub() {
  return vi.fn().mockResolvedValue({
    ok: true,
    blob: () => Promise.resolve(new Blob(['mp3'], { type: 'audio/mpeg' })),
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  restoreHostname();
  vi.unstubAllGlobals();
});

// --- 1. getCloudTtsUrl ------------------------------------------------------

describe('getCloudTtsUrl', () => {
  it('returns empty string when not configured', () => {
    expect(getCloudTtsUrl()).toBe('');
  });

  it('returns the configured URL after setCloudTtsUrl', () => {
    setCloudTtsUrl('https://xiaoliao-tts.abc.workers.dev');
    expect(getCloudTtsUrl()).toBe('https://xiaoliao-tts.abc.workers.dev');
  });
});

// --- 2. setCloudTtsUrl ------------------------------------------------------

describe('setCloudTtsUrl', () => {
  it('writes the URL to localStorage', () => {
    setCloudTtsUrl('https://xiaoliao-tts.abc.workers.dev');
    expect(localStorage.getItem('speakup_cloud_tts_url')).toBe(
      'https://xiaoliao-tts.abc.workers.dev',
    );
  });

  it('trims surrounding whitespace before storing', () => {
    setCloudTtsUrl('  https://xiaoliao-tts.abc.workers.dev  ');
    expect(getCloudTtsUrl()).toBe('https://xiaoliao-tts.abc.workers.dev');
  });

  it('clears storage when given an empty string', () => {
    setCloudTtsUrl('https://xiaoliao-tts.abc.workers.dev');
    setCloudTtsUrl('');
    expect(getCloudTtsUrl()).toBe('');
    expect(localStorage.getItem('speakup_cloud_tts_url')).toBeNull();
  });

  it('clears storage when given undefined / falsy', () => {
    setCloudTtsUrl('https://xiaoliao-tts.abc.workers.dev');
    setCloudTtsUrl(undefined);
    expect(getCloudTtsUrl()).toBe('');
  });
});

// --- 3. cloudTtsSpeak -------------------------------------------------------

describe('cloudTtsSpeak', () => {
  it('fetches the /tts endpoint with text & voice and plays the returned audio', async () => {
    installAudioStub();
    installUrlStub();
    const fetchSpy = mp3FetchStub();
    vi.stubGlobal('fetch', fetchSpy);
    setCloudTtsUrl('https://tts.example.dev');

    await cloudTtsSpeak('hello', 'en-US-JennyNeural', 0.75);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0][0];
    expect(calledUrl).toContain('https://tts.example.dev/tts?');
    expect(calledUrl).toContain('text=hello');
    expect(calledUrl).toContain('voice=en-US-JennyNeural');
    // speed 0.75 -> -25%
    expect(calledUrl).toContain('rate=-25%');
  });

  it('throws when the worker response is not ok', async () => {
    installAudioStub();
    installUrlStub();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    setCloudTtsUrl('https://tts.example.dev');

    await expect(cloudTtsSpeak('hi', 'en-US-JennyNeural', 1)).rejects.toThrow(/Cloud TTS error/);
  });

  it('omits the voice param when no voice name is supplied', async () => {
    installAudioStub();
    installUrlStub();
    const fetchSpy = mp3FetchStub();
    vi.stubGlobal('fetch', fetchSpy);
    setCloudTtsUrl('https://tts.example.dev');

    await cloudTtsSpeak('hello world', '', 1);

    const calledUrl = fetchSpy.mock.calls[0][0];
    expect(calledUrl).toContain('text=hello');
    expect(calledUrl).not.toContain('voice=');
  });
});

// --- 4. speakText priority --------------------------------------------------

describe('speakText priority (cloud TTS first)', () => {
  it('with a cloud URL set, routes through cloudTtsSpeak (fetch /tts)', async () => {
    installAudioStub();
    installUrlStub();
    const fetchSpy = mp3FetchStub();
    vi.stubGlobal('fetch', fetchSpy);
    setCloudTtsUrl('https://tts.example.dev');

    await speakText('hello');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0][0];
    expect(calledUrl).toContain('/tts?text=hello');
    expect(calledUrl).toContain('voice=en-US-JennyNeural');
  });

  it('without a cloud URL, falls back to browser speechSynthesis (no /tts fetch)', async () => {
    // Public host => even an edgetts mode would be downgraded to browser.
    setHostname('github.io');
    const speakStub = installSpeechSynthesisStub();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    localStorage.removeItem('speakup_cloud_tts_url');

    await speakText('hello');

    // Cloud path skipped => cloudTtsSpeak never issued a /tts request.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Browser fallback was used instead.
    expect(speakStub.speak).toHaveBeenCalledTimes(1);
    expect(speakStub.speak.mock.calls[0][0].text).toBe('hello');
  });
});
