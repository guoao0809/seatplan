// 轮换规则：结构化硬约束（不能同桌）+ 公平轮换统计。
// 纯逻辑 + 自检，可用 node 直接跑：node --experimental-strip-types src/lib/rotation.ts

import { deskPairsOf, type Grid } from "./ai.ts";

/** 名单一行里与轮换有关的字段（RosterRow 的子集，避免 import seat.ts） */
export interface RosterStudent {
  name: string;
  trait?: string;
  note?: string;
}

/** 备注里「不能同桌」后面的名字段 */
const NO_DESK_RE = /不能同桌\s*[:：]\s*([^;；\n]*)/g;

export function parseNoDeskmate(note: string): string[] {
  const out: string[] = [];
  for (const m of note.matchAll(NO_DESK_RE)) {
    for (const raw of (m[1] ?? "").split(/[,，、;；\s]+/)) {
      const name = raw.trim();
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

export function noDeskmatePairs(students: RosterStudent[]): [string, string][] {
  const pairs = new Map<string, [string, string]>();
  for (const s of students) {
    const me = s.name.trim();
    if (!me) continue;
    for (const other of parseNoDeskmate(s.note ?? "")) {
      if (!other || other === me) continue; // 写自己没意义
      // 字母序归一：单向声明即对称，同一对不重复入表
      const [a, b] = me < other ? [me, other] : [other, me];
      pairs.set(`${a}|${b}`, [a, b]);
    }
  }
  return [...pairs.values()];
}

export function deskmateConflicts(grid: Grid, pairs: [string, string][]): [string, string][] {
  const wanted = new Set(pairs.map(([a, b]) => `${a}|${b}`));
  const hit: [string, string][] = [];
  for (const desk of deskPairsOf(grid)) {
    const names = desk.students.map((s) => s?.name?.trim() ?? "");
    const [x, y] = names;
    if (!x || !y) continue; // 空位不算同桌
    const [a, b] = x < y ? [x, y] : [y, x];
    if (!wanted.has(`${a}|${b}`)) continue;
    if (hit.some(([p, q]) => p === a && q === b)) continue;
    hit.push([a, b]);
  }
  return hit;
}

/** 自检：失败即抛错 */
export function runRotationSelfCheck(): void {
  const must = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  // 备注解析：支持中文冒号 / 顿号分隔，且只认「不能同桌」后面的名字
  const note = "近视，坐前排。不能同桌:张三，李四; 喜欢靠窗";
  must(
    parseNoDeskmate(note).join() === "张三,李四",
    `应解析出张三,李四，实际 ${parseNoDeskmate(note).join()}`,
  );
  must(parseNoDeskmate("").length === 0, "空备注应解析出空数组");
  must(parseNoDeskmate("不能同桌").length === 0, "没有冒号时不应解析出名字");
  must(
    parseNoDeskmate("不能同桌：张三 张三").join() === "张三",
    "同名应去重",
  );

  // 单向声明即对称生效：只有张三写了他不能跟李四同桌，这对就该成立
  const pairs = noDeskmatePairs([
    { name: "张三", note: "不能同桌:李四" },
    { name: "李四" },
    { name: "王五", note: "不能同桌:张三" },
  ]);
  must(pairs.length === 2, `应展开出 2 对，实际 ${pairs.length}`);
  must(
    pairs.some(([a, b]) => a === "张三" && b === "李四"),
    `应有张三-李四，实际 ${JSON.stringify(pairs)}`,
  );
  must(
    pairs.some(([a, b]) => a === "张三" && b === "王五"),
    `应有张三-王五，实际 ${JSON.stringify(pairs)}`,
  );
  must(
    noDeskmatePairs([{ name: "张三", note: "不能同桌:张三" }]).length === 0,
    "写自己不算一对",
  );

  // 冲突检测：同桌 = 同一排从左到右两两成对
  const desk: Grid = [
    [
      ["张三", "李四"],
      ["王五", "小明"],
    ],
  ];
  const hit = deskmateConflicts(desk, [["张三", "李四"]]);
  must(hit.length === 1, `第一排应撞上一对，实际 ${hit.length}`);
  must(
    deskmateConflicts(desk, [["张三", "王五"]]).length === 0,
    "不同排不该算冲突",
  );
  must(
    deskmateConflicts(desk, [["张三", "李四"], ["李四", "张三"]]).length === 1,
    "同一对重复声明只报一次",
  );
  const empty: Grid = [[[null, null]]];
  must(deskmateConflicts(empty, [["张三", "李四"]]).length === 0, "空位不该算冲突");
}

// 自检也可用 node 直接跑
declare const process: { stdout: { write: (s: string) => void } } | undefined;
if (typeof document === "undefined" && typeof process !== "undefined") {
  runRotationSelfCheck();
  process.stdout.write("rotation 自检通过\n");
}
