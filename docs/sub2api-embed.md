# Sub2API 嵌入模式契约（qlqqs/nova-image-studio · 分支 sub2api-custom）

本分支把 Nova Studio 作为 sub2api-custom（QxAPI）控制台里的「创作工作台」运行。
上游独立模式（BYOK）保持原样；嵌入模式由开关启用，所有改动尽量集中在新增文件里，便于继续合并 tianjiangqiji/nova-image-studio。

参考实现：远端 `sub2api-embed`（nuotian4-spec 的嵌入版，v3.3.0 衍生），可用 `git show sub2api-embed/main:<path>` 查看；只移植思路与必要代码，不整体合并。

## 1. 开关

| 位置 | 开关 | 说明 |
|---|---|---|
| 后端 | `NOVA_EMBED_MODE=1` | 启用本文所有服务端约束 |
| 前端构建 | `NEXT_PUBLIC_NOVA_EMBED=1` | 启用嵌入 UI；同时 `basePath`/`assetPrefix` = `/_nova`，关闭 PWA service worker |

## 2. 路径与网络

- 浏览器只访问 sub2api 同源地址；sub2api 把 `/_nova/*`（静态）与 `/api/nova/*`（含 WebSocket `/api/nova/ws`）转发给 Nova（默认端口 3000）。
- 静态资源前缀 `/_nova`；API 仍在站点根 `/api/nova/*`（不是 `/_nova/api/nova/*`）。
- Nova 调上游一律走 `SUB2API_GATEWAY_URL`（内网，如 `http://sub2api:8080`），必须是无路径、凭据、查询串和 fragment 的 HTTP(S) origin；嵌入模式下缺失或非法则拒绝启动。

## 3. 身份（由 sub2api 注入）

sub2api 转发 `/api/nova/*`（除 `/api/nova/ws`）前校验用户 JWT，删除客户端自带的 `X-Sub2API-*` 头，再注入：

| 头 | 值 |
|---|---|
| `X-Sub2API-User-Id` | 用户 ID（正整数字符串） |
| `X-Sub2API-User-Role` | `admin` 或 `user` |
| `X-Forwarded-For` | 用户真实 IP（单个值） |
| `X-Real-IP` | 同上 |

Nova 规则：
- 只在 TCP 来源地址属于 `NOVA_TRUSTED_PROXY_CIDRS`（逗号分隔 CIDR，默认 `127.0.0.1/32,::1/128`）时读取这些头；来源不可信 → 403 `{ "error": "UNTRUSTED_SOURCE" }`。
- 缺少 / 非法 `X-Sub2API-User-Id` → 401 `{ "error": "UNAUTHENTICATED" }`。
- 静态资源不需要身份。

## 4. WebSocket

- `POST /api/nova/ws-ticket`（经 sub2api 鉴权）→ `{ "ticket": "<base64url 32 字节>", "expiresInSec": 60 }`；ticket 一次性、绑定 userId。
- 建连：`/api/nova/ws?ticket=<ticket>`；无效 / 过期 / 已用 → HTTP 握手返回 401，不建立 WebSocket。
- 连接绑定 userId：`subscribeTasks` 只接受本人任务（他人或不存在的 taskId 静默忽略），`subscribeQueue` 只推送本人的排队信息。

## 5. 数据归属

- 图片与插件任务均记录 `tasks.user_id`；上传素材记录 `plugin_media.user_id`。迁移前无归属的数据不自动分配给登录用户。
- 任务详情、ack、图片 `/api/nova/images/:taskId/:n` 及视频结果 `/api/nova/plugin-results/:taskId/:n`：`user_id` 不匹配或已过期一律 404（与不存在相同）。图片响应为 `private, no-store`；前端须通过带会话鉴权的 fetch 取 blob，不能用裸 `<img src>` / `<video src>` 或把 JWT 放进 URL。
- `/api/nova/plugin-tasks*` 与 `POST /api/nova/plugin-media` 对登录用户开放，任务详情与 ack 校验归属、过期时间。
- 素材预览为 `GET /api/nova/plugin-media/<file>/preview`，要求本人会话、支持 Range、`private, no-store`；原始素材 GET/HEAD 在嵌入模式一律 404。
- `GET` / `HEAD /api/nova/public-media/<file>?exp=<unix秒>&sig=<hex>` 仅校验签名和有效期，不要求会话。签名为 HMAC-SHA256(secret, `"<file>\n<exp>"`)，有效期 24 小时，错误/过期/缺文件均 404，支持 Range。sub2api 转发该路由前删除所有 `X-Sub2API-*` 身份头，不注入身份。
- `/api/nova/queue-status`：嵌入模式只返回本人的排队 / 运行数与全局是否繁忙，不返回全站明细。

