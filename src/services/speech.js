// Speech service: Web Speech API (free) + optional Edge-TTS (natural voices)
// Edge-TTS provides much more natural English voices via a local Python server

let recognition = null;
let speaking = false;
let currentAudio = null;  // Track currently playing Audio element so we can cancel it
let ttsMode = 'browser'; // 'browser' | 'edgetts'

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
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio.load();
    currentAudio = null;
    speaking = false;
  }

  const url = new URL(`${EDGETTS_URL}/speak`);
  url.searchParams.set('text', text);
  if (voiceName) url.searchParams.set('voice', voiceName);
  if (rate) url.searchParams.set('rate', rate);

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error('Edge-TTS server error');

  const blob = await res.blob();
  const audioUrl = URL.createObjectURL(blob);
  const audio = new Audio(audioUrl);
  // Mount to DOM: detached Audio elements are blocked by mobile autoplay
  // policies even after a user gesture (play() runs after the fetch callback).
  audio.style.cssText = 'position:absolute;left:-9999px;opacity:0;pointer-events:none;width:1px;height:1px;';
  document.body.appendChild(audio);
  currentAudio = audio;

  return new Promise((resolve) => {
    const cleanup = () => {
      URL.revokeObjectURL(audioUrl);
      speaking = false;
      if (currentAudio === audio) currentAudio = null;
      if (audio.parentNode) audio.parentNode.removeChild(audio);
    };
    audio.onended = () => { cleanup(); resolve(); };
    audio.onerror = (e) => {
      console.error('Edge-TTS audio error:', e);
      cleanup();
      resolve();
    };
    speaking = true;
    audio.play().catch((e) => {
      console.error('Edge-TTS play() blocked:', e);
      cleanup();
      resolve();
    });
  });
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
  // Cancel any currently playing audio immediately.
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio.load();
    currentAudio = null;
    speaking = false;
  }

  const cloudUrl = getCloudTtsUrl();
  const params = new URLSearchParams({ text });
  if (voiceName) params.set('voice', voiceName);
  if (rate !== undefined) {
    const pct = Math.round((rate - 1) * 100);
    params.set('rate', `${pct >= 0 ? '+' : ''}${pct}%`);
  }

  const res = await fetch(`${cloudUrl}/tts?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Cloud TTS error: ${res.status}`);

  const blob = await res.blob();
  const audioUrl = URL.createObjectURL(blob);
  const audio = new Audio(audioUrl);
  // Mount to DOM so mobile autoplay policies don't silently block playback
  // (play() runs after await fetch, outside the original user gesture).
  audio.style.cssText = 'position:absolute;left:-9999px;opacity:0;pointer-events:none;width:1px;height:1px;';
  document.body.appendChild(audio);
  currentAudio = audio;

  return new Promise((resolve) => {
    const cleanup = () => {
      URL.revokeObjectURL(audioUrl);
      speaking = false;
      if (currentAudio === audio) currentAudio = null;
      if (audio.parentNode) audio.parentNode.removeChild(audio);
    };
    audio.onended = () => { cleanup(); resolve(); };
    audio.onerror = (e) => {
      console.error('Cloud TTS audio error:', e);
      cleanup();
      resolve();
    };
    speaking = true;
    audio.play().catch((e) => {
      console.error('Cloud TTS play() blocked:', e);
      cleanup();
      resolve();
    });
  });
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
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    // Mount to DOM to satisfy mobile autoplay policies (same fix as cloud/edge TTS).
    audio.style.cssText = 'position:absolute;left:-9999px;opacity:0;pointer-events:none;width:1px;height:1px;';
    document.body.appendChild(audio);

    const cleanup = () => {
      URL.revokeObjectURL(url);
      if (audio.parentNode) audio.parentNode.removeChild(audio);
    };
    audio.onended = () => { cleanup(); resolve(); };
    audio.onerror = (e) => {
      console.error('playAudioBlob audio error:', e);
      cleanup();
      resolve();
    };
    audio.play().catch((e) => {
      console.error('playAudioBlob play() blocked:', e);
      cleanup();
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

  // --- Cloud TTS priority ---
  // If a cloud TTS Worker URL is configured, always prefer it. This is what
  // makes AI voices audible on public (GitHub Pages) deployments and on
  // Chinese Android phones without Google Mobile Services, where the browser
  // speechSynthesis engine has no usable English voice.
  const cloudUrl = getCloudTtsUrl();
  if (cloudUrl) {
    try {
      await cloudTtsSpeak(text, voiceName || 'en-US-JennyNeural', speed);
      return;
    } catch (e) {
      console.warn('Cloud TTS failed, falling back to local/default engine:', e?.message || e);
      // Do NOT change the global TTS mode — only fall back for this single call.
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

function browserSpeak(text, opts = {}) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      console.warn('Speech synthesis not supported');
      resolve();
      return;
    }

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = opts.lang || 'en-US';
    utterance.rate = opts.rate || 1.0;
    utterance.pitch = opts.pitch || 1.0;

    // Pick best available voice
    const voices = window.speechSynthesis.getVoices();
    const selectedVoice = pickBestVoice(voices, opts.voice);
    if (selectedVoice) utterance.voice = selectedVoice;

    speaking = true;

    utterance.onend = () => { speaking = false; resolve(); };
    utterance.onerror = () => { speaking = false; resolve(); };

    window.speechSynthesis.speak(utterance);
  });
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
  // Stop Edge-TTS audio if playing
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
