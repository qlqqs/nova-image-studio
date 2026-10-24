import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

vi.mock('@/components/embed/ModelKeySettings', () => ({ ModelKeySettings: () => <div>model-key-settings</div> }));
vi.mock('@/components/settings/PluginsSettings', () => ({ PluginsSettings: () => <div>plugins-settings</div> }));

import { EmbedSettingsModal, visibleEmbedSettingsTabs } from '@/components/embed/EmbedSettingsModal';
import { applyParentMessage, parseParentMessage, resetEmbedSessionForTests } from '@/lib/embed/session';

function signIn(role: 'admin' | 'user') {
  act(() => {
    applyParentMessage(parseParentMessage({
      type: 'sub2api:nova-studio-session', revision: 1, sessionToken: 'jwt', userId: 3, role, theme: 'light',
    }));
  });
}

describe('嵌入设置页', () => {
  afterEach(() => resetEmbedSessionForTests());

  it('插件分区只对管理员可见', () => {
    expect(visibleEmbedSettingsTabs(false)).toEqual(['models', 'backup']);
    expect(visibleEmbedSettingsTabs(true)).toEqual(['models', 'plugins', 'backup']);
  });

  it('普通用户：模型与密钥 | 备份，无插件、无关于，有源码链接', () => {
    signIn('user');
    render(<EmbedSettingsModal isOpen onClose={() => undefined} />);
    expect(screen.getByRole('tab', { name: /模型与密钥/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /备份/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /插件/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /关于/ })).toBeNull();
    expect(screen.getByRole('link', { name: /源码/ })).toHaveAttribute('href', 'https://github.com/qlqqs/nova-image-studio');
    expect(screen.getByText('model-key-settings')).toBeInTheDocument();
  });

  it('普通用户请求插件页时回到模型与密钥', () => {
    signIn('user');
    render(<EmbedSettingsModal isOpen initialTab="plugins" onClose={() => undefined} />);
    expect(screen.queryByText('plugins-settings')).toBeNull();
    expect(screen.getByText('model-key-settings')).toBeInTheDocument();
  });

  it('管理员可见插件分区', () => {
    signIn('admin');
    render(<EmbedSettingsModal isOpen initialTab="plugins" onClose={() => undefined} />);
    expect(screen.getByRole('tab', { name: /插件/ })).toBeInTheDocument();
    expect(screen.getByText('plugins-settings')).toBeInTheDocument();
  });
});