## 6. 固定网关

- 嵌入模式忽略所有来自客户端的上游地址：任务 body 的 `baseUrl`、`x-nova-base-url`、插件 `defaultBaseUrl` 与凭据中的 `baseUrl`，一律使用 `SUB2API_GATEWAY_URL`（图片按协议补 `/v1`、`/v1beta`，Seedance 使用 `/api/v3/contents/generations/tasks`）。不放行任何官方地址。
- 所有发往网关的请求带 `X-Forwarded-For: <用户真实 IP>`（取自 sub2api 注入的值）。
- API Key 仍由前端随请求提供（用户在设置页选择的 sub2api Key），服务端只放内存，不落库。
- 网关请求禁止自动重定向，避免 307/308 将 Key、请求体转发到其他地址。用户 IP 随任务保存于内存，调度队列时不继承触发调度的另一个用户 IP。
- 插件提交和轮询只允许固定网关 origin，即使该 origin 是内网，也不依赖插件 manifest 的公网主机白名单。
- 视频成功后从上游结果 URL 下载到 `NOVA_VIDEO_DIR`（默认数据目录下 `videos/`，镜像为 `/data/videos`）。仅允许 HTTPS；最多 3 次重定向，每一跳重新检查协议；单文件上限 1GB、总超时 10 分钟。下载失败标记失败，明确提示上游已生成并计费、附上上游任务 ID。
- 本机模拟专用 `NOVA_RESULT_DOWNLOAD_ALLOW_HTTP=1` 允许 HTTP 下载，生产不配置。
- 图片结果下载也只能访问网关 origin，外部图片 URL 返回 `UPSTREAM_NOT_ALLOWED`，不会出网。支持第三方结果 URL 所需的受控下载策略尚未实现；这不是已完成的图片兼容性验收。

## 7. 限额与清理

- 嵌入模式关闭按 IP / apiKeyHash 的限流与单来源排队上限；保留全局并发 `NOVA_TASK_CONCURRENCY`。
- 图片使用 `NOVA_RETENTION_DAYS`（默认 7）；视频使用 `NOVA_VIDEO_RETENTION_DAYS`（默认 3）。均从终态起计算；启动及每 5 分钟清理到期任务、结果和绑定素材，读取时立即拒绝过期任务。视频 ack 不缩短保留期。
- 插件任务排队及处理期间不设过期时间；后端独立轮询到终态，Seedance 上限 12 小时，不依赖浏览器在线。
- 未绑定素材 24 小时后清理；绑定素材随任务清理，不受孤儿素材 TTL 影响。
- 嵌入模式必须配置 `NOVA_PUBLIC_BASE_URL`，生产为 `https://www.qlqqx.com`。`NOVA_MEDIA_SIGNING_SECRET` 可显式提供；缺省在数据目录生成 `media-signing.key` 并持久化（权限 600）。素材目录可用 `NOVA_PLUGIN_MEDIA_DIR` 指定，镜像缺省 `/data/plugin-media`。
- Key 不落盘，重启把未终态插件任务标记为失败，提示按上游任务 ID 联系管理员核对。
- 单批张数不设业务上限，大批任务分批执行，仍遵守全站并发；独立模式原有 8 张限制不变。
- 嵌入模式强制关闭 CDP（忽略 `NOVA_CDP_ENABLED`）。

## 8. 管理员

- 前端「插件」设置分区仅 `role === 'admin'` 显示。
- `GET /api/nova/plugins?reload=1` 会触发重新加载插件，必须为管理员，否则 403。将来新增的写接口也适用；不带 reload 的只读列表供登录用户使用。
- 插件任务与素材上传向普通登录用户开放；CDP 仍对所有用户返回 404。

## 8A. 提示词广场（服务端拉取）

浏览器端 CSP 为 `connect-src 'self'`，不能访问第三方代理或图床。嵌入模式下：

