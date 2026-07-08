// Speech service: Web Speech API (free) + optional Edge-TTS (natural voices)
// Edge-TTS provides much more natural English voices via a local Python server

let recognition = null;
let speaking = false;
let currentAudio = null;  // Track currently playing HTML <audio> element so we can cancel it
let currentSource = null; // Track currently playing Web Audio BufferSource so we can cancel it

// --- Centralized TTS error reporting ---
// Lets the app layer hook in a user-visible error reporter (e.g. a toast).
// Without a handler, errors are still logged to the console via reportTtsError.
let ttsErrorHandler = null;
export function setTtsErrorHandler(fn) {
  if (typeof fn === 'function') ttsErrorHandler = fn;
}
function reportTtsError(msg) {
  console.error('[XiaLiao TTS] ' + msg);
  if (ttsErrorHandler) { try { ttsErrorHandler(msg); } catch {} }
}

let ttsMode = 'browser'; // 'browser' | 'edgetts'

// --- Web Audio API playback (mobile-safe) ---
// Mobile browsers enforce a stricter autoplay policy than desktop: audio.play()
// must run inside the user-gesture call stack, or the page must have unlocked an
// AudioContext via a prior gesture. Because our TTS flow awaits a fetch before
// playback, play() lands outside the gesture and is silently blocked on phones
// (desktop Chrome's "sticky activation" is more lenient, so desktop still works).
// Web Audio playback via decodeAudioData + AudioBufferSourceNode does NOT require
// play() to be inside the gesture, so we unlock the AudioContext on first gesture
// and use it for all synthesized audio.

let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      try { audioCtx = new Ctx(); } catch (e) { audioCtx = null; }
    }
  }
  return audioCtx;
}

// Mobile autoplay policy: unlock (resume) the AudioContext on the first user gesture.
(function setupAudioUnlock() {
  if (typeof document === 'undefined') return;
  const unlock = () => {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  };
  ['touchend', 'click', 'keydown'].forEach((ev) =>
    document.addEventListener(ev, unlock, { passive: true })
  );
})();

// Play raw audio bytes through the Web Audio API. Does not require play() to be
// inside the user-gesture call stack, making it reliable on mobile browsers.
// IMPORTANT: the AudioContext MUST be resumed (and actually 'running') before
// source.start(), otherwise the buffer is scheduled on a suspended context and
// produces NO sound and NO error — silently breaking all playback.
async function playArrayBuffer(arrayBuffer) {
  const ctx = getAudioContext();
  if (!ctx) throw new Error('Web Audio API unavailable');
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch (e) { /* fall through to the check below */ }
    // If still suspended after resume (autoplay policy blocked it), let the
    // caller fall back to the HTML <audio> element instead of going silent.
    if (ctx.state === 'suspended') throw new Error('AudioContext still suspended after resume');
  }
  // Decode with callback form for max compatibility (Safari/older browsers
  // do NOT return a Promise from decodeAudioData — they only support callbacks).
  const audioBuffer = await new Promise((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    } catch (e) { reject(e); }
  });
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(ctx.destination);
  currentSource = source;
  // Safety net: resolve even if onended never fires (avoids a forever-pending
  // Promise that would leave the app stuck in the "speaking" state).
  const safetyMs = Math.max(500, Math.ceil(audioBuffer.duration * 1000) + 800);
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        if (currentSource === source) currentSource = null;
        resolve();
      }
    };
    source.onended = finish;
    setTimeout(finish, safetyMs);
    try { source.start(0); } catch (e) { finish(); }
  });
}

// HTML <audio> fallback for the rare environment without Web Audio support.
function playViaHtmlAudio(audioUrl) {
  return new Promise((resolve) => {
    const audio = new Audio(audioUrl);
    audio.style.cssText = 'position:absolute;left:-9999px;opacity:0;pointer-events:none;width:1px;height:1px;';
    if (typeof document !== 'undefined' && document.body) document.body.appendChild(audio);
    currentAudio = audio;
    const cleanup = () => {
      if (currentAudio === audio) currentAudio = null;
      if (audio.parentNode) audio.parentNode.removeChild(audio);
      URL.revokeObjectURL(audioUrl);
    };
    audio.onended = () => { cleanup(); resolve(); };
    audio.onerror = (e) => { console.error('HTMLAudio fallback error:', e); cleanup(); resolve(); };
    audio.play().catch((e) => { console.error('HTMLAudio fallback play blocked:', e); cleanup(); resolve(); });
  });
}

// Stop any in-progress playback (both Web Audio and HTML <audio> fallback).
function stopCurrentPlayback() {
  if (currentSource) {
    try { currentSource.stop(); } catch {}
    currentSource = null;
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio.load();
    currentAudio = null;
  }
}

