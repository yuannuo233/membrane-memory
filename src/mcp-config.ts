/**
 * MCP 接入配置生成器（CLI `mcp-config` 用）。
 *
 * 为什么要有：适配文档里全是 `<你的node路径>` 这种占位符，新手要改 3 处路径、
 * 还容易把 JSON 逗号写错。这里直接按客户端生成"改一个都不用改"的配置：
 * node 路径 = 当前进程的可执行文件，cli.js = 本包 dist/cli.js，db = 环境变量或当前目录。
 *
 * 设计原则：
 * - 只生成**片段/整文件**文本，不主动改用户已有配置文件（避免覆盖别人的 mcpServers）
 * - 每种客户端的格式差异（JSON / TOML / YAML / CLI 命令）在这里收口
 * - 不确定的入口路径明确标"以官方最新版为准"，不假装 100% 精确
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 支持生成的客户端 id */
export type McpClientId =
  | "claude-desktop"
  | "claude-code"
  | "cursor"
  | "cline"
  | "roo"
  | "windsurf"
  | "vscode"
  | "gemini"
  | "codex"
  | "antigravity"
  | "continue"
  | "zed"
  | "workbuddy"
  | "zcode"
  | "astrbot"
  | "cherry-studio"
  | "lobechat"
  | "nextchat"
  | "n8n"
  | "dify"
  | "generic";

export type McpConfigFormat = "json" | "toml" | "yaml" | "command" | "fields";

export interface McpClientSpec {
  id: McpClientId;
  name: string;
  format: McpConfigFormat;
  /** 配置文件位置（UI 类客户端为"在设置里找 MCP"） */
  pathHint: string;
  /** 额外说明（合并注意事项、已知不确定点） */
  note?: string;
}

export const MCP_CLIENTS: McpClientSpec[] = [
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    format: "json",
    pathHint: "%APPDATA%\\Claude\\claude_desktop_config.json",
    note: "已有 mcpServers 时只追加 membrane 这一项，别覆盖其他 server。",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    format: "command",
    pathHint: "终端执行一次即可（写入 Claude Code 自己的配置）",
  },
  {
    id: "cursor",
    name: "Cursor",
    format: "json",
    pathHint: "项目内 .cursor/mcp.json（全局在 Cursor 设置 → MCP）",
    note: "项目级配置会跟着仓库走；记忆库路径建议用绝对路径。",
  },
  {
    id: "cline",
    name: "Cline",
    format: "json",
    pathHint: "扩展设置 → MCP Servers → Configure（cline_mcp_settings.json）",
  },
  {
    id: "roo",
    name: "Roo Code",
    format: "json",
    pathHint: "扩展设置 → MCP Servers（与 Cline 同源格式）",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    format: "json",
    pathHint: "%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json",
  },
  {
    id: "vscode",
    name: "VS Code Copilot",
    format: "json",
    pathHint: "项目内 .vscode/mcp.json",
    note: "VS Code 用 servers 键（不是 mcpServers），且要写 type=stdio。",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    format: "json",
    pathHint: "%USERPROFILE%\\.gemini\\settings.json",
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    format: "toml",
    pathHint: "%USERPROFILE%\\.codex\\config.toml",
    note: "TOML 语法：Windows 路径用正斜杠，避免反斜杠转义。",
  },
  {
    id: "antigravity",
    name: "Google Antigravity",
    format: "json",
    pathHint: "Settings 里搜 MCP（或工作区 .gemini/settings.json）",
    note: "各版本入口可能变化；配置内容与通用 JSON 一致。",
  },
  {
    id: "continue",
    name: "Continue",
    format: "yaml",
    pathHint: "%USERPROFILE%\\.continue\\config.yaml",
    note: "Continue 的 mcpServers 是列表形态；合并到你已有的列表里。",
  },
  {
    id: "zed",
    name: "Zed",
    format: "json",
    pathHint: "Zed settings.json 的 context_servers",
    note: "Zed 用 context_servers + command 对象，格式与其他家不同，已单独生成。",
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    format: "json",
    pathHint: "%USERPROFILE%\\.workbuddy\\mcp.json",
  },
  {
    id: "zcode",
    name: "zcode（智谱 GLM）",
    format: "json",
    pathHint: "%USERPROFILE%\\.zcode\\cli\\plugins\\<插件目录>\\membrane-plugin.json",
    note: "zcode 是插件包形态；本地插件加载入口随版本变化，放好后在设置里搜“插件/MCP”确认。",
  },
  {
    id: "astrbot",
    name: "AstrBot",
    format: "fields",
    pathHint: "WebUI → 插件市场装 astrbot_plugin_skills_mcp_manager → 添加 stdio server",
    note: "按下面的字段填；AstrBot 是 AGPL，但通过 MCP 通信不构成代码混合，Membrane 仍是 MIT。",
  },
  {
    id: "cherry-studio",
    name: "Cherry Studio",
    format: "fields",
    pathHint: "设置 → MCP 服务器 → 添加（stdio）",
  },
  {
    id: "lobechat",
    name: "LobeChat",
    format: "fields",
    pathHint: "设置 → 插件/MCP → 添加本地 stdio 服务",
  },
  {
    id: "nextchat",
    name: "NextChat",
    format: "fields",
    pathHint: "设置 → MCP 服务 → 添加",
  },
  {
    id: "n8n",
    name: "n8n",
    format: "fields",
    pathHint: "工作流里加 MCP Client 节点（stdio 模式）",
  },
  {
    id: "dify",
    name: "Dify",
    format: "fields",
    pathHint: "工具 → MCP 服务 → 添加 stdio 服务",
  },
  {
    id: "generic",
    name: "任意 MCP 客户端",
    format: "json",
    pathHint: "把 mcpServers 片段合并进客户端配置",
  },
];

