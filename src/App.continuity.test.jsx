import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, waitFor, cleanup } from '@testing-library/react';

/**
 * Regression tests for the "same-device session continuity" fix.
 *
 * Strategy: mock the four heavy view components so we can render the REAL
 * <App/> logic (openChat / backToContacts / mount-restore / review-fallback)
 * without pulling in Web Speech API, fetch, etc. The mocked components just
 * capture their latest props, letting us assert App's internal state. We also
 * mock ./services/audioStore so binary persistence is fully controlled.
 */

// Shared capture objects, hoisted so the mock factories can reference them.
const captured = vi.hoisted(() => ({
  contactList: {},
  chatView: {},
  endReview: {},
  historyList: {},
}));

vi.mock('./components/ContactList', () => ({
  default: vi.fn((props) => { Object.assign(captured.contactList, props); return null; }),
}));
vi.mock('./components/ChatView', () => ({
  default: vi.fn((props) => { Object.assign(captured.chatView, props); return null; }),
}));
vi.mock('./components/EndReview', () => ({
  default: vi.fn((props) => { Object.assign(captured.endReview, props); return null; }),
}));
vi.mock('./components/HistoryList', () => ({
  default: vi.fn((props) => { Object.assign(captured.historyList, props); return null; }),
}));

// Controlled audio store spies.
const audioStore = vi.hoisted(() => ({
  saveAudio: vi.fn(() => Promise.resolve()),
  loadAudio: vi.fn(() => Promise.resolve(null)),
  deleteAudio: vi.fn(() => Promise.resolve()),
}));

vi.mock('./services/audioStore', () => ({
  saveAudio: (...a) => audioStore.saveAudio(...a),
  loadAudio: (...a) => audioStore.loadAudio(...a),
  deleteAudio: (...a) => audioStore.deleteAudio(...a),
}));

import App, { rememberView, loadMessages, saveMessages, clearMessages } from './App';

beforeEach(() => {
  localStorage.clear();
  for (const key of ['contactList', 'chatView', 'endReview', 'historyList']) {
    for (const p of Object.keys(captured[key])) delete captured[key][p];
  }
  audioStore.saveAudio.mockReset().mockImplementation(() => Promise.resolve());
  audioStore.loadAudio.mockReset().mockImplementation(() => Promise.resolve(null));
  audioStore.deleteAudio.mockReset().mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  cleanup(); // unmount => clears the splash timers, avoids post-test act warnings
});

