// 单词释义缓存层（功能1：聊天点词看音标）。
//
// 设计依据（架构 §2 / §3 / §7）：
//   - 内存 Map 缓存同一会话内「单词释义」，命中即返回，绝不重复打 API；
//   - AI 回复的 wordDefs 随消息预生成，离线可用，通过 primeFromMessage 预热；
//   - 用户消息首次点击某词时 lazy 生成（批量 defineWords + 单词兜底 defineWord），
//     生成结果同时写回消息 metadata（由调用方负责持久化）；
//   - 旧数据无 phonetic 时优雅降级（normalizeWordDef 补 ''），不报错。
//
// 缓存 key： `${messageId}::${word.toLowerCase()}`。

import { defineWords, defineWord, normalizeWordDef } from './gemini';

/** 内存缓存：key -> WordDef { word, zh, phonetic } */
const cache = new Map();

function cacheKey(messageId, word) {
  return `${messageId}::${String(word || '').toLowerCase()}`;
}

/** 写入一条释义到缓存（已归一化为 {word,zh,phonetic}）。 */
function setDef(messageId, def) {
  const n = normalizeWordDef(def);
  if (!n) return;
  cache.set(cacheKey(messageId, n.word), n);
}

/**
 * 读取某消息内某单词的释义（命中内存缓存返回，否则 undefined）。
 * @param {string} messageId
 * @param {string} word
 * @returns {{word:string,zh:string,phonetic:string}|undefined}
 */
function get(messageId, word) {
  if (!messageId || !word) return undefined;
  return cache.get(cacheKey(messageId, word));
}

/**
 * 用一条消息已预生成的 wordDefs 预热缓存（AI 回复场景）。
 * @param {{id?:string, metadata?:{wordDefs?:Array}}} message
 */
function primeFromMessage(message) {
  if (!message || !message.id) return;
  const defs = message.metadata && Array.isArray(message.metadata.wordDefs)
    ? message.metadata.wordDefs
    : [];
  defs.forEach((d) => setDef(message.id, d));
}

/**
 * 确保某消息内某单词的释义可用：
 *   - 若内存已缓存该词 → 直接返回 [该词]（秒级命中，不再打 API）；
 *   - 否则批量 defineWords 生成整句释义并全部写入缓存；
 *   - 若批量结果中仍缺该特定词 → 单词 defineWord 兜底（优雅降级）；
 * 返回该消息的全部释义数组（供调用方写回 metadata 持久化）。
 *
 * @param {string} apiKey
 * @param {string} messageId
 * @param {string} text 消息原文（用于批量提取关键单词）
 * @param {string} [specificWord] 用户实际点击的单词（可选，用于兜底）
 * @returns {Promise<Array<{word:string,zh:string,phonetic:string}>>}
 */
async function ensureDefs(apiKey, messageId, text, specificWord) {
  if (!messageId) return [];

  // 已缓存该特定词 → 秒级返回，不再打 API
  if (specificWord && get(messageId, specificWord)) {
    return [get(messageId, specificWord)];
  }

  let defs = [];
  try {
    const batch = await defineWords(apiKey, text || '');
    if (Array.isArray(batch)) {
      defs = batch.map((d) => normalizeWordDef(d)).filter(Boolean);
      defs.forEach((d) => setDef(messageId, d));
    }
  } catch {
    defs = [];
  }

  // 仍缺该特定词 → 单单词兜底（不阻断点击）。
  // 注意 defineWord 返回 { phonetic, meaning, example }，需映射为 { word, zh, phonetic }。
  let target = specificWord ? get(messageId, specificWord) : null;
  if (!target && specificWord) {
    try {
      const single = await defineWord(apiKey, specificWord);
      if (single && single.meaning) {
        const n = {
          word: specificWord,
          zh: single.meaning,
          phonetic: typeof single.phonetic === 'string' ? single.phonetic : '',
        };
        setDef(messageId, n);
        target = n;
        defs.push(n);
      }
    } catch {
      /* 单单词兜底失败：保持 target 为 null，上层按缺失处理 */
    }
  }

  return defs;
}

export default {
  get,
  ensureDefs,
  primeFromMessage,
  /** 仅供测试：清空内存缓存 */
  __clear: () => cache.clear(),
};
