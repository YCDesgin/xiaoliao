import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// 屏蔽 Web Speech API（jsdom 无），并给 WordDefBubble 的 speakWord 一个桩。
vi.mock('../services/speech', () => ({
  speakText: vi.fn(),
  stopSpeaking: vi.fn(),
  speakWord: vi.fn(),
}));

import EndReview from './EndReview';

const contact = { id: 'c1', name: 'Emma', avatar: 'https://example.com/emma.png', voice: 'en-US' };
const baseReview = (mistakes) => ({ score: 80, summary: 'ok', mistakes });
const noop = () => {};

describe('EndReview — 点词释义 (T05)', () => {
  const review = baseReview([
    {
      original: 'I goes school',
      corrected: 'I go to school',
      reason: 'r',
      reasonZh: 'z',
      wordDefs: [{ word: 'school', zh: '学校' }],
    },
  ]);

  it('renders each word in corrected as a clickable element', () => {
    render(<EndReview contact={contact} review={review} onBack={noop} onContinue={noop} onBackToList={noop} />);
    expect(screen.getByRole('button', { name: 'school' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'go' })).toBeInTheDocument();
  });

  it('clicking a word with a definition opens the bubble showing 中文 (B02)', () => {
    render(<EndReview contact={contact} review={review} onBack={noop} onContinue={noop} onBackToList={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'school' }));
    expect(screen.getByText('学校')).toBeInTheDocument();
  });

  it('clicking a word without a definition degrades to 暂无释义 (B02 降级)', () => {
    render(<EndReview contact={contact} review={review} onBack={noop} onContinue={noop} onBackToList={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(screen.getByText('暂无释义')).toBeInTheDocument();
  });

  it('old review missing wordDefs does not crash and degrades gracefully', () => {
    const oldReview = baseReview([{ original: 'x', corrected: 'y', reason: 'r' }]);
    render(<EndReview contact={contact} review={oldReview} onBack={noop} onContinue={noop} onBackToList={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'y' }));
    expect(screen.getByText('暂无释义')).toBeInTheDocument();
  });
});
