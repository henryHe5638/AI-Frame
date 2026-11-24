# server — AI 艺术相框后端

Node 20+ / TypeScript(strict) / Fastify 4 / better-sqlite3。OpenAI 兼容接口调用两组 AI（审核 audit / 构图 compose），进程内双队列，任务状态持久化到 SQLite，重启自动恢复。

## 运行

```bash
pnpm install          # 在 monorepo 根目录
pnpm --filter server build
pnpm --filter server dev      # tsx watch，端口 3000（PORT 可覆盖）
pnpm --filter server start    # 运行 dist
```

数据库文件：`server/data/app.db`（已 gitignore）。`POST /api/import/zip` 替换前会自动备份为 `app.db.bak-<时间戳>`（同属 data 目录），卡通画目录备份为 `cartoon.bak-<时间戳>`。可选环境变量见根目录 `.env.example`。

## 目录结构

- `src/db.ts` — schema + 连接（photos / settings / sync_state）
- `src/config.ts` — zod 设置 schema、默认值、持久化、脱敏
- `src/immich.ts` — Immich API（search/metadata 游标分页、资产查询、图片拉取）
- `src/ai.ts` — OpenAI 兼容 chat completions（120s 超时、重试 1 次、json_object 降级、容错 JSON 提取）
- `src/queue.ts` — audit / compose 双队列（信号量并发）、工作流、指令校验、重启恢复
- `src/dhash.ts` — dHash 差异哈希（jpeg-js 解码缩 9x8 灰度，64bit 十六进制）与汉明距离
- `src/localDedup.ts` — 本地相似去重（不依赖 Immich 权限）：dhash 补算 + 相似分组
- `src/routes/sync.ts` — 同步 / webhook / 图片代理
- `src/routes/photos.ts` — 照片墙 / 重跑 / 统计 / 队列状态
- `src/routes/settings.ts` — 设置 / 导入导出
- `src/index.ts` — 装配、CORS、静态托管 web/dist、增量轮询

## API 契约（供前端使用）

Base URL：`http://localhost:3000`。所有接口前缀 `/api`，CORS 全开。

### 同步与图片

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/sync` | 触发全量同步。成功 `{ok, scanned, upserted, addedIds, queued}`；Immich 不可达/未配置时 502 `{ok:false, error}` |
| POST | `/api/immich-webhook` | Immich v3 Workflow webhook，宽容解析 body 中的 asset id（UUID），逐个同步并入队。返回 `{ok, synced, queued, errors}` |
| GET | `/api/assets/:id/image?size=preview\|thumbnail` | 图片代理（服务端带 immich key 拉流，200 条 LRU 缓存）。`:id` 是**本地照片 id**（数字）。404 照片不存在；502 immich 错误 |

### 照片

`Photo` 对象字段：
`{id, immichId, fileName, takenAt, createdAt, updatedAt, width, height, clarity, beauty, story, totalScore, reason, auditStatus, composeStatus, instruction, error, duplicateGroupId, auditVote, composeVote, imageUrl, thumbnailUrl}`
- `auditStatus`: `pending | auditing | passed | rejected | failed | duplicate`（通过/淘汰按**当前阈值**即时判定：设置页改阈值会重判全部已评分照片；`auditVote='dislike'` 的照片永远 rejected）
- `auditVote` / `composeVote`：用户对审核 / 装裱的评价（`like | dislike | null`）；踩审核 = 不再展示，踩装裱 = 立即重新装裱（旧指令快照进 `compose_feedback` 供 AI 学习）
- `duplicateGroupId`: 重复照片分组 id（组内共享，可空）；同组只保留一张进入 compose。来源两种：Immich duplicates 接口（组 id 为组内最小 immichId）与本地 dhash 相似分组（`local:` 前缀），Immich 结果优先
- `composeStatus`: `pending | composing | done | failed`
- `instruction`: 已校验修正的构图指令对象（见下）或 `null`；可含 `overlay`（AI 直接写的 SVG 叠加层代码，铺满照片区域渲染，已做脚本/外链清洗）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/photos?status=all\|passed\|rejected\pending\|duplicate&startDate=&endDate=&sort=taken\|audited\|composed&order=asc\|desc&page=1&pageSize=50` | 列表，默认按拍摄时间倒序；sort 支持拍摄/评分/装裱时间（空值排最后），order 默认 desc；startDate/endDate 为 ISO 字符串（含边界）。返回 `{total, page, pageSize, items}` |
| GET | `/api/photos/:id` | 详情（Photo） |
| POST | `/api/photos/:id/vote` | body `{target:'audit'\|'compose', vote:'like'\|'dislike'\|null}`。审核赞 → 直接通过并进入装裱（不受阈值限制），审核踩 → 淘汰不再展示；装裱踩 → 先把旧指令交给 AI 总结进审美记忆（成功后删除该踩记录），再立即重新装裱；返回更新后的 Photo |
| POST | `/api/photos/:id/regenerate` | 单张重跑（清空评分与指令，重新 audit+compose）→ `{ok, id}` |
| POST | `/api/regenerate` | body `{startDate?, endDate?, status?}` 批量重跑 → `{ok, count}` |
| GET | `/api/stats` | `{total, passed, rejected, pending, duplicate, localDuplicate, composed, queue:{audit, compose}}`（localDuplicate 为本地相似分组内照片数） |
| GET | `/api/queue` | `{audit:{pending,running,concurrency,dbPending}, compose:{...}}` |

