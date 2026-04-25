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
