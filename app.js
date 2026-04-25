(function () {
  "use strict";

  const INITIAL_CASH = 100000;
  const DEFAULT_DISPLAY_BARS = 90;
  const MIN_DISPLAY_BARS = 30;
  const MAX_DISPLAY_BARS = 260;
  const INDICATOR_TYPES = ["macd", "rsi", "kdj", "dmi", "capital"];
  const API_START_DATE = "2025-01-01";
  const DEFAULT_SYMBOL = "000001";
  const EMPTY_ACCOUNT = {
    cash: INITIAL_CASH,
    positions: {},
    marketValue: 0,
    equity: INITIAL_CASH,
    pnl: 0,
    pnlPct: 0
  };

  let stocks = [];
  let quoteRows = [];
  let loadSeq = 0;

  const marketData = new Map();
  const dataCache = new Map();
  const quoteCache = new Map();

  const state = {
    symbol: DEFAULT_SYMBOL,
    asOfDate: defaultAsOfDate(),
    view: "market",
    displayBars: DEFAULT_DISPLAY_BARS,
    quoteSort: { key: "pct", dir: "desc" },
    indicatorPanels: defaultIndicatorPanels(),
    panel: initialPanel(),
    showMA: true,
    showBOLL: false,
    trades: [],
    drawings: [],
    sessions: [],
    currentSessionId: "",
    playing: false,
    timer: null,
    search: "",
    loading: false,
    tool: "cursor",
    hover: null,
    drag: null,
    draftDrawing: null,
    rangeSelection: null,
    settings: {
      indicators: {
        maFast: 5,
        maMid: 10,
        maSlow: 20,
        bollPeriod: 20,
        bollStd: 2,
        macdFast: 12,
        macdSlow: 26,
        macdSignal: 9,
        rsiFast: 6,
        rsiSlow: 12,
        kdjPeriod: 9,
        dmiPeriod: 14,
        capitalPeriod: 13
      },
      trade: {
        slippageBps: 5,
        commissionRatePct: 0.025,
        minCommission: 5,
        stampDutyRatePct: 0.05,
        limitPct: 10,
        enforceLimit: true,
        enforceSuspension: true
      }
    }
  };

  const chartState = {
    range: null,
    priceScale: null,
    latestIndicators: null
  };

  const el = {
    marketStatus: document.getElementById("marketStatus"),
    marketStrip: document.getElementById("marketStrip"),
    backtestDate: document.getElementById("backtestDate"),
    visibleDateTag: document.getElementById("visibleDateTag"),
    stockSearch: document.getElementById("stockSearch"),
    quoteList: document.getElementById("quoteList"),
    marketBoard: document.getElementById("marketBoard"),
    detailBoard: document.getElementById("detailBoard"),
    marketTableBody: document.getElementById("marketTableBody"),
    quoteCount: document.getElementById("quoteCount"),
    backToMarket: document.getElementById("backToMarket"),
    symbolTitle: document.getElementById("symbolTitle"),
    symbolMeta: document.getElementById("symbolMeta"),
    showMA: document.getElementById("showMA"),
    showBOLL: document.getElementById("showBOLL"),
    priceReadout: document.getElementById("priceReadout"),
    rangeStats: document.getElementById("rangeStats"),
    canvasStack: document.getElementById("canvasStack"),
    priceCanvas: document.getElementById("priceCanvas"),
    volumeCanvas: document.getElementById("volumeCanvas"),
    indicatorCanvas: document.getElementById("indicatorCanvas"),
    indicatorCanvas2: document.getElementById("indicatorCanvas2"),
    indicatorCanvas3: document.getElementById("indicatorCanvas3"),
    indicatorCanvas4: document.getElementById("indicatorCanvas4"),
    indicatorCanvas5: document.getElementById("indicatorCanvas5"),
    zoomMore: document.getElementById("zoomMore"),
    zoomLess: document.getElementById("zoomLess"),
    barCountLabel: document.getElementById("barCountLabel"),
    indicatorPanelControls: document.getElementById("indicatorPanelControls"),
    prevDay: document.getElementById("prevDay"),
    nextDay: document.getElementById("nextDay"),
    playToggle: document.getElementById("playToggle"),
    equityValue: document.getElementById("equityValue"),
    cashValue: document.getElementById("cashValue"),
    marketValue: document.getElementById("marketValue"),
    pnlValue: document.getElementById("pnlValue"),
    orderQty: document.getElementById("orderQty"),
    orderPrice: document.getElementById("orderPrice"),
    buyBtn: document.getElementById("buyBtn"),
    sellBtn: document.getElementById("sellBtn"),
    resetAccount: document.getElementById("resetAccount"),
    saveSession: document.getElementById("saveSession"),
    loadSession: document.getElementById("loadSession"),
    sessionName: document.getElementById("sessionName"),
    sessionSelect: document.getElementById("sessionSelect"),
    positionList: document.getElementById("positionList"),
    tradeLog: document.getElementById("tradeLog"),
    clearDrawings: document.getElementById("clearDrawings"),
    maFast: document.getElementById("maFast"),
    maMid: document.getElementById("maMid"),
    maSlow: document.getElementById("maSlow"),
    bollPeriod: document.getElementById("bollPeriod"),
    bollStd: document.getElementById("bollStd"),
    macdFast: document.getElementById("macdFast"),
    macdSlow: document.getElementById("macdSlow"),
    macdSignal: document.getElementById("macdSignal"),
    rsiFast: document.getElementById("rsiFast"),
    rsiSlow: document.getElementById("rsiSlow"),
    kdjPeriod: document.getElementById("kdjPeriod"),
    dmiPeriod: document.getElementById("dmiPeriod"),
    slippageBps: document.getElementById("slippageBps"),
    commissionRate: document.getElementById("commissionRate"),
    minCommission: document.getElementById("minCommission"),
    stampDutyRate: document.getElementById("stampDutyRate"),
    limitPct: document.getElementById("limitPct"),
    enforceLimit: document.getElementById("enforceLimit"),
    enforceSuspension: document.getElementById("enforceSuspension")
  };
  el.indicatorCanvases = [
    el.indicatorCanvas,
    el.indicatorCanvas2,
    el.indicatorCanvas3,
    el.indicatorCanvas4,
    el.indicatorCanvas5
  ].filter(Boolean);

  boot();

  async function boot() {
    el.backtestDate.min = API_START_DATE;
    el.backtestDate.max = todayString();
    el.backtestDate.value = state.asOfDate;

    bindEvents();
    syncPanelButtons();
    syncToolButtons();
    hydrateSettingsFromInputs();
    renderIndicatorPanelControls();

    try {
      await loadStocks();
      await Promise.all([loadMarketData(), loadSessions()]);
      renderAll();
    } catch (error) {
      renderFatalError(error);
    }
  }

  function bindEvents() {
    el.backtestDate.addEventListener("change", async () => {
      await setAsOfDate(el.backtestDate.value, { branch: true });
    });

    el.prevDay.addEventListener("click", () => moveDay(-1));
    el.nextDay.addEventListener("click", () => moveDay(1));
    el.playToggle.addEventListener("click", togglePlayback);

    el.stockSearch.addEventListener("input", (event) => {
      state.search = event.target.value.trim().toLowerCase();
      renderQuotes();
      renderMarketTable();
    });

    el.backToMarket.addEventListener("click", () => {
      state.view = "market";
      renderAll();
    });

    document.querySelectorAll(".market-table th[data-sort]").forEach((cell) => {
      cell.addEventListener("click", () => setQuoteSort(cell.dataset.sort));
    });

    el.showMA.addEventListener("change", () => {
      state.showMA = el.showMA.checked;
      renderCharts();
    });

    el.showBOLL.addEventListener("change", () => {
      state.showBOLL = el.showBOLL.checked;
      renderCharts();
    });

    document.querySelectorAll(".segment").forEach((button) => {
      button.addEventListener("click", () => {
        state.panel = button.dataset.panel;
        state.indicatorPanels[0].type = state.panel;
        window.location.hash = state.panel;
        syncPanelButtons();
        renderIndicatorPanelControls();
        renderCharts();
      });
    });

    document.querySelectorAll(".tool-button[data-tool]").forEach((button) => {
      button.addEventListener("click", () => {
        state.tool = button.dataset.tool;
        state.drag = null;
        state.draftDrawing = null;
        syncToolButtons();
      });
    });

    el.clearDrawings.addEventListener("click", () => {
      state.drawings = state.drawings.filter((drawing) => drawing.symbol !== state.symbol);
      state.draftDrawing = null;
      renderCharts();
    });

    el.zoomMore.addEventListener("click", () => zoomChart(20));
    el.zoomLess.addEventListener("click", () => zoomChart(-20));

    el.indicatorPanelControls.addEventListener("change", (event) => {
      updateIndicatorPanel(event.target);
      renderIndicatorPanelControls();
      renderCharts();
    });

    [
      el.maFast,
      el.maMid,
      el.maSlow,
      el.bollPeriod,
      el.bollStd,
      el.macdFast,
      el.macdSlow,
      el.macdSignal,
      el.rsiFast,
      el.rsiSlow,
      el.kdjPeriod,
      el.dmiPeriod
    ].forEach((input) => {
      input.addEventListener("change", () => {
        hydrateIndicatorSettings();
        renderReadout();
        renderCharts();
      });
    });

    [
      el.slippageBps,
      el.commissionRate,
      el.minCommission,
      el.stampDutyRate,
      el.limitPct,
      el.enforceLimit,
      el.enforceSuspension
    ].forEach((input) => {
      input.addEventListener("change", hydrateTradeSettings);
    });

    el.buyBtn.addEventListener("click", () => placeOrder("BUY"));
    el.sellBtn.addEventListener("click", () => placeOrder("SELL"));
    el.resetAccount.addEventListener("click", () => {
      state.trades = [];
      state.rangeSelection = null;
      renderAll();
    });
    el.saveSession.addEventListener("click", saveSession);
    el.loadSession.addEventListener("click", loadSelectedSession);

    [el.priceCanvas, el.volumeCanvas, ...el.indicatorCanvases].forEach((canvas) => {
      canvas.addEventListener("pointermove", handlePointerMove);
      canvas.addEventListener("pointerdown", handlePointerDown);
      canvas.addEventListener("pointerup", handlePointerUp);
      canvas.addEventListener("pointerleave", handlePointerLeave);
    });

    window.addEventListener("resize", renderCharts);
  }

  async function loadStocks() {
    const payload = await fetchJson("/api/stocks");
    stocks = payload.stocks || [];
    if (!stocks.length) throw new Error("股票列表为空");
    if (!stocks.some((stock) => stock.symbol === state.symbol)) state.symbol = stocks[0].symbol;
  }

  async function loadMarketData() {
    if (!stocks.length) return;
    const sequence = ++loadSeq;
    state.loading = true;
    setBusy(true);
    el.marketStatus.textContent = `扫描东方财富本地全市场行情 · as_of_date=${state.asOfDate}`;

    try {
      const payload = await fetchQuotes();
      if (sequence !== loadSeq) return;
      quoteRows = payload.quotes || [];
      if (quoteRows.length) {
        stocks = quoteRows.map((quote) => ({ symbol: quote.symbol, name: quote.name, market: quote.market }));
      }
      if (!stocks.some((stock) => stock.symbol === state.symbol) && stocks.length) state.symbol = stocks[0].symbol;
      if (state.view === "detail") await ensureSymbolBars(state.symbol);
      state.hover = null;
      state.drag = null;
      state.draftDrawing = null;
      hydrateSettingsFromInputs();
      renderRangeStats();
    } finally {
      if (sequence === loadSeq) {
        state.loading = false;
        setBusy(false);
      }
    }
  }

  async function fetchQuotes() {
    const key = `quotes|${state.asOfDate}`;
    if (quoteCache.has(key)) return quoteCache.get(key);
    const params = new URLSearchParams({
      as_of_date: state.asOfDate,
      market: "all"
    });
    const payload = await fetchJson(`/api/quotes?${params.toString()}`);
    quoteCache.set(key, payload);
    return payload;
  }

  async function fetchBars(symbol) {
    const key = `${symbol}|${state.asOfDate}|qfq`;
    if (dataCache.has(key)) return dataCache.get(key);
    const params = new URLSearchParams({
      symbol,
      as_of_date: state.asOfDate,
      start_date: API_START_DATE,
      adjust: "qfq"
    });
    const payload = await fetchJson(`/api/bars?${params.toString()}`);
    dataCache.set(key, payload);
    return payload;
  }

  async function ensureSymbolBars(symbol) {
    if (marketData.has(symbol)) return marketData.get(symbol);
    const payload = await fetchBars(symbol);
    marketData.set(symbol, payload.bars || []);
    const stock = getStock(symbol);
    if (payload.name && stock) stock.name = payload.name;
    return payload.bars || [];
  }

  async function openSymbol(symbol) {
    if (!symbol || state.loading) return;
    state.symbol = symbol;
    state.view = "detail";
    state.hover = null;
    state.rangeSelection = null;
    state.drag = null;
    state.draftDrawing = null;
    setBusy(true);
    try {
      await ensureSymbolBars(symbol);
      renderAll();
    } catch (error) {
      console.error(error);
      flashStatus(`无法加载 ${symbol}: ${error.message || error}`);
    } finally {
      setBusy(false);
    }
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, {
      cache: "no-store",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options && options.headers ? options.headers : {})
      }
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch (error) {
      payload = {};
    }
    if (!response.ok) {
      throw new Error(payload.error || `${response.status} ${response.statusText}`);
    }
    return payload;
  }

  async function setAsOfDate(date, options = {}) {
    if (!date || date === state.asOfDate) {
      renderAll();
      return;
    }
    state.asOfDate = date;
    if (options.branch) branchTimeline();
    stopPlayback();
    marketData.clear();
    await loadMarketData();
    renderAll();
  }

  function renderAll() {
    el.backtestDate.value = state.asOfDate;
    el.visibleDateTag.textContent = currentTradingDate() || state.asOfDate;
    el.marketStatus.textContent = `东方财富本地行情 · 服务端截断至 ${state.asOfDate}`;
    renderView();
    renderMarketStrip();
    renderQuotes();
    if (state.view === "market") renderMarketTable();
    renderHeader();
    renderReadout();
    renderRangeStats();
    renderAccount();
    renderSessions();
    renderCharts();
  }

  function renderView() {
    const isMarket = state.view === "market";
    el.marketBoard.hidden = !isMarket;
    el.detailBoard.hidden = isMarket;
    el.backToMarket.textContent = isMarket ? "全市场" : "返回";
    el.backToMarket.disabled = isMarket;
    if (el.barCountLabel) el.barCountLabel.textContent = `${state.displayBars} 根`;
  }

  function renderMarketTable() {
    if (!el.marketTableBody) return;
    const rows = sortedQuotes().filter((quote) => {
      const key = `${quote.symbol} ${quote.name}`.toLowerCase();
      return !state.search || key.includes(state.search);
    });
    if (el.quoteCount) {
      el.quoteCount.textContent = `${rows.length} / ${quoteRows.length} 只 · 双击进入 K 线`;
    }
    el.marketTableBody.innerHTML = rows
      .map((quote, index) => {
        const cls = quote.change > 0 ? "up" : quote.change < 0 ? "down" : "flat";
        return `
          <tr class="${quote.symbol === state.symbol ? "active" : ""}" data-symbol="${quote.symbol}">
            <td class="muted">${index + 1}</td>
            <td><strong>${quote.symbol}</strong></td>
            <td>${escapeHtml(quote.name)}${quote.suspended ? '<span class="muted"> 停</span>' : ""}</td>
            <td class="muted">${quote.market}</td>
            <td class="num ${cls}">${formatPrice(quote.close)}</td>
            <td class="num ${quote.volumeRatio > 1 ? "up" : quote.volumeRatio < 0.8 ? "down" : "flat"}">${formatRatio(quote.volumeRatio)}</td>
            <td class="num ${cls}">${quote.pct >= 0 ? "+" : ""}${quote.pct.toFixed(2)}</td>
            <td class="num ${cls}">${quote.change >= 0 ? "+" : ""}${formatPrice(quote.change)}</td>
            <td class="num">${formatPrice(quote.open)}</td>
            <td class="num up">${formatPrice(quote.high)}</td>
            <td class="num down">${formatPrice(quote.low)}</td>
            <td class="num">${formatCompact(quote.volume)}</td>
            <td class="num">${formatMoneyCompact(quote.amount)}</td>
            <td class="muted">${quote.date}</td>
          </tr>
        `;
      })
      .join("");

    el.marketTableBody.querySelectorAll("tr[data-symbol]").forEach((row) => {
      row.addEventListener("click", () => {
        state.symbol = row.dataset.symbol;
        renderHeader();
      });
      row.addEventListener("dblclick", () => openSymbol(row.dataset.symbol));
    });
  }

  function renderMarketStrip() {
    const symbols = ["000001", "600519", state.symbol].filter((symbol, index, arr) => arr.indexOf(symbol) === index);
    const tiles = symbols
      .map((symbol) => {
        const stock = getStock(symbol);
        const quote = getQuote(symbol);
        if (!stock || !quote) {
          return makeIndexTile(stock ? stock.name : symbol, NaN, NaN);
        }
        return makeIndexTile(stock.name, quote.close, quote.pct);
      })
      .join("");
    el.marketStrip.innerHTML = tiles || `<div class="empty-state">暂无行情</div>`;
  }

  function makeIndexTile(name, value, pct) {
    const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
    return `
      <div class="index-tile">
        <b>${escapeHtml(name)}</b>
        <span class="${cls}">${formatOptional(value)} ${Number.isFinite(pct) && pct > 0 ? "+" : ""}${Number.isFinite(pct) ? pct.toFixed(2) : "--"}%</span>
      </div>
    `;
  }

  function renderQuotes() {
    const filtered = sortedQuotes()
      .filter((quote) => {
      const key = `${quote.symbol} ${quote.name}`.toLowerCase();
      return !state.search || key.includes(state.search);
      })
      .slice(0, 180);

    el.quoteList.innerHTML = filtered
      .map((quote) => {
        const cls = quote.change > 0 ? "up" : quote.change < 0 ? "down" : "flat";
        const stale = quote.suspended ? " · 停牌" : "";
        return `
          <button class="quote-row ${quote.symbol === state.symbol ? "active" : ""}" data-symbol="${quote.symbol}">
            <span>
              <strong>${quote.symbol}</strong>
              <small>${escapeHtml(quote.name)}${stale}</small>
            </span>
            <span class="quote-price">
              <strong class="${cls}">${formatPrice(quote.close)}</strong>
              <small class="${cls}">${quote.change >= 0 ? "+" : ""}${formatPrice(quote.change)} / ${quote.pct >= 0 ? "+" : ""}${quote.pct.toFixed(2)}%</small>
            </span>
          </button>
        `;
      })
      .join("");

    el.quoteList.querySelectorAll(".quote-row").forEach((row) => {
      row.addEventListener("click", async () => {
        state.symbol = row.dataset.symbol;
        state.hover = null;
        state.rangeSelection = null;
        renderHeader();
      });
      row.addEventListener("dblclick", () => openSymbol(row.dataset.symbol));
    });
  }

  function renderHeader() {
    const stock = getStock(state.symbol);
    const quote = getQuote(state.symbol);
    if (state.view === "market") {
      el.symbolTitle.textContent = quote ? `${quote.symbol} ${quote.name}` : "全市场行情";
      el.symbolMeta.textContent = quote
        ? `${quote.date} · ${quote.pct >= 0 ? "+" : ""}${quote.pct.toFixed(2)}% · 双击表格进入单股`
        : "双击股票进入 K 线与交易";
      return;
    }
    const bars = currentBars();
    const bar = bars[bars.length - 1];
    const prev = bars[Math.max(0, bars.length - 2)];

    if (!stock || !bar || !prev) {
      el.symbolTitle.textContent = stock ? `${stock.symbol} ${stock.name}` : "--";
      el.symbolMeta.textContent = "无行情";
      return;
    }

    const pct = prev.close ? ((bar.close - prev.close) / prev.close) * 100 : 0;
    const tradeStatus = marketRuleStatus(bars, bars.length - 1);
    const statusText = tradeStatus.suspended ? "停牌/无交易" : bar.close >= prev.close ? "上涨" : "下跌";

    el.symbolTitle.textContent = `${stock.symbol} ${stock.name}`;
    el.symbolMeta.textContent = `${bar.date} · ${statusText} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  }

  function renderReadout() {
    const bars = currentBars();
    const bar = bars[bars.length - 1];
    const prev = bars[Math.max(0, bars.length - 2)];
    if (!bar || !prev) {
      el.priceReadout.innerHTML = `<div class="readout-cell"><span>行情</span><strong>--</strong></div>`;
      el.orderPrice.textContent = "--";
      return;
    }

    const change = bar.close - prev.close;
    const pct = prev.close ? (change / prev.close) * 100 : 0;
    const indicators = calculateIndicators(bars);
    const maFast = indicators.maFast[bars.length - 1];
    const maSlow = indicators.maSlow[bars.length - 1];
    const rsiValue = indicators.rsiFastLine[bars.length - 1];
    const changeCls = change > 0 ? "up" : change < 0 ? "down" : "flat";

    const cells = [
      ["开盘", formatPrice(bar.open), ""],
      ["最高", formatPrice(bar.high), "up"],
      ["最低", formatPrice(bar.low), "down"],
      ["收盘", formatPrice(bar.close), changeCls],
      ["涨跌幅", `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`, changeCls],
      [`MA${state.settings.indicators.maFast} / MA${state.settings.indicators.maSlow}`, `${formatOptional(maFast)} / ${formatOptional(maSlow)}`, ""],
      [`RSI${state.settings.indicators.rsiFast}`, formatOptional(rsiValue), rsiValue > 70 ? "up" : rsiValue < 30 ? "down" : ""]
    ];

    el.priceReadout.innerHTML = cells
      .map(
        ([label, value, cls]) => `
        <div class="readout-cell">
          <span>${label}</span>
          <strong class="${cls}">${value}</strong>
        </div>
      `
      )
      .join("");

    el.orderPrice.textContent = formatPrice(executionPrice("BUY", bar.close));
  }

  function renderRangeStats() {
    const bars = currentBars();
    const selection = normalizeSelection(state.rangeSelection);
    if (!selection || !bars.length) {
      el.rangeStats.innerHTML = `<span>区间 <strong>--</strong></span><span>收益 <strong>--</strong></span><span>振幅 <strong>--</strong></span><span>成交量 <strong>--</strong></span>`;
      return;
    }
    const start = clamp(selection.start, 0, bars.length - 1);
    const end = clamp(selection.end, 0, bars.length - 1);
    const slice = bars.slice(start, end + 1);
    if (!slice.length) return;
    const first = slice[0];
    const last = slice[slice.length - 1];
    const high = Math.max(...slice.map((bar) => bar.high));
    const low = Math.min(...slice.map((bar) => bar.low));
    const volume = slice.reduce((sum, bar) => sum + bar.volume, 0);
    const ret = first.close ? ((last.close - first.close) / first.close) * 100 : 0;
    const amp = low ? ((high - low) / low) * 100 : 0;
    const cls = ret > 0 ? "up" : ret < 0 ? "down" : "flat";

    el.rangeStats.innerHTML = `
      <span>区间 <strong>${first.date} → ${last.date}</strong></span>
      <span>周期 <strong>${slice.length} 日</strong></span>
      <span>收益 <strong class="${cls}">${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%</strong></span>
      <span>振幅 <strong>${amp.toFixed(2)}%</strong></span>
      <span>成交量 <strong>${formatCompact(volume)}</strong></span>
    `;
  }

  function renderAccount() {
    const account = rebuildAccount();
    el.equityValue.textContent = currency(account.equity);
    el.cashValue.textContent = currency(account.cash);
    el.marketValue.textContent = currency(account.marketValue);
    el.pnlValue.textContent = `${account.pnl >= 0 ? "+" : ""}${currency(account.pnl)} / ${account.pnlPct >= 0 ? "+" : ""}${account.pnlPct.toFixed(2)}%`;
    el.pnlValue.className = account.pnl > 0 ? "up" : account.pnl < 0 ? "down" : "flat";

    renderPositions(account);
    renderTrades();
  }

  function renderPositions(account) {
    const rows = Object.entries(account.positions)
      .filter(([, position]) => position.qty > 0)
      .map(([symbol, position]) => {
        const stock = getStock(symbol);
        const price = latestClose(symbol);
        const pnl = Number.isFinite(price) ? (price - position.avgCost) * position.qty : 0;
        return `
          <div class="position-row">
            <strong>${symbol} ${escapeHtml(stock ? stock.name : "")}</strong>
            <span>数量 ${position.qty} · 成本 ${formatPrice(position.avgCost)} · 现价 ${formatOptional(price)}</span>
            <span class="${pnl >= 0 ? "up" : "down"}">盈亏 ${pnl >= 0 ? "+" : ""}${currency(pnl)}</span>
          </div>
        `;
      });

    el.positionList.innerHTML = rows.length ? rows.join("") : `<div class="empty-state">暂无持仓</div>`;
  }

  function renderTrades() {
    const visibleTrades = visibleTradeList().slice().reverse();

    el.tradeLog.innerHTML = visibleTrades.length
      ? visibleTrades
          .map(
            (trade) => `
            <div class="trade-row">
              <strong class="${trade.side === "BUY" ? "up" : "down"}">${trade.side === "BUY" ? "买入" : "卖出"}</strong>
              <span>${trade.symbol}<br />${trade.date}</span>
              <span>${trade.qty} 股<br />${formatPrice(trade.price)} · 费 ${currency(trade.fee)}</span>
            </div>
          `
          )
          .join("")
      : `<div class="empty-state">暂无成交</div>`;
  }

  function renderSessions() {
    el.sessionSelect.innerHTML = state.sessions.length
      ? state.sessions
          .map((session) => {
            const selected = session.id === state.currentSessionId ? "selected" : "";
            const label = `${session.name || "未命名复盘"} · ${session.as_of_date || "--"}`;
            return `<option value="${session.id}" ${selected}>${escapeHtml(label)}</option>`;
          })
          .join("")
      : `<option value="">暂无复盘</option>`;
  }

  function renderCharts() {
    if (state.view !== "detail") return;
    const bars = currentBars();
    if (!bars.length) {
      clearCanvas(el.priceCanvas);
      clearCanvas(el.volumeCanvas);
      el.indicatorCanvases.forEach(clearCanvas);
      chartState.range = null;
      chartState.priceScale = null;
      return;
    }

    const indicators = calculateIndicators(bars);
    chartState.latestIndicators = indicators;
    const end = bars.length - 1;
    const start = Math.max(0, end - state.displayBars + 1);
    const range = { start, end, bars: bars.slice(start, end + 1) };
    chartState.range = range;

    drawPriceChart(el.priceCanvas, bars, indicators, range);
    drawVolumeChart(el.volumeCanvas, bars, range);
    el.indicatorCanvases.forEach((canvas, index) => {
      const panel = state.indicatorPanels[index] || state.indicatorPanels[0];
      const panelIndicators = calculateIndicators(bars, indicatorSettingsForPanel(panel));
      drawIndicatorChart(canvas, bars, panelIndicators, range, panel);
    });
  }

  function drawPriceChart(canvas, bars, indicators, range) {
    const ctx = prepareCanvas(canvas);
    const { width, height } = canvas.getBoundingClientRect();
    const pad = { left: 58, right: 72, top: 22, bottom: 26 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const visible = range.bars;
    const values = [];
    const p = state.settings.indicators;

    visible.forEach((bar) => values.push(bar.high, bar.low));
    if (state.showMA) {
      ["maFast", "maMid", "maSlow"].forEach((key) => {
        indicators[key].slice(range.start, range.end + 1).forEach((value) => {
          if (Number.isFinite(value)) values.push(value);
        });
      });
    }
    if (state.showBOLL) {
      ["bollUpper", "bollLower"].forEach((key) => {
        indicators[key].slice(range.start, range.end + 1).forEach((value) => {
          if (Number.isFinite(value)) values.push(value);
        });
      });
    }

    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const min = minValue * 0.995;
    const max = maxValue * 1.005;
    const y = (price) => pad.top + ((max - price) / Math.max(max - min, 0.0001)) * plotH;
    const priceForY = (yy) => max - ((yy - pad.top) / plotH) * (max - min);
    const barW = plotW / Math.max(visible.length, 1);
    const candleW = Math.max(3, Math.min(13, barW * 0.56));
    const xForIndex = (index) => pad.left + (index - range.start) * barW + barW / 2;
    const indexForX = (x) => clamp(Math.round((x - pad.left - barW / 2) / barW) + range.start, range.start, range.end);

    chartState.priceScale = { pad, width, height, plotW, plotH, min, max, y, priceForY, xForIndex, indexForX, barW, range };

    fill(ctx, "#080b0f", width, height);
    drawGrid(ctx, pad, width, height, 5, 6);
    drawRangeHighlight(ctx, pad, height, xForIndex, range);

    for (let i = 0; i <= 5; i += 1) {
      const price = max - ((max - min) / 5) * i;
      drawAxisText(ctx, formatPrice(price), width - pad.right + 10, y(price) + 4, "#7f8a99", "left");
    }

    visible.forEach((bar, offset) => {
      const x = pad.left + offset * barW + barW / 2;
      const rising = bar.close >= bar.open;
      const color = rising ? "#e05252" : "#20b26b";
      const openY = y(bar.open);
      const closeY = y(bar.close);
      const highY = y(bar.high);
      const lowY = y(bar.low);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      line(ctx, x, highY, x, lowY);
      ctx.fillStyle = rising ? "rgba(224,82,82,0.22)" : "rgba(32,178,107,0.22)";
      ctx.strokeStyle = color;
      const bodyY = Math.min(openY, closeY);
      const bodyH = Math.max(2, Math.abs(closeY - openY));
      ctx.fillRect(x - candleW / 2, bodyY, candleW, bodyH);
      ctx.strokeRect(x - candleW / 2, bodyY, candleW, bodyH);
    });

    if (state.showMA) {
      drawSeries(ctx, indicators.maFast, range, pad, plotW, y, "#e2b34b", barW);
      drawSeries(ctx, indicators.maMid, range, pad, plotW, y, "#5ea1ff", barW);
      drawSeries(ctx, indicators.maSlow, range, pad, plotW, y, "#b884ff", barW);
      drawLegend(ctx, [`MA${p.maFast}`, `MA${p.maMid}`, `MA${p.maSlow}`], ["#e2b34b", "#5ea1ff", "#b884ff"], pad.left, 15);
    }

    if (state.showBOLL) {
      drawSeries(ctx, indicators.bollUpper, range, pad, plotW, y, "#d8dfe8", barW);
      drawSeries(ctx, indicators.bollMid, range, pad, plotW, y, "#19b4a6", barW);
      drawSeries(ctx, indicators.bollLower, range, pad, plotW, y, "#d8dfe8", barW);
      drawLegend(ctx, [`BOLL${p.bollPeriod}`], ["#19b4a6"], pad.left + 210, 15);
    }

    drawDrawings(ctx, bars, range, xForIndex, y);

    const dates = [visible[0], visible[Math.floor(visible.length / 2)], visible[visible.length - 1]].filter(Boolean);
    dates.forEach((bar) => {
      const index = bars.indexOf(bar);
      drawAxisText(ctx, bar.date.slice(5), xForIndex(index), height - 9, "#7f8a99", "center");
    });

    const current = bars[bars.length - 1];
    drawAxisText(ctx, `${current.date} 收盘 ${formatPrice(current.close)}`, width - pad.right - 6, 16, "#d7dde5", "right");
    drawCrosshair(ctx, "price", pad, width, height, xForIndex, y);
  }

  function drawVolumeChart(canvas, bars, range) {
    const ctx = prepareCanvas(canvas);
    const { width, height } = canvas.getBoundingClientRect();
    const pad = { left: 58, right: 72, top: 14, bottom: 20 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const barW = plotW / Math.max(range.bars.length, 1);
    const max = Math.max(1, ...range.bars.map((bar) => bar.volume));
    const y = (value) => pad.top + (1 - value / max) * plotH;
    const xForIndex = (index) => pad.left + (index - range.start) * barW + barW / 2;

    fill(ctx, "#080b0f", width, height);
    drawGrid(ctx, pad, width, height, 2, 6);
    drawRangeHighlight(ctx, pad, height, xForIndex, range);

    range.bars.forEach((bar, offset) => {
      const prev = bars[Math.max(0, range.start + offset - 1)];
      const rising = bar.close >= prev.close;
      const x = pad.left + offset * barW + barW * 0.2;
      ctx.fillStyle = rising ? "rgba(224,82,82,0.68)" : "rgba(32,178,107,0.68)";
      ctx.fillRect(x, y(bar.volume), Math.max(2, barW * 0.56), Math.max(1, height - pad.bottom - y(bar.volume)));
    });

    drawAxisText(ctx, formatCompact(max), width - pad.right + 10, pad.top + 10, "#7f8a99", "left");
    drawAxisText(ctx, "VOL", width - pad.right - 6, 13, "#d7dde5", "right");
    drawCrosshair(ctx, "volume", pad, width, height, xForIndex);
  }

  function drawIndicatorChart(canvas, bars, indicators, range, panelConfig = { type: state.panel }) {
    const ctx = prepareCanvas(canvas);
    const { width, height } = canvas.getBoundingClientRect();
    const pad = { left: 58, right: 72, top: 18, bottom: 24 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const barW = plotW / Math.max(range.bars.length, 1);
    const panel = panelConfig.type || state.panel;
    const p = state.settings.indicators;
    const xForIndex = (index) => pad.left + (index - range.start) * barW + barW / 2;

    fill(ctx, "#080b0f", width, height);
    drawGrid(ctx, pad, width, height, 3, 6);
    drawRangeHighlight(ctx, pad, height, xForIndex, range);

    if (panel === "macd") {
      const macd = indicators.macd.slice(range.start, range.end + 1);
      const signal = indicators.signal.slice(range.start, range.end + 1);
      const hist = indicators.hist.slice(range.start, range.end + 1);
      const values = macd.concat(signal, hist).filter(Number.isFinite);
      const limit = Math.max(0.01, values.length ? Math.max(...values.map(Math.abs)) : 0.01);
      const y = (value) => pad.top + ((limit - value) / (limit * 2)) * plotH;
      const zeroY = y(0);
      line(ctx, pad.left, zeroY, width - pad.right, zeroY, "#394450");
      hist.forEach((value, i) => {
        if (!Number.isFinite(value)) return;
        const x = pad.left + i * barW + barW * 0.2;
        ctx.fillStyle = value >= 0 ? "rgba(224,82,82,0.72)" : "rgba(32,178,107,0.72)";
        ctx.fillRect(x, Math.min(zeroY, y(value)), Math.max(2, barW * 0.55), Math.max(1, Math.abs(zeroY - y(value))));
      });
      drawSeries(ctx, indicators.macd, range, pad, plotW, y, "#e2b34b", barW);
      drawSeries(ctx, indicators.signal, range, pad, plotW, y, "#5ea1ff", barW);
      drawLegend(ctx, [`DIF(${p.macdFast},${p.macdSlow})`, `DEA${p.macdSignal}`, "MACD"], ["#e2b34b", "#5ea1ff", "#e05252"], pad.left, 13);
    }

    if (panel === "rsi") {
      const values = indicators.rsiFastLine.slice(range.start, range.end + 1).filter(Number.isFinite);
      const y = (value) => pad.top + ((100 - value) / 100) * plotH;
      line(ctx, pad.left, y(70), width - pad.right, y(70), "rgba(224,82,82,0.35)");
      line(ctx, pad.left, y(30), width - pad.right, y(30), "rgba(32,178,107,0.35)");
      drawSeries(ctx, indicators.rsiFastLine, range, pad, plotW, y, "#e2b34b", barW);
      drawSeries(ctx, indicators.rsiSlowLine, range, pad, plotW, y, "#5ea1ff", barW);
      drawAxisText(ctx, "70", width - pad.right + 10, y(70) + 4, "#7f8a99", "left");
      drawAxisText(ctx, "30", width - pad.right + 10, y(30) + 4, "#7f8a99", "left");
      drawLegend(ctx, [`RSI${p.rsiFast} ${formatOptional(values[values.length - 1])}`, `RSI${p.rsiSlow}`], ["#e2b34b", "#5ea1ff"], pad.left, 13);
    }

    if (panel === "kdj") {
      const y = (value) => pad.top + ((100 - value) / 100) * plotH;
      line(ctx, pad.left, y(80), width - pad.right, y(80), "rgba(224,82,82,0.35)");
      line(ctx, pad.left, y(20), width - pad.right, y(20), "rgba(32,178,107,0.35)");
      drawSeries(ctx, indicators.k, range, pad, plotW, y, "#e2b34b", barW);
      drawSeries(ctx, indicators.d, range, pad, plotW, y, "#5ea1ff", barW);
      drawSeries(ctx, indicators.j, range, pad, plotW, y, "#b884ff", barW);
      drawLegend(ctx, [`KDJ${p.kdjPeriod}`, "K", "D", "J"], ["#9aa5b4", "#e2b34b", "#5ea1ff", "#b884ff"], pad.left, 13);
    }

    if (panel === "dmi") {
      const y = (value) => pad.top + ((100 - value) / 100) * plotH;
      line(ctx, pad.left, y(50), width - pad.right, y(50), "rgba(127,138,153,0.26)");
      line(ctx, pad.left, y(25), width - pad.right, y(25), "rgba(127,138,153,0.18)");
      drawSeries(ctx, indicators.pdi, range, pad, plotW, y, "#e05252", barW);
      drawSeries(ctx, indicators.mdi, range, pad, plotW, y, "#20b26b", barW);
      drawSeries(ctx, indicators.adx, range, pad, plotW, y, "#e2b34b", barW);
      drawSeries(ctx, indicators.adxr, range, pad, plotW, y, "#5ea1ff", barW);
      drawAxisText(ctx, "50", width - pad.right + 10, y(50) + 4, "#7f8a99", "left");
      drawAxisText(ctx, "25", width - pad.right + 10, y(25) + 4, "#7f8a99", "left");
      drawLegend(ctx, [`DMI${p.dmiPeriod}`, "PDI", "MDI", "ADX", "ADXR"], ["#9aa5b4", "#e05252", "#20b26b", "#e2b34b", "#5ea1ff"], pad.left, 13);
    }

    if (panel === "capital") {
      const y = (value) => pad.top + ((100 - value) / 200) * plotH;
      line(ctx, pad.left, y(0), width - pad.right, y(0), "#394450");
      line(ctx, pad.left, y(50), width - pad.right, y(50), "rgba(224,82,82,0.22)");
      line(ctx, pad.left, y(-50), width - pad.right, y(-50), "rgba(32,178,107,0.22)");
      drawSeries(ctx, indicators.superFund, range, pad, plotW, y, "#e05252", barW);
      drawSeries(ctx, indicators.largeFund, range, pad, plotW, y, "#e2b34b", barW);
      drawSeries(ctx, indicators.middleFund, range, pad, plotW, y, "#5ea1ff", barW);
      drawSeries(ctx, indicators.retailFund, range, pad, plotW, y, "#20b26b", barW);
      drawAxisText(ctx, "+50", width - pad.right + 10, y(50) + 4, "#7f8a99", "left");
      drawAxisText(ctx, "0", width - pad.right + 10, y(0) + 4, "#7f8a99", "left");
      drawAxisText(ctx, "-50", width - pad.right + 10, y(-50) + 4, "#7f8a99", "left");
      drawLegend(ctx, ["超大", "大户", "中户", "散户"], ["#e05252", "#e2b34b", "#5ea1ff", "#20b26b"], pad.left, 13);
    }

    drawAxisText(ctx, panelTitle(panel), width - pad.right - 6, 13, "#d7dde5", "right");
    drawCrosshair(ctx, "indicator", pad, width, height, xForIndex);
  }

  function drawDrawings(ctx, bars, range, xForIndex, y) {
    const drawings = state.drawings.filter((drawing) => drawing.symbol === state.symbol);
    const active = state.draftDrawing ? drawings.concat(state.draftDrawing) : drawings;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    active.forEach((drawing) => {
      const startIndex = bars.findIndex((bar) => bar.date === drawing.startDate);
      const endIndex = bars.findIndex((bar) => bar.date === drawing.endDate);
      if (startIndex < 0 || endIndex < 0) return;
      if (Math.max(startIndex, endIndex) < range.start || Math.min(startIndex, endIndex) > range.end) return;
      ctx.strokeStyle = drawing.draft ? "rgba(226,179,75,0.62)" : "rgba(226,179,75,0.9)";
      ctx.beginPath();
      ctx.moveTo(xForIndex(startIndex), y(drawing.startPrice));
      ctx.lineTo(xForIndex(endIndex), y(drawing.endPrice));
      ctx.stroke();
    });
    ctx.restore();
  }

  function drawRangeHighlight(ctx, pad, height, xForIndex, range) {
    const selection = normalizeSelection(state.rangeSelection);
    if (!selection) return;
    if (selection.end < range.start || selection.start > range.end) return;
    const start = clamp(selection.start, range.start, range.end);
    const end = clamp(selection.end, range.start, range.end);
    const x1 = xForIndex(start);
    const x2 = xForIndex(end);
    ctx.fillStyle = "rgba(94,161,255,0.10)";
    ctx.fillRect(Math.min(x1, x2), pad.top, Math.max(2, Math.abs(x2 - x1)), height - pad.top - pad.bottom);
  }

  function drawCrosshair(ctx, source, pad, width, height, xForIndex, y) {
    if (!state.hover || !chartState.range) return;
    const index = clamp(state.hover.index, chartState.range.start, chartState.range.end);
    const bar = currentBars()[index];
    if (!bar) return;
    const x = xForIndex(index);

    ctx.save();
    ctx.strokeStyle = "rgba(216,223,232,0.42)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    line(ctx, x, pad.top, x, height - pad.bottom);

    if (state.hover.source === source && Number.isFinite(state.hover.y)) {
      line(ctx, pad.left, state.hover.y, width - pad.right, state.hover.y);
    }
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(13,17,22,0.88)";
    ctx.fillRect(Math.min(width - pad.right - 150, Math.max(pad.left, x + 8)), pad.top + 4, 142, 38);
    ctx.fillStyle = "#d7dde5";
    ctx.textAlign = "left";
    ctx.fillText(bar.date, Math.min(width - pad.right - 140, Math.max(pad.left + 8, x + 16)), pad.top + 20);
    ctx.fillStyle = bar.close >= bar.open ? "#e05252" : "#20b26b";
    ctx.fillText(`收 ${formatPrice(bar.close)} 量 ${formatCompact(bar.volume)}`, Math.min(width - pad.right - 140, Math.max(pad.left + 8, x + 16)), pad.top + 35);

    if (source === "price" && y) {
      const yy = y(bar.close);
      ctx.fillStyle = "rgba(216,223,232,0.85)";
      ctx.beginPath();
      ctx.arc(x, yy, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function handlePointerMove(event) {
    if (!chartState.range || !chartState.priceScale) return;
    const canvas = event.currentTarget;
    const point = canvasPoint(canvas, event);
    const index = chartState.priceScale.indexForX(point.x);
    state.hover = {
      index,
      source: canvas === el.priceCanvas ? "price" : canvas === el.volumeCanvas ? "volume" : "indicator",
      x: point.x,
      y: point.y
    };

    if (state.drag && state.tool === "range") {
      state.rangeSelection = { start: state.drag.startIndex, end: index };
      renderRangeStats();
    }

    if (state.drag && state.tool === "line" && canvas === el.priceCanvas) {
      const bars = currentBars();
      const endPrice = chartState.priceScale.priceForY(point.y);
      state.draftDrawing = {
        symbol: state.symbol,
        startDate: bars[state.drag.startIndex].date,
        startPrice: state.drag.startPrice,
        endDate: bars[index].date,
        endPrice,
        draft: true
      };
    }

    renderCharts();
  }

  function handlePointerDown(event) {
    if (!chartState.range || !chartState.priceScale) return;
    const point = canvasPoint(event.currentTarget, event);
    const index = chartState.priceScale.indexForX(point.x);
    const bars = currentBars();
    if (!bars[index]) return;

    if (state.tool === "range") {
      state.drag = { type: "range", startIndex: index };
      state.rangeSelection = { start: index, end: index };
      renderRangeStats();
      renderCharts();
      return;
    }

    if (state.tool === "line" && event.currentTarget === el.priceCanvas) {
      state.drag = {
        type: "line",
        startIndex: index,
        startPrice: chartState.priceScale.priceForY(point.y)
      };
      state.draftDrawing = null;
    }
  }

  function handlePointerUp(event) {
    if (!state.drag || !chartState.priceScale) return;
    const point = canvasPoint(event.currentTarget, event);
    const index = chartState.priceScale.indexForX(point.x);
    const bars = currentBars();

    if (state.drag.type === "range") {
      state.rangeSelection = { start: state.drag.startIndex, end: index };
    }

    if (state.drag.type === "line" && event.currentTarget === el.priceCanvas && bars[index]) {
      const drawing = {
        symbol: state.symbol,
        startDate: bars[state.drag.startIndex].date,
        startPrice: state.drag.startPrice,
        endDate: bars[index].date,
        endPrice: chartState.priceScale.priceForY(point.y)
      };
      if (drawing.startDate !== drawing.endDate || Math.abs(drawing.startPrice - drawing.endPrice) > 0.0001) {
        state.drawings.push(drawing);
      }
      state.draftDrawing = null;
    }

    state.drag = null;
    renderRangeStats();
    renderCharts();
  }

  function handlePointerLeave() {
    if (!state.drag) {
      state.hover = null;
      renderCharts();
    }
  }

  function canvasPoint(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  function placeOrder(side) {
    const qty = normalizeQty(Number(el.orderQty.value));
    const bars = currentBars();
    const index = bars.length - 1;
    const bar = bars[index];
    const account = rebuildAccount();
    const position = account.positions[state.symbol] || { qty: 0, avgCost: 0 };

    if (!bar || qty <= 0) return;
    const ruleError = validateMarketRules(side, bars, index);
    if (ruleError) {
      flashButton(side === "BUY" ? el.buyBtn : el.sellBtn, ruleError);
      return;
    }

    const price = executionPrice(side, bar.close);
    const amount = qty * price;
    const fee = calculateFee(side, amount);

    if (side === "BUY" && amount + fee > account.cash) {
      flashButton(el.buyBtn, "资金不足");
      return;
    }
    if (side === "SELL" && qty > position.qty) {
      flashButton(el.sellBtn, "持仓不足");
      return;
    }

    branchTimeline();
    state.trades.push({
      id: randomId(),
      symbol: state.symbol,
      side,
      qty,
      price,
      referencePrice: bar.close,
      fee,
      amount,
      date: bar.date,
      as_of_date: state.asOfDate,
      index,
      slippageBps: state.settings.trade.slippageBps,
      config: { ...state.settings.trade }
    });

    renderAll();
  }

  function validateMarketRules(side, bars, index) {
    const status = marketRuleStatus(bars, index);
    const cfg = state.settings.trade;
    if (cfg.enforceSuspension && status.suspended) return "停牌";
    if (cfg.enforceLimit && side === "BUY" && status.limitUp) return "涨停";
    if (cfg.enforceLimit && side === "SELL" && status.limitDown) return "跌停";
    return "";
  }

  function marketRuleStatus(bars, index) {
    const bar = bars[index];
    const prev = bars[Math.max(0, index - 1)];
    if (!bar) return { suspended: true, limitUp: false, limitDown: false };

    const weekdayNoPrint = bar.date < state.asOfDate && isWeekday(state.asOfDate);
    const suspended = Boolean(bar.suspended) || bar.volume <= 0 || weekdayNoPrint;
    if (!prev || prev === bar || !Number.isFinite(prev.close) || prev.close <= 0) {
      return { suspended, limitUp: false, limitDown: false };
    }

    const limit = Math.max(0.01, state.settings.trade.limitPct / 100);
    const up = prev.close * (1 + limit);
    const down = prev.close * (1 - limit);
    const tolerance = prev.close * 0.0015;
    return {
      suspended,
      limitUp: bar.close >= up - tolerance,
      limitDown: bar.close <= down + tolerance
    };
  }

  function executionPrice(side, close) {
    const slip = Math.max(0, state.settings.trade.slippageBps) / 10000;
    return roundPrice(close * (side === "BUY" ? 1 + slip : 1 - slip));
  }

  function calculateFee(side, amount) {
    const cfg = state.settings.trade;
    const commission = Math.max(cfg.minCommission, amount * (cfg.commissionRatePct / 100));
    const stamp = side === "SELL" ? amount * (cfg.stampDutyRatePct / 100) : 0;
    return roundMoney(commission + stamp);
  }

  function flashButton(button, text) {
    const previous = button.textContent;
    button.textContent = text;
    button.disabled = true;
    window.setTimeout(() => {
      button.textContent = previous;
      button.disabled = false;
    }, 850);
  }

  function rebuildAccount() {
    let cash = INITIAL_CASH;
    const positions = {};
    const trades = visibleTradeList().slice().sort((a, b) => a.date.localeCompare(b.date));

    trades.forEach((trade) => {
      const position = positions[trade.symbol] || { qty: 0, avgCost: 0, cost: 0 };
      if (trade.side === "BUY") {
        cash -= trade.amount + trade.fee;
        position.cost += trade.amount + trade.fee;
        position.qty += trade.qty;
        position.avgCost = position.cost / position.qty;
      } else if (position.qty > 0) {
        const sellQty = Math.min(trade.qty, position.qty);
        const ratio = sellQty / position.qty;
        cash += trade.amount - trade.fee;
        position.cost *= Math.max(0, 1 - ratio);
        position.qty -= sellQty;
        position.avgCost = position.qty > 0 ? position.cost / position.qty : 0;
      }
      positions[trade.symbol] = position;
    });

    let marketValue = 0;
    Object.entries(positions).forEach(([symbol, position]) => {
      if (position.qty <= 0) return;
      const price = latestClose(symbol);
      if (Number.isFinite(price)) marketValue += position.qty * price;
    });

    const equity = cash + marketValue;
    const pnl = equity - INITIAL_CASH;
    const pnlPct = (pnl / INITIAL_CASH) * 100;
    return { cash, positions, marketValue, equity, pnl, pnlPct };
  }

  function visibleTradeList() {
    const currentDate = currentTradingDate() || state.asOfDate;
    return state.trades.filter((trade) => String(trade.date || "") <= currentDate);
  }

  async function moveDay(step) {
    if (state.loading) return false;
    const bars = currentBars();
    const originalAsOf = state.asOfDate;
    const originalTradingDate = currentTradingDate();

    if (step < 0) {
      if (!bars.length) {
        state.asOfDate = shiftCalendarDays(originalAsOf, -1);
        marketData.clear();
        await loadMarketData();
        renderAll();
        return true;
      }
      if (bars.length < 2) return false;
      state.asOfDate = bars[bars.length - 2].date;
      branchTimeline();
      marketData.clear();
      await loadMarketData();
      renderAll();
      return true;
    }

    if (!bars.length) {
      const nextDate = shiftCalendarDays(originalAsOf, 1);
      if (nextDate > todayString()) return false;
      state.asOfDate = nextDate;
      marketData.clear();
      await loadMarketData();
      renderAll();
      return true;
    }

    for (let offset = 1; offset <= 10; offset += 1) {
      const nextDate = shiftCalendarDays(originalAsOf, offset);
      if (nextDate > todayString()) break;
      state.asOfDate = nextDate;
      marketData.clear();
      await loadMarketData();
      const nextTradingDate = currentTradingDate();
      if (nextTradingDate && nextTradingDate !== originalTradingDate && nextTradingDate > originalTradingDate) {
        branchTimeline();
        renderAll();
        return true;
      }
    }

    state.asOfDate = originalAsOf;
    marketData.clear();
    await loadMarketData();
    renderAll();
    return false;
  }

  function togglePlayback() {
    if (state.playing) {
      stopPlayback();
      return;
    }
    state.playing = true;
    el.playToggle.textContent = "Ⅱ";
    state.timer = window.setInterval(async () => {
      const moved = await moveDay(1);
      if (!moved) stopPlayback();
    }, 1200);
  }

  function stopPlayback() {
    if (state.timer) window.clearInterval(state.timer);
    state.timer = null;
    state.playing = false;
    el.playToggle.textContent = "▶";
  }

  function branchTimeline() {
    const currentDate = currentTradingDate() || state.asOfDate;
    state.trades = state.trades.filter((trade) => String(trade.date || "") <= currentDate);
  }

  async function saveSession() {
    const currentDate = currentTradingDate() || state.asOfDate;
    const stock = getStock(state.symbol);
    const name =
      el.sessionName.value.trim() ||
      `${stock ? stock.name : state.symbol} ${currentDate} 复盘`;
    const payload = {
      name,
      symbol: state.symbol,
      as_of_date: currentDate,
      trades: visibleTradeList(),
      drawings: state.drawings,
      settings: {
        panel: state.panel,
        displayBars: state.displayBars,
        indicatorPanels: state.indicatorPanels,
        showMA: state.showMA,
        showBOLL: state.showBOLL,
        indicators: state.settings.indicators,
        trade: state.settings.trade
      }
    };

    try {
      const result = await fetchJson("/api/sessions", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      state.currentSessionId = result.session.id;
      await loadSessions();
      renderSessions();
      flashButton(el.saveSession, "已保存");
    } catch (error) {
      flashButton(el.saveSession, "失败");
      console.error(error);
    }
  }

  async function loadSessions() {
    const payload = await fetchJson("/api/sessions");
    state.sessions = payload.sessions || [];
  }

  async function loadSelectedSession() {
    const id = el.sessionSelect.value;
    if (!id) return;
    const summary = state.sessions.find((session) => session.id === id);
    const loadAsOf = summary && summary.as_of_date ? summary.as_of_date : state.asOfDate;

    try {
      const params = new URLSearchParams({ as_of_date: loadAsOf });
      const payload = await fetchJson(`/api/sessions/${id}?${params.toString()}`);
      const session = payload.session;
      state.currentSessionId = session.id;
      state.symbol = session.symbol || state.symbol;
      state.asOfDate = session.as_of_date || loadAsOf;
      state.view = "detail";
      state.trades = session.trades || [];
      state.drawings = session.drawings || [];
      if (session.settings) applySettings(session.settings);
      marketData.clear();
      await loadMarketData();
      renderAll();
      flashButton(el.loadSession, "已加载");
    } catch (error) {
      flashButton(el.loadSession, "失败");
      console.error(error);
    }
  }

  function applySettings(settings) {
    if (settings.panel) state.panel = settings.panel;
    if (settings.displayBars) state.displayBars = clamp(Number(settings.displayBars), MIN_DISPLAY_BARS, MAX_DISPLAY_BARS);
    if (Array.isArray(settings.indicatorPanels)) {
      state.indicatorPanels = settings.indicatorPanels.slice(0, 5).map((panel, index) => ({
        ...defaultIndicatorPanels()[index],
        ...panel
      }));
    }
    if (typeof settings.showMA === "boolean") state.showMA = settings.showMA;
    if (typeof settings.showBOLL === "boolean") state.showBOLL = settings.showBOLL;
    if (settings.indicators) state.settings.indicators = { ...state.settings.indicators, ...settings.indicators };
    if (settings.trade) state.settings.trade = { ...state.settings.trade, ...settings.trade };
    syncInputsFromSettings();
    syncPanelButtons();
    syncToolButtons();
    renderIndicatorPanelControls();
  }

  function hydrateSettingsFromInputs() {
    hydrateIndicatorSettings();
    hydrateTradeSettings();
  }

  function hydrateIndicatorSettings() {
    const p = state.settings.indicators;
    p.maFast = intValue(el.maFast, 5, 2, 250);
    p.maMid = intValue(el.maMid, 10, 2, 250);
    p.maSlow = intValue(el.maSlow, 20, 2, 250);
    p.bollPeriod = intValue(el.bollPeriod, 20, 5, 250);
    p.bollStd = numberValue(el.bollStd, 2, 0.5, 5);
    p.macdFast = intValue(el.macdFast, 12, 2, 120);
    p.macdSlow = Math.max(p.macdFast + 1, intValue(el.macdSlow, 26, 3, 260));
    p.macdSignal = intValue(el.macdSignal, 9, 2, 120);
    p.rsiFast = intValue(el.rsiFast, 6, 2, 120);
    p.rsiSlow = intValue(el.rsiSlow, 12, 2, 120);
    p.kdjPeriod = intValue(el.kdjPeriod, 9, 3, 120);
    p.dmiPeriod = intValue(el.dmiPeriod, 14, 3, 120);
    syncInputsFromSettings();
  }

  function hydrateTradeSettings() {
    const cfg = state.settings.trade;
    cfg.slippageBps = numberValue(el.slippageBps, 5, 0, 200);
    cfg.commissionRatePct = numberValue(el.commissionRate, 0.025, 0, 1);
    cfg.minCommission = numberValue(el.minCommission, 5, 0, 100);
    cfg.stampDutyRatePct = numberValue(el.stampDutyRate, 0.05, 0, 1);
    cfg.limitPct = numberValue(el.limitPct, 10, 1, 30);
    cfg.enforceLimit = el.enforceLimit.checked;
    cfg.enforceSuspension = el.enforceSuspension.checked;
  }

  function syncInputsFromSettings() {
    const p = state.settings.indicators;
    el.maFast.value = p.maFast;
    el.maMid.value = p.maMid;
    el.maSlow.value = p.maSlow;
    el.bollPeriod.value = p.bollPeriod;
    el.bollStd.value = p.bollStd;
    el.macdFast.value = p.macdFast;
    el.macdSlow.value = p.macdSlow;
    el.macdSignal.value = p.macdSignal;
    el.rsiFast.value = p.rsiFast;
    el.rsiSlow.value = p.rsiSlow;
    el.kdjPeriod.value = p.kdjPeriod;
    el.dmiPeriod.value = p.dmiPeriod;

    const cfg = state.settings.trade;
    el.slippageBps.value = cfg.slippageBps;
    el.commissionRate.value = cfg.commissionRatePct;
    el.minCommission.value = cfg.minCommission;
    el.stampDutyRate.value = cfg.stampDutyRatePct;
    el.limitPct.value = cfg.limitPct;
    el.enforceLimit.checked = cfg.enforceLimit;
    el.enforceSuspension.checked = cfg.enforceSuspension;
    el.showMA.checked = state.showMA;
    el.showBOLL.checked = state.showBOLL;
  }

  function indicatorSettingsForPanel(panel) {
    const p = { ...state.settings.indicators };
    const period = clamp(parseInt(panel.period, 10) || 0, 2, 260);
    const second = clamp(parseInt(panel.second, 10) || 0, 0, 260);
    const signal = clamp(parseInt(panel.signal, 10) || 0, 0, 120);
    if (panel.type === "macd") {
      p.macdFast = clamp(period || p.macdFast, 2, 120);
      p.macdSlow = Math.max(p.macdFast + 1, second || p.macdSlow);
      p.macdSignal = clamp(signal || p.macdSignal, 2, 120);
    }
    if (panel.type === "rsi") {
      p.rsiFast = clamp(period || p.rsiFast, 2, 120);
      p.rsiSlow = clamp(second || p.rsiSlow, 2, 120);
    }
    if (panel.type === "kdj") p.kdjPeriod = clamp(period || p.kdjPeriod, 3, 120);
    if (panel.type === "dmi") p.dmiPeriod = clamp(period || p.dmiPeriod, 3, 120);
    if (panel.type === "capital") p.capitalPeriod = clamp(period || p.capitalPeriod, 3, 120);
    return p;
  }

  function calculateIndicators(bars, overrides) {
    const p = overrides || state.settings.indicators;
    const closes = bars.map((bar) => bar.close);
    const highs = bars.map((bar) => bar.high);
    const lows = bars.map((bar) => bar.low);
    const opens = bars.map((bar) => bar.open);
    const volumes = bars.map((bar) => bar.volume);
    const maFast = sma(closes, p.maFast);
    const maMid = sma(closes, p.maMid);
    const maSlow = sma(closes, p.maSlow);
    const bollMid = sma(closes, p.bollPeriod);
    const bollStd = rollingStd(closes, p.bollPeriod);
    const bollUpper = bollMid.map((value, index) => (Number.isFinite(value) ? value + p.bollStd * bollStd[index] : NaN));
    const bollLower = bollMid.map((value, index) => (Number.isFinite(value) ? value - p.bollStd * bollStd[index] : NaN));
    const emaFast = ema(closes, p.macdFast);
    const emaSlow = ema(closes, p.macdSlow);
    const macd = emaFast.map((value, index) => value - emaSlow[index]);
    const signal = ema(macd, p.macdSignal);
    const hist = macd.map((value, index) => (value - signal[index]) * 2);
    const rsiFastLine = rsi(closes, p.rsiFast);
    const rsiSlowLine = rsi(closes, p.rsiSlow);
    const { k, d, j } = kdj(highs, lows, closes, p.kdjPeriod);
    const { pdi, mdi, adx, adxr } = dmi(highs, lows, closes, p.dmiPeriod, Math.max(3, Math.round(p.dmiPeriod / 2)));
    const { superFund, largeFund, middleFund, retailFund } = capitalGame(opens, highs, lows, closes, volumes, p.capitalPeriod);

    return {
      maFast,
      maMid,
      maSlow,
      bollMid,
      bollUpper,
      bollLower,
      macd,
      signal,
      hist,
      rsiFastLine,
      rsiSlowLine,
      k,
      d,
      j,
      pdi,
      mdi,
      adx,
      adxr,
      superFund,
      largeFund,
      middleFund,
      retailFund
    };
  }

  function sma(values, period) {
    return values.map((_, index) => {
      if (index < period - 1) return NaN;
      let sum = 0;
      for (let i = index - period + 1; i <= index; i += 1) sum += values[i];
      return sum / period;
    });
  }

  function rollingStd(values, period) {
    return values.map((_, index) => {
      if (index < period - 1) return NaN;
      const slice = values.slice(index - period + 1, index + 1);
      const mean = slice.reduce((sum, value) => sum + value, 0) / period;
      const variance = slice.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period;
      return Math.sqrt(variance);
    });
  }

  function ema(values, period) {
    const multiplier = 2 / (period + 1);
    const output = [];
    values.forEach((value, index) => {
      if (index === 0 || !Number.isFinite(output[index - 1])) {
        output.push(value);
      } else {
        output.push((value - output[index - 1]) * multiplier + output[index - 1]);
      }
    });
    return output;
  }

  function rsi(closes, period) {
    const output = Array(closes.length).fill(NaN);
    for (let i = period; i < closes.length; i += 1) {
      let gains = 0;
      let losses = 0;
      for (let j = i - period + 1; j <= i; j += 1) {
        const diff = closes[j] - closes[j - 1];
        if (diff >= 0) gains += diff;
        else losses += Math.abs(diff);
      }
      output[i] = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
    }
    return output;
  }

  function kdj(highs, lows, closes, period) {
    const k = Array(closes.length).fill(NaN);
    const d = Array(closes.length).fill(NaN);
    const j = Array(closes.length).fill(NaN);
    let prevK = 50;
    let prevD = 50;

    for (let i = 0; i < closes.length; i += 1) {
      if (i < period - 1) continue;
      const high = Math.max(...highs.slice(i - period + 1, i + 1));
      const low = Math.min(...lows.slice(i - period + 1, i + 1));
      const rsv = high === low ? 50 : ((closes[i] - low) / (high - low)) * 100;
      prevK = (2 / 3) * prevK + (1 / 3) * rsv;
      prevD = (2 / 3) * prevD + (1 / 3) * prevK;
      k[i] = prevK;
      d[i] = prevD;
      j[i] = 3 * prevK - 2 * prevD;
    }

    return { k, d, j };
  }

  function dmi(highs, lows, closes, period, adxPeriod) {
    const tr = Array(closes.length).fill(NaN);
    const plusDM = Array(closes.length).fill(0);
    const minusDM = Array(closes.length).fill(0);

    for (let i = 1; i < closes.length; i += 1) {
      const highMove = highs[i] - highs[i - 1];
      const lowMove = lows[i - 1] - lows[i];
      tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      plusDM[i] = highMove > lowMove && highMove > 0 ? highMove : 0;
      minusDM[i] = lowMove > highMove && lowMove > 0 ? lowMove : 0;
    }

    const trRma = rma(tr, period);
    const plusRma = rma(plusDM, period);
    const minusRma = rma(minusDM, period);
    const pdi = closes.map((_, index) => (trRma[index] > 0 ? (plusRma[index] / trRma[index]) * 100 : NaN));
    const mdi = closes.map((_, index) => (trRma[index] > 0 ? (minusRma[index] / trRma[index]) * 100 : NaN));
    const dx = closes.map((_, index) => {
      const total = pdi[index] + mdi[index];
      return total > 0 ? (Math.abs(pdi[index] - mdi[index]) / total) * 100 : NaN;
    });
    const adx = rma(dx, adxPeriod);
    const adxr = adx.map((value, index) => (index >= adxPeriod && Number.isFinite(value) ? (value + adx[index - adxPeriod]) / 2 : NaN));

    return { pdi, mdi, adx, adxr };
  }

  function capitalGame(opens, highs, lows, closes, volumes, period) {
    const money = closes.map((close, index) => close * volumes[index]);
    const avgMoney = sma(money, period);
    const superRaw = [];
    const largeRaw = [];
    const middleRaw = [];
    const retailRaw = [];

    for (let i = 0; i < closes.length; i += 1) {
      if (i === 0) {
        superRaw.push(0);
        largeRaw.push(0);
        middleRaw.push(0);
        retailRaw.push(0);
        continue;
      }

      const range = Math.max(highs[i] - lows[i], closes[i] * 0.002);
      const priceChange = (closes[i] - closes[i - 1]) / closes[i - 1];
      const closeLocation = ((closes[i] - lows[i]) / range - 0.5) * 2;
      const bodyPower = (closes[i] - opens[i]) / range;
      const volumeRatio = avgMoney[i] > 0 ? clamp(money[i] / avgMoney[i], 0.55, 2.2) : 1;
      const force = clamp(priceChange * 18 + closeLocation * 0.34 + bodyPower * 0.42, -1, 1);
      const turnover = money[i] * volumeRatio;
      const activeFlow = turnover * force;
      const impulse = Math.max(0, volumeRatio - 1) * Math.sign(force) * turnover * 0.16;

      superRaw.push(activeFlow * 0.42 + impulse);
      largeRaw.push(activeFlow * 0.28);
      middleRaw.push(activeFlow * 0.12 - impulse * 0.35);
      retailRaw.push(-activeFlow * 0.34 - impulse * 0.65);
    }

    return {
      superFund: normalizeFundLine(superRaw, money, period),
      largeFund: normalizeFundLine(largeRaw, money, period),
      middleFund: normalizeFundLine(middleRaw, money, period),
      retailFund: normalizeFundLine(retailRaw, money, period)
    };
  }

  function normalizeFundLine(flows, money, period) {
    const flowSum = rollingSum(flows, period);
    const moneySum = rollingSum(money, period);
    return flows.map((_, index) => {
      if (!Number.isFinite(flowSum[index]) || !Number.isFinite(moneySum[index]) || moneySum[index] === 0) return NaN;
      return clamp((flowSum[index] / moneySum[index]) * 220, -100, 100);
    });
  }

  function rollingSum(values, period) {
    return values.map((_, index) => {
      if (index < period - 1) return NaN;
      let sum = 0;
      for (let i = index - period + 1; i <= index; i += 1) sum += Number.isFinite(values[i]) ? values[i] : 0;
      return sum;
    });
  }

  function rma(values, period) {
    const output = Array(values.length).fill(NaN);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < values.length; i += 1) {
      const value = Number.isFinite(values[i]) ? values[i] : 0;
      if (count < period) {
        sum += value;
        count += 1;
        if (count === period) output[i] = sum / period;
      } else {
        output[i] = (output[i - 1] * (period - 1) + value) / period;
      }
    }
    return output;
  }

  function prepareCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 1;
    ctx.font = "12px Microsoft YaHei, Segoe UI, sans-serif";
    return ctx;
  }

  function clearCanvas(canvas) {
    const ctx = prepareCanvas(canvas);
    const { width, height } = canvas.getBoundingClientRect();
    fill(ctx, "#080b0f", width, height);
  }

  function drawGrid(ctx, pad, width, height, rows, cols) {
    for (let i = 0; i <= rows; i += 1) {
      const y = pad.top + ((height - pad.top - pad.bottom) / rows) * i;
      line(ctx, pad.left, y, width - pad.right, y, "#1b222b");
    }
    for (let i = 0; i <= cols; i += 1) {
      const x = pad.left + ((width - pad.left - pad.right) / cols) * i;
      line(ctx, x, pad.top, x, height - pad.bottom, "#151b22");
    }
  }

  function drawSeries(ctx, series, range, pad, plotW, y, color, barW) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;
    for (let i = range.start; i <= range.end; i += 1) {
      const value = series[i];
      if (!Number.isFinite(value)) {
        started = false;
        continue;
      }
      const x = pad.left + (i - range.start) * barW + barW / 2;
      const yy = y(value);
      if (!started) {
        ctx.moveTo(x, yy);
        started = true;
      } else {
        ctx.lineTo(x, yy);
      }
    }
    ctx.stroke();
  }

  function drawLegend(ctx, labels, colors, x, y) {
    let cursor = x;
    labels.forEach((label, index) => {
      ctx.fillStyle = colors[index];
      ctx.fillRect(cursor, y - 8, 8, 2);
      ctx.fillStyle = "#9aa5b4";
      ctx.fillText(label, cursor + 12, y - 3);
      cursor += String(label).length * 7 + 34;
    });
  }

  function drawAxisText(ctx, text, x, y, color, align) {
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
  }

  function fill(ctx, color, width, height) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
  }

  function line(ctx, x1, y1, x2, y2, color) {
    if (color) ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function panelTitle(panel) {
    const titles = {
      macd: "MACD",
      rsi: "RSI",
      kdj: "KDJ",
      dmi: "DMI",
      capital: "资金博弈"
    };
    return titles[panel] || panel.toUpperCase();
  }

  function initialPanel() {
    const hash = window.location.hash.replace("#", "").toLowerCase();
    return INDICATOR_TYPES.includes(hash) ? hash : "macd";
  }

  function defaultIndicatorPanels() {
    return INDICATOR_TYPES.map((type, index) => ({
      type,
      period: type === "dmi" ? 14 : type === "capital" ? 13 : type === "rsi" ? 6 : type === "kdj" ? 9 : 12,
      second: type === "macd" ? 26 : type === "rsi" ? 12 : 0,
      signal: type === "macd" ? 9 : 0,
      enabled: index < 5
    }));
  }

  function syncPanelButtons() {
    document.querySelectorAll(".segment").forEach((item) => item.classList.toggle("active", item.dataset.panel === state.panel));
  }

  function renderIndicatorPanelControls() {
    if (!el.indicatorPanelControls) return;
    state.indicatorPanels = state.indicatorPanels.slice(0, 5);
    el.indicatorPanelControls.innerHTML = state.indicatorPanels
      .map((panel, index) => {
        const options = INDICATOR_TYPES.map(
          (type) => `<option value="${type}" ${panel.type === type ? "selected" : ""}>${panelTitle(type)}</option>`
        ).join("");
        return `
          <label>副${index + 1}
            <select data-panel-index="${index}" data-field="type">${options}</select>
          </label>
          <label>P1<input data-panel-index="${index}" data-field="period" type="number" min="2" max="260" value="${panel.period || ""}" /></label>
          <label>P2<input data-panel-index="${index}" data-field="second" type="number" min="0" max="260" value="${panel.second || ""}" /></label>
          <label>S<input data-panel-index="${index}" data-field="signal" type="number" min="0" max="120" value="${panel.signal || ""}" /></label>
        `;
      })
      .join("");
  }

  function updateIndicatorPanel(target) {
    if (!target || !target.dataset) return;
    const index = Number(target.dataset.panelIndex);
    const field = target.dataset.field;
    if (!Number.isInteger(index) || !state.indicatorPanels[index] || !field) return;
    const panel = state.indicatorPanels[index];
    if (field === "type") {
      panel.type = target.value;
      const defaults = defaultIndicatorPanels().find((item) => item.type === panel.type) || defaultIndicatorPanels()[0];
      panel.period = defaults.period;
      panel.second = defaults.second;
      panel.signal = defaults.signal;
      return;
    }
    panel[field] = Number(target.value) || 0;
  }

  function syncToolButtons() {
    document.querySelectorAll(".tool-button[data-tool]").forEach((item) => item.classList.toggle("active", item.dataset.tool === state.tool));
  }

  function setBusy(isBusy) {
    [el.prevDay, el.nextDay, el.buyBtn, el.sellBtn, el.saveSession, el.loadSession, el.zoomMore, el.zoomLess]
      .filter(Boolean)
      .forEach((button) => {
      button.disabled = isBusy;
    });
  }

  function renderFatalError(error) {
    const message = escapeHtml(error.message || String(error));
    el.marketStatus.textContent = "服务未连接";
    el.quoteList.innerHTML = `<div class="error-state">无法加载行情：${message}</div>`;
    el.priceReadout.innerHTML = `<div class="readout-cell"><span>错误</span><strong>请通过 python server.py 启动</strong></div>`;
    clearCanvas(el.priceCanvas);
    clearCanvas(el.volumeCanvas);
    el.indicatorCanvases.forEach(clearCanvas);
    if (el.marketTableBody) el.marketTableBody.innerHTML = `<tr><td colspan="14" class="error-state">无法加载行情：${message}</td></tr>`;
  }

  function currentBars() {
    return marketData.get(state.symbol) || [];
  }

  function currentTradingDate() {
    const bars = currentBars();
    if (bars.length) return bars[bars.length - 1].date;
    const quote = getQuote(state.symbol);
    return quote ? quote.date : "";
  }

  function latestClose(symbol) {
    const bars = marketData.get(symbol) || [];
    const bar = bars[bars.length - 1];
    if (bar) return bar.close;
    const quote = getQuote(symbol);
    return quote ? quote.close : NaN;
  }

  function getStock(symbol) {
    return stocks.find((stock) => stock.symbol === symbol);
  }

  function getQuote(symbol) {
    return quoteRows.find((quote) => quote.symbol === symbol);
  }

  function sortedQuotes() {
    const { key, dir } = state.quoteSort;
    const multiplier = dir === "asc" ? 1 : -1;
    return quoteRows.slice().sort((a, b) => {
      if (key === "rank") return multiplier * ((quoteRows.indexOf(a) + 1) - (quoteRows.indexOf(b) + 1));
      const av = a[key];
      const bv = b[key];
      if (typeof av === "number" || typeof bv === "number") {
        return multiplier * ((Number(av) || 0) - (Number(bv) || 0));
      }
      return multiplier * String(av || "").localeCompare(String(bv || ""), "zh-CN");
    });
  }

  function setQuoteSort(key) {
    if (!key) return;
    if (state.quoteSort.key === key) {
      state.quoteSort.dir = state.quoteSort.dir === "asc" ? "desc" : "asc";
    } else {
      state.quoteSort = { key, dir: key === "symbol" || key === "name" || key === "market" ? "asc" : "desc" };
    }
    renderQuotes();
    renderMarketTable();
  }

  function zoomChart(delta) {
    state.displayBars = clamp(state.displayBars + delta, MIN_DISPLAY_BARS, MAX_DISPLAY_BARS);
    if (el.barCountLabel) el.barCountLabel.textContent = `${state.displayBars} 根`;
    renderCharts();
  }

  function flashStatus(message) {
    const previous = el.marketStatus.textContent;
    el.marketStatus.textContent = message;
    window.setTimeout(() => {
      el.marketStatus.textContent = previous;
    }, 1200);
  }

  function normalizeQty(value) {
    return Math.max(0, Math.floor(value / 100) * 100);
  }

  function normalizeSelection(selection) {
    if (!selection) return null;
    return {
      start: Math.min(selection.start, selection.end),
      end: Math.max(selection.start, selection.end)
    };
  }

  function intValue(input, fallback, min, max) {
    return Math.round(numberValue(input, fallback, min, max));
  }

  function numberValue(input, fallback, min, max) {
    const value = Number(input.value);
    return clamp(Number.isFinite(value) ? value : fallback, min, max);
  }

  function formatPrice(value) {
    if (!Number.isFinite(value)) return "--";
    if (Math.abs(value) >= 10) return value.toFixed(2);
    return value.toFixed(3);
  }

  function formatOptional(value) {
    return Number.isFinite(value) ? formatPrice(value) : "--";
  }

  function formatCompact(value) {
    if (!Number.isFinite(value)) return "--";
    return Number(value).toLocaleString("zh-CN", {
      notation: "compact",
      maximumFractionDigits: 2
    });
  }

  function formatMoneyCompact(value) {
    if (!Number.isFinite(value)) return "--";
    const abs = Math.abs(value);
    if (abs >= 100000000) return `${(value / 100000000).toFixed(2)}亿`;
    if (abs >= 10000) return `${(value / 10000).toFixed(2)}万`;
    return currency(value);
  }

  function formatRatio(value) {
    return Number.isFinite(value) ? value.toFixed(2) : "--";
  }

  function currency(value) {
    return Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function roundPrice(value) {
    return Math.round(value * 1000) / 1000;
  }

  function roundMoney(value) {
    return Math.round(value * 100) / 100;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function randomId() {
    return window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function defaultAsOfDate() {
    const today = new Date();
    const day = today.getDay();
    if (day === 6) today.setDate(today.getDate() - 1);
    if (day === 0) today.setDate(today.getDate() - 2);
    return toDateString(today);
  }

  function todayString() {
    return toDateString(new Date());
  }

  function shiftCalendarDays(date, step) {
    const next = parseLocalDate(date);
    next.setDate(next.getDate() + step);
    return toDateString(next);
  }

  function parseLocalDate(date) {
    return new Date(`${date}T00:00:00`);
  }

  function isWeekday(date) {
    const day = parseLocalDate(date).getDay();
    return day !== 0 && day !== 6;
  }

  function toDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
})();
