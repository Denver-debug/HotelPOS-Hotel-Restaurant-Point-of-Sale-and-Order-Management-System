// Dashboard/report charts (Chart.js). Single-measure charts use one validated hue;
// every charted value is also listed in an adjacent table, so tooltips only enhance.
(function () {
  "use strict";

  const SERIES = "#2a78d6"; // validated vs the white card surface (contrast >= 3:1)
  const TEXT = "#475569";
  const GRID = "#eef2f7";
  const money = (v) => "₱" + Number(v).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function base(extra = {}) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false, // synchronous draws, so re-measuring works even in background tabs
      plugins: {
        legend: { display: false }, // single series: the card title names it
        tooltip: { callbacks: { label: (ctx) => ` ${money(ctx.parsed.y ?? ctx.parsed.x)}` } },
      },
      ...extra,
    };
  }

  // Only value axes get a formatter; category axes keep Chart.js's label callback.
  const axis = (isMoney) => ({
    grid: { color: GRID, drawTicks: false },
    border: { display: false },
    ticks: isMoney ? { color: TEXT, padding: 6, callback: (v) => money(v).replace(".00", "") } : { color: TEXT, padding: 6 },
  });

  function line(id, rows) {
    const el = document.getElementById(id);
    if (!el || !rows?.length) return;
    charts.push(new Chart(el, {
      type: "line",
      data: {
        labels: rows.map((r) => r.label),
        datasets: [{ data: rows.map((r) => r.value), borderColor: SERIES, backgroundColor: "rgba(42,120,214,0.08)", fill: true, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: SERIES, pointBorderColor: "#fff", pointBorderWidth: 2, tension: 0 }],
      },
      options: base({
        interaction: { mode: "index", intersect: false },
        scales: { x: { ...axis(false), grid: { display: false } }, y: { ...axis(true), beginAtZero: true } },
      }),
    }));
  }

  function hbar(id, rows) {
    const el = document.getElementById(id);
    if (!el || !rows?.length) return;
    charts.push(new Chart(el, {
      type: "bar",
      data: {
        labels: rows.map((r) => r.label),
        datasets: [{ data: rows.map((r) => r.value), backgroundColor: SERIES, borderRadius: 4, borderSkipped: "start", maxBarThickness: 22, borderColor: "#fff", borderWidth: { top: 2, bottom: 2 } }],
      },
      options: base({
        indexAxis: "y",
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${money(ctx.parsed.x)}` } } },
        scales: { x: { ...axis(true), beginAtZero: true }, y: { ...axis(false), grid: { display: false } } },
      }),
    }));
  }

  // The Tailwind CDN generates the grid styles asynchronously, so a canvas may first
  // measure the unstyled full-width page. Re-measure once the layout has settled
  // (setTimeout, because requestAnimationFrame is paused in background tabs).
  const charts = [];
  const settle = () => [150, 600, 1500].forEach((ms) => setTimeout(() => charts.forEach((c) => c.resize()), ms));

  function render() {
    const data = JSON.parse(document.getElementById("dashboard-charts")?.textContent || "null");
    if (!data || typeof Chart === "undefined") return;
    Chart.defaults.font.family = "Inter, ui-sans-serif, system-ui, sans-serif";
    line("chart-trend", data.trend);
    hbar("chart-outlets", data.outlets);
    hbar("chart-methods", data.methods);
    (data.extra || []).forEach((c) => (c.kind === "line" ? line(c.id, c.rows) : hbar(c.id, c.rows)));
    settle();
  }

  if (document.readyState === "complete") setTimeout(render, 0);
  else window.addEventListener("load", () => setTimeout(render, 0));
})();
