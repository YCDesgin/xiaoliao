import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';

// EndReview calls stopSpeaking() on unmount; stub the speech service so the
// test never depends on the Web Speech API (unavailable in jsdom).
vi.mock('../services/speech', () => ({
  speakText: vi.fn(),
  stopSpeaking: vi.fn(),
}));

import EndReview from './EndReview';
import { BRAND_BADGE_CLASS } from './SettingsModal.test';

const contact = {
  id: 'c1',
  name: 'Emma',
  avatar: 'https://example.com/emma.png',
  voice: 'en-US',
};

const review = { score: 82, summary: 'Nice chatting with you today!' };

const noop = () => {};

describe('EndReview — 🦐 虾聊 brand badge in header', () => {
  it('keeps the "Chat with {name}" title unchanged', () => {
    render(
      <EndReview
        contact={contact}
        review={review}
        onBack={noop}
        onContinue={noop}
        onBackToList={noop}
      />,
    );
    expect(screen.getByText('Chat with Emma')).toBeInTheDocument();
  });

  it('renders the 🦐 虾聊 brand badge in the header', () => {
    render(
      <EndReview
        contact={contact}
        review={review}
        onBack={noop}
        onContinue={noop}
        onBackToList={noop}
      />,
    );
    expect(screen.getByText('🦐 虾聊')).toBeInTheDocument();
  });

  it('uses the exact brand badge core class string (identical to Settings badge)', () => {
    render(
      <EndReview
        contact={contact}
        review={review}
        onBack={noop}
        onContinue={noop}
        onBackToList={noop}
      />,
    );
    const badge = screen.getByText('🦐 虾聊');
    BRAND_BADGE_CLASS.split(' ').forEach((token) => {
      expect(badge.className).toContain(token);
    });
  });
});
