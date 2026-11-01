# Seedance 视频

内置插件 `qx-seedance` 使用 Ark 任务协议，经 sub2api 网关调用 `doubao-seedance-2-0-260128` / `doubao-seedance-2-5-260628`（界面显示 Seedance 2.0 / 2.5）。
网关账号的 model_mapping 负责映射到 mmgate 的实际模型 ID。

## 模式与参数

- 文生视频、图生视频、首尾帧、参考生成、视频编辑、视频延长。
- 分辨率：2.0 支持 480p / 720p / 1080p / 4k；2.5 支持 480p / 720p / 1080p；默认 720p。
- 比例：adaptive / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 / 21:9；默认 adaptive。2.5 首帧/首尾帧仅 adaptive。
- 时长：2.0 为 4–15 秒，2.5 为 4–30 秒；两者均支持 -1 自动，默认 5 秒。自动时长分别按 15 / 30 秒预估；编辑不传 duration。
- generate_audio 默认 true；watermark 固定 false（mmgate 忽略此参数，默认无水印）。
- 参考图片 / 视频 / 音频数量上限：2.0 为 9 / 3 / 3，2.5 为 30 / 10 / 10。参考视频总时长上限分别为 15 / 30 秒。
- 编辑/延长使用一个原视频，同样遵守视频总时长上限。2.5 编辑的原视频至少 4 秒。
- 2.0 不能仅使用参考音频，需同时提供参考图片或视频。

## 素材与结果

`media.<key>` 为字符串数组，接受上传返回的内部地址及 HTTPS 公网链接。
上传素材仅在提交上游时转换为签名公开链接，有效期 24 小时。外链原样透传。
槽名：firstFrame、lastFrame、referenceImages、referenceVideos、referenceAudios、sourceVideo。

上传预览：`/api/nova/plugin-media/<file>/preview`，嵌入模式检查归属。
结果下载到 `NOVA_VIDEO_DIR`（嵌入镜像默认 `/data/videos`）；返回鉴权地址
`/api/nova/plugin-results/<taskId>/<n>`。前端用会话 fetch→blob 播放、下载。
任务从终态起保留 `NOVA_VIDEO_RETENTION_DAYS` 天（默认 3）；素材随任务过期清理。

轮询间隔 10 秒，最多 12 小时。Key 只在内存中；重启后未完成任务标记失败并保留上游任务 ID。

## 校验

```bash
cd backend
npm run plugins:verify qx-seedance
node --test test/plugin-runtime.test.js test/plugin-storage.test.js test/embed-server.integration.test.js
```

fixtures 共 9 个提交快照：六种模式，以及 2.0 的 4k + 自动时长、2.5 的 30 图 + 10 音频上限、2.0 默认参数。
规格按 2026-10-31 的变更 01（mmgate /v1/models 快照）更新；角色及请求结构沿用创建任务文档。
manifest 价格为 720p 普通档展示兜底，实际单价按网关分组的分辨率档位取值；有参考视频时使用对应的 -ref 档。
