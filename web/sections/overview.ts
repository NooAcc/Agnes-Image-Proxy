/** Overview section: daily totals, 14-day trend chart and per-model usage. */
export const OVERVIEW_HTML = `
<section class="panel is-active" data-section="overview" data-title="总览">
  <div class="section-head">
    <div class="section-lead">
      <h2>当日概览</h2>
      <p>按 UTC 日期统计成功请求、失败请求与图片产量；趋势图覆盖所选日期及之前 13 天。</p>
    </div>
    <div class="toolbar">
      <label class="label" for="overview-day">日期</label>
      <input class="input compact" id="overview-day" data-role="overview-day" type="date">
      <button class="btn small" data-action="overview-today" type="button">今天</button>
    </div>
  </div>
  <div class="stat-grid">
    <div class="stat">
      <div class="stat-label">请求</div>
      <div class="stat-value" data-role="stat-attempts">0</div>
      <div class="stat-meta" data-role="stat-attempts-meta">成功 0 · 失败 0</div>
    </div>
    <div class="stat">
      <div class="stat-label">图片</div>
      <div class="stat-value" data-role="stat-images">0</div>
      <div class="stat-meta" data-role="stat-images-meta">成功返回的输出图</div>
    </div>
    <div class="stat" data-role="stat-error-card">
      <div class="stat-label">错误率</div>
      <div class="stat-value" data-role="stat-error-rate">0<span class="unit">%</span></div>
      <div class="stat-meta" data-role="stat-error-meta">0 次失败请求</div>
    </div>
    <div class="stat">
      <div class="stat-label">健康 Key</div>
      <div class="stat-value" data-role="stat-keys">0<span class="unit">/ 0</span></div>
      <div class="stat-meta" data-role="stat-keys-meta">尚未添加账号</div>
    </div>
  </div>
  <div class="card">
    <div class="card-head">
      <div>
        <div class="card-title">近 14 天用量</div>
        <p>绿色为成功请求，红色为失败请求；悬停或聚焦柱状图查看每日明细。</p>
      </div>
      <div class="trend-readout" data-role="trend-readout" aria-live="polite">聚焦柱状图查看每日明细</div>
    </div>
    <div class="chart" data-role="trend-chart" role="group" aria-label="近 14 天每日请求与失败"></div>
    <div class="chart-legend"><span><i class="ok"></i>成功请求</span><span><i class="err"></i>失败请求</span></div>
  </div>
  <div class="card">
    <div class="card-head">
      <div>
        <div class="card-title">模型用量</div>
        <p data-role="models-note">当日按模型拆分的请求与图片。</p>
      </div>
    </div>
    <div class="model-list" data-role="model-list"></div>
  </div>
</section>`;

