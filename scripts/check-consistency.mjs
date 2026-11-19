/**
 * 文档一致性检查（CI 用）。
 *
 * 存在的理由：DESIGN.md 被声明为"唯一事实源"，但 README 又抄了一遍数字，
 * 于是必然漂移。历史上真实发生过：徽章写 134 测试、表格还写 119；
 * MCP 工具数三处分别是 8 / 6 / 7；Node 下限 README 写 22.5、DESIGN 写 20。
 *
 * 本脚本从 package.json 和源码抓真实值，再扫全部文档比对。
 * 有任何不一致就以退出码 1 失败，让 CI 卡住。
 *
 * 用法：node scripts/check-consistency.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = [
  'README.md',
  'README.en.md',
  'DESIGN.md',
  'llms.txt',
  'why-membrane.md',
  '为什么用Membrane.md',
  '安装说明.md',
  '使用场景.md',
  '适配配置/各工具接入配置.md',
  '适配配置/REST与SDK接入.md',
];

/** 从源码抓"事实" */
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
const mcpSrc = readFileSync(join(root, 'src/mcp.ts'), 'utf8');
const versionSrc = readFileSync(join(root, 'src/version.ts'), 'utf8');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8').replace(/^\uFEFF/, ''));

const FACT = {
  version: pkg.version,
  nodeMinMajor: Number(String(pkg.engines.node).replace(/[^\d.]/g, '').split('.')[0]),
  nodeMinMinor: Number(String(pkg.engines.node).replace(/[^\d.]/g, '').split('.')[1] ?? 0),
  nodeMinRaw: String(pkg.engines.node),
  runtimeDeps: Object.keys(pkg.dependencies ?? {}),
  mcpTools: (mcpSrc.match(/name: "membrane_/g) || []).length,
};

const problems = [];

// 0) 版本唯一事实源：src/version.ts 必须等于 package.json，lock 也要跟
const srcVersion = versionSrc.match(/export const VERSION = "([^"]+)"/)?.[1];
if (srcVersion !== FACT.version) {
  problems.push(`src/version.ts 写 ${srcVersion ?? '(没找到)'}，package.json 是 ${FACT.version}`);
}
if (lock.version !== FACT.version || lock.packages?.['']?.version !== FACT.version) {
  problems.push(`package-lock.json 写 ${lock.version} / ${lock.packages?.['']?.version}，package.json 是 ${FACT.version}`);
}

// 0b) 源码里不允许再硬编码版本号（version.ts 自己是唯一事实源）
const srcDir = join(root, 'src');
for (const f of readdirSync(srcDir).filter((n) => n.endsWith('.ts') && n !== 'version.ts').sort()) {
  const text = readFileSync(join(srcDir, f), 'utf8');
  for (const m of text.matchAll(/(?:version|VERSION)\s*[:=]\s*"0\.\d+\.\d+"/g)) {
    problems.push(`src/${f}: 硬编码版本号（"${m[0]}"），应 import VERSION`);
  }
}

/** 测试用例数：从测试目录里数 it( 出现次数（动态扫，新增测试文件不用手改这里） */
let testCount = 0;
const testDir = join(root, 'test');
if (existsSync(testDir)) {
  for (const f of readdirSync(testDir).filter((n) => n.endsWith('.test.ts')).sort()) {
    testCount += (readFileSync(join(testDir, f), 'utf8').match(/^\s*it\(/gm) || []).length;
  }
}
FACT.tests = testCount;

/** 仓库里所有启动脚本（.bat / .cmd / .ps1），逐一检查是否成了孤儿 */
const trackedScripts = (() => {
  try {
    const out = execSync('git -c core.quotepath=false ls-files "*.bat" "*.cmd" "*.ps1"', {
      cwd: root,
      encoding: 'utf8',
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
})();

for (const doc of DOCS) {
  const p = join(root, doc);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');

  // 1) 测试数量
  for (const m of text.matchAll(/\b(\d{2,4})\s*(?:个)?\s*(?:tests|测试|用例|cases)/gi)) {
    const n = Number(m[1]);
    if (n > 10 && n !== FACT.tests) {
      problems.push(`${doc}: 测试数写作 ${n}，源码实际 ${FACT.tests}（"${m[0]}"）`);
    }
  }

  // 2) MCP 工具数量
  for (const m of text.matchAll(/(\d+)\s*(?:个\s*)?(?:工具|tools)/gi)) {
    const n = Number(m[1]);
    if (n >= 4 && n <= 10 && n !== FACT.mcpTools) {
      problems.push(`${doc}: MCP 工具数写作 ${n}，源码实际 ${FACT.mcpTools}（"${m[0]}"）`);
    }
  }

  // 3) Node 下限（比对 major.minor，避免 "22.5 解释文字" 被误伤）
  for (const m of text.matchAll(/Node\s*(?:>=|≥)\s*(\d+)\.(\d+)/gi)) {
    const major = Number(m[1]);
    const minor = Number(m[2]);
    const tooLow =
      major < FACT.nodeMinMajor ||
      (major === FACT.nodeMinMajor && minor < FACT.nodeMinMinor);
    if (tooLow) {
      problems.push(
        `${doc}: Node 下限写作 ${major}.${minor}，package.json 要求 ${FACT.nodeMinRaw}（"${m[0]}"）`,
      );
    }
  }

  // 4) 已移除的依赖不得作为现行依赖出现
  if (
    text.includes('@modelcontextprotocol/sdk') &&
    !/已移除|移除该|早已删除|已从|removed|no longer|deleted/i.test(text)
  ) {
    problems.push(`${doc}: 提到 @modelcontextprotocol/sdk 但未标注已移除（package.json 里没有它）`);
  }

  // 5) 裸的 npm 安装引导必须紧跟"未发布"说明
  const lines = text.split('\n');
  lines.forEach((ln, i) => {
    if (/npm install -g membrane-memory\s*$/.test(ln.trim())) {
      const ctx = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (!/404|未发布|not published|NOT on npm|not on npm/i.test(ctx)) {
        problems.push(`${doc}:${i + 1}: npm 安装引导未标注"尚未发布"（会 404）`);
      }
    }
  });

  // 6) 版本号漂移
  //
  // 要覆盖三种写法，任一漏掉都会让旧版本号偷偷留下：
  //   a. badge：version-0.2.6-blue
  //   b. 纯文本：- Version: 0.2.5   /  v0.2.5
  //   c. JSON 片段："version": "0.1.0"
  //
  // 排除历史性表述（"v0.2 新增"、"v0.2.1 质量版"）——那些是变更说明，本就该留在旧版本号上。
  const versionPatterns = [
    { re: /version[- ](0\.\d+\.\d+)/gi, label: 'badge' },
    { re: /^-?\s*Version:\s*(0\.\d+\.\d+)/gim, label: 'Version:' },
    { re: /"version":\s*"(0\.\d+\.\d+)"/g, label: 'JSON' },
  ];
  for (const { re, label } of versionPatterns) {
    for (const m of text.matchAll(re)) {
      if (m[1] !== FACT.version) {
        problems.push(
          `${doc}: ${label} 版本号写作 ${m[1]}，package.json 是 ${FACT.version}（"${m[0].trim()}"）`,
        );
      }
    }
  }
  // 独立成行的 v0.2.x 标题式声明（如 DESIGN 里的 "当前版本 v0.2.5"）
  for (const m of text.matchAll(/当前版本[：:\s]*v?(0\.\d+\.\d+)/g)) {
    if (m[1] !== FACT.version) {
      problems.push(`${doc}: "当前版本" 写作 ${m[1]}，package.json 是 ${FACT.version}`);
    }
  }
}

// 7) 启动脚本（.bat / .ps1 / .cmd）—— 最容易变成"没人管的孤儿文件"
//
// 教训来源：代码已到 v0.2.6，一键安装.bat 还停在 v0.1 时代——
// 写死 E:\开源盛世 绝对路径、不显示版本号、调用已废弃命令。
// 这些是用户双击时才会发现的，静态审查和单元测试都抓不到。
//
// 这里强制三条：
//   a. 不得写死本机绝对路径（必须 %~dp0 自定位）
//   b. 必须从 package.json 读版本，不得硬编码
//   c. 不得调用已废弃的 CLI 命令
const DEPRECATED_CLI = [
  'getBySupersededBy',
  'hardDelete',
];
for (const f of trackedScripts) {
  const full = join(root, f);
  if (!existsSync(full)) continue;
  // GBK 脚本用 latin1 读，只为匹配 ASCII 路径与命令
  const raw = readFileSync(full, 'latin1');

  // a. 硬编码盘符路径
  const absHits = [...raw.matchAll(/[A-Za-z]:\\[^\s"'\r\n]{3,}/g)].map((m) => m[0]);
  const realAbs = absHits.filter(
    (p) => !/^\w:\\Windows|^\w:\\Program Files|^\w:\\ProgramData/i.test(p),
  );
  // 只在 .bat/.cmd 里报；.ps1 允许出现示例路径
  if (/\.(bat|cmd)$/i.test(f) && realAbs.length > 0) {
    problems.push(
      `${f}: 硬编码绝对路径（换机器即失效），应改用 %~dp0 —— ${[...new Set(realAbs)].slice(0, 3).join(', ')}`,
    );
  }

  // b. 版本号读取
  const hasVersionRead = /set \/p VER=|VERSION\s*=|package\.json.*version/i.test(raw);
  if (!hasVersionRead) {
    problems.push(`${f}: 没有读取/显示版本号的逻辑，用户看不出这是哪个版本`);
  }

  // c. 废弃命令
  for (const dep of DEPRECATED_CLI) {
    if (raw.includes(dep)) {
      problems.push(`${f}: 调用了已删除的 API "${dep}"`);
    }
  }
}

console.log('=== 从源码抓到的真实值 ===');
console.log(`  版本          ${FACT.version}`);
console.log(`  Node 下限     ${FACT.nodeMinRaw}`);
console.log(`  运行时依赖    ${FACT.runtimeDeps.join(', ') || '(无)'}`);
console.log(`  MCP 工具数    ${FACT.mcpTools}`);
console.log(`  测试用例数    ${FACT.tests}`);
console.log('');

if (problems.length === 0) {
  console.log('✅ 全部文档与源码一致');
  process.exit(0);
}

console.log(`❌ 发现 ${problems.length} 处不一致：`);
for (const p of problems) console.log('  - ' + p);
process.exit(1);
