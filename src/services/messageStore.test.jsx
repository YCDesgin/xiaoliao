/**
 * Tests for src/services/messageStore.js — metadata (功能1 wordDefs 缓存) 序列化往返。
 *
 * 覆盖（架构 T4 验收点）：
 *   - toSlim 写入 metadata（含 wordDefs）后能经 writeRaw → readRaw 原样往返；
 *   - loadMessages 回灌 metadata，且旧消息无 metadata 时不报错（undefined 处理）。
 *
 * 说明：saveMessages / loadMessages 会触及 IndexedDB（audioStore），在 jsdom 下
 * IndexedDB 不可用，相关调用被 audioStore 的 try/catch 吞掉、audioBlob 回退为 null，
 * 不影响 metadata 文本部分的断言。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeRaw, readRaw, loadMessages } from './messageStore.js';

// 验证 metadata（功能1 wordDefs 缓存）经 writeRaw → readRaw / loadMessages 的往返一致性。

const CONTACT = 'msgtest-c1';

function makeMessages() {
  return [
    {
      id: 'm1',
      role: 'user',
      text: 'I went to the garden yesterday',
      timestamp: new Date('2026-07-11T10:00:00.000Z'),
      metadata: {
        wordDefs: [
          { word: 'garden', zh: '花园', phonetic: '/ˈɡɑːrdn/' },
          { word: 'yesterday', zh: '昨天', phonetic: '/ˈjestədeɪ/' },
        ],
      },
    },
    {
      id: 'm2',
      role: 'them',
      text: 'Nice! The garden looks beautiful.',
      timestamp: new Date('2026-07-11T10:00:05.000Z'),
      // 旧数据：无 metadata
    },
  ];
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('messageStore — metadata 序列化往返 (T04)', () => {
  it('含 metadata 的消息 writeRaw → readRaw 往返一致', async () => {
    const msgs = makeMessages();
    writeRaw(CONTACT, msgs);
    const back = readRaw(CONTACT);

    expect(back).toHaveLength(2);
    const m1 = back.find((m) => m.id === 'm1');
    expect(m1.metadata).toBeDefined();
    expect(m1.metadata.wordDefs).toHaveLength(2);
    expect(m1.metadata.wordDefs[0]).toEqual({ word: 'garden', zh: '花园', phonetic: '/ˈɡɑːrdn/' });

    // 旧消息无 metadata → 回读后 metadata 为 undefined（不报错、不注入空对象）
    const m2 = back.find((m) => m.id === 'm2');
    expect(m2.metadata).toBeUndefined();
  });

  it('metadata 缺失 phonetic 也能往返（优雅降级，字段原样保留）', () => {
    const msgs = [
      {
        id: 'm3',
        role: 'user',
        text: 'hello',
        timestamp: new Date(),
        metadata: { wordDefs: [{ word: 'hello', zh: '你好' }] }, // 无 phonetic
      },
    ];
    writeRaw(CONTACT, msgs);
    const back = readRaw(CONTACT);
    expect(back[0].metadata.wordDefs[0]).toEqual({ word: 'hello', zh: '你好' });
  });

  it('loadMessages 回灌 metadata，且 audioBlob 安全回退为 null', async () => {
    const msgs = makeMessages();
    writeRaw(CONTACT, msgs);
    const loaded = await loadMessages(CONTACT);

    expect(loaded).toHaveLength(2);
    const m1 = loaded.find((m) => m.id === 'm1');
    expect(m1.metadata?.wordDefs?.[0]).toEqual({ word: 'garden', zh: '花园', phonetic: '/ˈɡɑːrdn/' });
    // 文本消息无 audioBlob → loadMessages 回退 null（不抛）
    expect(m1.audioBlob).toBeNull();
  });

  it('readRaw 对空存储返回 []（不抛）', () => {
    expect(readRaw('nonexistent')).toEqual([]);
  });
});
