/**
 * XiaLiao (虾聊) Cloud TTS Worker
 * ---------------------------------------------------------------------------
 * A zero-cost Cloudflare Worker that proxies Microsoft Edge-TTS so the
 * XiaLiao web app can play natural English AI voices on ANY device — including
 * Chinese Android phones without Google Mobile Services (where the browser's
 * built-in speechSynthesis has no English voice).
 *
 * Implementation notes:
 *  - We talk to Edge-TTS directly with the NATIVE WebSocket API (no npm
 *    package needed). Cloudflare Workers support outbound WebSockets.
 *  - `GET /tts?text=...&voice=...&rate=...` returns an `audio/mpeg` stream.
 *  - `GET /voices` returns a JSON array of common English Neural voices.
 *
 * Deploy: see README.md (or just `npx wrangler deploy` inside this folder).
 */

// Hard-coded Microsoft subscription key used by the public edge.microsoft.com
// certificate endpoint (same constant as the open-source edge-tts library).
const SECRET = '9d3c3d3f0b9f4e9c9d3c3d3f0b9f4e9c';

// Public endpoint that mints a short-lived JWT used to authorize the WS.
const CERT_URL = 'https://edge.microsoft.com/tts/certificates';

// Edge-TTS WebSocket gateway (eastus region). The JWT is passed as a Bearer
// token directly in the query string (note: NO space after "Bearer").
const WS_BASE =
  'wss://eastus.tts.speech.microsoft.com/cognitiveservices/websockets/v1';

// 24kHz / 48kbps mono MP3 — small enough for mobile, good enough quality.
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

const DEFAULT_VOICE = 'en-US-JennyNeural';

