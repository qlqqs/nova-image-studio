'use strict';

const fs = require('node:fs');

/** 单段 Range 足够用于视频流式拉取和拖动。 */
function serveFile(req, res, filePath, contentType, cacheControl = 'private, no-store') {
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
  const size = fs.statSync(filePath).size;
  const headers = { 'Content-Type': contentType, 'Cache-Control': cacheControl, 'Accept-Ranges': 'bytes' };
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }); res.end(); return;
    }
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (start > end || start >= size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }); res.end(); return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  res.writeHead(status, { ...headers, 'Content-Length': Math.max(0, end - start + 1) });
  if (req.method === 'HEAD' || size === 0) { res.end(); return; }
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', error => res.destroy(error));
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

module.exports = { serveFile };
