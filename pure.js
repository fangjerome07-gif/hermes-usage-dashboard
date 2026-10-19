/* DashPure — 看板纯函数（无 DOM 依赖；node 可直接测试，浏览器挂到 window.DashPure）。
 * 承载“日期窗口 / Token 口径 / 等值金额标注 / 剩余百分比”的共享逻辑，
 * app.js 只做装配与渲染，测试见 tests/test_pure.js。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DashPure = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  // 北京时间（UTC+8）最近 count 个自然日，"YYYY-MM-DD"，今天在最前。
  function recentBjDates(count, nowMs) {
    var now = nowMs != null ? new Date(nowMs) : new Date();
    var bjMs = now.getTime() + 8 * 3600 * 1000;
    var dates = [];
    for (var i = 0; i < count; i += 1) {
      var d = new Date(bjMs - i * 86400000);
      dates.push(d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()));
    }
    return dates;
  }

  function checkinClock(value) {
    if (!value) return null;
    var date = new Date(value);
    if (isNaN(date.getTime())) return null;
    var beijing = new Date(date.getTime() + 8 * 3600 * 1000);
    return pad2(beijing.getUTCHours()) + ":" + pad2(beijing.getUTCMinutes());
  }

  function checkinLabel(checkin, todayBj) {
    if (!checkin || checkin.date !== todayBj) {
      return { tone: "muted", text: "今日签到 · 待 08:05" };
    }
    var clock = checkinClock(checkin.checked_at);
    if (checkin.state === "success") {
      var gain = finiteNumber(checkin.gain_mb);
      var details = [];
      if (gain != null) details.push("+" + gain + " MB");
      if (clock) details.push(clock);
      return { tone: "ok", text: "签到" + (details.length ? " · " + details.join(" · ") : "") };
    }
    if (checkin.state === "already") {
      return { tone: "ok", text: "签到 · 今日已签" + (clock ? " · " + clock : "") };
    }
    if (checkin.state === "expired") {
      return { tone: "bad", text: "签到 · 登录态失效" };
    }
    return { tone: "warn", text: "签到 · 失败" };
  }

  // 已用百分比 -> 剩余百分比（用于文案与剩余量计算）。
  function remainingPct(used) {
    var u = Number(used);
    if (!isFinite(u)) return null;
    return Math.max(0, Math.min(100, 100 - u));
  }

  // 已用百分比对应的配额颜色档位（≥90% 红、≥80% 黄）。
  function barColor(used) {
    var u = Number(used);
    if (!isFinite(u)) return "ok";
    if (u >= 90) return "danger";
    if (u >= 80) return "warning";
    return "ok";
  }

  // 磁盘专用已用百分比颜色档位（已用 ≥90% 红、≥80% 黄）。
  function diskBarColor(used) {
    if (used == null || used === "") return "ok";
    var u = Number(used);
    if (!isFinite(u)) return "ok";
    if (u >= 90) return "danger";
    if (u >= 80) return "warning";
    return "ok";
  }

  function hasRealError(value) {
    return typeof value === "string" && value !== "" && value.indexOf("0001-01-01") !== 0;
  }

  // Match only the known archive-coverage caveats. Operational failures stay visible.
  function isStaticDataCaveat(text) {
    if (typeof text !== "string") return false;
    var value = text.trim().replace(/^(?:⚠️\s*)+/, "").replace(/\s+/g, " ").toLowerCase();
    if (!value) return false;
    if (/^近\s*7\s*天/.test(value)) {
      if (/total[_ ]?tokens/.test(value) && /(部分请求|未提供)/.test(value)) return true;
      if (/缓存命中/.test(value) && /(细分|缓存率|相关费用)/.test(value)) return true;
      if (/reasoning[_ ]tokens/.test(value) && /(请求归档|字段|推理)/.test(value)) return true;
      if (/credit[_ ]known/.test(value) && /积分/.test(value)) return true;
      if (/ttfb[_ ]ms/.test(value) && /(部分请求|归档)/.test(value)) return true;
    }
    if (/^panel\s*请求归档/.test(value) && /reasoning[_ ]tokens/.test(value)) return true;
    if (/^有请求/.test(value) && /credit[_ ]known/.test(value) && /积分/.test(value)) return true;
    if (/^部分请求/.test(value) && /ttfb[_ ]ms/.test(value)) return true;
    return false;
  }

  function wbUnknownRealmSummary(rows) {
    var groups = [];
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (!row || !(row.unknownRealm === true ||
          (Object.prototype.hasOwnProperty.call(row, "realm") && row.realm !== "cn" && row.realm !== "intl"))) return;
      groups.push({ model: String(row.model || "未知模型"), calls: finiteNumber(row.calls) || 0 });
    });
    if (!groups.length) return null;
    return {
      groups: groups,
      totalGroups: groups.length,
      totalCalls: groups.reduce(function (sum, group) { return sum + group.calls; }, 0),
    };
  }

  // WB 的 prompt 口径已包含 cached：拆成“未缓存输入 + 缓存读”，避免总数重复。
  function wbTokenSplit(prompt, cached) {
    var p = prompt == null || prompt === "" ? null : Number(prompt);
    var c = cached == null || cached === "" ? null : Number(cached);
    if (p != null && !isFinite(p)) p = null;
    if (c != null && !isFinite(c)) c = null;
    if (p == null && c == null) return null;
    // Neither side can be inferred from the other. Keep the unknown side
    // visible instead of silently turning a missing field into zero.
    if (p == null) return { uncached: null, read: Math.max(0, c) };
    if (c == null) return { uncached: null, read: null };
    var read = Math.min(Math.max(0, p), Math.max(0, c));
    return { uncached: Math.max(0, p - read), read: read };
  }

  function finiteNumber(value) {
    if (value == null || value === "") return null;
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : null;
  }

  // Keep the three displayed WB token columns on the same contract as the
  // source fields; a missing component remains unknown rather than zero.
  function wbTokenColumns(row) {
    row = row && typeof row === "object" ? row : {};
    var split = wbTokenSplit(row.prompt_tokens, row.cached_tokens);
    var output = finiteNumber(row.completion_tokens);
    if (!split && output == null) return null;
    return {
      input: split ? split.uncached : null,
      cache_read: split ? split.read : null,
      output: output,
    };
  }

  // Preserve partial totals and sample counts for WB metrics. Null full totals
  // stay unknown; callers may display a known lower bound with its coverage.
  function wbMetricState(row, metric) {
    if (!row || typeof row !== "object") return null;
    var specs = {
      tokens: ["tokens", "tokens_known_total", "tokens_known_count", "tokens_missing_count", "tokens_complete"],
      prompt_tokens: ["prompt_tokens", "prompt_tokens_known_total", "prompt_tokens_known_count", "prompt_tokens_missing_count", "prompt_complete"],
      cached_tokens: ["cached_tokens", "cached_tokens_known_total", "cached_tokens_known_count", "cached_tokens_missing_count", "cache_complete"],
      completion_tokens: ["completion_tokens", "completion_tokens_known_total", "completion_tokens_known_count", "completion_tokens_missing_count", "completion_complete"],
      reasoning_tokens: ["reasoning_tokens", "reasoning_tokens_known_total", "reasoning_tokens_known_count", "reasoning_tokens_missing_count", "reasoning_complete"],
      credits: ["credits", "credits_known_total", "credits_known_count", "credits_missing_count", "credits_complete"],
    };
    var spec = specs[metric];
    if (!spec && metric === "reasoning") {
      spec = ["reasoning", "reasoning_known_total", "reasoning_known_count", "reasoning_missing_count", "reasoning_complete"];
    }
    if (!spec) return null;
    var samples = finiteNumber(row.requests);
    if (samples == null) samples = finiteNumber(row.calls);
    if (samples == null || samples < 0) samples = 0;
    var value = finiteNumber(row[spec[0]]);
    var knownTotal = finiteNumber(row[spec[1]]);
    if (knownTotal == null && value != null) knownTotal = value;
    var completeFlag = row[spec[4]];
    var knownCount = finiteNumber(row[spec[2]]);
    if (knownCount == null) {
      if (completeFlag === true || value != null) knownCount = samples;
      else if (knownTotal != null && knownTotal !== 0) knownCount = null;
      else knownCount = 0;
    }
    if (knownCount != null) knownCount = Math.max(0, Math.min(samples, knownCount));
    var missingCount = finiteNumber(row[spec[3]]);
    if (missingCount == null) missingCount = knownCount == null ? null : Math.max(0, samples - knownCount);
    if (missingCount != null) missingCount = Math.max(0, Math.min(samples, missingCount));
    var complete = completeFlag !== false && missingCount === 0;
    if (samples === 0) {
      complete = true;
      knownTotal = value == null ? 0 : value;
      knownCount = 0;
      missingCount = 0;
    }
    return {
      value: value,
      knownTotal: knownTotal,
      knownCount: knownCount,
      missingCount: missingCount,
      samples: samples,
      complete: complete,
    };
  }

  // Shared cost-state accumulator: known amounts add up, while missing or
  // explicitly partial contributions remain visible to the renderer.
  function amountBucket() {
    return { value: 0, known: false, partial: false, hasUsage: false };
  }

  function addAmount(bucket, value, partial, hasUsage) {
    if (!bucket || !hasUsage) return bucket;
    bucket.hasUsage = true;
    var parsed = finiteNumber(value);
    if (parsed == null) {
      bucket.partial = true;
    } else {
      bucket.value += parsed;
      bucket.known = true;
    }
    if (partial) bucket.partial = true;
    return bucket;
  }

  function escapeAttr(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // 等值金额缺失/不完整：返回 HTML 前缀与标记，绝不按 0 静默处理。
  function wbEquivMark(info, usd, hasUsage) {
    if (!hasUsage) return { prefix: "", markHtml: "" };
    var partial = !!(info && info.complete === false);
    var missing = usd == null;
    if (!partial && !missing) return { prefix: "", markHtml: "" };
    var tip;
    if (missing) {
      tip = "WB 等值金额暂不可用（计价引擎不可用或未产生可用计价）";
    } else {
      tip = "WB 等值金额不完整：" + (Number(info.unpriced) || 0) + " 条请求未计价";
      var models = info.unpriced_models || [];
      if (models.length) tip += "（" + models.join("、") + "）";
    }
    return {
      prefix: "≥",
      markHtml: '<span class="partial-mark" title="' + escapeAttr(tip) + '">*</span>',
    };
  }

  // 「模型价格」折叠排序：按常用度（窗口内调用数）降序在前；调数为 0/缺失的
  // 模型保持价表原顺序排在后面（稳定，不重排）。
  function usageFirstOrder(ids, callsByModel) {
    var used = [];
    var unused = [];
    (ids || []).forEach(function (id, index) {
      var calls = callsByModel ? Number(callsByModel[id]) : 0;
      if (isFinite(calls) && calls > 0) {
        used.push({ id: id, calls: calls, index: index });
      } else {
        unused.push(id);
      }
    });
    used.sort(function (a, b) { return b.calls - a.calls || a.index - b.index; });
    return used.map(function (row) { return row.id; }).concat(unused);
  }

  function wbFmtVal(value) {
    if (value == null || value === "") return "—";
    var n = Number(value);
    if (!isFinite(n)) return "—";
    return String(n);
  }

  function wbRatesLine(prefix, scope, row, keyMap) {
    if (!row || typeof row !== "object") return null;
    var bits = [];
    keyMap.forEach(function (pair) {
      if (row[pair[0]] == null) return;
      bits.push(pair[1] + " " + wbFmtVal(row[pair[0]]));
    });
    if (!bits.length) return null;
    return prefix + (scope ? " " + scope : "") + "：" + bits.join(" · ");
  }

  var WB_DUAL_KEYS = [["cache_miss", "未命中"], ["cache_hit", "缓存"], ["output", "输出"]];
  var WB_SHORT_KEYS = [["input", "输入"], ["cached_input", "缓存输入"], ["cache_write", "缓存写"], ["output", "输出"]];
  var WB_FLAT_KEYS = [["input", "输入"], ["cache_hit", "缓存命中"], ["output", "输出"],
                      ["cache_write_5min", "缓存写(5分钟)"], ["cache_write_1h", "缓存写(1小时)"]];
  var WB_PROMO_KEYS = [["input", "输入"], ["cache_hit", "缓存命中"], ["output", "输出"]];

  // WB 价目条目 -> 展示行（纯文本；HTML 装配在 app.js）。
  // 覆盖 wb.json 的四种结构：usd/cny 双档（DeepSeek）、short/long（OpenAI/xAI）、
  // 单档（腾讯/智谱/Kimi/Google）、standard=null（暂未公布）。
  function wbPriceBlock(entry) {
    var out = { lines: [], notes: [] };
    if (!entry || typeof entry !== "object") {
      out.lines.push("价格数据不可用");
      return out;
    }
    if (entry.usd || entry.cny) {
      [["USD/1M", entry.usd], ["CNY/1M", entry.cny]].forEach(function (pair) {
        var obj = pair[1];
        if (!obj || typeof obj !== "object") return;
        var peak = wbRatesLine(pair[0], "高峰", obj.peak, WB_DUAL_KEYS);
        var off = wbRatesLine(pair[0], "空闲", obj.off_peak, WB_DUAL_KEYS);
        if (peak) out.lines.push(peak);
        if (off) out.lines.push(off);
      });
      out.notes.push("空闲时段价格=高峰的一半；高峰=工作日 9:00-12:00、14:00-18:00（北京时间，法定节假日除外）");
      return out;
    }
    var standard = entry.standard;
    if (standard === null) {
      out.lines.push("官网暂未公布价格");
      if (entry.note) out.notes.push(entry.note);
      return out;
    }
    if (!standard || typeof standard !== "object") {
      out.lines.push("价格数据不可用");
      return out;
    }
    var unit = entry.currency === "CNY" ? "CNY/1M" : "USD/1M";
    if (standard.short || standard.long) {
      var shortLine = wbRatesLine(unit, "短档", standard.short, WB_SHORT_KEYS);
      var longLine = wbRatesLine(unit, "长档", standard.long, WB_SHORT_KEYS);
      if (shortLine) out.lines.push(shortLine);
      if (longLine) out.lines.push(longLine);
      var thr = standard.long_threshold_tokens;
      if (thr != null && isFinite(Number(thr))) {
        out.notes.push("长档阈值：输入 " + (entry.vendor === "xAI" ? "≥" : ">") + (Number(thr) / 1000) + "K tokens");
      } else if (entry.vendor === "OpenAI") {
        out.notes.push("长档阈值：单请求输入 >272K tokens");
      }
    } else {
      var flatLine = wbRatesLine(unit, "", standard, WB_FLAT_KEYS);
      if (flatLine) out.lines.push(flatLine);
    }
    var promo = entry.promo;
    if (promo && typeof promo === "object") {
      var promoLine = wbRatesLine(unit, promo.label || "促销", promo, WB_PROMO_KEYS);
      if (promoLine) out.lines.push(promoLine);
    }
    if (entry.note) out.notes.push(entry.note);
    return out;
  }

  // WB 逐日模型数据（usage.daily[].models）-> 指定日期集合内按（模型, 出口）
  // 聚合，按消耗积分降序（同分按调用数、再按模型名）。用于「模型消耗排行」与价格块排序。
  function wbModelUsageRows(dailyList, daySet) {
    var map = {};
    (Array.isArray(dailyList) ? dailyList : []).forEach(function (ds) {
      if (!ds || (daySet && !daySet[ds.day])) return;
      (Array.isArray(ds.models) ? ds.models : []).forEach(function (m) {
        if (!m || !m.model) return;
        var realm = m.realm === "cn" || m.realm === "intl" ? m.realm : "unknown";
        var intl = realm === "intl";
        var key = m.model + "::" + realm;
        var ent = map[key];
        if (!ent) {
          ent = map[key] = {
            model: m.model, realm: realm, intl: intl, calls: 0, tokens: 0, credits: 0, reasoning: 0,
            tokensComplete: true, tokensKnownTotal: 0, tokensKnownCount: 0,
            creditsComplete: true, creditsKnownTotal: 0, creditsKnownCount: 0,
            reasoningComplete: true, reasoningKnownTotal: 0, reasoningKnownCount: 0,
            prompt_tokens: 0, prompt_tokens_complete: true, prompt_tokens_known_total: 0, prompt_tokens_known_count: 0,
            cached_tokens: 0, cached_tokens_complete: true, cached_tokens_known_total: 0, cached_tokens_known_count: 0,
            completion_tokens: 0, completion_tokens_complete: true, completion_tokens_known_total: 0, completion_tokens_known_count: 0,
            usd: null, usdPartial: false,
          };
        }
        ent.calls += Number(m.calls) || 0;
        var modelCalls = Number(m.calls) || 0;
        var totalTokens = m.tokens == null || m.tokens === "" ? null : Number(m.tokens);
        var totalKnown = m.tokens_known_total == null ? totalTokens : Number(m.tokens_known_total);
        var totalKnownCount = m.tokens_known_count == null
          ? (m.tokens_complete === false ? (totalTokens == null ? 0 : modelCalls) : modelCalls)
          : Number(m.tokens_known_count);
        if (totalKnown != null && isFinite(totalKnown)) ent.tokensKnownTotal += totalKnown;
        if (isFinite(totalKnownCount)) ent.tokensKnownCount += totalKnownCount;
        if (m.tokens_complete === false || totalTokens == null || !isFinite(totalTokens)) ent.tokensComplete = false;
        else ent.tokens += totalTokens;
        var modelCredits = m.credits == null || m.credits === "" ? null : Number(m.credits);
        var modelCreditsKnown = m.credits_known_total == null || m.credits_known_total === ""
          ? modelCredits : Number(m.credits_known_total);
        if (modelCreditsKnown != null && isFinite(modelCreditsKnown)) ent.creditsKnownTotal += modelCreditsKnown;
        else ent.creditsComplete = false;
        var modelCreditCount = m.credits_known_count == null
          ? (m.credits_complete === false ? (modelCredits == null ? 0 : modelCalls) : modelCalls)
          : Number(m.credits_known_count);
        if (isFinite(modelCreditCount)) ent.creditsKnownCount += modelCreditCount;
        if (m.credits_complete === false || modelCredits == null || !isFinite(modelCredits)) ent.creditsComplete = false;
        else ent.credits += modelCredits;
        var reasoning = m.reasoning == null || m.reasoning === "" ? null : Number(m.reasoning);
        var reasoningKnown = m.reasoning_known_total == null ? reasoning : Number(m.reasoning_known_total);
        var reasoningCount = m.reasoning_known_count == null
          ? (m.reasoning_complete === false ? (reasoning == null ? 0 : modelCalls) : modelCalls)
          : Number(m.reasoning_known_count);
        if (reasoningKnown != null && isFinite(reasoningKnown)) ent.reasoningKnownTotal += reasoningKnown;
        if (isFinite(reasoningCount)) ent.reasoningKnownCount += reasoningCount;
        if (m.reasoning_complete === false || reasoning == null || !isFinite(reasoning)) ent.reasoningComplete = false;
        else ent.reasoning += reasoning;
        var promptTokens = m.prompt_tokens == null || m.prompt_tokens === "" ? null : Number(m.prompt_tokens);
        var promptKnown = m.prompt_tokens_known_total == null ? promptTokens : Number(m.prompt_tokens_known_total);
        var promptCount = m.prompt_tokens_known_count == null
          ? (m.prompt_complete === false ? (promptTokens == null ? 0 : modelCalls) : modelCalls)
          : Number(m.prompt_tokens_known_count);
        if (promptKnown != null && isFinite(promptKnown)) ent.prompt_tokens_known_total += promptKnown;
        if (isFinite(promptCount)) ent.prompt_tokens_known_count += promptCount;
        var cachedTokens = m.cached_tokens == null || m.cached_tokens === "" ? null : Number(m.cached_tokens);
        var cachedKnown = m.cached_tokens_known_total == null ? cachedTokens : Number(m.cached_tokens_known_total);
        var cachedCount = m.cached_tokens_known_count == null
          ? (m.cache_complete === false ? (cachedTokens == null ? 0 : modelCalls) : modelCalls)
          : Number(m.cached_tokens_known_count);
        if (cachedKnown != null && isFinite(cachedKnown)) ent.cached_tokens_known_total += cachedKnown;
        if (isFinite(cachedCount)) ent.cached_tokens_known_count += cachedCount;
        var completionTokens = m.completion_tokens == null || m.completion_tokens === "" ? null : Number(m.completion_tokens);
        var completionKnown = m.completion_tokens_known_total == null ? completionTokens : Number(m.completion_tokens_known_total);
        var completionCount = m.completion_tokens_known_count == null
          ? (m.completion_complete === false ? (completionTokens == null ? 0 : modelCalls) : modelCalls)
          : Number(m.completion_tokens_known_count);
        if (completionKnown != null && isFinite(completionKnown)) ent.completion_tokens_known_total += completionKnown;
        if (isFinite(completionCount)) ent.completion_tokens_known_count += completionCount;
        if (promptTokens == null || !isFinite(promptTokens)) ent.prompt_tokens_complete = false;
        else ent.prompt_tokens += promptTokens;
        if (cachedTokens == null || !isFinite(cachedTokens)) ent.cached_tokens_complete = false;
        else ent.cached_tokens += cachedTokens;
        if (completionTokens == null || !isFinite(completionTokens)) ent.completion_tokens_complete = false;
        else ent.completion_tokens += completionTokens;
        // usd：null=从未有计价贡献；usdPartial=有调用行缺金额（展示时加 ≥，不按 0 静默）；
        // m.usd_partial=数据源标记「该（模型,出口）当日存在未计价请求」，即使 usd 存在也要加 ≥
        if (m.usd_partial === true) ent.usdPartial = true;
        if (typeof m.usd === "number" && isFinite(m.usd)) {
          ent.usd = (ent.usd == null ? 0 : ent.usd) + m.usd;
        } else if ((Number(m.calls) || 0) > 0) {
          ent.usdPartial = true;
        }
      });
    });
    var rows = Object.keys(map).map(function (key) {
      var row = map[key];
      if (!row.tokensComplete) row.tokens = null;
      if (!row.creditsComplete) row.credits = null;
      if (!row.reasoningComplete) row.reasoning = null;
      row.tokens_known_total = row.tokensKnownTotal;
      row.tokens_known_count = row.tokensKnownCount;
      row.tokens_missing_count = Math.max(0, row.calls - row.tokensKnownCount);
      row.tokens_complete = row.tokensComplete;
      row.credits_known_total = row.creditsKnownTotal;
      row.credits_known_count = row.creditsKnownCount;
      row.credits_missing_count = Math.max(0, row.calls - row.creditsKnownCount);
      row.credits_complete = row.creditsComplete;
      row.reasoning_known_total = row.reasoningKnownTotal;
      row.reasoning_known_count = row.reasoningKnownCount;
      row.reasoning_missing_count = Math.max(0, row.calls - row.reasoningKnownCount);
      row.reasoning_complete = row.reasoningComplete;
      row.prompt_tokens_known_total = row.prompt_tokens_known_total;
      row.prompt_tokens_known_count = row.prompt_tokens_known_count;
      row.prompt_tokens_missing_count = Math.max(0, row.calls - row.prompt_tokens_known_count);
      row.prompt_complete = row.prompt_tokens_complete;
      row.cached_tokens_known_total = row.cached_tokens_known_total;
      row.cached_tokens_known_count = row.cached_tokens_known_count;
      row.cached_tokens_missing_count = Math.max(0, row.calls - row.cached_tokens_known_count);
      row.cache_complete = row.cached_tokens_complete;
      row.completion_tokens_known_total = row.completion_tokens_known_total;
      row.completion_tokens_known_count = row.completion_tokens_known_count;
      row.completion_tokens_missing_count = Math.max(0, row.calls - row.completion_tokens_known_count);
      row.completion_complete = row.completion_tokens_complete;
      if (!row.prompt_tokens_complete) row.prompt_tokens = null;
      if (!row.cached_tokens_complete) row.cached_tokens = null;
      if (!row.completion_tokens_complete) row.completion_tokens = null;
      delete row.tokensComplete;
      delete row.tokensKnownTotal;
      delete row.tokensKnownCount;
      delete row.creditsKnownTotal;
      delete row.creditsKnownCount;
      delete row.creditsComplete;
      delete row.reasoningKnownTotal;
      delete row.reasoningKnownCount;
      delete row.reasoningComplete;
      delete row.prompt_tokens_complete;
      delete row.cached_tokens_complete;
      delete row.completion_tokens_complete;
      return row;
    });
    rows.sort(function (a, b) {
      return b.credits_known_total - a.credits_known_total || b.calls - a.calls ||
        (a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
    });
    return rows;
  }

  // WB 账号列表 -> 按模型汇总的「当前限流」行（模型级冷却，含恢复时刻）。
  // 同一模型可能被多个账号冷却，取最早的恢复时刻作为该模型的恢复时间。
  // 只统计 model_cooldowns：账号级 in_cooldown 是整账号不可用，不是模型限流。
  function wbThrottleRows(accounts, nowMs) {
    var now = nowMs != null ? Number(nowMs) : Date.now();
    var map = {};
    (Array.isArray(accounts) ? accounts : []).forEach(function (a) {
      if (!a) return;
      var cds = a.model_cooldowns;
      if (!Array.isArray(cds)) return;
      cds.forEach(function (c) {
        if (!c || !c.model) return;
        var until = Number(c.until);
        if (!isFinite(until) || until * 1000 <= now) return; // 已到期的不算在限
        var ent = map[c.model];
        if (!ent) {
          ent = map[c.model] = { model: c.model, accounts: 0, until: until };
        }
        ent.accounts += 1;
        if (until < ent.until) ent.until = until;
      });
    });
    return Object.keys(map).map(function (k) {
      var row = map[k];
      row.leftSec = Math.max(0, Math.round((row.until * 1000 - now) / 1000));
      var d = new Date(row.until * 1000);
      row.recoverClock = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
      return row;
    }).sort(function (a, b) {
      return a.until - b.until || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
    });
  }

  // 限流恢复时刻文案（epoch 秒 → 本地 "HH:MM"），无效值返回 "—"。
  function wbThrottleClock(untilSec) {
    var n = Number(untilSec);
    if (!isFinite(n) || n <= 0) return "—";
    var d = new Date(n * 1000);
    if (isNaN(d.getTime())) return "—";
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  // 限流剩余时长文案：分钟级够用，超过 1 小时切小时档。
  function wbThrottleLeftText(sec) {
    var s = Number(sec);
    if (!isFinite(s) || s <= 0) return "即将恢复";
    if (s < 60) return Math.round(s) + " 秒";
    if (s < 3600) return Math.round(s / 60) + " 分钟";
    return (s / 3600).toFixed(1) + " 小时";
  }

  // 采样时间格式化：当日只显示 "HH:MM:SS"，跨日补 "MM-DD HH:MM:SS"
  function formatUpdatedClock(isoString, nowMs) {
    if (!isoString) return null;
    var date = new Date(isoString);
    if (isNaN(date.getTime())) return null;
    var now = nowMs != null ? new Date(nowMs) : new Date();
    var clock = pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
    var sameDay = date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    if (sameDay) return clock;
    return pad2(date.getMonth() + 1) + "-" + pad2(date.getDate()) + " " + clock;
  }

  // 看板各用量源（及 Clash）更新时间文案判定（纯函数，无 DOM 依赖）。
  // 口径规则：
  // 1. 请求在途中或首屏无数据 -> 主文案「更新中」
  // 2. 取数失败且无旧数据 -> 「更新失败」；有旧数据但刷新失败 -> 「更新于 <旧时间>（刷新失败）」
  // 3. 后端明确标了数据不新鲜（stale=true 或 refresh_pending=true）-> 主文案「更新中」，旧时间作为 title
  // 4. 数据是当前的（当次真实取数，或后端 TTL 内的缓存副本）-> 「更新于 HH:MM:SS」（跨天补 MM-DD）
  //    注意 from_cache=true 只表示"这份是服务端缓存副本"，不等于不新鲜：server.py 只在缓存
  //    超过 TTL 时才置 stale/refresh_pending，TTL 内的缓存就是当前值——据此判「更新中」会让
  //    标签常亮「更新中」（2026-10-10 实测踩过）。TTL 数值只留在 server.py，前端不复制一份。
  function formatUpdateStatus(options, nowMs) {
    options = options || {};
    var loading = !!options.loading;
    var meta = options.meta || null;
    var error = options.error;
    var lastFetchedAt = options.lastFetchedAt || (meta ? meta.fetched_at : null);
    var ageSeconds = options.ageSeconds != null ? options.ageSeconds : (meta ? meta.age_seconds : null);
    var fromCache = options.fromCache != null ? !!options.fromCache : (meta ? !!meta.from_cache : false);
    var stale = options.stale != null ? !!options.stale : (meta ? !!meta.stale : false);
    var refreshPending = options.refreshPending != null ? !!options.refreshPending : (meta ? !!meta.refresh_pending : false);
    var refreshError = options.refreshError != null ? options.refreshError : (meta ? meta.refresh_error : null);
    var ok = meta ? meta.ok !== false : true;

    // 1. 请求在途中 / 加载中
    if (loading) {
      var clockPending = formatUpdatedClock(lastFetchedAt, nowMs);
      return {
        text: "更新中",
        title: clockPending ? "正在刷新（上次更新于 " + clockPending + "）" : "正在获取最新数据",
        isFresh: false,
      };
    }

    // 2. 取数失败（直接报错、meta.ok 为 false、或有旧缓存但后台刷新失败且未在重试）
    var isFailed = !!error || !ok || (!!refreshError && !refreshPending);
    if (isFailed) {
      var clockFail = formatUpdatedClock(lastFetchedAt, nowMs);
      if (clockFail) {
        var failReason = refreshError || (error && error.message) || (typeof error === "string" ? error : "");
        var failTitle = "刷新失败" + (failReason ? ": " + failReason : "") + " · 当前显示上次数据（" + clockFail + "）";
        return {
          text: "更新于 " + clockFail + "（刷新失败）",
          title: failTitle,
          isFresh: false,
        };
      }
      return {
        text: "更新失败",
        title: "数据获取失败" + (error ? ": " + ((error && error.message) || error) : ""),
        isFresh: false,
      };
    }

    // 3. 首屏无数据
    if (!meta && !lastFetchedAt) {
      return {
        text: "更新中",
        title: "正在获取最新数据",
        isFresh: false,
      };
    }

    // 4. 后端明确标了不新鲜（缓存已过 TTL，或后台正在刷新）
    if (stale || refreshPending) {
      var clockCache = formatUpdatedClock(lastFetchedAt, nowMs);
      var cacheTitle = clockCache ? "上次更新于 " + clockCache : "更新中";
      if (ageSeconds != null && isFinite(Number(ageSeconds))) {
        cacheTitle += " · 缓存 " + Number(ageSeconds) + "s";
      }
      if (refreshPending) {
        cacheTitle += refreshError ? " · 正在重试刷新（上次失败）" : " · 正在刷新";
      }
      return {
        text: "更新中",
        title: cacheTitle,
        isFresh: false,
      };
    }

    // 5. 数据是当前的（当次真实取数，或后端 TTL 内的缓存副本）
    var clockFresh = formatUpdatedClock(lastFetchedAt, nowMs);
    if (clockFresh) {
      return {
        text: "更新于 " + clockFresh,
        title: "更新于 " + clockFresh + (fromCache ? " · 后端缓存（TTL 内）" : " · 当次取数"),
        isFresh: true,
      };
    }

    return {
      text: "更新中",
      title: "更新中",
      isFresh: false,
    };
  }

  // 账号登录凭证剩余寿命文案（来自网关账号）：无效/缺失 -> ""（调用方隐藏）；
  // 已过期 -> "已过期"；否则 "剩余 X.X 天"（最多 1 位小数，整数不带尾零）。
  function expiryLeftText(expiresAt, nowMs) {
    var exp = expiresAt == null || expiresAt === "" ? NaN : Number(expiresAt);
    if (!isFinite(exp) || exp <= 0) return "";
    var now = nowMs != null ? Number(nowMs) : Date.now();
    var days = (exp * 1000 - now) / 86400000;
    if (days <= 0) return "已过期";
    return "剩余 " + (+days.toFixed(1)) + " 天";
  }

  // Muse 周额度重置时间中文化。上游两种写法都出现过，逐个实测互证过：
  //   "Oct 12 at 3:32 PM CST" —— CST=中国标准时间（UTC+8），直接用；
  //   "Oct 12 at 7:32 AM UTC" —— 同一时刻的 UTC 写法（7:32+8=15:32），需 +8 换算，可能跨日。
  // 解析不了就原样返回（不猜、不显示错误）。
  function museResetCn(text) {
    if (text == null) return text;
    var m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s+(CST|UTC)$/.exec(String(text).trim());
    if (!m) return String(text);
    var months = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
    var mon = months[m[1]];
    if (!mon) return String(text);
    var hour = parseInt(m[3], 10);
    if (m[5] === "PM" && hour !== 12) hour += 12;
    if (m[5] === "AM" && hour === 12) hour = 0;
    var day = parseInt(m[2], 10);
    if (m[6] === "UTC") {
      // UTC → 北京时间 +8，超过 24 点即跨到次日（不判月末：上游只给"月 日"，
      // 没有年份，按当月天数进位会引入年份/闰年假设，这里只在日期上 +1 天）。
      hour += 8;
      if (hour >= 24) {
        hour -= 24;
        day += 1;
      }
    }
    var hh = (hour < 10 ? "0" : "") + hour;
    return mon + "月" + day + "日 " + hh + ":" + m[4] + "（北京时间）";
  }

  // agy 额度重置时间：ISO UTC（如 "2026-10-23T07:00:46Z"）→ 北京时间文案。
  // 解析不了就原样返回（不猜、不显示错误）。
  function agyResetCn(iso) {
    if (iso == null) return iso;
    var d = new Date(String(iso));
    if (isNaN(d.getTime())) return String(iso);
    var bj = new Date(d.getTime() + 8 * 3600000);
    var mon = bj.getUTCMonth() + 1;
    var day = bj.getUTCDate();
    var hh = bj.getUTCHours();
    var mm = bj.getUTCMinutes();
    return mon + "月" + day + "日 " + (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm + "（北京时间）";
  }

  // WorkBuddy realm → 徽标：cn=国内版 / intl=国际版 / 其他=未知（不猜方向）。
  // text = 完整展示文案（含"出口："前缀）；tone = 样式类后缀（realm-pill is-<tone>）。
  function realmLabel(realm) {
    if (realm === "cn") return { text: "出口：🇨🇳 国内版", tone: "cn" };
    if (realm === "intl") return { text: "出口：🌐 国际版", tone: "intl" };
    return { text: "出口：未知", tone: "unknown" };
  }

  // Tavily key 状态行：'当前 · pool-A · 剩 229/1000'；查询失败如实标注，不编数字。
  function tavilyKeyLine(entry, isActive) {
    var label = entry && entry.label != null && String(entry.label) !== "" ? String(entry.label) : "未命名";
    var prefix = isActive ? "当前 · " : "";
    if (!entry || entry.query_ok !== true) {
      return prefix + label + " · 查询失败";
    }
    var used = entry.used;
    var limit = entry.limit;
    var remaining = entry.remaining;
    if (remaining == null && used != null && limit != null) {
      remaining = limit - used;
    }
    if (remaining != null && limit != null) {
      return prefix + label + " · 剩 " + remaining + "/" + limit;
    }
    return prefix + label + " · 额度未知";
  }

  // Tavily key → 进度条三件套：label / value / 剩余百分比（未查到时 null）。
  function tavilyKeyParts(entry, isActive) {
    var label = entry && entry.label != null && String(entry.label) !== "" ? String(entry.label) : "未命名";
    var prefix = isActive ? "当前 · " : "";
    if (!entry || entry.query_ok !== true) {
      return { label: prefix + label, value: "查询失败", pct: null };
    }
    var used = entry.used;
    var limit = entry.limit;
    var remaining = entry.remaining;
    if (remaining == null && used != null && limit != null) {
      remaining = limit - used;
    }
    if (remaining != null && limit != null && limit > 0) {
      var pct = Math.max(0, Math.min(100, (remaining / limit) * 100));
      return { label: prefix + label, value: "剩 " + remaining + "/" + limit, pct: pct };
    }
    return { label: prefix + label, value: "额度未知", pct: null };
  }

  function uptimeText(seconds) {
    var s = Number(seconds);
    if (!isFinite(s) || s <= 0) return "—";
    var days = Math.floor(s / 86400);
    var hours = Math.floor((s % 86400) / 3600);
    if (days > 0) return days + "天" + hours + "小时";
    var mins = Math.floor((s % 3600) / 60);
    return hours + "小时" + mins + "分";
  }

  function bjClock(isoString) {
    if (!isoString) return "";
    var s = String(isoString).trim();
    if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) {
      var d = new Date(s);
      if (!isNaN(d.getTime())) {
        var bj = new Date(d.getTime() + 8 * 3600 * 1000);
        return pad2(bj.getUTCHours()) + ":" + pad2(bj.getUTCMinutes());
      }
    }
    var m = s.match(/[T ](\d{2}):(\d{2})/);
    if (m) return m[1] + ":" + m[2];
    var d2 = new Date(s);
    if (!isNaN(d2.getTime())) {
      var bj2 = new Date(d2.getTime() + 8 * 3600 * 1000);
      return pad2(bj2.getUTCHours()) + ":" + pad2(bj2.getUTCMinutes());
    }
    return "";
  }

  // 内存 Top 10 每行：序号 · 进程名 · RSS MB · 占比%（如 "1 · python3 · 1012.0 MB · 6.2%"）
  function macTopMemoryLine(item, rank) {
    if (!item) return "";
    var r = (rank != null && isFinite(rank)) ? Number(rank) : 1;
    var name = item.name || "—";
    var rss = Number(item.rss_mb);
    var rssText = isFinite(rss) ? rss.toFixed(1) + " MB" : "— MB";
    var pct = Number(item.pct);
    var pctText = isFinite(pct) ? pct.toFixed(1) + "%" : "—%";
    return r + " · " + name + " · " + rssText + " · " + pctText;
  }

  // 磁盘 Top 10 每行：序号 · 路径 · GB（如 "1 · ~/.hermes/profiles · 17.3 GB"）
  function macTopDiskLine(item, rank) {
    if (!item) return "";
    var r = (rank != null && isFinite(rank)) ? Number(rank) : 1;
    var path = item.path || "—";
    var gb = item.gb != null ? Number(item.gb) : (item.bytes != null ? Number(item.bytes) / (1024 * 1024 * 1024) : NaN);
    var gbText = isFinite(gb) ? gb.toFixed(1) + " GB" : "— GB";
    return r + " · " + path + " · " + gbText;
  }

  // 磁盘 Top 10 块底注：数据为 HH:MM 扫描；stale=true 时改为 数据已过期（HH:MM 扫描）
  function macDiskTopNote(scannedAtOrDiskTop, stale) {
    var scannedAt = scannedAtOrDiskTop;
    var isStale = false;
    if (scannedAtOrDiskTop && typeof scannedAtOrDiskTop === "object") {
      scannedAt = scannedAtOrDiskTop.scanned_at;
      isStale = scannedAtOrDiskTop.stale === true;
    } else {
      isStale = stale === true;
    }
    var clock = bjClock(scannedAt);
    if (!clock) return isStale ? "数据已过期" : "";
    return isStale ? "数据已过期（" + clock + " 扫描）" : "数据为 " + clock + " 扫描";
  }

  // 保修信息文案：null 或 expired===true 时整块不渲染返回 null；未过期返回 "保修至 YYYY-MM-DD · 剩余 N 天"
  function macWarrantyText(warranty) {
    if (!warranty || typeof warranty !== "object" || warranty.expired === true) return null;
    if (!warranty.expires) return null;
    var days = Number(warranty.days_left);
    if (!isFinite(days) || days < 0) return null;
    return "保修至 " + warranty.expires + " · 剩余 " + days + " 天";
  }

  // 本机健康分（本看板自定义口径，不是 Apple 官方评分）。
  // 规则固定可解释：基础 100，逐项取最大扣分；SMART 异常直接归零。
  function macHealthScore(data) {
    if (!data || data.ok !== true) return null;
    var gb = 1024 * 1024 * 1024;
    var disk = data.disk || {};
    var mem = data.memory || {};
    var temp = data.temp || {};
    var fans = Array.isArray(data.fans) ? data.fans : [];
    var load = data.load || {};
    var storage = data.storage_health || {};
    var items = [];

    function add(label, detail, points) {
      items.push({ label: label, detail: detail, points: points });
    }

    // 磁盘：已用 >=90 扣 30，>=80 扣 15；剩余 <20G 至少扣 10
    var usedPct = Number(disk.used_pct);
    if (!isFinite(usedPct)) usedPct = 0;
    var freeGb = (Number(disk.free) || 0) / gb;
    var diskPoints = usedPct >= 90 ? 30 : (usedPct >= 80 ? 15 : 0);
    if (freeGb > 0 && freeGb < 20 && diskPoints < 10) diskPoints = 10;
    add("磁盘", "已用 " + usedPct.toFixed(1) + "% · 余 " + freeGb.toFixed(1) + " GB", diskPoints);

    // 内存：按 swap 使用率，>=80% 扣 20，>=50% 扣 10
    var swapTotal = (Number(mem.swap_total) || 0) / gb;
    var swapUsed = (Number(mem.swap_usage) || 0) / gb;
    var swapPct = swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0;
    add(
      "内存",
      "swap " + swapUsed.toFixed(1) + " / " + swapTotal.toFixed(1) + " GB（" + swapPct.toFixed(0) + "%）",
      swapPct >= 80 ? 20 : (swapPct >= 50 ? 10 : 0)
    );

    // CPU 温度：>=80 扣 15，>=60 扣 5
    var cpuTemp = Number(temp.cpu);
    var hasTemp = isFinite(cpuTemp) && cpuTemp > 1;
    add(
      "温度",
      hasTemp ? cpuTemp.toFixed(1) + " °C" : "—",
      hasTemp ? (cpuTemp >= 80 ? 15 : (cpuTemp >= 60 ? 5 : 0)) : 0
    );

    // 风扇：占上限 >=70% 扣 10，>=40% 扣 5
    var fan = fans.length ? fans[0] : null;
    var fanPct = 0;
    if (fan && Number(fan.max_rpm) > 0) {
      fanPct = ((Number(fan.rpm) || 0) / Number(fan.max_rpm)) * 100;
    }
    add(
      "风扇",
      fan && fan.rpm != null ? Math.round(fan.rpm) + " / " + fan.max_rpm + " RPM（" + fanPct.toFixed(0) + "%）" : "—",
      fanPct >= 70 ? 10 : (fanPct >= 40 ? 5 : 0)
    );

    // 负载：load1 超过核数扣 10，超过两倍核数扣 20
    var load1 = Number(load.load1);
    var cores = Number(load.cores) || 1;
    var loadPoints = 0;
    if (isFinite(load1)) {
      loadPoints = load1 >= cores * 2 ? 20 : (load1 >= cores ? 10 : 0);
    }
    add("负载", isFinite(load1) ? load1.toFixed(2) + " / " + cores + " 核" : "—", loadPoints);

    // SMART：非 Verified 直接归零；未读到不扣分
    var smart = storage.smart || "";
    var smartOk = storage.smart_ok === true;
    add("SMART", smart || "未读取", smart && !smartOk ? 50 : 0);

    // 内核崩溃：有记录扣 20
    var panicCount = Number(storage.panic_count) || 0;
    add("内核崩溃", panicCount > 0 ? panicCount + " 次" : "0 次", panicCount > 0 ? 20 : 0);

    var total = 100;
    items.forEach(function (it) {
      total -= it.points;
    });
    if (smart && !smartOk) total = 0;
    total = Math.max(0, Math.min(100, total));

    var level = "优秀";
    var tone = "ok";
    if (total < 60) {
      level = "偏高";
      tone = "danger";
    } else if (total < 75) {
      level = "注意";
      tone = "warn";
    } else if (total < 90) {
      level = "良好";
    }

    return { score: total, level: level, tone: tone, items: items };
  }

  // 本机 Mac 预览卡（mac 源）→ {disk, mem, sensors, foot, warn, warnText}；数据不可用时返回 null。
  function macView(data) {
    if (!data || data.ok !== true) return null;
    var gb = 1024 * 1024 * 1024;
    var disk = data.disk || {};
    var mem = data.memory || {};
    var host = data.host || {};
    var load = data.load || {};
    var temp = data.temp || {};
    var fans = Array.isArray(data.fans) ? data.fans : [];

    var freeGb = (Number(disk.free) || 0) / gb;
    var usedPct = Number(disk.used_pct);
    if (!isFinite(usedPct)) usedPct = 0;
    var diskColor = diskBarColor(usedPct);
    var warrantyText = macWarrantyText(data.warranty);

    var ramUsed = (Number(mem.ram_usage) || 0) / gb;
    var ramTotal = (Number(mem.ram_total) || 0) / gb;
    var swapUsed = (Number(mem.swap_usage) || 0) / gb;
    var swapTotal = (Number(mem.swap_total) || 0) / gb;
    var memPct = ramTotal > 0 ? Math.max(0, Math.min(100, (ramUsed / ramTotal) * 100)) : null;
    var swapPct = swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0;

    var fan = fans.length ? fans[0] : null;
    var sensorBits = [];
    if (fan && fan.rpm != null) sensorBits.push("风扇 " + Math.round(fan.rpm) + " RPM");
    var cpuTemp = Number(temp.cpu);
    if (isFinite(cpuTemp) && cpuTemp > 1) sensorBits.push("CPU " + Math.round(cpuTemp) + "°C");
    var load1 = Number(load.load1);
    if (isFinite(load1)) sensorBits.push("负载 " + load1.toFixed(2) + "/" + (load.cores || "?") + " 核");

    var memValue = ramTotal > 0
      ? "已用 " + ramUsed.toFixed(1) + " / " + ramTotal.toFixed(1) + " GB"
      : "—";
    if (swapTotal > 0) memValue += " · swap " + swapUsed.toFixed(1) + "G";

    var warnText = [];
    if (freeGb < 20 || usedPct >= 85) {
      warnText.push("磁盘余量 " + freeGb.toFixed(1) + " GB（" + usedPct.toFixed(0) + "% 已用）");
    }
    if (swapPct >= 80) warnText.push("swap 已用 " + Math.round(swapPct) + "%");

    return {
      disk: {
        label: "磁盘",
        value: "已用 " + usedPct.toFixed(0) + "% (余 " + freeGb.toFixed(1) + " GB)",
        pct: usedPct,
        color: diskColor,
        barColor: diskColor,
        warn: freeGb < 20 || usedPct >= 85,
      },
      mem: {
        label: "内存",
        value: memValue,
        pct: memPct,
        warn: swapPct >= 80,
      },
      sensors: sensorBits.join(" · "),
      foot: (host.chip || "Mac") + (host.cores ? " · " + host.cores + " 核" : "") + " · 运行 " + uptimeText(data.uptime_seconds),
      warranty: warrantyText,
      warrantyText: warrantyText,
      warn: warnText.length > 0,
      warnText: warnText.join("；"),
    };
  }

  // 本机 Mac 详情页：每项给当前值 + 参考区间 + 状态判定（ok / warn / danger）。
  function macDetail(data) {
    if (!data || data.ok !== true) return null;
    var gb = 1024 * 1024 * 1024;
    var disk = data.disk || {};
    var mem = data.memory || {};
    var detail = mem.detail || {};
    var host = data.host || {};
    var load = data.load || {};
    var temp = data.temp || {};
    var fans = Array.isArray(data.fans) ? data.fans : [];
    var power = data.power || {};
    var tiers = Array.isArray(data.cpu_tiers) ? data.cpu_tiers : [];
    var gpu = data.gpu || {};

    function bytesGb(value) { return (Number(value) || 0) / gb; }
    function toneOf(pct, warnAt, dangerAt) {
      var n = Number(pct);
      if (!isFinite(n)) return "ok";
      if (n >= dangerAt) return "danger";
      if (n >= warnAt) return "warn";
      return "ok";
    }

    var tiles = [];
    var rows = [];

    // 磁盘：APFS Capacity 口径（used/(used+avail)）
    var diskUsedPct = Number(disk.used_pct) || 0;
    var diskFree = bytesGb(disk.free);
    var diskTotal = bytesGb(disk.total);
    var diskUsed = bytesGb(disk.used);
    var diskColor = diskBarColor(diskUsedPct);
    tiles.push({
      key: "disk",
      label: "磁盘",
      tone: toneOf(diskUsedPct, 80, 90),
      value: "已用 " + diskUsedPct.toFixed(1) + "%",
      sub: diskUsed.toFixed(1) + " / " + diskTotal.toFixed(1) + " GB（余 " + diskFree.toFixed(1) + " GB）",
      pct: diskUsedPct,
      color: diskColor,
      barColor: diskColor,
      range: "已用 <80%（剩余 >" + (diskTotal * 0.2).toFixed(0) + " GB）正常；80-90% 注意；≥90% 建议清理",
    });

    // 内存：macOS 会主动用 RAM 做缓存，判断以 swap 与压缩器为主
    var ramTotal = bytesGb(mem.ram_total);
    var ramUsed = bytesGb(mem.ram_usage);
    var swapTotal = bytesGb(mem.swap_total);
    var swapUsed = bytesGb(mem.swap_usage);
    var swapPct = swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0;
    var compressor = bytesGb(detail.compressor);
    var ramUsedPct = ramTotal > 0 ? Math.max(0, Math.min(100, (ramUsed / ramTotal) * 100)) : 0;
    tiles.push({
      key: "memory",
      label: "内存",
      tone: toneOf(swapPct, 50, 80),
      value: "已用 " + ramUsed.toFixed(1) + " / " + ramTotal.toFixed(1) + " GB",
      sub: "swap " + swapUsed.toFixed(1) + " / " + swapTotal.toFixed(1) + " GB · 压缩器 " + compressor.toFixed(1) + " GB",
      pct: ramUsedPct,
      range: "swap <" + (swapTotal * 0.5).toFixed(1) + " GB（<50%）正常；压缩器 <" + (ramTotal * 0.3).toFixed(1) + " GB 正常；RAM 占用高本身不是问题",
    });

    // CPU 温度（GPU 温度在 M4 上无有效传感器，不显示）
    var cpuTemp = Number(temp.cpu);
    if (isFinite(cpuTemp) && cpuTemp > 1) {
      tiles.push({
        key: "temp",
        label: "CPU 温度",
        tone: toneOf(cpuTemp, 60, 80),
        value: cpuTemp.toFixed(1) + " °C",
        sub: "待机 35-50°C 常见；高负载 70-90°C",
        pct: null,
        range: "<60°C 正常；60-80°C 偏热；>80°C 注意散热（持续 >95°C 会降频）",
      });
    }

    // 风扇：按占最高转速比例判定
    var fan = fans.length ? fans[0] : null;
    if (fan && fan.rpm != null) {
      var fanMax = Number(fan.max_rpm) || 0;
      var fanPct = fanMax > 0 ? (Number(fan.rpm) / fanMax) * 100 : 0;
      tiles.push({
        key: "fan",
        label: "风扇",
        tone: toneOf(fanPct, 40, 70),
        value: Math.round(Number(fan.rpm)) + " RPM",
        sub: "上限 " + fanMax + " RPM · 当前占 " + Math.round(fanPct) + "%",
        // 转速是传感器读数，不是容量配额，因此不画条。
        pct: null,
        range: "待机约 1000 RPM 正常；<" + Math.round(fanMax * 0.4) + " RPM 属轻载；接近 " + fanMax + " RPM 为高负载",
      });
    }

    // 明细行
    var load1 = Number(load.load1);
    if (isFinite(load1)) {
      rows.push({
        label: "负载（1 / 5 / 15 分钟）",
        value: load1.toFixed(2) + " / " + Number(load.load5 || 0).toFixed(2) + " / " + Number(load.load15 || 0).toFixed(2) + "（" + (load.cores || "?") + " 核）",
        note: "每核负载 <1 正常（load1 <" + (load.cores || "?") + "）",
      });
    }
    var cpuPower = Number(power.cpu);
    var sysPower = Number(power.sys);
    if (isFinite(cpuPower) || isFinite(sysPower)) {
      rows.push({
        label: "功耗",
        value: "CPU " + (isFinite(cpuPower) ? cpuPower.toFixed(2) : "—") + " W · GPU " + (isFinite(Number(power.gpu)) ? Number(power.gpu).toFixed(2) : "—") + " W · 整机 " + (isFinite(sysPower) ? sysPower.toFixed(2) : "—") + " W",
      });
    }
    if (detail && (detail.active != null || detail.wired != null)) {
      rows.push({
        label: "内存分项",
        value: "活跃 " + bytesGb(detail.active).toFixed(1) + " · 非活跃 " + bytesGb(detail.inactive).toFixed(1) + " · 有线 " + bytesGb(detail.wired).toFixed(1) + " · 压缩器 " + bytesGb(detail.compressor).toFixed(1) + " · 空闲 " + bytesGb(detail.free).toFixed(1) + " GB",
      });
    }
    if (tiers.length) {
      rows.push({
        label: "CPU 核心簇",
        value: tiers.map(function (t) {
          return (t.label || "?") + " 核 ×" + (t.cores || 0) + " · " + Math.round(Number(t.freq_mhz) || 0) + " MHz · 负载 " + Math.round((Number(t.scaled_ratio) || 0) * 100) + "%";
        }).join("；"),
      });
    }
    if (gpu && gpu.freq_mhz != null && Number(gpu.freq_mhz) > 0) {
      rows.push({
        label: "GPU",
        value: Math.round(Number(gpu.freq_mhz)) + " MHz · 负载 " + Math.round((Number(gpu.scaled_ratio) || 0) * 100) + "%",
      });
    }
    if (data.process_count != null) {
      rows.push({ label: "进程数", value: String(data.process_count) });
    }
    if (data.uptime_seconds != null) {
      rows.push({ label: "运行时长", value: uptimeText(data.uptime_seconds) });
    }
    if (host.chip) {
      rows.push({
        label: "机型",
        value: (host.model || "Mac") + " · " + host.chip + " · " + (host.cores || "?") + " 核 · " + bytesGb(host.ram_total).toFixed(0) + " GB",
      });
    }

    var topMemory = Array.isArray(data.top_memory) && data.top_memory.length > 0
      ? data.top_memory.map(function (item, idx) { return macTopMemoryLine(item, idx + 1); })
      : null;

    var diskTop = (data.disk_top && Array.isArray(data.disk_top.items) && data.disk_top.items.length > 0)
      ? {
          items: data.disk_top.items.map(function (item, idx) { return macTopDiskLine(item, idx + 1); }),
          note: macDiskTopNote(data.disk_top),
        }
      : null;

    var warrantyText = macWarrantyText(data.warranty);

    return {
      tiles: tiles,
      rows: rows,
      header: (host.chip || "Mac") + " · " + (host.cores || "?") + " 核 · 运行 " + uptimeText(data.uptime_seconds),
      warranty: warrantyText,
      topMemory: topMemory,
      diskTop: diskTop,
      generated: data.generated_at ? String(data.generated_at).slice(5, 19).replace("T", " ") : "",
      notes: [
        "传感器（温度/风扇/内存/功耗）由 macmon 读取（免 sudo，本机 127.0.0.1:9090）；GPU 温度在 M4 上无有效传感器，不显示。",
        "参考区间为通用经验值，不是 Apple 官方阈值；macOS 会主动用内存做缓存，内存是否吃紧以 swap 和压缩器为主。",
      ],
    };
  }

  // 窗口保活段（anchors 源）→ {text, tone}；tone 直接作为 pill 样式类（ok/warning/danger/accent）。
  function anchorStatus(segment) {
    if (!segment || segment.state_ok === false) {
      return { text: "状态读取失败", tone: "danger" };
    }
    if (segment.enabled === false) {
      return { text: "已停用", tone: "accent" };
    }
    var targets = Array.isArray(segment.targets) ? segment.targets : [];
    var maxTries = 0;
    var anyFire = false;
    var anySuccess = false;
    targets.forEach(function (t) {
      if (!t) return;
      var tries = Number(t.tries);
      if (isFinite(tries) && tries > maxTries) maxTries = tries;
      if (t.last_fire_at != null) anyFire = true;
      if (t.last_success_at != null) anySuccess = true;
    });
    if (maxTries >= 3) return { text: "异常 · 连续 " + maxTries + " 次失败", tone: "danger" };
    if (maxTries > 0) return { text: "重试中", tone: "warning" };
    if (anySuccess) return { text: "正常", tone: "ok" };
    if (anyFire) return { text: "待确认", tone: "accent" };
    return { text: "待首次触发", tone: "accent" };
  }

  // ---- Hub 增强块（hub_insights：调度器 / 成长任务 / 性能分位）----
  function hubNumber(value, digits) {
    var num = Number(value);
    if (!isFinite(num)) return "—";
    return num.toFixed(digits == null ? 0 : digits)
      .replace(/(\.\d*?)0+$/, "$1")
      .replace(/\.$/, "");
  }

  // Hub 调度器时间是本地 "YYYY-MM-DD HH:MM:SS"：今天的只显示 HH:MM，跨天补 MM-DD。
  function hubClock(value) {
    var text = value == null ? "" : String(value).trim();
    if (!text) return "";
    var match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!match) return text;
    var day = match[2] + "-" + match[3];
    var today = recentBjDates(1)[0].slice(5);
    return (day === today ? "" : day + " ") + match[4] + ":" + match[5];
  }

  // → {text, title} 或 null（没有数据就不渲染，不留占位）。
  function hubSchedulerLine(insights) {
    var sched = insights && insights.scheduler;
    if (!sched || sched.ok !== true) return null;
    var title = [sched.mode, sched.last_log].filter(function (part) { return !!part; }).join("\n");
    if (sched.enabled === false) {
      return { text: "🤖 自动任务：已停用", title: title };
    }
    var next = hubClock(sched.next_run_time);
    var last = hubClock(sched.last_run_time);
    return {
      text: "🤖 自动任务：" +
        (next && next !== "待调度" ? "下次 " + next : "下次 待调度") + " · " +
        (last && last !== "尚未运行" ? "上次 " + last + " 完成" : "上次 尚未运行"),
      title: title,
    };
  }

  // → {badge, streak, energy, cards, lottery, tiers[], travel, claimedTasks, taskCount, note}
  function hubTaskBits(tasks) {
    if (!tasks || tasks.ok !== true) return null;
    var streak = Number(tasks.streak_days);
    var tiers = (Array.isArray(tasks.tiers) ? tasks.tiers : []).map(function (tier) {
      if (!tier) return "";
      var label = tier.tier || (tier.days != null ? tier.days + "d" : "");
      if (tier.status === "claimed") return label + " 已领";
      if (tier.status === "locked") {
        var days = Number(tier.days);
        if (isFinite(days) && isFinite(streak)) {
          return label + " " + Math.min(Math.max(streak, 0), days) + "/" + days + " 天";
        }
        return label + " 未达成";
      }
      return label;
    }).filter(function (part) { return !!part; });
    var travel = "";
    if (tasks.travel_claimed === true) travel = "旅行奖励今日已领";
    else if (tasks.travel_state === "idle") travel = "旅行待出发";
    else if (tasks.travel_state) travel = "旅行：" + tasks.travel_state;
    return {
      badge: hubNumber(tasks.streak_days, 0) + " 天",
      streak: hubNumber(tasks.streak_days, 0) + " 天",
      energy: hubNumber(tasks.energy, 0),
      cards: hubNumber(tasks.makeup_cards, 0),
      lottery: hubNumber(tasks.lottery_chances, 0),
      tiers: tiers,
      travel: travel,
      claimedTasks: hubNumber(tasks.claimed_tasks, 0),
      taskCount: hubNumber(tasks.task_count, 0),
      note: "默认账号（国内 " + hubNumber(tasks.cn_accounts, 0) + " 个账号）",
    };
  }

  // 今日签到 / 猫猫旅行（Hub /activity/history + 调度器日志环）→
  // {badge, summary, travelLine, rows:[{clock, account, tag, text}], note} 或 null。
  // 旅行只有调度器滚动 60 条日志这一处来源，文案必须写成「最近」，不能写成当日全量。
  function hubActivityBits(activity) {
    if (!activity) return null;
    var travel = activity.travel && activity.travel.ok === true ? activity.travel : null;
    if (activity.ok !== true && !travel) return null;
    var checkin = activity.ok === true ? (activity.checkin || null) : null;
    var daily = activity.ok === true ? (activity.daily_chat || null) : null;
    var parts = [];
    var badge = [];
    var rows = [];
    if (checkin && Number(checkin.total) > 0) {
      var failed = Number(checkin.failed) || 0;
      parts.push("签到 " + hubNumber(checkin.done, 0) + "/" + hubNumber(checkin.total, 0) +
        (failed ? "（失败 " + hubNumber(failed, 0) + "）" : ""));
      badge.push("签到 " + hubNumber(checkin.done, 0) + "/" + hubNumber(checkin.total, 0));
      (checkin.rows || []).forEach(function (row) {
        if (!row) return;
        rows.push({
          clock: row.clock || "",
          account: row.account || "",
          tag: "签到",
          text: (row.ok === true ? "已签到" : "失败") + (row.message ? " · " + row.message : ""),
        });
      });
    }
    if (daily && Number(daily.total) > 0) {
      parts.push("国际活跃 " + hubNumber(daily.done, 0) + "/" + hubNumber(daily.total, 0));
    }
    var travelLine = "";
    if (travel && ((travel.rows || []).length || Number(travel.claims) || Number(travel.departs))) {
      var credit = Number(travel.credits);
      var travelText = "猫猫旅行：领奖 " + hubNumber(travel.claims, 0) + " 次" +
        (isFinite(credit) && credit > 0 ? "（+" + hubNumber(credit, 2) + " 积分）" : "");
      parts.push(travelText);
      badge.push("🐱 " + hubNumber(travel.claims, 0));
      var clocks = (travel.rows || []).map(function (row) { return row && row.clock; }).filter(function (clock) { return !!clock; });
      travelLine = "🐱 " + travelText + (clocks.length ? " · 最近 " + clocks[clocks.length - 1] : "");
      (travel.rows || []).forEach(function (row) {
        if (!row) return;
        rows.push({
          clock: row.clock || "",
          account: row.account || "",
          tag: "猫猫",
          text: row.message || (row.action === "claim" ? "领奖成功" : row.action || ""),
        });
      });
    }
    if (!parts.length) return null;
    return {
      badge: badge.join(" · "),
      summary: parts.join(" · "),
      travelLine: travelLine,
      rows: rows,
      note: "签到 / 国际活跃 = Hub 今日活动历史；猫猫旅行 = 调度器最近日志（Hub 只保留滚动 60 条，非当日全量）",
    };
  }

  // → {label, rows:[{label, value}], note} 或 null。样本是 Hub 的「最近 N 条请求」，
  // 不是自然日窗口——label 必须带上样本量与起点，避免被读成「今日」。
  function hubPerfBits(perf) {
    if (!perf || perf.ok !== true) return null;
    var sampled = perf.sampled != null ? hubNumber(perf.sampled, 0) : "—";
    var label = "最近 " + sampled + " 次请求";
    if (perf.sample_from) label += "（" + String(perf.sample_from).slice(5) + " 起）";

    function msText(value) {
      var num = Number(value);
      if (!isFinite(num)) return "—";
      return num >= 10000 ? hubNumber(num / 1000, 1) + "s" : hubNumber(num / 1000, 2) + "s";
    }

    function pick(block, formatter) {
      if (!block) return "";
      return [block.p50, block.p90, block.p99].map(formatter).join(" / ");
    }

    var rows = [];
    var ttft = pick(perf.ttft_ms, msText);
    if (ttft) rows.push({ label: "首字耗时 p50 / p90 / p99", value: ttft });
    var speed = pick(perf.tokens_per_sec, function (value) {
      return value == null ? "—" : hubNumber(value, 0);
    });
    if (speed) rows.push({ label: "输出速度 p50 / p90 / p99", value: speed + " t/s" });
    var hit = pick(perf.cache_hit_pct, function (value) {
      return value == null ? "—" : hubNumber(value, 1) + "%";
    });
    if (hit) rows.push({ label: "缓存命中 p50 / p90 / p99", value: hit });
    if (perf.success_rate_pct != null) {
      rows.push({
        label: "成功率",
        value: hubNumber(perf.success_rate_pct, 1) + "% · 中断 " + hubNumber(perf.client_aborted, 0) + " 次",
      });
    }
    if (!rows.length) return null;
    return {
      label: label,
      rows: rows,
      note: perf.sample_capped === true ? "样本已达上限，只统计最近 " + sampled + " 次" : "",
    };
  }

  // Hub 更新徽标：只有真的存在新版本才出现，安静时零渲染。
  function hubUpdateBadge(insights) {
    var upd = insights && insights.updates;
    if (!upd || upd.ok !== true || upd.update_available !== true) return null;
    return {
      text: "⬆ " + (upd.latest_version || "新版"),
      title: "Hub " + (upd.current_version || "?") + " → " + (upd.latest_version || "?"),
    };
  }

  // 最近请求（Hub /usage/recent）→ 行；账号已由脚本换成账号卡同款脱敏昵称。
  function hubRecentRows(recent) {
    if (!recent || recent.ok !== true) return null;
    var rows = Array.isArray(recent.rows) ? recent.rows : [];
    if (!rows.length) return null;
    return rows.map(function (row) {
      var meta = [];
      if (row.effort) meta.push(row.effort);
      if (row.ttft_ms != null) meta.push((Number(row.ttft_ms) / 1000).toFixed(1) + "s");
      return {
        clock: row.clock || "",
        model: row.model || "",
        account: row.account || "—",
        meta: meta.join(" · "),
        credit: row.credit == null ? "" : String(Math.round(Number(row.credit) * 100) / 100),
        failed: !!row.outcome && row.outcome !== "completed",
      };
    });
  }

  // Hub 账本按小时桶（/usage/timeseries）→ 柱高按请求数归一。缺桶补零柱：Hub 当时在跑，
  // 缺桶就是这段时间没有请求，补上才不会被读成随手省略的间隔。
  function hubHourBits(hours) {
    if (!hours || hours.ok !== true) return null;
    var buckets = (Array.isArray(hours.buckets) ? hours.buckets : []).filter(function (bucket) {
      return bucket && bucket.at != null;
    });
    if (!buckets.length) return null;
    var step = Number(hours.bucket_seconds) || 3600;
    if (!isFinite(step) || step <= 0) step = 3600;
    var sorted = buckets.slice().sort(function (a, b) { return Number(a.at) - Number(b.at); });
    var start = Number(sorted[0].at);
    var end = Number(sorted[sorted.length - 1].at);
    var count = Math.max(1, Math.round((end - start) / step) + 1);
    var byIndex = {};
    sorted.forEach(function (bucket) {
      byIndex[Math.round((Number(bucket.at) - start) / step)] = bucket;
    });
    var max = 0;
    var total = 0;
    var credits = 0;
    var creditsComplete = true;
    var bars = [];
    for (var index = 0; index < count; index += 1) {
      var bucket = byIndex[index];
      var requests = bucket ? (Number(bucket.requests) || 0) : 0;
      var credit = bucket && bucket.credit != null ? Number(bucket.credit) : null;
      if (requests > max) max = requests;
      total += requests;
      if (bucket && credit == null) creditsComplete = false;
      if (credit != null) credits += credit;
      bars.push({
        empty: !bucket,
        requests: requests,
        label: bucket ? (bucket.label || "") : "",
        title: bucket
          ? (bucket.label || "?") + " 起 1 小时 · " + requests + " 次请求" +
            (credit == null ? "" : " · " + (Math.round(credit * 100) / 100) + " 积分")
          : "无请求记录",
        pct: 0,
      });
    }
    bars.forEach(function (bar) {
      bar.pct = bar.requests === 0 || max === 0 ? 2
        : Math.max(2, Math.round((bar.requests / max) * 100));
    });
    return {
      bars: bars,
      total: total,
      note: "近 24 小时：" + total + " 次请求" +
        (creditsComplete ? " · " + (Math.round(credits * 100) / 100) + " 积分" : "") +
        "（按 Hub 账本小时桶）",
    };
  }

  // 本地账本按 API key 聚合（usage.by_key）→ 一行文案；无数据返回 null。
  function keyUsageLine(byKey) {
    if (!byKey || !Array.isArray(byKey.today) || !byKey.today.length) return null;
    return byKey.today.map(function (row) {
      var text = (row.key || "?") + " " + (row.requests || 0) + " 次";
      if (row.credits != null) text += " · " + (Math.round(Number(row.credits) * 100) / 100) + " 积分";
      return text;
    }).join(" · ");
  }

  return {
    recentBjDates: recentBjDates,
    checkinLabel: checkinLabel,
    realmLabel: realmLabel,
    remainingPct: remainingPct,
    barColor: barColor,
    hasRealError: hasRealError,
    isStaticDataCaveat: isStaticDataCaveat,
    wbUnknownRealmSummary: wbUnknownRealmSummary,
    wbTokenSplit: wbTokenSplit,
    wbTokenColumns: wbTokenColumns,
    wbMetricState: wbMetricState,
    amountBucket: amountBucket,
    addAmount: addAmount,
    wbEquivMark: wbEquivMark,
    usageFirstOrder: usageFirstOrder,
    wbPriceBlock: wbPriceBlock,
    wbModelUsageRows: wbModelUsageRows,
    wbThrottleRows: wbThrottleRows,
    wbThrottleClock: wbThrottleClock,
    wbThrottleLeftText: wbThrottleLeftText,
    formatUpdatedClock: formatUpdatedClock,
    formatUpdateStatus: formatUpdateStatus,
    expiryLeftText: expiryLeftText,
    museResetCn: museResetCn,
    agyResetCn: agyResetCn,
    tavilyKeyLine: tavilyKeyLine,
    tavilyKeyParts: tavilyKeyParts,
    macView: macView,
    macDetail: macDetail,
    macHealthScore: macHealthScore,
    diskBarColor: diskBarColor,
    macTopMemoryLine: macTopMemoryLine,
    macTopDiskLine: macTopDiskLine,
    macDiskTopNote: macDiskTopNote,
    macWarrantyText: macWarrantyText,
    warrantyText: macWarrantyText,
    formatTopMemoryRow: macTopMemoryLine,
    formatTopDiskRow: macTopDiskLine,
    diskTopNote: macDiskTopNote,
    anchorStatus: anchorStatus,
    hubSchedulerLine: hubSchedulerLine,
    hubTaskBits: hubTaskBits,
    hubActivityBits: hubActivityBits,
    hubPerfBits: hubPerfBits,
    hubUpdateBadge: hubUpdateBadge,
    hubRecentRows: hubRecentRows,
    hubHourBits: hubHourBits,
    keyUsageLine: keyUsageLine,
  };
});
