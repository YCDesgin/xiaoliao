import { useEffect } from 'react';

/**
 * Pick a color for the score chip based on the value.
 * >=80 green, >=60 blue, otherwise red — matching the rest of the UI palette.
 * @param {number} score
 * @returns {string} hex color
 */
function scoreColor(score) {
  if (score >= 80) return '#4caf50';
  if (score >= 60) return '#2aabee';
  return '#e74c3c';
}

/**
 * HistoryList — a fixed overlay modal listing past reviews for a contact.
 *
 * Props:
 *  - contactName: string (displayed in the header)
 *  - reviews: Array (newest first; each entry has { id, generatedAt, review })
 *  - onSelect: (entry) => void — invoked when a row is clicked
 *  - onClose: () => void — invoked when the close (✕) button is clicked
 */
export default function HistoryList({ contactName, reviews, onSelect, onClose }) {
  // Lock background scroll while the overlay is open for a cleaner feel.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div className="fixed inset-0 z-[70] bg-[#0e1621]/80 backdrop-blur-sm flex items-center justify-center">
      <div className="w-[90%] max-w-[380px] max-h-[80%] bg-[#17212b] border border-[#1c2a3a] rounded-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1c2a3a] flex-shrink-0">
          <div className="text-sm font-medium text-[#f5f5f5]">
            复盘历史{contactName ? <span className="text-[#707579]"> · {contactName}</span> : null}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-full hover:bg-[#1f2c3a] flex items-center justify-center text-[#707579] hover:text-[#f5f5f5] transition-colors text-base flex-shrink-0"
          >
            ✕
          </button>
        </div>

        {/* List */}
        <div className="overflow-y-auto flex-1 px-3 py-3">
          {reviews.length === 0 ? (
            <div className="px-4 py-10 text-center text-[13px] text-[#707579]">还没有复盘记录</div>
          ) : (
            reviews.map((r) => {
              const score = typeof r.review?.score === 'number' ? r.review.score : 0;
              const dateLabel = new Date(r.generatedAt).toLocaleDateString([], { month: 'long', day: 'numeric' });
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onSelect(r)}
                  className="w-full text-left px-3 py-2.5 mb-2 rounded-xl bg-[#0e1621] hover:bg-[#1f2c3a] transition-colors flex items-center gap-3 border border-[#1c2a3a] last:mb-0"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-[#f5f5f5]">{dateLabel}</div>
                    <div className="text-[12px] text-[#707579] truncate">{r.review?.summary || ''}</div>
                  </div>
                  <div className="text-2xl font-bold flex-shrink-0" style={{ color: scoreColor(score) }}>
                    {score}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
