/**
 * Tests for src/components/VoiceBubble.jsx — 点词弹层（功能1：看音标 + 🔊）。
 *
 * 覆盖（架构 T6 验收点）：
 *   1. 点击英文单词 → 弹 WordDefBubble，显示 单词 + 音标 + 中文释义；
 *   2. 命中缓存（wordDefCache.get）时不再打 API（ensureDefs 不被调用）；
 *   3. 缓存未命中 → 调 ensureDefs lazy 生成；
 *   4. phonetic 缺失 → 不显示音标行（优雅降级）；
 *   5. 点击 🔊 → 调用 speakWord。
 *
 * gemini / speech / wordDefCache 全部 mock，保证纯组件级断言。
 * 注意：vi.mock 必须在模块顶层声明（Vitest 会 hoist），每个用例用
 * mockReturnValue 控制缓存命中/未命中，避免在 it() 内调用 vi.mock（非法）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const GARDEN_DEF = { word: 'garden', zh: '花园', phonetic: '/ˈɡɑːrdn/' };

vi.mock('../services/wordDefCache', () => ({
  default: {
    get: vi.fn(),
    ensureDefs: vi.fn(),
    primeFromMessage: vi.fn(),
  },
}));

vi.mock('../services/gemini', () => ({
  translateText: vi.fn().mockResolvedValue('翻译'),
}));

vi.mock('../services/speech', () => ({
  playAudioBlob: vi.fn(),
  speakWord: vi.fn(),
}));

import VoiceBubble from './VoiceBubble';
import wordDefCache from '../services/wordDefCache';
import { speakWord } from '../services/speech';

const msg = {
  id: 'vb-1',
  role: 'user',
  text: 'I love the garden',
  timestamp: new Date(),
};

function renderAndOpen(msgObj) {
  render(<VoiceBubble message={msgObj} isPlaying={false} onPlay={vi.fn()} apiKey="key" />);
  // 展开英文文本
  fireEvent.click(screen.getByText('▼ Show text'));
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  // 默认：缓存未命中（get 返回 undefined），ensureDefs 解析为空数组。
  wordDefCache.get.mockReturnValue(undefined);
  wordDefCache.ensureDefs.mockResolvedValue([]);
});

describe('VoiceBubble — 点词弹层显示音标+释义 (T06)', () => {
  it('命中缓存：点击 garden → 弹层显示 单词 + 音标 + 释义，且不打 API', () => {
    wordDefCache.get.mockReturnValue(GARDEN_DEF);
    renderAndOpen(msg);
    fireEvent.click(screen.getByText('garden'));

    // 注意：气泡与原文各渲染一个 'garden'，故用 getAllByText 避免歧义。
    expect(screen.getAllByText('garden').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('/ˈɡɑːrdn/')).toBeInTheDocument();
    expect(screen.getByText('花园')).toBeInTheDocument();
    // 命中缓存：ensureDefs 不应被调用（无需 lazy 生成）
    expect(wordDefCache.ensureDefs).not.toHaveBeenCalled();
  });

  it('缓存未命中：点击 garden → 调 ensureDefs lazy 生成，弹层仍显示释义', async () => {
    wordDefCache.get.mockReturnValue(undefined);
    wordDefCache.ensureDefs.mockResolvedValue([GARDEN_DEF]);
    renderAndOpen(msg);
    fireEvent.click(screen.getByText('garden'));

    // ensureDefs 被调用（lazy 生成）
    expect(wordDefCache.ensureDefs).toHaveBeenCalledTimes(1);
    // 异步生成后弹层出现
    expect(await screen.findByText('花园')).toBeInTheDocument();
    expect(screen.getByText('/ˈɡɑːrdn/')).toBeInTheDocument();
  });

  it('phonetic 缺失 → 弹层不显示音标行（降级），但释义正常', () => {
    wordDefCache.get.mockReturnValue({ word: 'garden', zh: '花园', phonetic: '' });
    renderAndOpen(msg);
    fireEvent.click(screen.getByText('garden'));

    expect(screen.queryByText('/ˈɡɑːrdn/')).not.toBeInTheDocument();
    expect(screen.getByText('花园')).toBeInTheDocument();
  });

  it('点击 🔊 → 调用 speakWord(word)', () => {
    wordDefCache.get.mockReturnValue(GARDEN_DEF);
    renderAndOpen(msg);
    fireEvent.click(screen.getByText('garden'));
    fireEvent.click(screen.getByLabelText('朗读单词'));

    expect(speakWord).toHaveBeenCalledWith('garden');
  });

  it('再次点击同一单词 → 关闭弹层', () => {
    wordDefCache.get.mockReturnValue(GARDEN_DEF);
    renderAndOpen(msg);
    const word = screen.getByText('garden');
    fireEvent.click(word);
    expect(screen.getByText('花园')).toBeInTheDocument();
    fireEvent.click(word); // 再次点击 → 关闭
    expect(screen.queryByText('花园')).not.toBeInTheDocument();
  });
});
