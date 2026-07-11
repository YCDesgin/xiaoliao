import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import VoiceBubble from './VoiceBubble';
import MessageInput from './MessageInput';
import { chatWithAI, reviewConversation } from '../services/gemini';
import { speakText, stopSpeaking, SPEED_PRESETS } from '../services/speech';
import { DIFFICULTY_PRESETS, getContactDifficulty, setContactDifficulty } from '../data/contacts';
import { getEffectiveVoice, ALIYUN_VOICE_OPTIONS, setContactVoiceOverride } from '../data/voices';
import { fingerprintOf, findCached, saveReview, clearReviews, normalizeReview } from '../services/reviewStore';
import { searchImage, cleanQuery } from '../services/imageService';

function getContactSpeed(cId) { return parseFloat(localStorage.getItem(`speakup_speed_${cId}`) || '0.75'); }
function setContactSpeed(cId, v) { localStorage.setItem(`speakup_speed_${cId}`, v.toString()); }

/**
 * Detect whether a user message is asking for a visual explanation of a noun
 * ("我不明白 apple", "I don't understand the word strawberry", ...).
 * Returns the cleaned search term, or null when no trigger is found.
 *
 * Triggers are matched (case-insensitive) against a list of Chinese / English
 * phrases; whatever follows the trigger is treated as the query.
 */
const IMAGE_TRIGGERS = [
  /我不明白(.+)/i,
  /我不懂(.+)/i,
  /没听懂(.+)/i,
  /不明白(.+)/i,
  /不懂(.+)/i,
  /不知道(.+?)是什么意思/i,
  /不知道(.+?)意思/i,
  /what does (.+?) mean/i,
  /not sure what (.+?) (?:is|means)/i,
  /what is (.+)/i,
  /i don'?t get (.+)/i,
  /don'?t understand (.+)/i,
  /do not understand (.+)/i,
];

function detectImageQuery(text) {
  if (!text) return null;
  for (const re of IMAGE_TRIGGERS) {
    const m = text.match(re);
    if (m) {
      const q = cleanQuery(m[1] || '');
      if (q) return q;
    }
  }
  return null;
}