export interface McpConfigOptions {
  /** node 可执行文件路径（默认当前进程） */
  nodePath?: string;
  /** dist/cli.js 路径（默认按本模块位置推断） */
  cliPath?: string;
  /** 数据库绝对路径（默认 MEMBRANE_DB 或当前目录 membrane.db） */
  dbPath?: string;
}

export interface McpConfigResult {
  client: McpClientSpec;
  /** 可直接粘贴/保存的文本 */
  content: string;
  /** 人类可读的落地步骤 */
  steps: string[];
}

/** 把反斜杠统一成正斜杠（TOML/YAML 里不用转义，Windows node 也认） */
function slash(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 默认路径推断：dist 目录 → cli.js；db 默认 cwd/membrane.db */
function resolvePaths(opts: McpConfigOptions): { node: string; cli: string; db: string } {
  const here = dirname(fileURLToPath(import.meta.url)); // 运行时 = <pkg>/dist（源码测试时 = src）
  const cli = opts.cliPath ?? join(here, "cli.js");
  const node = opts.nodePath ?? process.execPath;
  const db = resolve(opts.dbPath ?? process.env["MEMBRANE_DB"] ?? "membrane.db");
  return { node, cli, db };
}

function jsonBlock(node: string, cli: string, db: string, key: "mcpServers" | "servers"): string {
  const server: Record<string, unknown> = {
    command: node,
    args: [cli, "mcp"],
    env: { MEMBRANE_DB: db },
  };
  if (key === "servers") server["type"] = "stdio";
  return JSON.stringify({ [key]: { membrane: server } }, null, 2);
}

/** 生成指定客户端的接入配置 */
export function buildMcpConfig(clientId: string, opts: McpConfigOptions = {}): McpConfigResult {
  const client = MCP_CLIENTS.find((c) => c.id === clientId);
  if (!client) {
    throw new Error(
      `未知客户端：${clientId}。可用：${MCP_CLIENTS.map((c) => c.id).join(" / ")}`,
    );
  }
  const { node, cli, db } = resolvePaths(opts);
  const steps: string[] = [];
  let content = "";

  switch (client.id) {
    case "claude-code":
      content = `claude mcp add membrane -- "${node}" "${cli}" mcp`;
      steps.push("在终端执行上面这一行（路径已按当前环境填好）");
      steps.push("执行后重启 Claude Code，输入 /mcp 确认 membrane 已连接");
      break;
    case "codex":
      content = [
        "[mcp_servers.membrane]",
        `command = "${slash(node)}"`,
        `args = ["${slash(cli)}", "mcp"]`,
        `env = { MEMBRANE_DB = "${slash(db)}" }`,
      ].join("\n");
      steps.push(`保存/合并到 ${client.pathHint}`);
      steps.push("重启 Codex CLI，问它“用 membrane_recall 查用户住在哪”验证");
      break;
    case "continue":
      content = [
        "mcpServers:",
        "  - name: membrane",
        `    command: "${slash(node)}"`,
        "    args:",
        `      - "${slash(cli)}"`,
        '      - "mcp"',
        "    env:",
        `      MEMBRANE_DB: "${slash(db)}"`,
      ].join("\n");
      steps.push(`把这段追加到 ${client.pathHint} 的 mcpServers 列表`);
      steps.push("重启 Continue");
      break;
    case "zed":
      content = JSON.stringify(
        {
          context_servers: {
            membrane: {
              command: {
                path: node,
                args: [cli, "mcp"],
                env: { MEMBRANE_DB: db },
              },
            },
          },
        },
        null,
        2,
      );
      steps.push(`合并到 ${client.pathHint}`);
      steps.push("重启 Zed；在 Agent 面板确认 membrane 工具出现");
      break;
    case "vscode":
      content = jsonBlock(node, cli, db, "servers");
      steps.push(`保存为 ${client.pathHint}（已有 servers 就追加 membrane 这一项）`);
      steps.push("VS Code 里执行 MCP: List Servers，确认 membrane 已启动");
      break;
    case "zcode":
      content = JSON.stringify(
        {
          name: "membrane-local",
          version: "0.2.1",
          description: "Membrane 记忆脑：时间感知、可解释的 Agent 记忆",
          author: { name: "local" },
          license: "MIT",
          mcpServers: {
            membrane: {
              command: node,
              args: [cli, "mcp"],
              cwd: dirname(cli),
              env: { MEMBRANE_DB: db },
            },
          },
        },
        null,
        2,
      );
      steps.push(`建目录并保存为 ${client.pathHint}`);
      steps.push("重启 zcode；若没加载，在设置里搜“插件/MCP”确认入口");
      break;
    case "astrbot":
    case "cherry-studio":
    case "lobechat":
    case "nextchat":
    case "n8n":
    case "dify":
      content = [
        `命令（command）：${node}`,
        `参数（args）：${cli} mcp`,
        `环境变量：MEMBRANE_DB=${db}`,
      ].join("\n");
      steps.push(`入口：${client.pathHint}`);
      steps.push("类型选 stdio / 本地进程，把上面三行分别填进对应输入框");
      break;
    default: {
      content = jsonBlock(node, cli, db, "mcpServers");
      steps.push(`把上面 JSON 里的 membrane 项合并进 ${client.pathHint}`);
      steps.push("重启客户端，验证工具列表里出现 membrane_*");
    }
  }

  steps.push(`数据库：${db}（所有客户端都填同一个路径，记忆才是共享的）`);
  if (client.note) steps.push(client.note);
  return { client, content, steps };
}
