/**
 * QA regression tests — MessageInput integration with the ASR diagnostic bar
 * and the red-text error bar.
 *
 * Verifies (against the REAL component + REAL speech.js service):
 *   - setAsrStatusHandler / setAsrErrorHandler are registered on mount and
 *     unregistered (set to null) on unmount.
 *   - the persistent diagnostic bar renders the mode + phase (e.g. "云端识别模式 · 待命").
 *   - firing the registered status handler updates the bar live.
 *   - firing the registered error handler shows the red error text.
 *   - when supportsVoiceInput() is false the mic button is disabled ("Mic not supported").
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import MessageInput from './MessageInput.jsx';
import * as speech from '../services/speech.js';

beforeEach(() => {
  localStorage.clear();
  speech.setCloudTtsUrl('https://asr.example.dev'); // cloud mode => mic enabled
  // Spy on the handler registrars so we can assert registration/unregistration.
  vi.spyOn(speech, 'setAsrStatusHandler');
  vi.spyOn(speech, 'setAsrErrorHandler');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  speech.setAsrErrorHandler(null);
  speech.setAsrStatusHandler(null);
});

describe('C. MessageInput diagnostic + error bar integration', () => {
  it('registers both status + error handlers on mount, unregisters on unmount', () => {
    const { unmount } = render(<MessageInput onSend={() => {}} />);
    expect(speech.setAsrStatusHandler).toHaveBeenCalledTimes(1);
    expect(speech.setAsrErrorHandler).toHaveBeenCalledTimes(1);
    expect(typeof speech.setAsrStatusHandler.mock.calls[0][0]).toBe('function');
    expect(typeof speech.setAsrErrorHandler.mock.calls[0][0]).toBe('function');

    unmount();
    // cleanup sets both handlers to null
    const lastStatus = speech.setAsrStatusHandler.mock.calls.at(-1)[0];
    const lastError = speech.setAsrErrorHandler.mock.calls.at(-1)[0];
    expect(lastStatus).toBeNull();
    expect(lastError).toBeNull();
  });

  it('renders the persistent diagnostic bar with the cloud mode label', () => {
    render(<MessageInput onSend={() => {}} />);
    expect(screen.getByText('语音')).toBeInTheDocument();
    expect(screen.getByText(/云端识别模式/)).toBeInTheDocument();
    expect(screen.getByText(/待命/)).toBeInTheDocument();
  });

  it('updates the diagnostic bar live when the status handler fires', () => {
    render(<MessageInput onSend={() => {}} />);
    const handler = speech.setAsrStatusHandler.mock.calls[0][0];
    act(() => {
      handler({ phase: '录音中', detail: '云端采集' });
    });
    expect(screen.getByText(/录音中/)).toBeInTheDocument();
    expect(screen.getByText(/云端采集/)).toBeInTheDocument();
  });

  it('shows red error text when the error handler fires', () => {
    render(<MessageInput onSend={() => {}} />);
    const handler = speech.setAsrErrorHandler.mock.calls[0][0];
    act(() => {
      handler('麦克风不可用：请允许麦克风权限后重试');
    });
    // error bar prefixes with "语音识别失败：" unless it starts with "没听到声音"
    expect(screen.getByText(/麦克风不可用/)).toBeInTheDocument();
  });

  it('keeps the red error bar independent from the diagnostic status bar', () => {
    render(<MessageInput onSend={() => {}} />);
    const errHandler = speech.setAsrErrorHandler.mock.calls[0][0];
    const statusHandler = speech.setAsrStatusHandler.mock.calls[0][0];
    // A recognition failure shows the red error text...
    act(() => {
      errHandler('没听清，请再说一次（没识别到文字）');
    });
    expect(screen.getByText(/没听清/)).toBeInTheDocument();
    // ...and a subsequent status update does NOT wipe it (the two bars are independent).
    act(() => {
      statusHandler({ phase: '成功', detail: '识别到 5 字' });
    });
    expect(screen.getByText(/没听清/)).toBeInTheDocument();
    // Both the error bar and the diagnostic bar are visible at the same time.
    expect(screen.getByText(/成功/)).toBeInTheDocument();
  });

  it('disables the mic button when supportsVoiceInput() is false', () => {
    localStorage.clear();
    window.SpeechRecognition = undefined;
    window.webkitSpeechRecognition = undefined;
    render(<MessageInput onSend={() => {}} />);
    const micBtn = screen.getByText('Mic not supported');
    expect(micBtn).toBeDisabled();
  });

  it('enables the mic button (Hold to talk) when a cloud URL is configured', () => {
    speech.setCloudTtsUrl('https://asr.example.dev');
    render(<MessageInput onSend={() => {}} />);
    expect(screen.getByText('Hold to talk')).toBeInTheDocument();
  });
});
