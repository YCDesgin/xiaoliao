// Speech service: Web Speech API (free) + optional Edge-TTS (natural voices)
// Edge-TTS provides much more natural English voices via a local Python server

// --- Cloud ASR (华为 / 无 GMS 安卓手机语音输入) ---
// 关键修复（绕过全部移动端音频 API 的坑）：前端只做"最稳的原生采集 + 原样上传"，
// 不做任何解码 / 重采样 / WAV 编码。直接用原生 MediaRecorder 录 audio/webm;codecs=opus
// （移动端最稳），把 Blob 原样 POST 给云端代理 ?action=asr；代理侧用 ffmpeg 转码成
// NLS 要求的 16k/16bit/mono WAV 再送阿里云识别。
// 这样彻底绕开此前五代迭代都栽过的坑：MediaRecorder 解不开 webm/opus、
// ScriptProcessor / AudioWorklet 在安卓上不触发回调、extendable-media-recorder 依赖
// SharedArrayBuffer（GitHub Pages 不发送 COOP/COEP → crossOriginIsolated=false →
// 安卓上 SAB 不可用 → connect() 失败 → 回退原生 MediaRecorder 录 webm → 又卡死）。

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

// --- Centralized ASR error reporting ---
// Mirrors setTtsErrorHandler: lets the app layer surface a user-visible error
// (e.g. red text in the input bar) when cloud speech recognition fails, so the
// failure is never silently swallowed as empty text (the original Huawei bug).
let asrErrorHandler = null;
export function setAsrErrorHandler(fn) {
  if (typeof fn === 'function') asrErrorHandler = fn;
  else asrErrorHandler = null;
}
function reportAsrError(msg) {
  console.error('[XiaLiao ASR] ' + msg);
  if (asrErrorHandler) { try { asrErrorHandler(msg); } catch {} }
}

// --- Centralized ASR status reporting (always-on diagnostic bar) ---
// Lets the app layer render a persistent status line (mode / phase / detail)
// so the user can tell whether ASR is in cloud mode, recording, uploading,
// recognizing, succeeded, or failed — even when no text ever comes back.
let asrStatusHandler = null;
export function setAsrStatusHandler(fn) {
  if (typeof fn === 'function') asrStatusHandler = fn;
  else asrStatusHandler = null;
}
// status: { mode?: string, phase?: string, detail?: string }
function reportAsrStatus(status) {
  if (asrStatusHandler && status) {
    try { asrStatusHandler(status); } catch {}
  }
}

let ttsMode = 'browser'; // 'browser' | 'edgetts'

// --- Word 🔊 provider (功能2 联动) ---
// 控制「点词朗读单个单词」走浏览器原生 speechSynthesis 还是云端 CosyVoice：
//   'browser'  （默认）  → 浏览器 SpeechSynthesis（免费，但机械）
//   'cosyvoice'           → 经 cloudTtsSpeak 走 FC 代理的 CosyVoice（更逼真）
// 句子播放始终由 getCloudTtsUrl() 是否存在决定（与现有一致），与此开关无关。
let wordTtsProvider =
  (typeof localStorage !== 'undefined' && localStorage.getItem('speakup_word_tts_provider')) || 'browser';

export function setWordTtsProvider(p) {
  wordTtsProvider = p;
  if (typeof localStorage !== 'undefined') {
    if (p && p !== 'browser') localStorage.setItem('speakup_word_tts_provider', p);
    else localStorage.removeItem('speakup_word_tts_provider');
  }
}

export function getWordTtsProvider() {
  return wordTtsProvider;
}

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
      // 代理支持根路径 + query（主）与 /tts 子路径（兼容）。优先用根路径，
      // 因为部分 FC 版本对子路径转发不一致，根路径最稳定。
      const sep = cloudUrl.includes('?') ? '&' : '?';
      res = await fetch(`${cloudUrl}${sep}${params}`, { signal: AbortSignal.timeout(15000) });
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
let recordingSafetyTimer = null; // Module-level safety-timeout handle so cancelRecording can clear it

