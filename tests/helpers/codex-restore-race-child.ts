import { restoreNativeCodex } from "../../src/codex/inject";

const result = restoreNativeCodex({ skipHistory: true });
console.log(JSON.stringify({
  success: result.success,
  message: result.message.slice(0, 240),
}));
