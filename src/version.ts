/**
 * 版本号唯一事实源。
 *
 * 之前 server / mcp / mcp-config / doctor 各写一份 "0.2.x"，升版时漏一处
 * 就会出现"健康检查说 0.2.2、MCP 握手说 0.2.3"的漂移。这里集中定义，
 * 其余文件只允许 import VERSION；scripts/check-consistency.mjs 会校验
 * 它和 package.json 是否一致。
 */
export const VERSION = "0.2.7";
