import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';

// ChatView is heavy (Web Speech API, Gemini fetch, image search, review store).
// Mock every service it touches so we can unit-test the back-arrow navigation
// logic in isolation. We only care about WHICH callback (onBack vs onEnd) fires.
vi.mock('../services/gemini', () => ({
  chatWithAI: vi.fn(),
  reviewConversation: vi.fn().mockResolvedValue({
    summary: 'Nice chatting with you today!',
    summaryZh: '',
    score: 80,
    mistakes: [],
    newWords: [],
    suggestions: [],
    expressions: [],
    feedback: 'Keep practicing!',
  }),
}));
vi.mock('../services/speech', () => ({
  speakText: vi.fn().mockResolvedValue(undefined),
  stopSpeaking: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  supportsSpeechRecognition: vi.fn().mockReturnValue(false),
  SPEED_PRESETS: [{ value: 0.75, label: '0.75x' }],
}));
vi.mock('../data/contacts', () => ({
  DIFFICULTY_PRESETS: [{ id: 'beginner', label: 'Beginner', rules: '' }],
  getContactDifficulty: vi.fn().mockReturnValue('beginner'),
  setContactDifficulty: vi.fn(),
}));
vi.mock('../services/reviewStore', () => ({
  fingerprintOf: vi.fn().mockReturnValue('fp-test'),
  findCached: vi.fn().mockReturnValue(undefined),
  saveReview: vi.fn().mockReturnValue({ id: 'e1', generatedAt: new Date().toISOString() }),
  clearReviews: vi.fn(),
  getReviews: vi.fn().mockReturnValue([]),
}));
vi.mock('../services/imageService', () => ({
  searchImage: vi.fn().mockResolvedValue(null),
  cleanQuery: vi.fn((q) => q),
}));

import ChatView from './ChatView';
import EndReview from './EndReview';

// jsdom does not implement scrollIntoView; stub it so ChatView's scroll effect
// never throws during render.
Element.prototype.scrollIntoView = vi.fn();

const contact = {
  id: 'emma',
  name: 'Emma',
  avatar: 'https://example.com/emma.png',
  voice: 'en-US',
  basePrompt: 'You are Emma.',
  openingLine: 'Hi!',
};

const noop = vi.fn();

function mkMessages(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'them',
    text: `message ${i}`,
    timestamp: new Date(),
  }));
}

// ----------------------------------------------------------------- Bug A: nav
describe('ChatView back-arrow navigation (Bug A)', () => {
  it('fromHistory=true → back returns to contacts (onBack), no auto-review', async () => {
    const onBack = vi.fn();
    const onEnd = vi.fn();
    render(
      <ChatView
        contact={contact}
        messages={mkMessages(3)}
        setMessages={noop}
        apiKey="key"
        userAvatar={null}
        onBack={onBack}
        onEnd={onEnd}
        onShowHistory={noop}
        fromHistory={true}
      />,
    );
    fireEvent.click(screen.getByText('←'));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('fromHistory=false with >=2 messages → auto-review (onEnd), not back', async () => {
    const onBack = vi.fn();
    const onEnd = vi.fn();
    render(
      <ChatView
        contact={contact}
        messages={mkMessages(3)}
        setMessages={noop}
        apiKey="key"
        userAvatar={null}
        onBack={onBack}
        onEnd={onEnd}
        onShowHistory={noop}
        fromHistory={false}
      />,
    );
    fireEvent.click(screen.getByText('←'));
    await waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
    expect(onBack).not.toHaveBeenCalled();
  });

  it('fromHistory=false with <2 messages → straight back (onBack), no review', async () => {
    const onBack = vi.fn();
    const onEnd = vi.fn();
    render(
      <ChatView
        contact={contact}
        messages={mkMessages(1)}
        setMessages={noop}
        apiKey="key"
        userAvatar={null}
        onBack={onBack}
        onEnd={onEnd}
        onShowHistory={noop}
        fromHistory={false}
      />,
    );
    fireEvent.click(screen.getByText('←'));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    expect(onEnd).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------- Bug B: EndReview lists
describe('EndReview list readability (Bug B)', () => {
  const review = {
    score: 82,
    summary: 'Nice chatting with you today!',
    summaryZh: '今天聊得不错！',
    mistakes: [
      {
        original: 'I goes to school',
        corrected: 'I go to school',
        reason: 'Subject-verb agreement',
        reasonZh: '主谓一致',
      },
    ],
    newWords: ['vocabulary'],
    suggestions: ['Try using more linking words'],
    expressions: ['Nice to meet you'],
    feedback: 'Keep practicing!',
  };

  it('uses divide-y divide-[#1c2a3a] on all three list sections', () => {
    render(
      <EndReview
        contact={contact}
        review={review}
        onBack={noop}
        onContinue={noop}
        onBackToList={noop}
      />,
    );
    const dividers = [...document.querySelectorAll('*')].filter(
      (el) =>
        typeof el.className === 'string' &&
        el.className.includes('divide-y') &&
        el.className.includes('divide-[#1c2a3a]'),
    );
    expect(dividers.length).toBe(3);
    dividers.forEach((el) => expect(el.className).not.toContain('space-y-2'));
  });

  it('keeps original/corrected/play/reason content for mistakes', () => {
    render(
      <EndReview
        contact={contact}
        review={review}
        onBack={noop}
        onContinue={noop}
        onBackToList={noop}
      />,
    );
    expect(screen.getByText('I goes to school')).toBeInTheDocument();
    expect(screen.getByText('I go to school')).toBeInTheDocument();
    expect(screen.getByLabelText('Play corrected sentence')).toBeInTheDocument();
    expect(screen.getByText('Subject-verb agreement')).toBeInTheDocument();
  });

  it('expands Chinese reason via the 中文 toggle', async () => {
    render(
      <EndReview
        contact={contact}
        review={review}
        onBack={noop}
        onContinue={noop}
        onBackToList={noop}
      />,
    );
    expect(screen.queryByText('主谓一致')).not.toBeInTheDocument();
    // Scope to the mistakes list so we click the mistake's 中文 toggle, not the
    // Summary section's (both share the same label text).
    const mistakesContainer = [...document.querySelectorAll('*')]
      .filter(
        (el) =>
          typeof el.className === 'string' &&
          el.className.includes('divide-y') &&
          el.className.includes('divide-[#1c2a3a]'),
      )
      .find((c) => c.textContent.includes('I goes to school'));
    fireEvent.click(within(mistakesContainer).getByText('🇨🇳 中文'));
    expect(await screen.findByText('主谓一致')).toBeInTheDocument();
  });

  it('renders suggestions, expressions and newWords unchanged', () => {
    render(
      <EndReview
        contact={contact}
        review={review}
        onBack={noop}
        onContinue={noop}
        onBackToList={noop}
      />,
    );
    expect(screen.getByText('Try using more linking words')).toBeInTheDocument();
    expect(screen.getByText('"Nice to meet you"')).toBeInTheDocument();
    expect(screen.getByText('vocabulary')).toBeInTheDocument();
  });
});
