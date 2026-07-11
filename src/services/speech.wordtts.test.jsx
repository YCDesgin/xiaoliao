/**
 * Tests for the per-word 🔊 provider routing in speech.js (架构 T7 / §3 / §7).
 *
 * Covers:
 *   - getWordTtsProvider 默认 'browser'，setWordTtsProvider 可切换并持久化；
 *   - browser 模式：speakWord 走浏览器 speechSynthesis；
 *   - cosyvoice 模式（已配置云端地址）：speakWord 经 cloudTtsSpeak 发请求，
 *     不下发浏览器 speechSynthesis（失败才回退，本测试走成功路径）。
 *
 * jsdom 无 Web Speech API / AudioContext，故全局 stub。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getWordTtsProvider,
  setWordTtsProvider,
  getCloudTtsUrl,
  setCloudTtsUrl,
  speakWord,
} from './speech.js';

if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = (ms) => new AbortController().signal;
}

const ORIGINAL_HOSTNAME = window.location.hostname;

function setHostname(name) {
  try {
    Object.defineProperty(window.location, 'hostname', { value: name, configurable: true, writable: true });
  } catch {
    vi.stubGlobal('location', { hostname: name, href: `https://${name}/` });
  }
}
function restoreHostname() {
  try {
    Object.defineProperty(window.location, 'hostname', { value: ORIGINAL_HOSTNAME, configurable: true, writable: true });
  } catch {
    vi.stubGlobal('location', { hostname: ORIGINAL_HOSTNAME, href: `https://${ORIGINAL_HOSTNAME}/` });
  }
}

function installSpeechSynthesisStub() {
  const stub = {
    cancel: vi.fn(),
    speak: vi.fn((u) => { if (u && typeof u.onend === 'function') u.onend(); }),
    getVoices: vi.fn().mockReturnValue([{ name: 'Google US English', lang: 'en-US', default: true }]),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('speechSynthesis', stub);
  vi.stubGlobal('SpeechSynthesisUtterance', class {
    constructor(t) { this.text = t; this.lang = ''; this.rate = 1; this.pitch = 1; this.voice = null; }
  });
  return stub;
}

function installAudioContextStub() {
  vi.stubGlobal('AudioContext', class {
    constructor() { this.state = 'running'; this.destination = {}; }
    resume() { return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({ duration: 0.1, length: 1000 }); }
    createBufferSource() { return { buffer: null, connect() {}, start() {}, onended: null }; }
  });
}

beforeEach(() => {
  localStorage.clear();
  setHostname('localhost');
  installSpeechSynthesisStub();
  installAudioContextStub();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  restoreHostname();
  vi.unstubAllGlobals();
  setWordTtsProvider('browser');
});

describe('Test A — getWordTtsProvider 默认与切换', () => {
  it('默认返回 browser', () => {
    expect(getWordTtsProvider()).toBe('browser');
  });

  it('setWordTtsProvider 切换并持久化；切回 browser 清除存储', () => {
    setWordTtsProvider('cosyvoice');
    expect(getWordTtsProvider()).toBe('cosyvoice');
    expect(localStorage.getItem('speakup_word_tts_provider')).toBe('cosyvoice');
    setWordTtsProvider('browser');
    expect(localStorage.getItem('speakup_word_tts_provider')).toBeNull();
  });
});

describe('Test B — browser 模式走 speechSynthesis', () => {
  it('speakWord 调 speechSynthesis.speak 一次，且不打 fetch', async () => {
    setWordTtsProvider('browser');
    const synth = window.speechSynthesis;
    await speakWord('hello');
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(synth.speak.mock.calls[0][0].text).toBe('hello');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Test C — cosyvoice 模式走云端 cloudTtsSpeak', () => {
  it('speakWord 经 cloudTtsSpeak 发请求，且不走浏览器 speechSynthesis', async () => {
    setCloudTtsUrl('https://fc.example.com/tts');
    setWordTtsProvider('cosyvoice');
    const synth = window.speechSynthesis;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve({ size: 8, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
    }));

    await speakWord('hello');
    // 等待 cloudTtsSpeak 的异步 fetch 触发（成功路径不下发浏览器 TTS）
    await new Promise((r) => setTimeout(r, 0));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain('https://fc.example.com/tts');
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it('未配置云端地址时，cosyvoice 模式自动回退 browser', async () => {
    setCloudTtsUrl(''); // 无云端地址
    setWordTtsProvider('cosyvoice');
    const synth = window.speechSynthesis;
    await speakWord('hello');
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
