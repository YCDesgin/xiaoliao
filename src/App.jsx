import { useState, useCallback, useEffect } from 'react';
import ContactList from './components/ContactList';
import ChatView from './components/ChatView';
import EndReview from './components/EndReview';
import HistoryList from './components/HistoryList';
import { getContact } from './data/contacts';
import { getReviews } from './services/reviewStore';

// Persist messages to localStorage (text only, audio blobs can't be serialized)
function loadMessages(contactId) {
  try {
    const raw = localStorage.getItem(`speakup_msgs_${contactId}`);
    if (!raw) return [];
    const msgs = JSON.parse(raw);
    // Restore Date objects
    return msgs.map(m => ({ ...m, timestamp: new Date(m.timestamp) }));
  } catch {
    return [];
  }
}

function saveMessages(contactId, msgs) {
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
}

function clearMessages(contactId) {
  localStorage.removeItem(`speakup_msgs_${contactId}`);
}

export default function App() {
  const [view, setView] = useState('contacts');
  const [currentContactId, setCurrentContactId] = useState(null);
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
    const existing = loadMessages(contactId);
    setMessages(existing);
    setReviewData(null);
    setReviewMeta(null);
    setChatFromHistory(false);
    setView('chat');
  }, []);

  const endChat = useCallback((review) => {
    setReviewData(review);
    setReviewMeta(null);
    setView('review');
  }, []);

  const backToContacts = useCallback(() => {
    setView('contacts');
    setCurrentContactId(null);
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