export default function ChatView({ contact, messages, setMessages, apiKey, userAvatar, onBack, onEnd, onShowHistory, fromHistory }) {
  const [loading, setLoading] = useState(false);
  const [playingId, setPlayingId] = useState(null);
  const [chatSpeed, setChatSpeed] = useState(() => getContactSpeed(contact.id));
  const [showSettings, setShowSettings] = useState(false);
  const [difficulty, setDifficulty] = useState(() => getContactDifficulty(contact.id));
  const [generating, setGenerating] = useState(false);
  const [voiceTick, setVoiceTick] = useState(0);
  const chatEndRef = useRef(null);
  const initializedRef = useRef(false);

  const systemPrompt = useMemo(() => {
    const diff = DIFFICULTY_PRESETS.find(d => d.id === difficulty);
    return `${contact.basePrompt}\n\n${diff?.rules || ''}`;
  }, [contact.basePrompt, difficulty]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  useEffect(() => {
    if (!initializedRef.current && messages.length === 0 && contact.openingLine) {
      initializedRef.current = true;
      const opening = { id: Date.now().toString(), role: 'them', text: contact.openingLine, timestamp: new Date() };
      setMessages([opening]);
      const t = setTimeout(() => {
        setPlayingId(opening.id);
        speakText(opening.text, { voice: getEffectiveVoice(contact), rate: chatSpeed, mode: 'edgetts' }).finally(() => setPlayingId(null));
      }, 500);
      return () => clearTimeout(t);
    }
  }, []);

  // Append an AI image bubble (triggered automatically by detectImageQuery).
  // Image search is async and never blocks the AI text reply.
  const appendImageMessage = useCallback((url, query) => {
    if (!url) return;
    const imgMsg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      role: 'ai',
      type: 'image',
      imageUrl: url,
      query: query,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, imgMsg]);
  }, [setMessages]);

  const sendMessage = useCallback(async (text, audioBlob) => {
    if (!text.trim() || loading) return;
    const userMsg = { id: Date.now().toString(), role: 'user', text: text.trim(), audioBlob: audioBlob || null, timestamp: new Date() };
    setMessages(p => [...p, userMsg]);

    // Auto image search: if the user says they don't understand a noun,
    // silently fetch a real photo and append it as an image bubble.
    const q = detectImageQuery(text);
    if (q) {
      searchImage(q)
        .then((url) => { if (url) appendImageMessage(url, q); })
        .catch(() => {});
    }

    setLoading(true);
    try {
      // Image bubbles carry no text and must not be sent to the AI.
      const allMessages = [...messages, userMsg]
        .filter(m => m.type !== 'image')
        .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text }));
      const reply = await chatWithAI(apiKey, systemPrompt, allMessages);
      const aiMsg = { id: (Date.now() + 1).toString(), role: 'them', text: reply, timestamp: new Date() };
      setMessages(p => [...p, aiMsg]);
      setPlayingId(aiMsg.id);
      speakText(reply, { voice: getEffectiveVoice(contact), rate: chatSpeed, mode: 'edgetts' }).finally(() => setPlayingId(null));
    } catch (err) {
      setMessages(p => [...p, { id: (Date.now() + 1).toString(), role: 'them', text: `[Error: ${err.message}]`, timestamp: new Date(), isError: true }]);
    } finally { setLoading(false); }
  }, [messages, apiKey, systemPrompt, loading, setMessages, contact, chatSpeed, appendImageMessage]);

  // Build a structured review object, mapping the raw AI result into a
  // guaranteed shape (with sensible defaults) so the review page never breaks.
  const generateReview = useCallback(async () => {
    // Image bubbles carry no text and must not participate in the review.
    const textMessages = messages.filter(m => m.type !== 'image' && m.text);
    const turns = textMessages.length;
    if (turns < 2) {
      return {
        turns,
        summary: 'Nice start! Try a longer chat next time for a fuller review.',
        summaryZh: '',
        score: 0,
        mistakes: [],
        newWords: [],
        suggestions: [],
        expressions: [],
        feedback: 'Give it a go — every chat helps!',
      };
    }
    let review = null;
    try {
      review = await reviewConversation(
        apiKey,
        systemPrompt,
        textMessages.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text }))
      );
    } catch {
      /* fall back to defaults below */
    }
    if (!review) {
      return {
        turns,
        summary: 'Nice chatting with you today!',
        summaryZh: '',
        score: 0,
        mistakes: [],
        newWords: [],
        suggestions: [],
        expressions: ['having a nice chat'],
        feedback: 'Keep practicing and you\'ll keep improving!',
      };
    }
    return {
      turns,
      summary: review.summary || 'Nice chatting with you today!',
      summaryZh: review.summaryZh || '',
      score: typeof review.score === 'number' ? review.score : 0,
      // 透传 wordDefs（B01）：normalizeReview 保证每个 mistake 都有 wordDefs 数组
      mistakes: normalizeReview(review).mistakes,
      newWords: Array.isArray(review.newWords) ? review.newWords : [],
      suggestions: Array.isArray(review.suggestions) ? review.suggestions : [],
      expressions: Array.isArray(review.expressions) ? review.expressions : ['having a nice chat'],
      feedback: review.feedback || 'Keep practicing and you\'ll keep improving!',
    };
  }, [messages, apiKey, systemPrompt]);

  // buildReview: returns a cached review when the conversation fingerprint is
  // unchanged, otherwise regenerates via generateReview() and persists it as a
  // new history entry. Keeps the same fallback guarantees as generateReview().
  const buildReview = useCallback(async () => {
    const fp = fingerprintOf(messages);
    const cached = findCached(contact.id, fp);
    if (cached) return cached.review;            // 缓存命中，不调接口
    const review = await generateReview();        // 仍含 turns<2 / API 失败兜底
    saveReview(contact.id, review, fp);           // 存为新历史
    return review;
  }, [messages, contact.id, generateReview]);

  // Manual review (End or 复盘 button): generate then navigate to review page.
  const handleEnd = useCallback(async () => {
    stopSpeaking(); setPlayingId(null);
    if (generating) return;
    setGenerating(true);
    try {
      const review = await buildReview();
      onEnd(review);
    } finally {
      setGenerating(false);
    }
  }, [generating, buildReview, onEnd]);

  // Back arrow: auto-review when there's a real conversation, else just go back.
  const handleBack = useCallback(async () => {
    stopSpeaking(); setPlayingId(null);
    if (generating) return;
    if (fromHistory) { onBack(); return; }
    if (messages.length >= 2) {
      setGenerating(true);
      try {
        const review = await buildReview();
        onEnd(review);
      } finally {
        setGenerating(false);
      }
    } else {
      onBack();
    }
  }, [generating, messages.length, buildReview, onEnd, onBack, fromHistory]);

  const pickSpeed = v => { setChatSpeed(v); setContactSpeed(contact.id, v); };
  const pickDifficulty = d => { setDifficulty(d); setContactDifficulty(contact.id, d); };

  const handlePlay = useCallback((msgId, text) => {
    if (playingId === msgId) { stopSpeaking(); setPlayingId(null); return; }
    stopSpeaking(); setPlayingId(msgId);
    speakText(text, { voice: getEffectiveVoice(contact), rate: chatSpeed, mode: 'edgetts' }).finally(() => setPlayingId(null));
  }, [playingId, contact, chatSpeed]);

  const formatDate = (d) => d?.toLocaleDateString([], { month: 'long', day: 'numeric' });

  return (
    <div className="relative h-full flex flex-col bg-[#0e1621]">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 bg-[#17212b] border-b border-[#1c2a3a]">
        <button onClick={handleBack}
          className="w-8 h-8 rounded-full hover:bg-[#1f2c3a] flex items-center justify-center text-[#aaaaaa] transition-colors text-lg">
          ←
        </button>
        <div className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0 bg-[#1f2c3a]">
          <img src={contact.avatar} alt={contact.name} className="w-full h-full object-cover" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-[#f5f5f5] truncate">{contact.name}</div>
          <div className="text-[11px] text-[#4caf50]">online</div>
        </div>

        <div className="relative">
          <button onClick={() => setShowSettings(!showSettings)}
            className="w-8 h-8 rounded-full hover:bg-[#1f2c3a] flex items-center justify-center text-[#aaaaaa] transition-colors">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
          </button>
          {showSettings && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowSettings(false)} />
              <div className="absolute right-0 top-10 z-50 w-48 bg-[#17212b] border border-[#1c2a3a] rounded-xl p-3 shadow-lg slide-up">
                <div className="text-[11px] text-[#707579] mb-1.5 font-medium">Difficulty</div>
                <div className="flex gap-1 mb-1.5">
                  {DIFFICULTY_PRESETS.map(p => (
                    <button key={p.id} onClick={() => pickDifficulty(p.id)}
                      className={`flex-1 py-1.5 text-[11px] rounded-lg transition-colors ${difficulty === p.id ? 'bg-[#2aabee] text-white' : 'bg-[#0e1621] text-[#707579] hover:bg-[#1f2c3a]'}`}>
                      {p.label}
                    </button>
                  ))}
                </div>
                {/* 难度切换即时反馈：显示当前难度的核心规则（不改变 systemPrompt 逻辑） */}
                <div className="text-[10px] text-[#5a6a7a] mb-3 px-0.5">
                  当前难度 · {DIFFICULTY_PRESETS.find(p => p.id === difficulty)?.summary || ''}
                </div>
                <div className="text-[11px] text-[#707579] mb-1.5 font-medium">Speed</div>
                <div className="flex gap-1 mb-3">
                  {SPEED_PRESETS.map(p => (
                    <button key={p.value} onClick={() => pickSpeed(p.value)}
                      className={`flex-1 py-1.5 text-[11px] rounded-lg transition-colors ${chatSpeed === p.value ? 'bg-[#2aabee] text-white' : 'bg-[#0e1621] text-[#707579] hover:bg-[#1f2c3a]'}`}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <div className="text-[11px] text-[#707579] mb-1.5 font-medium">Voice</div>
                <select
                  key={`voice-${voiceTick}`}
                  value={getEffectiveVoice(contact)}
                  onChange={(e) => { setContactVoiceOverride(contact.id, e.target.value); setVoiceTick(t => t + 1); }}
                  className="w-full bg-[#0e1621] border border-[#1c2a3a] rounded-xl px-2 py-1.5 text-[11px] text-[#f5f5f5] focus:outline-none focus:border-[#2aabee] transition-colors mb-3"
                >
                  {ALIYUN_VOICE_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <div className="pt-2 border-t border-[#1c2a3a]">
                  <button onClick={() => { if (confirm('Clear chat history?')) { localStorage.removeItem(`speakup_msgs_${contact.id}`); clearReviews(contact.id); setMessages([]); setShowSettings(false); }}}
                    className="w-full py-1.5 text-[11px] text-[#e74c3c] hover:bg-[#e74c3c]/10 rounded-lg transition-colors">
                    Clear history
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
        <button onClick={handleEnd} disabled={generating}
          className="text-[11px] text-[#aaaaaa] hover:text-[#e74c3c] transition-colors px-2 py-1 rounded-lg hover:bg-[#1f2c3a] disabled:opacity-50">End</button>
        <button onClick={handleEnd} disabled={generating}
          className="text-[11px] text-[#aaaaaa] hover:text-[#2aabee] transition-colors px-2 py-1 rounded-lg hover:bg-[#1f2c3a] disabled:opacity-50">复盘</button>
        <button onClick={() => onShowHistory && onShowHistory()} disabled={generating}
          className="text-[11px] text-[#aaaaaa] hover:text-[#2aabee] transition-colors px-2 py-1 rounded-lg hover:bg-[#1f2c3a] disabled:opacity-50">📜 历史</button>
      </div>

      {/* Generating review overlay */}
      {generating && (
        <div className="absolute inset-0 z-[60] flex flex-col items-center justify-center bg-[#0e1621]/70 backdrop-blur-sm">
          <div className="w-10 h-10 border-4 border-[#1c2a3a] border-t-[#2aabee] rounded-full animate-spin" />
          <div className="mt-3 text-xs text-[#707579]">Generating your review…</div>
        </div>
      )}

      {/* Chat */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="text-5xl mb-3">🦐</div>
            <div className="text-lg font-semibold text-[#f5f5f5]">虾聊</div>
            <div className="text-[12px] text-[#707579] mt-1.5">
              和 {contact.name} 开始今天的口语练习吧～
            </div>
          </div>
        )}
        {messages.length > 0 && (
          <div className="flex justify-center my-3">
            <span className="text-[11px] text-[#707579] bg-[#17212b] rounded-full px-3 py-1">
              {formatDate(messages[0].timestamp)}
            </span>
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={`flex items-end gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'} fade-in`}>
            {/* Avatar on the left for AI / image messages */}
            {msg.role !== 'user' && (
              <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0 bg-[#1f2c3a] mb-0.5">
                <img src={contact.avatar} alt={contact.name} className="w-full h-full object-cover" />
              </div>
            )}
            <VoiceBubble message={msg} isPlaying={playingId === msg.id} onPlay={() => handlePlay(msg.id, msg.text)} apiKey={apiKey} />
            {/* User avatar on the right */}
            {msg.role === 'user' && (
              <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0 bg-[#1f2c3a] mb-0.5">
                {userAvatar ? (
                  <img src={userAvatar} alt="You" className="w-full h-full object-cover" />
                ) : (
                  <svg viewBox="0 0 40 40" className="w-full h-full">
                    <rect width="40" height="40" rx="20" fill="#F4A460"/>
                    <ellipse cx="15" cy="18" rx="5" ry="6" fill="white"/><ellipse cx="25" cy="18" rx="5" ry="6" fill="white"/>
                    <circle cx="15" cy="18" r="2.5" fill="#333"/><circle cx="25" cy="18" r="2.5" fill="#333"/>
                    <ellipse cx="20" cy="24" rx="3" ry="2" fill="#FF8C69"/>
                    <path d="M18 25 Q20 29 22 25" stroke="#333" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
                    <path d="M5 10 L12 15 M35 10 L28 15" stroke="#F4A460" strokeWidth="3" fill="#F4A460"/>
                    <rect x="12" y="13" width="4" height="3" rx="1" fill="#F4A460"/>
                    <rect x="24" y="13" width="4" height="3" rx="1" fill="#F4A460"/>
                    <line x1="20" y1="22" x2="20" y2="30" stroke="#333" strokeWidth="1.5"/>
                  </svg>
                )}
              </div>
            )}
            {msg.role !== 'user' && <div className="w-7 h-7 flex-shrink-0" />}
          </div>
        ))}
        {loading && (
          <div className="flex items-end gap-2 justify-start">
            <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0 bg-[#1f2c3a] mb-0.5">
              <img src={contact.avatar} alt={contact.name} className="w-full h-full object-cover" />
            </div>
            <div className="bg-[#182533] rounded-xl rounded-bl-[3px] px-4 py-3">
              <div className="flex gap-0.5 h-5">
                {[...Array(5)].map((_, i) => <span key={i} className="wave-bar" style={{ animationDelay: `${i * 0.1}s` }} />)}
              </div>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      <MessageInput onSend={sendMessage} disabled={loading} />
    </div>
  );
}
