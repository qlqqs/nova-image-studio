import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ uploadPluginMedia: vi.fn(), createPluginTask: vi.fn() }));
vi.mock('@/lib/plugin-task-client', () => client);

import { __resetUploadRunnerForTests, getUploadProgress, startPluginJob, type PendingMedia } from '@/lib/plugin-upload-runner';
import { __resetPluginJobsCacheForTests, loadPluginJobs, type PluginJob } from '@/lib/plugin-job-store';

const job: PluginJob = {
  id: 'job-1', status: 'uploading', pluginId: 'qx-seedance', pluginName: 'Seedance 视频', pluginVersion: '1.0.0',
  model: 'seedance-2.0', modelLabel: 'Seedance 2.0', prompt: 'p', facets: {}, fields: {}, paramSummary: [],
  estimatedCost: null, currency: 'CNY', createdAt: '2026-10-31T00:00:00Z',
};

function file(name: string): PendingMedia {
  return { id: name, slot: 'referenceVideos', kind: 'videos', file: new File(['x'], name, { type: 'video/mp4' }), previewUrl: '' };
}

describe('插件素材上传：本地文件与公网链接混合', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPluginJobsCacheForTests();
    client.uploadPluginMedia.mockImplementation(async (_plugin: string, f: File) => ({ url: `/api/nova/plugin-media/${f.name}` }));
    client.createPluginTask.mockResolvedValue('task-1');
  });

  afterEach(() => {
    __resetUploadRunnerForTests();
    vi.clearAllMocks();
  });

  it('公网链接不上传、不进进度列表，按原顺序与上传地址一起提交', async () => {
    const remote: PendingMedia = { id: 'r', slot: 'referenceVideos', kind: 'videos', file: null, remoteUrl: 'https://cdn.example.com/b.mp4', previewUrl: '' };
    startPluginJob({ job, items: [file('a.mp4'), remote, file('c.mp4')], buildPayload: () => ({ pluginId: 'qx-seedance', apiKey: 'sk', model: 'seedance-2.0', facets: {}, fields: {} }) });
    expect(getUploadProgress('job-1')?.map(item => item.name)).toEqual(['a.mp4', 'c.mp4']);
    await vi.waitFor(() => expect(client.createPluginTask).toHaveBeenCalled());
    expect(client.uploadPluginMedia).toHaveBeenCalledTimes(2);
    expect(client.createPluginTask).toHaveBeenCalledWith(expect.objectContaining({
      media: { referenceVideos: ['/api/nova/plugin-media/a.mp4', 'https://cdn.example.com/b.mp4', '/api/nova/plugin-media/c.mp4'] },
    }));
    expect(client.createPluginTask.mock.calls[0][0]).not.toHaveProperty('baseUrl');
    await vi.waitFor(() => expect(loadPluginJobs()[0]).toMatchObject({ status: 'processing', serverTaskId: 'task-1' }));
  });
});
