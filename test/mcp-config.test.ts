/**
 * MCP 接入配置生成器测试。
 *
 * 这个功能的失败方式很隐蔽：路径拼错、JSON 少逗号、TOML 反斜杠转义炸——
 * 用户拿去粘贴才发现。所以这里逐格式验"能被目标客户端解析"的关键特征。
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { buildMcpConfig, MCP_CLIENTS } from "../src/mcp-config.js";

const OPTS = {
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  cliPath: "C:\\我的项目\\membrane\\dist\\cli.js",
  dbPath: "D:\\记忆\\membrane.db",
};

/**
 * db 路径经过 path.resolve() 归一化，而这个函数是**平台相关**的：
 * 在 Windows 上 `D:\记忆\membrane.db` 已是绝对路径，原样返回；
 * 在 Linux/macOS 上它不被认作绝对路径，会被拼到当前工作目录后面。
 *
 * nodePath 与 cliPath 不经过 resolve，任何平台都原样保留，所以只有 db 需要
 * 按平台算期望值。这样测试在两种平台上都能验证"路径确实被正确传递"，
 * 而不是硬编码 Windows 结果、在 CI 的 Linux runner 上必挂。
 */
const IS_WIN = process.platform === "win32";
const EXPECTED_DB = IS_WIN ? OPTS.dbPath : resolve(OPTS.dbPath);
/** Codex 的 TOML 用正斜杠，避免反斜杠被当成转义 */
const EXPECTED_DB_FORWARD = EXPECTED_DB.replace(/\\/g, "/");

describe("mcp-config：多客户端接入配置", () => {
  it("客户端清单完整且 id 不重复", () => {
    expect(MCP_CLIENTS.length).toBeGreaterThanOrEqual(20);
    const ids = new Set(MCP_CLIENTS.map((c) => c.id));
    expect(ids.size).toBe(MCP_CLIENTS.length);
  });

  it("Claude Desktop：合法 JSON，路径原样转义，args 带 mcp", () => {
    const r = buildMcpConfig("claude-desktop", OPTS);
    const parsed = JSON.parse(r.content) as {
      mcpServers: { membrane: { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(parsed.mcpServers.membrane.command).toBe(OPTS.nodePath);
    expect(parsed.mcpServers.membrane.args).toEqual([OPTS.cliPath, "mcp"]);
    expect(parsed.mcpServers.membrane.env["MEMBRANE_DB"]).toBe(EXPECTED_DB);
    expect(r.steps.join("\n")).toContain("claude_desktop_config.json");
  });

  it("VS Code：用 servers 键并声明 type=stdio（格式与别家不同）", () => {
    const r = buildMcpConfig("vscode", OPTS);
    const parsed = JSON.parse(r.content) as {
      servers: { membrane: { type: string } };
      mcpServers?: unknown;
    };
    expect(parsed.servers.membrane.type).toBe("stdio");
    expect(parsed.mcpServers).toBeUndefined();
  });

  it("Codex：TOML 语法 + 正斜杠路径（反斜杠会被当转义）", () => {
    const r = buildMcpConfig("codex", OPTS);
    expect(r.content).toContain("[mcp_servers.membrane]");
    expect(r.content).toContain('command = "C:/Program Files/nodejs/node.exe"');
    expect(r.content).toContain(`env = { MEMBRANE_DB = "${EXPECTED_DB_FORWARD}" }`);
    expect(r.content).not.toContain("\\\\");
  });

  it("Claude Code：生成一条可直接执行的 add 命令", () => {
    const r = buildMcpConfig("claude-code", OPTS);
    expect(r.content.startsWith("claude mcp add membrane -- ")).toBe(true);
    expect(r.content).toContain("mcp");
    expect(r.client.format).toBe("command");
  });

  it("Zed：context_servers 的 command 是对象，不是字符串", () => {
    const r = buildMcpConfig("zed", OPTS);
    const parsed = JSON.parse(r.content) as {
      context_servers: { membrane: { command: { path: string; args: string[] } } };
    };
    expect(parsed.context_servers.membrane.command.path).toBe(OPTS.nodePath);
    expect(parsed.context_servers.membrane.command.args).toEqual([OPTS.cliPath, "mcp"]);
  });

  it("未知客户端给出明确可用列表，不静默生成垃圾", () => {
    expect(() => buildMcpConfig("不存在的客户端", OPTS)).toThrow(/未知客户端/);
    expect(() => buildMcpConfig("不存在的客户端", OPTS)).toThrow(/claude-desktop/);
  });
});