// --- Cloud ASR capture (raw upload path) ---
// When the device has no usable native SpeechRecognition (e.g. Huawei without
// GMS) but a cloud ASR proxy URL is configured, we record audio with the native
// MediaRecorder (audio/webm;codecs=opus, the most reliable on mobile) and upload
// the raw Blob to the proxy as-is — the proxy transcodes it to 16k/16bit/mono WAV
// with ffmpeg and forwards it to Aliyun NLS. No client-side decode/resample/WAV
// encoding is performed, which is what finally sidesteps every mobile-audio pitfall.
let recordingUseCloud = false;   // true when this session uses the cloud ASR path
let cloudRecordedMimeType = '';  // mimeType of the cloud MediaRecorder capture ('audio/webm;codecs=opus' | 'audio/webm' | '')

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
    // 麦克风权限被拒 / 设备无麦克风：必须给用户红字提示，绝不能再静默消失
    console.log('Mic permission denied:', e);
    reportAsrError('麦克风不可用：请允许麦克风权限后重试');
    reportAsrStatus({ mode: getAsrModeLabel(), phase: '失败', detail: '麦克风权限被拒' });
    return { transcript: '', audioBlob: null };
  }

  interimCallback = onInterim || null;

  // --- Reset capture state ---
  audioChunks = [];
  mediaRecorder = null;
  cloudRecordedMimeType = '';
  recordingUseCloud = false;
  finalTranscript = '';
  lastTranscript = '';
  recordingSafetyTimer = null;

  const cloudUrlPresent = !!getCloudTtsUrl();

  // --- SpeechRecognition（连续识别，不因停顿而自动停止）---
  // 关键修复：只要配置了云端 ASR 地址，就完全跳过原生 Web Speech 的创建与启动，
  // 绕开国产安卓"谎称支持原生识别却永不触发 onresult"的桩，避免静默失败。
  // 仅在没有云端地址、且浏览器确实暴露 SpeechRecognition 时，才走原生识别。
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (recognition) {
    try { recognition.stop(); } catch {}
    recognition = null;
  }

  // 诊断条：先推送当前模式（云端 / 原生 / 不可用）
  reportAsrStatus({ mode: getAsrModeLabel(), phase: '待命' });

  if (!cloudUrlPresent && SpeechRecognition) {
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
      // — don't stop, just log and keep going.
      // "service-not-allowed" / "network" 等表示引擎不可用（如华为无 GMS），
      // 清除 recognition，让原生分支在 stopRecording 中按"无识别结果"安全收尾。
      console.log('SpeechRecognition event:', event.error);
      if (event.error === 'service-not-allowed' || event.error === 'no-speech' || event.error === 'audio-capture' || event.error === 'network') {
        // 引擎不可用：停止识别实例
        try { recognition.stop(); } catch {}
        recognition = null;
      }
    };

    recognition.onend = () => {
      // Auto-restart if we're still supposed to be recording.
      // This handles Chrome's internal timeout without stopping the session.
      if (mediaRecorder && mediaRecorder.state === 'recording' && recognition) {
        try { recognition.start(); } catch {
          // If restart fails (e.g. tab losing focus or no engine), just wait for user to stop manually
          recognition = null;
        }
      }
    };

    try {
      recognition.start();
    } catch (err) {
      // 原生识别 .start() 同步抛异常：清除 recognition，原生分支将安全收尾（无识别结果）。
      // 注意：走到这里的前提是"未配置云端地址"（否则不会创建 recognition），
      // 因此不会误入云端分支。
      console.warn('SpeechRecognition.start() 失败，原生分支将安全收尾:', err?.message || err);
      recognition = null;
    }
  }

  // --- 决定采集方式 ---
  // 填了云端地址 → 走云端 ASR（录制 webm/opus 原样上传，由代理转码识别），绕开不可靠的原生识别。
  // 没填云端地址但浏览器暴露原生 SpeechRecognition → 走原生识别（桌面/部分浏览器）。
  recordingUseCloud = !!getCloudTtsUrl();
  if (recordingUseCloud) {
    // 云端模式：原生 MediaRecorder 录 webm/opus（移动端最稳），原样上传给代理转码
    await setupCloudWavCapture(recordingStream);
  } else {
    // MediaRecorder（录用户自己的声音用于回放）
    audioChunks = [];
    mediaRecorder = new MediaRecorder(recordingStream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };
    mediaRecorder.start();
  }

  // 诊断条：已进入录音采集阶段
  reportAsrStatus({ phase: '录音中', detail: recordingUseCloud ? '云端采集' : '原生采集' });

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
    let cloudTranscript = '';

    // 诊断条：推送当前模式
    reportAsrStatus({ mode: getAsrModeLabel() });

    // 云端识别模式：只要配置了云端 ASR 地址就走云端（绕开不可靠的原生识别）。
    // recognition 此时为 null（startRecording 已跳过原生识别创建）。
    const useCloud = !!getCloudTtsUrl();

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

      // 云端模式取云端 ASR 文本；原生模式取 final/interim 文本（含兜底）
      const transcript = useCloud
        ? (cloudTranscript || '').trim()
        : (finalTranscript.trim() || lastTranscript.trim());
      // 诊断条：原生模式根据最终 transcript 标记成功/失败（云端模式在各分支已单独上报）
      if (!useCloud) {
        if (transcript) {
          reportAsrStatus({ phase: '成功', detail: `识别到 ${transcript.length} 字` });
        } else {
          reportAsrStatus({ phase: '失败', detail: '原生无返回' });
        }
      }
      if (recordingResolve) {
        recordingResolve({ transcript, audioBlob });
        recordingResolve = null;
      }
      resolve({ transcript, audioBlob });
    };

    // 安全超时：原生模式等 recognition 收尾（3s）；云端模式等上传+识别（15s）
    // 提成模块级 recordingSafetyTimer，以便 cancelRecording 能清除潜在兜底 timer。
    recordingSafetyTimer = setTimeout(() => {
      recordingSafetyTimer = null;
      // 超时兜底：无论云端还是原生，都必须给红字提示 + 诊断条，绝不再静默消失
      if (!resolved) {
        if (useCloud) {
          reportAsrError('语音识别超时，请重试');
        } else {
          reportAsrError('原生语音识别失败，请改用云端识别或检查网络');
        }
        reportAsrStatus({ phase: '失败', detail: '超时' });
      }
      recorderStopped = true;
      recognitionStopped = true;
      tryResolve();
    }, useCloud ? 15000 : 3000);

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

    // --- Cloud ASR branch: encode captured PCM straight to WAV and upload ---
    if (useCloud) {
      // 云端模式：把采集到的 webm/opus Blob 原样交给代理，由代理 ffmpeg 转码成 WAV 再识别。
      // 前端不再做任何解码（彻底绕开华为浏览器解不开 webm/opus 的原罪）。
      reportAsrStatus({ phase: '上传中', detail: '上传音频到云端' });
      cloudStopAndEncode()
        .then((wavBytes) => {
          // 关键修复：云端分支此前从未给 audioBlob 赋值（原生分支有），
          // 导致用户消息 audioBlob=null → 回放误走 TTS 念文字（变音）。
          // cloudStopAndEncode() 已返回原始录音 Blob，这里存进同作用域的 audioBlob。
          audioBlob = wavBytes;
          if (!wavBytes) {
            // 没有采集到有效声音
            reportAsrError('没听到声音，请按住麦克风再说一次');
            reportAsrStatus({ phase: '失败', detail: '没听到声音' });
            recorderStopped = true;
            tryResolve();
            return;
          }
          reportAsrStatus({ phase: '识别中', detail: '云端识别中' });
          return cloudAsr(wavBytes).then((t) => {
            if (!t || !t.trim()) {
              // 代理返回空：采到静音 / 没识别到 → 给红字提示，而不是静默消失
              // （这正是「转盘动画完成后直接消失、没有任何反应」的用户现象根因）
              reportAsrError('没听清，请再说一次（没识别到文字）');
              reportAsrStatus({ phase: '失败', detail: '没识别到文字' });
              recorderStopped = true;
              tryResolve();
              return;
            }
            cloudTranscript = t;
            reportAsrStatus({ phase: '成功', detail: `识别到 ${t.trim().length} 字` });
            recorderStopped = true;
            tryResolve();
          });
        })
        .catch((e) => {
          const msg = classifyAsrError(e);
          reportAsrError(msg);
          console.error('云端 ASR 失败:', e);
          reportAsrStatus({ phase: '失败', detail: msg });
          recorderStopped = true;
          cloudTranscript = '';
          tryResolve();
        });
      return;
    }

    // --- Native branch: stop MediaRecorder and collect webm for playback ---
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.onstop = () => {
        // 注意：云端模式下【保留】recordingSafetyTimer 作为 fetch 兜底，不要 clearTimeout。
        // 否则若云端请求因 CORS/网络挂起，会永远停在 Transcribing（无超时兜底）。
        audioBlob = audioChunks.length > 0
          ? new Blob(audioChunks, { type: 'audio/webm' })
          : null;
        recorderStopped = true;
        tryResolve();
      };
      mediaRecorder.stop();
    } else {
      clearTimeout(recordingSafetyTimer);
      recordingSafetyTimer = null;
      audioBlob = null;
      recorderStopped = true;
      tryResolve();
    }
  });
}

