// DeepSeek API service (OpenAI-compatible)
// Model: deepseek-chat — cheap, fast, great English

const API_BASE = 'https://api.deepseek.com/v1/chat/completions';

/**
 * 归一化单条单词释义：保证 { word, zh, phonetic } 形态。
 * - 缺 word / zh → 返回 null（非法条目，调用方应丢弃）；
 * - phonetic 缺省补 ''（优雅降级，不报错）。
 * @param {object} d
 * @returns {{word:string,zh:string,phonetic:string}|null}
 */
export function normalizeWordDef(d) {
  if (!d || typeof d !== 'object') return null;
  if (typeof d.word !== 'string' || typeof d.zh !== 'string') return null;
  return {
    word: d.word,
    zh: d.zh,
    phonetic: typeof d.phonetic === 'string' ? d.phonetic : '',
  };
}

/** 归一化单词释义数组：过滤非法条目，保留 {word,zh,phonetic}。 */
export function normalizeWordDefsArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeWordDef).filter(Boolean);
}

/**
 * 从模型文本中提取第一个完整 JSON 对象（兼容 markdown 代码块）。
 * 提取失败 / 解析失败均抛错，交由调用方优雅降级。
 * @param {string} text
 * @returns {object}
 */
function parseJsonObject(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('未找到 JSON 对象');
  return JSON.parse(m[0]);
}

/**
 * 容错规范化：保证每个 mistake 都有 wordDefs 数组（B01），并保留 phonetic。
 * 解析失败 / 字段缺失都不抛错，缺省补 []，便于逐词释义优雅降级。
 * @param {object} review
 * @returns {object}
 */
export function normalizeWordDefs(review) {
  if (!review || typeof review !== 'object' || !Array.isArray(review.mistakes)) return review;
  review.mistakes = review.mistakes.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const defs = Array.isArray(m.wordDefs) ? normalizeWordDefsArray(m.wordDefs) : [];
    return { ...m, wordDefs: defs };
  });
  return review;
}

/**
 * 让 AI 在回复时顺带输出关键单词「音标 + 中文释义」的指令（功能1）。
 * 要求模型只返回 JSON：{"reply": <自然英文回复>, "wordDefs": [{word,zh,phonetic}]}，
 * 老调用方不传 withWordDefs，则模型按原样输出纯文本，互不影响。
 */
const WORD_DEFS_INSTRUCTION = `When you reply, ALSO emit a small machine-readable block so the learner can tap any word to see its phonetic and Chinese meaning.
Respond with ONLY a JSON object (no markdown code blocks, no other text) in this exact shape:
{"reply": "<your natural English reply to the user, exactly as you normally would>", "wordDefs": [{"word": "<lowercase english word taken from YOUR reply>", "zh": "<中文释义，用初学者能懂的大白话>", "phonetic": "<IPA phonetic, e.g. /həˈloʊ/">"}]}
List 1-4 useful words from your reply. If none are worth explaining, use "wordDefs": []. Keep "reply" natural and conversational (do NOT change your normal reply style).`;

/**
 * Send a message and get a response from DeepSeek.
 *
 * @param {string} apiKey
 * @param {string} systemPrompt
 * @param {Array<{role:string,text:string}>} messages
 * @param {object} [opts] - { withWordDefs?: boolean }
 *   当 withWordDefs 为 true 时，本函数返回 { text, wordDefs:[{word,zh,phonetic}] }；
 *   否则保持旧行为，返回纯文本字符串（兼容旧调用方与测试）。
 * @returns {string|{text:string, wordDefs:Array}}
 */
