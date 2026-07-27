# TagTime · 标签时间追踪

基于标签的时间追踪应用，灵感来自 [Traggo](https://github.com/traggo/server)，在此基础上增加了日记、日历、待办、目标习惯等功能。

## 功能

- **标签计时**：选标签 → 点开始 → 点结束，支持多个同步计时
- **标签分类**：自定义大类（日常、工作、宝宝…），标签归属分类，颜色区分
- **次数打卡**：标签支持时长计时和次数打卡两种模式
- **日历视图**：日/周/月三视图，跨午夜计时正确显示，当前时间指示线
- **日记/随手记**：计时关联日记，支持文字+图片+视频附件，自定义时间，编辑功能
- **Todo 待办**：独立待办列表，关联分类，从待办一键发起计时
- **目标习惯**：时长型/次数型目标，周期追踪，进度可视化
- **统计图表**：每日趋势、标签时长排行、自定义时间区间查询
- **搜索**：活动搜索（标签名+备注）、日记搜索（内容+标签名）
- **数据自托管**：SQLite 单文件，Docker 单容器部署

## 技术栈

- 前端：React 18 + TypeScript + Vite + Tailwind CSS + Recharts
- 后端：Fastify 5 + TypeScript + Prisma ORM
- 数据库：SQLite
- 部署：Docker multi-stage 构建

## Docker 部署

```bash
docker compose up -d --build
# 访问 http://localhost:3000
```

数据持久化在 `./data/tagtime.db`，上传附件存储在 `./data/uploads/`。

## 本地开发

```bash
npm install
npm run db:push
npm run dev
# 前端: http://localhost:5173  后端: http://localhost:3000
```

## 项目结构

```
tagtime/
├── apps/
│   ├── server/              # 后端 Fastify + Prisma
│   │   └── src/
│   │       ├── schema.prisma        # 数据模型
│   │       ├── db.ts                # Prisma 客户端
│   │       ├── index.ts             # 服务入口
│   │       └── routes/              # API 路由
│   │           ├── categories.ts    # 分类 CRUD
│   │           ├── tags.ts          # 标签 CRUD
│   │           ├── timer.ts         # 计时 start/stop/list
│   │           ├── todos.ts         # 待办 CRUD
│   │           ├── stats.ts         # 统计聚合
│   │           ├── goals.ts         # 目标习惯
│   │           └── memos.ts         # 日记 + 文件上传
│   └── web/                 # 前端 React + Vite
│       └── src/
│           ├── pages/               # 计时/待办/日历/统计/标签
│           ├── components/          # 布局
│           ├── store.ts             # Zustand 全局状态
│           ├── api.ts               # API 客户端
│           └── types.ts             # 类型定义
├── Dockerfile               # multi-stage 构建
└── docker-compose.yml
```