### 设置 / 导入导出

`Settings` 对象（GET 返回中所有 apiKey 均已脱敏为 `****后4位`）：
```json
{
  "immichBaseUrl": "", "immichApiKey": "****abcd",
  "pollIntervalSec": 300, "webhookEnabled": true, "dedupEnabled": true, "localDedupEnabled": true,
  "audit":   { "baseUrl": "https://api.openai.com/v1", "apiKey": "****abcd", "model": "gpt-4o-mini", "prompt": "..." },
  "compose": { "baseUrl": "https://api.openai.com/v1", "apiKey": "", "model": "gpt-4o-mini", "prompt": "..." },
  "scoreThreshold": 21, "auditConcurrency": 3, "composeConcurrency": 3
}
```

`frameClockLayout` / `frameCalendarLayout`：时钟 / 日历浮层布局 `{x, y, scale}`（x、y 为浮层中心相对屏幕的比例 0-1，scale 0.4-3）；`null` 表示使用默认角落位置。在轮播页点击「布局」按钮后可拖动、缩放，松开即自动保存。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/settings` | 返回脱敏 Settings |
| PUT | `/api/settings` | 部分更新（深度合并）。**apiKey 传 `"****xxxx"` 脱敏值表示不修改**，传新值则覆盖 |
| GET | `/api/export/zip` | 导出备份 zip（deflate 压缩）：`app.db`（先 `wal_checkpoint(TRUNCATE)`，含全部设置与照片数据）+ `cartoon/` 下全部卡通画，`application/zip` 附件下载，文件名 `ai-art-frame-backup-YYYYMMDD.zip` |
| POST | `/api/import/zip` | body 为 `application/octet-stream` 的备份 zip。解析校验 zip 与 `app.db`（文件头 + 试开），备份当前库为 `app.db.bak-<时间戳>`、卡通画目录为 `cartoon.bak-<时间戳>` 后替换；`?overwriteSettings=true` 时用备份中的设置整体覆盖（含 API key），默认保留当前设置。返回 `{ok, restartRequired, backup, cartoons, settingsOverwritten}` 并 **退出进程**（dev 下由 tsx watch 自动重跑恢复；生产环境需进程管理器或手动重启） |

### compose 指令（instruction）格式

服务端已校验修正：crop 各值 clamp 到 [0,1]、宽高 ≥0.3、中心±半宽限制在界内；rotate 非法归 0；text.content 截断 ≤16 字；颜色非 `#RRGGBB` 用默认值。

