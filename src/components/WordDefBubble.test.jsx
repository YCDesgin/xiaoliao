import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// 屏蔽 Web Speech API（jsdom 无）；speakWord 给桩以便断言点击朗读。
vi.mock('../services/speech', () => ({
  speakText: vi.fn(),
  stopSpeaking: vi.fn(),
  speakWord: vi.fn(),
}));

import WordDefBubble from './WordDefBubble';
import { speakWord } from '../services/speech';

const noop = () => {};

describe('WordDefBubble — 暂无释义降级 + 朗读 (T05/B02)', () => {
  it('zh 为空 → 显示「暂无释义」', () => {
    render(<WordDefBubble word="hello" zh={null} x={100} y={100} onClose={noop} />);
    expect(screen.getByText('暂无释义')).toBeInTheDocument();
  });

  it('zh 有值 → 显示中文释义', () => {
    render(<WordDefBubble word="school" zh="学校" x={100} y={100} onClose={noop} />);
    expect(screen.getByText('学校')).toBeInTheDocument();
    expect(screen.queryByText('暂无释义')).not.toBeInTheDocument();
  });

  it('点击 🔊 → 调用 speakWord(word)', () => {
    render(<WordDefBubble word="school" zh="学校" x={100} y={100} onClose={noop} />);
    fireEvent.click(screen.getByLabelText('朗读单词'));
    expect(speakWord).toHaveBeenCalledTimes(1);
    expect(speakWord).toHaveBeenCalledWith('school');
  });

  it('点击气泡外部 → 触发 onClose', () => {
    const onClose = vi.fn();
    render(<WordDefBubble word="school" zh="学校" x={100} y={100} onClose={onClose} />);
    fireEvent.mouseDown(document.body); // 外部点击
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('按 Esc → 触发 onClose', () => {
    const onClose = vi.fn();
    render(<WordDefBubble word="school" zh="学校" x={100} y={100} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('WordDefBubble — 音标显示 + 缺失降级 (T05)', () => {
  it('phonetic 有值 → 显示音标', () => {
    render(<WordDefBubble word="school" zh="学校" phonetic="/skuːl/" x={100} y={100} onClose={noop} />);
    expect(screen.getByText('/skuːl/')).toBeInTheDocument();
  });

  it('phonetic 缺失（undefined）→ 不渲染音标行（优雅降级，不显示占位）', () => {
    render(<WordDefBubble word="school" zh="学校" x={100} y={100} onClose={noop} />);
    expect(screen.queryByText('/skuːl/')).not.toBeInTheDocument();
    // 释义仍然正常显示
    expect(screen.getByText('学校')).toBeInTheDocument();
  });

  it('phonetic 为空字符串 → 不渲染音标行', () => {
    render(<WordDefBubble word="school" zh="学校" phonetic="" x={100} y={100} onClose={noop} />);
    expect(screen.queryByText('/skuːl/')).not.toBeInTheDocument();
  });
});
