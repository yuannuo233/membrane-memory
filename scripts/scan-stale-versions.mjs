/**
 * 版本号漂移扫描：找出所有"当前性"的过期版本引用。
 *
 * 存在的理由（用户的真实投诉）：
 *   仓库里多次出现代码已到 v0.2.6、某些文件还写着 v0.2.5 / v0.1.0 的情况。
 *   用户是在 GitHub 页面上亲眼看到的，而当时的 check-consistency 正则只认
 *   "version-0.2.6-blue" 和 "version 0.2.6" 两种写法，漏掉了
 *   "Version: 0.2.5"（冒号）和 "\"version\": \"0.1.0\""（JSON）。
 *
 * 本脚本换成"逐个文件扫所有 x.y.z 数字"的策略，再按上下文判断是
 * "当前声明"（必须等于 package.json）还是"历史叙述"（允许是旧版本）。
 *
 * 用法：node scripts/scan-stale-versions.mjs [--strict]
 *   退出码 0 = 无过期引用；1 = 有（CI 会失败）
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
const CURRENT = pkg.version;

/**
 * 允许出现旧版本号的文件：它们是变更历史，本就该记录"当时是什么版本"。
 * 加新文件到这里之前先想清楚——是不是真的属于历史记录。
 */
const HISTORY_FILES = new Set([
  'CHANGELOG.md',      // 每个版本的历史条目
  'DESIGN.md',         // "v0.2.1 质量版新增…" 这类变更说明
  'bench/README.md',   // 压测对比："v0.2.4 用 10.9s vs v0.2.5 用 0.30s"
  'scripts/scan-stale-versions.mjs',        // 本文件自身的注释示例
  'scripts/check-consistency.mjs',          // 同上
  // src/version.ts 的注释用 "健康检查说 0.2.2、MCP 握手说 0.2.3" 举例说明
  // 什么是版本漂移——那是解释，不是声明。该文件真正的版本号由导出常量决定。
  'src/version.ts',
]);

/**
 * 历史文件里，这些上下文说明是"叙述历史"而非"当前声明"，放行。
 * 例：累计 / 增至 / 版 / 新增 / 修复 / 对比 / → / 之前 / 曾经
 */
const HISTORY_CONTEXT = /新增|累计|增至|版本|版\b|修复|优化|对比|→|vs\b|历史|之前|曾经|旧锁|当时|回滚|升级自|自 v\d/i;

/** 形如 0.0.0.0 的 IP 不是版本号 */
const IP_LIKE = /^\d+\.\d+\.\d+\.\d+/;

// core.quotepath=false 是关键：默认 git 会把中文路径转义成 "\344\270\255..."
// 形式，导致 endsWith('.md') 之类的判断全部落空——中文文件会被静默跳过。
// 这正是历史上"明明有旧版本号却查不出来"的根因。
const tracked = execSync('git -c core.quotepath=false ls-files', { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean);

const problems = [];

for (const f of tracked) {
  if (!/\.(md|bat|ps1|ts|js|mjs|json|yml|yaml|txt)$/i.test(f)) continue;
  if (f === 'package-lock.json') continue;

  const full = join(root, f);
  if (!existsSync(full)) continue;

  let text;
  try {
    const buf = readFileSync(full);
    text = f.endsWith('.bat') ? buf.toString('latin1') : buf.toString('utf8');
  } catch {
    continue;
  }

  const isHistory = HISTORY_FILES.has(f);
  const lines = text.split(/\r?\n/);

  // 纯历史/说明性文件：整份跳过（它们的旧版本号是记录，不是声明）
  if (isHistory) continue;

  lines.forEach((line, idx) => {
    // 抓所有 x.y.z
    for (const m of line.matchAll(/\b(\d+\.\d+\.\d+)\b/g)) {
      const ver = m[1];

      // 必须是 0.x.y 形式，且不等于当前版本
      if (!/^0\.\d+\.\d+$/.test(ver) || ver === CURRENT) continue;

      // 排除 IP 地址片段（0.0.0.0 / 127.0.0.1）
      const tail = line.slice(m.index, m.index + 12);
      if (IP_LIKE.test(tail) && /^0\.0\.0$/.test(ver)) continue;
      if (/^127\.0\.0/.test(ver) || /^0\.0\.0$/.test(ver)) continue;

      // 历史文件 + 历史语境 → 放行
      if (isHistory && HISTORY_CONTEXT.test(line)) continue;

      problems.push({
        file: f,
        line: idx + 1,
        version: ver,
        snippet: line.trim().slice(0, 100),
      });
    }
  });
}

// package-lock.json 的两处版本必须等于当前版本
try {
  const raw = readFileSync(join(root, 'package-lock.json'), 'utf8').replace(/^\uFEFF/, '');
  const lock = JSON.parse(raw);
  if (lock.version !== CURRENT) {
    problems.push({ file: 'package-lock.json', line: 0, version: lock.version, snippet: '根对象 version' });
  }
  if (lock.packages?.['']?.version !== CURRENT) {
    problems.push({
      file: 'package-lock.json',
      line: 0,
      version: lock.packages?.['']?.version ?? '(缺失)',
      snippet: 'packages[""].version',
    });
  }
} catch {
  problems.push({ file: 'package-lock.json', line: 0, version: '?', snippet: '无法解析' });
}

console.log(`当前版本 ${CURRENT}，扫描 ${tracked.length} 个被跟踪文件\n`);

if (problems.length === 0) {
  console.log('✅ 没有发现过期的版本引用');
  process.exit(0);
}

console.log(`❌ ${problems.length} 处过期版本引用：\n`);
let cur = '';
for (const p of problems) {
  if (p.file !== cur) {
    console.log(`  ${p.file}`);
    cur = p.file;
  }
  console.log(`    第 ${p.line} 行  写作 ${p.version}  —  ${p.snippet}`);
}
console.log(`\n修法：把这些改成 ${CURRENT}；若是历史记录，把该文件加进 HISTORY_FILES。`);
process.exit(1);
