import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// Stub the speech + gemini services so the test never depends on the Web
// Speech API / network (both unavailable in jsdom).
vi.mock('../services/speech', () => ({
  playAudioBlob: vi.fn(),
}));
vi.mock('../services/gemini', () => ({
  translateText: vi.fn(),
  defineWord: vi.fn(),
}));

import VoiceBubble from './VoiceBubble';
import { playAudioBlob } from '../services/speech';

const noop = () => {};

const TRANSCRIPT_WORDS = ['Hello', 'there', 'friend'];

function makeAiMessage(text = 'Hello there friend') {
  return { role: 'assistant', text, type: 'text' };
}

// The waveform (L0) is the only div with the class group
// `flex items-center gap-2 cursor-pointer`. Clicking any child of it bubbles
// up to its onClick handler (play/pause).
function getWaveform(container) {
  return container.querySelector('div.flex.items-center.gap-2.cursor-pointer');
}

function expectTranscriptVisible() {
  TRANSCRIPT_WORDS.forEach((w) => {
    expect(screen.getByText(w)).toBeInTheDocument();
  });
}

function expectTranscriptHidden() {
  TRANSCRIPT_WORDS.forEach((w) => {
    expect(screen.queryByText(w)).toBeNull();
  });
}

describe('VoiceBubble — waveform play/pause must NOT collapse expanded text (bug regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('expands text via the Show text button, then clicking the waveform keeps it open AND triggers onPlay', () => {
    const onPlay = vi.fn();
    const { container } = render(
      <VoiceBubble message={makeAiMessage()} isPlaying={false} onPlay={onPlay} apiKey="k" />,
    );

    // Initially the transcript is hidden.
    expectTranscriptHidden();

    // Expand the transcript with the dedicated toggle button.
    fireEvent.click(screen.getByText('▼ Show text'));
    expectTranscriptVisible();

    // Now click the waveform (play/pause) — the exact user action in the bug report.
    fireEvent.click(getWaveform(container));

    // THE FIX: text must remain expanded (it used to collapse back here).
    expectTranscriptVisible();
    // Playback must have been triggered.
    expect(onPlay).toHaveBeenCalledTimes(1);
    // The waveform must NOT have touched the text/word/translation state.
    expect(playAudioBlob).not.toHaveBeenCalled();
  });

  it('when text is collapsed, clicking the waveform only triggers onPlay and does not error', () => {
    const onPlay = vi.fn();
    const { container } = render(
      <VoiceBubble message={makeAiMessage()} isPlaying={false} onPlay={onPlay} apiKey="k" />,
    );

    expectTranscriptHidden();

    fireEvent.click(getWaveform(container));

    expect(onPlay).toHaveBeenCalledTimes(1);
    expectTranscriptHidden();
  });

  it('the Show text button still independently toggles text visibility (collapse works)', () => {
    const onPlay = vi.fn();
    render(<VoiceBubble message={makeAiMessage()} isPlaying={false} onPlay={onPlay} apiKey="k" />);

    // Expand
    fireEvent.click(screen.getByText('▼ Show text'));
    expectTranscriptVisible();

    // Collapse via the same button (now labelled Hide text)
    fireEvent.click(screen.getByText('▲ Hide text'));
    expectTranscriptHidden();

    // Waveform was never invoked.
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('user bubble with audioBlob routes waveform click to playAudioBlob, not onPlay', () => {
    const onPlay = vi.fn();
    const blob = new Blob(['x'], { type: 'audio/wav' });
    const { container } = render(
      <VoiceBubble
        message={{ role: 'user', text: 'my recording', audioBlob: blob, type: 'text' }}
        isPlaying={false}
        onPlay={onPlay}
        apiKey="k"
      />,
    );

    fireEvent.click(getWaveform(container));

    expect(playAudioBlob).toHaveBeenCalledTimes(1);
    expect(playAudioBlob).toHaveBeenCalledWith(blob);
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('user bubble WITHOUT audioBlob routes waveform click to onPlay', () => {
    const onPlay = vi.fn();
    const { container } = render(
      <VoiceBubble
        message={{ role: 'user', text: 'no audio', type: 'text' }}
        isPlaying={false}
        onPlay={onPlay}
        apiKey="k"
      />,
    );

    fireEvent.click(getWaveform(container));

    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(playAudioBlob).not.toHaveBeenCalled();
  });
});
