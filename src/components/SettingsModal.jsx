import { useState, useRef } from 'react';

// Edge-TTS voice options for the "AI 语音" dropdown.
const VOICE_OPTIONS = [
  { value: 'en-US-JennyNeural', label: 'Jenny (美式女声)' },
  { value: 'en-US-GuyNeural', label: 'Guy (美式男声)' },
  { value: 'en-GB-SoniaNeural', label: 'Sonia (英式女声)' },
  { value: 'en-AU-NatashaNeural', label: 'Natasha (澳式女声)' },
];

export default function SettingsModal({ apiKey, userAvatar, onSave, onSaveAvatar, onClose }) {
  // Fallback to an empty string so the input never becomes an uncontrolled
  // (null/undefined) field and `key.trim()` below can never throw.
  const [key, setKey] = useState(apiKey || '');
  const [saved, setSaved] = useState(false);
  // Cloud TTS Worker URL (empty = not configured). Read once on open, using the
  // same localStorage key as getCloudTtsUrl() in services/speech.js.
  const [cloudUrl, setCloudUrl] = useState(
    () => localStorage.getItem('speakup_cloud_tts_url') || '',
  );
  // Preferred AI voice; default to Jenny so the dropdown always has a value.
  const [preferredVoice, setPreferredVoice] = useState(
    localStorage.getItem('speakup_preferred_voice') || 'en-US-JennyNeural',
  );
  const fileRef = useRef(null);

  const handleSave = () => {
    onSave((key || '').trim());
    // Persist cloud TTS URL (clears storage when empty) — identical logic to
    // setCloudTtsUrl() in services/speech.js, kept local so this component has
    // no dependency on the (partially-mocked) speech service in tests.
    const trimmedUrl = (cloudUrl || '').trim();
    if (trimmedUrl) localStorage.setItem('speakup_cloud_tts_url', trimmedUrl);
    else localStorage.removeItem('speakup_cloud_tts_url');
    // Persist preferred AI voice.
    localStorage.setItem('speakup_preferred_voice', preferredVoice || 'en-US-JennyNeural');
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleAvatarClick = () => fileRef.current?.click();

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onSaveAvatar(reader.result);
    reader.readAsDataURL(file);
  };

  return (
    <div className="absolute inset-0 z-50 bg-black/50 flex items-center justify-center p-4 fade-in" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-sm bg-[#17212b] border border-[#1c2a3a] rounded-2xl p-5 shadow-lg slide-up" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-[#f5f5f5]">Settings</h2>
          <span className="text-[10px] text-[#2aabee] border border-[#2aabee]/30 bg-[#2aabee]/10 rounded-full px-2 py-0.5">🦐 虾聊</span>
        </div>

        {/* Avatar section */}
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={handleAvatarClick}
            className="w-14 h-14 rounded-full overflow-hidden flex-shrink-0 hover:opacity-80 transition-opacity relative group"
          >
            {userAvatar ? (
              <img src={userAvatar} alt="Your avatar" className="w-full h-full object-cover" />
            ) : (
              <svg viewBox="0 0 40 40" className="w-full h-full">
                <rect width="40" height="40" rx="20" fill="#F4A460"/>
                <ellipse cx="15" cy="18" rx="5" ry="6" fill="white"/><ellipse cx="25" cy="18" rx="5" ry="6" fill="white"/>
                <circle cx="15" cy="18" r="2.5" fill="#333"/><circle cx="25" cy="18" r="2.5" fill="#333"/>
                <ellipse cx="20" cy="24" rx="3" ry="2" fill="#FF8C69"/>
                <path d="M18 25 Q20 29 22 25" stroke="#333" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
                <path d="M5 10 L12 15 M35 10 L28 15" stroke="#F4A460" strokeWidth="3" fill="#F4A460"/>
              </svg>
            )}
            <div className="absolute inset-0 bg-black/30 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <span className="text-white text-lg">📷</span>
            </div>
          </button>
          <div>
            <div className="text-sm text-[#f5f5f5] font-medium">Your Avatar</div>
            <p className="text-[11px] text-[#707579] mt-0.5">Tap to upload a photo</p>
            {userAvatar && (
              <button
                onClick={() => onSaveAvatar(null)}
                className="text-[11px] text-[#e74c3c] hover:underline mt-0.5"
              >
                Reset to default
              </button>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
        </div>

        {/* API Key */}
        <div className="mt-5">
          <p className="text-xs text-[#707579] mb-2">
            Get your key at{' '}
            <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer" className="text-[#2aabee] underline">
              platform.deepseek.com
            </a>
          </p>
          <label className="block text-xs text-[#707579] mb-1.5">DeepSeek API Key</label>
          <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="sk-..."
            className="w-full bg-[#0e1621] border border-[#1c2a3a] rounded-xl px-3 py-2.5 text-sm text-[#f5f5f5] placeholder-[#5a6a7a] focus:outline-none focus:border-[#2aabee] transition-colors" />
          {!key && (
            <p className="text-[11px] text-[#e67e22] mt-1.5">
              请先填写 API Key 再保存，否则对话、语音与复盘功能将无法使用。
            </p>
          )}
        </div>

        {/* Cloud TTS address */}
        <div className="mt-5">
          <label className="block text-xs text-[#707579] mb-1.5">云端 TTS 地址</label>
          <input type="url" value={cloudUrl} onChange={e => setCloudUrl(e.target.value)} placeholder="https://xiaoliao-tts.xxx.workers.dev"
            className="w-full bg-[#0e1621] border border-[#1c2a3a] rounded-xl px-3 py-2.5 text-sm text-[#f5f5f5] placeholder-[#5a6a7a] focus:outline-none focus:border-[#2aabee] transition-colors" />
          <p className="text-[11px] text-[#5a6a7a] mt-1.5">部署 Cloudflare Worker 后填入，手机可听 AI 语音</p>
        </div>

        {/* AI voice selection */}
        <div className="mt-4">
          <label className="block text-xs text-[#707579] mb-1.5">AI 语音</label>
          <select value={preferredVoice} onChange={e => setPreferredVoice(e.target.value)}
            className="w-full bg-[#0e1621] border border-[#1c2a3a] rounded-xl px-3 py-2.5 text-sm text-[#f5f5f5] focus:outline-none focus:border-[#2aabee] transition-colors">
            {VOICE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="flex gap-3 mt-5">
          <button onClick={onClose} className="flex-1 py-2.5 text-sm text-[#707579] hover:text-[#aaaaaa] hover:bg-[#1f2c3a] rounded-xl transition-colors">Cancel</button>
          <button onClick={handleSave} className="flex-1 py-2.5 text-sm bg-[#2aabee] hover:bg-[#3db9f5] text-white rounded-xl font-medium transition-colors">
            {saved ? 'Saved!' : 'Save'}
          </button>
        </div>
        <p className="text-[10px] text-[#5a6a7a] mt-3 text-center">Key is stored locally.</p>
      </div>
    </div>
  );
}
