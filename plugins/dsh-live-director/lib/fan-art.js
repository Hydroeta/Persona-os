import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/fan-art.ts
import { existsSync } from "node:fs";
var LOG_TAG = "[dsh-live-director/fan-art]";
var sender = async (userId, filePath) => {
  console.log(`${LOG_TAG} [QQ Hook] \u51C6\u5907\u5C06 ${filePath} \u53D1\u9001\u7ED9 ${userId}`);
  return false;
};
function setFanArtSender(fn) {
  sender = fn;
}
async function sendFanArtToQQ(userId, filePath) {
  if (!userId || !filePath) return false;
  if (!existsSync(filePath)) {
    console.error(`${LOG_TAG} \u6587\u4EF6\u4E0D\u5B58\u5728\uFF0C\u8DF3\u8FC7\u4EA4\u4ED8\uFF1A${filePath}`);
    return false;
  }
  try {
    return await sender(userId, filePath);
  } catch (e) {
    console.error(`${LOG_TAG} \u4EA4\u4ED8\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u4F5C\u753B\uFF09\uFF1A${e.message}`);
    return false;
  }
}
export {
  sendFanArtToQQ,
  setFanArtSender
};
//# sourceMappingURL=fan-art.js.map
