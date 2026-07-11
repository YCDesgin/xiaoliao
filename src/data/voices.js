// 音色池与按角色默认分配（纯前端）。
//
// 后端 aliyun-tts-proxy/index.js 仅支持以下阿里云 NLS 英文发音人：
//   cally / abby（偏女声）  andy / harry / eric（偏男声）
// 前端曾错误地使用 Edge-TTS 的 Microsoft Neural 名（en-US-ChristopherNeural 等），
// 后端不识别 → 全部 fallback 到默认 cally → 所有 AI 角色同声。
// 本文件统一前端音色命名为后端支持的阿里云名，并提供
// 「按名字+头像自动分配 + 可手动覆盖」逻辑，保证各 AI 角色默认就不同声。

/** 后端支持的阿里云英文发音人（必须与 aliyun-tts-proxy 的 KNOWN_EN_VOICES 保持一致） */
export const KNOWN_EN_VOICES = ['cally', 'abby', 'andy', 'harry', 'eric'];

/**
 * 每个发音人的中文标签与性别 hint（供 UI 下拉与默认分配使用）。
 * cosyVoiceId 为功能2（CosyVoice 逼真 TTS）默认英文音色：已预填 CosyVoice v3 纯英文
 * 出海营销系列（性别/口音对齐），与 aliyun-tts-proxy 的 COSYVOICE_DEFAULT_VOICE_MAP 一致。
 * 云端仍可用环境变量 COSYVOICE_VOICE_MAP 整体覆盖这些默认值（在后端生效）。
 */
export const ALIYUN_VOICE_OPTIONS = [
  { value: 'cally', label: 'Cally（女）', gender: 'female', cosyVoiceId: 'loongcally_v3' },
  { value: 'abby', label: 'Abby（女）', gender: 'female', cosyVoiceId: 'loongabby_v3' },
  { value: 'andy', label: 'Andy（男）', gender: 'male', cosyVoiceId: 'loongandy_v3' },
  { value: 'harry', label: 'Harry（男）', gender: 'male', cosyVoiceId: 'loongluca_v3' },
  { value: 'eric', label: 'Eric（男）', gender: 'male', cosyVoiceId: 'loongeric_v3' },
];

const FEMALE_VOICES = KNOWN_EN_VOICES.filter(
  (v) => ALIYUN_VOICE_OPTIONS.find((o) => o.value === v)?.gender === 'female',
);
const MALE_VOICES = KNOWN_EN_VOICES.filter(
  (v) => ALIYUN_VOICE_OPTIONS.find((o) => o.value === v)?.gender === 'male',
);

// 已分配音色登记表（按 contact.id 或 name 去重，保证静态角色默认不同声）。
// 关键点：assignDefaultVoice 对同一个 contact 幂等 —— 重复调用返回相同结果，
// 因此 getEffectiveVoice 在组件每次渲染时调用也不会产生副作用或漂移。
const assignedVoices = new Map();

// 稳定字符串哈希（FNV-1a），保证同一名字跨会话得到相同索引。
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 从头像/emoji/主色推断性别偏好（尽量自然）：女声 → female，男声 → male，无线索 → null。
function inferGenderPref(contact) {
  const clues = [contact?.emoji, contact?.avatar, contact?.color]
    .filter(Boolean)
    .map(String);
  for (const c of clues) {
    if (/👩|♀|woman|female/i.test(c)) return 'female';
    if (/👨|♂|man|male/i.test(c)) return 'male';
  }
  // 主色线索：偏粉/红/紫视为女性偏好，偏蓝视为男性偏好（弱启发，仅作补充）。
  const colorMatch = clues.find((c) => /^#?[0-9a-fA-F]{6}$/.test(c.replace('#', '')));
  if (colorMatch) {
    const hex = colorMatch.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if (r > 180 && b < 120) return 'female';
    if (b > 180 && r < 120) return 'male';
  }
  return null;
}

/**
 * 根据名字 + 头像自动分配一个阿里云音色。
 * - 先用头像/emoji/主色推断性别偏好，圈定候选音池（female / male）。
 * - 再用 name 稳定哈希得到索引，在候选池中选一个「尽量不与已分配角色重复」的值。
 * - 结果确定且跨会话一致；对同一 contact 幂等。
 *
 * @param {{id?: string, name?: string, avatar?: string, emoji?: string, color?: string}} contact
 * @returns {string} 阿里云发音人名（'cally' | 'abby' | 'andy' | 'harry' | 'eric'）
 */
export function assignDefaultVoice(contact) {
  const key = contact?.id || contact?.name || '';
  if (assignedVoices.has(key)) return assignedVoices.get(key);

  const pref = inferGenderPref(contact);
  const pool =
    pref === 'male' ? MALE_VOICES : pref === 'female' ? FEMALE_VOICES : KNOWN_EN_VOICES;
  const name = contact?.name || key || 'contact';
  const hash = hashString(name);

  // 在候选池中按 hash 索引顺序选一个，并跳过已被其他角色占用的音色。
  const taken = new Set(assignedVoices.values());
  let chosen = null;
  for (let i = 0; i < pool.length; i++) {
    const candidate = pool[(hash + i) % pool.length];
    if (!taken.has(candidate)) {
      chosen = candidate;
      break;
    }
  }
  // 池子全被占（理论上不会，因为池 >= 2）或池为空时，退化为按 hash 直接取。
  if (!chosen) chosen = pool.length > 0 ? pool[hash % pool.length] : KNOWN_EN_VOICES[hash % KNOWN_EN_VOICES.length];

  assignedVoices.set(key, chosen);
  return chosen;
}

const VOICE_KEY_PREFIX = 'speakup_voice_';

/** 读取某角色被手动覆盖的音色（无覆盖返回 null） */
export function getContactVoiceOverride(contactId) {
  if (!contactId) return null;
  const v = localStorage.getItem(VOICE_KEY_PREFIX + contactId);
  return v || null;
}

/** 写入某角色被手动覆盖的音色（清空则传 '' 或 null，即移除覆盖回到默认分配） */
export function setContactVoiceOverride(contactId, voice) {
  if (!contactId) return;
  if (!voice) {
    localStorage.removeItem(VOICE_KEY_PREFIX + contactId);
    return;
  }
  localStorage.setItem(VOICE_KEY_PREFIX + contactId, voice);
}

/**
 * 返回某角色最终生效的音色：手动覆盖优先，否则按名字+头像自动分配。
 *
 * @param {{id?: string, name?: string, avatar?: string, emoji?: string, color?: string}} contact
 * @returns {string}
 */
export function getEffectiveVoice(contact) {
  const override = getContactVoiceOverride(contact?.id);
  if (override && KNOWN_EN_VOICES.includes(override)) return override;
  return assignDefaultVoice(contact || {});
}

/**
 * 读取某阿里云发音人对应的 CosyVoice 音色 id（功能2）。
 * 初值为占位 ''（由用户在百炼试听后填入真实 id）。缺失 / 未知返回 ''。
 * @param {string} aliyunVoice 阿里云发音人名（如 'cally'）
 * @returns {string}
 */
export function getCosyVoiceId(aliyunVoice) {
  return ALIYUN_VOICE_OPTIONS.find((o) => o.value === aliyunVoice)?.cosyVoiceId || '';
}

/**
 * CosyVoice 模型（百炼）。初值 cosyvoice-v3-flash；
 * 若用户实际开通的是 v2，请在百炼确认后改为 cosyvoice-v2
 * （v3 与 v2 音色名不通用，选定模型后需对应选音色）。
 * @type {string}
 */
export const COSYVOICE_MODEL = 'cosyvoice-v3-flash';
