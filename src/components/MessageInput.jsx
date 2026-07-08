import { useState, useRef, useCallback } from 'react';
import { startRecording, stopRecording, supportsVoiceInput } from '../services/speech';

export default function MessageInput({ onSend, disabled }) {
  const [text, setText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [showTextInput, setShowTextInput] = useState(false);
  const recordingRef = useRef(false);
  const canRecord = supportsVoiceInput();

  const handleMicClick = useCallback(async () => {
    if (!canRecord || disabled) return;
    if (recordingRef.current) {
      recordingRef.current = false; setIsRecording(false); setIsTranscribing(true);
      const { transcript, audioBlob } = await stopRecording();
      setIsTranscribing(false);
      if (transcript?.trim()) onSend(transcript.trim(), audioBlob);
      return;
    }
    recordingRef.current = true; setIsRecording(true); setIsTranscribing(false);
    startRecording('en-US', null).catch(console.error).finally(() => {
      if (recordingRef.current) { recordingRef.current = false; setIsRecording(false); setIsTranscribing(false); }
    });
  }, [canRecord, disabled, onSend]);

  const handleSendText = () => { if (text.trim() && !disabled) { onSend(text.trim()); setText(''); } };

  return (
    <div className="bg-[#17212b] border-t border-[#1c2a3a] px-3 py-2">
      {isTranscribing && (
        <div className="mb-2 px-3 py-1.5 bg-[#0e1621] rounded-lg flex items-center gap-2 fade-in">
          <div className="w-3.5 h-3.5 border-2 border-[#2aabee]/30 border-t-[#2aabee] rounded-full animate-spin" />
          <div className="text-[11px] text-[#707579]">Transcribing...</div>
        </div>
      )}
      {showTextInput && (
        <div className="flex items-center gap-2 mb-2 fade-in">
          <div className="flex-1 flex items-center bg-[#0e1621] rounded-lg px-3">
            <input type="text" value={text} onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendText(); } }}
              placeholder="Message" disabled={disabled}
              className="flex-1 bg-transparent py-2.5 text-sm text-[#f5f5f5] placeholder-[#5a6a7a] focus:outline-none" autoFocus />
          </div>
          <button onClick={handleSendText} disabled={!text.trim() || disabled}
            className="w-9 h-9 rounded-full bg-[#2aabee] text-white flex items-center justify-center disabled:opacity-30 transition-opacity flex-shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button onClick={() => setShowTextInput(!showTextInput)}
          className={`w-10 h-10 rounded-full flex items-center justify-center text-lg transition-colors flex-shrink-0 ${showTextInput ? 'bg-[#2aabee]/15 text-[#2aabee]' : 'hover:bg-[#1f2c3a] text-[#707579]'}`}>
          ⌨
        </button>
        <button onClick={handleMicClick} disabled={!canRecord || disabled || isTranscribing}
          className={`flex-1 h-10 rounded-full flex items-center justify-center gap-2 text-sm font-medium transition-all ${isRecording ? 'bg-[#e74c3c] text-white recording-pulse relative' : isTranscribing ? 'bg-[#0e1621] text-[#2aabee]' : canRecord ? 'bg-[#0e1621] text-[#aaaaaa] hover:bg-[#1f2c3a]' : 'bg-[#0e1621] text-[#5a6a7a]'}`}>
          {isRecording ? (<><div className="w-2 h-2 rounded-full bg-white" /> <span>Tap to stop</span></>)
           : isTranscribing ? 'Transcribing...'
           : canRecord ? (<><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg> <span>Hold to talk</span></>)
           : 'Mic not supported'}
        </button>
      </div>
    </div>
  );
}
