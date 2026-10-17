// Public, non-secret wire limits shared by browser and server.
export const CHAT_LIMITS=Object.freeze({
  contextMessages:6,
  maxHistoryMessages:500,
  maxMessageChars:16000,
  requestBytes:128*1024,
  clientRequestBytes:120*1024,
});
export const RAG_LIMITS=Object.freeze({
  blocks:4,
  sources:5,
  citations:5,
  blockChars:1200,
  previewChars:300,
  rawChars:12000,
  transportBytes:256*1024,
});
