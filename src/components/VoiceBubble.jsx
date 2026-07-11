import { useState, useEffect } from 'react';
import { translateText } from '../services/gemini';
import { playAudioBlob } from '../services/speech';
import wordDefCache from '../services/wordDefCache';
import WordDefBubble from './WordDefBubble';

/**
 * 单条消息气泡：波形播放 + 展开英文文本（可点词）+ 翻译。
 *
 * 功能1（点词看音标）：英文单词可点击 → 命中缓存优先（AI 预生成 / 已查过）→
 * 未命中则 lazy 批量生成（wordDefCache.ensureDefs）→ 用 getBoundingClientRect
 * 取坐标弹 WordDefBubble（单词 + 音标 + 中文释义 + 🔊）。
 */
export default function VoiceBubble({ message, isPlaying, onPlay, apiKey, onWordDefs }) {
  const [showText, setShowText] = useState(false);
  // 点词弹层状态：{ word, zh, phonetic, x, y }（x/y 为触发元素视口坐标）
  const [bubble, setBubble] = useState(null);
  const [showTranslation, setShowTranslation] = useState(false);
  const [translatedText, setTranslatedText] = useState(null);
  const [translating, setTranslating] = useState(false);

  const isUser = message.role === 'user';
  const isError = message.isError;

  // --- Image bubble (auto image search result) -----------------------------
  // Short-circuit before any `message.text` access so we never crash on the
  // text-less image message. Renders left-aligned with the contact avatar
  // (handled by the parent ChatView) and a thumbnail bubble.
  if (message.type === 'image') {
    return (
      <div className="relative group" style={{ maxWidth: '85%' }}>
        <div className="bg-[#17212b] border border-[#1c2a3a] rounded-2xl p-2">
          {message.imageUrl ? (
            <img
              src={message.imageUrl}
              alt={message.query || 'image'}
              className="max-w-[220px] rounded-xl block cursor-pointer hover:opacity-90 transition-opacity"
              loading="lazy"
              onClick={() => window.open(message.imageUrl, '_blank')}
            />
          ) : null}
          {message.query ? (
            <div className="mt-1.5 text-[11px] text-[#707579] truncate">“{message.query}”</div>
          ) : null}
          <div className="text-right mt-0.5">
            <span className="text-[10px] text-[#5a6a7a]">
              {message.timestamp?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const wordCount = message.text.split(/\s+/).length;
  const fakeDuration = Math.max(2, Math.ceil(wordCount / 3)) + 's';

  // Dynamic width based on word count (like real voice messages)
  // 2 words → 35% | 10 words → ~55% | 20+ words → 75%
  const minW = 35, maxW = 75;
  const pct = isUser
    ? Math.min(maxW, Math.max(minW, minW + ((wordCount - 2) / 18) * (maxW - minW)))
    : null; // AI messages stay at full width for readability

  // 用消息已预生成的 wordDefs 预热内存缓存（AI 回复场景，离线可用）。
  useEffect(() => {
    if (message && message.id && message.metadata && Array.isArray(message.metadata.wordDefs)) {
      wordDefCache.primeFromMessage(message);
    }
  }, [message]);

  // 点词：读缓存 → 未命中 lazy 生成 → 弹 WordDefBubble（含音标 + 🔊）。
  const handleWordClick = async (word, e) => {
    // 再次点击同一词 → 关闭气泡
    if (bubble && bubble.word === word) { setBubble(null); return; }

    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top;

    // 1. 优先命中内存缓存（AI 预生成 / 已查过）。
    let def = wordDefCache.get(message.id, word);

    // 2. 未命中 → lazy 批量生成（用户消息），并把结果写回 metadata 持久化。
    if (!def) {
      try {
        const defs = await wordDefCache.ensureDefs(apiKey, message.id, message.text, word);
        def = defs.find(d => d.word.toLowerCase() === word.toLowerCase()) || null;
        if (defs.length && typeof onWordDefs === 'function') {
          onWordDefs(message.id, defs);
        }
      } catch {
        def = null;
      }
    }

    setBubble({
      word,
      zh: def?.zh || '',
      phonetic: def?.phonetic || '',
      x,
      y,
    });
  };

  const handleTranslationToggle = async () => {
    if (showTranslation) { setShowTranslation(false); return; }
    setShowTranslation(true);
    if (!translatedText) {
      setTranslating(true);
      const result = await translateText(apiKey, message.text);
      setTranslatedText(result || '(翻译失败)');
      setTranslating(false);
    }
  };

  return (
    <div
      className={`relative group ${isUser ? 'ml-auto' : ''}`}
      style={isUser ? { width: `${pct}%`, minWidth: '110px' } : { maxWidth: '85%' }}
    >
      <div
        className={`relative px-3 py-2 ${
          isUser
            ? 'bg-[#2b5278] rounded-xl rounded-br-[3px]'
            : isError
              ? 'bg-[#3a1a1a] rounded-xl rounded-bl-[3px] border border-[#e74c3c]/20'
              : 'bg-[#182533] rounded-xl rounded-bl-[3px]'
        }`}
      >
        {/* === L0: Voice waveform === */}
        <div
          className="flex items-center gap-2 cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            if (isUser && message.audioBlob) { playAudioBlob(message.audioBlob); }
            else { onPlay(); }
          }}
        >
          <div
            className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-xs transition-all ${
              isPlaying
                ? 'bg-[#2aabee] text-white'
                : isUser
                  ? 'bg-white/15 text-white'
                  : 'bg-white/10 text-[#aaaaaa] hover:bg-[#2aabee]/20 hover:text-[#2aabee]'
            }`}
          >
            {isPlaying ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                <rect x="1" y="1" width="3" height="8" rx="0.5" />
                <rect x="6" y="1" width="3" height="8" rx="0.5" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                <polygon points="2,1 9,5 2,9" />
              </svg>
            )}
          </div>

          {isPlaying ? (
            <div className="flex gap-0.5 items-center h-5">
              {[...Array(6)].map((_, i) => (
                <span key={i} className="wave-bar" style={{ animationDelay: `${i * 0.1}s` }} />
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-0.5 h-5 opacity-30">
              {[...Array(6)].map((_, i) => (
                <span key={i} className="inline-block bg-[#707579] rounded-sm"
                  style={{ width: '3px', height: `${3 + Math.sin(i * 0.7) * 5}px` }} />
              ))}
            </div>
          )}

          <span className="text-[10px] text-[#707579] flex-shrink-0 ml-auto">{fakeDuration}</span>
        </div>

        {/* Toggle text */}
        {!isError && (
          <button
            className="mt-1.5 w-full text-center text-[11px] text-[#2aabee] hover:text-[#3db9f5] transition-colors cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              setShowText(!showText);
              if (showText) { setBubble(null); setShowTranslation(false); }
            }}
          >
            {showText ? '▲ Hide text' : '▼ Show text'}
          </button>
        )}

        {/* === L1: English text === */}
        {showText && (
          <div
            className="mt-2 pt-2 border-t border-[#1c2a3a] text-[13px] leading-relaxed text-[#f5f5f5]"
            onClick={(e) => e.stopPropagation()}
          >
            {message.text.split(/(\s+)/).map((part, i) => {
              if (part.trim() === '') return <span key={i}>{part}</span>;
              const clean = part.replace(/[^a-zA-Z'-]/g, '');
              if (clean.length < 3) return <span key={i}>{part}</span>;
              return (
                <span key={i} className="cursor-pointer rounded px-0.5 hover:bg-[#2aabee]/15 transition-colors"
                  onClick={(e) => handleWordClick(clean, e)}>{part}</span>
              );
            })}

            {/* === L3: Translation === */}
            <div className="mt-2">
              <button onClick={handleTranslationToggle} disabled={translating}
                className="text-[11px] text-[#2aabee] hover:text-[#3db9f5] transition-colors disabled:opacity-50">
                {showTranslation ? 'Hide translation' : 'Translate to Chinese'}
              </button>
              {translating && <div className="mt-1 text-[11px] text-[#707579] italic fade-in">Translating...</div>}
              {showTranslation && translatedText && (
                <div className="mt-1.5 text-xs text-[#aaaaaa] leading-relaxed fade-in">{translatedText}</div>
              )}
            </div>
          </div>
        )}

        <div className="text-right mt-0.5">
          <span className="text-[10px] text-[#5a6a7a]">
            {message.timestamp?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>

      {/* === 点词弹层（功能1）：单词 + 音标 + 中文释义 + 🔊 === */}
      {bubble && (
        <WordDefBubble
          word={bubble.word}
          zh={bubble.zh}
          phonetic={bubble.phonetic}
          x={bubble.x}
          y={bubble.y}
          onClose={() => setBubble(null)}
        />
      )}
    </div>
  );
}