// Returns true when running on a local dev machine (where the Edge-TTS
// Python server at http://localhost:5100 is expected to be reachable).
function isLocalEnv() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

// --- TTS Mode ---

export function setTtsMode(mode) {
  ttsMode = mode;
  localStorage.setItem('speakup_tts_mode', mode);
}

export function getTtsMode() {
  return localStorage.getItem('speakup_tts_mode') || (isLocalEnv() ? 'edgetts' : 'browser');
}

// --- Cloud TTS (Cloudflare Worker proxying Edge-TTS) ---
// When a cloud TTS Worker URL is configured, AI voices are fetched from it as
// an mp3 stream. This is what makes the app audible on public (GitHub Pages)
// deployments and on Chinese Android phones without Google Mobile Services.

export function getCloudTtsUrl() {
  return localStorage.getItem('speakup_cloud_tts_url') || '';
}

export function setCloudTtsUrl(url) {
  if (url && url.trim()) {
    localStorage.setItem('speakup_cloud_tts_url', url.trim());
  } else {
    localStorage.removeItem('speakup_cloud_tts_url');
  }
}

// --- Edge-TTS ---

const EDGETTS_URL = 'http://localhost:5100';

export async function testEdgeTtsConnection() {
  try {
    const res = await fetch(`${EDGETTS_URL}/voices`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function edgeTtsSpeak(text, voiceName, rate) {
  // Cancel any currently playing audio immediately
  stopCurrentPlayback();
  speaking = false;

  const url = new URL(`${EDGETTS_URL}/speak`);
  url.searchParams.set('text', text);
  if (voiceName) url.searchParams.set('voice', voiceName);
  if (rate) url.searchParams.set('rate', rate);

  let res;
  try {
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(3000) });
  } catch (e) {
    reportTtsError('Edge-TTS 请求失败（本地服务不可达）: ' + (e?.message || e));
    throw e;
  }
  if (!res.ok) throw new Error('Edge-TTS server error');

  const blob = await res.blob();
  const arrayBuffer = await blob.arrayBuffer();
  speaking = true;
  try {
    await playArrayBuffer(arrayBuffer); // Web Audio main path (mobile-safe)
  } catch (e) {
    console.warn('Web Audio playback failed, falling back to HTMLAudio:', e);
    await playViaHtmlAudio(URL.createObjectURL(blob)); // fallback
  } finally {
    speaking = false;
  }
}

/**
 * Cloud TTS playback. Fetches a synthesized mp3 from the configured Cloudflare
 * Worker and plays it through an <audio> element (same cancel/play lifecycle
 * as edgeTtsSpeak). The Worker URL is read from localStorage via getCloudTtsUrl.
 *
 * @param {string} text - Text to speak
 * @param {string} voiceName - Edge-TTS voice name (e.g. en-US-JennyNeural)
 * @param {number} rate - Speed as a float multiplier (e.g. 0.75 → "-25%")
 */
export async function cloudTtsSpeak(text, voiceName, rate) {
  const cloudUrl = getCloudTtsUrl();
  if (!cloudUrl) { reportTtsError('未配置云端 TTS 地址'); return; }

  // Cancel any currently playing audio immediately.
  stopCurrentPlayback();
  speaking = false;

  const params = new URLSearchParams({ text });
  if (voiceName) params.set('voice', voiceName);
  if (rate !== undefined) {
    const pct = Math.round((rate - 1) * 100);
    params.set('rate', `${pct >= 0 ? '+' : ''}${pct}%`);
  }

  speaking = true;
  try {
    let res;
    try {
      res = await fetch(`${cloudUrl}/tts?${params}`, { signal: AbortSignal.timeout(15000) });
    } catch (e) {
      // Network error / Worker unreachable — report AND throw so speakText() can
      // fall back to the browser TTS engine instead of going silent.
      reportTtsError('请求云端 TTS 失败（网络/Worker 不可达）: ' + (e?.message || e));
      throw e;
    }
    if (!res.ok) {
      // Worker returned an error status (e.g. 500 / timeout) — report AND throw.
      reportTtsError(`云端 TTS 返回错误状态 ${res.status}`);
      throw new Error(`Cloud TTS error: ${res.status}`);
    }
    const blob = await res.blob();
    if (!blob || blob.size === 0) {
      // Worker returned an empty body — report AND throw.
      reportTtsError('云端 TTS 返回空音频');
      throw new Error('Cloud TTS returned empty audio');
    }
    const arrayBuffer = await blob.arrayBuffer();
    try {
      await playArrayBuffer(arrayBuffer); // Web Audio main path (mobile-safe)
    } catch (e) {
      // Web Audio decode/play failed — fall back to plain <audio> element.
      console.warn('Web Audio 播放失败，回退到 <audio>:', e);
      try {
        await playViaHtmlAudio(URL.createObjectURL(blob)); // fallback
      } catch (e2) {
        reportTtsError('回退播放也失败: ' + (e2?.message || e2));
      }
    }
  } catch (e) {
    // Network / status / empty-audio errors above were already reported via
    // reportTtsError before being thrown; only log the throw here so the stack
    // is visible in devtools. speakText()'s catch will fall back to browser TTS.
    console.error('Cloud TTS playback error:', e);
  } finally {
    speaking = false;
  }
}

// --- Speech Recognition + Audio Recording ---

let mediaRecorder = null;
let audioChunks = [];
let recordingResolve = null;   // Resolves the Promise returned by startRecording()
let recordingStream = null;    // Microphone stream for cleanup
let finalTranscript = '';      // Accumulated final transcript during continuous recording
let lastTranscript = '';       // Full current text (final + current interim), used as fallback on stop
let interimCallback = null;    // Callback for live interim text display

/**
 * Start a manual recording session (press to start, press again to stop).
 * Speech recognition runs continuously — pauses and hesitations won't end it.
 * Returns a Promise that only resolves when stopRecording() is called.
 *
 * @param {string} lang  - Recognition language
 * @param {function} onInterim - Callback for live interim text: (text) => void
 * @returns {Promise<{ transcript: string, audioBlob: Blob | null }>}
 */
export async function startRecording(lang = 'en-US', onInterim = null) {
  // --- Mic stream ---
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    console.log('Mic permission denied:', e);
    return { transcript: '', audioBlob: null };
  }

  interimCallback = onInterim || null;

  // --- MediaRecorder (records user's own voice for playback) ---
  audioChunks = [];
  mediaRecorder = new MediaRecorder(recordingStream, { mimeType: 'audio/webm' });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.start();

  // --- SpeechRecognition (continuous, won't auto-stop on pauses) ---
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (recognition) {
    try { recognition.stop(); } catch {}
    recognition = null;
  }
  finalTranscript = '';
  lastTranscript = '';

  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.lang = lang;
    recognition.continuous = true;   // DON'T stop on silence — user controls stop
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript + ' ';
        } else {
          interim += result[0].transcript;
        }
      }
      // Always keep the full current text (final + interim) as a fallback
      // in case the final result event arrives after onend (Chrome quirk).
      lastTranscript = (finalTranscript + interim).trim();
      // Fire live interim callback so the UI can show what's being heard
      if (interimCallback) {
        interimCallback(lastTranscript);
      }
    };

    recognition.onerror = (event) => {
      // no-speech / audio-capture / aborted are normal during continuous recording
      // — don't stop, just log and keep going
      console.log('SpeechRecognition event:', event.error);
    };

    recognition.onend = () => {
      // Auto-restart if we're still supposed to be recording.
      // This handles Chrome's internal timeout without stopping the session.
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        try { recognition.start(); } catch {
          // If restart fails (e.g. tab losing focus), just wait for user to stop manually
        }
      }
    };

    recognition.start();
  }

  // Return a Promise that only resolves when the user calls stopRecording()
  return new Promise((resolve) => {
    recordingResolve = resolve;
  });
}

