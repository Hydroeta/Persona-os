// src/index.ts
var LOG_TAG = "[dsh-memory-bus]";
if (!process.env.MEMORY_BUS_URL) process.env.MEMORY_BUS_URL = "http://127.0.0.1:8001";
var BASE_URL = (process.env.MEMORY_BUS_URL || "http://127.0.0.1:8001").replace(/\/$/, "");
async function postJson(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!r.ok) throw new Error(`memory \u670D\u52A1 ${url} \u8FD4\u56DE ${r.status}: ${text || r.statusText}`);
  return data;
}
async function getJson(url) {
  const r = await fetch(url);
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!r.ok) throw new Error(`memory \u670D\u52A1 ${url} \u8FD4\u56DE ${r.status}: ${text || r.statusText}`);
  return data;
}
var tools = [
  {
    name: "save_memory",
    description: "\u628A\u4E00\u6BB5\u6587\u672C\u5B58\u5165\u957F\u671F\u8BB0\u5FC6\uFF08\u5199\u5165\u5E95\u5C42 SQLite \u8BB0\u5FC6\u5E93\uFF0Cmeow-memory \u4E5F\u80FD\u68C0\u7D22\u5230\uFF09\u3002\u9002\u5408\u8BB0\u5F55\uFF1A\u7528\u6237\u504F\u597D\u3001\u4E8B\u5B9E\u3001\u7EA6\u5B9A\u3001\u5F85\u529E\u63D0\u9192\u3002tags \u4E3A\u53EF\u9009\u5173\u952E\u8BCD\u5217\u8868\u3002",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string", description: "\u8981\u8BB0\u4F4F\u7684\u5185\u5BB9\uFF0C\u5C3D\u91CF\u5B8C\u6574\u5177\u4F53" },
        tags: { type: "array", items: { type: "string" }, description: "\u53EF\u9009\u5173\u952E\u8BCD\u6807\u7B7E\uFF0C\u4FBF\u4E8E recall \u68C0\u7D22" },
        level: {
          type: "string",
          enum: ["fact", "lesson", "topic", "user", "project", "rules", "soul"],
          default: "fact",
          description: "\u8BB0\u5FC6\u5C42\uFF0C\u9ED8\u8BA4 fact"
        }
      }
    },
    output: {
      schema: { type: "object", properties: { ok: { type: "boolean" }, id: { type: "string" }, level: { type: "string" } } },
      render: (_args, value) => [
        { type: "text", text: `\u2705 \u5DF2\u5B58\u5165\u8BB0\u5FC6\uFF08id=${String(value?.id ?? "").slice(0, 8)}\uFF0Clevel=${value?.level ?? "fact"}\uFF09` }
      ]
    },
    async execute(args) {
      const text = typeof args?.text === "string" ? args.text : "";
      if (!text.trim()) throw new Error("save_memory: text \u4E0D\u80FD\u4E3A\u7A7A");
      const tags = Array.isArray(args?.tags) ? args.tags.filter((x) => typeof x === "string") : [];
      const level = typeof args?.level === "string" ? args.level : "fact";
      const res = await postJson(`${BASE_URL}/remember`, { text, tags, level });
      return { ok: true, id: res.id, level: res.level ?? level };
    },
    presentCall(args) {
      return { card: "generic", title: `save_memory: ${String(args?.text ?? "").slice(0, 40)}`, kind: "write" };
    }
  },
  {
    name: "recall_memory",
    description: "\u6309\u5173\u952E\u8BCD\u4ECE\u957F\u671F\u8BB0\u5FC6\u4E2D\u68C0\u7D22\u76F8\u5173\u6761\u76EE\uFF08LIKE \u5339\u914D\u6807\u9898 / \u5185\u5BB9 / \u6807\u7B7E\uFF09\uFF0C\u8FD4\u56DE\u6700\u76F8\u5173\u7684\u82E5\u5E72\u6761\u3002\u9700\u8981\u56DE\u5FC6\u7528\u6237\u8BF4\u8FC7\u7684\u8BDD\u3001\u8FC7\u5F80\u4E8B\u5B9E\u65F6\u8C03\u7528\u3002",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "\u68C0\u7D22\u5173\u952E\u8BCD" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 }
      }
    },
    output: {
      schema: { type: "object", properties: { ok: { type: "boolean" }, count: { type: "integer" }, results: { type: "array" } } },
      render: (_args, value) => [
        { type: "text", text: `\u{1F50D} \u627E\u5230 ${value?.count ?? 0} \u6761\u76F8\u5173\u8BB0\u5FC6\u3002` }
      ]
    },
    async execute(args) {
      const query = typeof args?.query === "string" ? args.query : "";
      if (!query.trim()) throw new Error("recall_memory: query \u4E0D\u80FD\u4E3A\u7A7A");
      const limit = Number.isInteger(args?.limit) ? args.limit : 20;
      const url = `${BASE_URL}/recall?query=${encodeURIComponent(query)}&limit=${limit}`;
      const res = await getJson(url);
      const results = Array.isArray(res.results) ? res.results : [];
      return { ok: true, count: results.length, results };
    },
    presentCall(args) {
      return { card: "generic", title: `recall_memory: ${String(args?.query ?? "").slice(0, 40)}`, kind: "read" };
    }
  }
];
var index_default = {
  name: "dsh-memory-bus",
  apply(ctx) {
    console.log(`${LOG_TAG} apply (base=${BASE_URL})`);
    const disposers = [];
    for (const t of tools) {
      try {
        const d = ctx.tools.register(t);
        if (typeof d === "function") disposers.push(d);
        console.log(`${LOG_TAG} \u5DF2\u6CE8\u518C\u5DE5\u5177 ${t.name}`);
      } catch (e) {
        console.error(`${LOG_TAG} \u6CE8\u518C\u5DE5\u5177 ${t.name} \u5931\u8D25\uFF1A`, e);
      }
    }
    console.log(`${LOG_TAG} \u5171\u6CE8\u518C ${disposers.length} \u4E2A\u5DE5\u5177`);
    ctx.on("dispose", () => {
      console.log(`${LOG_TAG} dispose\uFF1A\u6CE8\u9500 ${disposers.length} \u4E2A\u5DE5\u5177`);
      for (const d of disposers) {
        try {
          d();
        } catch {
        }
      }
    });
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
