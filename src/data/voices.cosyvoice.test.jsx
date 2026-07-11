/**
 * Tests for CosyVoice 占位映射（架构 T03）。
 *
 * 覆盖：
 *   - ALIYUN_VOICE_OPTIONS 每项含 cosyVoiceId 字段（初值占位 ''）；
 *   - getCosyVoiceId('cally') 返回 ''（占位），未知名返回 ''；
 *   - COSYVOICE_MODEL 为常数 cosyvoice-v3-flash。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ALIYUN_VOICE_OPTIONS,
  getCosyVoiceId,
  COSYVOICE_MODEL,
} from '../data/voices';

beforeEach(() => {
  localStorage.clear();
});

describe('voices — CosyVoice 占位映射 (T03)', () => {
  it('ALIYUN_VOICE_OPTIONS 每项含 cosyVoiceId 字段', () => {
    ALIYUN_VOICE_OPTIONS.forEach((o) => {
      expect(o).toHaveProperty('value');
      expect(o).toHaveProperty('cosyVoiceId');
      expect(typeof o.cosyVoiceId).toBe('string');
    });
  });

  it('getCosyVoiceId 返回初值占位（用户尚未填真实 id）', () => {
    expect(getCosyVoiceId('cally')).toBe('');
    expect(getCosyVoiceId('abby')).toBe('');
    expect(getCosyVoiceId('andy')).toBe('');
    expect(getCosyVoiceId('harry')).toBe('');
    expect(getCosyVoiceId('eric')).toBe('');
  });

  it('getCosyVoiceId 未知名 → 返回 ""', () => {
    expect(getCosyVoiceId('not-a-voice')).toBe('');
    expect(getCosyVoiceId('')).toBe('');
  });

  it('COSYVOICE_MODEL 初值为 cosyvoice-v3-flash', () => {
    expect(COSYVOICE_MODEL).toBe('cosyvoice-v3-flash');
  });
});
