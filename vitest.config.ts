import { defineConfig } from "vitest/config";

/**
 * vitest 配置：
 * - 环境为 Node（本地优先，测试不触网）；
 * - MCP/CLI 冒烟测试要拉起子进程（node dist/cli.js），超时放宽到 60s；
 * - 单测直接 import src/*.ts（vite 能把 `.js` 后缀解析回 `.ts` 源文件），
 *   而 CLI/MCP 冒烟跑的是编译产物 dist/，所以 npm test = build + vitest run。
 */
export default defineConfig({
  test: {
    environment: "node",
    timeout: 60000,
    hookTimeout: 60000,
    testTimeout: 60000,
    // 只收 test/ 目录，避免把 dist 里可能的产物误当测试
    include: ["test/**/*.test.ts"],
  },
});
