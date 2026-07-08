import { useState } from 'react';
import { contacts } from '../data/contacts';
import SettingsModal from './SettingsModal';

export default function ContactList({ apiKey, userAvatar, onSaveApiKey, onSaveAvatar, onOpenChat }) {
  const [showSettings, setShowSettings] = useState(false);

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-[#17212b] border-b border-[#1c2a3a]">
        <button className="w-8 h-8 rounded-full flex items-center justify-center text-[#aaaaaa] text-lg">
          ☰
        </button>
        <h1 className="text-base font-semibold text-[#f5f5f5]">🦐 虾聊</h1>
        <button
          onClick={() => setShowSettings(true)}
          className="w-8 h-8 rounded-full hover:bg-[#1f2c3a] flex items-center justify-center text-[#aaaaaa] transition-colors text-lg"
          title="Settings"
        >
          ⚙
        </button>
      </div>

      {!apiKey && (
        <div className="mx-3 mt-2 px-3 py-2 bg-[#2b1a1a] border border-[#e74c3c]/20 rounded-lg text-xs text-[#e74c3c]/90">
          在「设置」里填入 API Key 就能开始聊天啦～
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1 divide-y divide-[#1c2a3a]/50">
        {contacts.map((c) => (
          <button
            key={c.id}
            onClick={() => onOpenChat(c.id)}
            disabled={!apiKey}
            className="w-full flex items-center gap-3 px-4 py-5 hover:bg-[#1f2c3a] transition-colors text-left disabled:opacity-30 active:bg-[#253545]"
          >
            {/* Avatar image */}
            <div className="w-14 h-14 rounded-full overflow-hidden relative flex-shrink-0 bg-[#1f2c3a]">
              <img
                src={c.avatar}
                alt={c.name}
                className="w-full h-full object-cover"
              />
              <div className="absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full bg-[#4caf50] border-[2.5px] border-[#17212b]" />
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-[#f5f5f5] truncate">{c.name}</span>
                <span className="text-[11px] text-[#707579] flex-shrink-0 ml-2">now</span>
              </div>
              <p className="text-[13px] text-[#707579] truncate mt-0.5">{c.description}</p>
            </div>
          </button>
        ))}
      </div>

      <div className="px-4 py-2 text-center text-[11px] text-[#707579] bg-[#17212b] border-t border-[#1c2a3a]">
        和 AI 朋友聊英语，开口就能练
      </div>

      <div className="px-4 pb-3 text-center text-[10px] text-[#5a6066] bg-[#17212b]">
        说错也没关系，虾聊陪你练 🦐
      </div>

      {showSettings && (
        <SettingsModal
          apiKey={apiKey}
          userAvatar={userAvatar}
          onSave={onSaveApiKey}
          onSaveAvatar={onSaveAvatar}
          onClose={() => setShowSettings(false)}
        />
      )}
    </>
  );
}
