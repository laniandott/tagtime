# TagTime 数据备份与恢复（离线 CLI）

本文说明如何对 TagTime 服务的持久化数据进行离线备份与恢复。**必须在服务端进程停止后执行**；本工具不支持在线/热备份。

## 1. 覆盖范围

备份会完整复制以下持久化用户数据：

- **SQLite 数据库**：`DATABASE_URL` 指向的 `.db` 主库文件，以及共存时的 `-wal` / `-shm` 附属文件；
- **笔记 Markdown**：`NOTES_DIR`（默认 `DATA_DIR/notes`）下的全部 `.md`；
- **上传附件**：`UPLOAD_DIR`（即 `DATA_DIR/uploads`）下的全部附件。

> 若 `DATABASE_URL` 位于 `DATA_DIR` 之外，仍按 URL 读取并如实在 manifest 中记录，请留意备份后需连同该库位置一起迁移。

**不支持范围**（不在本文档能力内）：

- 在线 / 热备份：备份前必须先停止服务端进程，否则备份一致性无法保证；
- 运行中并发写入、SQLite checkpoint 转储、备份文件损坏后的自动修复；
- 跨平台自动差异 / 增量备份。

## 2. 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `DATA_DIR` | 数据根目录（含 `uploads/`） | `/data` 或工作目录下 `data` |
| `NOTES_DIR` | 笔记目录 | `DATA_DIR/notes` |
| `DATABASE_URL` | Prisma 数据库 URL（`file:` 或绝对路径） | `DATA_DIR/tagtime.db` |
| `PORT` | 服务端端口（用于检测服务是否在运行） | `3000` |

## 3. 备份

### 3.1 停止服务

先停止服务端进程（Docker：`docker compose down`；本地：停止 `npm start` 进程）。

### 3.2 执行备份

```bash
cd apps/server
npm run cli:backup
# 或指定目标目录：
node scripts/backup-restore-cli.mjs backup --dest /path/to/backup-dir
# 或显示帮助：
node scripts/backup-restore-cli.mjs --help
```

- 默认写入 `<DATA_DIR>/backups/backup-<时间戳>/`；
- 备份目录内包含 `notes/`、`uploads/`、数据库文件和 `manifest.json`（版本 / 时间戳 / 各文件 SHA-256 校验清单）；
- 写入过程使用临时目录，成功后原子改名；**失败不会留下可被误认为完整的备份**。

### 3.3 路径与运行保护

- 若检测到服务端正在运行（`PORT` 被监听），命令会拒绝并提示先停止服务（无旁路参数，确保离线一致性）。
- 备份目标若落在 `notes/` / `uploads/` 目录内部，或直接覆盖数据库文件，会因自包含/破坏数据库风险被拒绝。
- 默认会写入 `<DATA_DIR>/backups/backup-<时间戳>/`；真正禁止的是目标放在 `notes/` / `uploads/` 内部或覆盖数据库文件，而非要求必须在数据目录之外。

## 4. 恢复

### 4.1 停止服务

同样必须先停止服务端。

### 4.2 校验并恢复

```bash
cd apps/server
node scripts/backup-restore-cli.mjs restore /path/to/backup-dir
```

- 恢复前会**校验 `manifest.json` 与所有文件的 SHA-256**；任一不一致即拒绝，不触碰现有数据；
- **默认拒绝覆盖**：若目标目录已有数据，命令会退出并提示；确认要覆盖时加 `--force`（或 `--overwrite`）；
- 使用 `--force` 覆盖前，会自动生成一份独立的「恢复前备份」到 `<DATA_DIR>/backups/pre-restore-<时间戳>/`，供出错时回滚；
- 恢复采用**事务式替换**：先将 notes/uploads/主库及 `-wal/-shm` 各自移到同卷暂存并保留，再逐一落位新数据；任一步失败立即用暂存还原全部目标（原目标为空也会清掉部分新数据），日志会打印「恢复前备份」路径供手动处置。

```bash
node scripts/backup-restore-cli.mjs restore /path/to/backup-dir --force
```

## 5. 失败处置建议

- **备份失败**：检查磁盘空间、目标目录权限、是否服务仍在运行；备份目录内不会残留不完整文件，可安全重试。
- **恢复时校验失败**：不要强加 `--force` 覆盖，先检查备份目录是否损坏/被篡改；若确认备份损坏，应从更早的可信备份恢复。
- **恢复中断**：优先使用日志中打印的「恢复前备份」目录手工回滚；必要时 `--force` 从该恢复前备份再次恢复。

## 6. 验证恢复结果

推荐恢复后用一次端到端验证确认数据一致（Note ID、笔记链接、实体关联、附件可访问）。项目提供可重复演练：

```bash
# 数据一致性（备份→破坏→恢复→重启断言）
npm run backup:drill -w apps/server
# CLI 行为（运行保护/路径重叠/校验失败/恶意 manifest 拒绝/跨卷恢复/Phase A·B 回滚/Phase C 清理语义等 12 场景，全部临时目录隔离）
npm run backup:cli:drill -w apps/server
```

## 7. 版本与状态

- 本 CLI 属阶段六「离线备份/恢复」实现，首版提交 `5878218`。
- `c1d2c09` 起移除 `--ignore-running` 旁路并加固路径校验、sidecar 清理。
- `a8e6dbb` 把恢复改为事务式替换并补齐演练 S7-S10；其后补 Phase A/B 全阶段回滚与 Phase C「已提交待清理」语义（S11-S12），fault-injection 仅在 `TAGTIME_TEST_RUNNER=1` 时生效，生产流程无测试旁路。
- 状态：CLI 演练（12 场景）、服务端构建与既有测试通过；六-D 的「干净安装 / 升级安装 / 正式发布产物检查」及六-C 真机回归仍为独立待办，阶段六尚未正式验收与发布。