// Common English Neural voices surfaced by the /voices endpoint.
const COMMON_VOICES = [
  { name: 'en-US-JennyNeural', gender: 'Female', locale: 'en-US', label: 'Jenny (US, Female)' },
  { name: 'en-US-GuyNeural', gender: 'Male', locale: 'en-US', label: 'Guy (US, Male)' },
  { name: 'en-GB-SoniaNeural', gender: 'Female', locale: 'en-GB', label: 'Sonia (UK, Female)' },
  { name: 'en-AU-NatashaNeural', gender: 'Female', locale: 'en-AU', label: 'Natasha (AU, Female)' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Standard CORS headers so the GitHub Pages frontend can call this Worker. */
function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/** Escape XML special characters so user text can safely live inside SSML. */
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Fetch a fresh JWT from the public certificate endpoint. */
async function getToken() {
  const res = await fetch(CERT_URL, {
    headers: {
      Pragma: 'no-cache',
      'Ocp-Apim-Subscription-Key': SECRET,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch TTS token: ${res.status}`);
  }
  const data = await res.json();
  if (!data || !data.token) {
    throw new Error('Certificate endpoint returned no token');
  }
  return data.token;
}

/** Build the SSML document Edge-TTS expects. */
function buildSsml(text, voice, rate) {
  const safe = escapeXml(text);
  const inner = rate ? `<prosody rate="${rate}">${safe}</prosody>` : safe;
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">` +
    `<voice name="${voice}">${inner}</voice></speak>`
  );
}

/** Extract the `Path:` value from a (text or binary-header) protocol frame. */
function parsePath(text) {
  const m = String(text).match(/^Path:\s*([^\r\n]+)/i);
  return m ? m[1].trim() : '';
}

/** Pull an error description out of a `response` frame, if any. */
function parseError(text) {
  const idx = text.indexOf('\r\n\r\n');
  const body = idx >= 0 ? text.slice(idx + 4) : '';
  if (!body) return null;
  try {
    const json = JSON.parse(body);
    const err = json.WebResult && json.WebResult.WebErrorInfo;
    if (err && err.Code) return err.Description || `TTS error ${err.Code}`;
  } catch {
    /* not JSON — ignore */
  }
  return null;
}

/** Concatenate an array of Uint8Array chunks into one Uint8Array. */
function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Synthesize `text` via the Edge-TTS WebSocket protocol.
 * Resolves with a Uint8Array containing the full MP3 audio.
 */
function synth(text, voice, rate) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws = null;

    const finish = (audio) => {
      if (settled) return;
      settled = true;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      }
      resolve(audio);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      }
      reject(err);
    };

    const requestId = crypto.randomUUID().replace(/-/g, '');
    const ts = new Date().toUTCString();
    const audioChunks = [];

    getToken()
      .then((token) => {
        ws = new WebSocket(`${WS_BASE}?Authorization=Bearer${token}`);

        ws.addEventListener('open', () => {
          // 1) speech.config — declare output format & metadata options.
          const config = {
            context: {
              synthesis: {
                audio: {
                  metadataoptions: {
                    sentenceBoundaryEnabled: 'false',
                    wordBoundaryEnabled: 'false',
                  },
                  outputFormat: OUTPUT_FORMAT,
                },
              },
            },
          };
          const configStr = JSON.stringify(config);
          ws.send(
            'Path: speech.config\r\n' +
              `X-RequestId: ${requestId}\r\n` +
              `X-Timestamp: ${ts}\r\n` +
              'Content-Type: application/json\r\n' +
              `Content-Length: ${new TextEncoder().encode(configStr).length}\r\n` +
              '\r\n' +
              configStr,
          );

          // 2) synthesis.context — the SSML to render.
          const ssml = buildSsml(text, voice, rate);
          ws.send(
            'Path: synthesis.context\r\n' +
              `X-RequestId: ${requestId}\r\n` +
              `X-Timestamp: ${ts}\r\n` +
              'Content-Type: application/ssml+xml\r\n' +
              `Content-Length: ${new TextEncoder().encode(ssml).length}\r\n` +
              '\r\n' +
              ssml,
          );
        });

        ws.addEventListener('message', (event) => {
          if (typeof event.data === 'string') {
            // Text frame: turn.start / response / turn.end / close ...
            const path = parsePath(event.data);
            if (path === 'turn.end' || path === 'close') {
              finish(concatChunks(audioChunks));
            } else if (path === 'response') {
              const err = parseError(event.data);
              if (err) fail(new Error(err));
            }
            // turn.start and other informational frames are ignored.
          } else {
            // Binary frame: first 2 bytes = big-endian header length, then the
            // header text, then the MP3 payload.
            const buf = event.data; // ArrayBuffer
            const view = new DataView(buf);
            const headerLen = view.getUint16(0);
            const headerText = new TextDecoder().decode(new Uint8Array(buf, 2, headerLen));
            if (parsePath(headerText) === 'audio') {
              audioChunks.push(new Uint8Array(buf, 2 + headerLen));
            }
            // audio.metadata frames (boundaries) are ignored.
          }
        });

        ws.addEventListener('error', () => {
          fail(new Error('WebSocket error during TTS synthesis'));
        });

        ws.addEventListener('close', () => {
          // Server hung up. If we never saw an explicit turn.end, return
          // whatever audio we managed to collect (best effort).
          if (!settled) finish(concatChunks(audioChunks));
        });
      })
      .catch((e) => fail(e));

    // Safety net: never hang the Worker forever on a stuck connection.
    setTimeout(() => fail(new Error('TTS synthesis timed out')), 30000);
  });
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

async function handleTts(request) {
  const url = new URL(request.url);
  const text = url.searchParams.get('text');
  if (!text || !text.trim()) {
    return new Response('Missing "text" parameter', { status: 400, headers: cors() });
  }
  const voice = url.searchParams.get('voice') || DEFAULT_VOICE;
  const rate = url.searchParams.get('rate') || undefined;

  try {
    const audio = await synth(text, voice, rate);
    return new Response(audio, {
      status: 200,
      headers: {
        ...cors(),
        'Content-Type': 'audio/mpeg',
        'Content-Disposition': 'inline',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (e) {
    return new Response(`TTS synthesis failed: ${e.message}`, {
      status: 500,
      headers: cors(),
    });
  }
}

async function handleVoices() {
  return new Response(JSON.stringify(COMMON_VOICES), {
    status: 200,
    headers: { ...cors(), 'Content-Type': 'application/json' },
  });
}

function handleOptions() {
  return new Response(null, { status: 204, headers: cors() });
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return handleOptions();
    if (url.pathname === '/voices') return handleVoices();
    if (url.pathname === '/tts') return handleTts(request);

    return new Response('Not Found. Try /tts?text=hello or /voices', {
      status: 404,
      headers: cors(),
    });
  },
};
