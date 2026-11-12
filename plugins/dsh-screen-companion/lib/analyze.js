// src/analyze.ts
var MAX_CARE_PER_DAY = 3;
function parseVlmReply(raw) {
  const text = (raw || "").trim();
  const grab = (label) => {
    const m = text.match(label);
    return m ? m[1].trim() : "";
  };
  let activity = grab(/(?:在干什么|做什么|activity)\s*[:：]\s*([^\n,，。;；]+)/i);
  let mood = grab(/(?:情绪|心情|mood)\s*[:：]\s*([^\n,，。;；]+)/i);
  if (!activity && !mood) {
    const seg = text.split(/[，,。;；\n]/).map((s) => s.trim()).filter(Boolean);
    activity = seg[0] || "\u672A\u77E5";
    mood = seg[1] || "\u672A\u77E5";
  }
  const hasError = /(error|exception|traceback|failed|报错|异常|错误)/i.test(text) || /失败|崩了|无法/i.test(text);
  return { activity: activity.slice(0, 20), mood: mood.slice(0, 12), hasError };
}
function isLongFocus(obs, now, hours = 2) {
  const windowMs = hours * 36e5;
  const lookback = windowMs * 1.2;
  const recent = obs.filter((o) => now - o.ts <= lookback);
  if (recent.length < 2) return false;
  const span = now - recent[0].ts;
  if (span < windowMs) return false;
  return recent.every((o) => /写代码|工作|文档|表格|编程|代码/.test(o.activity));
}
function decideCare(opts) {
  const { observations, now, lastCareAt, careCountToday } = opts;
  if (careCountToday >= MAX_CARE_PER_DAY) return { care: false, reason: "\u4ECA\u5929\u5DF2\u7ECF\u5173\u5FC3\u8FC7 3 \u6B21", kind: "none" };
  if (lastCareAt && now - lastCareAt < 45 * 6e4) {
    return { care: false, reason: "\u8DDD\u4E0A\u6B21\u5173\u5FC3\u4E0D\u8DB3 45 \u5206\u949F", kind: "none" };
  }
  const last = observations[observations.length - 1];
  if (!last) return { care: false, reason: "\u8FD8\u6CA1\u6709\u89C2\u5BDF\u6570\u636E", kind: "none" };
  if (last.hasError && /焦虑|烦躁|急|崩溃|emo/i.test(last.mood)) {
    return { care: true, reason: `\u753B\u9762\u6709\u62A5\u9519\u4E14\u60C5\u7EEA\u300C${last.mood}\u300D`, kind: "error_anxious" };
  }
  if (isLongFocus(observations, now)) {
    return { care: true, reason: "\u8FDE\u7EED 2 \u5C0F\u65F6\u90FD\u5728\u5DE5\u4F5C", kind: "long_focus" };
  }
  return { care: false, reason: "\u6CA1\u6709\u89E6\u53D1\u6761\u4EF6", kind: "none" };
}
var ERROR_LINES = [
  "\u8FD9\u4E2A\u62A5\u9519\u6211\u770B\u4E86\u4E00\u4F1A\u513F\u4E86\uFF0C\u5148\u559D\u53E3\u6C34\u518D\u56DE\u6765\uFF1F",
  "\u5361\u8FD9\u4E48\u4E45\u8FD8\u76EF\u7740\u5C4F\u5E55\uFF0C\u773C\u775B\u5148\u6B47\u4E00\u4E0B\u3002",
  "\u90A3\u6BB5\u62A5\u9519\u7EA2\u5F97\u6BD4\u4F60\u8138\u8FD8\u7EA2\uFF0C\u5148\u522B\u6025\u3002"
];
var LONG_LINES = [
  "\u4E24\u4E2A\u949F\u5934\u4E86\uFF0C\u8D77\u6765\u52A8\u52A8\u5427\uFF0C\u6211\u53C8\u4E0D\u4F1A\u8DD1\u3002",
  "\u5750\u592A\u4E45\u4E86\uFF0C\u8170\u4F1A\u6297\u8BAE\u7684\u3002",
  "\u4F60\u5DF2\u7ECF\u5199\u4E86\u5F88\u4E45\u4E86\uFF0C\u6B47\u5341\u5206\u949F\u4E0D\u803D\u8BEF\u4E8B\u3002"
];
function careLine(kind, seed = Date.now()) {
  const pool = kind === "error_anxious" ? ERROR_LINES : LONG_LINES;
  return pool[Math.abs(seed) % pool.length];
}
export {
  MAX_CARE_PER_DAY,
  careLine,
  decideCare,
  isLongFocus,
  parseVlmReply
};
//# sourceMappingURL=analyze.js.map
