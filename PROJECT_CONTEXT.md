# 新开对话先读这个文件

## 项目定位

这是一个 A 股手动回测终端原型，目标是做成类似同花顺/东方财富的行情回看与模拟交易软件。

核心原则：

- 设置回测日期后，只能看到该日期及以前的数据。
- “未来不可见”必须以后端截断为准，前端只做展示与交互。
- 交易按当前回测交易日收盘价模拟，并叠加可配置的滑点、费用、涨跌停、停牌规则。
- 复盘会话可以保存和加载，便于回看手动交易过程。

## 当前技术状态

项目仍然无构建步骤，但已经从纯静态原型升级为一个轻量本地服务：

- `server.py`：标准库 HTTP 服务，提供静态文件、真实行情 API、复盘持久化。
- `index.html`：三栏终端布局。
- `styles.css`：深色行情终端样式。
- `app.js`：前端状态、图表、指标、交易、复盘逻辑。
- `data/sessions.json`：运行后生成的本地复盘数据，已被 `.gitignore` 忽略。

## 已实现功能

行情与后端：

- `GET /api/stocks` 返回内置 A 股股票池。
- `GET /api/bars` 从 `C:\eastmoney\swc8\data\SHANGHAI\DayData_SH_V43.dat` 和 `C:\eastmoney\swc8\data\SHENZHEN\DayData_SZ_V43.dat` 读取东方财富本地日 K。
- `/api/bars` 必填 `as_of_date`，服务端读取本地文件后按日期过滤截断。
- 前端不再使用 `generateBars()`，该函数已经移除。

交易与复盘：

- 初始资金 `100000`。
- 交易数量按 100 股取整。
- 买入检查可用资金，卖出检查持仓。
- 滑点、佣金率、最低佣金、印花税、涨跌停比例、涨跌停约束、停牌约束可在右侧配置。
- 保存复盘使用 `POST /api/sessions`。
- 加载复盘使用 `GET /api/sessions/{id}?as_of_date=...`，后端会按日期过滤成交。

图表与指标：

- 主图支持 K 线、MA、BOLL。
- 副图支持 MACD、RSI、KDJ、DMI、资金博弈。
- 新增成交量副图。
- 指标参数可调：MA、BOLL、MACD、RSI、KDJ、DMI。
- 图表工具支持十字光标、画线、区间统计。

## 本地验证

启动服务：

```powershell
python server.py
```

打开：

```text
http://127.0.0.1:8000/
```

接口验证：

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:8000/api/bars?symbol=600519&as_of_date=2026-04-10&start_date=2026-04-01&adjust=qfq' -UseBasicParsing
```

缺少 `as_of_date` 应返回 400。

## 下一步建议

- 将股票池改为可搜索全市场列表。
- 增加服务端订单接口，让交易校验也完全后端化。
- 复盘会话增加更新、删除、备注和导出。
- 接入用户已有的 `tupo` Python 回测项目，把指标与账户绩效计算逐步移到后端。
