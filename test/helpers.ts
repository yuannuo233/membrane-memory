/**
 * 测试公用工具：工作区内的临时目录。
 * 注意工作区铁律——测试产物不许写进系统 temp（C:\Users\...），全部落在
 * 项目根 .tmp-test/ 下（已在 .gitignore 排除），用完即删。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const BASE = join(process.cwd(), ".tmp-test");

/** 新建一个一次性目录（自动带随机后缀），返回绝对路径 */
export function newTmpDir(prefix: string): string {
  if (!existsSync(BASE)) mkdirSync(BASE, { recursive: true });
  return mkdtempSync(join(BASE, `${prefix}-`));
}

/** 递归清理一次性目录 */
export function rmDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** 固定时钟：doctor/单测的确定性时间源（从 BASE_TIME 起每调用一次 +1ms 也可手动指定） */
export const BASE_TIME = 1763500000000; // 2025-11-19 附近的固定锚点

export function fixedClock(start: number = BASE_TIME): () => number {
  return () => start;
}
