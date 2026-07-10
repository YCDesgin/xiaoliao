/**
 * Regression tests for src/data/voices.js (Problem 2 — per-AI-role voice).
 *
 * Covers the pure, deterministic contract of the voice module:
 *   - KNOWN_EN_VOICES / ALIYUN_VOICE_OPTIONS shape
 *   - assignDefaultVoice: returns a known voice, is idempotent, and honors the
 *     gender clue (emoji/avatar/color) by mapping into the male/female pool
 *   - getContactVoiceOverride / setContactVoiceOverride: localStorage round-trip,
 *     per-id namespacing, and clearing on empty/null
 *   - getEffectiveVoice: override wins; falls back to the default assignment;
 *     an invalid override (not in KNOWN_EN_VOICES) is ignored
 *
 * NOTE: this file imports ONLY voices.js, so the module-level `assignedVoices`
 * cache starts empty and every assertion below is fully self-contained.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  KNOWN_EN_VOICES,
  ALIYUN_VOICE_OPTIONS,
  assignDefaultVoice,
  getContactVoiceOverride,
  setContactVoiceOverride,
  getEffectiveVoice,
} from '../data/voices';

const MALE_VOICES = KNOWN_EN_VOICES.filter(
  (v) => ALIYUN_VOICE_OPTIONS.find((o) => o.value === v)?.gender === 'male',
);
const FEMALE_VOICES = KNOWN_EN_VOICES.filter(
  (v) => ALIYUN_VOICE_OPTIONS.find((o) => o.value === v)?.gender === 'female',
);

beforeEach(() => {
  localStorage.clear();
});

describe('module constants', () => {
  it('KNOWN_EN_VOICES matches the backend Aliyun NLS pool', () => {
    expect(KNOWN_EN_VOICES).toEqual(['cally', 'abby', 'andy', 'harry', 'eric']);
  });

  it('ALIYUN_VOICE_OPTIONS lists every known voice with a gender + label', () => {
    expect(ALIYUN_VOICE_OPTIONS.map((o) => o.value).sort()).toEqual(
      [...KNOWN_EN_VOICES].sort(),
    );
    ALIYUN_VOICE_OPTIONS.forEach((o) => {
      expect(['male', 'female']).toContain(o.gender);
      expect(typeof o.label).toBe('string');
      expect(o.label.length).toBeGreaterThan(0);
    });
    // exactly two female, three male — mirrors the male/female pools used below
    expect(FEMALE_VOICES).toEqual(['cally', 'abby']);
    expect(MALE_VOICES).toEqual(['andy', 'harry', 'eric']);
  });
});

describe('assignDefaultVoice', () => {
  it('always returns a value from KNOWN_EN_VOICES', () => {
    const v = assignDefaultVoice({ id: 'u1', name: 'Unit One' });
    expect(KNOWN_EN_VOICES).toContain(v);
  });

  it('is idempotent for the same contact (keyed by id)', () => {
    const contact = { id: 'uidem', name: 'Idem' };
    const a = assignDefaultVoice(contact);
    const b = assignDefaultVoice({ id: 'uidem', name: 'Idem' });
    expect(a).toBe(b);
  });

  it('is idempotent for a contact identified only by name', () => {
    const a = assignDefaultVoice({ name: 'Nameless' });
    const b = assignDefaultVoice({ name: 'Nameless' });
    expect(a).toBe(b);
  });

  it('maps a male emoji clue (👨) into the male voice pool', () => {
    const v = assignDefaultVoice({ id: 'bob', name: 'Bob', emoji: '👨' });
    expect(MALE_VOICES).toContain(v);
  });

  it('maps a female emoji clue (👩) into the female voice pool', () => {
    const v = assignDefaultVoice({ id: 'lucy', name: 'Lucy', emoji: '👩' });
    expect(FEMALE_VOICES).toContain(v);
  });

  it('uses the color clue (blue => male, red => female)', () => {
    const male = assignDefaultVoice({ id: 'mike', name: 'Mike', color: '#0000ff' });
    expect(MALE_VOICES).toContain(male);
    const female = assignDefaultVoice({ id: 'rose', name: 'Rose', color: '#ff0033' });
    expect(FEMALE_VOICES).toContain(female);
  });

  it('has no gender clue => still returns a valid (any) known voice', () => {
    const v = assignDefaultVoice({ id: 'neutral', name: 'Neutral' });
    expect(KNOWN_EN_VOICES).toContain(v);
  });
});

describe('getContactVoiceOverride / setContactVoiceOverride', () => {
  it('returns null when nothing is stored', () => {
    expect(getContactVoiceOverride('ov1')).toBeNull();
  });

  it('round-trips a stored override', () => {
    setContactVoiceOverride('ov1', 'abby');
    expect(getContactVoiceOverride('ov1')).toBe('abby');
  });

  it('clears the override when an empty string is written', () => {
    setContactVoiceOverride('ov2', 'harry');
    expect(getContactVoiceOverride('ov2')).toBe('harry');
    setContactVoiceOverride('ov2', '');
    expect(getContactVoiceOverride('ov2')).toBeNull();
  });

  it('clears the override when null is written', () => {
    setContactVoiceOverride('ov3', 'cally');
    setContactVoiceOverride('ov3', null);
    expect(getContactVoiceOverride('ov3')).toBeNull();
  });

  it('namespaces overrides per contact id', () => {
    setContactVoiceOverride('a', 'cally');
    setContactVoiceOverride('b', 'eric');
    expect(getContactVoiceOverride('a')).toBe('cally');
    expect(getContactVoiceOverride('b')).toBe('eric');
  });
});

describe('getEffectiveVoice', () => {
  it('returns the override when one is set', () => {
    setContactVoiceOverride('vx', 'eric');
    expect(getEffectiveVoice({ id: 'vx', name: 'Vx' })).toBe('eric');
  });

  it('falls back to the default assignment when no override exists', () => {
    setContactVoiceOverride('vy', ''); // ensure cleared
    const v = getEffectiveVoice({ id: 'vy', name: 'Vy' });
    expect(KNOWN_EN_VOICES).toContain(v);
  });

  it('ignores an invalid override (not in KNOWN_EN_VOICES) and uses the default', () => {
    setContactVoiceOverride('vz', 'not-a-real-voice');
    const v = getEffectiveVoice({ id: 'vz', name: 'Vz' });
    expect(v).not.toBe('not-a-real-voice');
    expect(KNOWN_EN_VOICES).toContain(v);
  });
});
