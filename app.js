(function () {
  "use strict";

  const INITIAL_CASH = 100000;
  const DISPLAY_BARS = 90;

  const stocks = [
    { symbol: "000001", name: "平安银行", seed: 11, start: 10.8 },
    { symbol: "600519", name: "贵州茅台", seed: 29, start: 1520 },
    { symbol: "300750", name: "宁德时代", seed: 41, start: 185 },
    { symbol: "601318", name: "中国平安", seed: 53, start: 43 },
    { symbol: "000858", name: "五粮液", seed: 67, start: 128 },
    { symbol: "002594", name: "比亚迪", seed: 83, start: 226 },
    { symbol: "600036", name: "招商银行", seed: 97, start: 36 },
    { symbol: "688981", name: "中芯国际", seed: 109, start: 52 },
    { symbol: "510300", name: "沪深300ETF", seed: 131, start: 3.86 },
    { symbol: "159915", name: "创业板ETF", seed: 149, start: 2.12 }
  ];

  const tradingDays = createTradingDays("2025-05-06", "2026-04-24");
  const marketData = new Map(stocks.map((stock) => [stock.symbol, generateBars(stock)]));

  const state = {
    symbol: "000001",
    currentIndex: Math.min(148, tradingDays.length - 1),
    panel: initialPanel(),
    showMA: true,
    showBOLL: false,
    trades: [],
    playing: false,
    timer: null,
    search: ""
  };

  const el = {
    marketStrip: document.getElementById("marketStrip"),
    backtestDate: document.getElementById("backtestDate"),
    visibleDateTag: document.getElementById("visibleDateTag"),
    stockSearch: document.getElementById("stockSearch"),
    quoteList: document.getElementById("quoteList"),
    symbolTitle: document.getElementById("symbolTitle"),
    symbolMeta: document.getElementById("symbolMeta"),
    showMA: document.getElementById("showMA"),
    showBOLL: document.getElementById("showBOLL"),
    priceReadout: document.getElementById("priceReadout"),
    priceCanvas: document.getElementById("priceCanvas"),
    indicatorCanvas: document.getElementById("indicatorCanvas"),
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
    positionList: document.getElementById("positionList"),
    tradeLog: document.getElementById("tradeLog")
  };

  boot();

  function boot() {
    el.backtestDate.min = tradingDays[0];
    el.backtestDate.max = tradingDays[tradingDays.length - 1];
    el.backtestDate.value = tradingDays[state.currentIndex];

    syncPanelButtons();
    bindEvents();
    renderAll();
  }

  function bindEvents() {
    el.backtestDate.addEventListener("change", () => {
      const nextIndex = findTradingIndex(el.backtestDate.value);
      if (nextIndex >= 0) {
        state.currentIndex = nextIndex;
        branchTimeline();
        stopPlayback();
        renderAll();
      }
    });

    el.prevDay.addEventListener("click", () => moveDay(-1));
    el.nextDay.addEventListener("click", () => moveDay(1));
    el.playToggle.addEventListener("click", togglePlayback);

    el.stockSearch.addEventListener("input", (event) => {
      state.search = event.target.value.trim().toLowerCase();
      renderQuotes();
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
        window.location.hash = state.panel;
        syncPanelButtons();
        renderCharts();
      });
    });

    el.buyBtn.addEventListener("click", () => placeOrder("BUY"));
    el.sellBtn.addEventListener("click", () => placeOrder("SELL"));
    el.resetAccount.addEventListener("click", () => {
      state.trades = [];
      renderAll();
    });

    window.addEventListener("resize", renderCharts);
  }

  function renderAll() {
    el.backtestDate.value = tradingDays[state.currentIndex];
    el.visibleDateTag.textContent = tradingDays[state.currentIndex];
    renderMarketStrip();
    renderQuotes();
    renderHeader();
    renderReadout();
    renderAccount();
    renderCharts();
  }

  function renderMarketStrip() {
    const tiles = [
      makeIndexTile("上证指数", 3128.42, 0.73, 0),
      makeIndexTile("深证成指", 10186.35, -0.28, 1),
      makeIndexTile("创业板指", 2048.16, 1.12, 2)
    ];
    el.marketStrip.innerHTML = tiles.join("");
  }

  function makeIndexTile(name, base, drift, offset) {
    const wave = Math.sin((state.currentIndex + offset * 11) / 12) * 0.6;
    const pct = drift + wave;
    const value = base * (1 + pct / 100);
    const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
    return `
      <div class="index-tile">
        <b>${name}</b>
        <span class="${cls}">${formatNumber(value)} ${pct > 0 ? "+" : ""}${pct.toFixed(2)}%</span>
      </div>
    `;
  }

  function renderQuotes() {
    const filtered = stocks.filter((stock) => {
      const key = `${stock.symbol} ${stock.name}`.toLowerCase();
      return !state.search || key.includes(state.search);
    });

    el.quoteList.innerHTML = filtered
      .map((stock) => {
        const bars = marketData.get(stock.symbol);
        const today = bars[state.currentIndex];
        const yesterday = bars[Math.max(0, state.currentIndex - 1)];
        const change = today.close - yesterday.close;
        const pct = yesterday.close ? (change / yesterday.close) * 100 : 0;
        const cls = change > 0 ? "up" : change < 0 ? "down" : "flat";
        return `
          <button class="quote-row ${stock.symbol === state.symbol ? "active" : ""}" data-symbol="${stock.symbol}">
            <span>
              <strong>${stock.symbol}</strong>
              <small>${stock.name}</small>
            </span>
            <span class="quote-price">
              <strong class="${cls}">${formatPrice(today.close)}</strong>
              <small class="${cls}">${change >= 0 ? "+" : ""}${formatPrice(change)} / ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</small>
            </span>
          </button>
        `;
      })
      .join("");

    el.quoteList.querySelectorAll(".quote-row").forEach((row) => {
      row.addEventListener("click", () => {
        state.symbol = row.dataset.symbol;
        renderAll();
      });
    });
  }

  function renderHeader() {
    const stock = getStock(state.symbol);
    const bars = currentBars();
    const bar = bars[state.currentIndex];
    const prev = bars[Math.max(0, state.currentIndex - 1)];
    const pct = prev.close ? ((bar.close - prev.close) / prev.close) * 100 : 0;

    el.symbolTitle.textContent = `${stock.symbol} ${stock.name}`;
    el.symbolMeta.textContent = `${bar.date} · ${bar.close >= prev.close ? "上涨" : "下跌"} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  }

  function renderReadout() {
    const bars = currentBars();
    const bar = bars[state.currentIndex];
    const prev = bars[Math.max(0, state.currentIndex - 1)];
    const change = bar.close - prev.close;
    const pct = prev.close ? (change / prev.close) * 100 : 0;
    const indicators = calculateIndicators(bars);
    const ma5 = indicators.ma5[state.currentIndex];
    const ma20 = indicators.ma20[state.currentIndex];
    const rsi = indicators.rsi6[state.currentIndex];

    const cells = [
      ["开盘", formatPrice(bar.open), ""],
      ["最高", formatPrice(bar.high), "up"],
      ["最低", formatPrice(bar.low), "down"],
      ["收盘", formatPrice(bar.close), change > 0 ? "up" : change < 0 ? "down" : "flat"],
      ["涨跌幅", `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`, change > 0 ? "up" : change < 0 ? "down" : "flat"],
      ["MA5 / MA20", `${formatOptional(ma5)} / ${formatOptional(ma20)}`, ""],
      ["RSI6", formatOptional(rsi), rsi > 70 ? "up" : rsi < 30 ? "down" : ""]
    ];

    el.priceReadout.innerHTML = cells
      .map(([label, value, cls]) => `
        <div class="readout-cell">
          <span>${label}</span>
          <strong class="${cls}">${value}</strong>
        </div>
      `)
      .join("");

    el.orderPrice.textContent = formatPrice(bar.close);
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
        const price = marketData.get(symbol)[state.currentIndex].close;
        const pnl = (price - position.avgCost) * position.qty;
        return `
          <div class="position-row">
            <strong>${symbol} ${stock.name}</strong>
            <span>数量 ${position.qty} · 成本 ${formatPrice(position.avgCost)} · 现价 ${formatPrice(price)}</span>
            <span class="${pnl >= 0 ? "up" : "down"}">盈亏 ${pnl >= 0 ? "+" : ""}${currency(pnl)}</span>
          </div>
        `;
      });

    el.positionList.innerHTML = rows.length ? rows.join("") : `<div class="empty-state">暂无持仓</div>`;
  }

  function renderTrades() {
    const visibleTrades = state.trades
      .filter((trade) => trade.index <= state.currentIndex)
      .slice()
      .reverse();

    el.tradeLog.innerHTML = visibleTrades.length
      ? visibleTrades
          .map((trade) => `
            <div class="trade-row">
              <strong class="${trade.side === "BUY" ? "up" : "down"}">${trade.side === "BUY" ? "买入" : "卖出"}</strong>
              <span>${trade.symbol}<br />${trade.date}</span>
              <span>${trade.qty} 股<br />${formatPrice(trade.price)}</span>
            </div>
          `)
          .join("")
      : `<div class="empty-state">暂无成交</div>`;
  }

  function renderCharts() {
    const bars = currentBars();
    const indicators = calculateIndicators(bars);
    const start = Math.max(0, state.currentIndex - DISPLAY_BARS + 1);
    const visible = bars.slice(start, state.currentIndex + 1);
    const range = { start, end: state.currentIndex, bars: visible };

    drawPriceChart(el.priceCanvas, bars, indicators, range);
    drawIndicatorChart(el.indicatorCanvas, bars, indicators, range);
  }

  function drawPriceChart(canvas, bars, indicators, range) {
    const ctx = prepareCanvas(canvas);
    const { width, height } = canvas.getBoundingClientRect();
    const pad = { left: 58, right: 72, top: 20, bottom: 28 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const visible = range.bars;
    const values = [];

    visible.forEach((bar) => values.push(bar.high, bar.low));
    if (state.showMA) {
      ["ma5", "ma10", "ma20"].forEach((key) => {
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

    const min = Math.min(...values) * 0.995;
    const max = Math.max(...values) * 1.005;
    const y = (price) => pad.top + ((max - price) / (max - min)) * plotH;
    const barW = plotW / Math.max(visible.length, 1);
    const candleW = Math.max(3, Math.min(13, barW * 0.56));

    fill(ctx, "#080b0f", width, height);
    drawGrid(ctx, pad, width, height, 5, 6);

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
      drawSeries(ctx, indicators.ma5, range, pad, plotW, y, "#e2b34b", barW);
      drawSeries(ctx, indicators.ma10, range, pad, plotW, y, "#5ea1ff", barW);
      drawSeries(ctx, indicators.ma20, range, pad, plotW, y, "#b884ff", barW);
      drawLegend(ctx, ["MA5", "MA10", "MA20"], ["#e2b34b", "#5ea1ff", "#b884ff"], pad.left, 15);
    }

    if (state.showBOLL) {
      drawSeries(ctx, indicators.bollUpper, range, pad, plotW, y, "#d8dfe8", barW);
      drawSeries(ctx, indicators.bollMid, range, pad, plotW, y, "#19b4a6", barW);
      drawSeries(ctx, indicators.bollLower, range, pad, plotW, y, "#d8dfe8", barW);
      drawLegend(ctx, ["BOLL"], ["#19b4a6"], pad.left + 180, 15);
    }

    const dates = [visible[0], visible[Math.floor(visible.length / 2)], visible[visible.length - 1]].filter(Boolean);
    dates.forEach((bar) => {
      const index = bars.indexOf(bar) - range.start;
      const x = pad.left + index * barW + barW / 2;
      drawAxisText(ctx, bar.date.slice(5), x, height - 9, "#7f8a99", "center");
    });

    const current = bars[state.currentIndex];
    drawAxisText(ctx, `${current.date} 收盘 ${formatPrice(current.close)}`, width - pad.right - 6, 16, "#d7dde5", "right");
  }

  function drawIndicatorChart(canvas, bars, indicators, range) {
    const ctx = prepareCanvas(canvas);
    const { width, height } = canvas.getBoundingClientRect();
    const pad = { left: 58, right: 72, top: 18, bottom: 24 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const barW = plotW / Math.max(range.bars.length, 1);
    const panel = state.panel;

    fill(ctx, "#080b0f", width, height);
    drawGrid(ctx, pad, width, height, 3, 6);

    if (panel === "macd") {
      const macd = indicators.macd.slice(range.start, range.end + 1);
      const signal = indicators.signal.slice(range.start, range.end + 1);
      const hist = indicators.hist.slice(range.start, range.end + 1);
      const values = macd.concat(signal, hist).filter(Number.isFinite);
      const limit = Math.max(0.01, Math.max(...values.map(Math.abs)));
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
      drawLegend(ctx, ["DIF", "DEA", "MACD"], ["#e2b34b", "#5ea1ff", "#e05252"], pad.left, 13);
    }

    if (panel === "rsi") {
      const values = indicators.rsi6.slice(range.start, range.end + 1).filter(Number.isFinite);
      const y = (value) => pad.top + ((100 - value) / 100) * plotH;
      line(ctx, pad.left, y(70), width - pad.right, y(70), "rgba(224,82,82,0.35)");
      line(ctx, pad.left, y(30), width - pad.right, y(30), "rgba(32,178,107,0.35)");
      drawSeries(ctx, indicators.rsi6, range, pad, plotW, y, "#e2b34b", barW);
      drawSeries(ctx, indicators.rsi12, range, pad, plotW, y, "#5ea1ff", barW);
      drawAxisText(ctx, "70", width - pad.right + 10, y(70) + 4, "#7f8a99", "left");
      drawAxisText(ctx, "30", width - pad.right + 10, y(30) + 4, "#7f8a99", "left");
      drawLegend(ctx, [`RSI6 ${formatOptional(values[values.length - 1])}`, "RSI12"], ["#e2b34b", "#5ea1ff"], pad.left, 13);
    }

    if (panel === "kdj") {
      const y = (value) => pad.top + ((100 - value) / 100) * plotH;
      line(ctx, pad.left, y(80), width - pad.right, y(80), "rgba(224,82,82,0.35)");
      line(ctx, pad.left, y(20), width - pad.right, y(20), "rgba(32,178,107,0.35)");
      drawSeries(ctx, indicators.k, range, pad, plotW, y, "#e2b34b", barW);
      drawSeries(ctx, indicators.d, range, pad, plotW, y, "#5ea1ff", barW);
      drawSeries(ctx, indicators.j, range, pad, plotW, y, "#b884ff", barW);
      drawLegend(ctx, ["K", "D", "J"], ["#e2b34b", "#5ea1ff", "#b884ff"], pad.left, 13);
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
      drawLegend(ctx, ["PDI", "MDI", "ADX", "ADXR"], ["#e05252", "#20b26b", "#e2b34b", "#5ea1ff"], pad.left, 13);
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

  function drawGrid(ctx, pad, width, height, rows, cols) {
    ctx.strokeStyle = "#1b222b";
    ctx.lineWidth = 1;
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
      cursor += label.length * 8 + 34;
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

  function placeOrder(side) {
    const qty = normalizeQty(Number(el.orderQty.value));
    const bar = currentBars()[state.currentIndex];
    const account = rebuildAccount();
    const position = account.positions[state.symbol] || { qty: 0, avgCost: 0 };
    const amount = qty * bar.close;
    const fee = calculateFee(side, amount);

    if (qty <= 0) return;
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
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      symbol: state.symbol,
      side,
      qty,
      price: bar.close,
      fee,
      amount,
      date: bar.date,
      index: state.currentIndex
    });

    renderAll();
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
    const visibleTrades = state.trades
      .filter((trade) => trade.index <= state.currentIndex)
      .slice()
      .sort((a, b) => a.index - b.index);

    visibleTrades.forEach((trade) => {
      const position = positions[trade.symbol] || { qty: 0, avgCost: 0, cost: 0 };
      if (trade.side === "BUY") {
        cash -= trade.amount + trade.fee;
        position.cost += trade.amount + trade.fee;
        position.qty += trade.qty;
        position.avgCost = position.cost / position.qty;
      } else {
        const ratio = trade.qty / position.qty;
        cash += trade.amount - trade.fee;
        position.cost *= Math.max(0, 1 - ratio);
        position.qty -= trade.qty;
        position.avgCost = position.qty > 0 ? position.cost / position.qty : 0;
      }
      positions[trade.symbol] = position;
    });

    let marketValue = 0;
    Object.entries(positions).forEach(([symbol, position]) => {
      if (position.qty <= 0) return;
      const price = marketData.get(symbol)[state.currentIndex].close;
      marketValue += position.qty * price;
    });

    const equity = cash + marketValue;
    const pnl = equity - INITIAL_CASH;
    const pnlPct = (pnl / INITIAL_CASH) * 100;
    return { cash, positions, marketValue, equity, pnl, pnlPct };
  }

  function moveDay(step) {
    state.currentIndex = clamp(state.currentIndex + step, 0, tradingDays.length - 1);
    el.backtestDate.value = tradingDays[state.currentIndex];
    stopPlaybackIfDone();
    renderAll();
  }

  function togglePlayback() {
    if (state.playing) {
      stopPlayback();
      return;
    }
    state.playing = true;
    el.playToggle.textContent = "Ⅱ";
    state.timer = window.setInterval(() => {
      if (state.currentIndex >= tradingDays.length - 1) {
        stopPlayback();
        return;
      }
      moveDay(1);
    }, 900);
  }

  function stopPlayback() {
    if (state.timer) window.clearInterval(state.timer);
    state.timer = null;
    state.playing = false;
    el.playToggle.textContent = "▶";
  }

  function stopPlaybackIfDone() {
    if (state.currentIndex >= tradingDays.length - 1) stopPlayback();
  }

  function branchTimeline() {
    state.trades = state.trades.filter((trade) => trade.index <= state.currentIndex);
  }

  function calculateIndicators(bars) {
    const closes = bars.map((bar) => bar.close);
    const highs = bars.map((bar) => bar.high);
    const lows = bars.map((bar) => bar.low);
    const opens = bars.map((bar) => bar.open);
    const volumes = bars.map((bar) => bar.volume);
    const ma5 = sma(closes, 5);
    const ma10 = sma(closes, 10);
    const ma20 = sma(closes, 20);
    const bollMid = ma20;
    const bollStd = rollingStd(closes, 20);
    const bollUpper = bollMid.map((value, index) => (Number.isFinite(value) ? value + 2 * bollStd[index] : NaN));
    const bollLower = bollMid.map((value, index) => (Number.isFinite(value) ? value - 2 * bollStd[index] : NaN));
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const macd = ema12.map((value, index) => value - ema26[index]);
    const signal = ema(macd, 9);
    const hist = macd.map((value, index) => (value - signal[index]) * 2);
    const rsi6 = rsi(closes, 6);
    const rsi12 = rsi(closes, 12);
    const { k, d, j } = kdj(highs, lows, closes, 9);
    const { pdi, mdi, adx, adxr } = dmi(highs, lows, closes, 14, 6);
    const { superFund, largeFund, middleFund, retailFund } = capitalGame(opens, highs, lows, closes, volumes, 13);

    return {
      ma5,
      ma10,
      ma20,
      bollMid,
      bollUpper,
      bollLower,
      macd,
      signal,
      hist,
      rsi6,
      rsi12,
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
      if (losses === 0) output[i] = 100;
      else {
        const rs = gains / losses;
        output[i] = 100 - 100 / (1 + rs);
      }
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
    const panels = ["macd", "rsi", "kdj", "dmi", "capital"];
    const hash = window.location.hash.replace("#", "").toLowerCase();
    return panels.includes(hash) ? hash : "macd";
  }

  function syncPanelButtons() {
    document.querySelectorAll(".segment").forEach((item) => item.classList.toggle("active", item.dataset.panel === state.panel));
  }

  function createTradingDays(start, end) {
    const days = [];
    const cursor = new Date(`${start}T00:00:00`);
    const last = new Date(`${end}T00:00:00`);
    while (cursor <= last) {
      const day = cursor.getDay();
      if (day !== 0 && day !== 6) days.push(toDateString(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return days;
  }

  function generateBars(stock) {
    const rand = seededRandom(stock.seed);
    const bars = [];
    let close = stock.start;
    let trend = 0;

    tradingDays.forEach((date, index) => {
      trend = trend * 0.96 + (rand() - 0.5) * 0.018;
      const seasonal = Math.sin((index + stock.seed) / 19) * 0.007;
      const shock = (rand() - 0.5) * 0.035;
      const change = clamp(trend + seasonal + shock, -0.085, 0.085);
      const open = close * (1 + (rand() - 0.5) * 0.018);
      close = Math.max(stock.start * 0.35, close * (1 + change));
      const high = Math.max(open, close) * (1 + rand() * 0.018);
      const low = Math.min(open, close) * (1 - rand() * 0.018);
      const volume = Math.round((500000 + rand() * 2500000) * (1 + Math.abs(change) * 12));

      bars.push({
        date,
        open: roundPrice(open),
        high: roundPrice(high),
        low: roundPrice(low),
        close: roundPrice(close),
        volume
      });
    });

    return bars;
  }

  function seededRandom(seed) {
    let value = seed % 2147483647;
    return function next() {
      value = (value * 16807) % 2147483647;
      return (value - 1) / 2147483646;
    };
  }

  function currentBars() {
    return marketData.get(state.symbol);
  }

  function getStock(symbol) {
    return stocks.find((stock) => stock.symbol === symbol);
  }

  function findTradingIndex(date) {
    const exact = tradingDays.indexOf(date);
    if (exact >= 0) return exact;
    const requested = new Date(`${date}T00:00:00`).getTime();
    for (let i = tradingDays.length - 1; i >= 0; i -= 1) {
      if (new Date(`${tradingDays[i]}T00:00:00`).getTime() <= requested) return i;
    }
    return 0;
  }

  function normalizeQty(value) {
    return Math.max(0, Math.floor(value / 100) * 100);
  }

  function calculateFee(side, amount) {
    const commission = Math.max(5, amount * 0.00025);
    const stamp = side === "SELL" ? amount * 0.0005 : 0;
    return commission + stamp;
  }

  function formatPrice(value) {
    if (!Number.isFinite(value)) return "--";
    if (Math.abs(value) >= 1000) return value.toFixed(2);
    if (Math.abs(value) >= 10) return value.toFixed(2);
    return value.toFixed(3);
  }

  function formatOptional(value) {
    return Number.isFinite(value) ? formatPrice(value) : "--";
  }

  function formatNumber(value) {
    return Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function currency(value) {
    return Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function roundPrice(value) {
    return Math.round(value * 1000) / 1000;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function toDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
})();
