/**
 * ULID 生成器（依赖白名单里的 `ulid` 包）。
 *
 * ULID = 48bit 毫秒时间戳 + 80bit 随机数，Crockford Base32 编码成 26 字符。
 * 为什么用 ULID 而不是 UUID：① 按时间有序，id 排序≈时间排序，调试/导出友好；
 * ② 全小写字母数字之外的 Crockford 字母表，肉眼抄写不混淆（无 I/L/O/U）。
 *
 * 本项目用单调变体：同一毫秒内多次生成时递增随机位，保证 id 严格递增，
 * 顺序写入不会乱序（取代链的新旧判断多一层保险）。
 */
import { ulid as ulidBase, monotonicFactory } from "ulid";

/** 直接生成一个 ULID（旧式，等价于每次新随机） */
export function ulid(): string {
  return ulidBase();
}

/**
 * 单调 ULID 工厂：同一毫秒内保持严格递增。
 * Membrane 每个实例持有一个，见 src/membrane.ts。
 */
export function createMonotonicUlid(): (now?: number) => string {
  const factory = monotonicFactory();
  return (now?: number) => factory(now);
}
