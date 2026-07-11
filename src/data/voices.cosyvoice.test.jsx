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
  it('ALIYUN_VOICE_OPTIONS — CosyVoice 音色每项含 cosyVoiceId 字段', () => {
    ALIYUN_VOICE_OPTIONS.forEach((o) => {
      expect(o).toHaveProperty('value');
      // 播音腔(nls) 无 cosyVoiceId；仅 CosyVoice 音色带 cosyVoiceId。
      if (o.provider !== 'nls') {
        expect(o).toHaveProperty('cosyVoiceId');
        expect(typeof o.cosyVoiceId).toBe('string');
      }
    });
  });

  it('getCosyVoiceId 返回内置默认英文音色映射（性别/口音对齐，loong*）', () => {
    expect(getCosyVoiceId('cally')).toBe('loongcally_v3');
    expect(getCosyVoiceId('abby')).toBe('loongabby_v3');
    expect(getCosyVoiceId('andy')).toBe('loongandy_v3');
    expect(getCosyVoiceId('harry')).toBe('loongluca_v3');
    expect(getCosyVoiceId('eric')).toBe('loongeric_v3');
  });

  it('getCosyVoiceId 未知名 → 返回 ""', () => {
    expect(getCosyVoiceId('not-a-voice')).toBe('');
    expect(getCosyVoiceId('')).toBe('');
  });

  it('COSYVOICE_MODEL 初值为 cosyvoice-v3-flash', () => {
    expect(COSYVOICE_MODEL).toBe('cosyvoice-v3-flash');
  });
});