/**
 * Manually stop the recording session.
 * Waits for speech recognition to finish finalizing the transcript before resolving,
 * so the last few words aren't lost when the user clicks stop.
 *
 * @returns {{ transcript: string, audioBlob: Blob | null }}
 */
export function stopRecording() {
  return new Promise((resolve) => {
    let audioBlob = null;
    let recorderStopped = false;
    let recognitionStopped = !recognition;
    let resolved = false;

    const tryResolve = () => {
      if (resolved || !recorderStopped || !recognitionStopped) return;
      resolved = true;

      // Detach handlers and clean up recognition
      if (recognition) {
        recognition.onresult = null;
        recognition.onend = null;
        recognition.onerror = null;
        recognition = null;
      }

      // Release mic
      if (recordingStream) {
        recordingStream.getTracks().forEach(t => t.stop());
        recordingStream = null;
      }

      // Use final results; fall back to the last known (final + interim) text
      // so a message is never dropped even if the final event is late/missing.
      const transcript = finalTranscript.trim() || lastTranscript.trim();
      if (recordingResolve) {
        recordingResolve({ transcript, audioBlob });
        recordingResolve = null;
      }
      resolve({ transcript, audioBlob });
    };

    // Safety net: don't wait more than 3 seconds for recognition to finalize
    const safetyTimeout = setTimeout(() => {
      recorderStopped = true;
      recognitionStopped = true;
      tryResolve();
    }, 3000);

    // --- Stop speech recognition and capture its final result ---
    if (recognition) {
      const finish = () => {
        recognitionStopped = true;
        tryResolve();
      };
      recognition.onend = () => {
        // Give the last sentence's final result a buffer window — Chrome's
        // isFinal event often arrives tens to hundreds of ms AFTER onend.
        setTimeout(finish, 400);
      };
      recognition.onerror = () => {
        setTimeout(finish, 400);
      };
      // onresult stays the same as in startRecording, so it keeps
      // accumulating into finalTranscript / lastTranscript.
      try { recognition.stop(); } catch {}
    } else {
      recognitionStopped = true;
    }

    // --- Stop MediaRecorder and collect audio ---
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.onstop = () => {
        clearTimeout(safetyTimeout);
        audioBlob = audioChunks.length > 0
          ? new Blob(audioChunks, { type: 'audio/webm' })
          : null;
        recorderStopped = true;
        tryResolve();
      };
      mediaRecorder.stop();
    } else {
      clearTimeout(safetyTimeout);
      audioBlob = null;
      recorderStopped = true;
      tryResolve();
    }
  });
}

