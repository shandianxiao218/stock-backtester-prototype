# 架构设计文档

## 1. 当前架构（2026-04-25 更新）

### 1.1 数据源

东方财富终端本地数据：
- `C:\eastmoney\swc8\data\SHANGHAI\DayData_SH_V43.dat` - 上海市场日K
- `C:\eastmoney\swc8\data\SHENZHEN\DayData_SZ_V43.dat` - 深圳市场日K
- `C:\eastmoney\swc8\data\StkQuoteList\StkQuoteList_V10_*.dat` - 股票名称列表

### 1.2 二进制文件格式

```
文件头 (48 字节):
- 偏移 16: records_per_block (uint32)
- 偏移 20: capacity (uint32) - 股票槽位数

Entry 区 (每槽位 516 字节):
- 偏移 0: 股票代码 (ascii, 16 字节)
- 偏移 24: total_days (uint32) - 交易天数
- 偏移 32: block_ids[] - 数据块ID数组

数据区 (每记录 40 字节):
- 偏移 0: date (uint32) - 日期，格式 YYYYMMDD
- 偏移 8: open (float)
- 偏移 12: high (float)
- 偏移 16: low (float)
- 偏移 20: close (float)
- 偏移 24: volume (uint32)
- 偏移 32: amount (double)
```

### 1.3 新架构：C 语言数据导入 + 快照查询

**Python 数据导入性能瓶颈**：
- Python 的 mmap 和 struct 解析效率较低
- 5000+ 只股票 × N 条 K 线 = 数百万次循环
- 预计导入时间：2-5 分钟

**C 语言解决方案**：
- 编译型语言，直接内存访问
- 单次遍历文件，批量写入 SQLite
- 同步生成 `daily_quotes` 与近一年 `quote_snapshots`
- 当前实测导入：5523 只股票、15199063 条 K 线，约 7 分钟（TDM-GCC 32 位环境）
- 当前实测查询：`/api/quotes` 平均 52.41ms；页面日期切换实测 46.5-91.4ms

## 2. C 语言数据导入程序

### 2.1 程序结构

```
data_import.c
├── main()                  - 入口，初始化数据库
├── scan_market_file()      - 扫描市场文件，收集股票列表
├── import_market_data()    - 导入单个市场数据
└── extract_name_before_code() - 从名称文件提取股票名称
```

### 2.2 编译和运行

```bash
# 编译（使用仓库内 sqlite3.c）
gcc -O3 -std=c11 -I. -o data_import.exe data_import.c sqlite3.c -lws2_32

# 运行
data_import.exe <db_path> <eastmoney_root>

# 示例
data_import.exe data/eastmarket.db C:\eastmoney
```

### 2.3 进度报告机制

C 程序将进度写入 `<db_path>.progress` 文件（JSON 格式）：

```json
{
  "phase": "importing",     // init, scanning, importing, complete
  "market": "SH",           // 当前处理的市场
  "current": 1200,          // 当前进度
  "total": 5000,            // 总数
  "message": "Importing SH: 1200/5000 stocks"
}
```

Python 服务器通过 `/api/db-progress` 接口读取此文件，向网页前端返回实时进度。

## 3. 数据库更新策略

### 3.1 手动触发原则

**不再自动更新数据库**：
- 启动服务器不自动检查和更新
- 数据库过期不影响服务器运行（继续使用旧数据）
- 用户手动触发更新：`POST /api/rebuild-db`

### 3.2 API 接口

| 接口 | 说明 |
|------|------|
| `GET /api/db-status` | 数据库状态（条目数、大小、是否过期） |
| `GET /api/db-progress` | 导入进度（读取 .progress 文件） |
| `POST /api/rebuild-db` | 手动触发 C 程序执行数据导入 |

### 3.3 进度显示流程

```
用户点击"更新数据库"按钮
    │
    ├─ POST /api/rebuild-db
    │   └─ Python 启动 data_import.exe 子进程
    │
    ├─ 前端轮询 GET /api/db-progress（每秒）
    │   ├─ 读取 eastmarket.db.progress 文件
    │   └─ 返回 {phase, market, current, total, message}
    │
    └─ 进度条实时显示
        ├─ "正在扫描 SH 市场: 1200/5000"
        ├─ "正在导入 SH: 500/5000"
        └─ "导入完成: 5234 只股票, 1250000 条 K 线"
```

## 4. 部署结构

```
stock-backtester-prototype/
├── server.py             # HTTP 服务器（不再执行数据导入）
├── data_import.c         # C 语言数据导入程序
├── data_import.exe       # 编译后的导入程序
├── index.html
├── app.js
├── styles.css
├── DESIGN.md             # 本文档
├── CLAUDE.md
└── data/
    ├── eastmarket.db          # SQLite 数据库
    ├── eastmarket.db.progress # 导入进度文件（运行时生成）
    ├── sessions.json
    └── perf.log
```

## 5. 数据库表结构

### 5.1 stocks 表 - 股票列表（带预计算字段）
```sql
CREATE TABLE stocks (
    symbol TEXT PRIMARY KEY,
    name TEXT,
    market TEXT,
    last_date INTEGER,      -- 预计算：最新交易日期
    last_close REAL,        -- 预计算：最新收盘价
    last_volume INTEGER,    -- 预计算：最新成交量
    total_bars INTEGER DEFAULT 0
);
CREATE INDEX idx_stocks_market ON stocks(market);
```