/**
 * Cancel an in-progress recording session.
 *
 * Stops capture, releases the microphone, and discards all collected audio —
 * WITHOUT resolving a sendable result and WITHOUT surfacing an error (a cancel
 * is a deliberate user action, so it stays neutral). The dangling Promise from
 * startRecording() is resolved with an empty payload so the UI's await never
 * leaks and the recording state doesn't get stuck.
 *
 * Idempotent & safe: if there is no active recording session, this is a no-op.
 */
export function cancelRecording() {
  // Nothing to cancel — no active recording session.
  if (!recordingResolve && !mediaRecorder && !recognition && !recordingStream) {
    return;
  }

  // Clear the safety-timeout so a later firing can't trigger error reporting
  // or a spurious resolve after the session was cancelled.
  if (recordingSafetyTimer) {
    clearTimeout(recordingSafetyTimer);
    recordingSafetyTimer = null;
  }

  // Stop the MediaRecorder (if still recording).
  try {
    if (mediaRecorder && typeof mediaRecorder.stop === 'function'
        && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
  } catch {}

  // Stop speech recognition (if any) and detach its handlers.
  try {
    if (recognition) recognition.stop();
  } catch {}
  if (recognition) {
    recognition.onresult = null;
    recognition.onend = null;
    recognition.onerror = null;
  }

  // Release the microphone.
  if (recordingStream) {
    try {
      recordingStream.getTracks().forEach(t => t.stop());
    } catch {}
    recordingStream = null;
  }

  // Reset all capture state so a fresh recording starts clean.
  mediaRecorder = null;
  recognition = null;
  audioChunks = [];
  recordingUseCloud = false;
  cloudRecordedMimeType = '';
  finalTranscript = '';
  lastTranscript = '';
  interimCallback = null;

  // Resolve the dangling Promise from startRecording() with an empty payload
  // so the UI's await doesn't leak. The UI must treat an empty transcript as
  // "do not send".
  if (recordingResolve) {
    recordingResolve({ transcript: '', audioBlob: null });
    recordingResolve = null;
  }

  // Neutral status update — NOT an error (cancel is a deliberate user action).
  reportAsrStatus({ mode: getAsrModeLabel(), phase: '待命', detail: '已取消' });
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

  // --- 云端 TTS 优先（只要配置了可用的云端地址）---
  // 云端 TTS（如阿里云语音合成代理）提供自然的英文神经语音，且国内可直连，
  // 是华为等无 GMS 手机听到自然英文发音的唯一可靠路径。用户在设置里填了
  // "云端 TTS 地址"就优先走云端；任何失败（网络/服务错误）都自动回退到
  // 浏览器语音，绝不会静音。
  const cloudUrl = getCloudTtsUrl();
  if (cloudUrl) {
    try {
      await cloudTtsSpeak(text, voiceName || 'en-US-JennyNeural', speed);
      return;
    } catch (e) {
      console.warn('Cloud TTS 失败，回退到浏览器语音:', e?.message || e);
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

/**
 * Speak a single word. Used by the per-word "tap to define" bubble so learners
 * can hear the exact pronunciation of the word they tapped (功能1 🔊).
 *
 * 播放入口可配置（功能2 联动，架构 §3 / §7）：
 *   - provider === 'cosyvoice' 且已配置云端 TTS 地址 → 走 cloudTtsSpeak（CosyVoice，更逼真）；
 *     失败自动回退浏览器 speechSynthesis。
 *   - 其余（默认 'browser'）→ 浏览器原生 SpeechSynthesis。
 *
 * @param {string} word - The word to speak
 * @param {object} opts - Optional { rate, lang, voice }
 */
export function speakWord(word, opts = {}) {
  if (!word) return;
  const text = String(word).trim();
  if (!text) return;

  const provider = getWordTtsProvider();
  if (provider === 'cosyvoice' && getCloudTtsUrl() && typeof window !== 'undefined' && window.speechSynthesis) {
    // 经云端 CosyVoice 朗读单词；任何失败都回退浏览器原生 TTS（绝不让点击无反应）。
    cloudTtsSpeak(text, 'en-US-JennyNeural', opts.rate || 0.8).catch(() => {
      speakBrowserWord(text, opts);
    });
    return;
  }

  speakBrowserWord(text, opts);
}

/**
 * Speak a single word using the browser's built-in SpeechSynthesis engine.
 * Reuses the same robust voice selection as browserSpeak() but keeps the rate
 * slow for clarity. (speakWord 的默认/browser 路径与此一致。)
 *
 * @param {string} word - The word to speak
 * @param {object} opts - Optional { rate, lang, voice }
 */
function speakBrowserWord(word, opts = {}) {
  if (!window.speechSynthesis) {
    console.warn('Speech synthesis not supported');
    return;
  }
  const text = String(word).trim();
  if (!text) return;

  const lang = opts.lang || 'en-US';
  const rate = opts.rate || 0.8; // slower than normal so the single word is clear
  const preferred = opts.voice || localStorage.getItem('speakup_preferred_voice') || '';

  // Cancel anything currently playing (including a sentence being read) so the
  // single-word playback is unambiguous.
  window.speechSynthesis.cancel();

  const speak = (voices) => {
    const selected = pickBestVoice(voices, preferred);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = rate;
    u.pitch = opts.pitch || 1.0;
    if (selected) u.voice = selected;
    speaking = true;
    u.onend = () => { speaking = false; };
    u.onerror = () => { speaking = false; };
    window.speechSynthesis.speak(u);
  };

  const voices = window.speechSynthesis.getVoices();
  if (voices && voices.length > 0) {
    speak(voices);
  } else {
    const onVoicesChanged = () => {
      window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
      speak(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);
    setTimeout(() => {
      const v = window.speechSynthesis.getVoices();
      window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
      speak(v && v.length > 0 ? v : []);
    }, 400);
  }
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

// --- 云端语音识别 (ASR) ---
// 前端只做"原生采集 + 原样上传"，不做任何解码/重采样/WAV 编码（见文件顶部说明）。
// 音频 Blob 由云端代理接收后用 ffmpeg 转码成 16k/16bit/mono WAV 再送阿里云 NLS。

// 把 ASR 异常归类为用户可读的中文提示
function classifyAsrError(e) {
  if (!e) return '云端语音识别失败，请重试';
  const msg = e.message || String(e);
  // 代理已在 cloudAsr 中带上 "云端语音识别失败（HTTP xxx）：" 前缀，原样透传即可
  if (/HTTP \d+/i.test(msg)) return msg;
  // fetch 网络层失败 / AbortSignal 超时（CORS 被拒 / 服务端不可达 / 断网 / 超时）
  if (e.name === 'TimeoutError' || /Failed to fetch|NetworkError|network|网络|fetch/i.test(msg)) {
    return '云端语音识别连接失败：网络异常或代理地址错误，请检查「云端TTS/ASR地址」设置';
  }
  // 其余（含代理透传的错误信息）直接展示
  return msg || '云端语音识别失败，请重试';
}

// 云端模式采集：直接用原生 MediaRecorder 录 audio/webm;codecs=opus（见下方 setupCloudWavCapture）。
// 旧版 AudioWorklet / ScriptProcessor / WAV 编码链路已整体移除（见文件顶部说明）。

// 云端模式采集（新主路径）：直接用原生 MediaRecorder 录 audio/webm;codecs=opus。
// 移动端最稳（opus 是安卓 Chrome/华为支持最好的编码），且无需前端做任何解码/重采样。
// 录到的 Blob 原样 POST 给云端代理，由代理侧 ffmpeg 转码成 16k/16bit/mono WAV 再送 NLS。
// 彻底绕开此前五代迭代都栽过的坑（见文件顶部说明）。
// 回退顺序：audio/webm;codecs=opus → audio/webm → 默认 new MediaRecorder(stream)。
async function setupCloudWavCapture(stream) {
  const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', ''];
  let mr = null;
  for (const mt of mimeCandidates) {
    try {
      mr = mt ? new MediaRecorder(stream, { mimeType: mt }) : new MediaRecorder(stream);
      cloudRecordedMimeType = mt || (mr.mimeType || 'audio/webm');
      break;
    } catch {
      mr = null;
    }
  }
  if (!mr) {
    // 连原生 MediaRecorder 都不可用：给红字提示，绝不静默消失
    mediaRecorder = null;
    reportAsrError('当前浏览器不支持录音（MediaRecorder 不可用）');
    return;
  }
  audioChunks = [];
  mr.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };
  try {
    mr.start();
  } catch (startErr) {
    console.warn('[ASR诊断] MediaRecorder.start 失败:', startErr?.message || startErr);
    mediaRecorder = null;
    reportAsrError('麦克风启动失败，请重试');
    return;
  }
  mediaRecorder = mr;
}

// 兜底采集链路（AudioWorklet / ScriptProcessor / WAV 编码）已整体移除：
// 移动端最稳的路径就是原生 MediaRecorder 录 opus/webm 再原样上传，转码交给后端 ffmpeg。

// 云端模式停止采集：直接停止 MediaRecorder，把收集到的音频 Blob（opus/webm）原样交给
// 发送逻辑。不再做 decodeAudioData / WAV 编码 / 重采样（这些交由后端 ffmpeg 完成）。
// 返回 Blob（opus/webm）或 null（没有采集到有效声音）。
async function cloudStopAndEncode() {
  // 停止云端采集的 MediaRecorder，确保最后一次 ondataavailable 的数据块已被推入
  // audioChunks 再读取。注意：云端分支在 stopRecording 里 return 早退，不会走到原生
  // 分支的 mediaRecorder.stop()，因此这里必须显式停止并等待 onstop 完成 flush。
  if (mediaRecorder && typeof mediaRecorder.stop === 'function') {
    try {
      if (mediaRecorder.state === 'recording') {
        await new Promise((resolve) => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          mediaRecorder.onstop = finish;
          // 2 秒超时：安卓上 onstop 可能不触发，超时后继续处理已收集的 audioChunks
          setTimeout(finish, 2000);
          try { mediaRecorder.stop(); } catch { finish(); }
        });
      } else {
        console.warn('[ASR诊断] 停止时 mediaRecorder.state=', mediaRecorder.state, '（可能 start 失败或已停止）');
      }
    } catch {
      /* 停止失败也无妨，已采集到的块仍可用 */
    }
  }

  if (audioChunks.length === 0) {
    // 没有采集到任何音频数据（ondataavailable 未触发，可能麦克风被占用或浏览器不支持录音）
    console.warn('[ASR诊断] 没有采集到任何音频数据（ondataavailable 未触发）');
    return null;
  }
  const blob = new Blob(audioChunks, { type: cloudRecordedMimeType || 'audio/webm' });
  audioChunks = [];
  return blob;
}

export async function cloudAsr(audioBlob) {
  const cloudUrl = getCloudTtsUrl();
  if (!cloudUrl) return '';
  // audioBlob：前端原生 MediaRecorder 录制的 opus/webm 音频，原样 POST 给代理。
  // 代理侧用 ffmpeg 转码成 NLS 要求的 16k/16bit/mono WAV，再送阿里云识别。
  if (!audioBlob || audioBlob.size === 0) {
    throw new Error('没有采集到音频数据');
  }
  const sep = cloudUrl.includes('?') ? '&' : '?';
  const res = await fetch(`${cloudUrl}${sep}action=asr`, {
    method: 'POST',
    // 用实际录制到的 mime 类型；代理会按二进制原样接收并用 ffmpeg 探测/转码
    headers: { 'Content-Type': audioBlob.type || 'application/octet-stream' },
    body: audioBlob,
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    // 代理透传的错误信息（j.error）优先；否则给出带前缀的 HTTP 状态提示
    let info = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.error) info = j.error;
    } catch {}
    throw new Error(`云端语音识别失败（${info}）`);
  }
  const json = await res.json();
  return (json && json.result) || '';
}

// 返回当前语音识别模式的可读中文标签（供诊断条常驻显示）
export function getAsrModeLabel() {
  if (getCloudTtsUrl()) return '云端识别模式';
  if (supportsSpeechRecognition()) return '原生识别模式';
  return '语音不可用';
}

// 是否支持语音输入：原生 SpeechRecognition 可用，或已配置云端 ASR 地址
export function supportsVoiceInput() {
  return supportsSpeechRecognition() || !!getCloudTtsUrl();
}
