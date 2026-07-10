/**
 * Regression tests for src/data/contacts.js (Problems 2 & 3).
 *
 * Problem 2: every AI role's default `voice` comes from assignDefaultVoice
 *   (an Aliyun NLS name), and two shipped roles (Alex / Sam) must NOT share a
 *   voice — proving "different AI roles sound different" out of the box.
 *
 * Problem 3: DIFFICULTY_PRESETS must carry a `summary` field per tier so the
 *   ChatView difficulty button can show immediate, visible feedback after a
 *   switch. Every tier's summary must be non-empty and distinct.
 */

import { describe, it, expect } from 'vitest';
import { contacts, DIFFICULTY_PRESETS } from '../data/contacts';
import { KNOWN_EN_VOICES } from '../data/voices';

describe('Problem 2 — per-role default voice', () => {
  it('every shipped contact has a default voice from KNOWN_EN_VOICES', () => {
    contacts.forEach((c) => {
      expect(KNOWN_EN_VOICES).toContain(c.voice);
    });
  });

  it('Alex and Sam get DIFFERENT default voices (different role = different sound)', () => {
    const alex = contacts.find((c) => c.id === 'alex');
    const sam = contacts.find((c) => c.id === 'sam');
    expect(alex).toBeTruthy();
    expect(sam).toBeTruthy();
    expect(alex.voice).not.toBe(sam.voice);
  });
});

describe('Problem 3 — DIFFICULTY_PRESETS summary', () => {
  it('has exactly three tiers', () => {
    expect(DIFFICULTY_PRESETS).toHaveLength(3);
  });

  it('each tier exposes a non-empty, distinct summary', () => {
    const ids = DIFFICULTY_PRESETS.map((d) => d.id);
    expect(ids).toEqual(['beginner', 'intermediate', 'advanced']);

    const summaries = DIFFICULTY_PRESETS.map((d) => d.summary);
    // non-empty
    summaries.forEach((s) => {
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
    });
    // distinct
    expect(new Set(summaries).size).toBe(summaries.length);
    expect(summaries).toEqual(['极简短句', '日常对话', '母语级 idiom']);
  });
});
