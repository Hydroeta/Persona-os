// src/report-format.ts
var SECTIONS = ["\u5B9A\u5411", "\u6DF1\u6316", "\u501F\u529B", "\u5B9E\u8DF5"];
var SECTION_TITLES = {
  \u5B9A\u5411: "\u3010\u5B9A\u5411\u3011\u8981\u89E3\u51B3\u4EC0\u4E48\u95EE\u9898",
  \u6DF1\u6316: "\u3010\u6DF1\u6316\u3011\u67E5\u5230\u4E86\u4EC0\u4E48",
  \u501F\u529B: "\u3010\u501F\u529B\u3011\u53C2\u8003\u4E86\u4EC0\u4E48",
  \u5B9E\u8DF5: "\u3010\u5B9E\u8DF5\u3011\u6253\u7B97\u600E\u4E48\u505A"
};
var EMPTY_TEXT = {
  \u5B9A\u5411: "\uFF08\u8FD8\u6CA1\u60F3\u6E05\u695A\u8981\u89E3\u51B3\u4EC0\u4E48\uFF09",
  \u6DF1\u6316: "\uFF08\u6CA1\u6709\u67E5\u9605\u4EE3\u7801\u6216\u65E5\u5FD7\uFF09",
  \u501F\u529B: "\u6CA1\u6709\u53C2\u8003\u5916\u90E8\u65B9\u6848",
  \u5B9E\u8DF5: "\uFF08\u8FD8\u6CA1\u51B3\u5B9A\u600E\u4E48\u505A\uFF09"
};
function bullets(items) {
  const lines = (items ?? []).map((x) => String(x).trim()).filter(Boolean);
  return lines.length ? lines.map((x) => `- ${x}`).join("\n") : "";
}
function renderReport(input) {
  const groups = {
    \u5B9A\u5411: input.dings,
    \u6DF1\u6316: input.shenkan,
    \u501F\u529B: input.jieli,
    \u5B9E\u8DF5: input.shijian
  };
  const out = [`# ${(input.title || "").trim() || "\uFF08\u65E0\u6807\u9898\uFF09"}`, ""];
  for (const key of SECTIONS) {
    out.push(`## ${SECTION_TITLES[key]}`);
    const body = bullets(groups[key]);
    out.push(body || EMPTY_TEXT[key]);
    out.push("");
  }
  return out.join("\n").replace(/\s+$/, "") + "\n";
}
function parseSections(markdown) {
  const text = markdown || "";
  const marks = [];
  for (const key of SECTIONS) {
    const idx = text.indexOf(`## ${SECTION_TITLES[key]}`);
    if (idx >= 0) marks.push({ idx, key });
  }
  marks.sort((a, b) => a.idx - b.idx);
  const found = {};
  for (let i = 0; i < marks.length; i++) {
    const { idx, key } = marks[i];
    const start = idx + `## ${SECTION_TITLES[key]}`.length;
    const end = i + 1 < marks.length ? marks[i + 1].idx : text.length;
    found[key] = text.slice(start, end).trim();
  }
  for (const key of SECTIONS) {
    if (!(key in found)) found[key] = "";
  }
  return found;
}
function checkReport(markdown) {
  const problems = [];
  const secs = parseSections(markdown);
  for (const key of SECTIONS) {
    if (!secs[key]) problems.push(`\u7F3A\u5C11\u300C${key}\u300D\u5C0F\u8282`);
  }
  const present = SECTIONS.filter((k) => (markdown || "").includes(`## ${SECTION_TITLES[k]}`));
  const indices = present.map((k) => ({ k, i: markdown.indexOf(`## ${SECTION_TITLES[k]}`) }));
  indices.sort((a, b) => a.i - b.i);
  const actual = indices.map((x) => x.k);
  if (actual.join(",") !== present.join(",")) {
    problems.push(`\u5C0F\u8282\u987A\u5E8F\u4E0D\u5BF9\uFF1A\u5B9E\u9645 ${actual.join("\u2192")}\uFF0C\u8981\u6C42 ${present.join("\u2192")}`);
  }
  if (["", "\uFF08\u7A7A\uFF09", "\u65E0"].includes(secs["\u501F\u529B"])) {
    problems.push("\u300C\u501F\u529B\u300D\u4E3A\u7A7A\u65F6\u5FC5\u987B\u5982\u5B9E\u5199\u300C\u6CA1\u6709\u53C2\u8003\u5916\u90E8\u65B9\u6848\u300D");
  }
  return problems;
}
export {
  EMPTY_TEXT,
  SECTIONS,
  SECTION_TITLES,
  checkReport,
  parseSections,
  renderReport
};
//# sourceMappingURL=report-format.js.map
