/**
 * QA regression tests — ChatView in-panel Voice <select> dropdown (small increment).
 *
 * Scope: the Voice dropdown added to the settings popover in ChatView.jsx
 *   (L282-292: Voice label + <select> bound to getEffectiveVoice / setContactVoiceOverride).
 *
 * Test plan:
 *   1. Render  — popover open shows a Voice <select> whose initial value
 *                equals getEffectiveVoice(contact); options match ALIYUN_VOICE_OPTIONS.
 *   2. Select  — choosing a new voice writes localStorage + refreshes the
 *                <select> display (voiceTick remount mechanism).
 *   3. Linkage — after override, getEffectiveVoice(contact) returns the new voice
 *                (so the next speakText call will use it); speakText wiring proof
 *                via the mount opening-line effect.
 *   4. No-reg  — Difficulty / Speed / Clear history controls still present.
 *   5. No-send — changing voice does NOT call chatWithAI (no message sent).
 *
 * External services (gemini / speech / imageService / reviewStore) are mocked so
 * ChatView renders in jsdom without network or Web Speech API.  voices.js and
 * contacts.js are used for real — they are pure localStorage logic and we want
 * to verify the genuine getEffectiveVoice / setContactVoiceOverride round-trip.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Service mocks — keep ChatView (and its children VoiceBubble / MessageInput)
// fully hermetic in jsdom.
// ---------------------------------------------------------------------------
vi.mock('../services/speech', () => ({
  speakText: vi.fn().mockResolvedValue(undefined),
  stopSpeaking: vi.fn(),
  SPEED_PRESETS: [
    { value: 0.7, label: '慢速' },
    { value: 0.85, label: '中速' },
    { value: 1.0, label: '正常' },
  ],
  // VoiceBubble
  playAudioBlob: vi.fn(),
  // MessageInput
  startRecording: vi.fn().mockResolvedValue(undefined),
  stopRecording: vi.fn().mockResolvedValue({ transcript: '', audioBlob: null }),
  cancelRecording: vi.fn(),
  supportsVoiceInput: vi.fn().mockReturnValue(false),
  setAsrErrorHandler: vi.fn(),
  setAsrStatusHandler: vi.fn(),
  getAsrModeLabel: vi.fn().mockReturnValue(''),
}));

vi.mock('../services/gemini', () => ({
  chatWithAI: vi.fn().mockResolvedValue('AI reply'),
  reviewConversation: vi.fn().mockResolvedValue({}),
  // VoiceBubble
  translateText: vi.fn().mockResolvedValue(''),
  defineWord: vi.fn().mockResolvedValue(null),
}));

vi.mock('../services/imageService', () => ({
  searchImage: vi.fn().mockResolvedValue(null),
  cleanQuery: vi.fn().mockReturnValue(''),
}));

vi.mock('../services/reviewStore', () => ({
  fingerprintOf: vi.fn().mockReturnValue('fp'),
  findCached: vi.fn().mockReturnValue(null),
  saveReview: vi.fn(),
  clearReviews: vi.fn(),
}));

import ChatView from './ChatView';
import { speakText } from '../services/speech';
import { chatWithAI } from '../services/gemini';
import {
  getEffectiveVoice,
  ALIYUN_VOICE_OPTIONS,
  KNOWN_EN_VOICES,
} from '../data/voices';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal contact without openingLine (no auto-speak on mount). */
function makeContact(id = 'qa-c1', name = 'QA Bot') {
  return {
    id,
    name,
    avatar: 'https://example.com/a.png',
    basePrompt: 'You are a test bot.',
  };
}

function makeProps(overrides = {}) {
  return {
    contact: makeContact(),
    messages: [],
    setMessages: vi.fn(),
    apiKey: 'sk-test',
    userAvatar: null,
    onBack: vi.fn(),
    onEnd: vi.fn(),
    onShowHistory: vi.fn(),
    fromHistory: false,
    ...overrides,
  };
}

/**
 * The settings (⋯) toggle is the only <button> whose <svg> contains <circle>
 * elements.  With no chat messages rendered there are no VoiceBubble SVGs, so
 * this uniquely targets the popover trigger.
 */
