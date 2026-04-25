# 股票回测终端原型

这是一个 A 股手动回测终端原型，界面风格接近行情软件：左侧行情池，中间 K 线/成交量/指标图区，右侧账户、交易、复盘与交易模型参数。

## 当前功能

- 后端读取 `C:\eastmoney\swc8\data\SHANGHAI\DayData_SH_V43.dat` 与 `C:\eastmoney\swc8\data\SHENZHEN\DayData_SZ_V43.dat` 的东方财富本地日 K 数据。
- `/api/quotes` 从东方财富本地日线索引生成全市场行情快照，前端支持全市场排序、搜索，双击股票进入单股 K 线。
- `/api/bars` 强制要求 `as_of_date`，服务端按该日期截断 K 线，前端不会拿到未来数据。
- 前端行情、K 线、成交量、指标、账户重建全部基于后端截断后的数据。
- 交易模型支持滑点、佣金率、最低佣金、印花税、涨跌停、停牌规则配置。
- 支持复盘保存/加载，数据保存在本地 `data/sessions.json`，该文件默认不提交。
- 技术指标参数可调：MA、BOLL、MACD、RSI、KDJ、DMI。
- 图表支持 K 线缩放、成交量副图、最多 5 个独立指标副图、画线、十字光标、区间统计。

## 本地运行

```powershell
cd C:\Users\Administrator\Documents\Codex\2026-04-25\github-github-com-shandianxiao218-tab-repositories\stock-backtester-prototype
python server.py
```

打开：

```text
http://127.0.0.1:8000/
```

如果 8000 被占用：

```powershell
python server.py --port 8001
```

## 主要接口

```http
GET /api/stocks
GET /api/quotes?as_of_date=2026-04-24&market=all
GET /api/bars?symbol=600519&as_of_date=2026-04-24&start_date=2025-01-01&adjust=qfq
GET /api/sessions
GET /api/sessions/{id}?as_of_date=2026-04-24
POST /api/sessions
```

`GET /api/bars` 不传 `as_of_date` 会返回 400，这是防止未来数据泄漏的后端硬约束。

本地数据源可通过环境变量覆盖：

```powershell
$env:EASTMONEY_ROOT='C:\eastmoney'
python server.py --port 8010
```