- 来源文件：`GET /api/nova/prompt-gallery/raw/<owner>/<repo>/<ref>/<path>`，只允许 `backend/embed/prompt-gallery.js` 中固定的 7 个仓库与 `.json/.md/.jpg/.jpeg/.png/.webp/.gif`，内容类型由扩展名决定。
- 示例图：`GET /api/nova/prompt-gallery/img?u=<https 地址>`，只允许固定图床（i.ibb.co、files.catbox.moe、pbs.twimg.com、YouMind / imgedify CDN、GitHub 附件等）；上游必须返回 jpeg/png/webp/gif/avif，SVG 与 HTML 一律拒绝。
- 重定向手动跟随，每一跳都要通过同一白名单（GitHub 附件 → 签名 S3 地址只作为跳转目标允许）；单文件上限 20MB。
- 结果缓存到 `NOVA_GALLERY_CACHE_DIR`（默认图片目录同级 `prompt-gallery-cache`），6 小时后刷新，上游失败时返回旧副本；总量超过 512MB 时按时间淘汰。
- 需要登录（与其他 `/api/nova/*` 相同），前端用会话鉴权的 fetch 取成 blob 显示（同 §5）。
- 可选：`NOVA_GALLERY_RAW_BASE` 换成 raw.githubusercontent.com 的镜像前缀；`NOVA_GALLERY_PROXY` 让这两个接口经 HTTP 代理出网（只影响广场，不影响网关请求）。
- 来源或图床增减时，后端白名单与前端 `lib/embed/prompt-gallery.ts` 需同步修改。

## 9. 父页（sub2api `/studio`）↔ Nova 的 postMessage

同源，双方都校验 `event.origin === window.location.origin` 与 `event.source`。

```ts
// 父 → Nova：iframe 加载后发送；token 刷新、用户信息或主题变化时重发（revision 递增）
{ type: 'sub2api:nova-studio-session', revision: number, sessionToken: string,
  userId: number, role: 'admin' | 'user', theme: 'light' | 'dark' }
// 父 → Nova：退出登录 / 切换账号
{ type: 'sub2api:nova-studio-revoke' }
// Nova → 父
{ type: 'nova:ready' }                        // 可接收 session
{ type: 'nova:balance-changed' }              // 任务结束，父页刷新余额
{ type: 'nova:navigate', path: string }       // 站内跳转（父页只允许白名单，如 /purchase、/keys）
```

- 收到 session 前 Nova 显示加载态；收到 revoke 立即清空内存中的 token 与 Key，并切换到空白状态。
- `sessionToken` 只附加到同源 `/api/nova/*` 与 sub2api 用户接口 `/api/v1/*`；**绝不**附加到网关 `/v1/*`、`/v1beta/*`（网关只用 API Key）。

## 10. Nova 前端调用的 sub2api 用户接口

响应外层统一为 `{ code: 0, message, data }`（非 0 为错误）。类型可参考 sub2api 仓库 `frontend/src/api/*.ts`（只读参考）。

| 接口 | 用途 |
|---|---|
| `GET /api/v1/auth/me` | 余额、角色、用户 ID 校验 |
| `GET /api/v1/keys?page=1&page_size=100` | 用户的 Key（明文、状态、额度、过期、`group.platform`、`group.allow_image_generation`） |
| `GET /api/v1/groups/available` | 一键创建 Key 时可选分组 |
| `POST /api/v1/keys` | 一键创建 Key |
| `GET /api/v1/model-plaza` | 模型用途（计费模式）与单价 |
| 网关 `GET /v1/models`（`Authorization: Bearer <API Key>`） | 所选 Key 实际可用的模型 |

## 11. 存储分区（前端）

- 所有 `localStorage` 键与 localforage 实例名统一经 `storageKey()` 加 `u<userId>:` 前缀；userId 变化时重新加载状态。
- 嵌入模式下模型注册表不读写 `localStorage['nova-model-registry']`，而是由设置页的选择（只持久化 `{keyId, model}`）+ 内存中的 Key 明文在内存里生成。
- 注册表包含所选 Key 在网关 `/v1/models` 下同用途的全部模型（按模型广场计费模式 / 名称分类，隐藏 `codex-auto-review`、`gpt-reserve`），Nova 各功能自带的模型选择器都能选；设置页选中的生图 / 对话模型排第一，作为各功能默认值。模型列表取不到时只注册选中的那一个。
- 备份导出剔除所有 Key。