/**
 * Play an audio blob.
 */
export function playAudioBlob(blob) {
  return new Promise((resolve) => {
    if (!blob) { resolve(); return; }
    blob.arrayBuffer()
      .then((arrayBuffer) => {
        // Try Web Audio first (mobile-safe); fall back to HTML <audio> on failure.
        return playArrayBuffer(arrayBuffer).catch((e) => {
          console.warn('Web Audio playback failed, falling back to HTMLAudio:', e);
          return playViaHtmlAudio(URL.createObjectURL(blob));
        });
      })
      .then(() => resolve())
      .catch((e) => {
        console.error('playAudioBlob error:', e);
        resolve();
      });
  });
}

// Legacy: speech recognition only (kept for compatibility)
export function startListening(lang = 'en-US') {
  return new Promise((resolve) => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      resolve('');
      return;
    }

    if (recognition) {
      try { recognition.stop(); } catch {}
    }

    recognition = new SpeechRecognition();
    recognition.lang = lang;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      resolve(transcript);
    };

    recognition.onerror = (event) => {
      console.log('SpeechRecognition event:', event.error);
      resolve('');
    };

    recognition.onend = () => {
      resolve('');
    };

    recognition.start();
  });
}

export function stopListening() {
  if (recognition) {
    try { recognition.stop(); } catch {}
    recognition = null;
  }
}

// --- Speech Synthesis ---

/**
 * Speak text. Uses Edge-TTS if connected, otherwise browser TTS.
 * @param {string} text - Text to speak
 * @param {object} opts - { rate, pitch, lang, voice }
 */
export async function speakText(text, opts = {}) {
  const voiceName = opts.voice || localStorage.getItem('speakup_preferred_voice') || '';
  const mode = opts.mode || getTtsMode();
  const speed = opts.rate || getSpeechRate();

  // --- 方案 C：浏览器内置语音为主路径 ---
  // 云端 TTS（Cloudflare Worker）在国内网络无法访问（workers.dev 被拦截，
  // 报 ERR_CONNECTION_RESET），因此默认直接走浏览器 speechSynthesis
  // （零服务器、零翻墙、国内直接可用）。仅当用户在设置里显式选择"云端模式"
  // 且已配置 Worker 地址时才走云端。
  if (mode === 'cloud' && getCloudTtsUrl()) {
    try {
      await cloudTtsSpeak(text, voiceName || 'en-US-JennyNeural', speed);
      return;
    } catch (e) {
      console.warn('Cloud TTS failed, falling back to browser TTS:', e?.message || e);
    }
  }

  // On public (non-localhost) deployments the Edge-TTS local server is
  // unreachable, so go straight to browser TTS instead of failing a fetch.
  const effectiveMode = (mode === 'edgetts' && !isLocalEnv()) ? 'browser' : mode;

  if (effectiveMode === 'edgetts') {
    try {
      // Convert float rate to edge-tts percentage (0.75 → "-25%")
      const pct = Math.round((speed - 1) * 100);
      const rateStr = `${pct >= 0 ? '+' : ''}${pct}%`;
      await edgeTtsSpeak(text, voiceName || 'en-US-JennyNeural', rateStr);
      return;
    } catch {
      console.warn('Edge-TTS unavailable, falling back to browser TTS');
      // fall through to browser TTS (do NOT persist global mode change)
    }
  }

  // Browser TTS
  browserSpeak(text, { ...opts, voice: voiceName, rate: speed });
}