### 5.2 bars 表 - K线数据
```sql
CREATE TABLE bars (
    symbol TEXT NOT NULL,
    date INTEGER NOT NULL,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    volume INTEGER,
    amount REAL,
    PRIMARY KEY (symbol, date)
);
CREATE INDEX idx_bars_date ON bars(date);
CREATE INDEX idx_bars_symbol_date ON bars(symbol, date);
CREATE INDEX idx_bars_symbol_date_desc ON bars(symbol, date DESC);
```

### 5.3 meta 表 - 元数据
```sql
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- 存储:
-- source_signature: 源文件签名
```

### 5.4 daily_quotes 表 - 预计算行情行
```sql
CREATE TABLE daily_quotes (
    symbol TEXT NOT NULL,
    date INTEGER NOT NULL,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    volume INTEGER,
    amount REAL,
    prev_close REAL,
    avg_volume_5 REAL
);
CREATE INDEX idx_daily_quotes_date_symbol ON daily_quotes(date, symbol);
CREATE UNIQUE INDEX idx_daily_quotes_symbol_date ON daily_quotes(symbol, date);
```

### 5.5 quote_snapshots 表 - 100ms 查询快照
```sql
CREATE TABLE quote_snapshots (
    date INTEGER PRIMARY KEY,
    count INTEGER NOT NULL,
    quotes_json TEXT NOT NULL
);
```

`quote_snapshots` 目前预计算 `2025-01-01` 之后的交易日，覆盖前端日期选择范围。服务端命中后直接返回 JSON 字节，避免 Python 逐行组装 5000 条行情。快照行使用数组格式，并通过响应顶层 `fields` 描述字段顺序，减少传输体积和浏览器 JSON 解析成本。

## 6. 性能预期

| 操作 | 旧方案 (Python) | 新方案 (C) | 说明 |
|------|----------------|-----------|------|
| 数据导入 | 120-300 秒 | ~7 分钟 | 当前 32 位 GCC + SQLite 单进程实测 |
| 全市场行情 | 秒级 | 52.41ms 平均 | `quote_snapshots` 直接返回 |
| 单股 K 线 | < 100ms | 15.41ms 平均 | 数据库查询 |
| 页面日期切换 | 秒级 | 46.5-91.4ms | 快照数组 + 虚拟行情表 |

## 7. API 接口

### 7.1 数据库管理接口

| 接口 | 说明 |
|------|------|
| `GET /api/db-status` | 数据库状态（条目数、大小、是否过期） |
| `GET /api/db-progress` | 导入进度（实时） |
| `POST /api/rebuild-db` | 手动触发 C 程序执行数据导入 |

### 7.2 数据接口（保持不变）

```
GET /api/stocks                    - 股票列表
GET /api/quotes?as_of_date=...     - 全市场行情
GET /api/bars?symbol=...&as_of_date=... - K线数据
```

## 8. 实现状态（2026-04-26）

### 已完成

- [x] C 语言数据导入程序 (`data_import.c`)
- [x] 移除 Python 自动更新逻辑
- [x] 添加手动触发 API (`POST /api/rebuild-db`)
- [x] 进度文件读取机制
- [x] `/api/db-progress` 接口
- [x] 更新 DESIGN.md 文档
- [x] 编译 `data_import.c` 生成 `data_import.exe`
- [x] 修复 `data_import.exe` 运行时崩溃
- [x] 测试数据导入流程
- [x] 生成 `daily_quotes` 与 `quote_snapshots`
- [x] 性能测试验证 `/api/quotes` < 100ms
- [x] 全市场表虚拟滚动，避免日期切换时重绘 5000 行
- [x] 快照 JSON 改为数组格式，页面日期切换进入 100ms 目标

### 待完成

- [ ] 前端添加"更新数据库"按钮（可选）
- [ ] 优化 C 导入速度（当前约 7 分钟，低于设计预期）
- [ ] 将快照预计算范围做成可配置项
- [ ] 拼音首字母映射表完善（当前为简化版，覆盖常用汉字）

## 9. 当前功能 TODO（2026-04-26）

### 行情规则与K线表现

- [x] 涨跌停规则按板块识别：主板 10%、创业板 20%、科创板 20%、北交所 30%、ST 5%。
- [x] 涨停日线主图使用橙色实体，跌停继续保留绿色/下跌语义。
- [x] 交易校验使用板块规则，不再只依赖手工输入的单一涨跌停百分比。

### 图表与指标交互

- [x] 十字光标主图显示日期、开盘、收盘、最高、最低、涨跌幅、成交量，并放到顶部读数区，避免遮挡K线。
- [x] 十字光标在成交量和各副图显示对应指标值。
- [x] 指标名称后显示参数，例如 `MACD(12,26,9)`、`RSI(6,12)`。
- [x] 双击指标线/指标图区域弹窗修改指标参数。
- [x] 股票日线图标记买卖点。

### 历史周期与数据范围

- [x] 前端 K 线请求起始日期从 `2025-01-01` 改为更早日期，允许查看 2025 年以前数据。
- [x] 支持日线、周线、月线切换。
- [x] 周线/月线由日线按周期聚合，遵守后端 `as_of_date` 截断后的数据范围。

### 股票列表与键盘导航

- [x] 小键盘/键盘输入股票代码或拼音首字母，快速跳转个股K线。
- [x] 左侧增加”全部 / 自选 / 持仓”列表。
- [x] 自选股支持添加/移除并保存在本地。
- [x] 个股 K 线页使用 PageDown / PageUp 按左侧当前列表切换下一只/上一只股票。
