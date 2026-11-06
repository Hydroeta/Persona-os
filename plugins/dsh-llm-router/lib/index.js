// src/index.ts
async function openAiCompatChat(baseUrl, apiKey, model, messages, opts = {}) {
  const body = { model, messages, stream: false };
  if (opts.temperature != null) body.temperature = opts.temperature;
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const r = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: opts.signal
  });
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    throw new Error(`LLM ${baseUrl} \u8FD4\u56DE ${r.status}\uFF1A${text.slice(0, 300)}`);
  }
  const content = data?.choices?.[0]?.message?.content ?? "";
  return { content, provider: baseUrl, model, raw: data };
}
var DeepSeekProvider = class {
  id = "deepseek";
  baseUrl;
  apiKey;
  model;
  constructor(opts) {
    this.baseUrl = opts?.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
    this.apiKey = opts?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? null;
    this.model = opts?.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
  }
  async chat(messages, opts = {}) {
    if (!this.apiKey) {
      throw new Error("DeepSeekProvider\uFF1A\u672A\u8BBE\u7F6E DEEPSEEK_API_KEY\uFF08\u8BF7\u5728\u73AF\u5883\u53D8\u91CF\u4E2D\u914D\u7F6E\uFF0C\u52FF\u5199\u5165\u4EE3\u7801\uFF09");
    }
    const r = await openAiCompatChat(this.baseUrl, this.apiKey, opts.model ?? this.model, messages, opts);
    return { ...r, provider: "deepseek" };
  }
};
var OllamaProvider = class {
  id = "ollama";
  baseUrl;
  model;
  constructor(opts) {
    this.baseUrl = opts?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
    this.model = opts?.model ?? process.env.OLLAMA_MODEL ?? "qwen2.5:7b";
  }
  async chat(messages, opts = {}) {
    const r = await openAiCompatChat(this.baseUrl, null, opts.model ?? this.model, messages, opts);
    return { ...r, provider: "ollama" };
  }
};
var GeminiProvider = class {
  id = "gemini";
  async chat() {
    throw new Error("GeminiProvider \u5C1A\u672A\u5B9E\u73B0\uFF08\u63A5\u53E3\u5DF2\u9884\u7559\uFF0C\u5F85\u540E\u7EED\u63A5\u5165\uFF09");
  }
};
var LLMRouter = class {
  providers;
  contextThreshold;
  constructor(opts) {
    this.providers = opts?.providers ?? {
      deepseek: new DeepSeekProvider(),
      ollama: new OllamaProvider(),
      gemini: new GeminiProvider()
    };
    const envT = Number(process.env.LLM_ROUTER_CONTEXT_THRESHOLD);
    this.contextThreshold = opts?.contextThreshold ?? (Number.isFinite(envT) && envT > 0 ? envT : 24e3);
  }
  estimateChars(messages) {
    return messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0);
  }
  /** 决定本轮走哪个 provider。 */
  route(messages, opts = {}) {
    if (opts.prefer && opts.prefer !== "auto") return opts.prefer;
    if (opts.background) return "ollama";
    if (this.estimateChars(messages) >= this.contextThreshold) return "ollama";
    return "deepseek";
  }
  async chat(messages, opts = {}) {
    const id = this.route(messages, opts);
    const p = this.providers[id];
    if (!p) throw new Error(`LLMRouter\uFF1A\u672A\u77E5 provider "${id}"`);
    return p.chat(messages, opts);
  }
};
function createDefaultRouter() {
  return new LLMRouter();
}
function msgContent(m) {
  if (typeof m === "string") return m;
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((b) => typeof b?.text === "string" ? b.text : "").join("");
  }
  return "";
}
function extractMessages(objs) {
  for (const o of objs) {
    if (!o || typeof o !== "object") continue;
    for (const key of ["messages", "input"]) {
      if (Array.isArray(o[key])) return o[key];
    }
  }
  return [];
}
var LOG_TAG = "[dsh-llm-router]";
var index_default = {
  name: "dsh-llm-router",
  apply(ctx) {
    const router = createDefaultRouter();
    const serviceApi = {
      chat: router.chat.bind(router),
      route: router.route.bind(router),
      estimateChars: router.estimateChars.bind(router),
      providers: router.providers,
      router
    };
    try {
      if (typeof ctx.set === "function") {
        ctx.set("llmRouter", serviceApi);
        console.log(`${LOG_TAG} \u5DF2\u66B4\u9732 llmRouter \u670D\u52A1\uFF08ctx.get('llmRouter')\uFF09`);
      } else {
        console.log(`${LOG_TAG} ctx.set \u4E0D\u53EF\u7528\uFF0C\u672A\u66B4\u9732 llmRouter \u670D\u52A1\uFF1B\u4ECD\u53EF\u901A\u8FC7\u6A21\u5757\u5BFC\u5165\u4F7F\u7528`);
      }
    } catch (e) {
      console.error(`${LOG_TAG} \u66B4\u9732 llmRouter \u670D\u52A1\u5931\u8D25\uFF1A${e.message}`);
    }
    const ollamaProviderId = (process.env.LLM_ROUTER_OLLAMA_PROVIDER || "").trim();
    const ollamaModelOverride = (process.env.LLM_ROUTER_OLLAMA_MODEL || "").trim();
    const deepseekProviderId = (process.env.LLM_ROUTER_DEEPSEEK_PROVIDER || "deepseek-official").trim();
    let loggedOriginal = false;
    if (ollamaProviderId) {
      ctx.on("agent/request", async (payload, next) => {
        let cfg;
        try {
          cfg = await next();
        } catch (e) {
          throw e;
        }
        try {
          if (!loggedOriginal) {
            loggedOriginal = true;
            console.log(`${LOG_TAG} \u89C2\u6D4B\u539F\u59CB\u8BF7\u6C42 provider=${cfg?.provider} model=${cfg?.model}`);
          }
          const agent = payload?.agent;
          const isSubagent = agent?.session?.header?.origin === "subagent";
          const msgs = extractMessages([payload, cfg, payload?.agent]);
          const chars = msgs.reduce((s, m) => s + msgContent(m).length, 0);
          const wantOllama = isSubagent || chars >= router.contextThreshold;
          if (wantOllama) {
            const out = { ...cfg, provider: ollamaProviderId };
            if (ollamaModelOverride) out.model = ollamaModelOverride;
            console.log(
              `${LOG_TAG} \u8DEF\u7531 \u2192 ollama\uFF08origin=${isSubagent ? "subagent" : "main"}\uFF0Cest_chars=${chars}\uFF09`
            );
            return out;
          }
          if (cfg?.provider && cfg.provider !== deepseekProviderId) {
            console.log(`${LOG_TAG} \u8DEF\u7531 \u2192 ${deepseekProviderId}\uFF08\u539F provider=${cfg.provider}\uFF09`);
            return { ...cfg, provider: deepseekProviderId };
          }
          return cfg;
        } catch (e) {
          console.error(`${LOG_TAG} \u8DEF\u7531\u62E6\u622A\u5931\u8D25\uFF0Cfail-open \u653E\u884C\u539F\u59CB\u914D\u7F6E\uFF1A${e.message}`);
          return cfg;
        }
      });
      console.log(`${LOG_TAG} agent/request \u900F\u660E\u62E6\u622A\u5DF2\u542F\u7528\uFF08ollama provider=${ollamaProviderId}\uFF09`);
    } else {
      console.log(
        `${LOG_TAG} agent/request \u900F\u660E\u62E6\u622A\u672A\u542F\u7528\uFF08\u672A\u8BBE\u7F6E LLM_ROUTER_OLLAMA_PROVIDER\uFF09\uFF1Bchat() \u670D\u52A1/\u6A21\u5757\u5BFC\u5165\u4ECD\u53EF\u7528\u3002\u8BBE\u7F6E\u8BE5\u73AF\u5883\u53D8\u91CF\u4E3A DSH \u4E2D Ollama \u7684 provider id \u5373\u53EF\u542F\u7528\u3002`
      );
    }
    ctx.on("dispose", () => {
      console.log(`${LOG_TAG} disposed`);
    });
  }
};
export {
  DeepSeekProvider,
  GeminiProvider,
  LLMRouter,
  OllamaProvider,
  createDefaultRouter,
  index_default as default
};
//# sourceMappingURL=index.js.map
