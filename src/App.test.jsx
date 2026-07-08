import { render, screen, act } from '@testing-library/react';
import { vi } from 'vitest';

// Isolate the splash-screen logic: the four view components are heavy (they
// touch Web Speech API, fetch, localStorage) and are irrelevant to the splash
// overlay we are verifying. Mocking them keeps the test focused and stable.
vi.mock('./components/ContactList', () => ({ default: vi.fn(() => null) }));
vi.mock('./components/ChatView', () => ({ default: vi.fn(() => null) }));
vi.mock('./components/EndReview', () => ({ default: vi.fn(() => null) }));
vi.mock('./components/HistoryList', () => ({ default: vi.fn(() => null) }));

import App from './App';

// The splash slogan is unique to the splash overlay, so it is a reliable
// marker for "is the splash currently mounted?".
const SLOGAN = '说错也没关系，虾聊陪你练';

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('App — splash screen lifecycle', () => {
  it('shows the splash overlay immediately on mount', () => {
    render(<App />);
    expect(screen.getByText(SLOGAN)).toBeInTheDocument();
  });

  it('splash is still present at 1000ms (not yet unmounted)', () => {
    render(<App />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(SLOGAN)).toBeInTheDocument();
  });

  it('splash is unmounted at 1500ms', () => {
    render(<App />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText(SLOGAN)).not.toBeInTheDocument();
  });

  it('clears both timers on unmount (no timer leak)', () => {
    const { unmount } = render(<App />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    unmount();
    // After unmount the cleanup function must have cleared the pending timers.
    expect(vi.getTimerCount()).toBe(0);
  });
});