## 12. 当前验证状态（2026-10-24）

后端安全基础、前端嵌入（会话、存储隔离、模型与密钥、提示词广场服务端拉取、提交前预估费用）与 sub2api `/studio` 已在本机测试环境（sub2api-local + sub2api-local-nova）用真实浏览器联调通过：出图扣费与直接调用网关一致，usage 记录用户 IP，跨用户读取任务 / 图片为 404。

- 余额只显示在控制台顶栏（Nova 内不再重复显示），任务结束后经 `nova:balance-changed` 同步刷新。
- 预估费用只对按张 / 按次计费的模型显示（单价取模型广场，× 张数）；按 token 计费的模型不预估。
- 深浅色跟随控制台（父页切换时重发会话，`applyEmbedTheme` 同步 `dark` 类）；嵌入模式按控制台 token 覆盖配色（`globals.css` 末尾 `html[data-nova-embed]` 规则：主色、白 / 藏青底、1px 淡线，上传区灰色细虚线，输入卡片无阴影），队列状态标签在嵌入模式隐藏。
- 换账号：A 退出后 B 打开工作台看不到 A 的设置，本地存储按 `u<userId>:` 分区。
- sub2api 侧 e2e（`sub2api-local/e2e/p8_studio.py`，STU-00..16）覆盖：扣费与 IP、跨用户隔离、嵌入策略头、插件管理仅管理员、视频接口鉴权、广场白名单拒绝、Nova 停机返回 503 并能恢复。
- 镜像与当前七号机部署见第 13 节。

```bash
cd backend
npm ci --no-audit --no-fund
node --test test/embed-*.test.js
npm test
npm run lint
```

所有集成桩只绑定 `127.0.0.1`，数据库、素材与结果目录位于测试专属临时目录，不连接 sub2api-local、生产或官方 API。

## 13. 镜像与部署

- 镜像：`docker/sub2api-embed.Dockerfile`（前端以 `NEXT_PUBLIC_NOVA_EMBED=1` 构建，默认 `NOVA_EMBED_MODE=1`、`NOVA_CDP_ENABLED=false`，数据在 `/data`，以 `node` 用户运行）。
- CI：`.github/workflows/custom-image.yml`，推送 `sub2api-custom` 后先跑后端 `node --test`、前端嵌入目录的 eslint 与全部 vitest，通过后推送 `ghcr.io/qlqqs/nova-image-studio:custom-latest` 与 `:custom-<sha7>`（amd64）。只改 `docs/` 或 `*.md` 不触发。上游代码本身有 eslint 错误，所以 CI 不跑全量 lint。
- fork 默认分支为 `sub2api-custom`；上游的 `desktop-release` 在 GitHub Actions 设置里已禁用（是设置状态，不在文件里），合并上游后如有新增工作流同样要禁用。
- 生产目标：**七号机**，项目 `sub2api-custom`。
- SSH：`ssh -p 40000 qlqq@15.204.64.92`，使用 `sudo` 管理 Docker 和 `/root` 目录。
- 七号机生产配置：
  - `/root/sub2api-custom`：sub2api 接入共享网络 `sub2api-custom-studio`（`192.168.240.0/24`），`.env` 设 `STUDIO_NOVA_URL=http://nova-studio:3000`；主服务发布 `0.0.0.0:48080 → 8080`。
  - `/root/sub2api-custom-nova`：Compose 项目与容器名为 `sub2api-custom-nova`，数据在 `./data`（属主 uid 1000），通过共享网络提供服务。
  - `SUB2API_GATEWAY_URL=http://sub2api-custom:8080`，`NOVA_TRUSTED_PROXY_CIDRS=192.168.240.0/24`。
  - 新增 `NOVA_PUBLIC_BASE_URL=https://www.qlqqx.com`、`NOVA_VIDEO_RETENTION_DAYS=3`；`NOVA_MEDIA_SIGNING_SECRET` 缺省自动生成到 `/data/media-signing.key`，随数据目录持久化。
  - sub2api 为 public-media 增加免 JWT 转发，并在工作台 CSP 允许 `media-src 'self' blob:`。
- 更新：在七号机 root shell 中进入 `/root/sub2api-custom-nova`，执行 `docker compose pull && docker compose up -d`。
- 完整部署流程见本机 `/home/qlqq/workspace/sub2api/AGENTS.md`。
