/**
 * 默认配置集中地：权重 / 半衰期 / 冲突阈值。
 * 数值依据见 DESIGN.md 第 4/5 节的实现注记（Jaccard vs 包含系数的实测对比）。
 * 集中一处是为了"调参改一行，文档同步改一节"。
 */
import type { ConflictPolicy, MemoryKind, RecallWeights } from "./types.js";

/** 检索四项权重（DESIGN.md 第 4 节默认 0.4/0.3/0.2/0.1） */
export const DEFAULT_WEIGHTS: RecallWeights = {
  text: 0.4,
  vec: 0.3,
  time: 0.2,
  conf: 0.1,
};

/** 新鲜度半衰期默认值（天）：偏好最长效，情节片段衰减最快 */
export const DEFAULT_HALF_LIVES: Record<MemoryKind, number> = {
  fact: 90,
  episode: 14,
  preference: 365,
  procedure: 60,
};

/**
 * 冲突检测阈值（DESIGN.md 第 5 节）：用 bigram 包含系数 |A∩B|/min(|A|,|B|) 判定。
 * high 以上取代、mid~high 并存、mid 以下视为不同记忆。
 */
export const DEFAULT_CONFLICT_THRESHOLDS: {
  lexical: { high: number; mid: number };
} = {
  lexical: { high: 0.55, mid: 0.35 },
};

/** 默认冲突策略 */
export const DEFAULT_CONFLICT_POLICY: ConflictPolicy = "supersede";

/** RRF 常数 K（业界标准 60；归一化公式见 DESIGN.md 第 4 节注记） */
export const RRF_K = 60;
