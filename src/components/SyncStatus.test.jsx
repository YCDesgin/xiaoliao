/**
 * SyncStatus 显示逻辑回归测试。
 *
 * 需求（用户原话）：
 *   「同步正常的情况下是不显示标记了。只在同步异常的时候会出现异常标记。」
 *
 * 即：
 *   - idle / syncing / synced → 不渲染任何底部浮层标记（返回 null）。
 *   - error → 渲染红色圆点 + 文案 + 重试按钮。
 *
 * 我们通过 vi.mock('../hooks/useSyncStatus') 注入不同 state 返回值，
 * 断言各状态对应的渲染结果，不触碰任何其它源文件。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import SyncStatus from './SyncStatus';

// 用 vi.hoisted 持有可变引用，供 vi.mock 工厂闭包安全地读取
// （避免 vitest 把 vi.mock 提升到顶部后引用未初始化变量的问题）。
const { mockStatusRef, mockRetry } = vi.hoisted(() => ({
  mockStatusRef: { current: { state: 'idle', error: null, lastSyncAt: null } },
  // 模拟 useSyncStatus 返回的 retry：返回已 resolve 的 Promise，便于点击后走 .then 分支。
  mockRetry: vi.fn(() => Promise.resolve()),
}));

vi.mock('../hooks/useSyncStatus', () => ({
  useSyncStatus: () => ({
    state: mockStatusRef.current.state,
    error: mockStatusRef.current.error,
    lastSyncAt: mockStatusRef.current.lastSyncAt,
    retry: mockRetry,
  }),
}));

// 每次用例前重置为 idle，并清空 retry spy。
beforeEach(() => {
  mockStatusRef.current = { state: 'idle', error: null, lastSyncAt: null };
  mockRetry.mockClear();
  cleanup();
});

describe('SyncStatus 显示逻辑（仅异常显示标记）', () => {
  it('state=idle → 渲染结果为空，找不到任何标记/圆点/按钮', () => {
    mockStatusRef.current = { state: 'idle', error: null, lastSyncAt: null };
    const { container } = render(<SyncStatus contactId="c1" />);
    expect(container.querySelector('.fade-in')).toBeNull();
    expect(screen.queryByText('重试')).toBeNull();
    expect(screen.queryByText('同步中…')).toBeNull();
    expect(screen.queryByText('已同步')).toBeNull();
  });

  it('state=syncing → 渲染结果为空', () => {
    mockStatusRef.current = { state: 'syncing', error: null, lastSyncAt: null };
    const { container } = render(<SyncStatus contactId="c1" />);
    expect(container.querySelector('.fade-in')).toBeNull();
    expect(screen.queryByText('重试')).toBeNull();
    expect(screen.queryByText('同步中…')).toBeNull();
  });

  it('state=synced → 渲染结果为空', () => {
    mockStatusRef.current = { state: 'synced', error: null, lastSyncAt: Date.now() };
    const { container } = render(<SyncStatus contactId="c1" />);
    expect(container.querySelector('.fade-in')).toBeNull();
    expect(screen.queryByText('重试')).toBeNull();
    expect(screen.queryByText('已同步')).toBeNull();
  });

  it('state=error → 渲染异常标记：文案含错误原因 + 重试按钮 + 红色圆点', () => {
    mockStatusRef.current = { state: 'error', error: '网络超时', lastSyncAt: null };
    const { container } = render(<SyncStatus contactId="c1" />);

    // 浮层容器存在
    expect(container.querySelector('.fade-in')).not.toBeNull();

    // 文案含错误原因
    expect(screen.getByText('网络超时')).toBeInTheDocument();

    // 重试按钮存在且可点击
    const retryBtn = screen.getByText('重试');
    expect(retryBtn).toBeInTheDocument();

    // 红色异常圆点（bg-[#e74c3c]）
    const dot = container.querySelector('span.rounded-full');
    expect(dot).not.toBeNull();
    expect(dot.className).toContain('bg-[#e74c3c]');
  });

  it('state=error 且 error 为空 → 回退为「同步失败」文案', () => {
    mockStatusRef.current = { state: 'error', error: null, lastSyncAt: null };
    render(<SyncStatus contactId="c1" />);
    expect(screen.getByText('同步失败')).toBeInTheDocument();
    expect(screen.getByText('重试')).toBeInTheDocument();
  });

  it('state=error → 点击「重试」以 contactId 调用 retry', () => {
    mockStatusRef.current = { state: 'error', error: '网络超时', lastSyncAt: null };
    render(<SyncStatus contactId="c1" onSynced={() => {}} />);

    const retryBtn = screen.getByText('重试');
    fireEvent.click(retryBtn);

    expect(mockRetry).toHaveBeenCalledTimes(1);
    expect(mockRetry).toHaveBeenCalledWith('c1');
  });
});
