# 问题记录

## 2026-04-25 data_import.exe 运行时崩溃

状态：已解决（2026-04-26）

### 问题描述

C 语言数据导入程序 `data_import.exe` 在运行时发生段错误（Segmentation fault），程序崩溃。

### 复现步骤

1. 编译程序：`gcc -O3 -std=c11 -I. -o data_import.exe data_import.c sqlite3.c -lws2_32`
2. 运行程序：`./data_import.exe data/eastmarket.db "C:\eastmoney"`
3. 程序崩溃，退出代码 139

### 错误信息

```
Segmentation fault
Exit code: 139
```

### 进度文件显示

```json
{"phase":"scanning","market":"SH","current":0,"total":20000,"message":"Scanning SH: 0 stocks found"}
```

程序在 `scan_market_file()` 函数中崩溃，具体位置尚未确定。

### 已尝试的修复

1. **添加 stdint.h 头文件** - 修复了编译错误
2. **修复 is_a_share_code() 函数** - 添加了安全的字符串长度检查
3. **改进文件大小检查** - 使用正确的 GetFileSize 方法

### 可能的原因

1. 文件映射问题 - MapViewOfFile 可能失败或返回的映射范围不正确
2. 内存访问越界 - 在访问 mm 指针时可能超出了映射范围
3. SQLite WAL 模式冲突 - Python 服务器和 C 程序同时访问数据库
4. capacity 值异常 - 从文件头读取的 capacity 值可能不正确

### 根因

1. `EMEntry` 结构体偏移错误：`total_days` 实际在 entry 偏移 24，`block_ids` 实际从偏移 32 开始。
2. 代码对只读 mmap 执行 `entry->code[15] = '\0'`，Windows 只读映射下会触发非法写入。
3. 空数据库场景下 C 程序没有创建 SQLite schema，直接 `DELETE/INSERT` 会失败。

### 修复

1. 修正 `EMEntry` 结构体布局，增加保留字段并读取 121 个 block id。
2. 改为复制代码字段到本地 buffer 后再做字符串处理，不再写 mmap。
3. C 导入器启动时创建 `meta/stocks/bars/daily_quotes/quote_snapshots` 表。
4. 名称文件改为一次性 mmap 复用，避免每只股票重复打开文件。

### 验证

1. `gcc -O3 -std=c11 -I. -o data_import.exe data_import.c sqlite3.c -lws2_32` 编译通过。
2. `data_import.exe data/eastmarket.db C:\eastmoney` 导入完成。
3. 导入结果：5523 只股票，15199063 条 K 线。

## 2026-04-26 全市场日期切换超过 100ms

状态：已解决

### 根因

历史日期查询走逐股票补查路径，约 5000 次 SQLite 查询；即便改成 `daily_quotes` 后，Python 逐行组装 JSON 仍会超过 100ms。

### 修复

1. 增加 `daily_quotes`，预计算前收与 5 日均量。
2. 增加 `quote_snapshots`，预存前端日期范围内的全市场 JSON。
3. `/api/quotes` 命中快照时直接返回 JSON bytes，避免 Python 逐行构造 dict。
4. 快照 JSON 仅保留前端行情表使用字段，减少传输和解析成本。

### 验证

`python bench_api.py`：

- `/api/quotes` 平均 84.68ms，5041 条。
- `/api/bars` 平均 15.41ms。
- `/api/stocks` 平均 122.38ms。

单独测试 1 年前日期：

- `2025-04-25` 平均 75.90ms。
- `2025-04-26` 自动回退到 `2025-04-25`，平均 74.66ms。

### 二次复查

用户复测后仍感觉切换慢。后端接口已低于 100ms，但浏览器仍会在日期切换时完整重建 5000 行行情表，并解析较大的对象数组 JSON。

### 追加修复

1. `quote_snapshots` 改为数组快照，响应通过顶层 `fields` 标明字段顺序，单日响应体约 445-457KB。
2. 全市场表改为虚拟滚动，只渲染可见行，滚动高度由 `tbody` 承载。
3. 左侧行情池渲染数量从 180 降到 40，避免日期切换时重复创建大量按钮。
4. 成交量紧凑格式改为手写格式化，避免 `toLocaleString(..., { notation: "compact" })` 在热路径上反复执行。

### 追加验证

- `python bench_api.py`：`/api/quotes` 平均 52.41ms。
- Headless Chrome 页面实测：
  - `2025-04-25`：91.4ms。
  - `2026-04-24`：46.5ms。
  - `2025-04-26`：56.6ms。

## 2026-04-26 首次加载慢与时间导航失效

状态：已解决

### 根因

