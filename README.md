# TagTime · 标签时间追踪

一个基于标签的时间追踪应用，灵感来自 [Traggo](https://github.com/traggo/server)，在此基础上增加了 **Todo 待办**、**标签分类管理**、**统计图表**。

## 功能

- **标签计时**：选标签 → 点开始 → 点结束，3 步记录一次活动
- **标签分类**：自定义大类（日常、工作、宝宝…），标签归属分类，按颜色区分
- **Todo 待办**：独立待办列表，可关联标签，从待办一键发起计时
- **统计图表**：每日趋势柱状图、分类占比饼图、标签时长排行、日/周/月概览
- **数据自托管**：SQLite 单文件，Docker 单容器部署

## 技术栈

- 前端：React 18 + TypeScript + Vite + Tailwind CSS + Recharts
- 后端：Fastify 5 + TypeScript + Prisma ORM
- 数据库：SQLite
- 部署：Docker multi-stage 构建

## 本地开发

```bash
# 安装依赖
npm install

# 初始化数据库
npm run db:push

# 同时启动前后端开发服务器（热重载）
npm run dev
# 前端: http://localhost:5173  后端: http://localhost:3000
```

## Docker 部署

```bash
docker compose up -d --build
# 访问 http://localhost:3000
```

数据持久化在 `./data/tagtime.db`。

## 接入现有服务

本项目放在 `f:\DOCKER\tagtime` 下，与你现有的 Docker 服务矩阵协同：

- **Nginx Proxy Manager (npm)**：反代 `tagtime.你的域名` → `http://tagtime:3000`
- **Homepage**：在 `homepage/config/services.yaml` 添加 TagTime 卡片

## 项目结构

```
tagtime/
├── apps/
│   ├── server/          # 后端 Fastify + Prisma
│   │   └── src/
│   │       ├── schema.prisma    # 数据模型
│   │       ├── db.ts            # Prisma 客户端
│   │       ├── index.ts         # 服务入口
│   │       └── routes/          # API 路由
│   └── web/             # 前端 React + Vite
│       └── src/
│           ├── pages/           # 计时/待办/统计/标签
│           ├── components/      # 布局
│           ├── store.ts         # Zustand 全局状态
│           ├── api.ts           # API 客户端
│           └── types.ts         # 类型定义
├── Dockerfile           # multi-stage 构建
└── docker-compose.yml
```
