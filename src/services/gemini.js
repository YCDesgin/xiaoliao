// DeepSeek API service (OpenAI-compatible)
// Model: deepseek-chat — cheap, fast, great English

const API_BASE = 'https://api.deepseek.com/v1/chat/completions';

/**
 * Send a message and get a response from DeepSeek.
 */
export async function chatWithAI(apiKey, systemPrompt, messages) {
  if (!apiKey) throw new Error('API key not configured');

  const chatMessages = [];

  // DeepSeek supports native system role
  if (systemPrompt) {
    chatMessages.push({ role: 'system', content: systemPrompt });
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
      max_tokens: 256,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API error (${response.status}): ${err}`);
  }

  const data = await response.json();

  const text = data.choices?.[0]?.message?.content || '';

  if (!text) {
    throw new Error('Empty response from API');
  }

  return text.trim();
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
      "reasonZh": "一段中文说明，用初学者能懂的大白话解释为什么这样说更好，30字以内"
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
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
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
