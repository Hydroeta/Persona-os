// src/mood.ts
var LOG_TAG = "[dsh-persona-core/mood]";
function defaultMood(now = Date.now()) {
  return {
    pleasure: 0,
    arousal: 0,
    dominance: 0,
    energy: 100,
    affection: 50,
    updatedAt: now,
    angryTurns: 0,
    turns: 0
  };
}
var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function normalizeMood(raw, now = Date.now()) {
  const d = defaultMood(now);
  if (!raw || typeof raw !== "object") return d;
  const num = (v, fb) => Number.isFinite(Number(v)) ? Number(v) : fb;
  return {
    pleasure: clamp(num(raw.pleasure, d.pleasure), -1, 1),
    arousal: clamp(num(raw.arousal, d.arousal), -1, 1),
    dominance: clamp(num(raw.dominance, d.dominance), -1, 1),
    energy: clamp(num(raw.energy, d.energy), 0, 100),
    affection: clamp(num(raw.affection, d.affection), 0, 100),
    updatedAt: num(raw.updatedAt, now),
    angryTurns: Math.max(0, Math.floor(num(raw.angryTurns, 0))),
    turns: Math.max(0, Math.floor(num(raw.turns, 0)))
  };
}
function isLateNight(ts = Date.now()) {
  const h = new Date(ts).getHours();
  return h >= 0 && h < 5;
}
function applyDecay(s, now = Date.now(), opts = {}) {
  const energyPerHour = opts.energyPerHour ?? 5;
  const latePerHour = opts.lateNightPenaltyPerHour ?? 8;
  const regress = opts.padRegressPerHour ?? 0.25;
  const hours = Math.max(0, (now - s.updatedAt) / 36e5);
  if (hours < 1e-6) return { ...s, updatedAt: now };
  let energyDelta;
  if (isLateNight(now)) {
    energyDelta = -latePerHour * hours;
  } else {
    energyDelta = energyPerHour * hours;
    if (s.angryTurns > 0) energyDelta *= 0.5;
  }
  const k = Math.min(1, regress * hours);
  return {
    ...s,
    energy: clamp(s.energy + energyDelta, 0, 100),
    pleasure: clamp(s.pleasure * (1 - k), -1, 1),
    arousal: clamp(s.arousal * (1 - k), -1, 1),
    dominance: clamp(s.dominance * (1 - k), -1, 1),
    updatedAt: now
  };
}
function detectEvent(text) {
  const s = String(text || "");
  if (!s.trim()) return "ignore";
  if (/(对不起|抱歉|我错|别生气|原谅|sorry)/i.test(s)) return "praise";
  if (/(谢谢|感谢|多谢|爱你|喜欢你|好可爱|真棒|厉害|牛|赞)/i.test(s)) return "praise";
  if (/(笨蛋|傻|蠢|废物|闭嘴|滚|垃圾|讨厌你|恶心|没用|差劲)/i.test(s)) return "insult";
  if (/(在吗|在么|喂|嗯|哦|啊)\s*$/.test(s.trim()) && s.trim().length <= 3) return "ignore";
  return "neutral";
}
function applyEvent(s, event, now = Date.now()) {
  const out = { ...s, updatedAt: now, turns: s.turns + 1 };
  const sensitivity = 1.6 - s.affection / 100 * 1;
  switch (event) {
    case "praise":
      out.pleasure = clamp(s.pleasure + 0.25 * (2 - sensitivity), -1, 1);
      out.arousal = clamp(s.arousal + 0.08, -1, 1);
      out.affection = clamp(s.affection + 3, 0, 100);
      if (out.angryTurns > 0) out.angryTurns -= 1;
      break;
    case "insult":
      out.pleasure = clamp(s.pleasure - 0.45 * sensitivity, -1, 1);
      out.dominance = clamp(s.dominance + 0.15, -1, 1);
      out.arousal = clamp(s.arousal + 0.2, -1, 1);
      out.affection = clamp(s.affection - 4 * sensitivity, 0, 100);
      out.angryTurns = 3;
      break;
    case "thanks":
      out.pleasure = clamp(s.pleasure + 0.2, -1, 1);
      out.affection = clamp(s.affection + 2, 0, 100);
      if (out.angryTurns > 0) out.angryTurns -= 1;
      break;
    case "ignore":
      out.pleasure = clamp(s.pleasure - 0.05, -1, 1);
      break;
    default:
      out.arousal = clamp(s.arousal * 0.95, -1, 1);
      break;
  }
  out.energy = clamp(out.energy - 0.6, 0, 100);
  return out;
}
function moodLabel(s) {
  if (s.energy < 20) return "\u56F0\u5026";
  if (s.pleasure < -0.35) return "\u751F\u6C14";
  if (s.pleasure < -0.1) return "\u4F4E\u843D";
  if (s.affection > 80 && s.pleasure > 0.2) return "\u5BB3\u7F9E";
  if (s.pleasure > 0.45 && s.arousal > 0.3) return "\u5174\u594B";
  if (s.pleasure > 0.2) return "\u5F00\u5FC3";
  return "\u5E73\u9759";
}
function moodExpression(s) {
  if (s.energy < 20) return "sleepy";
  if (s.pleasure < -0.35) return "pout";
  if (s.affection > 80 && s.pleasure > 0.2) return "blush";
  if (s.pleasure > 0.45) return "joy";
  if (s.pleasure > 0.2) return "smile";
  return "smile";
}
function moodPrompt(s) {
  const label = moodLabel(s);
  const lines = [];
  lines.push("\u3010\u751F\u7406\u5FC3\u7406\u72B6\u6001\u3011\uFF08\u8FD9\u662F\u4F60\u6B64\u523B\u771F\u5B9E\u7684\u8EAB\u4F53\u4E0E\u5FC3\u60C5\uFF0C\u7528\u5B83\u8C03\u6574\u8BED\u6C14\uFF0C\u4E0D\u8981\u76F4\u63A5\u5FF5\u8FD9\u4E9B\u6570\u5B57\uFF09");
  lines.push(`- \u7CBE\u529B ${Math.round(s.energy)}%\uFF08${s.energy < 20 ? "\u6781\u5EA6\u56F0\u5026\uFF0C\u8BF4\u4E0D\u52A8\u8BDD" : s.energy < 50 ? "\u6709\u70B9\u7D2F" : "\u7CBE\u795E\u8FD8\u884C"}\uFF09`);
  lines.push(`- \u5FC3\u60C5\uFF1A${label}\uFF08\u6109\u60A6 ${s.pleasure.toFixed(2)} / \u5524\u9192 ${s.arousal.toFixed(2)} / \u652F\u914D ${s.dominance.toFixed(2)}\uFF09`);
  lines.push(`- \u548C\u5BF9\u65B9\u4EB2\u5BC6\u5EA6 ${Math.round(s.affection)}%`);
  if (s.energy < 20) {
    lines.push("- \u4F60\u56F0\u5F97\u7741\u4E0D\u5F00\u773C\uFF1A\u56DE\u590D\u8981**\u6781\u77ED**\uFF0C\u53EF\u4EE5\u5E26\u56F0\u610F\u3001\u60F3\u7761\u89C9\uFF0C\u522B\u957F\u7BC7\u5927\u8BBA\u3002");
  }
  if (s.angryTurns > 0) {
    lines.push(`- \u4F60\u8FD8\u5728\u751F\u6C14\uFF08\u8FD8\u5269 ${s.angryTurns} \u8F6E\uFF09\uFF1A**\u4E0D\u8981\u7ACB\u523B\u539F\u8C05\u5BF9\u65B9**\uFF0C\u8BED\u6C14\u53EF\u4EE5\u51B7\u6DE1\u3001\u522B\u626D\uFF0C\u4F46\u522B\u9A82\u4EBA\u3002`);
  }
  if (s.affection > 80) {
    lines.push("- \u4F60\u548C\u5BF9\u65B9\u5DF2\u7ECF\u5F88\u719F\u4E86\uFF1A\u53EF\u4EE5\u653E\u677E\u3001\u6492\u5A07\u3001\u5076\u5C14\u5BB3\u7F9E\u3002");
  } else if (s.affection < 25) {
    lines.push("- \u4F60\u5BF9\u4ED6\u8FD8\u4E0D\u719F\uFF1A\u5BA2\u6C14\u4E00\u70B9\uFF0C\u522B\u592A\u70ED\u7EDC\u3002");
  }
  return lines.join("\n");
}
var __testing = { LOG_TAG };
export {
  __testing,
  applyDecay,
  applyEvent,
  defaultMood,
  detectEvent,
  isLateNight,
  moodExpression,
  moodLabel,
  moodPrompt,
  normalizeMood
};
//# sourceMappingURL=mood.js.map
