import { useState, useCallback, useEffect } from 'react';
import ContactList from './components/ContactList';
import ChatView from './components/ChatView';
import EndReview from './components/EndReview';
import HistoryList from './components/HistoryList';
import { getContact } from './data/contacts';
import { getReviews } from './services/reviewStore';
import { saveAudio, loadAudio, deleteAudio } from './services/audioStore';

// Persist the "where the user was" so a refresh drops them back in.
const LAST_VIEW_KEY = 'speakup_last_view';
const LAST_CONTACT_KEY = 'speakup_last_contact';

/**
 * Persist which view / contact the user last stayed on.
 * Audio blobs themselves are stored separately (IndexedDB), this only records
 * the navigation state in localStorage so it can be restored on reload.
 * @param {'contacts'|'chat'|'review'} view
 * @param {string|null} contactId
 */
export function rememberView(view, contactId) {
  try {
    localStorage.setItem(LAST_VIEW_KEY, view);
    if (contactId) {
      localStorage.setItem(LAST_CONTACT_KEY, contactId);
    } else {
      localStorage.removeItem(LAST_CONTACT_KEY);
    }
  } catch {
    // ignore storage failures (e.g. private mode)
  }
}

// Load messages from localStorage. Audio blobs live in IndexedDB (localStorage
// can't hold binary), so after restoring the text we rehydrate each message's
// audioBlob by its id. Returns a fully-populated array (audioBlob may be null).
export async function loadMessages(contactId) {
  try {
    const raw = localStorage.getItem(`speakup_msgs_${contactId}`);
    if (!raw) return [];
    const msgs = JSON.parse(raw);
    const restored = msgs.map(m => ({ ...m, timestamp: new Date(m.timestamp) }));
    await Promise.all(restored.map(async (m) => {
      try {
        m.audioBlob = await loadAudio(m.id);
      } catch {
        m.audioBlob = null;
      }
    }));
    return restored;
  } catch {
    return [];
  }
}

export function saveMessages(contactId, msgs) {
  const slim = msgs.map(m => ({
    id: m.id,
    role: m.role,
    text: m.text,
    type: m.type || undefined,
    imageUrl: m.imageUrl || undefined,
    query: m.query || undefined,
    timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
    isError: m.isError || undefined,
  }));
  localStorage.setItem(`speakup_msgs_${contactId}`, JSON.stringify(slim));
  // Persist audio blobs to IndexedDB (fire-and-forget, never blocks the text save).
  for (const m of msgs) {
    if (m.audioBlob && m.audioBlob instanceof Blob) {
      saveAudio(m.id, m.audioBlob).catch(() => {});
    }
  }
}

export function clearMessages(contactId) {
  // Best-effort: also purge any audio blobs we stored for these messages.
  try {
    const raw = localStorage.getItem(`speakup_msgs_${contactId}`);
    if (raw) {
      const msgs = JSON.parse(raw);
      for (const m of msgs) {
        if (m && m.id) deleteAudio(m.id).catch(() => {});
      }
    }
  } catch {
    // ignore parse errors
  }
  localStorage.removeItem(`speakup_msgs_${contactId}`);
}

