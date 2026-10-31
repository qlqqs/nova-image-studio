'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { serveFile } = require('./files');

const MAX_BYTES = 1024 * 1024 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;

function assertDownloadUrl(value, allowHttp = false) {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) || url.username || url.password) {
    throw new Error('视频下载只允许 HTTPS');
  }
  return url;
}

async function downloadResult(url, destination, { allowHttp = false, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const partial = `${destination}.part`;
  try {
    let target = assertDownloadUrl(url, allowHttp);
    for (let redirects = 0; ; redirects++) {
      const response = await fetch(target, { redirect: 'manual', signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (redirects === 3) throw new Error('视频下载重定向超过 3 次');
        const location = response.headers.get('location');
        if (!location) throw new Error('视频下载重定向缺少地址');
        target = assertDownloadUrl(new URL(location, target), allowHttp);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`视频下载失败 (${response.status})`); }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel(); throw new Error('视频文件超过 1GB 上限');
      }
      let bytes = 0;
      const limiter = new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        done(bytes > maxBytes ? new Error('视频文件超过 1GB 上限') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(partial), { signal: controller.signal });
      fs.renameSync(partial, destination);
      return { bytes, mime: response.headers.get('content-type')?.split(';')[0] || 'video/mp4' };
    }
  } finally {
    clearTimeout(timer);
    fs.rmSync(partial, { force: true });
  }
}

function createResultStore({ directory, allowHttp = false }) {
  fs.mkdirSync(directory, { recursive: true });
  async function save(taskId, assets) {
    const result = [];
    try {
      for (const [index, asset] of assets.entries()) {
        const filename = `${taskId}-${index}.mp4`;
        const saved = await downloadResult(asset.url, path.join(directory, filename), { allowHttp });
        result.push({ kind: asset.kind, mime: saved.mime, url: `/api/nova/plugin-results/${taskId}/${index}`,
          ...(asset.durationSec !== undefined ? { durationSec: asset.durationSec } : {}) });
      }
      return result;
    } catch (error) { remove(taskId); throw error; }
  }
  function remove(taskId) {
    for (const file of fs.readdirSync(directory)) {
      if (file.startsWith(`${taskId}-`)) fs.rmSync(path.join(directory, file), { force: true });
    }
  }
  function serve(req, res, taskId, index, asset) {
    serveFile(req, res, path.join(directory, `${taskId}-${index}.mp4`), asset.mime || 'video/mp4');
  }
  return { save, remove, serve };
}

module.exports = { createResultStore, downloadResult, assertDownloadUrl, MAX_BYTES, TIMEOUT_MS };
