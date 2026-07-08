/**
 * Targeted tests for the TTS browser-fallback enhancement in speech.js.
 *
 * Covers the 4 changes:
 *   1. isLocalEnv()                                  — env detection
 *   2. getTtsMode() env default                      — localhost=>edgetts, public=>browser
 *   3. speakText effectiveMode fallback              — public deploy never hits localhost:5100
 *   4. fetch AbortSignal.timeout + no global pollution on Edge-TTS failure
 *
 * NOTE on jsdom: jsdom does not implement the Web Speech API, so
 * `window.speechSynthesis` and `SpeechSynthesisUtterance` are stubbed globally.
 * `browserSpeak` only resolves its returned Promise when the utterance's
 * `onend`/`onerror` fires, so the `speechSynthesis.speak` stub invokes
 * `utterance.onend()` to let the async flow settle (an entirely empty `speak`
 * would hang the `await`). This still proves `speak` was called exactly once
 * and the localhost `fetch` was never issued.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getTtsMode, speakText } from './speech.js';

// jsdom / older Node may lack AbortSignal.timeout — polyfill defensively.
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = (ms) => new AbortController().signal;
}

const ORIGINAL_HOSTNAME = window.location.hostname;

function setHostname(name) {
  try {
    Object.defineProperty(window.location, 'hostname', {
      value: name,
      configurable: true,
      writable: true,
    });
  } catch {
    // jsdom sometimes blocks redefining location.hostname — fall back to
    // stubbing the global `location` reference used by isLocalEnv().
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

// Returns a speechSynthesis stub and installs it (plus SpeechSynthesisUtterance)
// so browserSpeak can run under jsdom. `speak` fires onend so the Promise settles.
function installSpeechSynthesisStub() {
  const stub = {
    cancel: vi.fn(),
    speak: vi.fn((utterance) => {
      if (utterance && typeof utterance.onend === 'function') utterance.onend();
    }),
    getVoices: vi.fn().mockReturnValue([]),
  };
  vi.stubGlobal('speechSynthesis', stub);
  // jsdom has no SpeechSynthesisUtterance constructor; provide a minimal one.
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

beforeEach(() => {
  localStorage.clear();
  installSpeechSynthesisStub();
  // default no-op fetch; individual tests override as needed
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  restoreHostname();
  vi.unstubAllGlobals();
});

describe('Test A — getTtsMode environment default', () => {
  it('returns "browser" on a public (github.io) host', () => {
    setHostname('ycdesgin.github.io');
    localStorage.clear();
    expect(getTtsMode()).toBe('browser');
  });

  it('returns "edgetts" on a local (localhost) host', () => {
    setHostname('localhost');
    localStorage.clear();
    expect(getTtsMode()).toBe('edgetts');
  });

  it('returns "edgetts" on 127.0.0.1 as well', () => {
    setHostname('127.0.0.1');
    localStorage.clear();
    expect(getTtsMode()).toBe('edgetts');
  });

  it('explicit stored mode wins over the env default', () => {
    setHostname('ycdesgin.github.io');
    localStorage.setItem('speakup_tts_mode', 'edgetts');
    expect(getTtsMode()).toBe('edgetts');
  });
});

describe('Test B — public deploy never issues the localhost:5100 fetch', () => {
  it('mode "edgetts" is force-downgraded to browser; fetch not called, speak called once', async () => {
    setHostname('github.io');
    const speakStub = installSpeechSynthesisStub();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await speakText('hello', { mode: 'edgetts' });

    // Should go straight to browser TTS, never reach Edge-TTS server.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(speakStub.speak).toHaveBeenCalledTimes(1);
    // sanity: the utterance text is what we asked to speak
    expect(speakStub.speak.mock.calls[0][0].text).toBe('hello');
  });
});

describe('Test C — local Edge-TTS failure falls back gracefully', () => {
  it('fetch rejection is caught; no unhandled error; falls back to browser speak', async () => {
    setHostname('localhost');
    const speakStub = installSpeechSynthesisStub();
    const fetchSpy = vi.fn().mockRejectedValue(new Error('conn refused'));
    vi.stubGlobal('fetch', fetchSpy);

    // Edge-TTS fetch fails; speakText must catch and fall back to browser TTS
    // without throwing an unhandled exception.
    await expect(speakText('hello', { mode: 'edgetts' })).resolves.toBeUndefined();

    // The rejected fetch was attempted (local env uses Edge-TTS path first)...
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // ...but the failure was recovered and browser TTS was used as fallback.
    expect(speakStub.speak).toHaveBeenCalledTimes(1);
  });
});

describe('Robustness — no global mode pollution on fallback', () => {
  it('falling back does not persist "browser" into speakup_tts_mode', async () => {
    setHostname('localhost');
    installSpeechSynthesisStub();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('conn refused')));

    await speakText('hello', { mode: 'edgetts' });

    // The catch removed the old setTtsMode('browser') pollution: localStorage
    // must remain untouched by the fallback.
    expect(localStorage.getItem('speakup_tts_mode')).toBeNull();
  });
});
