/**
 * QA regression tests — MessageInput "录音取消" UI wiring.
 *
 * Drives the REAL MessageInput component with a PARTIALLY mocked speech service
 * (startRecording / stopRecording / cancelRecording are stubbed so we don't need
 * full MediaRecorder/getUserMedia/fetch mocks — the service contract is already
 * covered by speech.cancel.test.jsx). Verifies the UI-level contract added in
 * this feature:
 *
 *   - While recording (isRecording), the 取消 button is shown (and 完成 too).
 *   - Clicking 取消 calls cancelRecording(), returns the bar to idle (Hold to
 *     talk reappears, 取消 disappears), and does NOT call onSend (no message sent).
 *   - When NOT recording, there is no 取消 button and cancelRecording is never
 *     triggered from the UI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import MessageInput from './MessageInput.jsx';

// Partially mock the speech service: keep the real setAsrErrorHandler /
// setAsrStatusHandler / getAsrModeLabel, but replace the recording lifecycle
// functions with controllable stubs. startRecording returns a never-resolving
// promise to simulate an in-progress session; cancelRecording is a plain spy.
vi.mock('../services/speech', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    supportsVoiceInput: () => true,
    startRecording: vi.fn().mockReturnValue(new Promise(() => {})),
    stopRecording: vi.fn().mockResolvedValue({ transcript: 'hello', audioBlob: null }),
    cancelRecording: vi.fn(),
  };
});

import * as speech from '../services/speech';

beforeEach(() => {
  localStorage.clear();
  speech.setCloudTtsUrl('https://asr.example.dev'); // mic enabled (cloud mode label)
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  setAsrStatusHandlerUnregistered();
});

function setAsrStatusHandlerUnregistered() {
  try { speech.setAsrStatusHandler(null); speech.setAsrErrorHandler(null); } catch {}
}

describe('MessageInput — 录音取消按钮 (UI)', () => {
  it('shows 取消 while recording; clicking it cancels without sending and returns to idle', async () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    // Start "recording" via the mic button.
    const micBtn = screen.getByText('Hold to talk');
    await act(async () => { fireEvent.click(micBtn); });

    // The 取消 (cancel) button must now be visible.
    const cancelBtn = screen.getByText('取消');
    expect(cancelBtn).toBeInTheDocument();

    // Click 取消.
    await act(async () => { fireEvent.click(cancelBtn); });

    // cancelRecording was invoked exactly once.
    expect(speech.cancelRecording).toHaveBeenCalledTimes(1);
    // No message was sent (cancel discards).
    expect(onSend).not.toHaveBeenCalled();
    // The bar returns to idle: Hold to talk reappears...
    expect(screen.getByText('Hold to talk')).toBeInTheDocument();
    // ...and the 取消 button is gone.
    expect(screen.queryByText('取消')).not.toBeInTheDocument();
  });

  it('does NOT show 取消 when not recording, and never triggers cancelRecording', () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    // Idle state: no 取消 button.
    expect(screen.queryByText('取消')).not.toBeInTheDocument();
    // And the service cancel was never called by the UI.
    expect(speech.cancelRecording).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });
});