export const OVERVIEW_SCRIPT = String.raw`
(function () {
  "use strict";
  var A = window.Agnes;
  var section = document.querySelector('[data-section="overview"]');
  if (!section) return;

  var state = { day: "", trend: [], requestId: 0, loaded: false };
  var dayInput = section.querySelector('[data-role="overview-day"]');
  var today = new Date().toISOString().slice(0, 10);
  state.day = today;
  if (dayInput) dayInput.value = today;

  function node(role) { return section.querySelector('[data-role="' + role + '"]'); }
  function active() { return section.classList.contains("is-active"); }

  function setStat(role, value) {
    var target = node(role);
    if (target) target.textContent = value;
  }

  function setErrorRate(errors, attempts) {
    var rate = attempts === 0 ? 0 : (errors / attempts) * 100;
    var display = rate === 0 ? "0" : (rate < 10 ? rate.toFixed(1) : Math.round(rate).toString());
    var value = node("stat-error-rate");
    if (value) value.replaceChildren(document.createTextNode(display), A.el("span", "unit", "%"));
    var card = node("stat-error-card");
    if (card) {
      card.classList.toggle("tone-warn", rate >= 5 && rate < 20);
      card.classList.toggle("tone-bad", rate >= 20);
    }
  }

  function renderTotals(data) {
    var attempts = data.totals.requests + data.totals.errors;
    setStat("stat-attempts", A.fmtNumber(attempts));
    setStat("stat-attempts-meta", "成功 " + A.fmtNumber(data.totals.requests) + " · 失败 " +
      A.fmtNumber(data.totals.errors));
    setStat("stat-images", A.fmtNumber(data.totals.images));
    setErrorRate(data.totals.errors, attempts);
    setStat("stat-error-meta", A.fmtNumber(data.totals.errors) + " 次失败请求");
    var keys = node("stat-keys");
    if (keys) {
      keys.replaceChildren(
        document.createTextNode(A.fmtNumber(data.accounts.healthy)),
        A.el("span", "unit", "/ " + A.fmtNumber(data.accounts.total)),
      );
    }
    var keysMeta = data.accounts.total === 0
      ? "尚未添加账号"
      : "启用 " + A.fmtNumber(data.accounts.enabled) + " 个 · 降级 " +
        A.fmtNumber(data.accounts.degraded) + " 个";
    setStat("stat-keys-meta", keysMeta);
    A.setHealth(data.accounts.healthy, data.accounts.total);
  }

  function renderTrend() {
    var chart = node("trend-chart");
    if (!chart) return;
    chart.replaceChildren();
    var max = 1;
    for (var i = 0; i < state.trend.length; i++) {
      var total = state.trend[i].requests + state.trend[i].errors;
      if (total > max) max = total;
    }
    for (var j = 0; j < state.trend.length; j++) {
      var day = state.trend[j];
      var sum = day.requests + day.errors;
      var col = A.el("div", "bar-col");
      col.tabIndex = 0;
      col.setAttribute("role", "img");
      col.setAttribute("aria-label", day.day + "：请求 " + sum + " 次，成功 " + day.requests +
        "，失败 " + day.errors + "，图片 " + day.images + " 张");
      if (day.day === state.day) col.classList.add("is-selected");

      var track = A.el("div", "bar-track");
      var stack = A.el("div", "bar-stack");
      if (sum === 0) {
        stack.style.height = "3px";
        stack.append(A.el("span", "bar-zero"));
      } else {
        stack.style.height = Math.max(4, Math.round((sum / max) * 100)) + "%";
        if (day.errors > 0) {
          var errShare = Math.round((day.errors / sum) * 100);
          var err = A.el("span", "bar-seg err");
          err.style.height = errShare + "%";
          stack.append(err);
          var ok = A.el("span", "bar-seg ok");
          ok.style.height = (100 - errShare) + "%";
          stack.append(ok);
        } else {
          var okOnly = A.el("span", "bar-seg ok");
          okOnly.style.height = "100%";
          stack.append(okOnly);
        }
      }
      track.append(stack);
      col.append(track);
      col.append(A.el("div", "bar-day", A.dayShort(day.day)));

      (function (entry, column) {
        function readout() {
          var readoutNode = node("trend-readout");
          if (!readoutNode) return;
          var sum = entry.requests + entry.errors;
          readoutNode.textContent = entry.day + " · 请求 " + sum + " · 成功 " + entry.requests +
            " · 失败 " + entry.errors + " · 图片 " + entry.images + " 张";
        }
        column.addEventListener("mouseenter", readout);
        column.addEventListener("focus", readout);
      })(day, col);

      chart.append(col);
    }
  }

  function metric(label, value) {
    var item = A.el("span");
    item.append(document.createTextNode(label + " "));
    item.append(A.el("b", null, A.fmtNumber(value)));
    return item;
  }

  function renderModels(data) {
    var list = node("model-list");
    if (!list) return;
    list.replaceChildren();
    var max = 1;
    var attempts = 0;
    for (var i = 0; i < data.models.length; i++) {
      var total = data.models[i].requests + data.models[i].errors;
      attempts += total;
      if (total > max) max = total;
    }
    var note = node("models-note");
    if (note) {
      note.textContent = attempts === 0
        ? "所选日期还没有请求。"
        : "请求量最高的模型显示为满格。";
    }
    for (var j = 0; j < data.models.length; j++) {
      var model = data.models[j];
      var used = model.requests + model.errors;
      var row = A.el("div", "model-row");
      var left = A.el("div");
      var name = A.el("div", "model-name");
      name.append(A.el("span", "mono", model.id));
      name.append(A.el("span", "tag", model.sizeMode === "exact" ? "exact" : "tier"));
      left.append(name);
      var stats = A.el("div", "model-stats");
      stats.append(metric("成功", model.requests));
      stats.append(metric("失败", model.errors));
      stats.append(metric("图片", model.images));
      left.append(stats);

      var last = A.el("div", "muted");
      last.style.fontSize = "11.5px";
      last.style.whiteSpace = "nowrap";
      last.textContent = model.lastUsedAt ? "最后 " + A.fmtRelative(model.lastUsedAt) : "未使用";

      var meter = A.el("div", "model-meter");
      var fill = A.el("span");
      fill.style.width = used === 0 ? "0%" : Math.max(3, Math.round((used / max) * 100)) + "%";
      if (used === 0) fill.className = "is-empty";
      meter.append(fill);

      row.append(left);
      row.append(last);
      row.append(meter);
      list.append(row);
    }
  }

  function render(data) {
    state.trend = data.trend || [];
    renderTotals(data);
    renderTrend();
    renderModels(data);
    state.loaded = true;
  }

  async function load() {
    var id = ++state.requestId;
    var query = state.day ? "?day=" + encodeURIComponent(state.day) : "";
    try {
      var data = await A.api("/admin/api/overview" + query);
      if (id !== state.requestId) return;
      render(data);
    } catch (error) {
      if (id !== state.requestId) return;
      A.toast(error.message, "error");
    }
  }

  if (dayInput) {
    dayInput.addEventListener("change", function () {
      if (!dayInput.value) return;
      state.day = dayInput.value;
      load();
    });
  }

  section.addEventListener("click", function (event) {
    var button = event.target.closest('[data-action="overview-today"]');
    if (!button) return;
    state.day = new Date().toISOString().slice(0, 10);
    if (dayInput) dayInput.value = state.day;
    load();
  });

  document.addEventListener("agnes:section", function (event) {
    if (!event.detail || event.detail.name !== "overview" || !active()) return;
    load();
  });
})();
`;