function getSettingsButton() {
  return Array.from(screen.getAllByRole('button')).find(
    (b) => b.querySelector('svg circle'),
  );
}

function openSettings() {
  fireEvent.click(getSettingsButton());
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let _origScrollIntoView;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  // jsdom does not implement Element.scrollIntoView; ChatView's messages effect
  // calls it on mount, so stub it to avoid a TypeError.
  _origScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  Element.prototype.scrollIntoView = _origScrollIntoView;
  cleanup();
});

// ---------------------------------------------------------------------------
// 1. Render
// ---------------------------------------------------------------------------

describe('ChatView Voice dropdown — render', () => {
  it('panel is hidden until the ⋯ button is clicked, then shows the Voice label + <select>', () => {
    render(<ChatView {...makeProps()} />);

    // Before opening: no Voice label visible.
    expect(screen.queryByText('Voice')).toBeNull();

    openSettings();

    // After opening: Voice label + combobox appear.
    expect(screen.getByText('Voice')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('the <select> initial value equals getEffectiveVoice(contact)', () => {
    const contact = makeContact('render-init', 'Init Bot');
    render(<ChatView {...makeProps({ contact })} />);

    openSettings();

    const select = screen.getByRole('combobox');
    expect(select.value).toBe(getEffectiveVoice(contact));
  });

  it('the <select> options exactly match ALIYUN_VOICE_OPTIONS', () => {
    render(<ChatView {...makeProps()} />);
    openSettings();

    const select = screen.getByRole('combobox');
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toEqual(ALIYUN_VOICE_OPTIONS.map((o) => o.value));
  });
});

// ---------------------------------------------------------------------------
// 2. Selection
// ---------------------------------------------------------------------------

describe('ChatView Voice dropdown — selection', () => {
  it('selecting a new voice writes localStorage and refreshes the <select> display', () => {
    const contact = makeContact('sel-1', 'Sel Bot');
    render(<ChatView {...makeProps({ contact })} />);
    openSettings();

    const select = screen.getByRole('combobox');
    const oldVoice = select.value;
    const newVoice = KNOWN_EN_VOICES.find((v) => v !== oldVoice);
    expect(newVoice).toBeTruthy(); // sanity: there is at least one other voice

    fireEvent.change(select, { target: { value: newVoice } });

    // localStorage key matches the PRD contract: speakup_voice_${contactId}
    expect(localStorage.getItem('speakup_voice_sel-1')).toBe(newVoice);

    // The select display refreshed (voiceTick remount → new value reflected).
    expect(screen.getByRole('combobox').value).toBe(newVoice);
  });

  it('switching back to the original voice also works (toggle)', () => {
    const contact = makeContact('sel-2', 'Toggle Bot');
    render(<ChatView {...makeProps({ contact })} />);
    openSettings();

    const select = screen.getByRole('combobox');
    const original = select.value;
    const other = KNOWN_EN_VOICES.find((v) => v !== original);

    // change away
    fireEvent.change(select, { target: { value: other } });
    expect(screen.getByRole('combobox').value).toBe(other);
    expect(localStorage.getItem('speakup_voice_sel-2')).toBe(other);

    // change back
    fireEvent.change(screen.getByRole('combobox'), { target: { value: original } });
    expect(screen.getByRole('combobox').value).toBe(original);
    expect(localStorage.getItem('speakup_voice_sel-2')).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// 3. Linkage with getEffectiveVoice / speakText
// ---------------------------------------------------------------------------

describe('ChatView Voice dropdown — linkage', () => {
  it('after overriding, getEffectiveVoice(contact) returns the new voice (next speakText will use it)', () => {
    const contact = makeContact('link-1', 'Link Bot');
    render(<ChatView {...makeProps({ contact })} />);
    openSettings();

    const select = screen.getByRole('combobox');
    const oldVoice = select.value;
    const newVoice = KNOWN_EN_VOICES.find((v) => v !== oldVoice);

    fireEvent.change(select, { target: { value: newVoice } });

    // Data-layer consistency: localStorage ↔ getEffectiveVoice agree.
    expect(localStorage.getItem('speakup_voice_link-1')).toBe(newVoice);
    expect(getEffectiveVoice(contact)).toBe(newVoice);

    // The <select> — which is bound to getEffectiveVoice(contact) — agrees too.
    expect(screen.getByRole('combobox').value).toBe(newVoice);
  });

  it('speakText is called with voice = getEffectiveVoice(contact) (wiring proof)', async () => {
    vi.useFakeTimers();
    const contact = makeContact('link-2', 'Speak Bot');
    contact.openingLine = 'Hi, I am Speak Bot!';
    const defaultVoice = getEffectiveVoice(contact);

    render(<ChatView {...makeProps({ contact })} />);

    // Mount effect schedules speakText after a 500 ms timeout.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(speakText).toHaveBeenCalledWith(
      'Hi, I am Speak Bot!',
      expect.objectContaining({ voice: defaultVoice }),
    );
  });

  it('after overriding the voice, a subsequent speakText call would receive the new voice', async () => {
    vi.useFakeTimers();
    const contact = makeContact('link-3', 'Speak Bot 2');
    contact.openingLine = 'Hello again!';
    const defaultVoice = getEffectiveVoice(contact);

    const { container } = render(<ChatView {...makeProps({ contact })} />);

    // Let the opening-line speakText fire (with the default voice).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(speakText).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ voice: defaultVoice }),
    );

    // Now override the voice via the settings <select>.
    vi.clearAllMocks();
    openSettings();
    const select = screen.getByRole('combobox');
    const newVoice = KNOWN_EN_VOICES.find((v) => v !== defaultVoice);
    fireEvent.change(select, { target: { value: newVoice } });

    // getEffectiveVoice now reflects the override — which is exactly what
    // the next speakText call (handlePlay / sendMessage) will read.
    expect(getEffectiveVoice(contact)).toBe(newVoice);
    expect(localStorage.getItem('speakup_voice_link-3')).toBe(newVoice);
  });
});

// ---------------------------------------------------------------------------
// 4. Non-regression — existing settings controls
// ---------------------------------------------------------------------------

describe('ChatView Voice dropdown — does not affect existing settings', () => {
  it('Difficulty, Speed, and Clear history controls are still present', () => {
    render(<ChatView {...makeProps()} />);
    openSettings();

    expect(screen.getByText('Difficulty')).toBeInTheDocument();
    expect(screen.getByText('Speed')).toBeInTheDocument();
    expect(screen.getByText('Clear history')).toBeInTheDocument();
  });

  it('Speed preset buttons are still clickable (no crash)', () => {
    render(<ChatView {...makeProps()} />);
    openSettings();

    // The Speed section renders one <button> per SPEED_PRESETS entry.
    // Clicking the first one should not throw.
    const speedLabels = ['慢速', '中速', '正常'];
    const speedBtn = screen.getByText(speedLabels[0]);
    expect(() => fireEvent.click(speedBtn)).not.toThrow();
  });

  it('Difficulty preset buttons are still clickable (no crash)', () => {
    render(<ChatView {...makeProps()} />);
    openSettings();

    const diffBtn = screen.getByText('入门');
    expect(() => fireEvent.click(diffBtn)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. No side-effect — changing voice must not send a message
// ---------------------------------------------------------------------------

describe('ChatView Voice dropdown — no send side-effect', () => {
  it('changing the voice does NOT call chatWithAI (sendMessage not triggered)', () => {
    render(<ChatView {...makeProps()} />);
    openSettings();

    const select = screen.getByRole('combobox');
    const newVoice = KNOWN_EN_VOICES.find((v) => v !== select.value);
    fireEvent.change(select, { target: { value: newVoice } });

    expect(chatWithAI).not.toHaveBeenCalled();
  });

  it('changing the voice does NOT call onEnd / onBack / onShowHistory', () => {
    const onEnd = vi.fn();
    const onBack = vi.fn();
    const onShowHistory = vi.fn();
    render(
      <ChatView
        {...makeProps({ onEnd, onBack, onShowHistory })}
      />,
    );
    openSettings();

    const select = screen.getByRole('combobox');
    const newVoice = KNOWN_EN_VOICES.find((v) => v !== select.value);
    fireEvent.change(select, { target: { value: newVoice } });

    expect(onEnd).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    expect(onShowHistory).not.toHaveBeenCalled();
  });
});
