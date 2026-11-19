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
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = [
  'README.md',
  'README.en.md',
  'DESIGN.md',
  'llms.txt',
  'why-membrane.md',
  '为什么用Membrane.md',
];

/** 从源码抓"事实" */
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
const mcpSrc = readFileSync(join(root, 'src/mcp.ts'), 'utf8');

const FACT = {
  version: pkg.version,
  nodeMinMajor: Number(String(pkg.engines.node).replace(/[^\d.]/g, '').split('.')[0]),
  nodeMinRaw: String(pkg.engines.node),
  runtimeDeps: Object.keys(pkg.dependencies ?? {}),
  mcpTools: (mcpSrc.match(/name: "membrane_/g) || []).length,
};

/** 测试用例数：从测试文件里数 it( 出现次数 */
let testCount = 0;
for (const f of [
  'engine.test.ts', 'extract.test.ts', 'mcp.test.ts', 'model.test.ts',
  'robustness.test.ts', 'server.test.ts', 'storage.test.ts', 'tenant.test.ts',
]) {
  const p = join(root, 'test', f);
  if (!existsSync(p)) continue;
  testCount += (readFileSync(p, 'utf8').match(/^\s*it\(/gm) || []).length;
}
FACT.tests = testCount;

const problems = [];

for (const doc of DOCS) {
  const p = join(root, doc);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');

  // 1) 测试数量
  for (const m of text.matchAll(/\b(\d{2,4})\s*(?:个)?\s*(?:tests|测试)/gi)) {
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

  // 3) Node 下限
  for (const m of text.matchAll(/Node\s*(?:>=|≥)?\s*(\d+)(?:\.\d+)?/gi)) {
    const v = Number(m[1]);
    if (v >= 10 && v < FACT.nodeMinMajor) {
      problems.push(`${doc}: Node 下限写作 ${v}，package.json 要求 ${FACT.nodeMinRaw}（"${m[0]}"）`);
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

  // 6) 版本号（只查 badge / "version x.y.z" 形式，避免误伤历史记录）
  for (const m of text.matchAll(/version[- ]?(0\.\d+\.\d+)/gi)) {
    if (m[1] !== FACT.version) {
      problems.push(`${doc}: 版本号写作 ${m[1]}，package.json 是 ${FACT.version}`);
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