// Speak text with the browser's built-in SpeechSynthesis engine.
// Robust for mobile: handles async voice loading, avoids the cancel-then-speak
// "first word dropped" bug, and splits long text into chunks to dodge the
// ~15s per-utterance cap on mobile browsers.
function browserSpeak(text, opts = {}) {
  if (!window.speechSynthesis) {
    console.warn('Speech synthesis not supported');
    return;
  }
  // Cancel anything currently playing before enqueuing new utterances.
  window.speechSynthesis.cancel();
  const lang = opts.lang || 'en-US';
  const rate = opts.rate || 1.0;
  const preferred = opts.voice || '';

  const speakChunks = (voices) => {
    const selected = pickBestVoice(voices, preferred);
    const chunks = splitIntoChunks(text);
    let index = 0;
    const speakNext = () => {
      if (index >= chunks.length) { speaking = false; return; }
      const chunk = chunks[index++];
      if (!chunk.trim()) { speakNext(); return; }
      const u = new SpeechSynthesisUtterance(chunk);
      u.lang = lang;
      u.rate = rate;
      u.pitch = opts.pitch || 1.0;
      if (selected) u.voice = selected;
      u.onend = () => { if (index >= chunks.length) speaking = false; speakNext(); };
      u.onerror = () => { if (index >= chunks.length) speaking = false; speakNext(); };
      window.speechSynthesis.speak(u);
    };
    speaking = true;
    speakNext();
  };

  // Voices load asynchronously on most browsers (getVoices() is empty until the
  // 'voiceschanged' event fires). Wait for them before speaking so we actually
  // pick a usable English voice instead of a silent default.
  const voices = window.speechSynthesis.getVoices();
  if (voices && voices.length > 0) {
    speakChunks(voices);
  } else {
    const onVoicesChanged = () => {
      window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
      speakChunks(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);
    // Safety fallback: if the event never fires, try after a short delay.
    setTimeout(() => {
      const v = window.speechSynthesis.getVoices();
      if (v && v.length > 0) {
        window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
        speakChunks(v);
      } else {
        // No voices available at all — speak with the default engine anyway.
        speakChunks([]);
      }
    }, 400);
  }
}

// Split long text into chunks small enough to avoid the mobile ~15s utterance cap.
function splitIntoChunks(text, maxLen = 180) {
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]*/g) || [text];
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > maxLen && current) {
      chunks.push(current.trim());
      current = '';
    }
    current += s;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}

function pickBestVoice(voices, preferredVoiceName) {
  if (!voices || voices.length === 0) return null;

  if (preferredVoiceName) {
    const match = voices.find(v => v.name === preferredVoiceName);
    if (match) return match;
  }

  const priorityPatterns = [
    'Google US English',
    'Google UK English Female',
    'Google UK English Male',
    'Microsoft Jenny',
    'Microsoft Guy',
    'Microsoft Aria',
    'Microsoft David',
    'Microsoft Zira',
    'Samantha',
    'Alex',
    'Daniel',
    'Karen',
    /^en-US/,
    /^en/,
  ];

  for (const pattern of priorityPatterns) {
    const found = typeof pattern === 'string'
      ? voices.find(v => v.name === pattern)
      : voices.find(v => v.lang.match(pattern));
    if (found) return found;
  }

  return null;
}

export function getEnglishVoices() {
  if (!window.speechSynthesis) return [];
  const voices = window.speechSynthesis.getVoices();
  return voices
    .filter(v => v.lang.startsWith('en'))
    .map(v => ({ name: v.name, lang: v.lang, default: v.default }));
}

export function stopSpeaking() {
  // Stop Web Audio playback if playing
  if (currentSource) {
    try { currentSource.stop(); } catch {}
    currentSource = null;
  }
  // Stop HTML <audio> playback if playing
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio.load();
    currentAudio = null;
  }
  // Stop browser SpeechSynthesis
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  speaking = false;
}

export function isSpeaking() {
  return speaking;
}

export function supportsSpeechRecognition() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function getSpeechRate() {
  return parseFloat(localStorage.getItem('speakup_speed') || '0.75');
}

export function setSpeechRate(val) {
  localStorage.setItem('speakup_speed', val.toString());
}

export const SPEED_PRESETS = [
  { value: 0.7, label: '慢速 (入门)' },
  { value: 0.85, label: '中速 (进阶)' },
  { value: 1.0, label: '正常语速' },
];
