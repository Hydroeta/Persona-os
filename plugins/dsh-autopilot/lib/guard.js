// src/guard.ts
import { posix } from "node:path";
function slugify(title, maxLen = 40) {
  const cleaned = (title || "").replace(/[\\/:*?"<>|\r\n\t]/g, " ").replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "proposal").slice(0, maxLen);
}
function proposalRelPath(date, title) {
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return posix.join("data", "proposals", `${d}_${slugify(title)}.md`);
}
function isPathInsideRepo(root, relPath) {
  const p = (relPath || "").trim();
  if (!p) return { reason: "file_path \u4E3A\u7A7A" };
  if (/^[a-zA-Z]:/.test(p)) return { file_path: p, reason: "\u4E0D\u5141\u8BB8\u7EDD\u5BF9\u76D8\u7B26\u8DEF\u5F84" };
  if (p.startsWith("/") || p.startsWith("\\")) return { file_path: p, reason: "\u4E0D\u5141\u8BB8\u4EE5\u6839\u76EE\u5F55\u5F00\u5934\u7684\u8DEF\u5F84" };
  const norm = posix.normalize(p.replace(/\\/g, "/"));
  if (norm.startsWith("..") || norm.includes("/../")) return { file_path: p, reason: "\u8DEF\u5F84\u8D8A\u51FA\u4ED3\u5E93\uFF08\u5305\u542B ..\uFF09" };
  if (norm.startsWith(".git/") || norm === ".git") return { file_path: p, reason: "\u4E0D\u5141\u8BB8\u6539 .git" };
  const rootNorm = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!rootNorm) return { file_path: p, reason: "\u4ED3\u5E93\u6839\u4E3A\u7A7A" };
  return null;
}
var SECRET_PATTERNS = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}/, label: "\u7591\u4F3C API Key\uFF08sk-\u2026\uFF09" },
  { re: /C:\\Users\\[^\\\s"']+/i, label: "\u672C\u673A\u7528\u6237\u76EE\u5F55\uFF08C:\\Users\\\u2026\uFF09" },
  { re: /(password|passwd|pwd)\s*[:=]\s*['"][^'"]+['"]/i, label: "\u786C\u7F16\u7801\u5BC6\u7801" },
  { re: /(api[_-]?key|secret|access[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-]{12,}['"]/i, label: "\u786C\u7F16\u7801\u5BC6\u94A5" },
  { re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: "\u79C1\u94A5" }
];
function scanSecrets(filePath, content) {
  const issues = [];
  for (const { re, label } of SECRET_PATTERNS) {
    const m = content.match(re);
    if (m) issues.push({ file_path: filePath, reason: `\u7591\u4F3C\u654F\u611F\u5185\u5BB9\uFF1A${label}`, hint: m[0].slice(0, 12) + "\u2026" });
  }
  return issues;
}
function validateChanges(root, changes) {
  const issues = [];
  if (!Array.isArray(changes) || changes.length === 0) {
    return [{ reason: "changes \u4E0D\u80FD\u4E3A\u7A7A" }];
  }
  if (changes.length > 30) issues.push({ reason: `\u4E00\u6B21\u6700\u591A\u6539 30 \u4E2A\u6587\u4EF6\uFF08\u6536\u5230 ${changes.length}\uFF09` });
  for (const c of changes) {
    const pathIssue = isPathInsideRepo(root, c?.file_path ?? "");
    if (pathIssue) {
      issues.push(pathIssue);
      continue;
    }
    if (typeof c.new_content !== "string" || !c.new_content.length) {
      issues.push({ file_path: c.file_path, reason: "new_content \u4E3A\u7A7A\uFF08\u4E0D\u63A5\u53D7\u7A7A\u6587\u4EF6\u8986\u76D6\uFF09" });
      continue;
    }
    issues.push(...scanSecrets(c.file_path, c.new_content));
  }
  return issues;
}
function buildTargets(changes) {
  const dirs = /* @__PURE__ */ new Set();
  for (const c of changes) {
    const norm = (c.file_path || "").replace(/\\/g, "/");
    const m = norm.match(/^plugins\/([^/]+)\//);
    if (m) dirs.add(`plugins/${m[1]}`);
  }
  return [...dirs];
}
function normalizeCommitMessage(msg) {
  const one = (msg || "").replace(/\s+/g, " ").trim();
  return (one || "chore(auto): \u81EA\u8FDB\u5316\u53D8\u66F4").slice(0, 120);
}
export {
  buildTargets,
  isPathInsideRepo,
  normalizeCommitMessage,
  proposalRelPath,
  scanSecrets,
  slugify,
  validateChanges
};
//# sourceMappingURL=guard.js.map
