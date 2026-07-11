import { useState, useEffect, useRef } from 'react';
import { speakWord } from '../services/speech';

/**
 * 逐词释义气泡（B02 / B03 基础增强）。
 * - 显示中文释义（无则「暂无释义」）
 * - 🔊 朗读该单词（speech.speakWord）
 * - 点击空白 / 按 Esc 关闭
 * - 位置避让：默认显示在词上方；顶部空间不足则转下方；水平按视口夹紧。
 *
 * 坐标说明：x/y 来自触发元素 getBoundingClientRect()（视口坐标系），
 * 本组件用 fixed 定位，二者一致。
 */
export default function WordDefBubble({ word, zh, phonetic, x, y, onClose }) {
  const ref = useRef(null);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const handleSpeak = () => {
    speakWord(word);
    setSpeaking(true);
    setTimeout(() => setSpeaking(false), 900);
  };

  // 位置避让（B03 基础）
  const vw = typeof window !== 'undefined' ? window.innerWidth : 360;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 640;
  const bubbleW = 200;
  const bubbleH = 84;
  let left = x - bubbleW / 2;
  left = Math.max(8, Math.min(left, vw - bubbleW - 8));
  let top = y - bubbleH - 8; // 优先上方
  if (top < 8) top = y + 24; // 上方空间不足 → 下方
  if (top + bubbleH > vh - 8) top = Math.max(8, vh - bubbleH - 8);

  return (
    <div
      ref={ref}
      className="fixed z-[70] bg-[#17212b] border border-[#1c2a3a] rounded-xl px-3 py-2 shadow-xl fade-in"
      style={{ left, top, width: bubbleW }}
      role="dialog"
      aria-label={`释义：${word}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-[#f5f5f5] truncate">{word}</div>
        <button
          type="button"
          onClick={handleSpeak}
          aria-label="朗读单词"
          className={`text-[#2aabee] hover:text-[#3db9f5] transition-colors text-base leading-none ${speaking ? 'animate-pulse' : ''}`}
        >
          🔊
        </button>
      </div>
      {/* 音标：仅当 AI 预生成/查词返回 phonetic 时才显示（缺失优雅降级，不显示占位） */}
      {phonetic ? (
        <div className="mt-0.5 text-[12px] text-[#7fb3d5] leading-snug">{phonetic}</div>
      ) : null}
      <div className="mt-1 text-[13px] text-[#cdd6df] leading-relaxed">
        {zh || '暂无释义'}
      </div>
    </div>
  );
}
