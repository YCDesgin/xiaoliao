import { useSyncStatus } from '../hooks/useSyncStatus';

// 同步状态小条（A07）：idle/syncing/synced/error + 失败重试入口。
// 以底部居中的浮层呈现，避免遮挡聊天内容（与输入框保持间距）。
export default function SyncStatus({ contactId, onSynced }) {
  const { state, error, lastSyncAt, retry } = useSyncStatus();
  if (state === 'idle') return null;

  const onRetry = () => {
    if (!contactId) return;
    retry(contactId)
      .then(() => { if (onSynced) onSynced(contactId); })
      .catch(() => {});
  };

  const label =
    state === 'syncing' ? '同步中…'
      : state === 'synced' ? '已同步'
        : state === 'error' ? (error || '同步失败') : '';

  const dotColor =
    state === 'syncing' ? 'bg-[#2aabee] animate-pulse'
      : state === 'synced' ? 'bg-[#4caf50]'
        : 'bg-[#e74c3c]';

  return (
    <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-30 fade-in">
      <div className="flex items-center gap-2 bg-[#17212b]/95 border border-[#1c2a3a] rounded-full pl-3 pr-2 py-1.5 shadow-lg">
        <span className={`w-2 h-2 rounded-full ${dotColor}`} />
        <span className="text-[11px] text-[#cdd6df] whitespace-nowrap">{label}</span>
        {state === 'error' && (
          <button
            onClick={onRetry}
            className="text-[11px] text-[#2aabee] hover:text-[#3db9f5] px-2 py-0.5 rounded-lg hover:bg-[#1f2c3a] transition-colors"
          >
            重试
          </button>
        )}
        {state === 'synced' && lastSyncAt && (
          <span className="text-[10px] text-[#5a6a7a]">
            {new Date(lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
    </div>
  );
}
