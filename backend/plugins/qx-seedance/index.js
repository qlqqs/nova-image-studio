'use strict';

const { InputError } = require('../../plugin-runtime/input');
const TASKS_PATH = '/api/v3/contents/generations/tasks';

function validateInput({ facets, fields, media }) {
  if (facets.mode === 'reference') {
    if (!['referenceImages', 'referenceVideos', 'referenceAudios'].some(key => media[key]?.length)) {
      throw new InputError('参考生成至少需要一项素材');
    }
    if (facets.targetModel === 'seedance-2.0' && !media.referenceImages?.length && !media.referenceVideos?.length) {
      throw new InputError('Seedance 2.0 不能仅使用参考音频，请添加参考图片或视频');
    }
  }
  if (facets.targetModel === 'seedance-2.5' && ['i2v', 'firstlast'].includes(facets.mode) && fields.ratio !== 'adaptive') {
    throw new InputError('Seedance 2.5 首帧和首尾帧模式的画面比例只能为 adaptive');
  }
}

function buildSubmit(ctx) {
  const { fields, media, facet } = ctx;
  const content = [{ type: 'text', text: fields.prompt }];
  const add = (key, type, role) => {
    for (const url of media[key] || []) content.push({ type, [type]: { url }, role });
  };
  add('firstFrame', 'image_url', 'first_frame');
  add('lastFrame', 'image_url', 'last_frame');
  add('referenceImages', 'image_url', 'reference_image');
  add('referenceVideos', 'video_url', 'reference_video');
  add('referenceAudios', 'audio_url', 'reference_audio');
  add('sourceVideo', 'video_url', 'reference_video');
  return {
    method: 'POST', url: `${ctx.baseUrl}${TASKS_PATH}`,
    headers: { Authorization: `Bearer ${ctx.apiKey}` },
    body: {
      model: ctx.model, content, resolution: fields.resolution, ratio: fields.ratio,
      ...(facet.mode !== 'edit' ? { duration: fields.duration } : {}),
      generate_audio: fields.generate_audio, watermark: false,
      ...(['edit', 'extend'].includes(facet.mode) ? { omni_reference_task_type: facet.mode } : {}),
    },
  };
}

function buildQuery(taskId, ctx) {
  return { method: 'GET', url: `${ctx.baseUrl}${TASKS_PATH}/${encodeURIComponent(taskId)}`,
    headers: { Authorization: `Bearer ${ctx.apiKey}` } };
}

function parseTaskResult(payload) {
  if (payload.status === 'succeeded') {
    if (!payload.content?.video_url) return { state: 'failed', error: '上游报告完成但没有返回可用的产物地址' };
    return { state: 'completed', progress: 100, assets: [{ kind: 'video', mime: 'video/mp4', url: payload.content.video_url,
      ...(payload.duration !== undefined ? { durationSec: payload.duration } : {}) }] };
  }
  if (['failed', 'cancelled', 'expired'].includes(payload.status)) {
    return { state: 'failed', error: payload.error?.message || '视频生成失败' };
  }
  return { state: 'processing' };
}

module.exports = { buildSubmit, buildQuery, parseTaskResult, validateInput };
