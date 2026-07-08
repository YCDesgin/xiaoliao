import { render, screen } from '@testing-library/react';
import SettingsModal from './SettingsModal';

// The exact core class string both the Settings badge and the EndReview header
// badge must share (only layout-only classes like `ml-auto` may differ).
export const BRAND_BADGE_CLASS =
  'text-[10px] text-[#2aabee] border border-[#2aabee]/30 bg-[#2aabee]/10 rounded-full px-2 py-0.5';

const baseProps = {
  apiKey: 'sk-test-key',
  userAvatar: null,
  onSave: () => {},
  onSaveAvatar: () => {},
  onClose: () => {},
};

describe('SettingsModal — 🦐 虾聊 brand badge', () => {
  it('still renders the "Settings" heading', () => {
    render(<SettingsModal {...baseProps} />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders the 🦐 虾聊 brand badge', () => {
    render(<SettingsModal {...baseProps} />);
    expect(screen.getByText('🦐 虾聊')).toBeInTheDocument();
  });

  it('uses the exact brand badge core class string (no extra/missing classes)', () => {
    render(<SettingsModal {...baseProps} />);
    const badge = screen.getByText('🦐 虾聊');
    // Every token of the spec'd core class must be present.
    BRAND_BADGE_CLASS.split(' ').forEach((token) => {
      expect(badge.className).toContain(token);
    });
  });
});
