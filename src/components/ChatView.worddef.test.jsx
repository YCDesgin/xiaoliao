/**
 * Tests for ChatView.sendMessage — AI 回复预生成 wordDefs 写入 metadata (架构 T8)。
 *
 * 覆盖：
 *   1. 发送消息后，chatWithAI 返回的 wordDefs 写入 AI 消息 metadata 并持久化到 localStorage；
 *   2. chatWithAI 返回纯文本（无 wordDefs）兜底时，AI 消息正常渲染、metadata 为 undefined、不崩。
 *
 * speech / imageService / reviewStore 全 mock；gemini 的 chatWithAI 返回结构化管理对象。
 * 关键：gemini mock 必须提供 wordDefCache 依赖的 defineWords/defineWord/normalizeWordDef，
 *       否则 VoiceBubble 预热缓存时会因导入符号缺失而抛错。
 *
 * ChatView 是受控组件（messages 来自 props，setMessages 由父组件提供），故用 Harness
 * 持有 messages 状态并回灌，模拟真实父组件行为。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { useState } from 'react';

vi.mock('../services/speech', () => ({
  speakText: vi.fn().mockResolvedValue(undefined),
  stopSpeaking: vi.fn(),
  SPEED_PRESETS: [{ value: 0.7, label: '慢速' }, { value: 0.85, label: '中速' }, { value: 1.0, label: '正常' }],
  playAudioBlob: vi.fn(),
  startRecording: vi.fn().mockResolvedValue(undefined),
  stopRecording: vi.fn().mockResolvedValue({ transcript: '', audioBlob: null }),
  cancelRecording: vi.fn(),
  supportsVoiceInput: vi.fn().mockReturnValue(false),
  setAsrErrorHandler: vi.fn(),
  setAsrStatusHandler: vi.fn(),
  getAsrModeLabel: vi.fn().mockReturnValue(''),
}));

vi.mock('../services/gemini', () => ({
  chatWithAI: vi.fn().mockResolvedValue({ text: 'Hi there!', wordDefs: [{ word: 'hi', zh: '你好', phonetic: '/haɪ/' }] }),
  reviewConversation: vi.fn().mockResolvedValue({}),
  translateText: vi.fn().mockResolvedValue(''),
  defineWord: vi.fn().mockResolvedValue(null),
  defineWords: vi.fn().mockResolvedValue([]),
  normalizeWordDef: (d) => (d && d.word && d.zh ? { word: d.word, zh: d.zh, phonetic: d.phonetic || '' } : null),
}));

vi.mock('../services/imageService', () => ({
  searchImage: vi.fn().mockResolvedValue(null),
  cleanQuery: vi.fn().mockReturnValue(''),
}));

vi.mock('../services/reviewStore', () => ({
  fingerprintOf: vi.fn().mockReturnValue('fp'),
  findCached: vi.fn().mockReturnValue(null),
  saveReview: vi.fn(),
  clearReviews: vi.fn(),
}));

import ChatView from './ChatView';

function makeContact(id = 'cv-wd', name = 'WD Bot') {
  return { id, name, avatar: 'https://example.com/a.png', basePrompt: 'You are a bot.' };
}

function makeProps(overrides = {}) {
  // 注意：messages / setMessages 由 Harness 注入（受控组件）。
  return {
    contact: makeContact(),
    apiKey: 'sk',
    userAvatar: null,
    onBack: vi.fn(),
    onEnd: vi.fn(),
    onShowHistory: vi.fn(),
    fromHistory: false,
    ...overrides,
  };
}

// Harness：持有 messages 状态，模拟真实父组件把 state 交给 ChatView。
function Harness({ initialMessages = [], ...props }) {
  const [messages, setState] = useState(initialMessages);
  const setMessages = (updater) =>
    setState((prev) => (typeof updater === 'function' ? updater(prev) : updater));
  return <ChatView {...props} messages={messages} setMessages={setMessages} />;
}

// 展开所有消息文本（VoiceBubble 默认折叠，仅显示波形；文本按词拆成多个 span）。
function expandAllText() {
  screen.getAllByText('▼ Show text').forEach((b) => fireEvent.click(b));
}

let _origScrollIntoView;
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  _origScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  Element.prototype.scrollIntoView = _origScrollIntoView;
  cleanup();
});

describe('ChatView — AI 回复预生成 wordDefs 写入 metadata (T08)', () => {
  it('发送消息后，AI 回复的 wordDefs 写入消息 metadata（持久化到 localStorage）', async () => {
    const contact = makeContact();
    render(<Harness {...makeProps({ contact })} />);

    // 打开文本输入框（⌨ 按钮）
    fireEvent.click(screen.getByText('⌨'));
    const input = screen.getByPlaceholderText('Message');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    // 等待 sendMessage 异步完成
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    // 展开文本后，AI 回复（按拆分后的单词 span 断言）
    expandAllText();
    expect(await screen.findByText('there!')).toBeInTheDocument();

    // localStorage 中该会话消息含 metadata.wordDefs
    const raw = localStorage.getItem(`speakup_msgs_${contact.id}`);
    expect(raw).toBeTruthy();
    const stored = JSON.parse(raw);
    const ai = stored.find((m) => m.role === 'them');
    expect(ai).toBeTruthy();
    expect(ai.metadata).toBeDefined();
    expect(ai.metadata.wordDefs).toEqual([{ word: 'hi', zh: '你好', phonetic: '/haɪ/' }]);
  });

  it('chatWithAI 返回纯文本（无 wordDefs）兜底：AI 消息正常渲染、metadata 为 undefined、不崩', async () => {
    const { chatWithAI } = await import('../services/gemini');
    chatWithAI.mockResolvedValueOnce('Plain reply');
    const contact = makeContact('cv-plain');
    render(<Harness {...makeProps({ contact })} />);

    fireEvent.click(screen.getByText('⌨'));
    const input = screen.getByPlaceholderText('Message');
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    expandAllText();
    expect(await screen.findByText('reply')).toBeInTheDocument();

    const raw = localStorage.getItem(`speakup_msgs_${contact.id}`);
    const stored = JSON.parse(raw);
    const ai = stored.find((m) => m.role === 'them');
    expect(ai.metadata).toBeUndefined();
  });
});
