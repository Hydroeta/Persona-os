import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/rhythm.ts
var LOG_TAG = "[dsh-live-director/rhythm]";
var THINKING_STAGES = ["\u5B9A\u5411", "\u6DF1\u6316", "\u501F\u529B", "\u5B9E\u8DF5"];
var STAGE_TEXT = {
  \u5B9A\u5411: "\u6B63\u5728\u7406\u89E3\u4F60\u7684\u610F\u601D\u2026",
  \u6DF1\u6316: "\u8BA9\u6211\u67E5\u67E5\u8BB0\u5FC6\u2026",
  \u501F\u529B: "\u8BA9\u6211\u56DE\u5FC6\u4E00\u4E0B\u2026",
  // 真实动作 = 从本地记忆找相似经验，不是上网搜
  \u5B9E\u8DF5: "\u8FD9\u5C31\u52A8\u624B\uFF01"
};
var COMPLEX_KEYWORDS = [
  "\u753B\u56FE",
  "\u753B\u4E2A",
  "\u753B\u4E00\u4E2A",
  "\u753B\u50CF",
  "\u5206\u6790",
  "\u603B\u7ED3",
  "\u68B3\u7406",
  "\u6574\u7406\u4E00\u4E0B",
  "\u67E5\u4E00\u4E0B",
  "\u67E5\u67E5",
  "\u641C\u4E00\u4E0B",
  "\u5199\u4E2A",
  "\u5199\u4E00\u4E2A",
  "\u5E2E\u6211\u505A",
  "\u5E2E\u6211\u5199",
  "\u4E3A\u4EC0\u4E48",
  "\u600E\u4E48\u505A",
  "\u600E\u4E48\u529E",
  "\u4EC0\u4E48\u539F\u7406"
];
function isComplexInstruction(text) {
  const s = String(text || "").trim();
  if (!s) return { complex: false, reason: "\u7A7A\u6587\u672C" };
  const hit = COMPLEX_KEYWORDS.find((k) => s.includes(k));
  if (hit) return { complex: true, reason: `\u542B\u89E6\u53D1\u8BCD\u300C${hit}\u300D` };
  if (s.length >= 20) return { complex: true, reason: `\u957F\u5EA6 ${s.length} \u2265 20` };
  if (s.length < 15) return { complex: false, reason: `\u957F\u5EA6 ${s.length} < 15 \u4E14\u65E0\u89E6\u53D1\u8BCD` };
  return { complex: false, reason: `\u957F\u5EA6 ${s.length} \u5728 15~19 \u4E4B\u95F4\uFF0C\u6309\u77ED\u53E5\u5904\u7406` };
}
function splitSentence(text, minLen = 6, maxLen = 40) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return [];
  const rough = s.match(/[^。！？!?…]+[。！？!?…]*/g) ?? [s];
  const out = [];
  let buf = "";
  for (const piece of rough) {
    const p = piece.trim();
    if (!p) continue;
    buf += p;
    if (buf.length >= minLen) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf) {
    if (out.length) out[out.length - 1] += buf;
    else out.push(buf);
  }
  const fin = [];
  for (const seg of out) {
    if (seg.length <= maxLen) {
      fin.push(seg);
      continue;
    }
    let rest = seg;
    while (rest.length > maxLen) {
      const cut = rest.slice(0, maxLen);
      const idx = Math.max(cut.lastIndexOf("\uFF0C"), cut.lastIndexOf(","), cut.lastIndexOf("\u3001"));
      const take = idx > maxLen * 0.4 ? idx + 1 : maxLen;
      fin.push(rest.slice(0, take));
      rest = rest.slice(take);
    }
    if (rest) fin.push(rest);
  }
  return fin.length ? fin : [s];
}
function randInt(lo, hi, rng = Math.random) {
  const a = Math.ceil(lo);
  const b = Math.floor(hi);
  return Math.floor(a + rng() * (b - a + 1));
}
function withThinkingChain(userText) {
  return [
    userText,
    "",
    "\u2014\u2014\uFF08\u4EE5\u4E0B\u662F\u4F60\u81EA\u5DF1\u7684\u601D\u8003\u8981\u6C42\uFF0C\u4E0D\u8981\u5FF5\u51FA\u6765\uFF0C\u4E5F\u4E0D\u8981\u5199\u8FDB\u56DE\u7B54\u91CC\uFF09",
    "\u8FD9\u6761\u6709\u70B9\u590D\u6742\uFF0C\u56DE\u7B54\u524D\u5728\u5FC3\u91CC\u8FC7\u56DB\u6B65\uFF1A",
    "1. \u5B9A\u5411\uFF1A\u5BF9\u65B9\u5230\u5E95\u60F3\u8981\u4EC0\u4E48\u7ED3\u679C\uFF1F",
    "2. \u6DF1\u6316\uFF1A\u6211\u8BB0\u5FC6\u91CC\u6709\u6CA1\u6709\u76F8\u5173\u7684\u80CC\u666F\u6216\u4E4B\u524D\u505A\u8FC7\u7684\u4E8B\uFF1F",
    "3. \u501F\u529B\uFF1A\u6709\u6CA1\u6709\u73B0\u6210\u7684\u7ECF\u9A8C\u3001\u73B0\u6210\u7684\u8BF4\u6CD5\u53EF\u4EE5\u501F\u7528\uFF1F",
    "4. \u5B9E\u8DF5\uFF1A\u60F3\u6E05\u695A\u4E4B\u540E\u518D\u5F00\u53E3\uFF0C\u7ED9\u4E00\u4E2A\u80FD\u843D\u5730\u7684\u56DE\u7B54\u3002",
    "\u56DE\u7B54\u8981\u53E3\u8BED\u3001\u7B80\u77ED\uFF0C\u50CF\u5728\u76F4\u64AD\u95F4\u8BF4\u8BDD\uFF0C\u4E0D\u8981\u5206\u70B9\u5217\u4E3E\uFF0C\u4E0D\u8981\u5FF5\u51FA\u8FD9\u56DB\u6B65\u3002"
  ].join("\n");
}
var __testing = { LOG_TAG };
export {
  COMPLEX_KEYWORDS,
  STAGE_TEXT,
  THINKING_STAGES,
  __testing,
  isComplexInstruction,
  randInt,
  splitSentence,
  withThinkingChain
};
//# sourceMappingURL=rhythm.js.map
