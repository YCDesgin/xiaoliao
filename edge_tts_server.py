"""
Edge-TTS server for natural-sounding English voices.
Uses Microsoft's neural voice engine (free, no API key needed).

Usage: python edge_tts_server.py
Runs on port 5100.

Endpoints:
  GET  /voices           — list available English voices
  GET  /speak?text=...&voice=...&rate=...  — MP3 audio of spoken text
"""

import asyncio
import io
import json
import re
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs

try:
    import edge_tts
except ImportError:
    print("Please install edge-tts: pip install edge-tts")
    exit(1)

VOICES = [
    # Best male voices (ranked)
    {"name": "en-US-ChristopherNeural", "label": "Christopher (US Male \u2014 warm, natural)"},
    {"name": "en-US-EricNeural", "label": "Eric (US Male \u2014 friendly, natural)"},
    {"name": "en-US-DavisNeural", "label": "Davis (US Male \u2014 deep, calm)"},
    {"name": "en-US-RogerNeural", "label": "Roger (US Male \u2014 steady)"},
    {"name": "en-US-GuyNeural", "label": "Guy (US Male)"},
    {"name": "en-US-SteffanNeural", "label": "Steffan (US Male \u2014 low)"},
    # Best female voices (ranked)
    {"name": "en-US-AvaNeural", "label": "Ava (US Female \u2014 warm, modern)"},
    {"name": "en-US-AriaNeural", "label": "Aria (US Female \u2014 expressive)"},
    {"name": "en-US-EmmaNeural", "label": "Emma (US Female \u2014 friendly)"},
    {"name": "en-US-JennyNeural", "label": "Jenny (US Female \u2014 cheerful)"},
    {"name": "en-US-MichelleNeural", "label": "Michelle (US Female \u2014 pleasant)"},
    {"name": "en-US-AnaNeural", "label": "Ana (US Female \u2014 youthful)"},
    {"name": "en-US-SaraNeural", "label": "Sara (US Female)"},
    # UK / AU variants
    {"name": "en-GB-SoniaNeural", "label": "Sonia (UK Female)"},
    {"name": "en-GB-RyanNeural", "label": "Ryan (UK Male)"},
    {"name": "en-AU-NatashaNeural", "label": "Natasha (AU Female)"},
]

DEFAULT_VOICE = "en-US-JennyNeural"


def clean_text(text):
    text = re.sub(r'\*\*?(.*?)\*\*?', r'\1', text)
    text = re.sub(r'`(.*?)`', r'\1', text)
    text = re.sub(r'\[(.*?)\]\(.*?\)', r'\1', text)
    text = re.sub(r'[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF\U0001F1E0-\U0001F1FF\u2600-\u26FF\u2700-\u27BF]', '', text)
    return text.strip()


async def _generate_speech(text, voice, rate):
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    buffer = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            buffer.write(chunk["data"])
    return buffer.getvalue()


class TTSHandler(BaseHTTPRequestHandler):
    timeout = 30  # seconds

    def log_message(self, format, *args):
        if args and args[0].startswith('"GET'):
            print(f"  {args[0]}")

    def _set_cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')

    def do_OPTIONS(self):
        self.send_response(200)
        self._set_cors()
        self.end_headers()

    def do_GET(self):
        try:
            parsed = urlparse(self.path)

            if parsed.path == '/voices':
                self.send_response(200)
                self._set_cors()
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(VOICES).encode())
                return

            if parsed.path == '/speak':
                params = parse_qs(parsed.query)
                text = params.get('text', [''])[0]
                voice = params.get('voice', [DEFAULT_VOICE])[0]
                rate_str = params.get('rate', ['+0%'])[0]

                if not text:
                    self.send_response(400)
                    self.end_headers()
                    return

                text = clean_text(text)
                if not text:
                    self.send_response(204)
                    self.end_headers()
                    return

                try:
                    audio_data = asyncio.run(
                        asyncio.wait_for(_generate_speech(text, voice, rate_str), timeout=25)
                    )
                except asyncio.TimeoutError:
                    self.send_response(504)
                    self.end_headers()
                    print(f"  Timeout generating speech for: {text[:50]}...")
                    return
                except Exception as e:
                    self.send_response(500)
                    self.end_headers()
                    print(f"  TTS error: {e}")
                    traceback.print_exc()
                    return

                self.send_response(200)
                self._set_cors()
                self.send_header('Content-Type', 'audio/mpeg')
                self.send_header('Content-Length', str(len(audio_data)))
                self.end_headers()
                self.wfile.write(audio_data)
                return

            self.send_response(404)
            self.end_headers()

        except (ConnectionError, BrokenPipeError):
            pass  # Client disconnected, ignore
        except Exception as e:
            print(f"  Request error: {e}")
            traceback.print_exc()
            try:
                self.send_response(500)
                self.end_headers()
            except Exception:
                pass


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """Handle each request in a separate thread."""
    daemon_threads = True


if __name__ == '__main__':
    port = 5100
    server = ThreadedHTTPServer(('127.0.0.1', port), TTSHandler)
    print(f"Edge-TTS server running on http://localhost:{port}")
    print(f"Voices: {len(VOICES)} | Threaded mode")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
