'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID, randomBytes, createHmac, timingSafeEqual } = require('crypto');
const { serveFile: serveStoredFile } = require('./files');

const MEDIA_EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
};

const CONTENT_TYPE_BY_EXT = Object.entries(MEDIA_EXT_BY_MIME).reduce((acc, [mime, ext]) => {
  if (!acc[ext]) acc[ext] = mime;
  return acc;
}, {});

const KIND_DEFAULT_MAX_BYTES = {
  images: 10 * 1024 * 1024,
  videos: 50 * 1024 * 1024,
  audios: 15 * 1024 * 1024,
};

const KIND_PREFIX = { images: 'image/', videos: 'video/', audios: 'audio/' };
const KIND_LABEL = { images: '图片', videos: '视频', audios: '音频' };

const MEDIA_URL_PREFIX = '/api/nova/plugin-media/';

/**
 * @param {object} deps 宿主注入的依赖，避免这个模块反过来 require server.js
 */
function createMediaStore({ db, getRuntimeEnv, parseIntegerEnv, createHttpError, getClientIp, normalizeBaseUrl, dataDir }) {
  const MEDIA_DIR = process.env.NOVA_PLUGIN_MEDIA_DIR
    || path.join(dataDir || path.join(__dirname, '..', 'data'), 'plugin-media');
  let signingSecret;
  const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

  function getTtlMs() {
    return parseIntegerEnv(getRuntimeEnv().NOVA_PLUGIN_MEDIA_TTL_MS, DEFAULT_TTL_MS, {
      min: 5 * 60 * 1000,
      max: 30 * 24 * 60 * 60 * 1000,
    });
  }

  function initSchema() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_name TEXT NOT NULL UNIQUE,
        hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        task_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_media_hash_task ON plugin_media(hash, task_id);
      CREATE INDEX IF NOT EXISTS idx_plugin_media_task ON plugin_media(task_id);
    `);
    if (!db.prepare('PRAGMA table_info(plugin_media)').all().some(column => column.name === 'user_id')) {
      db.exec('ALTER TABLE plugin_media ADD COLUMN user_id TEXT');
    }
    signingSecret = getRuntimeEnv().NOVA_MEDIA_SIGNING_SECRET;
    if (!signingSecret) {
      const keyPath = path.join(dataDir || path.dirname(MEDIA_DIR), 'media-signing.key');
      fs.mkdirSync(path.dirname(keyPath), { recursive: true });
      if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
      fs.chmodSync(keyPath, 0o600);
      signingSecret = fs.readFileSync(keyPath, 'utf8').trim();
    }
  }

  /**
   * 每类素材的 MIME 前缀与体积上限。上限走 env，所以每次读取而不是模块加载时固化，
   * 保证改 .env 后不用重启也能生效。
   */
  function getKindRules() {
    const env = getRuntimeEnv();
    const cap = (value, fallback) =>
      parseIntegerEnv(value, fallback, { min: 1024, max: 2 * 1024 * 1024 * 1024 });
    return {
      images: {
        prefix: KIND_PREFIX.images,
        label: KIND_LABEL.images,
        maxBytes: cap(env.NOVA_MEDIA_MAX_IMAGE_BYTES, KIND_DEFAULT_MAX_BYTES.images),
      },
      videos: {
        prefix: KIND_PREFIX.videos,
        label: KIND_LABEL.videos,
        maxBytes: cap(env.NOVA_MEDIA_MAX_VIDEO_BYTES, KIND_DEFAULT_MAX_BYTES.videos),
      },
      audios: {
        prefix: KIND_PREFIX.audios,
        label: KIND_LABEL.audios,
        maxBytes: cap(env.NOVA_MEDIA_MAX_AUDIO_BYTES, KIND_DEFAULT_MAX_BYTES.audios),
      },
    };
  }

  /** 供前端展示与预校验：每类素材的可选格式与体积上限。 */
  function getLimitsForClient() {
    const rules = getKindRules();
    const result = {};
    for (const [kind, rule] of Object.entries(rules)) {
      const mimeTypes = Object.keys(MEDIA_EXT_BY_MIME).filter(mime => mime.startsWith(rule.prefix));
      const extensions = [...new Set(mimeTypes.map(mime => MEDIA_EXT_BY_MIME[mime]))];
      result[kind] = { label: rule.label, maxBytes: rule.maxBytes, mimeTypes, extensions };
    }
    return result;
  }

  function ensureDir() {
    if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
  }

  /** 优先用显式配置的公网地址；否则按反代头 / Host 头推断。 */
  function resolvePublicBaseUrl(req) {
    const configured = normalizeBaseUrl(getRuntimeEnv().NOVA_PUBLIC_BASE_URL);
    if (configured) return configured;
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const host = forwardedHost || String(req.headers.host || '').split(',')[0].trim();
    if (!host) return '';
    return `${forwardedProto || 'http'}://${host}`;
  }

  function readBodyToBuffer(req, maxBytes, overLimitMessage) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let aborted = false;
      req.on('data', chunk => {
        if (aborted) return;
        size += chunk.length;
        if (size > maxBytes) {
          aborted = true;
          chunks.length = 0;
          req.resume();
          reject(createHttpError(413, 'PAYLOAD_TOO_LARGE', overLimitMessage));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
      req.on('error', reject);
    });
  }

  /** 从素材 URL 中取出本机文件名；不是本机地址则返回 null。 */
  function extractFileName(url) {
    if (typeof url !== 'string') return null;
    const match = url.match(/\/api\/nova\/plugin-media\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
    if (!match) return null;
    return match[1].includes('..') ? null : match[1];
  }

  /**
   * 把请求里引用到的素材绑定到任务上。绑定后该素材随任务一起清理，
   * 并且不再参与去重复用——避免删掉任务 A 时连带删掉任务 B 还在用的文件。
   */
  function bindToTask(taskId, urls) {
    const fileNames = [...new Set((urls || []).map(extractFileName).filter(Boolean))];
    if (fileNames.length === 0) return 0;
    const stmt = db.prepare('UPDATE plugin_media SET task_id = ? WHERE file_name = ? AND task_id IS NULL');
    let bound = 0;
    db.transaction(() => {
      for (const fileName of fileNames) bound += stmt.run(taskId, fileName).changes;
    })();
    return bound;
  }

  /** 任务清理即素材清理。 */
  function deleteTaskMedia(taskId) {
    let rows;
    try {
      rows = db.prepare('SELECT file_name FROM plugin_media WHERE task_id = ?').all(taskId);
    } catch {
      return { total: 0, success: 0, failed: 0 };
    }
    if (rows.length === 0) return { total: 0, success: 0, failed: 0 };

    let success = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const filePath = path.join(MEDIA_DIR, row.file_name);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        success++;
      } catch (error) {
        failed++;
        console.warn(`[plugin-media] 素材删除失败: ${row.file_name}`, error && error.message);
      }
    }
    db.prepare('DELETE FROM plugin_media WHERE task_id = ?').run(taskId);
    return { total: rows.length, success, failed };
  }

  function cleanupExpired() {
    try {
      if (!fs.existsSync(MEDIA_DIR)) return;
      const ttlMs = getTtlMs();
      const now = Date.now();
      const bound = new Set(db.prepare('SELECT file_name FROM plugin_media WHERE task_id IS NOT NULL').all().map(row => row.file_name));
      for (const name of fs.readdirSync(MEDIA_DIR)) {
        if (bound.has(name)) continue;
        const filePath = path.join(MEDIA_DIR, name);
        try {
          if (now - fs.statSync(filePath).mtimeMs > ttlMs) {
            fs.unlinkSync(filePath);
            // 同步清掉记录，否则表会随时间无限增长
            db.prepare('DELETE FROM plugin_media WHERE file_name = ?').run(name);
          }
        } catch { /* 单个文件失败不影响其余清理 */ }
      }
      // 文件已不在（手动删除 / 上一轮失败）的孤立记录也一并清掉
      for (const row of db.prepare('SELECT file_name FROM plugin_media').all()) {
        if (!fs.existsSync(path.join(MEDIA_DIR, row.file_name))) {
          db.prepare('DELETE FROM plugin_media WHERE file_name = ?').run(row.file_name);
        }
      }
    } catch (error) {
      console.warn('[plugin-media] 清理临时素材失败', error && error.message);
    }
  }

  /**
   * 接收原始二进制素材（Content-Type 即 MIME），落盘后返回可供上游拉取的 URL。
   * 直接收二进制而不是 multipart：省掉一层解析，也避免 base64 膨胀 33%。
   */
  async function handleUpload(req, kind, plugin) {
    const rule = getKindRules()[kind];
    if (!rule) {
      throw createHttpError(400, 'INVALID_MEDIA_TYPE', `不支持的素材类型: ${kind}`);
    }
    // 插件必须在 manifest.media 里申报过这一类素材，否则不给上传
    const declared = plugin && plugin.manifest.media && plugin.manifest.media[kind];
    if (!declared || !Number.isInteger(declared.maxCount) || declared.maxCount <= 0) {
      throw createHttpError(400, 'MEDIA_KIND_NOT_DECLARED', `插件 ${plugin ? plugin.id : ''} 未申报${rule.label}素材`);
    }

    const mimeType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = MEDIA_EXT_BY_MIME[mimeType];
    if (!mimeType.startsWith(rule.prefix) || !ext) {
      throw createHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', `不支持的${rule.label}格式: ${mimeType || '未知'}`);
    }

    const baseUrl = resolvePublicBaseUrl(req);
    if (!baseUrl) {
      throw createHttpError(500, 'NO_PUBLIC_BASE_URL', '无法确定素材的公网地址，请配置 NOVA_PUBLIC_BASE_URL');
    }

    const maxMb = Math.round(rule.maxBytes / 1024 / 1024);
    const buffer = await readBodyToBuffer(
      req,
      rule.maxBytes,
      `${rule.label}体积超过上限 ${maxMb}MB，请压缩后重试`,
    );
    if (buffer.length === 0) {
      throw createHttpError(400, 'EMPTY_MEDIA', '素材内容为空');
    }

    ensureDir();

    // 嵌入模式按用户 ID 去重；独立模式沿用 IP，同一素材跨用户分别存储。
    const ip = getClientIp(req);
    const hash = createHash('sha256').update(String(req.novaUser?.userId || ip || '')).update('\n').update(buffer).digest('hex');
    // 只复用还没绑定任务的记录：已绑定的会随那个任务被清理，复用会导致误删。
    const existing = db.prepare(
      'SELECT file_name FROM plugin_media WHERE hash = ? AND task_id IS NULL ORDER BY id DESC LIMIT 1',
    ).get(hash);

    let fileName;
    if (existing && fs.existsSync(path.join(MEDIA_DIR, existing.file_name))) {
      fileName = existing.file_name;
    } else {
      fileName = `${randomUUID()}.${ext}`;
      fs.writeFileSync(path.join(MEDIA_DIR, fileName), buffer);
      db.prepare(`
        INSERT INTO plugin_media (file_name, hash, kind, bytes, task_id, created_at, user_id)
        VALUES (?, ?, ?, ?, NULL, ?, ?)
      `).run(fileName, hash, kind, buffer.length, new Date().toISOString(), req.novaUser?.userId || null);
    }

    return { url: `${baseUrl}${MEDIA_URL_PREFIX}${fileName}`, previewUrl: `${MEDIA_URL_PREFIX}${fileName}/preview`, bytes: buffer.length };
  }

  function safeFileName(fileName) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(fileName || '')) && !fileName.includes('..');
  }

  function canPreview(fileName, user) {
    const row = db.prepare('SELECT user_id FROM plugin_media WHERE file_name = ?').get(fileName);
    return !!row && !!user && row.user_id === user.userId;
  }

  function validateForTask(media, plugin, user) {
    for (const [key, urls] of Object.entries(media)) {
      const field = plugin.uiSchema.fields.find(field => field.key === key);
      for (const url of urls) {
        const name = extractFileName(url);
        if (!name) continue;
        const row = db.prepare('SELECT * FROM plugin_media WHERE file_name = ?').get(name);
        if (!row || row.task_id || row.kind !== field.kind || (user && row.user_id !== user.userId)
          || !fs.existsSync(path.join(MEDIA_DIR, name))) {
          throw createHttpError(404, 'NOT_FOUND', '素材不存在或已绑定任务');
        }
      }
    }
  }

  function sign(fileName, exp) {
    return createHmac('sha256', signingSecret).update(`${fileName}\n${exp}`).digest('hex');
  }

  function publicUrl(fileName, baseUrl, now = Date.now()) {
    const exp = Math.floor(now / 1000) + 86400;
    return `${baseUrl}/api/nova/public-media/${fileName}?exp=${exp}&sig=${sign(fileName, exp)}`;
  }

  function signedMedia(media, baseUrl) {
    return Object.fromEntries(Object.entries(media).map(([key, urls]) => [key, urls.map(url => {
      const name = extractFileName(url);
      return name ? publicUrl(name, baseUrl) : url;
    })]));
  }

  function verifySignature(fileName, exp, signature, now = Date.now()) {
    if (!safeFileName(fileName) || !/^\d+$/.test(String(exp || '')) || Number(exp) <= Math.floor(now / 1000)
      || !/^[a-f0-9]{64}$/.test(String(signature || ''))) return false;
    return timingSafeEqual(Buffer.from(sign(fileName, exp), 'hex'), Buffer.from(signature, 'hex'));
  }

  function serveFile(req, res, fileName, cacheControl = 'private, no-store') {
    if (!safeFileName(fileName)) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(fileName).slice(1).toLowerCase();
    serveStoredFile(req, res, path.join(MEDIA_DIR, fileName), CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream', cacheControl);
  }

  return {
    MEDIA_DIR,
    MEDIA_URL_PREFIX,
    initSchema,
    getKindRules,
    getLimitsForClient,
    handleUpload,
    serveFile,
    canPreview,
    validateForTask,
    signedMedia,
    verifySignature,
    publicUrl,
    resolvePublicBaseUrl,
    bindToTask,
    deleteTaskMedia,
    cleanupExpired,
    extractFileName,
  };
}

module.exports = { createMediaStore, MEDIA_EXT_BY_MIME, MEDIA_URL_PREFIX };
