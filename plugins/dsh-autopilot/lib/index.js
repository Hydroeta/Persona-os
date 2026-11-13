// src/index.ts
import { execFile } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

// src/index.ts
var LOG_TAG = "[dsh-autopilot]";
function findRepoRoot(start) {
  let cur = resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, ".git"))) return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return resolve(start);
}
function run(cmd, args, cwd, timeoutMs = 18e4) {
  return new Promise((res) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      res({ code, out: `${stdout || ""}${stderr || ""}`.trim() });
    });
  });
}
async function saveProposal(opts) {
  const title = (opts.title || "").trim();
  const body = opts.markdown_content || "";
  if (!title) return { ok: false, error: "title \u4E0D\u80FD\u4E3A\u7A7A" };
  if (body.trim().length < 20) return { ok: false, error: "\u65B9\u6848\u5185\u5BB9\u592A\u77ED\uFF08\u81F3\u5C11 20 \u5B57\uFF09\uFF0C\u4E0D\u50CF\u4E00\u4EFD\u53EF\u5BA1\u6279\u7684\u65B9\u6848" };
  const rel = proposalRelPath(opts.now ?? /* @__PURE__ */ new Date(), title);
  const abs = join(opts.root, rel);
  try {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body, "utf8");
    return { ok: true, path: rel };
  } catch (e) {
    return { ok: false, error: `\u5199\u5165\u5931\u8D25\uFF1A${e.message}` };
  }
}
async function executeEvolution(opts) {
  const root = opts.root;
  const dry = opts.dryRun !== false;
  const steps = [];
  const push = (step, ok, detail) => steps.push({ step, ok, detail });
  const proposalAbs = join(root, (opts.proposalPath || "").replace(/\\/g, "/"));
  if (!opts.proposalPath || !existsSync(proposalAbs)) {
    return { ok: false, dry_run: dry, steps, error: `\u63D0\u6848\u4E0D\u5B58\u5728\uFF1A${opts.proposalPath || "(\u7A7A)"}` };
  }
  const issues = validateChanges(root, opts.changes || []);
  if (issues.length) {
    return {
      ok: false,
      dry_run: dry,
      steps,
      error: `\u6539\u52A8\u6821\u9A8C\u672A\u901A\u8FC7\uFF1A${issues.map((i) => `${i.file_path || ""} ${i.reason}`).join("\uFF1B")}`
    };
  }
  push("\u6821\u9A8C\u6539\u52A8\uFF08\u8DEF\u5F84/\u654F\u611F\u5185\u5BB9\uFF09", true, `${opts.changes.length} \u4E2A\u6587\u4EF6`);
  if (dry) {
    push("dry_run\uFF1A\u672A\u5199\u5165\u4EFB\u4F55\u6587\u4EF6", true, "\u4F20 dry_run:false + confirm:true \u624D\u771F\u6267\u884C");
    return { ok: true, dry_run: true, steps };
  }
  if (opts.confirm !== true) {
    return { ok: false, dry_run: false, steps, error: "\u7F3A\u5C11 confirm:true\uFF0C\u62D2\u7EDD\u771F\u6267\u884C" };
  }
  const status = await run("git", ["status", "--porcelain"], root);
  const head = await run("git", ["rev-parse", "HEAD"], root);
  const restoreRef = head.code === 0 ? head.out.trim() : "";
  push("\u8BB0\u5F55\u8FD8\u539F\u70B9", true, restoreRef ? restoreRef.slice(0, 8) : "(\u65E0 HEAD)");
  const dirty = status.out.length > 0;
  if (dirty) {
    const backup = await run("git", ["add", "-A"], root);
    const commit2 = await run("git", ["commit", "-m", "chore(auto): backup before evolution"], root);
    push("\u5907\u4EFD\u5F53\u524D\u6539\u52A8\uFF08commit\uFF09", backup.code === 0 && commit2.code === 0, commit2.out.split("\n")[0]);
  }
  const restore = async (why) => {
    await run("git", ["checkout", "--", "."], root);
    if (restoreRef) await run("git", ["reset", "--hard", restoreRef], root);
    push("\u56DE\u6EDA\u5230\u6267\u884C\u524D", true, why);
    return { ok: false, dry_run: false, steps, error: why };
  };
  try {
    for (const c of opts.changes) {
      const abs = join(root, c.file_path.replace(/\\/g, "/"));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, c.new_content, "utf8");
    }
    push("\u5199\u5165\u6587\u4EF6", true, opts.changes.map((c) => c.file_path).join(", ").slice(0, 200));
  } catch (e) {
    return await restore(`\u5199\u6587\u4EF6\u5931\u8D25\uFF1A${e.message}`);
  }
  if (opts.build !== false) {
    const targets = buildTargets(opts.changes);
    for (const dir of targets) {
      const buildFile = join(root, dir, "build.mjs");
      if (!existsSync(buildFile)) continue;
      const r = await run(process.execPath, ["build.mjs"], join(root, dir), 18e4);
      const ok = r.code === 0;
      push(`\u7F16\u8BD1 ${dir}`, ok, ok ? "" : r.out.slice(-400));
      if (!ok) return await restore(`\u7F16\u8BD1\u5931\u8D25\uFF1A${dir}`);
    }
    if (!targets.length) push("\u7F16\u8BD1", true, "\u6539\u7684\u6587\u4EF6\u4E0D\u5728\u63D2\u4EF6\u76EE\u5F55\uFF0C\u8DF3\u8FC7");
  }
  const msg = normalizeCommitMessage(opts.commitMessage);
  await run("git", ["add", "-A"], root);
  const commit = await run("git", ["commit", "-m", msg], root);
  if (commit.code !== 0) return await restore(`\u63D0\u4EA4\u5931\u8D25\uFF1A${commit.out.slice(-300)}`);
  const sha = (await run("git", ["rev-parse", "--short", "HEAD"], root)).out.trim();
  push("\u63D0\u4EA4", true, sha);
  let pushed = false;
  for (let i = 1; i <= 3 && !pushed; i++) {
    const p = await run("git", ["push"], root, 12e4);
    pushed = p.code === 0 || /main -> main|Everything up-to-date/.test(p.out);
    push(`\u63A8\u9001\uFF08\u7B2C ${i} \u6B21\uFF09`, pushed, pushed ? "" : p.out.slice(-300));
  }
  if (!pushed) {
    return { ok: false, dry_run: false, steps, error: "\u63A8\u9001\u4E09\u6B21\u90FD\u5931\u8D25\uFF0C\u672C\u5730\u5DF2\u63D0\u4EA4\uFF0C\u9700\u4EBA\u5DE5\u5904\u7406", commit: sha };
  }
  return { ok: true, dry_run: false, steps, commit: sha };
}
var name = "dsh-autopilot";
function apply(ctx) {
  const root = process.env.DSH_AUTOPILOT_ROOT ? resolve(process.env.DSH_AUTOPILOT_ROOT) : findRepoRoot(process.cwd());
  console.log(`${LOG_TAG} \u5DF2\u52A0\u8F7D\uFF0C\u4ED3\u5E93\u6839\uFF1A${root}`);
  const disposers = [];
  const saveTool = {
    name: "save_proposal",
    description: "\u628A\u4E00\u4EFD\u81EA\u8FDB\u5316\u65B9\u6848\u5199\u8FDB data/proposals/YYYY-MM-DD_\u6807\u9898.md\uFF0C\u8FD4\u56DE\u76F8\u5BF9\u8DEF\u5F84\uFF08\u4F9B\u4EBA\u5BA1\u6279\uFF09\u3002",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["title", "markdown_content"],
      properties: {
        title: { type: "string", description: "\u65B9\u6848\u6807\u9898\uFF08\u4F1A\u6210\u4E3A\u6587\u4EF6\u540D\uFF09" },
        markdown_content: { type: "string", description: "\u65B9\u6848\u6B63\u6587\uFF08Markdown\uFF09" }
      }
    },
    output: {
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" }, path: { type: "string" }, error: { type: "string" } }
      },
      render: (_a, v) => [
        { type: "text", text: v?.ok ? `\u{1F4DD} \u65B9\u6848\u5DF2\u4FDD\u5B58\uFF1A${v.path}` : `\u274C \u4FDD\u5B58\u5931\u8D25\uFF1A${v?.error ?? "\u672A\u77E5"}` }
      ]
    },
    async execute(args) {
      return await saveProposal({ root, title: String(args?.title ?? ""), markdown_content: String(args?.markdown_content ?? "") });
    },
    presentCall: (a) => ({ card: "generic", title: `\u4FDD\u5B58\u65B9\u6848 \u2192 ${String(a?.title ?? "")}`, kind: "write" })
  };
  const executeTool = {
    name: "execute_evolution",
    description: "\u6309\u5BA1\u6279\u8FC7\u7684\u65B9\u6848\u6539\u4EE3\u7801\uFF1A\u6821\u9A8C\u8DEF\u5F84\u4E0E\u654F\u611F\u5185\u5BB9 \u2192 \u5907\u4EFD \u2192 \u5199\u6587\u4EF6 \u2192 \u9010\u63D2\u4EF6\u7F16\u8BD1 \u2192 \u63D0\u4EA4 \u2192 \u63A8\u9001\uFF0C\u4EFB\u4E00\u6B65\u5931\u8D25\u81EA\u52A8\u56DE\u6EDA\u3002\u9ED8\u8BA4 dry_run=true\uFF0C\u5FC5\u987B\u663E\u5F0F dry_run:false \u4E14 confirm:true \u624D\u771F\u6267\u884C\u3002",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["proposal_path", "changes"],
      properties: {
        proposal_path: { type: "string", description: "\u63D0\u6848\u6587\u4EF6\u76F8\u5BF9\u8DEF\u5F84\uFF08data/proposals/\u2026\uFF09" },
        changes: {
          type: "array",
          description: "\u8981\u8986\u76D6\u7684\u6587\u4EF6\u5217\u8868\uFF0C\u6700\u591A 30 \u4E2A",
          items: {
            type: "object",
            required: ["file_path", "new_content"],
            properties: { file_path: { type: "string" }, new_content: { type: "string" } }
          }
        },
        commit_message: { type: "string", description: "\u63D0\u4EA4\u4FE1\u606F\uFF0C\u9ED8\u8BA4 chore(auto): \u81EA\u8FDB\u5316\u53D8\u66F4" },
        dry_run: { type: "boolean", description: "\u9ED8\u8BA4 true\uFF1A\u53EA\u6821\u9A8C\u4E0D\u5199\u5165" },
        confirm: { type: "boolean", description: "\u771F\u6267\u884C\u5FC5\u987B\u663E\u5F0F\u4F20 true" },
        build: { type: "boolean", description: "\u662F\u5426\u9010\u63D2\u4EF6\u7F16\u8BD1\uFF0C\u9ED8\u8BA4 true" }
      }
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          dry_run: { type: "boolean" },
          steps: { type: "array" },
          error: { type: "string" },
          commit: { type: "string" }
        }
      },
      render: (_a, v) => [
        {
          type: "text",
          text: `${v?.ok ? "\u2705" : "\u274C"} \u81EA\u8FDB\u5316${v?.dry_run ? "\uFF08dry run\uFF09" : ""}${v?.commit ? ` \xB7 ${v.commit}` : ""}
${(v?.steps || []).map((s) => `${s.ok ? "\xB7" : "\u2717"} ${s.step}${s.detail ? `\uFF1A${s.detail}` : ""}`).join("\n")}` + (v?.error ? `
\u2757 ${v.error}` : "")
        }
      ]
    },
    async execute(args) {
      return await executeEvolution({
        root,
        proposalPath: String(args?.proposal_path ?? ""),
        changes: Array.isArray(args?.changes) ? args.changes : [],
        commitMessage: String(args?.commit_message ?? ""),
        dryRun: args?.dry_run !== false,
        confirm: args?.confirm === true,
        build: args?.build !== false
      });
    },
    presentCall: (a) => ({ card: "generic", title: `\u81EA\u8FDB\u5316 \u2192 ${String(a?.commit_message ?? "")}`, kind: "write" })
  };
  for (const t of [saveTool, executeTool]) {
    try {
      const d = ctx.tools.register(t);
      if (typeof d === "function") disposers.push(d);
      console.log(`${LOG_TAG} \u5DF2\u6CE8\u518C\u5DE5\u5177 ${t.name}`);
    } catch (e) {
      console.error(`${LOG_TAG} \u6CE8\u518C ${t.name} \u5931\u8D25\uFF1A`, e);
    }
  }
  ctx.on("dispose", () => {
    for (const d of disposers) {
      try {
        d();
      } catch {
      }
    }
    console.log(`${LOG_TAG} disposed`);
  });
}
export {
  LOG_TAG,
  readFile as _read,
  rm as _rm,
  run as _run,
  apply,
  buildTargets,
  executeEvolution,
  findRepoRoot,
  name,
  proposalRelPath,
  saveProposal,
  scanSecrets,
  slugify,
  validateChanges
};
//# sourceMappingURL=index.js.map