1. 首次加载先等待 `/api/stocks` 返回完整股票池和拼音，再拉全市场快照；`/api/stocks` 冷启动可能超过 200ms。
2. 上一/下一交易日逻辑依赖当前个股 K 线；全市场页或个股 K 线未加载时会退化为日历日，遇到周末/非交易日体验不稳定。

### 修复

1. 首屏改为只等待 `/api/quotes` 和 `/api/sessions`，直接用行情快照构建股票池；`/api/stocks` 改为后台补全拼音和静态字段。
2. 新增 `GET /api/trading-date?date=YYYY-MM-DD&direction=prev|next`，优先查询 `quote_snapshots`，无快照时回退 `daily_quotes`。
3. 前端上一/下一交易日按钮改为调用交易日接口，不再逐日试探，也不依赖当前个股 K 线。
4. 首屏渲染顺序改为先渲染全市场虚拟表，再渲染左侧行情池。

### 验证

- 首屏行情表出现：约 92.5ms；首屏前不再请求 `/api/stocks`。
- `2026-04-26` 上一交易日返回 `2026-04-24`。
- `2025-04-25` 下一交易日返回 `2025-04-28`，自动跳过周末。
- 页面按钮实测：上一/下一交易日 26.4-53.9ms。

## 2026-04-26 日期选择控件不可见

状态：已解决

### 根因

顶部栏实际有 4 个区域：品牌、指数摘要、更新数据、日期导航，但 CSS 仍按 3 列布局。新增“更新数据”后，日期导航被自动排到下一行，并在较窄窗口下出现在可视区域左侧外面，看起来像日期选择功能消失。

### 修复

1. 顶部栏改为 4 列：品牌、指数摘要、更新数据、日期导航。
2. `db-update-area` 和 `top-actions` 使用 `max-content` 并右对齐，确保日期输入和上一/下一交易日按钮固定在右上。
3. 日期输入同时监听 `input` 和 `change`，兼容不同浏览器日期选择器触发方式。

### 验证

- 1366 宽视口下日期输入位置：`x=1034, y=37`，在可视区域内。
- 选择 `2025-04-26` 后页面显示交易日 `2025-04-25`，耗时约 62.6ms。
## 2026-04-26 全市场行情市场勾选筛选

状态：已完成

### TODO
- [x] 在全市场行情页增加沪深主板、创业板、科创板、ST板勾选项。
- [x] 只有被勾选的板块出现在全市场行情表和左侧行情池中。
- [x] ST 独立成组：未勾选 ST 时，即使沪深主板勾选也不显示 ST 股。
- [x] 筛选状态持久化到本地，刷新页面后保留。
- [x] 浏览器实测筛选、排序、日期切换后仍然生效。
- [x] 默认只勾选沪深主板、创业板。
- [x] 修正 K 线放大/缩小按钮方向：放大显示更少 K 线，缩小显示更多 K 线。

### 验证

- `2026-04-24` 全选：5041 只。
- 仅创业板：1315 只。
- 仅 ST板：106 只，表格前几行均为 `ST` / `*ST`。
- 仅科创板：571 只，刷新页面后仍保持仅科创板。
- 仅科创板状态下切换到 `2026-04-23` 后筛选仍保持。

## 2026-04-26 K线空心实体与副图数量

状态：已完成

### TODO
- [x] 增加副图数量设置，范围 1-5。
- [x] 副图数量变化后只显示对应数量的副图，并自动调整图表网格高度。
- [x] K线实体改为空心显示。
- [x] 上下影线不穿过K线实体中间。
- [x] 浏览器验证副图数量和K线渲染效果。
- [x] K线样式调整为红色空心上涨、青色实体下跌、橘色实体涨停。

### 验证

- 副图数设为 2：显示 `priceCanvas`、`volumeCanvas`、`indicatorCanvas`、`indicatorCanvas2`，控制项数量为 2。
- 副图数设回 5：五个副图全部恢复，控制项数量为 5。
- 主图像素检查存在空心实体背景区域。
- 主图像素检查存在橘色、青色、红色像素，确认涨停实体、下跌实体、上涨描边都已渲染。
# 2026-04-26 Chart Interaction Follow-up

Status: done

## TODO
- [x] Use mouse wheel on the detail K-line chart to switch stocks by the active left-side list order.
- [x] Set default indicator panel count to 3.
- [x] Set default panels to MACD, DMI, Capital Game.
- [x] Enable MA and BOLL on the main chart by default.
- [x] Keep the main price readout unchanged while appending active panel indicator values.
- [x] Show indicator values when the crosshair is over any chart area, not only the matching subchart.
- [x] Verify in browser and commit.