export async function chatWithAI(apiKey, systemPrompt, messages, opts = {}) {
  if (!apiKey) throw new Error('API key not configured');

  const chatMessages = [];

  // DeepSeek supports native system role
  if (systemPrompt) {
    chatMessages.push({
      role: 'system',
      content: opts.withWordDefs ? `${systemPrompt}\n\n${WORD_DEFS_INSTRUCTION}` : systemPrompt,
    });
  }

  // Add conversation messages
  for (const msg of messages) {
    chatMessages.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.text,
    });
  }

  const response = await fetch(API_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: chatMessages,
      temperature: 0.9,
      // 开启 wordDefs 时回复需容纳 JSON 结构，适当放大 token 上限
      max_tokens: opts.withWordDefs ? 400 : 256,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API error (${response.status}): ${err}`);
  }

  const data = await response.json();

  const raw = data.choices?.[0]?.message?.content || '';

  if (!raw) {
    throw new Error('Empty response from API');
  }

  // 功能1：解析 AI 顺带输出的 wordDefs；解析失败优雅回退为纯文本（wordDefs 置空）。
  if (opts.withWordDefs) {
    try {
      const parsed = parseJsonObject(raw);
      const text = (typeof parsed.reply === 'string' && parsed.reply.trim())
        ? parsed.reply.trim()
        : raw.trim();
      return { text, wordDefs: normalizeWordDefsArray(parsed.wordDefs) };
    } catch {
      return { text: raw.trim(), wordDefs: [] };
    }
  }

  return raw.trim();
}

/**
 * Review a conversation and generate a structured recap focused on the
 * learner's own English (the "You:" lines). Produces expression/grammar
 * corrections plus a warm summary.
 *
 * Returns a structured JSON object, or null on failure:
 * {
 *   summary: string,
 *   summaryZh: string,
 *   score: number (0-100),
 *   mistakes: [{ original, corrected, reason, reasonZh }],
 *   newWords: string[],
 *   suggestions: string[],
 * }
 */
export async function reviewConversation(apiKey, systemPrompt, messages) {
  if (!apiKey) return null;

  const conversationText = messages
    .map(m => `${m.role === 'user' ? 'You' : 'Friend'}: ${m.text}`)
    .join('\n');

  const reviewPrompt = `You are an English speaking coach reviewing a conversation between a learner (You) and a native-speaking friend (Friend).

Analyze ONLY the lines starting with "You:" — that is the learner's own English. Produce a structured review focused on expression and grammar-level correction (Type A), so the learner sounds more natural and correct.

Return ONLY valid JSON (no markdown code blocks, no other text) in this exact shape:
{
  "summary": "one warm, encouraging sentence summarizing how the chat went (under 25 words)",
  "summaryZh": "一句中文总结，用初学者能懂的大白话鼓励一下，25字以内",
  "score": 72,
  "mistakes": [
    {
      "original": "the exact learner phrase/sentence to improve (verbatim from a You: line)",
      "corrected": "a more natural or more correct version",
      "reason": "one short friendly explanation in English (under 20 words)",
      "reasonZh": "一段中文说明，用初学者能懂的大白话解释为什么这样说更好，30字以内",
      "wordDefs": [
        { "word": "a key word taken from the 'corrected' sentence, lowercase, punctuation stripped", "zh": "该词的中文释义（大白话）", "phonetic": "该词的音标，如 /ˈɡɑːrdn/" }
      ]
    }
  ],
  "newWords": ["useful word or phrase from this conversation 1", "..."],
  "suggestions": ["1-3 specific concrete tips for next time", "..."]
}

Rules:
- "reasonZh": write a plain-Chinese explanation for beginners (under 30 characters) telling WHY the correction is better — friendly, not academic.
- "summaryZh": a plain-Chinese one-sentence summary for beginners (under 25 characters) — warm and encouraging, not literal translation of summary.
- score is an integer 0-100 reflecting communication flow and effort; do NOT deduct for accent.
- mistakes: pick 2-4 of the most valuable corrections; if the learner did great, give 1 gentle tip or an empty array.
- wordDefs (per mistake): list the 1-3 most useful words that appear in the "corrected" sentence and give a plain-Chinese meaning, as wordDefs: [{ "word": <lowercase, no punctuation>, "zh": <中文释义>, "phonetic": <IPA 音标，如 /ɡɑːrdn/> }]. If the corrected sentence has no noteworthy words, use an empty array [].
- newWords: useful vocabulary or phrases that appeared in the conversation.
- suggestions: 1-3 specific, actionable improvements for next time.
- Tone: encouraging and supportive, never harsh.

Conversation:
${conversationText}`;

  try {
    const response = await fetch(API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: reviewPrompt }],
        temperature: 0.7,
        max_tokens: 600,
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return normalizeWordDefs(JSON.parse(jsonMatch[0]));
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Translate English text to Chinese.
 */
export async function translateText(apiKey, text) {
  if (!apiKey || !text) return null;

  try {
    const response = await fetch(API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'You are a translator. Translate the given English text into natural Chinese. Return ONLY the Chinese translation, no explanations.' },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
        max_tokens: 256,
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Look up a single English word: definition + example + Chinese meaning.
 */
export async function defineWord(apiKey, word) {
  if (!apiKey || !word) return null;

  try {
    const response = await fetch(API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: 'You are an English dictionary. Given a word, return ONLY a JSON object with: "phonetic" (pronunciation), "meaning" (Chinese meaning), "example" (one simple English example sentence). No other text.',
          },
          { role: 'user', content: word },
        ],
        temperature: 0.3,
        max_tokens: 200,
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch {
    return null;
  }
}

/**
 * 批量查词：从一段英文文本中提取关键单词，返回 [{word, zh, phonetic}]。
 * 用于用户消息点击单词时的 lazy 预生成（功能1）。容错：失败 / 无结果返回 []。
 *
 * @param {string} apiKey
 * @param {string} text 消息原文
 * @returns {Promise<Array<{word:string,zh:string,phonetic:string}>>}
 */
export async function defineWords(apiKey, text) {
  if (!apiKey || !text || !text.trim()) return [];
  try {
    const response = await fetch(API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: 'You are an English dictionary. Given an English sentence or phrase, pick the 1-4 most useful words worth explaining to a Chinese beginner and return ONLY a JSON array (no markdown) like: [{"word":"lowercase english word","zh":"该词的中文释义（大白话）","phonetic":"/ipa phonetic/"}]. Include the IPA phonetic for each. If the text has no noteworthy words, return [].',
          },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
        max_tokens: 300,
      }),
    });

    if (!response.ok) return [];
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return [];
    let arr;
    try { arr = JSON.parse(m[0]); } catch { return []; }
    return normalizeWordDefsArray(arr);
  } catch {
    return [];
  }
}