```json
{
  "crop":   { "cx": 0.5, "cy": 0.5, "width": 0.9, "height": 0.8 },
  "rotate": 0,
  "frame":  { "style": "wood", "widthPx": 24 },
  "text":   { "content": "时光在此停留", "position": "bottom", "gradientFrom": "#f5e6c8", "gradientTo": "#b98a44", "strokeColor": "#3a2a12" }
}
```
`frame.style`: `none|wood|black|white|gold`；`text.position`: `bottom|top|left|right`。**服务端不生成任何新图片**，前端按指令在 canvas/CSS 中渲染。

## 默认提示词

### audit（评分）

```
你是一位专业的摄影评审。请仔细观察这张照片，从以下三个维度各打 1-10 分：
1. 清晰度（clarity）：画面是否清晰、对焦准确、细节丰富；
2. 美观度（beauty）：构图、色彩、光影是否美观；
3. 故事性（story）：画面是否有情感、有故事、耐人寻味。
只输出严格 JSON，不要输出任何其他内容，格式如下：
{"clarity": 8, "beauty": 7, "story": 6, "reason": "一句话理由"}
```

### compose（构图指令）

```
你是一位艺术相框装裱大师。请分析照片的主体与构图，为它在电子相框中的展示生成装裱指令。要求：
1. crop：裁剪区域，中心点 cx、cy 与宽高 width、height 均为 0-1 的比例值，裁剪框不得越界，width 和 height 不小于 0.3，围绕主体合理构图；
2. rotate：旋转角度，只能是 0、90、180、270 之一；
3. frame：相框，style 只能是 none、wood、black、white、gold 之一，widthPx 为相框宽度像素（0-80）；
4. text：题字，content 为一句诗意中文短句（不超过 16 个字），position 只能是 bottom、top、left、right 之一，gradientFrom 与 gradientTo 为题字渐变色的十六进制色值，strokeColor 为描边色十六进制色值。
只输出严格 JSON，不要输出任何其他内容，格式如下：
{"crop": {"cx": 0.5, "cy": 0.5, "width": 0.9, "height": 0.8}, "rotate": 0, "frame": {"style": "wood", "widthPx": 24}, "text": {"content": "时光在此停留", "position": "bottom", "gradientFrom": "#f5e6c8", "gradientTo": "#b98a44", "strokeColor": "#3a2a12"}}
```

## 行为说明

- 新同步资产自动入 audit 队列；audit 通过阈值（默认 total ≥ 21）自动入 compose 队列。
- 重复照片去重（dedupEnabled，默认开）：每次全量/增量同步成功后拉取 Immich `GET /api/duplicates` 并刷新 photos.duplicateGroupId（先清空再写入）。审核完成时同组只保留 totalScore 最高的一张 passed 进入 compose，其余置 `auditStatus='duplicate'`；若已有照片开始/完成 compose 则不再被顶替。需要 Immich API key 具备 `duplicate.read` 权限，拉取失败仅告警不影响同步。
- 本地相似去重（localDedupEnabled，默认开，不依赖 Immich 权限）：audit 拉 preview 图时顺手计算 dHash（差异哈希，64bit 十六进制存 photos.dhash）；同步后后台为仍无 dhash 的 passed 照片批量补算。两两汉明距离 ≤5 的 passed 照片归入 `local:` 前缀组（已有 Immich 组 id 的跳过，Immich 优先），同组复用上述去重策略只留最高分；已 compose 完成的不动。
- 两组 AI 调用：120s 超时，失败重试 1 次；`response_format: json_object`，HTTP 400 时自动降级为普通请求。
- AI 返回 JSON 容错解析：截取第一个 `{` 到最后一个 `}`。
- 重启恢复：`auditing/composing` 状态重置为 `pending` 重新排队；`audit=passed 且 compose=pending` 的也会重新入 compose 队列。
- 增量轮询：按 `updatedAfter`（上次同步时间）调用 search/metadata；接口报错自动退化为全量比对（upsert 幂等，仅新资产入队）。
- 静态托管：若 `web/dist` 存在则托管，`GET *`（非 /api）回退 index.html；否则非 API GET 返回 503 提示。
