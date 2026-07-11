import { useState } from 'react';
import { generateCode, bindFromCode, clearBinding, getBinding, isBound } from '../services/syncService';

// 同步码管理弹窗：生成 / 输入绑定 / 解绑。
// 复用 SettingsModal 的遮罩与卡片视觉风格（原生 Tailwind class，无 MUI）。
export default function SyncModal({ onClose, onChange }) {
  const [mode, setMode] = useState('menu'); // 'menu' | 'generate' | 'input'
  const [input, setInput] = useState('');
  const [generated, setGenerated] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmUnbind, setConfirmUnbind] = useState(false);

  const bound = isBound();
  const current = getBinding();

  const doGenerate = () => {
    const b = generateCode();
    setGenerated(b);
    setMode('generate');
    setCopied(false);
    setError('');
  };

  const copyCode = async () => {
    if (!generated) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(generated.full);
      } else {
        const ta = document.createElement('textarea');
        ta.value = generated.full;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('复制失败，请长按手动选择整码');
    }
  };

  const doBind = () => {
    setError('');
    if (!input.trim()) { setError('请输入同步码'); return; }
    const ok = bindFromCode(input.trim());
    if (!ok) { setError('同步码格式不正确（应为 syncId.token）'); return; }
    if (onChange) onChange();
    if (onClose) onClose();
  };

  const doUnbind = () => {
    clearBinding();
    setConfirmUnbind(false);
    setMode('menu');
    setGenerated(null);
    setInput('');
    if (onChange) onChange();
  };

  return (
    <div
      className="absolute inset-0 z-50 bg-black/50 flex items-center justify-center p-4 fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose && onClose(); }}
    >
      <div
        className="w-full max-w-sm bg-[#17212b] border border-[#1c2a3a] rounded-2xl p-5 shadow-lg slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-[#f5f5f5]">数据同步</h2>
          <span className="text-[10px] text-[#2aabee] border border-[#2aabee]/30 bg-[#2aabee]/10 rounded-full px-2 py-0.5">🦐 虾聊</span>
        </div>
        <p className="text-[11px] text-[#707579] mt-1 mb-4">
          生成同步码后，在另一台设备粘贴即可跨端共享聊天与复盘（语音仅留本地）。
        </p>

        {mode === 'menu' && (
          <div className="space-y-2">
            <div className="text-[11px] text-[#707579] mb-1">
              当前状态：{bound
                ? <span className="text-[#4caf50]">已绑定（{current?.syncId?.slice(0, 6)}…）</span>
                : <span className="text-[#e67e22]">未绑定</span>}
            </div>
            <button
              onClick={doGenerate}
              className="w-full py-2.5 bg-[#2aabee] hover:bg-[#3db9f5] text-white rounded-xl text-sm font-medium transition-colors"
            >
              生成同步码
            </button>
            <button
              onClick={() => { setMode('input'); setError(''); }}
              className="w-full py-2.5 bg-[#0e1621] hover:bg-[#1f2c3a] text-[#f5f5f5] rounded-xl text-sm border border-[#1c2a3a] transition-colors"
            >
              输入同步码绑定
            </button>
            {bound && (
              <button
                onClick={() => setConfirmUnbind(true)}
                className="w-full py-2.5 text-[#e74c3c] hover:bg-[#e74c3c]/10 rounded-xl text-sm transition-colors"
              >
                解绑当前同步码
              </button>
            )}
          </div>
        )}

        {mode === 'generate' && generated && (
          <div className="space-y-3">
            <p className="text-[12px] text-[#707579]">把这串同步码复制到另一台设备：</p>
            <div className="bg-[#0e1621] border border-[#1c2a3a] rounded-xl px-3 py-3 break-all text-[13px] text-[#f5f5f5] select-all font-mono">
              {generated.full}
            </div>
            <div className="flex gap-2">
              <button
                onClick={copyCode}
                className="flex-1 py-2.5 bg-[#2aabee] hover:bg-[#3db9f5] text-white rounded-xl text-sm font-medium transition-colors"
              >
                {copied ? '已复制 ✓' : '复制整码'}
              </button>
              <button
                onClick={() => { setMode('menu'); setGenerated(null); }}
                className="flex-1 py-2.5 bg-[#0e1621] hover:bg-[#1f2c3a] text-[#f5f5f5] rounded-xl text-sm border border-[#1c2a3a] transition-colors"
              >
                返回
              </button>
            </div>
            <p className="text-[11px] text-[#5a6a7a]">
              同步码 = 命名空间 + 令牌，离线生成、长期有效。把它当作「共享钥匙」保管好。
            </p>
          </div>
        )}

        {mode === 'input' && (
          <div className="space-y-3">
            <label className="block text-xs text-[#707579] mb-1.5">粘贴同步码</label>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="例如 1a2b3c4d5e.6f7g8h9i0j1k2l3m4n5o6p"
              className="w-full bg-[#0e1621] border border-[#1c2a3a] rounded-xl px-3 py-2.5 text-sm text-[#f5f5f5] placeholder-[#5a6a7a] focus:outline-none focus:border-[#2aabee] transition-colors font-mono"
            />
            {error && <p className="text-[11px] text-[#e74c3c]">{error}</p>}
            <div className="flex gap-2">
              <button
                onClick={doBind}
                className="flex-1 py-2.5 bg-[#2aabee] hover:bg-[#3db9f5] text-white rounded-xl text-sm font-medium transition-colors"
              >
                绑定
              </button>
              <button
                onClick={() => { setMode('menu'); setInput(''); setError(''); }}
                className="flex-1 py-2.5 bg-[#0e1621] hover:bg-[#1f2c3a] text-[#f5f5f5] rounded-xl text-sm border border-[#1c2a3a] transition-colors"
              >
                返回
              </button>
            </div>
          </div>
        )}

        {confirmUnbind && (
          <div className="space-y-3">
            <p className="text-[13px] text-[#f5f5f5] leading-relaxed">
              确定解绑？本机将不再与该命名空间同步。云端数据默认保留（仅清本机绑定）。
            </p>
            <div className="flex gap-2">
              <button
                onClick={doUnbind}
                className="flex-1 py-2.5 bg-[#e74c3c] hover:bg-[#c0392b] text-white rounded-xl text-sm font-medium transition-colors"
              >
                确认解绑
              </button>
              <button
                onClick={() => setConfirmUnbind(false)}
                className="flex-1 py-2.5 bg-[#0e1621] hover:bg-[#1f2c3a] text-[#f5f5f5] rounded-xl text-sm border border-[#1c2a3a] transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-3 mt-5">
          <button
            onClick={() => onClose && onClose()}
            className="flex-1 py-2.5 text-sm text-[#707579] hover:text-[#aaaaaa] hover:bg-[#1f2c3a] rounded-xl transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
