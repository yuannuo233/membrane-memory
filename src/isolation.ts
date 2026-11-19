/**
 * 多任务记忆隔离探针。
 *
 * 回答一个非常实际的问题："一个 Agent 同时跑两个任务，记忆会不会串？"
 *
 * 结论由实验给出，不靠嘴：
 * - 同一个 namespace：两条任务记忆都会被召回 → 有串扰风险（这是语义检索的本性）；
 * - 不同 namespace：A 的查询只返回 A，B 只返回 B → 硬隔离。
 *
 * 探针只用 `:memory:` 临时库，不读写用户数据；后台页面/doctor/单测共用。
 */
import { Membrane } from "./engine.js";

const T0 = 1_760_000_000_000;

export interface IsolationProbeResult {
  /** 同一 namespace 下的实验结果 */
  sharedNamespace: {
    hits: number;
    tasks: string[];
    mixed: boolean;
  };
  /** 不同 namespace 下的实验结果 */
  separatedNamespaces: {
    taskA: { hits: number; tasks: string[] };
    taskB: { hits: number; tasks: string[] };
    /** A 的结果里混入 B 的条数（期望 0） */
    leakage: number;
    pass: boolean;
  };
  /** 人话结论 */
  note: string;
}

/**
 * 运行隔离探针。纯内存、固定时钟，重复跑结果一致。
 */
export function probeTaskIsolation(): IsolationProbeResult {
  const m = new Membrane({ dbPath: ":memory:", now: () => T0 });
  try {
    // 第一部分：同一个 namespace，两个任务
    m.add({
      content: "任务A 的数据库使用 PostgreSQL",
      subject: "任务A",
      kind: "fact",
      namespace: "probe-shared",
    });
    m.add({
      content: "任务B 的数据库使用 MySQL",
      subject: "任务B",
      kind: "fact",
      namespace: "probe-shared",
    });
    const shared = m.recall({ query: "数据库", namespace: "probe-shared", limit: 5 });
    const sharedTasks = unique(shared.map((h) => h.memory.subject ?? "?"));

    // 第二部分：不同 namespace，同样两个任务
    m.add({
      content: "任务A 的数据库使用 PostgreSQL",
      subject: "任务A",
      kind: "fact",
      namespace: "probe-task-a",
    });
    m.add({
      content: "任务B 的数据库使用 MySQL",
      subject: "任务B",
      kind: "fact",
      namespace: "probe-task-b",
    });
    const a = m.recall({ query: "数据库", namespace: "probe-task-a", limit: 5 });
    const b = m.recall({ query: "数据库", namespace: "probe-task-b", limit: 5 });
    const aTasks = unique(a.map((h) => h.memory.subject ?? "?"));
    const bTasks = unique(b.map((h) => h.memory.subject ?? "?"));
    const leakage =
      a.filter((h) => h.memory.subject === "任务B").length +
      b.filter((h) => h.memory.subject === "任务A").length;

    return {
      sharedNamespace: {
        hits: shared.length,
        tasks: sharedTasks,
        mixed: sharedTasks.includes("任务A") && sharedTasks.includes("任务B"),
      },
      separatedNamespaces: {
        taskA: { hits: a.length, tasks: aTasks },
        taskB: { hits: b.length, tasks: bTasks },
        leakage,
        pass: leakage === 0 && aTasks.every((t) => t === "任务A") && bTasks.every((t) => t === "任务B"),
      },
      note:
        "同一 namespace 下任务记忆会互相召回；给每个任务独立 namespace 后串扰为 0。" +
        " 需要共享知识时，单独查 shared namespace 再合并，不要让任务记忆和共享记忆混住。",
    };
  } finally {
    m.close();
  }
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}
