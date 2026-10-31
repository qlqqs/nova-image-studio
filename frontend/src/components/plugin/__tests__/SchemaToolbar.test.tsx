import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SchemaToolbar } from '@/components/plugin/SchemaToolbar';
import { parseRemoteMediaUrl, SchemaMediaField } from '@/components/plugin/SchemaMediaField';
import type { InstalledPlugin } from '@/lib/plugin-schema';

const plugin = {
  id: 'v', name: 'v', version: '1', kind: 'video', description: '', author: '', homepage: '', outputs: ['video'],
  credential: { source: 'client', label: 'k', defaultBaseUrl: '' }, media: {}, models: [],
  uiSchema: {
    apiVersion: 1,
    layout: { toolbar: ['duration', 'audio'] },
    modelSelector: { facets: [{ key: 'mode', label: '方式' }], facetOptions: { mode: [{ value: 't2v', label: '文生' }] }, variants: [{ model: 'm', mode: 't2v' }] },
    fields: [
      { key: 'duration', type: 'select-grid', label: '时长', suffix: '秒', showIf: { mode: ['t2v'] }, options: [{ value: 5, label: '5' }] },
      { key: 'audio', type: 'switch', label: '生成声音' },
    ],
  },
} as InstalledPlugin;

describe('SchemaToolbar', () => {
  it('选项字段遵守 showIf', () => {
    const { rerender } = render(<SchemaToolbar plugin={plugin} facets={{ mode: 't2v' }} fields={{ duration: 5, audio: true }} model="m" onFacetChange={vi.fn()} onFieldChange={vi.fn()} />);
    expect(screen.getByText('5秒')).toBeTruthy();
    rerender(<SchemaToolbar plugin={plugin} facets={{ mode: 'edit' }} fields={{ duration: 5, audio: true }} model="m" onFacetChange={vi.fn()} onFieldChange={vi.fn()} />);
    expect(screen.queryByText('5秒')).toBeNull();
  });

  it('switch 渲染为开关按钮，点击切换取值', () => {
    const onFieldChange = vi.fn();
    render(<SchemaToolbar plugin={plugin} facets={{ mode: 't2v' }} fields={{ duration: 5, audio: true }} model="m" onFacetChange={vi.fn()} onFieldChange={onFieldChange} />);
    const toggle = screen.getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(onFieldChange).toHaveBeenCalledWith('audio', false);
  });
});

describe('素材公网链接', () => {
  it('只接受 https://', () => {
    expect(parseRemoteMediaUrl(' https://cdn.example.com/a.mp4 ')).toBe('https://cdn.example.com/a.mp4');
    expect(parseRemoteMediaUrl('http://cdn.example.com/a.mp4')).toBeNull();
    expect(parseRemoteMediaUrl('/api/nova/plugin-media/a.mp4')).toBeNull();
    expect(parseRemoteMediaUrl('javascript:alert(1)')).toBeNull();
  });

  it('允许链接的素材槽可以填写链接，非 https 给出提示', () => {
    const onAddUrl = vi.fn();
    render(
      <SchemaMediaField
        field={{ key: 'referenceVideos', type: 'media', kind: 'videos', label: '参考视频', style: 'chip', allowRemoteUrl: true }}
        maxCount={3}
        required={false}
        items={[]}
        busy={false}
        onPick={vi.fn()}
        onRemove={vi.fn()}
        onAddUrl={onAddUrl}
      />,
    );
    fireEvent.click(screen.getByText('链接'));
    const input = screen.getByLabelText('参考视频链接');
    fireEvent.change(input, { target: { value: 'http://x.com/a.mp4' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('请填写 https:// 开头的公网链接')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'https://x.com/a.mp4' } });
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    expect(onAddUrl).toHaveBeenCalledWith('https://x.com/a.mp4');
  });

  it('链接素材显示主机名与末段路径', () => {
    render(
      <SchemaMediaField
        field={{ key: 'referenceVideos', type: 'media', kind: 'videos', label: '参考视频', style: 'chip' }}
        maxCount={3}
        required={false}
        items={[
          { id: 'r', slot: 'referenceVideos', kind: 'videos', file: null, remoteUrl: 'https://cdn.example.com/x/y/clip.mp4', previewUrl: '' },
          { id: 'f', slot: 'referenceVideos', kind: 'videos', file: new File(['x'], 'local.mp4'), previewUrl: 'blob:1', durationSec: 8.24 },
        ]}
        busy={false}
        onPick={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText('cdn.example.com/…/clip.mp4')).toBeTruthy();
    expect(screen.getByText('8.2秒')).toBeTruthy();
    expect(screen.queryByText('链接')).toBeNull();
  });
});
