# AI Frame — 会自己选图的 AI 电子相框

基于 [Immich](https://immich.app) 照片库的 AI 艺术相框：自动从相册中挑选「值得被看见」的照片，AI 评分、AI 装裱（裁剪 / 旋转 / 相框 / 诗意题字），最终在网页相框中轮播展示，让沉睡在硬盘里的记忆重新被看见。

## 致谢与灵感

本项目受 **【老戴】我用 AI 分析了500G照片库，做了一个"会自己选图"的电子相框：让沉睡的记忆重新被看见** 启发：

- B 站视频：https://www.bilibili.com/video/BV1KczbBXEeC
- 原作项目：http://www.github.com/dai-hongtao/InkTime

在此向原作者老戴（dai-hongtao）表示感谢！

## 特别说明

**本项目全部由 Vibe Coding 完成**（AI 辅助生成代码，Kimi Code CLI 驱动），欢迎大家随意二次开发、魔改、提 Issue / PR。

## 功能特性

- **自动同步**：对接 Immich API，全量 + 增量轮询同步照片，支持 webhook
- **AI 审核（audit）**：从清晰度、美观度、故事性三个维度打分（OpenAI 兼容接口，任意模型可换），通过阈值自动进入装裱队列
- **AI 装裱（compose）**：AI 生成构图指令——裁剪、旋转、相框样式（木/黑/白/金）、诗意中文题字（含渐变描边），甚至 SVG 叠加层；服务端只存指令，前端 Canvas 实时渲染，不生成新图片
- **双重去重**：Immich 官方 duplicates 接口 + 本地 dHash 相似图分组（汉明距离 ≤5），同组只留最高分一张
- **人工反馈学习**：对审核/装裱结果点赞或点踩，踩装裱会把旧指令交给 AI 总结进「审美记忆」，越用越懂你
- **照片墙 + 轮播相框**：Web 前端照片墙管理、筛选、重跑；轮播页支持时钟/日历浮层，布局可拖拽缩放
- **任务队列**：进程内双队列（audit/compose 独立并发），状态持久化 SQLite，重启自动恢复
- **导入导出**：JSON 配置/数据迁移，或整库 SQLite 导出导入（自动备份）

## 技术栈

- **后端**：Node.js 20+ / TypeScript (strict) / Fastify 4 / better-sqlite3
- **前端**：Vue 3 / Vite / Canvas 渲染
- **AI**：OpenAI 兼容 chat completions 接口（审核与装裱可分别配置 baseUrl / apiKey / model / prompt）
- **部署**：Docker / docker-compose，或 pnpm 直接运行

## 快速开始

```bash
pnpm install

# 开发模式（同时起 server 3000 + web 5173）
pnpm dev

# 生产模式
pnpm build
pnpm start          # server 静态托管 web/dist
```

或使用 Docker：

```bash
cp .env.example .env   # 按需修改
docker compose up -d
```

打开 `http://localhost:3000`，进入设置页填写：

1. Immich 地址与 API Key
2. 审核 / 装裱两组 AI 的接口地址、Key、模型（任何 OpenAI 兼容服务均可）
3. 点击同步，坐等 AI 帮你挑照片

更多 API 契约与行为细节见 [server/README.md](server/README.md)。

## 许可证

MIT —— 欢迎二次开发，玩得开心。