export default function App() {
  // Restore the last view & contact so a refresh returns to where the user was.
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem(LAST_VIEW_KEY) || 'contacts';
    } catch {
      return 'contacts';
    }
  });
  const [currentContactId, setCurrentContactId] = useState(() => {
    try {
      return localStorage.getItem(LAST_CONTACT_KEY) || null;
    } catch {
      return null;
    }
  });
  const [messages, setMessages] = useState([]);
  const [reviewData, setReviewData] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyContactId, setHistoryContactId] = useState(null);
  const [historyReviews, setHistoryReviews] = useState([]);
  const [reviewMeta, setReviewMeta] = useState(null);
  const [chatFromHistory, setChatFromHistory] = useState(false);

  // Splash screen: first-impression brand loading overlay (pure visual, no logic change)
  const [splash, setSplash] = useState(true);
  const [splashFade, setSplashFade] = useState(false);

  const [apiKey, setApiKey] = useState(() => {
    return localStorage.getItem('speakup_gemini_key') || '';
  });

  const saveApiKey = useCallback((key) => {
    setApiKey(key);
    localStorage.setItem('speakup_gemini_key', key);
  }, []);

  // User avatar: stored as base64 in localStorage, null = use default Garfield cat
  const [userAvatar, setUserAvatar] = useState(() => {
    return localStorage.getItem('speakup_avatar') || null;
  });

  const saveUserAvatar = useCallback((dataUrl) => {
    setUserAvatar(dataUrl);
    if (dataUrl) {
      localStorage.setItem('speakup_avatar', dataUrl);
    } else {
      localStorage.removeItem('speakup_avatar');
    }
  }, []);

  const contact = currentContactId ? getContact(currentContactId) : null;

  // On first mount, restore the conversation for the last-opened contact (if any)
  // so a refresh while in a chat drops the user straight back into it. The text
  // restore is async (audio blobs come from IndexedDB); the splash screen covers
  // this work. We do NOT touch the auto-save effect below because at mount
  // `messages` is empty, so it won't overwrite anything.
  useEffect(() => {
    if (currentContactId) {
      loadMessages(currentContactId).then(setMessages).catch(() => setMessages([]));
    }
    // Defensive: a restored 'review' view needs ephemeral reviewData we cannot
    // reconstruct after a reload, so fall back to a view that can actually render.
    if (localStorage.getItem(LAST_VIEW_KEY) === 'review' && !reviewData) {
      setView('contacts');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save messages when they change
  useEffect(() => {
    if (currentContactId && messages.length > 0) {
      saveMessages(currentContactId, messages);
    }
  }, [messages, currentContactId]);

  // Splash screen: fade out (~1.1s) then unmount (~1.5s)
  useEffect(() => {
    const fadeTimer = setTimeout(() => setSplashFade(true), 1100);
    const unmountTimer = setTimeout(() => setSplash(false), 1500);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(unmountTimer);
    };
  }, []);

  const openChat = useCallback((contactId) => {
    setCurrentContactId(contactId);
    setMessages([]);
    loadMessages(contactId).then(setMessages).catch(() => setMessages([]));
    setReviewData(null);
    setReviewMeta(null);
    setChatFromHistory(false);
    setView('chat');
    rememberView('chat', contactId);
  }, []);

  const endChat = useCallback((review) => {
    setReviewData(review);
    setReviewMeta(null);
    setView('review');
    // Keep the current contact so re-entering chat restores its history.
    rememberView('review', localStorage.getItem(LAST_CONTACT_KEY));
  }, []);

  const backToContacts = useCallback(() => {
    setView('contacts');
    setCurrentContactId(null);
    rememberView('contacts', null);
  }, []);

  const openHistory = useCallback((contactId) => {
    setHistoryContactId(contactId);
    setHistoryReviews(getReviews(contactId));
    setShowHistory(true);
  }, []);
  const viewHistoryReview = useCallback((entry) => {
    setReviewData(entry.review);
    setReviewMeta(entry);
    setShowHistory(false);
    setView('review');
    rememberView('review', localStorage.getItem(LAST_CONTACT_KEY));
  }, []);
  const backToHistoryList = useCallback(() => {
    setShowHistory(true);
  }, []);
  const closeHistory = useCallback(() => {
    setShowHistory(false);
  }, []);

  return (
    <div className="h-full max-w-[430px] mx-auto bg-[#0e1621] flex flex-col overflow-hidden relative shadow-2xl">
      {view === 'contacts' && (
        <ContactList
          apiKey={apiKey}
          userAvatar={userAvatar}
          onSaveApiKey={saveApiKey}
          onSaveAvatar={saveUserAvatar}
          onOpenChat={openChat}
        />
      )}
      {view === 'chat' && contact && (
        <ChatView
          contact={contact}
          messages={messages}
          setMessages={setMessages}
          apiKey={apiKey}
          userAvatar={userAvatar}
          onBack={backToContacts}
          onEnd={endChat}
          onShowHistory={() => openHistory(contact.id)}
          fromHistory={chatFromHistory}
        />
      )}
      {view === 'review' && contact && reviewData && (
        <EndReview
          contact={contact}
          review={reviewData}
          meta={reviewMeta}
          onBack={backToContacts}
          onBackToList={backToHistoryList}
          onContinue={() => {
            setChatFromHistory(true);
            setView('chat');
            setReviewData(null);
            setReviewMeta(null);
          }}
        />
      )}
      {showHistory && historyContactId && (
        <HistoryList
          contactName={getContact(historyContactId)?.name || ''}
          reviews={historyReviews}
          onSelect={viewHistoryReview}
          onClose={closeHistory}
        />
      )}

      {/* Splash screen overlay (pure visual brand enhancement, sits above all views) */}
      {splash && (
        <div className={`absolute inset-0 z-[60] bg-[#0e1621] flex flex-col items-center justify-center ${splashFade ? 'splash-out' : 'fade-in'}`}>
          <div className="text-6xl splash-bob">🦐</div>
          <div className="mt-4 text-lg font-semibold text-[#f5f5f5]">虾聊</div>
          <div className="mt-1 text-[11px] text-[#5a6066]">说错也没关系，虾聊陪你练</div>
          <div className="mt-6 flex items-end gap-1 h-6">
            <span className="wave-bar" style={{ animationDelay: '0ms' }} />
            <span className="wave-bar" style={{ animationDelay: '150ms' }} />
            <span className="wave-bar" style={{ animationDelay: '300ms' }} />
            <span className="wave-bar" style={{ animationDelay: '450ms' }} />
          </div>
        </div>
      )}
    </div>
  );
}