// ---------------------------------------------------------------------------
// rememberView — the low-level persistence helper
// ---------------------------------------------------------------------------
describe('rememberView — persists last view & contact', () => {
  it('writes both keys for a contact view', () => {
    rememberView('chat', 'alex');
    expect(localStorage.getItem('speakup_last_view')).toBe('chat');
    expect(localStorage.getItem('speakup_last_contact')).toBe('alex');
  });

  it('removes the contact key when contactId is null', () => {
    rememberView('chat', 'alex');
    rememberView('contacts', null);
    expect(localStorage.getItem('speakup_last_view')).toBe('contacts');
    expect(localStorage.getItem('speakup_last_contact')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// View memory wired through the real component (openChat / backToContacts)
// ---------------------------------------------------------------------------
describe('App — view memory via real wiring', () => {
  it('openChat remembers chat view + contact and renders ChatView', async () => {
    render(<App />);
    const openChat = captured.contactList.onOpenChat;
    expect(typeof openChat).toBe('function');

    await act(async () => { openChat('alex'); });

    // rememberView('chat', 'alex') ran synchronously inside openChat.
    expect(localStorage.getItem('speakup_last_view')).toBe('chat');
    expect(localStorage.getItem('speakup_last_contact')).toBe('alex');
    // The view actually switched to chat with the right contact.
    expect(captured.chatView.contact?.id).toBe('alex');
  });

  it('backToContacts remembers contacts view and clears the contact key', async () => {
    localStorage.setItem('speakup_last_view', 'chat');
    localStorage.setItem('speakup_last_contact', 'alex');
    render(<App />);

    const onBack = captured.chatView.onBack;
    expect(typeof onBack).toBe('function');

    await act(async () => { onBack(); });

    expect(localStorage.getItem('speakup_last_view')).toBe('contacts');
    expect(localStorage.getItem('speakup_last_contact')).toBeNull();
    // ContactList should now be the active view.
    expect(captured.contactList.onOpenChat).toBeTypeOf('function');
  });
});

// ---------------------------------------------------------------------------
// Message + audio restore on (re)mount
// ---------------------------------------------------------------------------
describe('App — restores conversation on mount', () => {
  it('loads previously saved messages back into ChatView', async () => {
    const stored = [{
      id: 'm1', role: 'user', text: 'Hello Alex', type: 'text',
      timestamp: new Date().toISOString(),
    }];
    localStorage.setItem('speakup_last_view', 'chat');
    localStorage.setItem('speakup_last_contact', 'alex');
    localStorage.setItem('speakup_msgs_alex', JSON.stringify(stored));

    render(<App />);

    await waitFor(() => {
      expect(captured.chatView.messages).toBeDefined();
      expect(captured.chatView.messages.some((m) => m.text === 'Hello Alex')).toBe(true);
    });
  });

  it('rehydrates audioBlob from the audio store after restore', async () => {
    const audioBlob = new Blob(['fake-audio-bytes'], { type: 'audio/webm' });
    audioStore.loadAudio.mockImplementation((id) => Promise.resolve(id === 'm1' ? audioBlob : null));

    const stored = [{
      id: 'm1', role: 'user', text: 'Voice msg', type: 'voice',
      timestamp: new Date().toISOString(),
    }];
    localStorage.setItem('speakup_last_view', 'chat');
    localStorage.setItem('speakup_last_contact', 'alex');
    localStorage.setItem('speakup_msgs_alex', JSON.stringify(stored));

    render(<App />);

    await waitFor(() => {
      const m = (captured.chatView.messages || []).find((x) => x.id === 'm1');
      expect(m).toBeDefined();
      expect(m.audioBlob).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// loadMessages / saveMessages / clearMessages units
// ---------------------------------------------------------------------------
describe('conversation persistence helpers', () => {
  it('loadMessages rehydrates audioBlob per message', async () => {
    const audioBlob = new Blob(['x'], { type: 'audio/webm' });
    audioStore.loadAudio.mockImplementation((id) => Promise.resolve(id === 'm1' ? audioBlob : null));

    const stored = [{
      id: 'm1', role: 'user', text: 'v', type: 'voice',
      timestamp: new Date().toISOString(),
    }];
    localStorage.setItem('speakup_msgs_alex', JSON.stringify(stored));

    const result = await loadMessages('alex');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('v');
    expect(result[0].audioBlob).toBe(audioBlob);
  });

  it('saveMessages stores a slim record (no audioBlob) and fires saveAudio for blobs', () => {
    const blob = new Blob(['a'], { type: 'audio/webm' });
    const msgs = [{
      id: 'm1', role: 'user', text: 'hi', type: 'voice', audioBlob: blob, timestamp: new Date(),
    }];

    saveMessages('alex', msgs);

    const stored = JSON.parse(localStorage.getItem('speakup_msgs_alex'));
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe('hi');
    expect(stored[0].audioBlob).toBeUndefined(); // slim — binary stays in IndexedDB
    expect(audioStore.saveAudio).toHaveBeenCalledWith('m1', blob);
  });

  it('clearMessages purges audio blobs and removes the localStorage key', () => {
    const ids = ['m1', 'm2'];
    const stored = ids.map((id, i) => ({
      id, role: 'user', text: `t${i}`, type: 'voice', timestamp: new Date().toISOString(),
    }));
    localStorage.setItem('speakup_msgs_alex', JSON.stringify(stored));

    clearMessages('alex');

    expect(audioStore.deleteAudio).toHaveBeenCalledWith('m1');
    expect(audioStore.deleteAudio).toHaveBeenCalledWith('m2');
    expect(localStorage.getItem('speakup_msgs_alex')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Defensive: restored 'review' view without reviewData must not blank-screen
// ---------------------------------------------------------------------------
describe('App — review-view defensive fallback', () => {
  it('falls back to contacts when last view was review but no reviewData exists', async () => {
    localStorage.setItem('speakup_last_view', 'review');
    localStorage.setItem('speakup_last_contact', 'alex');
    render(<App />);

    // The mount effect must reset the view to 'contacts' (no EndReview render).
    await waitFor(() => {
      expect(captured.contactList.onOpenChat).toBeTypeOf('function');
    });
    // EndReview must NOT be mounted (would be a blank screen).
    expect(captured.endReview.onBack).toBeUndefined();
  });
});
