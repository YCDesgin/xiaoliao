import { useState, useEffect, useRef } from 'react';
import { speakText, stopSpeaking } from '../services/speech';
import WordDefBubble from './WordDefBubble';
import { normalizeReview } from '../services/reviewStore';

// 把 corrected 句子切成词 token（保留空格作为普通文本）。
function tokenizeWords(text) {
  if (!text) return [];
  return text
    .split(/(\s+)/)
    .map((t) => ({ text: t, isWord: /[A-Za-z]/.test(t) && !/^\s+$/.test(t) }))
    .filter((t) => t.text.length > 0);
}

function cleanWord(raw) {
  return raw.toLowerCase().replace(/[^a-z'-]/g, '');
}

// 在 mistake.wordDefs 里按归一化词查找中文释义；找不到返回 null（→ 暂无释义）。
function findDef(mistake, rawWord) {
  const w = cleanWord(rawWord);
  const defs = Array.isArray(mistake.wordDefs) ? mistake.wordDefs : [];
  const hit = defs.find((d) => cleanWord(d.word) === w);
  return hit ? hit.zh : null;
}

export default function EndReview({ contact, review, onBack, onContinue, meta = null, onBackToList }) {
  const [playingIdx, setPlayingIdx] = useState(null);
  const [showSummaryZh, setShowSummaryZh] = useState(false);
  const [zhOpen, setZhOpen] = useState({}); // Tracks which correction items have Chinese explanation expanded (keyed by index)
  const [activeDef, setActiveDef] = useState(null); // 当前点开的逐词释义气泡 { word, zh, x, y }
  const activeRef = useRef(null); // Tracks the row whose playback is currently active

  // 点击 corrected 中的某个词 → 打开释义气泡（B02）
  const openDef = (e, mistake, rawWord) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setActiveDef({
      word: rawWord,
      zh: findDef(mistake, rawWord),
      x: rect.left + rect.width / 2,
      y: rect.top,
    });
  };

  // Stop any ongoing playback when leaving the review page
  useEffect(() => () => stopSpeaking(), []);

  /**
   * Play/stop a corrected sentence using the contact's dedicated voice at a
   * slightly slower rate so beginners can clearly hear pronunciation & intonation.
   * @param {number} index - Index of the mistake in the list
   * @param {string} text - The corrected sentence to speak
   */
  const handlePlayCorrected = async (index, text) => {
    if (!text) return;
    // If this row is currently playing, toggle it off (stop)
    if (playingIdx === index) {
      stopSpeaking();
      setPlayingIdx(null);
      activeRef.current = null;
      return;
    }
    activeRef.current = index;
    setPlayingIdx(index);
    try {
      await speakText(text, { voice: contact.voice, rate: 0.9 });
    } finally {
      // Only reset state if THIS row is still the active one. Switching to
      // another sentence sets activeRef to the new index and lets the previous
      // sentence's lingering finally no-op instead of clobbering the new state.
      if (activeRef.current === index) {
        activeRef.current = null;
        setPlayingIdx(null);
      }
    }
  };

  // Normalize so legacy reviews without wordDefs still render/tap correctly.
  const normalizedReview = normalizeReview(review);
  const summary = normalizedReview.summary || 'Nice chatting with you today!';
  const summaryZh = normalizedReview.summaryZh || '';
  const score = typeof normalizedReview.score === 'number' ? normalizedReview.score : 0;
  const mistakes = Array.isArray(normalizedReview.mistakes) ? normalizedReview.mistakes : [];
  const newWords = Array.isArray(review?.newWords) ? review.newWords : [];
  const suggestions = Array.isArray(review?.suggestions) ? review.suggestions : [];
  const expressions = Array.isArray(review?.expressions) ? review.expressions : [];
  const feedback = review?.feedback || '';

  // SVG ring progress
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(0, score));
  const offset = circumference * (1 - clamped / 100);

  return (
    <div className="h-full flex flex-col bg-[#0e1621]">
      <div className="flex items-center gap-3 px-4 py-3 bg-[#17212b] border-b border-[#1c2a3a]">
        <div className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0 bg-[#1f2c3a]">
          <img src={contact.avatar} alt={contact.name} className="w-full h-full object-cover" />
        </div>
        <div>
          <div className="text-sm font-medium text-[#f5f5f5]">Chat with {contact.name}</div>
          <div className="text-[11px] text-[#707579]">{meta ? `复盘于 ${new Date(meta.generatedAt).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}` : 'Session complete'}</div>
        </div>
        <span className="ml-auto text-[10px] text-[#2aabee] border border-[#2aabee]/30 bg-[#2aabee]/10 rounded-full px-2 py-0.5">🦐 虾聊</span>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-7 space-y-6">
        {/* 2. Speaking score */}
        <div className="flex flex-col items-center">
          <div className="relative w-32 h-32">
            <svg className="w-32 h-32 -rotate-90" viewBox="0 0 120 120">
              <circle cx="60" cy="60" r={radius} stroke="#1c2a3a" strokeWidth="10" fill="none" />
              <circle cx="60" cy="60" r={radius} stroke="#2aabee" strokeWidth="10" fill="none"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                style={{ transition: 'stroke-dashoffset 0.6s ease' }} />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-3xl font-bold text-[#f5f5f5]">{score}</span>
              <span className="text-[10px] text-[#707579]">speaking score</span>
            </div>
          </div>
        </div>

        {/* 3. Summary */}
        <div className="bg-[#2aabee]/10 border border-[#2aabee]/15 rounded-xl px-4 py-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] text-[#707579] uppercase tracking-wider font-medium">Summary</span>
            {summaryZh && (
              <button
                type="button"
                onClick={() => setShowSummaryZh(v => !v)}
                className="text-[11px] text-[#2aabee] hover:text-[#3db9f5] transition-colors px-2 py-0.5 rounded-lg hover:bg-[#1f2c3a]"
              >
                {showSummaryZh ? '收起中文' : '🇨🇳 中文'}
              </button>
            )}
          </div>
          <p className="text-sm text-[#f5f5f5] leading-relaxed">{summary}</p>
          {showSummaryZh && summaryZh && (
            <p className="text-[12px] text-[#c8d3dd] mt-1.5 leading-relaxed fade-in">🇨🇳 {summaryZh}</p>
          )}
        </div>

        {/* 4. Expression corrections (mistakes) */}
        {mistakes.length > 0 && (
          <div>
            <h3 className="text-[11px] text-[#707579] mb-3 uppercase tracking-wider font-medium">表达矫正 💡</h3>
            <div className="divide-y divide-[#1c2a3a]">
              {mistakes.map((m, i) => (
                <div key={i} className="py-4 first:pt-0 last:pb-0 fade-in" style={{ animationDelay: `${i * 0.08}s` }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[15px] text-[#9ca3af] line-through decoration-[#9ca3af]/80">{m.original}</span>
                    <span className="text-[#2aabee]">→</span>
                    <span className="text-sm font-bold text-[#f5f5f5]">
                      {tokenizeWords(m.corrected).map((token, ti) =>
                        token.isWord ? (
                          <button
                            key={ti}
                            type="button"
                            title="点击查看释义 / 朗读"
                            onClick={(e) => openDef(e, m, token.text)}
                            className="inline hover:text-[#3db9f5] hover:underline underline-offset-2 transition-colors cursor-pointer"
                          >
                            {token.text}
                          </button>
                        ) : (
                          <span key={ti}>{token.text}</span>
                        )
                      )}
                    </span>
                    {m.corrected && (
                      <button
                        type="button"
                        aria-label={playingIdx === i ? 'Stop playback' : 'Play corrected sentence'}
                        onClick={() => handlePlayCorrected(i, m.corrected)}
                        className={`ml-1 text-[#2aabee] hover:text-[#3db9f5] transition-colors text-sm flex-shrink-0 ${playingIdx === i ? 'animate-pulse' : ''}`}
                      >
                        {playingIdx === i ? '⏸' : '🔊'}
                      </button>
                    )}
                  </div>
                  {m.reason && (
                    <div className="text-[13px] text-[#cdd6df] mt-2 font-medium leading-relaxed">{m.reason}</div>
                  )}
                  {m.reasonZh && (
                    <>
                      <button
                        type="button"
                        onClick={() => setZhOpen(s => ({ ...s, [i]: !s[i] }))}
                        className="mt-1.5 text-[11px] text-[#2aabee] hover:text-[#3db9f5] transition-colors px-2 py-0.5 rounded-lg hover:bg-[#1f2c3a]"
                      >
                        {zhOpen[i] ? '收起中文' : '🇨🇳 中文'}
                      </button>
                      {zhOpen[i] && (
                        <div className="text-[12px] text-[#c8d3dd] mt-1 leading-relaxed fade-in">{m.reasonZh}</div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 5. New expressions (newWords) */}
        {newWords.length > 0 && (
          <div>
            <h3 className="text-[11px] text-[#707579] mb-3 uppercase tracking-wider font-medium">新表达</h3>
            <div className="flex flex-wrap gap-2">
              {newWords.map((w, i) => (
                <span key={i} className="bg-[#17212b] rounded-full px-3 py-1 text-[11px] text-[#f5f5f5] border border-[#1c2a3a]">
                  {w}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 6. Suggestions */}
        {suggestions.length > 0 && (
          <div>
            <h3 className="text-[11px] text-[#707579] mb-3 uppercase tracking-wider font-medium">下次可以</h3>
            <ul className="divide-y divide-[#1c2a3a]">
              {suggestions.map((s, i) => (
                <li key={i} className="flex gap-2 text-sm text-[#f5f5f5] py-2.5 first:pt-0 last:pb-0">
                  <span className="text-[#2aabee] mt-0.5">•</span>
                  <span className="leading-relaxed">{s}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Optional legacy fields (only when present) */}
        {expressions.length > 0 && (
          <div>
            <h3 className="text-[11px] text-[#707579] mb-3 uppercase tracking-wider font-medium">Expressions you heard</h3>
            <div className="divide-y divide-[#1c2a3a]">
              {expressions.map((expr, i) => (
                <div key={i} className="py-3 first:pt-0 last:pb-0 text-sm text-[#f5f5f5] fade-in" style={{ animationDelay: `${i * 0.1}s` }}>
                  &quot;{expr}&quot;
                </div>
              ))}
            </div>
          </div>
        )}
        {feedback && (
          <div className="bg-[#2aabee]/10 border border-[#2aabee]/15 rounded-xl px-4 py-3">
            <p className="text-sm text-[#f5f5f5] leading-relaxed">{feedback}</p>
          </div>
        )}

        <div className="text-center text-[11px] text-[#5a6a7a] leading-relaxed">
          The goal isn't perfection — it's connection.<br/>
          Every conversation makes you a little more natural.
        </div>
      </div>

      <div className="px-5 py-3 bg-[#17212b] border-t border-[#1c2a3a] space-y-2">
        <button onClick={onContinue} className="w-full py-3 bg-[#2aabee] hover:bg-[#3db9f5] rounded-xl text-sm font-medium text-white transition-colors">
          Keep chatting with {contact.name}
        </button>
        {meta ? (
          <button onClick={onBackToList} className="w-full py-3 text-sm text-[#707579] hover:text-[#aaaaaa] transition-colors">
            ← 复盘历史
          </button>
        ) : (
          <button onClick={onBack} className="w-full py-3 text-sm text-[#707579] hover:text-[#aaaaaa] transition-colors">
            Back to contacts
          </button>
        )}
      </div>

      {activeDef && (
        <WordDefBubble
          word={activeDef.word}
          zh={activeDef.zh}
          x={activeDef.x}
          y={activeDef.y}
          onClose={() => setActiveDef(null)}
        />
      )}
    </div>
  );
}
