(function () {
  "use strict";

  var keys = ["codex", "wb", "muse", "agy", "tavily", "mac", "anchors"];
  // 实时限流不走 keys：它不是一张卡片、不进 90 秒缓存，只在有 429 时驱动告警行。
  // 网关 state 中的模型冷却来自本地持久化状态，不读取用量归档。
  var liveThrottleCache = null;
  var refreshButton = document.getElementById("refresh-all");
  var loadingAll = false;
  var lastMeta = {};
  var openRefreshTimer = null;
  var wbPointsRefreshing = false;   // WB「刷新积分」进行中（跨重画保持按钮状态）

  // 只在打开页面时自动取数一次：首屏先用缓存渲染，随后按需补拉后台刷新结果。
  // 之后不再有周期轮询——数据更新一律靠手动刷新（顶部「全部刷新」/ 卡片按钮）。
  var OPEN_REFRESH_DELAY_MS = 5000;
  var OPEN_REFRESH_MAX_ROUNDS = 4;
  // 绝对上限：从打开页面起算，超过就不再补拉（慢响应不得把收尾拖成事实上的轮询）。
  var OPEN_REFRESH_DEADLINE_MS = 30000;
  // 纯函数集中在 pure.js（node 可直接测试）；此处仅装配。
  var DP = window.DashPure;

  // 币种显示：USD（默认）/ CNY（按每日汇率折算展示，数据本身仍为美元口径）
  var currencyMode = "USD";
  var usdCnyInfo = null;
  try {
    if (localStorage.getItem("dash-currency") === "CNY") currencyMode = "CNY";
  } catch (e) {}

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function number(value, digits) {
    var parsed = Number(value);
    if (!isFinite(parsed)) return "—";
    return parsed.toLocaleString("zh-CN", {
      maximumFractionDigits: digits == null ? 2 : digits,
    });
  }

  function formatTokens(count) {
    var val = Number(count);
    if (!isFinite(val) || val <= 0) return "0";
    if (val >= 1000000000) return (val / 1000000000).toFixed(2) + "B";
    if (val >= 1000000) return (val / 1000000).toFixed(2) + "M";
    if (val >= 1000) return (val / 1000).toFixed(1) + "K";
    return String(Math.round(val));
  }

  function tokenText(value) {
    return value == null || !isFinite(Number(value)) ? "—" : formatTokens(Number(value));
  }

  function percent(value) {
    if (value == null || value === "") return "—";
    var parsed = Number(value);
    return isFinite(parsed) ? number(parsed, 1) + "%" : "—";
  }

  function wbCreditsText(summary, digits) {
    if (!summary) return "—";
    return wbMetricText(summary, "credits", function (value) {
      return number(value, digits == null ? 1 : digits);
    });
  }

  function wbRealmCreditsText(summary, realm, digits) {
    if (!summary) return null;
    var isCn = realm === "cn";
    var value = isCn ? summary.cn_credits : summary.intl_credits;
    var complete = isCn ? summary.cn_credits_complete : summary.intl_credits_complete;
    var knownTotal = finiteAmount(isCn ? summary.cn_credits_known_total : summary.intl_credits_known_total);
    var knownCount = finiteAmount(isCn ? summary.cn_credits_known_count : summary.intl_credits_known_count);
    var d = digits == null ? 1 : digits;
    if (value != null && complete !== false) return number(Number(value), d);
    if (knownTotal != null && knownCount != null && knownCount > 0) return "≥" + number(knownTotal, d);
    return null;
  }

  function wbSplitCreditsParts(summary, digits) {
    var parts = [];
    if (!summary) return parts;
    var cn = wbRealmCreditsText(summary, "cn", digits);
    var intl = wbRealmCreditsText(summary, "intl", digits);
    if (cn != null) parts.push('<span class="credit-cn">🇨🇳 ' + cn + ' 积分</span>');
    if (intl != null) parts.push('<span class="credit-intl">🌐 ' + intl + ' 积分</span>');
    return parts;
  }

  function wbKnownRatePct(summary) {
    if (!summary) return null;
    if (summary.cache_pct != null) return Number(summary.cache_pct);
    var cached = finiteAmount(summary.cached_tokens_known_total);
    var prompt = finiteAmount(summary.prompt_tokens_known_total);
    var count = finiteAmount(summary.cached_tokens_known_count);
    if (cached == null || prompt == null || !(prompt > 0) || !(count > 0)) return null;
    return (cached / prompt) * 100;
  }

  function wbMetricInfo(summary, metric) {
    var state = DP.wbMetricState(summary, metric);
    if (!state) return "";
    if (state.knownCount == null) return "样本数未知";
    var missing = state.missingCount == null ? Math.max(0, state.samples - state.knownCount) : state.missingCount;
    return "样本 " + state.knownCount + "/" + state.samples + "（缺 " + missing + "）";
  }

  function wbMetricValue(summary, metric, formatValue) {
    var state = DP.wbMetricState(summary, metric);
    if (!state) return "—";
    if (state.samples === 0) return formatValue(0);
    if (state.knownCount === 0) return "—";
    var known = state.knownTotal == null ? null : Number(state.knownTotal);
    if (known == null || !isFinite(known)) return "—";
    if (state.complete && state.value != null && isFinite(Number(state.value))) {
      return formatValue(Number(state.value));
    }
    if (known === 0 && state.knownCount > 0) return formatValue(0);
    return "≥" + formatValue(known);
  }

  function wbMetricText(summary, metric, formatValue) {
    var value = wbMetricValue(summary, metric, formatValue);
    var info = wbMetricInfo(summary, metric);
    return info ? '<span title="' + escapeHtml(info) + '">' + value + '</span>' : value;
  }

  function wbModelTokenText(summary) {
    var value = wbMetricValue(summary, "tokens", tokenText);
    return value === "—" ? "" : wbMetricText(summary, "tokens", tokenText);
  }

  function wbUnknownRealmNote(rows) {
    var summary = DP.wbUnknownRealmSummary(rows);
    if (!summary) return "";
    var title = summary.groups.map(function (group) {
      return group.model + " ×" + number(group.calls, 0);
    }).join("；");
    return '<div class="muted" style="font-size:0.72rem;margin-top:4px;" title="' + escapeHtml(title) + '">另 ' +
      summary.totalGroups + ' 组请求出口无法判定（未计价失败请求 · 共 ' + number(summary.totalCalls, 0) + ' 次），未计入排行</div>';
  }

  function wbAccountReadyState(account) {
    if (!account || account.enabled === false || account.disabled || account.paused || wbAccountLimited(account)) return false;
    var credits = account.credits || {};
    var remain = finiteAmount(credits.remain != null ? credits.remain : account.remain);
    return remain == null ? null : remain > 0;
  }

  function wbCheckinSummary(accounts) {
    function realmSummary(realm, flag, label) {
      var group = accounts.filter(function (account) { return account.realm === realm; });
      if (!group.length) return flag + " " + label + "无账号";
      var known = group.filter(function (account) { return typeof account.checkin_done === "boolean"; });
      if (!known.length) return flag + " " + label + "无签到记录";
      var done = known.filter(function (account) { return account.checkin_done; }).length;
      var pending = known.length - done;
      var missing = group.length - known.length;
      var parts = [];
      if (done) parts.push(done + " 已完成");
      if (pending) parts.push(pending + " 未完成");
      if (missing) parts.push(missing + " 未知");
      return flag + " " + label + parts.join(" · ");
    }
    return realmSummary("cn", "🇨🇳", "") + " · " + realmSummary("intl", "🌐", "");
  }

  function wbModelCreditsText(row, digits) {
    if (!row) return "—";
    return wbMetricText(row, "credits", function (value) {
      return number(value, digits == null ? 2 : digits);
    });
  }

  function money(value) {
    var parsed = Number(value);
    if (!isFinite(parsed)) return "—";
    if (currencyMode === "CNY" && usdCnyInfo && isFinite(usdCnyInfo.rate)) {
      return "¥" + number(parsed * usdCnyInfo.rate, 2);
    }
    return "$" + number(parsed, 2);
  }

  function finiteAmount(value) {
    if (value == null || value === "") return null;
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : null;
  }

  function amountBucket() {
    return DP.amountBucket();
  }

  function addAmount(bucket, value, partial, hasUsage) {
    DP.addAmount(bucket, value, partial, hasUsage);
  }

  function amountText(bucket) {
    if (!bucket || !bucket.hasUsage) return "—";
    if (!bucket.known) return "未计价";
    return (bucket.partial ? "≥" : "") + money(bucket.value);
  }

  function chooseAmount(primary, fallback) {
    if (!primary || !primary.hasUsage) return fallback || amountBucket();
    if (primary.known || !fallback || !fallback.hasUsage) return primary;
    var chosen = amountBucket();
    chosen.value = fallback.value;
    chosen.known = fallback.known;
    chosen.partial = primary.partial || fallback.partial;
    chosen.hasUsage = true;
    return chosen;
  }

  function costText(value, partial, hasUsage) {
    if (!hasUsage) return "—";
    var parsed = finiteAmount(value);
    if (parsed == null) return "未计价";
    return (partial ? "≥" : "") + money(parsed);
  }

  function timestamp(value) {
    if (!value) return "未知";
    var match = String(value).match(/T(\d{2}:\d{2}:\d{2})/);
    if (match) return match[1];
    var date = new Date(value);
    return isNaN(date.getTime())
      ? "未知"
      : date.toLocaleTimeString("zh-CN", { hour12: false });
  }

  function dateTimeShort(value) {
    if (!value) return "未知";
    var numeric = Number(value);
    var date = isFinite(numeric) && numeric > 1000000000
      ? new Date(numeric * 1000)
      : new Date(value);
    if (isNaN(date.getTime())) return "未知";
    var m = date.getMonth() + 1;
    var d = date.getDate();
    var h = String(date.getHours()).padStart(2, "0");
    var min = String(date.getMinutes()).padStart(2, "0");
    return (m < 10 ? "0" + m : m) + "-" + (d < 10 ? "0" + d : d) + " " + h + ":" + min;
  }

  // 手动刷新模型下只显示绝对采样时间：相对文案（「刚刚更新 / N 分钟前」）只在渲染时算一次，
  // 没有轮询后会说谎——数据早已过期，文案却永远停在打开那一刻。
  function updatedLabel(isoString) {
    if (!isoString) return "更新时间未知";
    var date = new Date(isoString);
    if (isNaN(date.getTime())) return "更新时间未知";
    function pad(n) { return n < 10 ? "0" + n : String(n); }
    var clock = pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
    var now = new Date();
    var sameDay = date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    if (sameDay) return "更新于 " + clock;
    return "更新于 " + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + clock;
  }

  function resetLabel(windowData) {
    if (!windowData) return "重置时间未知";
    if (windowData.reset_at) {
      return dateTimeShort(windowData.reset_at);
    }
    if (windowData.reset_after_seconds != null) {
      var hrs = Number(windowData.reset_after_seconds) / 3600;
      return "约 " + number(hrs, 1) + " 小时后";
    }
    return "重置时间未知";
  }

  function burnCountdown(windowData) {
    if (!windowData || typeof windowData !== "object") return null;
    var used = Number(windowData.used_percent) / 100;
    var seconds = Number(windowData.window_seconds);
    var start = Number(windowData.window_start);
    var resetAt = Number(windowData.reset_at);
    if (!isFinite(used) || !isFinite(seconds) || !isFinite(start) || !isFinite(resetAt)) return null;
    var now = Date.now() / 1000;
    var elapsed = now - start;
    if (used >= 1.0) return { text: "额度已耗尽，等待重置", level: "danger" };
    if (used <= 0 || elapsed <= 0 || seconds <= 0) return null;
    var ratePerSec = used / elapsed;
    var burnAt = now + (1.0 - used) / ratePerSec;
    if (burnAt >= resetAt) {
      var atResetUsed = Math.min(1.0, used + (resetAt - now) * ratePerSec);
      var atResetRemain = Math.max(0.0, 1.0 - atResetUsed);
      return {
        text: "按当前速率可撑到重置（届时预计剩余约 " + Math.round(atResetRemain * 100) + "%）",
        level: "ok"
      };
    }
    var gapHours = Math.max(0, (resetAt - burnAt) / 3600);
    var burnDate = new Date(burnAt * 1000);
    var m = burnDate.getMonth() + 1;
    var d = burnDate.getDate();
    var h = String(burnDate.getHours()).padStart(2, "0");
    var min = String(burnDate.getMinutes()).padStart(2, "0");
    var dateStr = (m < 10 ? "0" + m : m) + "-" + (d < 10 ? "0" + d : d) + " " + h + ":" + min;
    return {
      text: "按当前速率 " + dateStr + " 撞墙（重置前断额 " + Math.round(gapHours) + " 小时）",
      level: "warning"
    };
  }

  // 用量进度条统一按已用百分比绘制；colorClass 可指定专用色档。
  function progressBar(usedPct, colorClass) {
    var used = Number(usedPct);
    if (!isFinite(used)) used = 0;
    used = Math.max(0, Math.min(100, used));
    var color = colorClass || DP.barColor(used);
    return (
      '<div class="progress-track">' +
        '<div class="progress-fill ' + color + '" style="width:' + used.toFixed(1) + '%"></div>' +
      '</div>'
    );
  }

  function wbEquivMark(info, usd, hasUsage) {
    // 等值金额缺失/不完整时用“≥ / *”显式标注，不按 0 静默处理。
    return DP.wbEquivMark(info, usd, hasUsage);
  }

  function previewBarItem(label, valText, usedPct, subText, colorClass, subTone, subTitle) {
    return (
      '<div class="preview-bar-item">' +
        '<div class="preview-bar-label">' +
          '<span>' + escapeHtml(label) + '</span>' +
          '<strong class="preview-bar-val">' + escapeHtml(valText) + '</strong>' +
        '</div>' +
        progressBar(usedPct, colorClass) +
        (subText ? '<div class="preview-bar-sub">' + escapeHtml(subText) +
          (subTone ? '<span class="quota-dot ' + subTone + '"' +
            (subTitle ? ' title="' + escapeHtml(subTitle) + '"' : '') + '></span>' : '') +
          '</div>' : '') +
      '</div>'
    );
  }

  function pill(text, type) {
    if (!text) return "";
    return '<span class="pill-badge ' + (type || "accent") + '">' + escapeHtml(text) + '</span>';
  }

  // WB 账号是否处于限流/冷却（429 错误、账号级冷却、或任一模型级冷却）。
  // 不能只看 lastError：其他模型的一次成功会清掉它，模型级限流却仍在。
  function wbAccountLimited(a) {
    if (!a) return false;
    var now = Date.now() / 1000;
    if (a.in_cooldown) return true;
    var cds = a.model_cooldowns;
    // 只认尚未到期的冷却；过期残留不算当前限流。
    if (Array.isArray(cds) && cds.some(function (c) { return c && Number(c.until) > now; })) return true;
    if (a.last_error && a.last_error.indexOf("429") !== -1) {
      var resetAt = Number(a.last_error_reset_at);
      // 只有明确的未来重置时刻才能证明限流仍在；无时间的 429 是历史残留
      // （如 6020 queue.waiting，明细里只有相对 retry_after），当前是否在限
      // 只认上面已处理的 in_cooldown / 未过期 model_cooldowns。
      return isFinite(resetAt) && resetAt > 0 && resetAt > now;
    }
    return false;
  }

  // 最早的模型级冷却到期时间（epoch 秒 → "HH:MM"），无有效值返回空串。
  function wbCooldownHint(a) {
    var cds = a && a.model_cooldowns;
    if (!cds || !cds.length) return "";
    var min = null;
    cds.forEach(function (c) {
      if (!c || c.until == null) return;
      if (min == null || c.until < min) min = c.until;
    });
    if (min == null) return "";
    var t = dateTimeShort(min);
    if (!t || t === "未知") return "";
    return " · 至 " + t.slice(-5);
  }

  // 429 徽标上的模型名：只带当前在限的模型（已过期的冷却不显示），多个用「、」连。
  // 一个账号可能同时冷却多个模型，徽标要能一眼看出是哪些模型不可用。
  function wbCooldownModels(a) {
    var cds = a && a.model_cooldowns;
    if (!Array.isArray(cds)) return "";
    var now = Date.now() / 1000;
    var names = [];
    cds.forEach(function (c) {
      if (!c || !c.model) return;
      var until = Number(c.until);
      if (!isFinite(until) || until <= now) return; // 已到期不算在限
      if (names.indexOf(c.model) === -1) names.push(c.model);
    });
    return names.join("、");
  }

  // 账号卡的 429 明细行（账号 · 模型 · 恢复时刻 · 还有多久），不在限返回空串。
  // 模型已知时按模型逐条列；账号级 429 未归因时只显示未知模型，不推测恢复时间。
  function wbThrottleLine(a) {
    if (!wbAccountLimited(a)) return "";
    var now = Date.now() / 1000;
    var cds = Array.isArray(a.model_cooldowns) ? a.model_cooldowns : [];
    var parts = [];
    cds.forEach(function (c) {
      if (!c || !c.model) return;
      var until = Number(c.until);
      if (!isFinite(until) || until <= now) return;
      parts.push(
        escapeHtml(c.model) + " · " + DP.wbThrottleClock(until) + " 恢复（还有 " +
        DP.wbThrottleLeftText(until - now) + "）"
      );
    });
    if (!parts.length) {
      var resetAt = Number(a.last_error_reset_at);
      if (isFinite(resetAt) && resetAt > now) {
        parts.push("模型未指明 · " + DP.wbThrottleClock(resetAt) + " 恢复（还有 " + DP.wbThrottleLeftText(resetAt - now) + "）");
      } else {
        parts.push("模型未指明 · 恢复时间未记录");
      }
    }
    var name = (a && (a.nickname || a.masked_uid)) || "未知账号";
    return '<div class="throttle-line">🚧 ' + escapeHtml(name) + "：" + parts.join("；") + "</div>";
  }

  // WB「刷新积分」按钮的 HTML：状态跟随 wbPointsRefreshing，重画后不失真。
  function wbPointsRefreshBtnHtml() {
    var busy = wbPointsRefreshing;
    return '<button class="btn-card-refresh accordion-action' + (busy ? ' is-spinning' : '') + '" type="button" data-action="wb-points-refresh"' +
      (busy ? ' disabled' : '') +
      ' title="' + (busy ? '刷新中…' : '刷新积分（真实刷新余额，约 17 秒）') + '" aria-label="刷新积分">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.85.83 6.72 2.24L21 8"/><path d="M21 3v5h-5"/></svg>' +
      '</button>';
  }

  // 把页面上所有「刷新积分」按钮同步到当前进行状态（含重画出的新节点）。
  function syncWbPointsButtons() {
    document.querySelectorAll('[data-action="wb-points-refresh"]').forEach(function (btn) {
      btn.disabled = wbPointsRefreshing;
      btn.classList.toggle("is-spinning", wbPointsRefreshing);
      btn.setAttribute("title", wbPointsRefreshing ? "刷新中…" : "刷新积分（真实刷新余额，约 17 秒）");
    });
  }

  function callout(type, icon, title, desc) {
    return (
      '<div class="callout-banner ' + (type || "info") + '">' +
        '<div class="callout-icon">' + escapeHtml(icon) + '</div>' +
        '<div class="callout-content">' +
          (title ? '<div class="callout-title">' + escapeHtml(title) + '</div>' : '') +
          '<div class="callout-desc">' + escapeHtml(desc) + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function accordion(title, badgeText, contentHtml, defaultOpen, titleExtraHtml) {
    var openAttr = defaultOpen ? " open" : "";
    var badgeHtml = badgeText ? ' ' + pill(badgeText, "accent") : "";
    return (
      '<details class="accordion"' + openAttr + '>' +
        '<summary>' +
          '<div class="accordion-title-box">' +
            '<span>' + escapeHtml(title) + '</span>' + badgeHtml +
          '</div>' +
          (titleExtraHtml || "") +
          '<span class="accordion-chevron">▾</span>' +
        '</summary>' +
        '<div class="accordion-body">' + contentHtml + '</div>' +
      '</details>'
    );
  }

  function tokenTotal(tokens) {
    if (!tokens || typeof tokens !== "object") return 0;
    return ["input", "cache_read", "cache_write", "output", "reasoning"].reduce(function (tot, k) {
      var val = Number(tokens[k]);
      return tot + (isFinite(val) ? val : 0);
    }, 0);
  }

  // 1. 渲染 CODEX 卡片
  function renderCodex(data) {
    var quota = data && data.quota;
    var primary = quota && quota.primary_window;
    var secondary = quota && quota.secondary_window;
    var quotaError = data && data.quota_error;
    var windowTotals = data && data.window_totals || {};
    var total = data && data.total || {};
    var totalTokens = total.tokens || {};
    var inTokens = Number(totalTokens.input) || 0;
    var readTokens = Number(totalTokens.cache_read) || 0;
    var writeTokens = Number(totalTokens.cache_write) || 0;
    var outTokens = Number(totalTokens.output) || 0;
    var reasoningTokens = Number(totalTokens.reasoning) || 0;
    var allTokens = inTokens + readTokens + writeTokens + outTokens;
    var hitPct = (inTokens + readTokens + writeTokens) > 0
      ? (readTokens / (inTokens + readTokens + writeTokens)) * 100
      : 0;

    var totalHasUsage = Number(total.api_calls) > 0 || Number(total.sessions) > 0;
    var costUsd = costText(total.api_equivalent_usd, total.api_equivalent_usd_info && total.api_equivalent_usd_info.complete === false, totalHasUsage);
    var creditsEquiv = total.credits_equivalent != null ? number(total.credits_equivalent, 2) : "—";

    // 重置卡（rate-limit reset credits，账号级）：张数双源读取；到期时间来自 app-server 明细
    var resetCount = null;
    var resetExpiries = [];
    if (quota && quota.reset_credits && quota.reset_credits.available_count != null) {
      resetCount = Number(quota.reset_credits.available_count);
    }
    if (data && data.official && data.official.rate_limit_reset_credits) {
      var rrc = data.official.rate_limit_reset_credits;
      if (resetCount == null && rrc.available_count != null) resetCount = Number(rrc.available_count);
      if (Array.isArray(rrc.credits)) {
        rrc.credits.forEach(function (c) {
          if (!c || (c.status && c.status !== "available")) return;
          var exp = Number(c.expires_at);
          if (isFinite(exp) && exp > 0) resetExpiries.push(exp);
        });
        resetExpiries.sort(function (a, b) { return a - b; });
      }
    }
    if (resetCount != null && !isFinite(resetCount)) resetCount = null;

    // 更新首页总览预览卡片（五小时额度/周额度进度条，不显示钱）
    var preBars = document.getElementById("preview-codex-bars");
    var preTag = document.getElementById("preview-codex-tag");
    var preFootHint = document.getElementById("preview-codex-foot-hint");
    if (preTag) preTag.textContent = quota && quota.plan ? (quota.plan.toUpperCase() + " ✅") : "统一账本";
    if (preFootHint) preFootHint.textContent = (total.sessions || 0) + " 会话 · " + (total.api_calls || 0) + " 调用 · 点击查看明细 →";
    var preReset = document.getElementById("preview-codex-reset");
    if (preReset) {
      if (resetCount != null) {
        var preResetText = "（重置卡 " + resetCount + " 张";
        if (resetExpiries.length) preResetText += "，最近过期 " + dateTimeShort(resetExpiries[0]).slice(0, 5);
        preReset.textContent = preResetText + "）";
      } else {
        preReset.textContent = "";
      }
    }

    if (preBars) {
      var barsHtml = [];
      if (primary && primary.used_percent != null) {
        var pRemain = Math.max(0, 100 - Number(primary.used_percent));
        var burn5h = burnCountdown(primary);
        var sub5h = resetLabel(primary) + " 重置" + (burn5h ? " · " + burn5h.text : "");
        barsHtml.push(previewBarItem("5 小时主窗口配额", "已用 " + percent(primary.used_percent) + " (余 " + pRemain.toFixed(0) + "%)", primary.used_percent, sub5h));
      } else {
        barsHtml.push(previewBarItem("5 小时主窗口配额", "统一账本对账中", 0, "服务端接口受限，本地日志完整审计中"));
      }

      if (secondary && secondary.used_percent != null) {
        var sRemain = Math.max(0, 100 - Number(secondary.used_percent));
        var burn7d = burnCountdown(secondary);
        var sub7d = resetLabel(secondary) + " 重置" + (burn7d ? " · " + burn7d.text : "");
        barsHtml.push(previewBarItem("7 天滚动次窗口", "已用 " + percent(secondary.used_percent) + " (余 " + sRemain.toFixed(0) + "%)", secondary.used_percent, sub7d));
      } else {
        barsHtml.push(previewBarItem("7 天滚动窗口", "统一账本", 0, "覆盖五个 active Hermes 实例"));
      }
      preBars.innerHTML = barsHtml.join("");
    }

    var html = [];

    // 重置卡（账号级）：并入「额度窗口」块展示（块内最后一行）；无窗口数据时退回独立行
    var resetRowHtml = "";
    if (resetCount != null) {
      var resetExpiryText = resetExpiries.length ? resetExpiries.map(dateTimeShort).join("、") : "";
      resetRowHtml =
        '<div class="reset-credit-row">' +
          '<span class="reset-credit-count">重置卡：' + number(resetCount, 0) + ' 张</span>' +
          (resetExpiryText ? '<span class="reset-credit-expiry">到期：' + escapeHtml(resetExpiryText) + '</span>' : '') +
        '</div>';
    }

    // 额度窗口：5 小时 + 7 天合并为一个块；重置卡收在块内（不再单独成块）
    if (quota && (primary || secondary)) {
      var quotaRows = [];
      if (primary) {
        var burn5h = burnCountdown(primary);
        var w5hStat = windowTotals.primary_window || windowTotals["5h"] || {};
        var w5hFull = w5hStat.implied_full_window_usd != null ? " · 预计完整窗口约 " + money(w5hStat.implied_full_window_usd) + (w5hStat.implied_full_window_credits != null ? " / " + number(w5hStat.implied_full_window_credits, 0) + " Credits" : "") : "";
        quotaRows.push(
          '<div class="quota-row">' +
            '<div class="gauge-card-header">' +
              '<span class="gauge-title">5 小时窗口</span>' +
              '<strong class="gauge-value">已用 ' + (primary.used_percent != null ? percent(primary.used_percent) : "—") + '</strong>' +
            '</div>' +
            progressBar(primary.used_percent) +
            '<div class="gauge-footer">' +
              '<span>已用 ' + percent(primary.used_percent) + ' · 剩余 ' + percent(100 - (primary.used_percent || 0)) + '</span>' +
              '<span>' + escapeHtml(resetLabel(primary)) + ' 重置</span>' +
            '</div>' +
            (burn5h ? '<div style="margin-top:4px;"><span class="burn-prediction-badge ' + burn5h.level + '">' + escapeHtml(burn5h.text + w5hFull) + '</span></div>' : '') +
          '</div>'
        );
      }
      if (secondary) {
        var burn7d = burnCountdown(secondary);
        var w7dStat = windowTotals.secondary_window || windowTotals["7d"] || {};
        var w7dFull = w7dStat.implied_full_window_usd != null ? " · 预计完整窗口约 " + money(w7dStat.implied_full_window_usd) + (w7dStat.implied_full_window_credits != null ? " / " + number(w7dStat.implied_full_window_credits, 0) + " Credits" : "") : "";
        quotaRows.push(
          '<div class="quota-row">' +
            '<div class="gauge-card-header">' +
              '<span class="gauge-title">7 天窗口</span>' +
              '<strong class="gauge-value">已用 ' + (secondary.used_percent != null ? percent(secondary.used_percent) : "—") + '</strong>' +
            '</div>' +
            progressBar(secondary.used_percent) +
            '<div class="gauge-footer">' +
              '<span>已用 ' + percent(secondary.used_percent) + ' · 剩余 ' + percent(100 - (secondary.used_percent || 0)) + '</span>' +
              '<span>' + escapeHtml(resetLabel(secondary)) + ' 重置</span>' +
            '</div>' +
            (burn7d ? '<div style="margin-top:4px;"><span class="burn-prediction-badge ' + burn7d.level + '">' + escapeHtml(burn7d.text + w7dFull) + '</span></div>' : '') +
          '</div>'
        );
      }
      html.push(
        '<div class="gauge-card">' +
          '<div class="gauge-card-header">' +
            '<span class="gauge-title">额度窗口</span>' +
            '<span class="quota-window-tag">5 小时 / 7 天</span>' +
          '</div>' +
          quotaRows.join("") +
          resetRowHtml +
        '</div>'
      );
    } else if (resetRowHtml) {
      html.push(resetRowHtml);
    }

    html.push('<div class="anchor-host" data-anchor-block="codex"></div>');

    if (!quota && quotaError) {
      html.push(callout("info", "ℹ️", "服务端额度受限", quotaError + "；以下展示本地统一账本审计数据"));
    }

    // 核心统一总用量 KPI Grid（窗口 = 统一账本窗口：额度窗口起点 → 数据快照）
    var codexWindowText = (data && data.window_start_bj && data.snapshot_bj)
      ? '🕒 起止时间：' + dateTimeShort(data.window_start_bj) + ' ~ ' + dateTimeShort(data.snapshot_bj)
      : "";
    html.push(
      '<div class="kpi-grid">' +
        '<div class="kpi-tile">' +
          '<span class="kpi-label">API 等值 (统一账本)</span>' +
          '<strong class="kpi-val">' + costUsd + '</strong>' +
          '<span class="kpi-sub">折合 ' + creditsEquiv + ' Credits</span>' +
          (codexWindowText ? '<span class="kpi-window">' + codexWindowText + '</span>' : '') +
        '</div>' +
        '<div class="kpi-tile">' +
          '<span class="kpi-label">记录 Token 流量</span>' +
          '<strong class="kpi-val">' + formatTokens(allTokens) + '</strong>' +
          '<span class="kpi-sub">缓存命中率 ' + hitPct.toFixed(1) + '%</span>' +
        '</div>' +
        '<div class="kpi-tile">' +
          '<span class="kpi-label">活跃会话</span>' +
          '<strong class="kpi-val">' + number(total.sessions || 0, 0) + ' 个</strong>' +
          '<span class="kpi-sub">窗口起点 ' + (data && data.window_start_bj ? timestamp(data.window_start_bj) : "7天前") + '</span>' +
        '</div>' +
        '<div class="kpi-tile">' +
          '<span class="kpi-label">API 调用次数</span>' +
          '<strong class="kpi-val">' + number(total.api_calls || 0, 0) + ' 次</strong>' +
          '<span class="kpi-sub">长上下文: ' + number(total.long_context_calls || 0, 0) + ' 次</span>' +
        '</div>' +
      '</div>'
    );

    // Token 流量全维度分布卡片
    html.push(
      '<div class="token-flow-card">' +
        '<div class="token-flow-head">' +
          '<span>Token 流量全维度分布</span>' +
          '<span>总计 ' + formatTokens(allTokens) + '</span>' +
        '</div>' +
        '<div class="token-flow-grid">' +
          '<div class="token-flow-item">' +
            '<span class="token-flow-label">📥 输入 Token</span>' +
            '<span class="token-flow-value">' + formatTokens(inTokens) + '</span>' +
            '<span class="token-flow-sub">全新上下文</span>' +
          '</div>' +
          '<div class="token-flow-item">' +
            '<span class="token-flow-label">⚡ 缓存命中</span>' +
            '<span class="token-flow-value">' + formatTokens(readTokens) + '</span>' +
            '<span class="token-flow-sub">占比 ' + hitPct.toFixed(1) + '%</span>' +
          '</div>' +
          '<div class="token-flow-item">' +
            '<span class="token-flow-label">📤 输出 Token</span>' +
            '<span class="token-flow-value">' + formatTokens(outTokens) + '</span>' +
            '<span class="token-flow-sub">其中推理 ' + formatTokens(reasoningTokens) + '</span>' +
          '</div>' +
          '<div class="token-flow-item">' +
            '<span class="token-flow-label">✍️ 缓存写入</span>' +
            '<span class="token-flow-value">' + formatTokens(writeTokens) + '</span>' +
            '<span class="token-flow-sub">持久化 Token</span>' +
          '</div>' +
        '</div>' +
      '</div>'
    );

    // 折叠 1：各实例分项用量明细
    var instances = Array.isArray(data && data.active_instances) ? data.active_instances : [];
    var instanceCards = instances.map(function (item) {
      var name = item && item.name || "未命名";
      var calls = Number(item && item.api_calls) || 0;
      var sessions = Number(item && item.sessions) || 0;
      var t = item && item.tokens || {};
      var tIn = Number(t.input) || 0;
      var tRead = Number(t.cache_read) || 0;
      var tOut = Number(t.output) || 0;
      var tReason = Number(t.reasoning) || 0;
      var tTotal = tIn + tRead + tOut;
      var itemHasUsage = calls > 0 || sessions > 0;
      var cost = costText(item && item.api_equivalent_usd, item && item.api_equivalent_usd_info && item.api_equivalent_usd_info.complete === false, itemHasUsage);
      var cred = item && item.credits_equivalent != null ? number(item.credits_equivalent, 2) : "—";
      var isZero = calls === 0 && sessions === 0;

      var modelsDict = item && item.models || {};
      var modelTags = Object.keys(modelsDict).map(function (mKey) {
        return '<span class="tag-pill">' + escapeHtml(mKey) + ' × ' + modelsDict[mKey] + '</span>';
      }).join("");

      var sReview = item && item.self_review || {};
      var reviewStr = (sReview.skill || sReview.memory)
        ? "自审: skill " + (sReview.skill || 0) + " · memory " + (sReview.memory || 0)
        : "";

      return (
        '<div class="instance-card' + (isZero ? ' dimmed' : '') + '">' +
          '<div class="instance-card-header">' +
            '<div class="instance-card-title">' +
              '<span>' + escapeHtml(name) + '</span>' +
              (isZero ? pill("无调用", "accent") : pill(sessions + " 会话 · " + calls + " 次调用", "ok")) +
            '</div>' +
            '<div class="instance-card-cost">' + (isZero ? "—" : cost + ' <small style="color:var(--muted);font-weight:normal;">(' + cred + ' credits)</small>') + '</div>' +
          '</div>' +
          (!isZero ? (
            '<div class="instance-card-tokens">' +
              '流量: ' + formatTokens(tTotal) + ' (输入 ' + formatTokens(tIn) + ' · 缓存 ' + formatTokens(tRead) + ' · 输出 ' + formatTokens(tOut) + (tReason ? ' · 推理 ' + formatTokens(tReason) : '') + ')' +
            '</div>' +
            '<div class="instance-card-meta">' +
              '<div class="tag-cloud">' + (modelTags || '<span class="muted">无模型记录</span>') + '</div>' +
              (reviewStr ? '<span style="font-size:0.7rem;color:var(--muted);">' + escapeHtml(reviewStr) + '</span>' : '') +
            '</div>'
          ) : '') +
        '</div>'
      );
    }).join("");
    if (!instanceCards) instanceCards = '<p class="muted">暂无实例数据</p>';

    // 折叠 2：按模型汇总与长上下文记录
    var modelUsage = total.model_usage || {};
    var modelKeys = Object.keys(modelUsage);
    var modelRows = modelKeys.map(function (mName) {
      var m = modelUsage[mName] || {};
      var calls = Number(m.api_calls) || 0;
      var sessions = Number(m.sessions) || 0;
      var t = m.tokens || {};
      var tIn = Number(t.input) || 0;
      var tRead = Number(t.cache_read) || 0;
      var tOut = Number(t.output) || 0;
      var tReason = Number(t.reasoning) || 0;
      var tTotal = tIn + tRead + tOut;
      var cost = costText(m.api_equivalent_usd, m.api_equivalent_usd_info && m.api_equivalent_usd_info.complete === false, calls > 0);
      var cred = m.credits_equivalent != null ? number(m.credits_equivalent, 2) + " credits" : "";
      return (
        '<div class="model-row">' +
          '<div class="model-row-head">' +
            '<span class="model-name">' + escapeHtml(mName) + '</span>' +
            '<span class="model-cost">' + cost + ' <small style="color:var(--muted);font-weight:normal;">(' + cred + ')</small></span>' +
          '</div>' +
          '<div class="model-tokens">' +
            sessions + ' 会话 · ' + calls + ' 次调用 · 总流量 ' + formatTokens(tTotal) +
            '<br>输入 ' + formatTokens(tIn) + ' · 缓存 ' + formatTokens(tRead) + ' · 输出 ' + formatTokens(tOut) +
            (tReason ? ' (推理 ' + formatTokens(tReason) + ')' : '') +
          '</div>' +
        '</div>'
      );
    }).join("");

    // >272K 长上下文
    var lcCalls = Number(total.long_context_calls) || 0;
    var lcUsage = total.long_context_usage || {};
    var lcModels = lcUsage.models || {};
    var lcModelRows = Object.keys(lcModels).map(function (k) {
      var lm = lcModels[k] || {};
      return '• ' + escapeHtml(k) + ': ' + (lm.api_calls || 0) + ' 次 · 基础 API ' + money(lm.base_api_equivalent_usd) + ' · 额外 ' + money(lm.extra_api_equivalent_usd) + ' · 倍率后 ' + money(lm.long_context_api_equivalent_usd) + ' · 额外 Credits ' + number(lm.extra_credits_equivalent, 2);
    }).join("<br>");

    var longContextHtml = (
      '<div class="highlight-box">' +
        '<div class="highlight-box-title">⚡ >272K 长上下文记录 (' + lcCalls + ' 次)</div>' +
        '<div>' + (lcModelRows || '暂无长上下文模型明细') + '</div>' +
        '<div style="font-size:0.68rem;color:var(--muted);margin-top:2px;">' +
          '计价说明：API 等值按官方 API 倍率（>272K 输入/缓存 2×、输出 1.5×），额外 API 已计入 API 等值总额；' +
          '6.1 Sol 仅订阅 included allowance 的额外 Credits 为 0；购买 credits、Enterprise PAYG 与 API 仍按各自规则。' +
        '</div>' +
      '</div>'
    );

    // 折叠 3：后台自审与口径说明
    var selfReview = data && data.self_review_total || {};
    var reviewHtml = (
      '<ul class="item-rows" style="margin-bottom:10px;">' +
        '<li class="item-row"><div class="item-row-title">技能评测 (Skill Review)</div><div class="item-row-val">' + number(selfReview.skill || 0, 0) + ' 次</div></li>' +
        '<li class="item-row"><div class="item-row-title">记忆提取 (Memory Review)</div><div class="item-row-val">' + number(selfReview.memory || 0, 0) + ' 次</div></li>' +
      '</ul>' +
      '<div style="font-size:0.72rem;color:var(--muted);line-height:1.45;border-top:1px dashed var(--border);padding-top:8px;">' +
        '• reasoning 是 output 的明细，流量不重复累加。<br>' +
        '• API 等值和完整窗口反推是估算，非 Plus 之外的实际扣款。<br>' +
        '• 统一账本覆盖五个 active Hermes 实例和 Codex 本地持久化记录。' +
      '</div>'
    );

    // 起止时间：复用 KPI 区已定义的窗口文本（统一账本窗口）
    var codexWindowNote = codexWindowText ? '<div class="model-window-note">' + codexWindowText + '</div>' : "";

    html.push(
      '<div class="accordion-group">' +
        accordion("模型消耗与长上下文", String(modelKeys.length), codexWindowNote + '<div class="models-list">' + modelRows + longContextHtml + '</div>', true) +
        accordion("各实例分项用量明细", String(instances.length), '<div class="instances-list">' + instanceCards + '</div>', false) +
        accordion("后台自审与口径说明", "", reviewHtml, false) +
      '</div>'
    );

    return html.join("");
  }

  // 2. 渲染 WORKBUDDY 卡片
  function renderWorkBuddy(data) {
    var gateway = data && data.gateway || {};
    var insights = (data && data.hub_insights) || {};
    var schedLine = DP.hubSchedulerLine(insights);
    var activityBits = DP.hubActivityBits(insights && insights.activity);
    var updBadge = DP.hubUpdateBadge(insights);
    var totals = data && data.totals || {};
    var usage = data && data.usage || {};
    var today = usage.today || {};
    var week = usage.week || {};
    var accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
    var remainComplete = totals.remain_complete !== false;
    var sizeComplete = totals.size_complete !== false;
    var remainCredits = finiteAmount(totals.remain);
    var sizeCredits = finiteAmount(totals.size);
    if (remainCredits == null) remainCredits = finiteAmount(totals.remain_known_total);
    if (sizeCredits == null) sizeCredits = finiteAmount(totals.size_known_total);

    // 动态统计账号健康状态 (非硬编码)
    var cnAccounts = accounts.filter(function (a) { return a.realm === "cn"; });
    var intlAccounts = accounts.filter(function (a) { return a.realm === "intl"; });

    var cnSizeFromAccounts = cnAccounts.reduce(function (s, a) { return s + (Number(a.credits && a.credits.size != null ? a.credits.size : a.size) || 0); }, 0);
    var intlSizeFromAccounts = intlAccounts.reduce(function (s, a) { return s + (Number(a.credits && a.credits.size != null ? a.credits.size : a.size) || 0); }, 0);
    var cnRemainFromAccounts = cnAccounts.reduce(function (s, a) { return s + (Number(a.credits && a.credits.remain != null ? a.credits.remain : a.remain) || 0); }, 0);
    var intlRemainFromAccounts = intlAccounts.reduce(function (s, a) { return s + (Number(a.credits && a.credits.remain != null ? a.credits.remain : a.remain) || 0); }, 0);
    var cnSizeComplete = totals.cn_size_complete !== false;
    var intlSizeComplete = totals.intl_size_complete !== false;
    var cnRemainComplete = totals.cn_remain_complete !== false;
    var intlRemainComplete = totals.intl_remain_complete !== false;
    var cnSizeVal = finiteAmount(totals.cn_size);
    var intlSizeVal = finiteAmount(totals.intl_size);
    var cnRemVal = finiteAmount(totals.cn_remain);
    var intlRemVal = finiteAmount(totals.intl_remain);
    if (cnSizeVal == null) cnSizeVal = finiteAmount(totals.cn_size_known_total);
    if (intlSizeVal == null) intlSizeVal = finiteAmount(totals.intl_size_known_total);
    if (cnRemVal == null) cnRemVal = finiteAmount(totals.cn_remain_known_total);
    if (intlRemVal == null) intlRemVal = finiteAmount(totals.intl_remain_known_total);
    if (cnSizeVal == null && cnSizeComplete) cnSizeVal = cnSizeFromAccounts;
    if (intlSizeVal == null && intlSizeComplete) intlSizeVal = intlSizeFromAccounts;
    if (cnRemVal == null && cnRemainComplete) cnRemVal = cnRemainFromAccounts;
    if (intlRemVal == null && intlRemainComplete) intlRemVal = intlRemainFromAccounts;

    var totalSizeVal = sizeCredits;
    var totalRemVal = remainCredits;
    if (totalSizeVal == null && sizeComplete && cnSizeVal != null && intlSizeVal != null) totalSizeVal = cnSizeVal + intlSizeVal;
    if (totalRemVal == null && remainComplete && cnRemVal != null && intlRemVal != null) totalRemVal = cnRemVal + intlRemVal;

    var remainCredits = totalRemVal;
    var sizeCredits = totalSizeVal;
    var usedCredits = remainComplete && sizeComplete && sizeCredits > 0 && remainCredits != null
      ? sizeCredits - remainCredits : null;
    var creditPct = usedCredits != null ? (usedCredits / sizeCredits) * 100 : null;
    var totalRemainPct = remainComplete && sizeComplete && sizeCredits > 0 && remainCredits != null
      ? (remainCredits / sizeCredits) * 100 : null;

    // 各自域内的剩余率（各自剩余 / 各自配额）
    var cnRemRate = cnRemainComplete && cnSizeComplete && cnSizeVal > 0 && cnRemVal != null ? (cnRemVal / cnSizeVal) * 100 : null;
    var intlRemRate = intlRemainComplete && intlSizeComplete && intlSizeVal > 0 && intlRemVal != null ? (intlRemVal / intlSizeVal) * 100 : null;

    var cnRemain = cnRemainComplete ? (cnRemVal == null ? "—" : number(cnRemVal, 2)) : "部分 ≥" + (cnRemVal == null ? "—" : number(cnRemVal, 2));
    var intlRemain = intlAccounts.length === 0 ? "—（无账号）"
      : (intlRemainComplete ? (intlRemVal == null ? "—" : number(intlRemVal, 2)) : "部分 ≥" + (intlRemVal == null ? "—" : number(intlRemVal, 2)));
    var totalRemainText = remainComplete ? (remainCredits == null ? "—" : number(remainCredits, 2)) : "部分 ≥" + (remainCredits == null ? "—" : number(remainCredits, 2));
    var totalSizeText = sizeComplete ? (sizeCredits == null ? "—" : number(sizeCredits, 1)) : "部分 ≥" + (sizeCredits == null ? "—" : number(sizeCredits, 1));
    var creditPctText = creditPct == null ? "—" : creditPct.toFixed(1) + "%";
    var totalRemainPctText = totalRemainPct == null ? "—" : totalRemainPct.toFixed(1) + "%";
    var usedCreditsText = usedCredits == null ? "—" : number(usedCredits, 2);
    var cnRemRateText = cnRemRate == null ? "—" : cnRemRate.toFixed(1) + "%";
    var intlRemRateText = intlRemRate == null ? "—" : intlRemRate.toFixed(1) + "%";
    var cnSizeStr = cnSizeVal != null ? (cnSizeComplete ? number(cnSizeVal, 1) : "≥" + number(cnSizeVal, 1)) : "—";
    var intlSizeStr = intlSizeVal != null ? (intlSizeComplete ? number(intlSizeVal, 1) : "≥" + number(intlSizeVal, 1)) : "—";

    function usedCreditsProgressBar(usedPct, heightPx) {
      var hStyle = heightPx ? ' style="height:' + heightPx + 'px;"' : '';
      if (usedPct == null || !isFinite(Number(usedPct))) {
        return '<div class="progress-track"' + hStyle + '></div>';
      }
      var pct = Math.max(0, Math.min(100, Number(usedPct)));
      return (
        '<div class="progress-track"' + hStyle + '>' +
          '<div class="progress-fill ' + DP.barColor(pct) + '" style="width:' + pct.toFixed(1) + '%"></div>' +
        '</div>'
      );
    }

    // 动态统计账号健康状态 (非硬编码)。「限流」= 429 错误、账号级冷却、或模型级冷却
    // （模型冷却不产生 lastError，必须单列判定）。
    var cnTotal = cnAccounts.length;
    var cn429Count = cnAccounts.filter(wbAccountLimited).length;
    var cnReadyCount = cnAccounts.filter(function (a) { return wbAccountReadyState(a) === true; }).length;
    var cnReadyUnknownCount = cnAccounts.filter(function (a) { return wbAccountReadyState(a) == null; }).length;
    var cnPct = cnTotal > 0 ? (cnReadyCount / cnTotal) * 100 : 0;

    var intlTotal = intlAccounts.length;
    var intlBalanceUnknownCount = intlAccounts.filter(function (a) { return wbAccountReadyState(a) == null; }).length;
    var intlActiveCount = intlAccounts.filter(function (a) { return wbAccountReadyState(a) === true; }).length;
    var intl429Count = intlAccounts.filter(wbAccountLimited).length;
    var intlPct = intlTotal > 0 ? (intlActiveCount / intlTotal) * 100 : 0;
    var panelReachable = gateway.endpoint_reachable === true || gateway.http_reachable === true;
    var panelReady = typeof gateway.panel_ready === "boolean" ? gateway.panel_ready : null;
    var panelStateText = !panelReachable ? "健康接口不可达"
      : (panelReady === true ? "健康接口可达 · 有健康账号"
        : (panelReady === false ? "健康接口可达 · 当前未就绪" : "健康接口可达 · 就绪状态未知"));

    // 更新首页总览预览卡片（总额度/国内账号/国际账号健康进度条，不显示钱）
    var preWbBars = document.getElementById("preview-wb-bars");
    var preWbTag = document.getElementById("preview-wb-tag");
    var preWbFootHint = document.getElementById("preview-wb-foot-hint");
    if (preWbTag) {
      preWbTag.textContent = !panelReachable ? "网关接口不可达"
        : (panelReady === false ? "网关未就绪"
          : (panelReady == null ? "网关健康状态未知"
            : ((cn429Count > 0 || intl429Count > 0) ? "⚠️有429限流"
              : ((cnReadyUnknownCount + intlBalanceUnknownCount) > 0 ? "账号状态部分未知" : "正常就绪"))));
    }
    var preWbRealm = document.getElementById("preview-wb-realm");
    if (preWbRealm) {
      var wbRealm = DP.realmLabel(gateway.realm);
      if (wbRealm.tone === "unknown") {
        preWbRealm.textContent = "按请求分流";
        preWbRealm.className = "realm-pill is-unknown";
        preWbRealm.title = "网关未提供默认出口，按请求分流";
      } else {
        preWbRealm.textContent = wbRealm.text;
        preWbRealm.className = "realm-pill is-" + wbRealm.tone;
        preWbRealm.title = "当前默认出口（bare 模型名）；global: 前缀仍走国际版";
      }
    }
    if (preWbFootHint) {
      preWbFootHint.textContent = panelStateText + " · " + accounts.length + " 个账号池 · 点击查看明细 →";
    }

    if (preWbBars) {
      var wbBarsHtml = [];
      // 1. 总积分已用进度条（国内绿与国际靛蓝双色堆叠）
      var todayCnCred = Number(today.cn_credits) || 0;
      var todayIntlCred = Number(today.intl_credits) || 0;
      var todayCostNote = today.credits_realm_split_complete === false
        ? ' · 今日耗: ' + wbCreditsText(today, 1) + ' 积分'
        : (today.credits_complete === false
        ? ' · 今日耗: ' + wbCreditsText(today, 1) + ' 积分'
        : ((todayCnCred > 0 || todayIntlCred > 0)
            ? ' · 今日耗: 🇨🇳 <span class="credit-cn">' + number(todayCnCred, 1) + '</span> + 🌐 <span class="credit-intl">' + number(todayIntlCred, 1) + '</span> 积分'
            : (today.credits != null && Number(today.credits) > 0 ? ' · 今日耗 ' + number(today.credits, 1) + ' 积分' : '')));

      wbBarsHtml.push(
        '<div class="preview-bar-item">' +
          '<div class="preview-bar-label">' +
            '<span>积分已用</span>' +
            '<div class="preview-bar-val" style="display:inline-flex;align-items:center;gap:4px;font-variant-numeric:tabular-nums;flex-wrap:wrap;">' +
              '<strong>已用 ' + usedCreditsText + ' / ' + totalSizeText + ' 点 (' + creditPctText + ')</strong>' +
            '</div>' +
          '</div>' +
          usedCreditsProgressBar(creditPct) +
          '<div class="preview-bar-sub">' +
            '<span>国内余 <strong class="credit-cn">' + cnRemain + ' 点 · ' + cnRemRateText + '</strong> · 国际余 <strong class="credit-intl">' + intlRemain + ' 点 · ' + intlRemRateText + '</strong> (总余 ' + totalRemainText + ' 点 · ' + totalRemainPctText + ')' + todayCostNote + '</span>' +
          '</div>' +
        '</div>'
      );

      // 2. 账号就绪（国内/国际合成一行）
      var totalAccounts = cnTotal + intlTotal;
      var totalReady = cnReadyCount + intlActiveCount;
      var totalPct = totalAccounts > 0 ? (totalReady / totalAccounts) * 100 : 0;
      var has429 = cn429Count > 0 || intl429Count > 0;
      var readyText = totalAccounts
        ? "🇨🇳 " + cnReadyCount + "/" + cnTotal + " · 🌐 " + intlActiveCount + "/" + intlTotal + " 可用"
        : "未知（无账号）";
      var readySub = has429
        ? "⚠️ 有账号冷却或限流（国内 " + cn429Count + " 个 · 国际 " + intl429Count + " 个）"
        : (totalAccounts === 0 ? "未配置账号"
          : (totalReady === 0 ? "⚠️ 当前无可用账号额度"
            : "账号可用数结合余额、停用、暂停和冷却状态计算"));
      wbBarsHtml.push(
        '<div class="preview-bar-item">' +
          '<div class="preview-bar-label">' +
            '<span>账号就绪</span>' +
            '<strong class="preview-bar-val" style="' + (has429 ? 'color:var(--amber);' : (totalAccounts > 0 && totalReady === 0 ? 'color:var(--rose);' : '')) + '">' +
              readyText +
            '</strong>' +
          '</div>' +
          '<div class="progress-track"><div class="progress-fill ' + (has429 ? 'warning' : (totalReady === 0 && totalAccounts > 0 ? 'danger' : 'ok')) + '" style="width:' + totalPct.toFixed(1) + '%"></div></div>' +
          '<div class="preview-bar-sub">' + escapeHtml(readySub) + '</div>' +
        '</div>'
      );

      // 3. 有 429 时追加明细行（哪个账号 · 哪个模型 · 何时恢复），安静时整块不渲染。
      var throttleLines = (cnAccounts.concat(intlAccounts)).map(wbThrottleLine).filter(Boolean).join("");
      if (throttleLines) {
        wbBarsHtml.push('<div class="throttle-alert">' + throttleLines + '</div>');
      }

      preWbBars.innerHTML = wbBarsHtml.join("");
    }

    var html = [];

    // 额度总览仪表卡（总积分已用按国内与国际双色堆叠）
    html.push(
      '<div class="gauge-card">' +
        '<div class="gauge-card-header" style="flex-wrap:wrap;gap:6px;">' +
          '<span class="gauge-title">WorkBuddy 积分已用</span>' +
          '<div style="display:flex;align-items:baseline;gap:6px;font-variant-numeric:tabular-nums;flex-wrap:wrap;">' +
            '<strong style="font-size:1.35rem;">已用 ' + usedCreditsText + ' / ' + totalSizeText + ' 点 (' + creditPctText + ')</strong>' +
          '</div>' +
        '</div>' +
        usedCreditsProgressBar(creditPct, 10) +
        '<div class="gauge-footer" style="flex-wrap:wrap;gap:4px;">' +
          '<span>总额度 ' + totalSizeText + ' credits (<span class="credit-cn">国内 ' + cnSizeStr + '</span> + <span class="credit-intl">国际 ' + intlSizeStr + '</span>)</span>' +
          '<span>总余 ' + totalRemainText + ' 点 (' + totalRemainPctText + ') · ' + accounts.length + ' 账号</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;border-top:1px dashed var(--border);padding-top:6px;margin-top:4px;font-size:0.75rem;flex-wrap:wrap;gap:6px;">' +
          '<span>🇨🇳 国内版余: <strong class="credit-cn">' + cnRemain + ' / ' + cnSizeStr + '</strong> (' + cnRemRateText + ')</span>' +
          '<span>🌐 国际版余: <strong class="credit-intl" style="' + (intlRemainComplete && intlRemVal === 0 ? 'color:var(--rose);' : '') + '">' + intlRemain + ' / ' + intlSizeStr + ' (' + intlRemRateText + (intlRemainComplete && intlRemVal === 0 ? ' 已耗尽' : '') + ')</strong></span>' +
        '</div>' +
      '</div>'
    );

    var earliestExpiry = null;
    accounts.forEach(function (a) {
      var ee = a.credits && a.credits.earliest_expiring;
      if (ee && (!earliestExpiry || (ee.days_left != null && ee.days_left < earliestExpiry.days_left))) {
        earliestExpiry = ee;
      }
    });

    var routeInfo = gateway.realm_servable && typeof gateway.realm_servable === "object" ? gateway.realm_servable : {};
    var wbDetailRealm = DP.realmLabel(gateway.realm);
    var currentRealmText = wbDetailRealm.tone === "unknown" ? "未知" : wbDetailRealm.text.replace(/^出口：/, "");
    function routeStatus(key) {
      return routeInfo[key] === true ? "可用" : (routeInfo[key] === false ? "不可用" : "未知");
    }
    var panelIcon = !panelReachable ? "⚪" : (panelReady === true ? "🟢" : (panelReady === false ? "🟡" : "⚪"));
    var panelVersion = gateway.version ? "v" + escapeHtml(gateway.version) : "";
    var gatewayLabel = gateway.service === "workbuddy-hub" ? "Hub" : "网关";
    html.push(
      '<div style="background:var(--card-subtle);border:1px solid var(--border);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;font-size:0.75rem;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;">' +
          '<span>' + panelIcon + ' ' + gatewayLabel + '：' + escapeHtml(panelStateText) + '</span>' +
          '<span class="muted">' + panelVersion +
            (updBadge ? ' <span class="pill-badge accent" title="' + escapeHtml(updBadge.title) + '">' + escapeHtml(updBadge.text) + '</span>' : '') +
          '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;">' +
          '<span>↔️ 当前出口：' + escapeHtml(currentRealmText) + ' · 按请求分流：🇨🇳 国内 ' + routeStatus("cn") + ' · 🌐 国际 ' + routeStatus("global") + '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;">' +
          '<span>🎁 签到状态：' + escapeHtml(wbCheckinSummary(accounts)) + '</span>' +
        '</div>' +
        (activityBits && activityBits.travelLine ? (
          '<div style="display:flex;align-items:center;justify-content:space-between;" title="' + escapeHtml(activityBits.note) + '">' +
            '<span>' + escapeHtml(activityBits.travelLine) + '</span>' +
          '</div>'
        ) : '') +
        (schedLine ? (
          '<div style="display:flex;align-items:center;justify-content:space-between;"' +
            (schedLine.title ? ' title="' + escapeHtml(schedLine.title) + '"' : '') + '>' +
            '<span>' + escapeHtml(schedLine.text) + '</span>' +
          '</div>'
        ) : '') +
        (earliestExpiry ? (
          '<div style="color:var(--muted);font-size:0.72rem;border-top:1px dashed var(--border);padding-top:4px;">' +
            '🕒 最近到期：' + escapeHtml(earliestExpiry.name) + ' · 剩 ' + number(earliestExpiry.remain, 2) + ' 点 · 剩余 ' + number(earliestExpiry.days_left, 1) + ' 天' +
          '</div>'
        ) : '') +
      '</div>'
    );

    // 折叠 1：账号分项与积分包（账号直接显示，积分包折叠）
    var domesticAccs = accounts.filter(function (a) { return a.realm === "cn"; });
    var intlAccs = accounts.filter(function (a) { return a.realm === "intl"; });
    var unknownRealmAccs = accounts.filter(function (a) { return a.realm !== "cn" && a.realm !== "intl"; });

    function renderAccountItem(account) {
      var credits = account.credits || {};
      var aRemain = finiteAmount(credits.remain != null ? credits.remain : account.remain);
      var aSize = finiteAmount(credits.size != null ? credits.size : account.size);
      var aUsed = aSize != null && aRemain != null && aSize > 0 ? aSize - aRemain : null;
      var aPct = aUsed != null ? (aUsed / aSize) * 100 : null;
      var aBarPct = aPct == null ? 0 : Math.min(100, Math.max(0, aPct));

      var is429 = wbAccountLimited(account);
      var coolModels = wbCooldownModels(account);
      var errorBadge = is429
        ? pill("429 限流" + (coolModels ? " · " + coolModels : "") + wbCooldownHint(account), "danger")
        : (DP.hasRealError(account.last_error) ? pill("异常", "warning") : "");
      var isDepleted = aRemain != null && aRemain <= 0;

      var earliest = credits.earliest_expiring;
      var expiryStr = earliest
        ? "最近到期包: " + (earliest.name || "个人体验版") + " · 剩 " + number(earliest.remain, 1) + " 点 · 剩余 " + number(earliest.days_left, 1) + " 天"
        : "暂无临期积分包";
      var expiryLeft = DP.expiryLeftText(account.expires_at);

      // 积分包折叠 (账号直接显示，积分包折叠)
      var pkgs = Array.isArray(credits.packages) ? credits.packages : [];
      var pkgAccordion = "";
      if (pkgs.length > 0) {
        var pkgRows = pkgs.map(function (pkg) {
          return (
            '<div class="pkg-row">' +
              '<span class="pkg-row-name">• ' + escapeHtml(pkg.name || "积分包") + '</span>' +
              '<span class="pkg-row-val">' + number(pkg.remain, 1) + ' / ' + number(pkg.size, 1) +
              (pkg.days_left != null ? ' (剩 ' + number(pkg.days_left, 1) + ' 天)' : '') + '</span>' +
            '</div>'
          );
        }).join("");

        pkgAccordion = (
          '<details class="pkg-accordion">' +
            '<summary class="pkg-summary">' +
              '<span>展开 ' + pkgs.length + ' 个积分包明细</span>' +
              '<span class="pkg-chevron">▾</span>' +
            '</summary>' +
            '<div class="pkg-list">' + pkgRows + '</div>' +
          '</details>'
        );
      }

      var isCn = account.realm === "cn";
      var isIntl = account.realm === "intl";
      var realmBadge = isCn ? '<span class="badge-cn">🇨🇳 国内</span>'
        : (isIntl ? '<span class="badge-intl">🌐 国际</span>' : '<span class="pill-badge warning">出口未知</span>');
      var creditClass = "";
      var progressFillClass = DP.barColor(aPct);
      var realmAccounts = accounts.filter(function (a) { return a.realm === account.realm; });
      var realmHasCheckinRecord = realmAccounts.some(function (a) { return typeof a.checkin_done === "boolean"; });
      var checkin = account.checkin_done === true ? pill("已签到", "ok")
        : (account.checkin_done === false ? pill("未签到", "warning")
          : (realmHasCheckinRecord ? pill("未知", "accent") : pill("无记录", "accent")));

      return (
        '<div class="account-card-item">' +
          '<div class="account-card-header">' +
            '<div style="display:flex;align-items:center;gap:6px;">' +
              '<span class="account-card-name">' + escapeHtml(account.nickname || account.masked_uid || "未知账号") + '</span>' +
              realmBadge +
              checkin +
              (isDepleted ? pill("已耗尽", "danger") : (aRemain == null ? pill("额度未知", "warning") : "")) +
              errorBadge +
            '</div>' +
            '<strong style="font-size:0.82rem;font-variant-numeric:tabular-nums;" class="' + creditClass + '">' +
              '已用 ' + (aUsed == null ? "—" : number(aUsed, 2)) + ' / ' + (aSize == null ? "—" : number(aSize, 2) + ' 点') +
              ' <small style="color:var(--muted);font-weight:normal;">(' + (aPct == null ? "—" : aPct.toFixed(1) + '%') + ')</small>' +
            '</strong>' +
          '</div>' +
          '<div class="progress-track"><div class="progress-fill ' + progressFillClass + '" style="width:' + aBarPct.toFixed(1) + '%"></div></div>' +
          '<div class="account-card-sub">' +
            '<span>余 ' + (aRemain == null ? "—" : number(aRemain, 2)) + ' 点 · ' + escapeHtml(expiryStr) + '</span>' +
          '<span>出口: ' + (isCn ? "国内版 (cn)" : (isIntl ? "国际版 (global)" : "未知")) +
              (expiryLeft ? ' · <span title="账号登录凭证，到期前自动续期">凭证到期: ' + escapeHtml(expiryLeft) + '</span>' : '') +
            '</span>' +
          '</div>' +
          wbThrottleLine(account) +
          pkgAccordion +
        '</div>'
      );
    }

    // 有 429 时在账号区上方挂一条汇总告警（账号 · 模型 · 恢复时刻 · 还有多久）；
    // 安静时整条不渲染，不留常驻占位。
    var throttleAlertHtml = accounts.map(wbThrottleLine).filter(Boolean).join("");

    var accountCardsHtml = (
      '<div>' +
        (throttleAlertHtml ? '<div class="throttle-alert">' + throttleAlertHtml + '</div>' : "") +
        '<div class="account-group-title">🇨🇳 国内版账号 (' + domesticAccs.length + ')</div>' +
        domesticAccs.map(renderAccountItem).join("") +
        '<div class="account-group-title">🌐 国际版账号 (' + intlAccs.length + ')</div>' +
        intlAccs.map(renderAccountItem).join("") +
        (unknownRealmAccs.length ? '<div class="account-group-title">出口未知账号 (' + unknownRealmAccs.length + ')</div>' + unknownRealmAccs.map(renderAccountItem).join("") : "") +
      '</div>'
    );

    // 折叠 2：今日用量与性能指标
    var speedStr = today.avg_speed != null ? number(today.avg_speed, 1) + " t/s" : "—";
    var ttftStr = today.avg_ttft != null ? number(today.avg_ttft / 1000, 2) + "s" : "—";
    var modelsToday = today.models_by_realm || today.models || {};
    var modelTagsToday = Object.keys(modelsToday).map(function (k) {
      return '<span class="tag-pill">' + escapeHtml(k) + ' (' + modelsToday[k] + ')</span>';
    }).join("");

    var hourBits = DP.hubHourBits(insights && insights.hours);
    var hourHtml = hourBits ? (
      '<div class="hour-block">' +
        '<div class="hour-bars">' + hourBits.bars.map(function (bar) {
          return '<span class="hour-bar' + (bar.empty ? ' is-empty' : '') + '" style="height:' + bar.pct + '%;" title="' + escapeHtml(bar.title) + '"></span>';
        }).join("") + '</div>' +
        '<div class="hour-axis">' + hourBits.bars.map(function (bar) {
          return '<span>' + escapeHtml(bar.label) + '</span>';
        }).join("") + '</div>' +
        '<div class="price-notes">• ' + escapeHtml(hourBits.note) + '</div>' +
      '</div>'
    ) : "";

    var perfBits = DP.hubPerfBits(insights && insights.perf);
    var perfHtml = perfBits ? (
      '<div class="perf-quantiles">' +
        '<div class="model-window-note">📊 ' + escapeHtml(perfBits.label) + '</div>' +
        perfBits.rows.map(function (row) {
          return '<div class="perf-row"><span>' + escapeHtml(row.label) + '</span><strong>' + escapeHtml(row.value) + '</strong></div>';
        }).join("") +
        (perfBits.note ? '<div class="price-notes">• ' + escapeHtml(perfBits.note) + '</div>' : '') +
      '</div>'
    ) : "";

    var statsHtml = (
      '<div class="kpi-grid" style="margin-bottom:12px;">' +
        '<div class="kpi-tile">' +
          '<span class="kpi-label">今日调用次数</span>' +
          '<strong class="kpi-val">' + (today.requests == null ? "—" : number(today.requests, 0)) + ' 次</strong>' +
          '<span class="kpi-sub kpi-sub-wrap">总 Token ' + wbMetricText(today, "tokens", tokenText) + '</span>' +
        '</div>' +
        '<div class="kpi-tile">' +
          '<span class="kpi-label">消耗积分</span>' +
          '<strong class="kpi-val">' + wbCreditsText(today, 2) + '</strong>' +
          '<span class="kpi-sub kpi-sub-wrap">缓存命中率 ' + percent(wbKnownRatePct(today)) + ' · 积分累计 ' + wbMetricText(today, "credits", function (value) { return number(value, 2); }) + '</span>' +
        '</div>' +
        '<div class="kpi-tile">' +
          '<span class="kpi-label">生成速率</span>' +
          '<strong class="kpi-val">' + speedStr + '</strong>' +
          '<span class="kpi-sub">首字耗时 ' + ttftStr + '</span>' +
        '</div>' +
        '<div class="kpi-tile">' +
          '<span class="kpi-label">近 7 天总计</span>' +
          '<strong class="kpi-val">' + (week.requests == null ? "—" : number(week.requests, 0)) + ' 次</strong>' +
          '<span class="kpi-sub kpi-sub-wrap">Token ' + wbMetricText(week, "tokens", tokenText) + ' · 积分 ' + wbCreditsText(week, 1) + '</span>' +
        '</div>' +
      '</div>' +
      '<div style="font-size:0.75rem;color:var(--text);border-top:1px dashed var(--border);padding-top:8px;">' +
        '<div style="font-weight:600;margin-bottom:4px;">今日调用模型分布：</div>' +
        '<div class="tag-cloud">' + (modelTagsToday || '<span class="muted">无记录</span>') + '</div>' +
      '</div>' +
      hourHtml +
      perfHtml
    );

    // 折叠（新增）：模型消耗排行（近 7 天）——与 Codex 同类块对齐
    var wbRecent7Set = {};
    DP.recentBjDates(7).forEach(function (d) { wbRecent7Set[d] = true; });
    var wbModelRows = DP.wbModelUsageRows((usage || {}).daily || [], wbRecent7Set);
    var wbVisibleModelRows = wbModelRows.filter(function (row) { return row.realm === "cn" || row.realm === "intl"; });
    var wbUnknownModelNote = wbUnknownRealmNote(wbModelRows);
    var wbModelRowHtml = wbVisibleModelRows.map(function (row) {
      // 流量行：单值（样本不全时加 ≥ 下界）；不展示拆分。
      var flowStr = wbModelTokenText(row);
      // 折算金额（官网价口径）：全计价显示金额；有未计价行加 ≥；从未计价显示「未计价」。
      var usdText = row.usd == null ? "未计价" : (row.usdPartial ? "≥" : "") + money(row.usd);
      var realmBadge = row.realm === "cn" ? '<span class="badge-cn">🇨🇳 国内</span>'
        : (row.realm === "intl" ? '<span class="badge-intl">🌐 国际</span>' : '<span class="pill-badge warning">出口未知</span>');
      var realmClass = row.realm === "cn" ? "credit-cn" : (row.realm === "intl" ? "credit-intl" : "");
      return (
        '<div class="model-row">' +
          '<div class="model-row-head">' +
            '<span class="model-name">' + escapeHtml(row.model) + ' ' +
              realmBadge +
            '</span>' +
            '<span class="model-cost ' + realmClass + '" style="text-align:right;">' +
              wbModelCreditsText(row, 2) + ' 积分<br>' +
              '<span style="font-size:0.7rem;color:var(--muted);font-weight:600;" title="按各厂商官网价折算的 API 等值（近 7 天窗口）">' + usdText + '</span>' +
            '</span>' +
          '</div>' +
          '<div class="model-tokens">' + number(row.calls, 0) + ' 次调用' + (flowStr ? ' · ' + flowStr : '') + '</div>' +
        '</div>'
      );
    }).join("");
    // 起止时间：近 7 天窗口内实际有数据的首末日期
    var wbRangeDays = ((usage || {}).daily || [])
      .map(function (d) { return d && d.day; })
      .filter(function (d) { return d && wbRecent7Set[d]; })
      .sort();
    var wbWindowNote = wbRangeDays.length
      ? '<div class="model-window-note">🕒 起止时间：' + wbRangeDays[0].slice(5) + ' ~ ' + wbRangeDays[wbRangeDays.length - 1].slice(5) + '</div>'
      : "";
    var keyLine = DP.keyUsageLine((usage || {}).by_key);
    var wbModelHtml = (
      wbWindowNote +
      '<div class="models-list">' + (wbModelRowHtml || '<p class="muted">近 7 天暂无可排行的模型调用</p>') + '</div>' +
      wbUnknownModelNote +
      (keyLine ? '<div class="price-notes">• 按 Key（今日）：' + escapeHtml(keyLine) + '</div>' : '') +
      '<div class="price-notes">• 近 7 天窗口（按可用日期）；按消耗积分降序；国内/国际分列。</div>'
    );

    // 「刷新积分」按钮（「账号分项与积分包」标题行右侧）：点击后请求 Hub POST /accounts/credits
    // 新全部账号积分（约 17 秒）；按钮状态由 wbPointsRefreshing 驱动，重画不失真。
    var wbPointsRefreshBtn = wbPointsRefreshBtnHtml();

    // 折叠：最近请求（Hub /usage/recent，最近 8 条）。没有数据就整块不出现。
    var recentRows = DP.hubRecentRows(insights && insights.recent);
    var recentHtml = recentRows ? (
      '<div class="recent-list">' + recentRows.map(function (row) {
        return '<div class="recent-row">' +
          '<span class="recent-time">' + escapeHtml(row.clock) + '</span>' +
          '<span class="recent-model">' + escapeHtml(row.model) + '</span>' +
          '<span class="recent-acct">' + escapeHtml(row.account) + '</span>' +
          '<span class="recent-meta">' + escapeHtml(row.meta) + '</span>' +
          '<strong class="recent-credit' + (row.failed ? ' is-failed' : '') + '">' +
            (row.failed ? '失败' : escapeHtml(row.credit)) + '</strong>' +
        '</div>';
      }).join("") + '</div>' +
      '<div class="price-notes">• 最近 8 条（模型 · 账号 · 档位 · 首字耗时 · 积分）</div>'
    ) : "";

    // 折叠：任务与福利（Hub /tasks，默认账号）。没有数据就整块不出现。
    var taskBits = DP.hubTaskBits(insights && insights.tasks);
    var tasksHtml = taskBits ? (
      '<div class="kpi-grid" style="margin-bottom:10px;">' +
        '<div class="kpi-tile">' +
          '<span class="kpi-label">连续打卡</span>' +
          '<strong class="kpi-val">' + escapeHtml(taskBits.streak) + '</strong>' +
          '<span class="kpi-sub">补签卡 ' + escapeHtml(taskBits.cards) + ' 张</span>' +
        '</div>' +
        '<div class="kpi-tile">' +
          '<span class="kpi-label">能量</span>' +
          '<strong class="kpi-val">' + escapeHtml(taskBits.energy) + '</strong>' +
          '<span class="kpi-sub">抽奖 ' + escapeHtml(taskBits.lottery) + ' 次</span>' +
        '</div>' +
        '<div class="kpi-tile">' +
          '<span class="kpi-label">任务领取</span>' +
          '<strong class="kpi-val">' + escapeHtml(taskBits.claimedTasks) + ' / ' + escapeHtml(taskBits.taskCount) + '</strong>' +
          '<span class="kpi-sub">已领 / 任务数</span>' +
        '</div>' +
        '<div class="kpi-tile">' +
          '<span class="kpi-label">等级进度</span>' +
          '<strong class="kpi-val" style="font-size:1rem;">' + escapeHtml(taskBits.tiers[0] || "—") + '</strong>' +
          '<span class="kpi-sub kpi-sub-wrap">' + escapeHtml(taskBits.tiers.slice(1).join(" · ") || "—") + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="price-notes">• ' + escapeHtml(taskBits.note) +
        (taskBits.travel ? ' · ' + escapeHtml(taskBits.travel) : '') + '</div>'
    ) : "";

    // 折叠：今日签到 / 猫猫旅行（Hub 活动历史 + 调度器日志环）。没有数据整块不出现。
    var activityHtml = activityBits ? (
      '<div class="price-notes" style="margin-bottom:6px;">• ' + escapeHtml(activityBits.summary) + '</div>' +
      (activityBits.rows.length ? activityBits.rows.map(function (row) {
        return '<div style="display:flex;gap:8px;align-items:baseline;font-size:0.75rem;padding:3px 0;border-top:1px dashed var(--border);">' +
          '<span class="muted" style="flex:none;width:56px;">' + escapeHtml(row.clock || "—") + '</span>' +
          '<span style="flex:none;width:118px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHtml(row.account || "") + '">' + escapeHtml(row.account || "—") + '</span>' +
          '<span class="muted" style="flex:none;">' + escapeHtml(row.tag || "") + '</span>' +
          '<span style="flex:1;">' + escapeHtml(row.text || "") + '</span>' +
        '</div>';
      }).join("") : "") +
      '<div class="price-notes" style="margin-top:6px;">• ' + escapeHtml(activityBits.note) + '</div>'
    ) : "";

    html.push(
      '<div class="accordion-group">' +
        accordion("账号分项与积分包", String(accounts.length), accountCardsHtml, true, wbPointsRefreshBtn) +
        (taskBits ? accordion("任务与福利", taskBits.badge, tasksHtml, false) : "") +
        (activityBits ? accordion("今日签到 / 猫猫旅行", activityBits.badge, activityHtml, false) : "") +
        (recentRows ? accordion("最近请求", String(recentRows.length), recentHtml, false) : "") +
        accordion("模型消耗排行", String(wbVisibleModelRows.length), wbModelHtml, true) +
        accordion("今日用量与性能指标", "", statsHtml, false) +
      '</div>'
    );

    // 联动诊断告警（按用户要求置于最底部）
    var warnings = Array.isArray(data && data.warnings) ? data.warnings : [];
    var staticWarnings = warnings.filter(function (warn) { return DP.isStaticDataCaveat(warn); });
    var dynamicWarnings = warnings.filter(function (warn) { return !DP.isStaticDataCaveat(warn); });
    if (staticWarnings.length) {
      html.push('<div class="muted" style="font-size:0.72rem;margin-top:8px;" title="' +
        escapeHtml(staticWarnings.join("；")) + '">ⓘ 部分样本缺失：带 ≥ 的为下界值（明细悬停）</div>');
    }
    dynamicWarnings.forEach(function (warn) {
      html.push('<div style="margin-top:10px;">' + callout("warning", "⚠️", "WorkBuddy 数据说明", warn) + '</div>');
    });

    return html.join("");
  }

  // 3. 渲染 MUSE 卡片（经 mini 用量桥：免费额度 / 转录次数 / VM 状态）
  function renderMuse(data) {
    if (!data || data.ok !== true) {
      var reason = data && data.error ? String(data.error) : "桥未返回有效数据";
      return callout("info", "ℹ️", "Muse 数据暂不可用", reason + "，可稍后点右上角刷新重试。");
    }
    var weeklyUsed = data.weekly_used_pct != null ? Number(data.weekly_used_pct) : null;
    var weeklyRemain = weeklyUsed != null ? Math.max(0, Math.min(100, 100 - weeklyUsed)) : null;
    var extraUsed = data.extra_tokens_used_pct != null ? Number(data.extra_tokens_used_pct) : null;
    var extraRemain = extraUsed != null ? Math.max(0, Math.min(100, 100 - extraUsed)) : null;
    var tTotal = Number(data.transcript_total);
    var tRemain = Number(data.transcript_remaining);
    var reportedTUsed = data.transcript_used != null ? Number(data.transcript_used) : NaN;
    var tHas = isFinite(tTotal) && tTotal > 0 && (isFinite(tRemain) || isFinite(reportedTUsed));
    var tUsed = tHas ? (isFinite(reportedTUsed) ? reportedTUsed : Math.max(0, tTotal - tRemain)) : null;
    if (tHas && !isFinite(tRemain)) tRemain = Math.max(0, tTotal - tUsed);
    var tPct = tHas ? Math.max(0, Math.min(100, (tUsed / tTotal) * 100)) : null;
    var planShort = data.plan ? String(data.plan).split("（")[0] : "额度";

    // 更新首页总览预览卡片（周额度 / 转录两条进度条）
    var preBars = document.getElementById("preview-muse-bars");
    var preTag = document.getElementById("preview-muse-tag");
    var preHint = document.getElementById("preview-muse-foot-hint");
    if (preTag) preTag.textContent = planShort;
    if (preHint) {
      preHint.textContent = (tHas ? "转录已用 " + number(tUsed, 0) + "/" + number(tTotal, 0) + " 次 · " : "") + "点击查看额度与 VM 状态 →";
    }
    if (preBars) {
      var bars = [];
      if (weeklyUsed != null) {
        bars.push(previewBarItem(
          "周免费额度",
          "已用 " + percent(weeklyUsed) + " (余 " + percent(weeklyRemain) + ")",
          weeklyUsed,
          data.weekly_resets_at_text ? "重置：" + DP.museResetCn(data.weekly_resets_at_text) : ""
        ));
      } else {
        bars.push(previewBarItem("周免费额度", "—", 0, "暂无数据"));
      }
      if (tHas) {
        bars.push(previewBarItem(
          "转录取稿额度",
          "已用 " + number(tUsed, 0) + " / " + number(tTotal, 0) + " 次 (" + percent(tPct) + ")",
          tPct,
          "余 " + number(tRemain, 0) + " 次 · 本地台账计数 · 每次成功取稿自动记账"
        ));
      }
      preBars.innerHTML = bars.join("");
    }

    var html = [];
    var gen = data.generated_at ? String(data.generated_at) : "";
    html.push(
      '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:0.78rem;margin-bottom:10px;">' +
        '<span>档位：' + escapeHtml(data.plan || "未知") + '</span>' +
        (gen.length >= 16 ? '<span>数据生成：' + escapeHtml(gen.slice(5, 16).replace("T", " ")) + '</span>' : "") +
      '</div>'
    );

    html.push(
      '<div class="gauge-card">' +
        '<div class="gauge-card-header">' +
          '<span class="gauge-title">周免费额度</span>' +
          '<strong class="gauge-value">已用 ' + (weeklyUsed != null ? percent(weeklyUsed) : "—") + '</strong>' +
        '</div>' +
        progressBar(weeklyUsed != null ? weeklyUsed : 0) +
        '<div class="gauge-footer">' +
          '<span>' + (weeklyUsed != null ? "已用 " + percent(weeklyUsed) + " · 剩余 " + percent(weeklyRemain) : "暂无数据") + '</span>' +
          (data.weekly_resets_at_text ? '<span>重置：' + escapeHtml(DP.museResetCn(data.weekly_resets_at_text)) + '</span>' : "") +
        '</div>' +
      '</div>'
    );

    html.push(
      '<div class="gauge-card">' +
        '<div class="gauge-card-header">' +
          '<span class="gauge-title">额外 token 包</span>' +
          '<strong class="gauge-value">已用 ' + (extraUsed != null ? percent(extraUsed) : "—") + '</strong>' +
        '</div>' +
        progressBar(extraUsed != null ? extraUsed : 0) +
        '<div class="gauge-footer">' +
          '<span>' + (extraUsed != null ? "已用 " + percent(extraUsed) + " · 剩 " + escapeHtml(data.extra_tokens_left_text || "—") : "暂无数据") + '</span>' +
        '</div>' +
      '</div>'
    );

    html.push(
      '<div class="gauge-card">' +
        '<div class="gauge-card-header">' +
          '<span class="gauge-title">转录取稿额度（免费）</span>' +
          '<strong class="gauge-value">已用 ' + (tPct != null ? percent(tPct) : "—") + '</strong>' +
        '</div>' +
        progressBar(tPct != null ? tPct : 0) +
        '<div class="gauge-footer">' +
          '<span>' + (tHas ? "已用 " + number(tUsed, 0) + "/" + number(tTotal, 0) + " 次 · 余 " + number(tRemain, 0) + " 次" : "暂无数据") + '</span>' +
        '</div>' +
      '</div>'
    );

    var vm = data.vm || {};
    var vmItems = [];
    if (vm.cpu) vmItems.push("🖥️ CPU：" + vm.cpu);
    if (vm.load) vmItems.push("📊 负载：" + vm.load);
    if (vm.mem) vmItems.push("🧠 内存：" + vm.mem);
    if (vm.disk) vmItems.push("💾 磁盘：" + vm.disk);
    if (vm.uptime) vmItems.push("⏱️ 已开机：" + vm.uptime);
    html.push(accordion(
      "VM 状态（Muse 所在虚机）",
      "",
      vmItems.length
        ? vmItems.map(function (line) {
            return '<div style="padding:3px 0;font-size:0.84rem;">' + escapeHtml(line) + '</div>';
          }).join("")
        : '<div style="padding:3px 0;color:var(--muted);font-size:0.84rem;">暂无数据</div>',
      true
    ));

    html.push(
      '<div style="margin-top:12px;color:var(--muted);font-size:0.74rem;line-height:1.7;">' +
        '• 数据与 VM 侧「/token」同源统计，经 mini 用量桥回传；转录取稿为本地台账口径（官方无余额接口）。' +
      '</div>'
    );

    return html.join("");
  }

  // ===== agy（Antigravity CLI）额度：官方 /usage 双模型池（Gemini / Claude·GPT） =====

  function renderAgy(data) {
    var preBars = document.getElementById("preview-agy-bars");
    if (!data || data.ok !== true) {
      var reason = data && data.error ? String(data.error) : "命令未返回有效数据";
      if (preBars) preBars.innerHTML = '<div class="preview-bar-placeholder">数据暂不可用</div>';
      return callout("info", "ℹ️", "Antigravity 数据暂不可用", reason + "，可稍后点右上角刷新重试。");
    }
    var pools = Array.isArray(data.pools) ? data.pools : [];

    function shortWindow(label) {
      var text = String(label || "");
      if (text.indexOf("5") >= 0 && text.indexOf("小时") >= 0) return "5h";
      if (text.indexOf("周") >= 0) return "周";
      return text;
    }
    function shortReset(value) {
      return DP.agyResetCn(value).replace("（北京时间）", "");
    }
    // 标签行用短时间：当天只给 HH:MM，跨天给 MM-DD HH:MM。
    function shortResetInline(value) {
      var text = shortReset(value);
      var match = text.match(/(\d{1,2})月(\d{1,2})日\s*(\d{2}:\d{2})/);
      if (!match) return text;
      var bj = new Date(Date.now() + 8 * 3600 * 1000);
      var today = bj.getUTCMonth() + 1 + "月" + bj.getUTCDate() + "日";
      var target = Number(match[1]) + "月" + Number(match[2]) + "日";
      if (target === today) return match[3];
      return String(match[1]).padStart(2, "0") + "-" + String(match[2]).padStart(2, "0") + " " + match[3];
    }

    // 首页总览预览卡片：每个模型池一条进度条（取该池中剩余更低的窗口作主条）
    if (preBars) {
      var bars = [];
      pools.forEach(function (pool) {
        var poolLabel = pool.label || pool.name || "模型池";
        var windows = Array.isArray(pool.windows) ? pool.windows.filter(function (w) { return w.remaining_pct != null; }) : [];
        if (!windows.length) return;
        // 主条固定 5h，周额度放副行；5h 缺失时退回第一个可用窗口。
        var main = windows.find(function (w) { return w.key === "five_hour"; }) || windows[0];
        var weekly = windows.find(function (w) { return w.key === "weekly"; }) || null;
        var remain = Math.max(0, Math.min(100, Number(main.remaining_pct)));
        var used = 100 - remain;
        var subText = "";
        var subTone = "";
        var subTitle = "";
        if (weekly) {
          var weekRemain = Math.max(0, Math.min(100, Number(weekly.remaining_pct)));
          subText = shortWindow(weekly.label) + " 已用 " + percent(100 - weekRemain) +
            "（余 " + percent(weekRemain) + "）";
          if (weekly.resets_at) subText += " · " + shortResetInline(weekly.resets_at) + " 重置";
          // 周额度小圆点常驻三色：健康绿、10–20% 黄、≤10% 红。
          if (weekRemain <= 10) {
            subTone = "danger";
            subTitle = "周额度剩余 " + percent(weekRemain) + "（≤10%）";
          } else if (weekRemain <= 20) {
            subTone = "warning";
            subTitle = "周额度剩余 " + percent(weekRemain) + "（≤20%）";
          } else {
            subTone = "ok";
            subTitle = "周额度剩余 " + percent(weekRemain) + "（健康）";
          }
        }
        var windowTag = main.label ? " · " + shortWindow(main.label) : "";
        if (main.resets_at) windowTag += "（" + shortResetInline(main.resets_at) + " 重置）";
        bars.push(previewBarItem(
          String(poolLabel).replace(" 模型池", "") + windowTag,
          "已用 " + percent(used) + " (余 " + percent(remain) + ")",
          used,
          subText,
          null,
          subTone,
          subTitle
        ));
      });
      preBars.innerHTML = bars.length ? bars.join("") : '<div class="preview-bar-placeholder">暂无数据</div>';
    }

    var html = [];
    var gen = data.generated_at ? String(data.generated_at) : "";
    html.push(
      '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:0.78rem;margin-bottom:10px;">' +
        '<span>账号：Antigravity CLI · Google AI Pro（5 TB） · 续订：2027年5月18日</span>' +
        (gen.length >= 16 ? '<span>数据生成：' + escapeHtml(gen.slice(5, 16).replace("T", " ")) + '</span>' : "") +
      '</div>'
    );

    var rows = 0;
    pools.forEach(function (pool) {
      var poolLabel = pool.label || pool.name || "模型池";
      (Array.isArray(pool.windows) ? pool.windows : []).forEach(function (w) {
        rows += 1;
        var remain = w.remaining_pct != null ? Math.max(0, Math.min(100, Number(w.remaining_pct))) : null;
        var used = remain != null ? 100 - remain : null;
        html.push(
          '<div class="gauge-card">' +
            '<div class="gauge-card-header">' +
              '<span class="gauge-title">' + escapeHtml(poolLabel + " · " + (w.label || "额度")) + '</span>' +
              '<strong class="gauge-value">已用 ' + (used != null ? percent(used) : "—") + '</strong>' +
            '</div>' +
            progressBar(used != null ? used : 0) +
            '<div class="gauge-footer">' +
              '<span>' + (remain != null ? "已用 " + percent(100 - remain) + " · 剩余 " + percent(remain) : "暂无数据") + '</span>' +
              (w.resets_at ? '<span>重置：' + escapeHtml(DP.agyResetCn(w.resets_at)) + '</span>' : "") +
            '</div>' +
          '</div>'
        );
      });
    });
    if (!rows) {
      return callout("info", "ℹ️", "Antigravity 暂无额度数据", "命令返回的额度表为空，可刷新重试。");
    }

    html.push('<div class="anchor-host" data-anchor-block="agy"></div>');

    html.push(
      '<div style="margin-top:12px;color:var(--muted);font-size:0.74rem;line-height:1.7;">' +
        '• 官方 /usage 口径（Antigravity CLI 直查，只读）；按模型池分组，5 小时与周窗口独立计算；重置时间为北京时间。' +
      '</div>'
    );

    return html.join("");
  }

  // 全网搜索（Tavily）：已并入「本机 Mac」卡，数据到达后重绘卡内的小字行。
  function renderTavily(data) {
    if (payloadCache.mac) renderMac(payloadCache.mac);
    return "";
  }

  // 本机 Mac：只更新首页迷你卡（无详情页）；磁盘/内存各一条（剩余语义），条下给传感器一行。
  function renderMac(data) {
    var barsEl = document.getElementById("preview-mac-bars");
    if (!barsEl) return "";
    var view = DP.macView(data);
    if (!view) {
      barsEl.innerHTML = '<div class="preview-bar-placeholder">数据暂不可用</div>';
      return "";
    }
    var html = "";
    if (view.warn) {
      html += '<div class="throttle-alert mac-warn">⚠ ' + escapeHtml(view.warnText) + '</div>';
    }
    html += previewBarItem(view.disk.label, view.disk.value, view.disk.pct, view.sensors, view.disk.color || view.disk.barColor);
    html += previewBarItem(view.mem.label, view.mem.value, view.mem.pct);
    barsEl.innerHTML = html;

    // 全网搜索（Tavily）已并入本卡：一行小字，不再占独立卡位。
    var tavily = payloadCache.tavily;
    if (tavily && tavily.ok === true) {
      var tavilyKeys = Array.isArray(tavily.keys) ? tavily.keys.filter(function (k) { return !!k; }) : [];
      var activeTavily = null;
      for (var ti = 0; ti < tavilyKeys.length; ti += 1) {
        if (tavilyKeys[ti].active === true) { activeTavily = tavilyKeys[ti]; break; }
      }
      if (activeTavily) {
        tavilyKeys = [activeTavily].concat(tavilyKeys.filter(function (k) { return k !== activeTavily; }));
      }
      if (tavilyKeys.length) {
        barsEl.insertAdjacentHTML(
          "beforeend",
          '<div class="preview-note-sub" id="preview-mac-tavily">' +
            escapeHtml("全网搜索 " + tavilyKeys.map(function (k) { return DP.tavilyKeyLine(k, k.active === true); }).join(" ｜ ")) +
          '</div>'
        );
      }
    }

    var hint = document.getElementById("preview-mac-foot-hint");
    if (hint) {
      if (view.warrantyText) {
        hint.textContent = view.foot + " · " + view.warrantyText;
        hint.title = view.foot + " · " + view.warrantyText;
      } else {
        hint.textContent = view.foot;
      }
    }
    var tag = document.getElementById("preview-mac-tag");
    var health = DP.macHealthScore(data);
    if (tag) {
      if (health) {
        tag.textContent = "健康 " + health.score;
        tag.className = "preview-tag health-" + health.tone;
        tag.title = health.level + " · 本看板自定义口径，不是 Apple 官方评分";
      } else if (data.host && data.host.chip) {
        tag.textContent = String(data.host.chip).replace("Apple ", "");
        tag.className = "preview-tag";
      }
    }
    return "";
  }

  // 本机 Mac 详情页：4 张状态卡（当前值 + 参考区间 + 正常/注意/偏高）+ 明细行。
  function renderMacDetail(data) {
    var detail = DP.macDetail(data);
    if (!detail) {
      return callout("info", "ℹ️", "Mac 数据暂不可用", "mac_status.py 未返回有效数据，可稍后刷新重试。");
    }
    var html = [];
    html.push(
      '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:0.78rem;margin-bottom:10px;">' +
        '<span>' + escapeHtml(detail.header) + '</span>' +
        (detail.warranty ? '<span>' + escapeHtml(detail.warranty) + '</span>' : "") +
        (detail.generated ? '<span>数据时间：' + escapeHtml(detail.generated) + '</span>' : "") +
      '</div>'
    );

    var health = DP.macHealthScore(data);
    if (health) {
      var breakdown = health.items.map(function (it) {
        return '<div class="health-row' + (it.points > 0 ? ' is-deduct' : '') + '">' +
          '<span class="health-label">' + escapeHtml(it.label) + '</span>' +
          '<span class="health-detail">' + escapeHtml(it.detail) + '</span>' +
          '<span class="health-points">' + (it.points > 0 ? '−' + it.points : '—') + '</span>' +
        '</div>';
      }).join("");
      html.push(
        '<div class="gauge-card health-card">' +
          '<div class="gauge-card-header">' +
            '<span class="gauge-title">健康分</span>' +
            '<strong class="gauge-value">' + health.score + ' · ' + escapeHtml(health.level) + '</strong>' +
          '</div>' +
          '<div class="health-breakdown">' + breakdown + '</div>' +
          '<div class="health-note">本看板自定义口径（磁盘 / 内存 / 温度 / 风扇 / 负载 / SMART / 内核崩溃），不是 Apple 官方评分；SMART 异常直接判 0 分。</div>' +
        '</div>'
      );
    }

    detail.tiles.forEach(function (t) {
      var toneClass = t.tone === "ok" ? "ok" : (t.tone === "warn" ? "stale" : "error");
      var toneText = t.tone === "ok" ? "正常" : (t.tone === "warn" ? "注意" : "偏高");
      html.push(
        '<div class="gauge-card">' +
          '<div class="gauge-card-header">' +
            '<span class="gauge-title">' + escapeHtml(t.label) + '</span>' +
            '<strong class="gauge-value">' + escapeHtml(t.value) + '</strong>' +
          '</div>' +
          (t.pct != null ? progressBar(t.pct, t.color || t.barColor) : "") +
          '<div class="gauge-footer">' +
            '<span>' + escapeHtml(t.sub) + '</span>' +
            '<span class="badge-status ' + toneClass + '">' + toneText + '</span>' +
          '</div>' +
          '<div style="margin-top:6px;color:var(--muted);font-size:0.72rem;line-height:1.55;">参考：' + escapeHtml(t.range) + '</div>' +
        '</div>'
      );
    });

    var prevMemOpen = false;
    var prevDiskOpen = false;
    var existingDetails = document.querySelectorAll("#mac-card details.accordion");
    if (existingDetails && existingDetails.length) {
      existingDetails.forEach(function (d) {
        var summary = d.querySelector("summary");
        if (!summary) return;
        if (summary.textContent.indexOf("内存 Top 10") !== -1) prevMemOpen = !!d.open;
        if (summary.textContent.indexOf("磁盘 Top 10") !== -1) prevDiskOpen = !!d.open;
      });
    }

    var accordionsHtml = [];
    if (detail.topMemory) {
      var memBody = detail.topMemory.map(function (line) {
        return '<div class="mac-top-row" title="' + escapeHtml(line) + '">' + escapeHtml(line) + '</div>';
      }).join("");
      accordionsHtml.push(accordion("内存 Top 10", "", memBody, prevMemOpen));
    }
    if (detail.diskTop) {
      var diskBody = detail.diskTop.items.map(function (line) {
        return '<div class="mac-top-row" title="' + escapeHtml(line) + '">' + escapeHtml(line) + '</div>';
      }).join("") +
      (detail.diskTop.note ? '<div class="mac-top-note">' + escapeHtml(detail.diskTop.note) + '</div>' : "");
      accordionsHtml.push(accordion("磁盘 Top 10", "", diskBody, prevDiskOpen));
    }
    if (accordionsHtml.length) {
      html.push('<div class="accordion-group">' + accordionsHtml.join("") + '</div>');
    }

    if (detail.rows.length) {
      html.push(
        '<div style="margin-top:14px;border-top:1px solid var(--border);">' +
          detail.rows.map(function (r) {
            return '<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:7px 0;border-bottom:1px solid var(--border);font-size:0.8rem;">' +
              '<span style="color:var(--muted);">' + escapeHtml(r.label) + '</span>' +
              '<span style="text-align:right;">' + escapeHtml(r.value) +
                (r.note ? '<span style="display:block;color:var(--muted);font-size:0.7rem;">' + escapeHtml(r.note) + '</span>' : "") +
              '</span>' +
            '</div>';
          }).join("") +
        '</div>'
      );
    }

    html.push(
      '<div style="margin-top:12px;color:var(--muted);font-size:0.74rem;line-height:1.7;">' +
        detail.notes.map(function (n) { return "• " + escapeHtml(n); }).join("<br>") +
      '</div>'
    );
    return html.join("");
  }

  // ===== 详情页下方「模型价格」折叠（三个页面共用；排序按常用度=窗口内调用数） =====

  function rateText(value) {
    if (value == null || value === "") return "—";
    var n = Number(value);
    if (!isFinite(n)) return "—";
    return String(n);
  }

  function renderPriceSections(cache) {
    ["codex", "wb"].forEach(function (key) {
      var host = document.getElementById(key + "-price-section");
      if (!host) return;
      var data = cache && cache[key];
      if (!data) return;
      var built = buildPriceSection(key, data);
      if (!built) { host.innerHTML = ""; return; }
      // 轮询重画时保留用户已展开的状态
      var prev = host.querySelector("details");
      var open = prev ? !!prev.open : false;
      host.innerHTML = accordion(built.title, built.badge, built.body, open);
    });
  }

  function buildPriceSection(key, data) {
    if (key === "codex") return buildCodexPriceSection(data);
    return buildWbPriceSection(data);
  }

  function buildCodexPriceSection(data) {
    var pricing = data && data.pricing || {};
    var mp = pricing.model_pricing || {};
    var models = mp.models || {};
    var ids = Object.keys(models);
    if (!ids.length) return null;
    var total = data && data.total || {};
    var usage = total.model_usage || {};
    var calls = {};
    Object.keys(usage).forEach(function (m) {
      calls[m] = Number(usage[m] && usage[m].api_calls) || 0;
    });
    var ordered = DP.usageFirstOrder(ids, calls);
    var rows = ordered.map(function (id) {
      var ent = models[id] || {};
      var cur = ent.current || {};
      var bits = [];
      if (cur.input_usd_per_1m != null) bits.push("输入 $" + rateText(cur.input_usd_per_1m));
      if (cur.cached_input_usd_per_1m != null) bits.push("缓存输入 $" + rateText(cur.cached_input_usd_per_1m));
      if (cur.cache_write_usd_per_1m != null) bits.push("缓存写 $" + rateText(cur.cache_write_usd_per_1m));
      if (cur.output_usd_per_1m != null) bits.push("输出 $" + rateText(cur.output_usd_per_1m));
      var promoHtml = "";
      if (ent.mode === "promotional" && ent.standard) {
        var st = ent.standard;
        var stBits = [];
        if (st.input_usd_per_1m != null) stBits.push("输入 $" + rateText(st.input_usd_per_1m));
        if (st.cached_input_usd_per_1m != null) stBits.push("缓存输入 $" + rateText(st.cached_input_usd_per_1m));
        if (st.cache_write_usd_per_1m != null) stBits.push("缓存写 $" + rateText(st.cache_write_usd_per_1m));
        if (st.output_usd_per_1m != null) stBits.push("输出 $" + rateText(st.output_usd_per_1m));
        promoHtml = '<div class="model-tokens" style="color:var(--amber);">促销价生效中；标准价：' + stBits.join(" · ") + '</div>';
      }
      return (
        '<div class="model-row">' +
          '<div class="model-row-head">' +
            '<span class="model-name">' + escapeHtml(id) + '</span>' +
            '<span class="model-cost" style="color:var(--muted);">' + escapeHtml(ent.label || "") + '</span>' +
          '</div>' +
          '<div class="model-tokens">' + bits.join(" · ") + '（USD / 1M tokens）</div>' +
          promoHtml +
        '</div>'
      );
    }).join("");
    var notes = ["价格为 OpenAI 官方价目（原价，不折算）"];
    if (pricing.sol_mode === "promotional" && pricing.sol_promotion_end_date_bj) {
      notes.push("GPT-5.6 Sol 促销价至 " + pricing.sol_promotion_end_date_bj +
        (pricing.sol_standard_restored_from_date_bj ? "（" + pricing.sol_standard_restored_from_date_bj + " 起恢复标准价）" : ""));
    }
    notes.push("长上下文：单请求输入 >272K 时 输入/缓存 ×2、输出 ×1.5；6.1 Sol 订阅 included allowance 的额外 Credits 为 0");
    return {
      title: "模型价格（按常用排序）",
      badge: ordered.length + " 款",
      body: '<div class="models-list">' + rows + '</div><div class="price-notes">' +
        notes.map(function (n) { return "• " + escapeHtml(n); }).join("<br>") + '</div>',
    };
  }

  function buildWbPriceSection(data) {
    var pricing = data && data.pricing || {};
    var models = pricing.models || {};
    var ids = Object.keys(models);
    if (!ids.length) return null;
    var daySet = {};
    DP.recentBjDates(7).forEach(function (d) { daySet[d] = true; });
    var usageRows = DP.wbModelUsageRows((data.usage || {}).daily || [], daySet);
    var calls = {};
    usageRows.forEach(function (r) { calls[r.model] = (calls[r.model] || 0) + r.calls; });
    var ordered = DP.usageFirstOrder(ids, calls);
    var rows = ordered.map(function (id) {
      var ent = models[id] || {};
      var block = DP.wbPriceBlock(ent);
      var vendor = ent.vendor ? ' <span class="tag-pill">' + escapeHtml(ent.vendor) + '</span>' : "";
      var lines = (block.lines || []).map(function (l) {
        return '<div class="model-tokens">' + escapeHtml(l) + '</div>';
      }).join("");
      var notes = (block.notes || []).length
        ? '<div class="price-note">' + block.notes.map(function (n) { return "· " + escapeHtml(n); }).join("<br>") + '</div>'
        : "";
      return (
        '<div class="model-row">' +
          '<div class="model-row-head">' +
            '<span class="model-name">' + escapeHtml(id) + vendor + '</span>' +
          '</div>' +
          lines + notes +
        '</div>'
      );
    }).join("");
    var footNotes = [
      "各厂商官网价，原样币种（USD / CNY），不折算" + (pricing.updated_at ? "；更新于 " + pricing.updated_at : ""),
      "峰谷、长短档与限时促销按官网原样标注",
    ];
    return {
      title: "模型价格（按常用排序）",
      badge: ordered.length + " 款",
      body: '<div class="models-list">' + rows + '</div><div class="price-notes">' +
        footNotes.map(function (n) { return "• " + escapeHtml(n); }).join("<br>") + '</div>',
    };
  }

  // 窗口保活块（Codex / Antigravity 详情内；数据来自 anchors 源；单一实现填充两处占位）
  function updateAnchorBlocks() {
    ["codex", "agy"].forEach(function (k) {
      var host = document.querySelector('[data-anchor-block="' + k + '"]');
      if (!host) return;
      host.innerHTML = anchorBlockHtml(k, payloadCache.anchors);
    });
  }

  function anchorBlockHtml(scriptKey, anchors) {
    if (!anchors || anchors.ok !== true) return "";
    var scripts = anchors.scripts || {};
    var segment = scripts[scriptKey];
    if (!segment) return "";
    var status = DP && DP.anchorStatus ? DP.anchorStatus(segment) : { text: "", tone: "accent" };
    var rows = (Array.isArray(segment.targets) ? segment.targets : []).map(function (t) {
      var recent = t && (t.last_success_text || t.last_fire_text) ? (t.last_success_text || t.last_fire_text) : "—";
      var next = t && t.next_fire_text ? t.next_fire_text : "—";
      var title = "失败计数 " + ((t && t.tries) || 0) +
        " · 最近成功 " + ((t && t.last_success_text) || "无") +
        ((t && t.retry_after_text) ? " · 重试定于 " + t.retry_after_text : "");
      return (
        '<div class="anchor-row" title="' + escapeHtml(title) + '">' +
          '<span class="anchor-target">' + escapeHtml((t && (t.label || t.key)) || "") + '</span>' +
          '<span class="anchor-times">最近 ' + escapeHtml(recent) + ' · 下次 ' + escapeHtml(next) + '</span>' +
        '</div>'
      );
    }).join("");
    return (
      '<details class="accordion" open>' +
        '<summary>' +
          '<div class="accordion-title-box">' +
            '<span>窗口保活</span>' + pill(status.text, status.tone) +
          '</div>' +
          '<span class="accordion-chevron">▾</span>' +
        '</summary>' +
        '<div class="accordion-body">' + rows +
          '<div class="anchor-note">推算模式：下次触发按「开火时刻 + 窗口时长」自动重排；时间为北京时间。</div>' +
        '</div>' +
      '</details>'
    );
  }

  function renderData(key, data) {
    if (key === "codex") return renderCodex(data);
    if (key === "muse") return renderMuse(data);
    if (key === "agy") return renderAgy(data);
    if (key === "tavily") { renderTavily(data); return ""; }
    if (key === "mac") { renderMac(data); return renderMacDetail(data); }
    if (key === "anchors") { updateAnchorBlocks(); return ""; }
    return renderWorkBuddy(data);
  }

  function cardFor(key) {
    return document.getElementById(key + "-card");
  }

  function setStatus(card, text, state) {
    var element = card.querySelector('[data-role="status"]');
    if (!element) return;
    element.textContent = text;
    element.className = "badge-status " + (state || "");
  }

  function setError(card, error, detail) {
    var errEl = card.querySelector('[data-role="error"]');
    var contentEl = card.querySelector('[data-role="content"]');
    if (!errEl) return;
    if (!error) {
      errEl.hidden = true;
      errEl.textContent = "";
      return;
    }
    errEl.hidden = false;
    errEl.textContent = (error || "加载失败") + (detail ? ": " + detail : "");
    if (contentEl && !contentEl.innerHTML) {
      contentEl.innerHTML = '<p class="muted">数据暂不可用</p>';
    }
  }

  function applySourceStatus(key, options) {
    if (!DP || !DP.formatUpdateStatus) return;
    var status = DP.formatUpdateStatus(options);
    var previewEl = document.getElementById("preview-" + key + "-updated");
    if (previewEl) {
      previewEl.textContent = status.text;
      previewEl.title = status.title;
    }
    var card = cardFor(key);
    if (card) {
      var foot = card.querySelector('[data-role="updated"]');
      if (foot) {
        foot.textContent = status.text;
        foot.title = status.title;
      }
    }
  }

  function applyClashStatus(options) {
    if (!DP || !DP.formatUpdateStatus) return;
    var status = DP.formatUpdateStatus(options);
    var previewEl = document.getElementById("preview-clash-updated");
    if (previewEl) {
      previewEl.textContent = status.text;
      previewEl.title = status.title;
    }
    var updated = document.getElementById("clash-updated");
    if (updated) {
      updated.textContent = status.text;
      updated.title = status.title;
    }
  }

  function setUpdated(card, isoString, fromCache, ageSeconds, meta) {
    var foot = card.querySelector('[data-role="updated"]');
    if (!foot || !DP || !DP.formatUpdateStatus) return;
    var status = DP.formatUpdateStatus({
      lastFetchedAt: isoString,
      fromCache: fromCache,
      ageSeconds: ageSeconds,
      meta: meta,
    });
    foot.textContent = status.text;
    foot.title = status.title;
  }

  // 首页概览卡与详情卡同一口径（纯函数判定）
  function setPreviewUpdated(key, isoString, meta) {
    var el = document.getElementById("preview-" + key + "-updated");
    if (!el || !DP || !DP.formatUpdateStatus) return;
    var status = DP.formatUpdateStatus({
      lastFetchedAt: isoString,
      meta: meta || lastMeta[key],
    });
    el.textContent = status.text;
    el.title = status.title;
  }

  var payloadCache = { codex: null, wb: null, muse: null, agy: null, tavily: null, anchors: null };

  function providerBadge(name, key) {
    return '<span class="provider-badge provider-' + escapeHtml(key) + '">' + escapeHtml(name) + '</span>';
  }

  function getRecentBjDates(count) {
    // 单一实现在 pure.js（node 可测试），此处仅装配。
    return DP.recentBjDates(count);
  }

  // 渲染全部概览：今日用量汇总、近七天汇总、近七天逐日明细
  function renderAllOverview(cache) {
    var codexData = cache.codex;
    var wbData = cache.wb;
    if (!codexData && !wbData) return;

    var todayEl = document.getElementById("today-summary-content");
    var weekEl = document.getElementById("week-summary-content");
    var dailyEl = document.getElementById("daily-history-content");

    // 1. 今日用量汇总 (今日 00:00 至今)
    if (todayEl) {
      var todayRows = [];
      var tCalls = 0;
      var tCodexCost = amountBucket();
      var tCredits = 0;
      var tIn = 0;
      var tRead = 0;
      var tOut = 0;
      var tTraffic = 0;
      var tTrafficKnown = true;
      var tHasTraffic = false;
      var tWbModelCost = amountBucket();
      var tWbCalls = 0;

      function addTodayTraffic(parts, calls) {
        var values = parts.map(finiteAmount);
        if (values.some(function (value) { return value == null; })) {
          if (calls > 0) tTrafficKnown = false;
          return;
        }
        tTraffic += values.reduce(function (sum, value) { return sum + value; }, 0);
        tHasTraffic = true;
      }

      // Codex 今日
      if (codexData && codexData.today) {
        var cToday = codexData.today;
        var cModels = cToday.model_usage || {};
        Object.keys(cModels).forEach(function (mKey) {
          var mStat = cModels[mKey] || {};
          var calls = Number(mStat.api_calls) || 0;
          var t = mStat.tokens || {};
          var inTok = Number(t.input) || 0;
          var readTok = Number(t.cache_read) || 0;
          var outTok = Number(t.output) || 0;
          var cost = finiteAmount(mStat.api_equivalent_usd);
          var cred = Number(mStat.credits_equivalent) || 0;
          var hit = (inTok + readTok) > 0 ? (readTok / (inTok + readTok)) * 100 : 0;

          tCalls += calls;
          addAmount(tCodexCost, cost, mStat.api_equivalent_usd_partial === true, calls > 0);
          tIn += inTok;
          tRead += readTok;
          tOut += outTok;
          addTodayTraffic([t.input, t.cache_read, t.output], calls);

          todayRows.push({
            provider: "Codex",
            providerKey: "codex",
            model: mKey,
            calls: calls,
            costText: costText(cost, mStat.api_equivalent_usd_partial === true, calls > 0) + (cred ? " (" + number(cred, 1) + " cr)" : ""),
            inTok: inTok,
            readTok: readTok,
            outTok: outTok,
            hitPct: hit,
            sortCost: cost == null ? -1 : cost,
          });
        });
      }

      // WorkBuddy 今日
      var tCnCredits = 0;
      var tIntlCredits = 0;
      if (wbData && wbData.usage && wbData.usage.today) {
        var wbToday = wbData.usage.today;
        var wbModels = Array.isArray(wbToday.models_detail) ? wbToday.models_detail : [];
        wbModels.forEach(function (m) {
          var calls = Number(m.calls) || 0;
          var split = DP.wbTokenColumns(m);
          var modelUsd = finiteAmount(m.usd != null ? m.usd : m.usd_equiv);
          var modelPartial = m.usd_partial === true;
          var cred = finiteAmount(m.credits_known_total);
          if (cred == null && m.credits_complete !== false) cred = finiteAmount(m.credits);
          if (cred == null) cred = 0;
          var isIntl = m.realm === "intl";
          var isCn = m.realm === "cn";
          var provider = isCn ? "WorkBuddy 国内" : (isIntl ? "WorkBuddy 国际" : "WorkBuddy 未知出口");
          var providerKey = isCn ? "wb-cn" : (isIntl ? "wb-intl" : "wb");
          var realmClass = isCn ? "credit-cn" : (isIntl ? "credit-intl" : "");

          tCalls += calls;
          tWbCalls += calls;
          tCredits += cred;
          if (isIntl) tIntlCredits += cred;
          else if (isCn) tCnCredits += cred;
          addAmount(tWbModelCost, modelUsd, modelPartial, calls > 0);

          todayRows.push({
            provider: provider,
            providerKey: providerKey,
            model: m.model,
            calls: calls,
            costText: costText(modelUsd, modelPartial || (calls > 0 && modelUsd == null), calls > 0) + ' · ' + (realmClass
              ? '<span class="' + realmClass + '">' + wbModelCreditsText(m, 2) + ' 积分 (' + (isIntl ? '国际' : '国内') + ')</span>'
              : wbModelCreditsText(m, 2) + ' 积分'),
            unknownRealm: !isCn && !isIntl,
            inTok: split ? split.input : null,
            readTok: split ? split.cache_read : null,
            outTok: split ? split.output : null,
            readTokText: m.cache_complete === false ? wbMetricText(m, "cached_tokens", tokenText) : null,
            outTokText: m.completion_complete === false ? wbMetricText(m, "completion_tokens", tokenText) : null,
            hitPct: split && split.input != null && split.cache_read != null && (split.input + split.cache_read) > 0
              ? (split.cache_read / (split.input + split.cache_read)) * 100 : null,
            sortCost: cred * 0.005,
          });
        });

        // WB 的 prompt_tokens 已含 cached_tokens：拆分后入桶，避免重复计总数。
        var wbTS = DP.wbTokenColumns(wbToday);
        if (wbTS) {
          if (wbTS.input != null) tIn += wbTS.input;
          if (wbTS.cache_read != null) tRead += wbTS.cache_read;
        } else if (finiteAmount(wbToday.cached_tokens_known_count) > 0) {
          tRead += Number(wbToday.cached_tokens_known_total) || 0;
          var tWbUncached = finiteAmount(wbToday.prompt_tokens_known_total);
          tWbUncached = tWbUncached == null ? null : tWbUncached - (Number(wbToday.cached_tokens_known_total) || 0);
          if (tWbUncached != null && tWbUncached > 0) tIn += tWbUncached;
        }
        var wbCompletion = finiteAmount(wbToday.completion_tokens);
        if (wbCompletion == null && finiteAmount(wbToday.completion_tokens_known_count) > 0) {
          wbCompletion = finiteAmount(wbToday.completion_tokens_known_total);
          tTrafficKnown = false;
        }
        if (wbCompletion != null) tOut += wbCompletion;
        var wbTraffic = finiteAmount(wbToday.tokens);
        if (wbTraffic == null && finiteAmount(wbToday.tokens_known_count) > 0) {
          wbTraffic = finiteAmount(wbToday.tokens_known_total);
          tTrafficKnown = false;
        }
        if (wbTraffic != null) {
          tTraffic += wbTraffic;
          tHasTraffic = true;
        } else if (Number(wbToday.requests) > 0) {
          tTrafficKnown = false;
        }
      }

      todayRows.sort(function (a, b) { return b.sortCost - a.sortCost; });

      var tWbObj = (wbData && wbData.usage && wbData.usage.today) || null;
      var tWbCacheIncomplete = !!(tWbObj && tWbObj.cache_complete === false);
      var tTotalHitPct = (tIn + tRead) > 0 ? (tRead / (tIn + tRead)) * 100 : 0;
      if (tWbObj && tWbObj.cn_credits != null) tCnCredits = Number(tWbObj.cn_credits) || 0;
      if (tWbObj && tWbObj.intl_credits != null) tIntlCredits = Number(tWbObj.intl_credits) || 0;
      var tWbUsd = tWbObj ? finiteAmount(tWbObj.usd_equiv) : null;
      var tWbHasUsage = !!tWbObj && (Number(tWbObj.requests) > 0 || tWbCalls > 0 || Number(tWbObj.credits) > 0 || tWbUsd != null);
      var tWbPartial = !!(tWbObj && tWbObj.usd_equiv_info && tWbObj.usd_equiv_info.complete === false);
      var tWbPrimaryCost = amountBucket();
      addAmount(tWbPrimaryCost, tWbUsd, tWbPartial || (tWbHasUsage && tWbUsd == null), tWbHasUsage);
      var tWbCost = chooseAmount(tWbPrimaryCost, tWbModelCost);
      var tWbMark = wbEquivMark(tWbObj ? tWbObj.usd_equiv_info : null, tWbCost.known ? tWbCost.value : null, tWbHasUsage);
      var tAllCost = amountBucket();
      addAmount(tAllCost, tCodexCost.known ? tCodexCost.value : null, tCodexCost.partial, tCodexCost.hasUsage);
      addAmount(tAllCost, tWbCost.known ? tWbCost.value : null, tWbCost.partial, tWbCost.hasUsage);
      var tWbCreditsText = wbCreditsText(tWbObj, 1);
      var tWbSplitKnown = !!(tWbObj && tWbObj.credits_realm_split_complete !== false &&
        (tWbObj.cn_credits != null || tWbObj.intl_credits != null));
      var tWbCreditsParts = wbSplitCreditsParts(tWbObj, 1);
      var tDetailSub = 'Codex ' + amountText(tCodexCost) + ' · WB ' + amountText(tWbCost) +
        '（' + (tWbCreditsParts.length ? tWbCreditsParts.join(' + ') : tWbCreditsText + ' 积分') + '）';
      var tTotalCostText = amountText(tAllCost) + (tWbMark.markHtml || "");
      var tTotalTrafficText = tHasTraffic ? (tTrafficKnown ? "" : "≥") + formatTokens(tTraffic) : "—";

      var todayHtml = [];
      todayHtml.push(
        '<div class="kpi-grid" style="margin-bottom:12px;">' +
          '<div class="kpi-tile">' +
            '<span class="kpi-label">今日总消耗等值</span>' +
            '<strong class="kpi-val">' + tTotalCostText + '</strong>' +
            '<span class="kpi-sub kpi-sub-wrap" title="' + (tWbSplitKnown ? 'WB 积分拆分：国内 ' + number(tCnCredits, 1) + ' / 国际 ' + number(tIntlCredits, 1) : 'WB 原始积分，分区明细未知') + '">' + tDetailSub + '</span>' +
          '</div>' +
          '<div class="kpi-tile">' +
            '<span class="kpi-label">今日调用总次数</span>' +
            '<strong class="kpi-val">' + number(tCalls, 0) + ' 次</strong>' +
            '<span class="kpi-sub">' + todayRows.length + ' 个活跃模型</span>' +
          '</div>' +
          '<div class="kpi-tile">' +
            '<span class="kpi-label">今日总流量</span>' +
            '<strong class="kpi-val">' + tTotalTrafficText + '</strong>' +
            '<span class="kpi-sub kpi-sub-wrap">缓存读 ' + (tWbCacheIncomplete ? "≥" : "") + formatTokens(tRead) + '</span>' +
          '</div>' +
          '<div class="kpi-tile">' +
            '<span class="kpi-label">综合缓存命中率</span>' +
            '<strong class="kpi-val">' + percent(tTotalHitPct) + '</strong>' +
            '<span class="kpi-sub">大幅节省 API 延迟</span>' +
          '</div>' +
        '</div>'
      );

      if (todayRows.length > 0) {
        var todayVisibleRows = todayRows.filter(function (row) { return row.unknownRealm !== true; });
        var tableRows = todayVisibleRows.map(function (row) {
          var hitText = row.hitPct != null ? row.hitPct.toFixed(1) + "%" : "—";
          var inText = row.inTok != null ? formatTokens(row.inTok) : "—";
          var readText = row.readTokText || (row.readTok != null ? formatTokens(row.readTok) : "—");
          var outText = row.outTokText || (row.outTok != null ? formatTokens(row.outTok) : "—");
          return (
            '<tr>' +
              '<td>' + providerBadge(row.provider, row.providerKey) + '</td>' +
              '<td><strong>' + escapeHtml(row.model) + '</strong></td>' +
              '<td>' + number(row.calls, 0) + ' 次</td>' +
              '<td style="font-weight:600;">' + row.costText + '</td>' +
              '<td>' + inText + '</td>' +
              '<td style="color:var(--emerald);">' + readText + '</td>' +
              '<td>' + outText + '</td>' +
              '<td>' + hitText + '</td>' +
            '</tr>'
          );
        }).join("");

        var tableWrapHtml = (todayVisibleRows.length ? (
          '<div class="summary-table-wrap">' +
            '<table class="summary-table">' +
              '<thead>' +
                '<tr>' +
                  '<th>供应商</th>' +
                  '<th>模型名称</th>' +
                  '<th>调用次数</th>' +
                  '<th>费用 / 积分</th>' +
                  '<th>输入(未缓存)</th>' +
                  '<th>缓存读取</th>' +
                  '<th>输出 Token</th>' +
                  '<th>缓存率</th>' +
                '</tr>' +
              '</thead>' +
              '<tbody>' + tableRows + '</tbody>' +
            '</table>' +
          '</div>'
        ) : "") + wbUnknownRealmNote(todayRows);

        // 默认折叠关闭各供应商/模型详情
        todayHtml.push(accordion("展开今日各供应商与模型消耗明细 (" + todayVisibleRows.length + " 款模型)", "", tableWrapHtml, false));
      } else {
        todayHtml.push('<p class="muted">今日暂无调用记录</p>');
      }

      todayEl.innerHTML = todayHtml.join("");
    }

    // 2. 七天用量汇总 (滚动 7 天)
    if (weekEl) {
      var wCalls = 0;
      var wCodexCost = amountBucket();
      var wCredits = 0;
      var wIn = 0;
      var wRead = 0;
      var wOut = 0;
      var wTraffic = 0;
      var wTrafficKnown = true;
      var wHasTraffic = false;
      var weekRows = [];
      var wCodexModelCost = amountBucket();
      var wWbModelCost = amountBucket();
      var wWbModelCalls = 0;
      var wWbModelCredits = 0;
      var wWbModelCn = 0;
      var wWbModelIntl = 0;

      // 以北京时间最近 7 个自然日为窗口（按日期集合过滤，避免依赖“恰好只有 7 条”）
      var recent7Set = {};
      getRecentBjDates(7).forEach(function (d) { recent7Set[d] = true; });

      // Codex 7天(逐日明细求和：五个实例 + 本机 Codex，统一口径)
      if (codexData && Array.isArray(codexData.daily_summaries)) {
        var codexDailies7 = codexData.daily_summaries.filter(function (c) { return recent7Set[c.day]; });
        var codex7ModelsMap = {};
        codexDailies7.forEach(function (dayEntry) {
          wCalls += Number(dayEntry.api_calls) || 0;
          addAmount(wCodexCost, dayEntry.api_equivalent_usd, dayEntry.api_equivalent_usd_partial === true, Number(dayEntry.api_calls) > 0);
          var dayTokens = dayEntry.tokens || {};
          wIn += Number(dayTokens.input) || 0;
          wRead += Number(dayTokens.cache_read) || 0;
          wOut += Number(dayTokens.output) || 0;
          var codexDayTraffic = [dayTokens.input, dayTokens.cache_read, dayTokens.output].map(finiteAmount);
          if (codexDayTraffic.some(function (value) { return value == null; })) wTrafficKnown = false;
          else {
            wTraffic += codexDayTraffic.reduce(function (sum, value) { return sum + value; }, 0);
            wHasTraffic = true;
          }
          (dayEntry.models || []).forEach(function (m) {
            var key = m.model;
            var ent = codex7ModelsMap[key];
            if (!ent) {
              ent = codex7ModelsMap[key] = { calls: 0, cost: 0, costKnown: false, costPartial: false, inTok: 0, readTok: 0, outTok: 0 };
            }
            ent.calls += Number(m.api_calls) || 0;
            var modelCost = finiteAmount(m.api_equivalent_usd);
            addAmount(wCodexModelCost, modelCost, m.api_equivalent_usd_partial === true, Number(m.api_calls) > 0);
            if (modelCost != null) {
              ent.cost += modelCost;
              ent.costKnown = true;
            } else if (Number(m.api_calls) > 0) {
              ent.costPartial = true;
            }
            if (m.api_equivalent_usd_partial === true) ent.costPartial = true;
            var modelTokens = m.tokens || {};
            ent.inTok += Number(modelTokens.input) || 0;
            ent.readTok += Number(modelTokens.cache_read) || 0;
            ent.outTok += Number(modelTokens.output) || 0;
          });
        });
        Object.keys(codex7ModelsMap).forEach(function (mKey) {
          var ent = codex7ModelsMap[mKey];
          var mHit = (ent.inTok + ent.readTok) > 0 ? (ent.readTok / (ent.inTok + ent.readTok)) * 100 : 0;
          weekRows.push({
            provider: "Codex",
            providerKey: "codex",
            model: mKey,
            calls: ent.calls,
            costText: ent.costKnown ? (ent.costPartial ? "≥" : "") + money(ent.cost) : "未计价",
            inTok: ent.inTok,
            readTok: ent.readTok,
            outTok: ent.outTok,
            hitPct: mHit,
            sortCost: ent.costKnown ? ent.cost : -1,
          });
        });
        wCodexCost = chooseAmount(wCodexCost, wCodexModelCost);
      }

      // WorkBuddy 7天
      if (wbData && wbData.usage && wbData.usage.week) {
        var wbW = wbData.usage.week;
        var wbWeekTopCalls = Number(wbW.requests) || 0;
        wCalls += wbWeekTopCalls;
        wCredits += Number(wbW.credits) || 0;
        var wbWS = DP.wbTokenColumns(wbW);
        if (wbWS) {
          if (wbWS.input != null) wIn += wbWS.input;
          if (wbWS.cache_read != null) wRead += wbWS.cache_read;
        } else if (finiteAmount(wbW.cached_tokens_known_count) > 0) {
          wRead += Number(wbW.cached_tokens_known_total) || 0;
          var wWbUncached = finiteAmount(wbW.prompt_tokens_known_total);
          wWbUncached = wWbUncached == null ? null : wWbUncached - (Number(wbW.cached_tokens_known_total) || 0);
          if (wWbUncached != null && wWbUncached > 0) wIn += wWbUncached;
        }
        var wbCompletion = finiteAmount(wbW.completion_tokens);
        if (wbCompletion == null && finiteAmount(wbW.completion_tokens_known_count) > 0) {
          wbCompletion = finiteAmount(wbW.completion_tokens_known_total);
          wTrafficKnown = false;
        }
        if (wbCompletion != null) wOut += wbCompletion;
        var wbTraffic = finiteAmount(wbW.tokens);
        if (wbTraffic == null && finiteAmount(wbW.tokens_known_count) > 0) {
          wbTraffic = finiteAmount(wbW.tokens_known_total);
          wTrafficKnown = false;
        }
        if (wbTraffic != null) {
          wTraffic += wbTraffic;
          wHasTraffic = true;
        } else if (Number(wbW.requests) > 0) {
          wTrafficKnown = false;
        }

        var wb7Rows = DP.wbModelUsageRows((wbData.usage.daily || []), recent7Set);
        wb7Rows.forEach(function (ent) {
          var split = DP.wbTokenColumns(ent);
          wWbModelCalls += ent.calls;
          var knownCredits = finiteAmount(ent.credits_known_total) || 0;
          wWbModelCredits += knownCredits;
          if (ent.intl) wWbModelIntl += knownCredits;
          else if (ent.realm === "cn") wWbModelCn += knownCredits;
          addAmount(wWbModelCost, ent.usd, ent.usdPartial, ent.calls > 0);
          var realmClass = ent.realm === "cn" ? "credit-cn" : (ent.realm === "intl" ? "credit-intl" : "");
          var realmLabel = ent.realm === "cn" ? "WorkBuddy 国内" : (ent.realm === "intl" ? "WorkBuddy 国际" : "WorkBuddy 未知出口");
          var realmKey = ent.realm === "cn" ? "wb-cn" : (ent.realm === "intl" ? "wb-intl" : "wb");
          weekRows.push({
            provider: realmLabel,
            providerKey: realmKey,
            model: ent.model,
            calls: ent.calls,
            costText: (ent.usd == null ? "未计价" : (ent.usdPartial ? "≥" : "") + money(ent.usd)) + " · " + (realmClass
              ? '<span class="' + realmClass + '">' + wbModelCreditsText(ent, 2) + ' 积分 (' + (ent.intl ? '国际' : '国内') + ')</span>'
              : wbModelCreditsText(ent, 2) + ' 积分'),
            unknownRealm: ent.realm !== "cn" && ent.realm !== "intl",
            inTok: split ? split.input : null,
            readTok: split ? split.cache_read : null,
            outTok: split ? split.output : null,
            readTokText: ent.cache_complete === false ? wbMetricText(ent, "cached_tokens", tokenText) : null,
            outTokText: ent.completion_complete === false ? wbMetricText(ent, "completion_tokens", tokenText) : null,
            hitPct: split && split.input != null && split.cache_read != null && (split.input + split.cache_read) > 0
              ? (split.cache_read / (split.input + split.cache_read)) * 100 : null,
            sortCost: knownCredits * 0.005,
          });
        });
        if (wbWeekTopCalls === 0) wCalls += wWbModelCalls;
        if (wbWeekTopCalls === 0 && wbW.credits == null) wCredits += wWbModelCredits;
      }

      weekRows.sort(function (a, b) { return b.sortCost - a.sortCost; });

      var wWbWeek = (wbData && wbData.usage && wbData.usage.week) ? wbData.usage.week : null;
      var wWbCacheIncomplete = !!(wWbWeek && wWbWeek.cache_complete === false);
      var wTotalHitPct = (wIn + wRead) > 0 ? (wRead / (wIn + wRead)) * 100 : 0;
      var wWbUsd = wWbWeek ? finiteAmount(wWbWeek.usd_equiv) : null;
      var wWbHasUsage = !!wWbWeek && (Number(wWbWeek.requests) > 0 || wWbModelCalls > 0 || Number(wWbWeek.credits) > 0 || wWbUsd != null);
      var wWbPartial = !!(wWbWeek && wWbWeek.usd_equiv_info && wWbWeek.usd_equiv_info.complete === false);
      var wWbPrimaryCost = amountBucket();
      addAmount(wWbPrimaryCost, wWbUsd, wWbPartial || (wWbHasUsage && wWbUsd == null), wWbHasUsage);
      var wWbCost = chooseAmount(wWbPrimaryCost, wWbModelCost);
      var wWbMark = wbEquivMark(wWbWeek ? wWbWeek.usd_equiv_info : null, wWbCost.known ? wWbCost.value : null, wWbHasUsage);
      var wWbCn = wWbWeek && wWbWeek.cn_credits != null ? Number(wWbWeek.cn_credits) : 0;
      var wWbIntl = wWbWeek && wWbWeek.intl_credits != null ? Number(wWbWeek.intl_credits) : 0;
      var wWbCredits = wWbWeek ? finiteAmount(wWbWeek.credits) : null;
      var wWbSplitKnown = !!(wWbWeek && wWbWeek.credits_realm_split_complete !== false &&
        (wWbWeek.cn_credits != null || wWbWeek.intl_credits != null));
      if (wWbCredits == null) wWbCredits = wWbModelCalls > 0 ? wWbModelCredits : wWbCn + wWbIntl;
      if (!wWbSplitKnown && wWbModelCalls > 0) {
        wWbCn = wWbModelCn;
        wWbIntl = wWbModelIntl;
        wWbSplitKnown = true;
      }
      var wAllCost = amountBucket();
      addAmount(wAllCost, wCodexCost.known ? wCodexCost.value : null, wCodexCost.partial, wCodexCost.hasUsage);
      addAmount(wAllCost, wWbCost.known ? wWbCost.value : null, wWbCost.partial, wWbCost.hasUsage);
      var wWbCreditsParts = wbSplitCreditsParts(wWbWeek, 1);
      var wDetailSub = 'Codex ' + amountText(wCodexCost) + ' · WB ' + amountText(wWbCost) +
        '（' + (wWbCreditsParts.length ? wWbCreditsParts.join(' + ') : wbCreditsText(wWbWeek, 1) + ' 积分') + '）';
      var wTotalCostText = amountText(wAllCost) + (wWbMark.markHtml || "");
      var wTotalTrafficText = wHasTraffic ? (wTrafficKnown ? "" : "≥") + formatTokens(wTraffic) : "—";

      var weekHtml = [];
      weekHtml.push(
        '<div class="kpi-grid" style="margin-bottom:12px;">' +
          '<div class="kpi-tile">' +
            '<span class="kpi-label">近 7 天总费用等值</span>' +
            '<strong class="kpi-val">' + wTotalCostText + '</strong>' +
            '<span class="kpi-sub kpi-sub-wrap" title="' + (wWbSplitKnown ? 'WB 积分拆分：国内 ' + number(wWbCn, 1) + ' / 国际 ' + number(wWbIntl, 1) : 'WB 原始积分，分区明细未知') + '">' + wDetailSub + '</span>' +
          '</div>' +
          '<div class="kpi-tile">' +
            '<span class="kpi-label">近 7 天调用次数</span>' +
            '<strong class="kpi-val">' + number(wCalls, 0) + ' 次</strong>' +
            '<span class="kpi-sub">滚动窗口审计</span>' +
          '</div>' +
          '<div class="kpi-tile">' +
            '<span class="kpi-label">近 7 天总流量</span>' +
            '<strong class="kpi-val">' + wTotalTrafficText + '</strong>' +
            '<span class="kpi-sub kpi-sub-wrap">缓存读 ' + (wWbCacheIncomplete ? "≥" : "") + formatTokens(wRead) + '</span>' +
          '</div>' +
          '<div class="kpi-tile">' +
            '<span class="kpi-label">平均缓存命中率</span>' +
            '<strong class="kpi-val">' + percent(wTotalHitPct) + '</strong>' +
            '<span class="kpi-sub">跨平台持久化缓存</span>' +
          '</div>' +
        '</div>'
      );

      if (weekRows.length > 0) {
        var weekVisibleRows = weekRows.filter(function (row) { return row.unknownRealm !== true; });
        var weekTableRows = weekVisibleRows.map(function (row) {
          var hitText = row.hitPct != null ? row.hitPct.toFixed(1) + "%" : "—";
          var inText = row.inTok != null ? formatTokens(row.inTok) : "—";
          var readText = row.readTokText || (row.readTok != null ? formatTokens(row.readTok) : "—");
          var outText = row.outTokText || (row.outTok != null ? formatTokens(row.outTok) : "—");
          return (
            '<tr>' +
              '<td>' + providerBadge(row.provider, row.providerKey) + '</td>' +
              '<td><strong>' + escapeHtml(row.model) + '</strong></td>' +
              '<td>' + number(row.calls, 0) + ' 次</td>' +
              '<td style="font-weight:600;">' + row.costText + '</td>' +
              '<td>' + inText + '</td>' +
              '<td style="color:var(--emerald);">' + readText + '</td>' +
              '<td>' + outText + '</td>' +
              '<td>' + hitText + '</td>' +
            '</tr>'
          );
        }).join("");

        weekHtml.push(
          accordion(
            "展开近 7 天各供应商与模型消耗明细 (" + weekVisibleRows.length + " 款模型)",
            "",
            (weekVisibleRows.length ? '<div class="summary-table-wrap">' +
              '<table class="summary-table">' +
                '<thead>' +
                  '<tr>' +
                    '<th>供应商</th>' +
                    '<th>模型名称</th>' +
                    '<th>7天调用</th>' +
                    '<th>7天费用/积分</th>' +
                    '<th>输入(未缓存)</th>' +
                    '<th>缓存读取</th>' +
                    '<th>输出 Token</th>' +
                    '<th>缓存率</th>' +
                  '</tr>' +
                '</thead>' +
                '<tbody>' + weekTableRows + '</tbody>' +
              '</table>' +
            '</div>' : "") + wbUnknownRealmNote(weekRows),
            false
          )
        );
      }

      weekEl.innerHTML = weekHtml.join("");
    }

    // 3. 近七天每一天流水 (折叠块)
    if (dailyEl) {
      var recentDates = getRecentBjDates(7);
      var codexDailies = (codexData && Array.isArray(codexData.daily_summaries)) ? codexData.daily_summaries : [];
      var wbDailies = (wbData && wbData.usage && Array.isArray(wbData.usage.daily)) ? wbData.usage.daily : [];

      var dayCardsHtml = recentDates.map(function (dStr, index) {
        var dayCodex = codexDailies.find(function (c) { return c.day === dStr; });
        var dayWb = wbDailies.find(function (c) { return c.day === dStr; });

        var dCalls = 0;
        var dCodexCost = amountBucket();
        var dWbCost = amountBucket();
        var dCredits = 0;
        var dIn = 0;
        var dRead = 0;
        var dOut = 0;
        var dTraffic = 0;
        var dTrafficKnown = true;
        var dHasTraffic = false;
        var dRows = [];
        var dCodexModelCost = amountBucket();
        var dWbModelCost = amountBucket();
        var dWbModelCalls = 0;
        var dWbModelCredits = 0;
        var dWbModelCn = 0;
        var dWbModelIntl = 0;

        if (dayCodex) {
          dCalls += Number(dayCodex.api_calls) || 0;
          addAmount(dCodexCost, dayCodex.api_equivalent_usd, dayCodex.api_equivalent_usd_partial === true, Number(dayCodex.api_calls) > 0);
          var t = dayCodex.tokens || {};
          dIn += Number(t.input) || 0;
          dRead += Number(t.cache_read) || 0;
          dOut += Number(t.output) || 0;
          var codexTraffic = [t.input, t.cache_read, t.output].map(finiteAmount);
          if (codexTraffic.some(function (value) { return value == null; })) dTrafficKnown = false;
          else {
            dTraffic += codexTraffic.reduce(function (sum, value) { return sum + value; }, 0);
            dHasTraffic = true;
          }
          (dayCodex.models || []).forEach(function (m) {
            addAmount(dCodexModelCost, m.api_equivalent_usd, m.api_equivalent_usd_partial === true, Number(m.api_calls) > 0);
            dRows.push({
              provider: "Codex",
              providerKey: "codex",
              model: m.model,
              calls: m.api_calls,
              costText: costText(m.api_equivalent_usd, m.api_equivalent_usd_partial === true, Number(m.api_calls) > 0),
              tokens: tokenText((m.tokens && finiteAmount(m.tokens.input) != null && finiteAmount(m.tokens.cache_read) != null && finiteAmount(m.tokens.output) != null)
                ? finiteAmount(m.tokens.input) + finiteAmount(m.tokens.cache_read) + finiteAmount(m.tokens.output) : null),
            });
          });
          dCodexCost = chooseAmount(dCodexCost, dCodexModelCost);
        }

        if (dayWb) {
          var dayWbTopCalls = Number(dayWb.requests) || 0;
          dCalls += dayWbTopCalls;
          dCredits += Number(dayWb.credits != null ? dayWb.credits : dayWb.credits_known_total) || 0;
          var dayWbUsd = finiteAmount(dayWb.usd_equiv);
          var dayWbHasUsage = dayWbTopCalls > 0 || Number(dayWb.credits) > 0 || dayWbUsd != null;
          var dayWbPartial = !!(dayWb.usd_equiv_info && dayWb.usd_equiv_info.complete === false);
          var dwS = DP.wbTokenColumns(dayWb);
          if (dwS) {
            if (dwS.input != null) dIn += dwS.input;
            if (dwS.cache_read != null) dRead += dwS.cache_read;
          } else if (finiteAmount(dayWb.cached_tokens_known_count) > 0) {
            dRead += Number(dayWb.cached_tokens_known_total) || 0;
            var dWbUncached = finiteAmount(dayWb.prompt_tokens_known_total);
            dWbUncached = dWbUncached == null ? null : dWbUncached - (Number(dayWb.cached_tokens_known_total) || 0);
            if (dWbUncached != null && dWbUncached > 0) dIn += dWbUncached;
          }
          var dayWbCompletion = finiteAmount(dayWb.completion_tokens);
          if (dayWbCompletion == null && finiteAmount(dayWb.completion_tokens_known_count) > 0) {
            dayWbCompletion = finiteAmount(dayWb.completion_tokens_known_total);
            dTrafficKnown = false;
          }
          if (dayWbCompletion != null) dOut += dayWbCompletion;
          var dayWbTraffic = finiteAmount(dayWb.tokens);
          if (dayWbTraffic == null && finiteAmount(dayWb.tokens_known_count) > 0) {
            dayWbTraffic = finiteAmount(dayWb.tokens_known_total);
            dTrafficKnown = false;
          }
          if (dayWbTraffic != null) {
            dTraffic += dayWbTraffic;
            dHasTraffic = true;
          } else if (Number(dayWb.requests) > 0) {
            dTrafficKnown = false;
          }
          (dayWb.models || []).forEach(function (m) {
            var isIntl = m.realm === "intl";
            var modelUsd = finiteAmount(m.usd != null ? m.usd : m.usd_equiv);
            var modelCalls = Number(m.calls) || 0;
            var modelCreditsKnown = finiteAmount(m.credits_known_total) || 0;
            dWbModelCalls += modelCalls;
            dWbModelCredits += modelCreditsKnown;
            if (isIntl) dWbModelIntl += modelCreditsKnown;
            else if (m.realm === "cn") dWbModelCn += modelCreditsKnown;
            addAmount(dWbModelCost, modelUsd, m.usd_partial === true, modelCalls > 0);
            var wbRealm = m.realm === "cn" || m.realm === "intl" ? m.realm : "unknown";
            var wbProvider = wbRealm === "cn" ? "WorkBuddy 国内" : (wbRealm === "intl" ? "WorkBuddy 国际" : "WorkBuddy 未知出口");
            var wbProviderKey = wbRealm === "cn" ? "wb-cn" : (wbRealm === "intl" ? "wb-intl" : "wb");
            var wbCreditClass = wbRealm === "cn" ? "credit-cn" : (wbRealm === "intl" ? "credit-intl" : "");
            dRows.push({
              provider: wbProvider,
              providerKey: wbProviderKey,
              model: m.model,
              calls: modelCalls,
              costText: costText(modelUsd, m.usd_partial === true || (modelCalls > 0 && modelUsd == null), modelCalls > 0) + " · " + (wbCreditClass
                ? '<span class="' + wbCreditClass + '">' + wbModelCreditsText(m, 2) + ' 积分 (' + (isIntl ? '国际' : '国内') + ')</span>'
                : wbModelCreditsText(m, 2) + ' 积分'),
              unknownRealm: wbRealm === "unknown",
              tokens: wbModelTokenText(m),
            });
          });
          if (dayWbTopCalls === 0) dCalls += dWbModelCalls;
          if (dayWbTopCalls === 0 && dayWb.credits == null) dCredits += dWbModelCredits;
          if (!dayWbHasUsage && dWbModelCalls > 0) dayWbHasUsage = true;
          var dayWbPrimaryCost = amountBucket();
          addAmount(dayWbPrimaryCost, dayWbUsd, dayWbPartial || (dayWbHasUsage && dayWbUsd == null), dayWbHasUsage);
          dWbCost = chooseAmount(dayWbPrimaryCost, dWbModelCost);
        }

        if (dCalls === 0) {
          return "";
        }

        var dHitPct = (dIn + dRead) > 0 ? (dRead / (dIn + dRead)) * 100 : 0;
        var dayTag = index === 0 ? pill("今天", "ok") : (index === 1 ? pill("昨天", "accent") : "");
        var dCostParts = [];
        if (dCodexCost.hasUsage) dCostParts.push("Codex " + amountText(dCodexCost));
        if (dayWb && dayWbHasUsage) {
          var dCreditsParts = wbSplitCreditsParts(dayWb, 1);
          if (!dCreditsParts.length) {
            var dCreditsText = wbCreditsText(dayWb, 1);
            if (dCreditsText !== "—") dCreditsParts.push(dCreditsText + " 积分");
          }
          if (!dCreditsParts.length && dWbModelCalls > 0) {
            dCreditsParts.push('<span class="credit-cn">🇨🇳 ' + number(dWbModelCn, 1) + ' 积分</span>');
            dCreditsParts.push('<span class="credit-intl">🌐 ' + number(dWbModelIntl, 1) + ' 积分</span>');
          }
          if (!dCreditsParts.length) dCreditsParts.push("— 积分");
          dCostParts.push("WB " + amountText(dWbCost) + " + " + dCreditsParts.join(" + "));
        } else if (dCredits > 0) {
          dCostParts.push(number(dCredits, 1) + " 积分");
        }
        var dCostStr = dCostParts.length ? dCostParts.join(" · ") : "—";
        var dTokensText = dHasTraffic ? (dTrafficKnown ? "" : "≥") + formatTokens(dTraffic) : "—";

        var visibleDayRows = dRows.filter(function (row) { return row.unknownRealm !== true; });
        var itemsList = visibleDayRows.map(function (row) {
          return (
            '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px 8px;font-size:0.72rem;padding:3px 0;border-bottom:1px dashed var(--border);">' +
              '<div style="display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap;">' +
                providerBadge(row.provider, row.providerKey) +
                '<span style="overflow-wrap:anywhere;">' + escapeHtml(row.model) + '</span>' +
              '</div>' +
              '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end;font-variant-numeric:tabular-nums;">' +
                '<span>' + row.calls + ' 次</span>' +
                '<span style="font-weight:600;">' + row.costText + '</span>' +
                (row.tokens ? '<span style="color:var(--muted);">' + row.tokens + '</span>' : '') +
              '</div>' +
            '</div>'
          );
        }).join("");
        var unknownDayNote = wbUnknownRealmNote(dRows);

        return (
          '<div class="daily-day-card">' +
            '<div class="daily-day-head">' +
              '<div class="daily-day-title">' +
                '<span>' + escapeHtml(dStr) + '</span>' +
                dayTag +
              '</div>' +
              '<div class="daily-day-stats">' +
                '<span>' + dCalls + ' 次调用</span>' +
                '<span class="daily-day-cost">' + dCostStr + '</span>' +
                '<span>流量 ' + dTokensText + '</span>' +
                '<span>命中率 ' + percent(dHitPct) + '</span>' +
              '</div>' +
            '</div>' +
            (visibleDayRows.length > 0 ? accordion("模型明细", String(visibleDayRows.length), '<div>' + itemsList + '</div>', false) : "") +
            unknownDayNote +
          '</div>'
        );
      }).filter(Boolean).join("");

      if (!dayCardsHtml) {
        dayCardsHtml = '<p class="muted">近 7 天暂无调用流水</p>';
      }

      dailyEl.innerHTML =
        '<header class="summary-section-head">' +
          '<div class="summary-section-title">' +
            '<span class="summary-icon">🗓️</span>' +
            '<h3>近七天逐日用量流水</h3>' +
          '</div>' +
          '<span class="summary-tag">7 天按日归档</span>' +
        '</header>' +
        '<div class="summary-section-body daily-cards-list">' + dayCardsHtml + '</div>';
    }
  }

  function fetchKey(key, force) {
    var card = cardFor(key);
    // tavily 只有首页迷你卡、anchors 只更新详情内子块：无卡也继续取数。
    if (!card && key !== "tavily" && key !== "anchors") return Promise.resolve();
    var startedAt = Date.now();
    var refreshBtn = card ? card.querySelector('[data-action="refresh"]') : null;

    if (card) card.classList.add("is-loading");
    if (refreshBtn) refreshBtn.classList.add("is-spinning");

    applySourceStatus(key, {
      loading: true,
      lastFetchedAt: lastMeta[key] ? lastMeta[key].fetched_at : null,
      meta: lastMeta[key],
    });

    var url = "/api/" + key + (force ? "?force=1" : "");
    return fetch(url, { cache: "no-store" })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) {
            throw new Error((body && body.detail) || (body && body.error) || ("HTTP " + res.status));
          }
          return body;
        });
      })
      .then(function (payload) {
        if (card) setError(card, null);
        var meta = payload.meta || {};
        lastMeta[key] = meta;
        payloadCache[key] = payload.data;

        var fxChanged = false;
        if (key === "wb" && payload.data && payload.data.usd_cny) {
          fxChanged = setUsdCny(payload.data.usd_cny);
        }

        applySourceStatus(key, {
          loading: false,
          meta: meta,
          lastFetchedAt: meta.fetched_at,
        });

        if (card) {
          if (meta.refresh_error && meta.refresh_pending) {
            setStatus(card, "更新中（上次失败）", "error");
          } else if (meta.refresh_error) {
            setStatus(card, "最近刷新失败", "error");
          } else if (meta.stale || meta.refresh_pending) {
            setStatus(card, "更新中", "stale");
          } else {
            setStatus(card, "正常", "ok");
          }
        }

        if (fxChanged && currencyMode === "CNY") {
          // 汇率就绪/变化：人民币模式下统一重刷所有金额，避免旧值残留
          rerenderAll();
        } else {
          if (key === "tavily" || key === "anchors") {
            renderData(key, payload.data);  // tavily=首页迷你卡；anchors=Codex/agy 详情内的保活块
          } else {
            var contentEl = card.querySelector('[data-role="content"]');
            if (contentEl) {
              contentEl.innerHTML = renderData(key, payload.data);
            }
          }
          renderAllOverview(payloadCache);
          renderPriceSections(payloadCache);
          updateAnchorBlocks();
          // renderData 会用 wb 快照重建告警区；有实时数据就再覆盖一次，别让快照盖掉瞬态。
          if (key === "wb") renderThrottleAlerts();
        }
        updateCurrencyUi();
      })
      .catch(function (err) {
        var detail = err.message;
        if (key === "muse") {
          // 桥查询有等待上限（超时即失败）；把页面实际等待时长一并报出来
          var waited = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
          detail = "等待 " + waited + " 秒未成功；" + detail;
        }
        if (card) {
          setError(card, "数据获取失败", detail);
          setStatus(card, "错误", "error");
        }
        applySourceStatus(key, {
          loading: false,
          error: err,
          lastFetchedAt: lastMeta[key] ? lastMeta[key].fetched_at : null,
        });
      })
      .finally(function () {
        if (card) card.classList.remove("is-loading");
        if (refreshBtn) refreshBtn.classList.remove("is-spinning");
      });
  }

  var clashPending = false;

  function speed(value) {
    if (typeof value !== "number" || !isFinite(value) || value < 0) return "—";
    if (value >= 1048576) return number(value / 1048576, 2) + " MiB/s";
    if (value >= 1024) return number(value / 1024, 1) + " KiB/s";
    return number(value, 0) + " B/s";
  }

  function bytes(value) {
    if (typeof value !== "number" || !isFinite(value) || value < 0) return "—";
    if (value >= 1024 * 1024 * 1024) return number(value / 1073741824, 2) + " GiB";
    if (value >= 1048576) return number(value / 1048576, 1) + " MiB";
    if (value >= 1024) return number(value / 1024, 1) + " KiB";
    return number(value, 0) + " B";
  }

  function shortDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    function pad(n) { return n < 10 ? "0" + n : String(n); }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function chainList(d) {
    var chain = (d.selected_chain || []).slice();
    var entry = d.entry;
    if (entry && entry.group && chain.indexOf(entry.group) === -1) {
      chain.unshift(entry.group);
    }
    return chain;
  }

  function chainLabel(d) {
    return chainList(d).join("  →  ");
  }

  function renderChainFlow(d) {
    var hops = chainList(d);
    if (!hops.length) return '<span class="clash-empty-state">链路未知</span>';
    var pills = hops.map(function (hop, idx) {
      var arrow = idx > 0 ? '<span class="clash-chain-arrow" aria-hidden="true">➔</span>' : '';
      return arrow + '<span class="clash-node-pill" title="' + escapeHtml(hop) + '">' + escapeHtml(hop) + '</span>';
    }).join("");
    return '<div class="clash-chain-flow">' + pills + '</div>';
  }

  // Egress arrives masked (153.***) with a match flag; the raw address is
  // never exposed because the dashboard is reachable from LAN and Tailscale.
  var STATIC_EXIT_LABEL = "德国静态IP";

  function linkBlock(d) {
    var exitOk = !!d.exit_ip;
    var isStaticExit = d.exit_is_static === true;
    var entry = d.entry;
    var entrySelected = (entry && entry.selected) ? entry.selected : "未识别";
    var delay = entry ? entry.delay_ms : null;
    var delayText = (typeof delay === "number") ? delay + " ms" : "—";
    var delayState = (typeof delay !== "number") ? "" :
      delay <= 150 ? "ok" : delay <= 400 ? "warn" : "bad";
    var aliveText = (entry && typeof entry.members === "number") ?
      (entry.alive + " / " + entry.members + " 在线") : "健康未知";

    var html = '<div class="clash-hero-grid">';
    // 出口 IP 卡片：静态出口受保护，漂移时按实际显示并告警
    html += '<div class="clash-hero-card">' +
      '<div class="clash-hero-top">' +
        '<span class="clash-hero-label">出口 IP</span>' +
        '<span class="clash-pill ' + (exitOk ? 'ok' : 'bad') + '">' +
          (exitOk ? '● 连通' : '● 失败') +
        '</span>' +
      '</div>' +
      '<div class="clash-hero-ip" title="' + escapeHtml(exitOk ? d.exit_ip : '探测失败') + '">' +
        escapeHtml(exitOk ? d.exit_ip : '探测失败') +
      '</div>' +
      '<div class="clash-hero-sub">' +
        (exitOk
          ? '<span class="clash-pill ' + (isStaticExit ? 'ok' : 'bad') + '">' +
              (isStaticExit ? STATIC_EXIT_LABEL : '出口已变更') +
            '</span>' +
            '<span>' + (isStaticExit ? '静态出口正常' : '非预期出口') + '</span>'
          : '<span>未能探测实际出口</span>') +
      '</div>' +
    '</div>';

    // 入口节点卡片
    html += '<div class="clash-hero-card">' +
      '<div class="clash-hero-top">' +
        '<span class="clash-hero-label">入口节点</span>' +
        (delayState ? '<span class="clash-pill ' + delayState + '">' + escapeHtml(delayText) + '</span>' : '') +
      '</div>' +
      '<div class="clash-hero-name" title="' + escapeHtml(entrySelected) + '">' +
        escapeHtml(entrySelected) +
      '</div>' +
      '<div class="clash-hero-sub">' + escapeHtml(aliveText) + '</div>' +
    '</div>';
    html += '</div>';

    // 链路轨迹卡片
    html += '<div class="clash-chain-card">' +
      '<div class="clash-chain-head">当前路由链路轨迹</div>' +
      renderChainFlow(d) +
    '</div>';

    return '<section class="clash-block">' +
      '<div class="clash-block-head">' +
        '<span class="clash-block-icon">🌐</span>' +
        '<h4 class="clash-block-title">出口网络与链路</h4>' +
      '</div>' +
      html +
    '</section>';
  }

  function todayBj() {
    return DP.recentBjDates(1)[0];
  }

  function checkinRow(checkin) {
    var label = DP.checkinLabel(checkin, todayBj());
    return '<div class="clash-checkin-row is-' + label.tone + '">' +
      '<span aria-hidden="true">🗓</span><span>' + escapeHtml(label.text) + '</span>' +
    '</div>';
  }

  function quotaBlock(s, checkin) {
    if (!s || typeof s.total !== "number") {
      return '<section class="clash-block">' +
        '<div class="clash-block-head"><span class="clash-block-icon">📦</span><h4 class="clash-block-title">订阅流量配额</h4></div>' +
        '<div class="clash-empty-state">订阅配额不可用（未缓存或未配置）</div>' +
        checkinRow(checkin) +
      '</section>';
    }

    var used = s.used || 0;
    var pct = s.total > 0 ? (used / s.total) * 100 : 0;
    var quotaState = DP.barColor(pct) === "danger" ? "bad" : DP.barColor(pct) === "warning" ? "warn" : "ok";
    var resetText = "—";
    var resetDate = "";
    if (s.days_to_reset !== null && s.days_to_reset !== undefined) {
      resetText = s.days_to_reset + " 天后重置";
      if (s.next_reset) resetDate = shortDate(s.next_reset);
    }

    var html = '<div class="clash-quota-box">' +
      '<div class="clash-quota-hero-row">' +
        '<div class="clash-quota-hero">' +
          '<span class="clash-quota-hero-label">已用流量</span>' +
          '<span class="clash-quota-hero-val ' + quotaState + '">' + bytes(used) + '</span>' +
        '</div>' +
        '<div class="clash-quota-reset">' +
          '<span class="clash-quota-reset-days">' + escapeHtml(resetText) + '</span>' +
          (resetDate ? '<span class="clash-quota-reset-date">' + escapeHtml(resetDate) + '</span>' : '') +
        '</div>' +
      '</div>' +
      progressBar(pct) +
      '<div class="clash-quota-foot-row">' +
        '<span>已用 ' + number(pct, 1) + '%</span>' +
        '<span>余 ' + bytes(s.remaining) + ' / 总量 ' + bytes(s.total) + '</span>' +
      '</div>' +
      '<div class="clash-quota-chips">' +
        (s.expire_at ? '<div class="clash-sub-chip"><span>账户到期</span><strong>' + escapeHtml(shortDate(s.expire_at)) + '</strong></div>' : '') +
        (s.updated_at ? '<div class="clash-sub-chip"><span>订阅更新</span><strong>' + escapeHtml(shortDate(s.updated_at)) + '</strong></div>' : '') +
      '</div>' +
      checkinRow(checkin) +
    '</div>';

    return '<section class="clash-block">' +
      '<div class="clash-block-head">' +
        '<span class="clash-block-icon">📦</span>' +
        '<h4 class="clash-block-title">订阅流量配额</h4>' +
      '</div>' +
      html +
    '</section>';
  }

  function trafficBlock(d) {
    var html = '<div class="clash-stat-grid">' +
      '<div class="clash-stat-tile">' +
        '<span class="clash-stat-label">↓ 下载速率</span>' +
        '<strong class="clash-stat-val is-down">' + speed(d.download_bps) + '</strong>' +
      '</div>' +
      '<div class="clash-stat-tile">' +
        '<span class="clash-stat-label">↑ 上传速率</span>' +
        '<strong class="clash-stat-val is-up">' + speed(d.upload_bps) + '</strong>' +
      '</div>' +
      '<div class="clash-stat-tile">' +
        '<span class="clash-stat-label">累计下载</span>' +
        '<strong class="clash-stat-val">' + bytes(d.download_total) + '</strong>' +
      '</div>' +
      '<div class="clash-stat-tile">' +
        '<span class="clash-stat-label">累计上传</span>' +
        '<strong class="clash-stat-val">' + bytes(d.upload_total) + '</strong>' +
      '</div>' +
    '</div>';

    return '<section class="clash-block">' +
      '<div class="clash-block-head">' +
        '<span class="clash-block-icon">⚡</span>' +
        '<h4 class="clash-block-title">速率与累计流量（刷新时采样）</h4>' +
      '</div>' +
      html +
      '<p class="clash-stat-note">速率为刷新瞬间的一次采样；累计流量为 Mihomo 进程本次运行以来的累计。</p>' +
    '</section>';
  }

  function runtimeBlock(d, modes) {
    var tunOk = d.tun_enabled === true;
    var tunText = tunOk ? "已开启" : (d.tun_enabled === false ? "已关闭" : "未知");
    var modeName = (modes && modes[d.mode]) || d.mode || "—";
    var profileName = (d.profile && (d.profile.name || d.profile.uid)) || "—";
    var memText = (typeof d.memory_bytes === "number") ? bytes(d.memory_bytes) : "—";

    var html = '<div class="clash-runtime-grid">' +
      '<div class="clash-stat-tile">' +
        '<span class="clash-stat-label">运行模式</span>' +
        '<strong class="clash-stat-val">' + escapeHtml(modeName) + '</strong>' +
      '</div>' +
      '<div class="clash-stat-tile">' +
        '<span class="clash-stat-label">TUN 网卡</span>' +
        '<strong class="clash-stat-val"><span class="clash-pill ' + (tunOk ? 'ok' : 'bad') + '">' + escapeHtml(tunText) + '</span></strong>' +
      '</div>' +
      '<div class="clash-stat-tile">' +
        '<span class="clash-stat-label">活动连接</span>' +
        '<strong class="clash-stat-val">' + (d.connection_count != null ? d.connection_count : '—') + '</strong>' +
      '</div>' +
      '<div class="clash-stat-tile">' +
        '<span class="clash-stat-label">内核版本</span>' +
        '<strong class="clash-stat-val" title="' + escapeHtml(d.version || '') + '">' + escapeHtml(d.version || '—') + '</strong>' +
      '</div>' +
      '<div class="clash-stat-tile">' +
        '<span class="clash-stat-label">内核内存</span>' +
        '<strong class="clash-stat-val">' + escapeHtml(memText) + '</strong>' +
      '</div>' +
      '<div class="clash-stat-tile">' +
        '<span class="clash-stat-label">当前配置</span>' +
        '<strong class="clash-stat-val" title="' + escapeHtml(profileName) + '">' + escapeHtml(profileName) + '</strong>' +
      '</div>' +
    '</div>';

    return '<section class="clash-block">' +
      '<div class="clash-block-head">' +
        '<span class="clash-block-icon">⚙️</span>' +
        '<h4 class="clash-block-title">内核与运行状态</h4>' +
      '</div>' +
      html +
    '</section>';
  }

  function routeBlock(d) {
    var mix = d.rule_mix || [];
    var mixHtml = "";
    if (mix.length) {
      mixHtml = '<div class="clash-rules-wrap">' + mix.map(function (m) {
        return '<span class="clash-rule-chip">' + escapeHtml(m.rule) + ' <strong>' + m.count + '</strong></span>';
      }).join("") + '</div>';
    }

    var active = (d.active_connections || []).filter(function (c) {
      // DIRECT chatter (Electron, apsd) drowns out the proxied traffic.
      return (c.chains || []).indexOf("DIRECT") === -1;
    });

    var connHtml = "";
    if (!active.length) {
      connHtml = '<div class="clash-empty-state">当前无走代理的活跃连接</div>';
    } else {
      var topActive = active.slice(0, 5);
      connHtml = '<div class="clash-conn-list">' + topActive.map(function (c) {
        var chainsText = (c.chains && c.chains.length) ? c.chains.join(" → ") : "—";
        var procText = c.process && c.process !== "—" ? c.process : "";
        return '<div class="clash-conn-item">' +
          '<div class="clash-conn-head">' +
            '<span class="clash-conn-host" title="' + escapeHtml(c.host) + '">' + escapeHtml(c.host) + '</span>' +
            (procText ? '<span class="clash-conn-proc">' + escapeHtml(procText) + '</span>' : '') +
          '</div>' +
          '<div class="clash-conn-foot">' +
            '<span class="clash-conn-chain" title="' + escapeHtml(chainsText) + '">' + escapeHtml(chainsText) + '</span>' +
            '<span class="clash-conn-bytes">' +
              '<span class="down">↓ ' + bytes(c.download) + '</span>' +
              '<span class="up">↑ ' + bytes(c.upload) + '</span>' +
            '</span>' +
          '</div>' +
        '</div>';
      }).join("") + '</div>';
    }

    return '<section class="clash-block">' +
      '<div class="clash-block-head">' +
        '<span class="clash-block-icon">🔀</span>' +
        '<h4 class="clash-block-title">路由观察与代理连接</h4>' +
      '</div>' +
      mixHtml +
      connHtml +
    '</section>';
  }

  function renderClashPreviewQuota(s) {
    var el = document.getElementById("clash-preview-quota");
    if (!el) return;
    if (!s || typeof s.total !== "number" || s.total <= 0) {
      el.className = "clash-preview-quota is-empty";
      el.textContent = "订阅配额不可用";
      return;
    }
    var used = typeof s.used === "number" ? s.used : 0;
    var pct = (used / s.total) * 100;
    var reset = (s.days_to_reset !== null && s.days_to_reset !== undefined)
      ? s.days_to_reset + " 天后重置" : "";
    el.className = "clash-preview-quota";
    el.innerHTML =
      '<div class="clash-preview-quota-head">' +
        '<span>订阅流量</span>' +
        '<strong>已用 ' + number(pct, 1) + '%</strong>' +
      '</div>' +
      progressBar(pct) +
      '<div class="clash-preview-quota-sub">' +
        escapeHtml("余 " + bytes(s.remaining) + " / 总量 " + bytes(s.total) + (reset ? " · " + reset : "")) +
      '</div>';
  }

  function renderClashPreviewCheckin(checkin) {
    var el = document.getElementById("clash-preview-checkin");
    if (!el) return;
    var label = DP.checkinLabel(checkin, todayBj());
    var statusText = label.text.replace(/^(?:今日签到|签到)\s*[·:：]\s*/, "");
    el.textContent = "签到：" + statusText;
    el.className = "clash-preview-checkin is-" + label.tone;
  }

  function fetchClash() {
    if (clashPending) return Promise.resolve();
    clashPending = true;
    var status = document.getElementById("clash-status");
    var content = document.getElementById("clash-content");
    var previewStatus = document.getElementById("clash-preview-status");
    var previewChain = document.getElementById("clash-preview-chain");
    var button = document.getElementById("clash-refresh");
    if (button) {
      button.disabled = true;
      button.classList.add("is-spinning");
    }
    applyClashStatus({
      loading: true,
      lastFetchedAt: lastMeta["clash"] ? lastMeta["clash"].fetched_at : null,
      meta: lastMeta["clash"],
    });
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 12000);
    return fetch("/api/clash", { cache: "no-store", signal: controller.signal })
      .then(function (res) {
        if (!res.ok) throw new Error("unavailable");
        return res.json();
      }).then(function (payload) {
        if (!payload.meta || !payload.meta.ok || !payload.data) throw new Error("unavailable");
        var d = payload.data;
        var modes = { rule: "规则模式", global: "全局模式", direct: "直连模式" };
        // Kernel liveness is not enough: a drifted egress is a real failure.
        // The badge reports overall health, not just whether the core answers.
        var exitAlive = !!d.exit_ip;
        var exitOk = exitAlive && d.exit_is_static !== false;
        var state = exitOk ? "ok" : "error";
        var stateText = exitAlive ? (exitOk ? "正常" : "异常") : "未探测";
        if (status) {
          status.textContent = stateText;
          status.className = "badge-status " + state;
          status.dataset.state = state;
        }
        if (previewStatus) {
          previewStatus.textContent = stateText;
          previewStatus.className = "badge-status " + state;
          previewStatus.dataset.state = state;
        }
        var dot = document.querySelector(".clash-dot");
        if (dot) dot.style.background = exitOk ? "var(--emerald)" : "var(--rose)";
        var chainText = chainLabel(d);
        if (previewChain) {
          var delay = d.entry ? d.entry.delay_ms : null;
          var delayHtml = "";
          if (typeof delay === "number") {
            var dState = delay <= 150 ? "ok" : delay <= 400 ? "warn" : "bad";
            delayHtml = ' · <span class="clash-preview-delay ' + dState + '">' +
              delay + " ms</span>";
          }
          previewChain.innerHTML = "当前所选链路：" + escapeHtml(chainText) + delayHtml;
        }
        var previewEntry = document.getElementById("clash-preview-entry");
        if (previewEntry) {
          var entry = d.entry;
          if (entry && entry.selected) {
            var alive = (typeof entry.alive === "number" && typeof entry.members === "number")
              ? "（" + entry.alive + "/" + entry.members + " 在线）"
              : "";
            previewEntry.innerHTML = "入口节点：" +
              '<span class="clash-preview-entry-name">' + escapeHtml(entry.selected) + "</span>" +
              '<span class="clash-preview-entry-meta">' + escapeHtml(alive) + "</span>";
          } else {
            previewEntry.textContent = "入口节点：未识别";
          }
        }
        renderClashPreviewQuota(d.subscription);
        renderClashPreviewCheckin(d.checkin);
        lastMeta["clash"] = payload.meta;
        applyClashStatus({
          loading: false,
          meta: payload.meta,
          lastFetchedAt: payload.meta ? payload.meta.fetched_at : null,
        });

        var html = "";
        html += linkBlock(d);
        html += quotaBlock(d.subscription, d.checkin);
        html += trafficBlock(d);
        html += runtimeBlock(d, modes);
        html += routeBlock(d);
        if (content) {
          content.innerHTML = html;
        }
      }).catch(function (err) {
        if (status) {
          status.textContent = "不可用";
          status.className = "badge-status error";
          status.dataset.state = "error";
        }
        if (previewStatus) {
          previewStatus.textContent = "不可用";
          previewStatus.className = "badge-status error";
          previewStatus.dataset.state = "error";
        }
        if (previewChain) {
          previewChain.textContent = "当前所选链路：链路未知";
        }
        var previewEntryFail = document.getElementById("clash-preview-entry");
        if (previewEntryFail) {
          previewEntryFail.textContent = "入口节点：未知";
        }
        renderClashPreviewQuota(null);
        var previewCheckinFail = document.getElementById("clash-preview-checkin");
        if (previewCheckinFail) {
          previewCheckinFail.textContent = "签到：未知";
          previewCheckinFail.className = "clash-preview-checkin is-muted";
        }
        var dot = document.querySelector(".clash-dot");
        if (dot) dot.style.background = "var(--rose)";
        if (content) {
          content.innerHTML = '<div class="clash-empty-state">无法连接本地 Clash / Mihomo 内核，当前代理状态未知。</div>';
        }
        applyClashStatus({
          loading: false,
          error: err || "unavailable",
          lastFetchedAt: lastMeta["clash"] ? lastMeta["clash"].fetched_at : null,
        });
      }).finally(function () {
        clearTimeout(timeout);
        clashPending = false;
        if (button) {
          button.disabled = false;
          button.classList.remove("is-spinning");
        }
      });
  }

  // 拉实时限流（无缓存、~130ms、零上游请求）并重画告警行。
  // 告警行只在有 429 时出现，所以这次取数轻量到可以随时发。
  function fetchLiveThrottles() {
    return fetch("/api/wb-throttles", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (payload) {
        liveThrottleCache = payload && payload.data ? payload.data : null;
        renderThrottleAlerts();
      })
      .catch(function () {
        // 实时接口不通就退回 wb 快照里的限流字段，不清掉已显示的告警。
        liveThrottleCache = null;
        renderThrottleAlerts();
      });
  }

  // 把实时限流数据覆盖到已渲染的两处告警（首页概览卡 + WB 详情卡），只动这两块。
  // 没有实时数据时退回 wb 快照的 accounts（可能过期，但不至于让告警消失）。
  function renderThrottleAlerts() {
    var accounts = null;
    if (liveThrottleCache && Array.isArray(liveThrottleCache.accounts)) {
      accounts = liveThrottleCache.accounts;
    } else if (payloadCache.wb && Array.isArray(payloadCache.wb.accounts)) {
      accounts = payloadCache.wb.accounts;
    }
    if (!accounts) return;
    var lines = accounts.map(wbThrottleLine).filter(Boolean).join("");

    var home = document.getElementById("preview-wb-bars");
    if (home) {
      var old = home.querySelector(".throttle-alert");
      if (old) old.remove();
      if (lines) home.insertAdjacentHTML("beforeend", '<div class="throttle-alert">' + lines + "</div>");
    }

    var detail = document.querySelector("#view-wb .throttle-alert");
    if (detail) {
      detail.innerHTML = lines;  // 无 429 时置空，块本身由 renderData 决定是否渲染
    }
  }

  function fetchAll(force) {
    // 任何一次全量取数（首屏或手动）都作废排队中的补拉，避免手动刷新后又自动打一轮。
    cancelOpenRefresh();
    var clashPromise = fetchClash();
    if (loadingAll) return Promise.resolve();
    loadingAll = true;
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.classList.add("is-loading");
    }

    var promises = keys.map(function (k) {
      return fetchKey(k, force);
    });
    // 限流是 60 秒瞬态，首屏/全量刷新后立刻补一次实时取数，别等 wb 的下个 TTL。
    promises.push(fetchLiveThrottles());
    if (clashPromise) promises.push(clashPromise);

    return Promise.all(promises).finally(function () {
      loadingAll = false;
      if (refreshButton) {
        refreshButton.disabled = false;
        refreshButton.classList.remove("is-loading");
      }
      var timeEl = document.getElementById("last-refresh-time");
      if (timeEl) {
        var now = new Date();
        var h = String(now.getHours()).padStart(2, "0");
        var m = String(now.getMinutes()).padStart(2, "0");
        var s = String(now.getSeconds()).padStart(2, "0");
        timeEl.textContent = "刷新时间: " + h + ":" + m + ":" + s;
      }
    });
  }

  // 首屏之后的收尾补拉：只追仍待更新的用量源——不重采样 Clash，也不重复请求已新鲜的源。
  // 双上限：最多 OPEN_REFRESH_MAX_ROUNDS 轮，且从打开页面起不超过 OPEN_REFRESH_DEADLINE_MS。
  function pendingKeys() {
    return keys.filter(function (k) {
      var m = lastMeta[k];
      return !!m && (m.stale || m.refresh_pending || m.refresh_error);
    });
  }

  function cancelOpenRefresh() {
    if (openRefreshTimer) {
      clearTimeout(openRefreshTimer);
      openRefreshTimer = null;
    }
  }

  function openRefresh() {
    var deadline = Date.now() + OPEN_REFRESH_DEADLINE_MS;
    var rounds = 0;
    function step() {
      if (rounds >= OPEN_REFRESH_MAX_ROUNDS) return;
      if (Date.now() >= deadline) return;
      if (!pendingKeys().length) return;
      rounds += 1;
      openRefreshTimer = setTimeout(function () {
        openRefreshTimer = null;
        var todo = pendingKeys();
        if (!todo.length) return;
        Promise.all(todo.map(function (k) { return fetchKey(k, false); })).then(step, step);
      }, OPEN_REFRESH_DELAY_MS);
    }
    step();
  }

  // 独立页面切换视图
  // Mac 详情页轮询：仅该视图可见且页面在前台时每 10 秒取一次。
  // 后端 mac 源 TTL 同步为 10 秒（CACHE_TTL_OVERRIDES），命中缓存时响应 <1 ms。
  var MAC_POLL_MS = 10000;
  var macPollTimer = null;

  function stopMacPolling() {
    if (macPollTimer) {
      clearInterval(macPollTimer);
      macPollTimer = null;
    }
  }

  function startMacPolling() {
    stopMacPolling();
    if (document.hidden) return;
    macPollTimer = setInterval(function () {
      if (document.hidden) return;
      var view = document.getElementById("view-mac");
      if (!view || view.classList.contains("is-hidden")) {
        stopMacPolling();
        return;
      }
      if (loadingAll) return;
      fetchKey("mac", false);
    }, MAC_POLL_MS);
  }

  function switchView(target) {
    if (!target) return;

    // 1. 切换分段控制器按钮激活状态
    var buttons = document.querySelectorAll(".segmented-control .seg-btn");
    buttons.forEach(function (b) {
      if (b.getAttribute("data-filter") === target) {
        b.classList.add("active");
        b.setAttribute("aria-current", "page");
      } else {
        b.classList.remove("active");
        b.removeAttribute("aria-current");
      }
    });

    // 2. 切换独立页面视图
    var viewPanels = {
      all: document.getElementById("view-all"),
      codex: document.getElementById("view-codex"),
      wb: document.getElementById("view-wb"),
      muse: document.getElementById("view-muse"),
      mac: document.getElementById("view-mac"),
      agy: document.getElementById("view-agy"),
      clash: document.getElementById("view-clash"),
    };

    Object.keys(viewPanels).forEach(function (k) {
      var p = viewPanels[k];
      if (!p) return;
      if (k === target) {
        p.classList.remove("is-hidden");
      } else {
        p.classList.add("is-hidden");
      }
    });

    if (target === "clash" || target === "all") fetchClash();
    // Mac 详情页：进入时立即取一次，之后仅在该视图可见且页面在前台时每 10 秒轮询。
    if (target === "mac") {
      fetchKey("mac", false);
      startMacPolling();
    } else {
      stopMacPolling();
    }
    // 打开首页或 WB 页时刷一次实时限流（60 秒瞬态，不能靠 wb 的缓存快照）。
    if (target === "all" || target === "wb") fetchLiveThrottles();

    // 3. 滚动到页面顶部
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // 首页总览预览卡片交互（点击直达对应详情页面）
  function initPreviewDeck() {
    var previewCards = document.querySelectorAll(".preview-deck .preview-card");
    previewCards.forEach(function (card) {
      function handleClick() {
        var target = card.getAttribute("data-target");
        if (target) {
          switchView(target);
        }
      }

      card.addEventListener("click", handleClick);
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      });
    });
  }

  // Segmented Control 切换卡片
  function initSegmentedControl() {
    var buttons = document.querySelectorAll(".segmented-control .seg-btn");
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var filter = btn.getAttribute("data-filter");
        switchView(filter);
      });
    });
  }

  // 绑定单个卡片刷新按钮
  function initCardActions() {
    keys.forEach(function (k) {
      var card = cardFor(k);
      if (!card) return;
      var btn = card.querySelector('[data-action="refresh"]');
      if (btn) {
        btn.addEventListener("click", function () {
          fetchKey(k, true);
        });
      }
    });

    if (refreshButton) {
      refreshButton.addEventListener("click", function () {
        fetchAll(true);
      });
    }
  }

  // WB「账号分项与积分包」标题里的「刷新积分」按钮：点击才触发真刷积分（force=1）。
  // 折叠块随每次取数重画，绑定走事件委托；进行状态存全局（wbPointsRefreshing）并
  // 同步到节点——避免重画（如币种切换）后新按钮丢失禁用/转圈态、被重复点击。
  function initWbPointsRefresh() {
    document.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest
        ? ev.target.closest('[data-action="wb-points-refresh"]')
        : null;
      if (!btn) return;
      // summary 内的默认点击会开合折叠面板——这里只让按钮动作生效
      ev.preventDefault();
      ev.stopPropagation();
      if (wbPointsRefreshing) return;   // 兜底：即便节点没带上 disabled 也不重复发请求
      wbPointsRefreshing = true;
      syncWbPointsButtons();
      fetchKey("wb", true).finally(function () {
        wbPointsRefreshing = false;
        syncWbPointsButtons();
      });
    });
  }

  // 币种切换：USD / CNY（按每日汇率折算显示，数据口径不变）
  function setUsdCny(info) {
    var normalized = null;
    if (info && isFinite(Number(info.rate)) && Number(info.rate) > 0) {
      normalized = {
        rate: Number(info.rate),
        day: String(info.day || ""),
        source: String(info.source || ""),
        stale: !!info.stale,
      };
    }
    var changed =
      (usdCnyInfo ? usdCnyInfo.rate : null) !== (normalized ? normalized.rate : null) ||
      (usdCnyInfo ? usdCnyInfo.day : null) !== (normalized ? normalized.day : null) ||
      (usdCnyInfo ? usdCnyInfo.stale : null) !== (normalized ? normalized.stale : null);
    usdCnyInfo = normalized;
    return changed;
  }

  function rerenderAll() {
    keys.forEach(function (k) {
      var data = payloadCache[k];
      var card = cardFor(k);
      if (!data || !card) return;
      var contentEl = card.querySelector('[data-role="content"]');
      if (contentEl) {
        contentEl.innerHTML = renderData(k, data);
      }
    });
    renderAllOverview(payloadCache);
    renderPriceSections(payloadCache);
    updateAnchorBlocks();
  }

  function updateCurrencyUi() {
    var buttons = document.querySelectorAll(".currency-switch .cur-btn");
    buttons.forEach(function (b) {
      if (b.getAttribute("data-cur") === currencyMode) {
        b.classList.add("active");
      } else {
        b.classList.remove("active");
      }
    });
    var note = document.getElementById("currency-note");
    if (!note) return;
    if (currencyMode === "CNY" && usdCnyInfo) {
      note.textContent = "≈" + number(usdCnyInfo.rate, 4) + (usdCnyInfo.stale ? "（旧）" : "");
      note.title = "1 USD = " + usdCnyInfo.rate + " CNY · " + usdCnyInfo.day + " · " + usdCnyInfo.source +
        (usdCnyInfo.stale ? " · 当日获取失败，回退旧值" : "");
    } else if (currencyMode === "CNY") {
      note.textContent = "汇率加载中";
      note.title = "尚未获取到汇率，金额暂按美元显示";
    } else {
      note.textContent = "";
      note.title = "";
    }
  }

  function initCurrencySwitch() {
    var buttons = document.querySelectorAll(".currency-switch .cur-btn");
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var mode = btn.getAttribute("data-cur");
        if (mode !== "CNY" && mode !== "USD") return;
        if (mode === currencyMode) return;
        currencyMode = mode;
        try {
          localStorage.setItem("dash-currency", currencyMode);
        } catch (e) {}
        rerenderAll();
        updateCurrencyUi();
      });
    });
    updateCurrencyUi();
  }

  // 初始化
  document.addEventListener("DOMContentLoaded", function () {
    keys.forEach(function (k) {
      applySourceStatus(k, { loading: true });
    });
    applyClashStatus({ loading: true });

    initPreviewDeck();
    initSegmentedControl();
    initCardActions();
    initWbPointsRefresh();
    initCurrencySwitch();
    document.getElementById("clash-preview").addEventListener("click", function () { switchView("clash"); });
    document.getElementById("clash-refresh").addEventListener("click", fetchClash);
    // 页面切回前台时，若仍在 Mac 详情页则恢复轮询；切到后台立即停。
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        stopMacPolling();
        return;
      }
      var macView = document.getElementById("view-mac");
      if (macView && !macView.classList.contains("is-hidden")) startMacPolling();
    });
    // 打开页面时取一次数（先缓存后补拉）；之后只由手动刷新触发。
    fetchAll(false).then(openRefresh, function () {});
  });
})();
