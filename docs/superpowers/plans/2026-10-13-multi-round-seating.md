# 多次排座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 弹窗一次生成 N（1~20，默认 8）张链式轮换的座位图，硬约束由程序逐轮校验，结果用左右箭头轮播浏览，并给出公平轮换统计表。

**Architecture:** 前端编排串行循环，每轮一次独立的 `ai_arrange` 调用（`current` = 上一轮结果），复用现有 SSE 流式、`parseArrangement` 校验与 `aiReqId` 取消机制；Rust 侧不改。轮换域的纯逻辑（硬约束解析、冲突检测、公平统计）单独放 `src/lib/rotation.ts` 并自带自检。主页从「一张图」扩展为「一组图 + 当前下标」，N=1 时行为与现在完全一致。

**Tech Stack:** Vue 3 `<script setup>` + TypeScript + Tailwind v4 + lucide-vue-next + Tauri 2。**无测试框架**：前端测试 = 每个 lib 文件自带的 `runSelfCheck()`，用 `node` 直接跑；Rust 用 `cargo test`。Vue 组件靠手工验收。

## Global Constraints

- 次数范围 **1~20，默认 8**（spec：不做 N > 20）。
- **N = 1 时不得出现箭头**，行为与改动前逐字一致（拖拽、导出、记录、AI 基准都不变）。
- 每轮 instruction 必须**重述规则原文**：每次调用是全新会话，模型没有跨轮记忆。
- payload 的 `history` **只带最近 3 轮**；公平性靠程序算的 `roundStats` 提供，不塞全部轮次。
- 硬约束语法：`不能同桌:张三,李四`（写在名单「注意事项」列）；**单向声明即对称生效**。
- 硬约束重试**最多 2 次**；仍不达标 → 保留该轮 + 标黄警告，继续下一轮（不中止整条链）。
- 公平统计**只报告，不改座位**；判定口径：前/中/后排某一类**一次都没轮到**才算 gap。
- 「同桌」定义沿用 `ai.ts` 的 `deskPairsOf`：同一排从左到右两两成对。
- 中文注释、中文文案；不新增依赖；Rust 侧不改动。

---

### Task 1: 轮换域纯逻辑 —— 硬约束解析与冲突检测

**Files:**
- Create: `src/lib/rotation.ts`
- Test: 同文件内的 `runRotationSelfCheck()`（沿用 `src/lib/ai.ts` 末尾的 node 自检写法）

**Interfaces:**
- Consumes: `deskPairsOf(grid)`、`type Grid`（来自 `src/lib/ai.ts`）
- Produces:
  - `interface RosterStudent { name: string; trait?: string; note?: string }`
  - `parseNoDeskmate(note: string): string[]`
  - `noDeskmatePairs(students: RosterStudent[]): [string, string][]`
  - `deskmateConflicts(grid: Grid, pairs: [string, string][]): [string, string][]`

- [ ] **Step 1: 写失败的断言**

创建 `src/lib/rotation.ts`，先只写自检和空的函数签名（实现先返回空值）：

```ts
// 轮换规则：结构化硬约束（不能同桌）+ 公平轮换统计。
// 纯逻辑 + 自检，可用 node 直接跑：node --experimental-strip-types src/lib/rotation.ts

import { deskPairsOf, type Grid } from "./ai";

/** 名单一行里与轮换有关的字段（RosterRow 的子集，避免 import seat.ts） */
export interface RosterStudent {
  name: string;
  trait?: string;
  note?: string;
}

/** 解析备注里的「不能同桌:张三,李四」；支持中文冒号、顿号、分号分隔 */
export function parseNoDeskmate(note: string): string[] {
  return [];
}

/** 把所有声明展开成去重、字母序归一的「不能同桌」对子（单向声明即对称生效） */
export function noDeskmatePairs(students: RosterStudent[]): [string, string][] {
  return [];
}

/** 逐轮查冲突：返回这一轮里被排成同桌的违规对子 */
export function deskmateConflicts(grid: Grid, pairs: [string, string][]): [string, string][] {
  return [];
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

  // 尾随标点 / 顿号 / 换行 / 散文混进名字段：都不能让硬约束凭空消失
  must(
    parseNoDeskmate("不能同桌:张三，李四。").join() === "张三,李四",
    `句末句号不该进名字，实际 ${parseNoDeskmate("不能同桌:张三，李四。").join()}`,
  );
  must(parseNoDeskmate("不能同桌:张三、李四").join() === "张三,李四", "顿号应作分隔符");
  must(parseNoDeskmate("不能同桌:张三\n别的备注").join() === "张三", "换行应终止名字段");
  const proseNote = noDeskmatePairs([
    { name: "张三", note: "不能同桌:李四，喜欢靠窗" },
    { name: "李四" },
  ]);
  must(
    proseNote.length === 1 && proseNote[0]!.join() === "张三,李四",
    `散文「喜欢靠窗」不该成为幽灵约束，实际 ${JSON.stringify(proseNote)}`,
  );
  // 对外 API 不该要求调用方先归一顺序
  must(deskmateConflicts(desk, [["李四", "张三"]]).length === 1, "对子顺序反过来也要能查到");
}

// 自检也可用 node 直接跑
declare const process: { stdout: { write: (s: string) => void } } | undefined;
if (typeof document === "undefined" && typeof process !== "undefined") {
  runRotationSelfCheck();
  process.stdout.write("rotation 自检通过\n");
}
```

- [ ] **Step 2: 跑自检，确认失败**

Run: `cd /d/wok/worknotes/seatplan && node src/lib/rotation.ts`
Expected: 抛出 `应解析出张三,李四，实际 `（断言失败），说明自检真的在跑

- [ ] **Step 3: 实现三个函数**

替换上面三个函数的函数体：

```ts
/**
 * 备注里「不能同桌」后面的名字段。遇到分号 / 换行 / 句末标点即认为该段结束——
 * 只认分号和换行的话，「不能同桌:张三，李四。」会把句号吞进名字，
 * 于是这条硬约束永远匹配不上，静默失效。
 */
const NO_DESK_RE = /不能同桌\s*[:：]\s*([^;；。！？!?\n]*)/g;

export function parseNoDeskmate(note: string): string[] {
  const out: string[] = [];
  for (const m of note.matchAll(NO_DESK_RE)) {
    for (const raw of (m[1] ?? "").split(/[,，、;；\s]+/)) {
      // 名字可能带着尾随标点，先剪掉再判断
      const name = raw.trim().replace(/[。！？!?、，,;；.]+$/u, "").trim();
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

export function noDeskmatePairs(students: RosterStudent[]): [string, string][] {
  // 只认名单里真实存在的人：备注若写成「不能同桌:李四，喜欢靠窗」，
  // 按分隔符会切出「喜欢靠窗」这种散文片段，不对照名单就会留下一条永远匹配不上的幽灵约束
  const known = new Set(students.map((s) => s.name.trim()).filter(Boolean));
  const pairs = new Map<string, [string, string]>();
  for (const s of students) {
    const me = s.name.trim();
    if (!me) continue;
    for (const other of parseNoDeskmate(s.note ?? "")) {
      if (other === me || !known.has(other)) continue; // 写自己、或不是本班学生 → 忽略
      // 字母序归一：单向声明即对称，同一对不重复入表
      const [a, b] = me < other ? [me, other] : [other, me];
      pairs.set(`${a}|${b}`, [a, b]);
    }
  }
  return [...pairs.values()];
}

export function deskmateConflicts(grid: Grid, pairs: [string, string][]): [string, string][] {
  // 自己归一顺序，不依赖调用方先归一过
  const wanted = new Set(
    pairs.map(([x, y]) => {
      const a = x.trim();
      const b = y.trim();
      return a < b ? `${a}|${b}` : `${b}|${a}`;
    }),
  );
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
```

- [ ] **Step 4: 跑自检，确认通过**

Run: `cd /d/wok/worknotes/seatplan && node src/lib/rotation.ts`
Expected: 先打印 `ai 自检通过`（`rotation.ts` import 了 `ai.ts`，其自检会先跑），再打印 `rotation 自检通过`

- [ ] **Step 5: Commit**

```bash
cd /d/wok/worknotes/seatplan
git add src/lib/rotation.ts
git commit -m "feat(rotation): 不能同桌硬约束的解析与逐轮冲突检测"
```

---

### Task 2: 轮换域纯逻辑 —— 公平统计

**Files:**
- Modify: `src/lib/rotation.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `RosterStudent`
- Produces:
  - `interface RoundStat { name: string; front: number; mid: number; back: number; left: number; right: number }`
  - `interface FairnessRow extends RoundStat { groups: number[]; gaps: string[] }`
  - `roundStatsOf(grids: Grid[], students: RosterStudent[]): RoundStat[]`
  - `fairnessReport(grids: Grid[], students: RosterStudent[]): FairnessRow[]`

- [ ] **Step 1: 写失败的断言**

在 `runRotationSelfCheck()` 的末尾（`}` 之前）追加：

```ts
  // 公平统计：1 组 2 排 2 座。排 0 = 前排、排 1 = 后排（按排数三等分；2 排的教室没有中排）
  // 嵌套层级注意：Grid = 组→排→座（三层），Grid[] = 轮→组→排→座（四层）
  const one: Grid = [[["甲", "乙"], ["丙", "丁"]]];
  const stat = roundStatsOf([one], [{ name: "甲" }, { name: "丙" }]);
  must(stat.length === 2, `只统计名单里出现的名字，实际 ${stat.length}`);
  const jia = stat.find((s) => s.name === "甲")!;
  must(jia.front === 1 && jia.back === 0, `甲应前排 1 次后排 0 次，实际 ${JSON.stringify(jia)}`);
  must(jia.left === 1 && jia.right === 0, `甲应左 1 右 0，实际 ${JSON.stringify(jia)}`);

  // 两轮之间整排对调 → 每人前后排各坐一次；且 2 排教室里「中排」不存在，不该被标轮空
  const rotated: Grid[] = [
    [[["甲", "乙"], ["丙", "丁"]]],
    [[["丙", "丁"], ["甲", "乙"]]],
  ];
  const rotatedRows = fairnessReport(rotated, [
    { name: "甲" },
    { name: "乙" },
    { name: "丙" },
    { name: "丁" },
  ]);
  must(
    rotatedRows.every((r) => r.front === 1 && r.back === 1),
    `每人应前后排各一次，实际 ${JSON.stringify(rotatedRows.map((r) => [r.name, r.front, r.back]))}`,
  );
  must(
    rotatedRows.every((r) => r.gaps.length === 0),
    `轮换到位不该有 gap，实际 ${JSON.stringify(rotatedRows.filter((r) => r.gaps.length))}`,
  );

  // 有人永远坐在同一排 → 标「没坐过后排」，但不该标「没坐过中排」（这教室没有中排）
  const skew: Grid[] = [
    [[["甲", "乙"], ["丙", "丁"]]],
    [[["甲", "乙"], ["丁", "丙"]]],
  ];
  const skewRows = fairnessReport(skew, [{ name: "甲" }, { name: "乙" }]);
  const jiaSkew = skewRows.find((r) => r.name === "甲")!;
  must(
    jiaSkew.front === 2 && jiaSkew.back === 0,
    `甲应前排 2 后排 0，实际 ${JSON.stringify(jiaSkew)}`,
  );
  must(
    jiaSkew.gaps.some((g) => g.includes("后排")),
    `甲从没坐过后排，应被标出，实际 ${JSON.stringify(jiaSkew.gaps)}`,
  );
  must(
    !jiaSkew.gaps.some((g) => g.includes("中排")),
    `2 排教室没有中排，不该标「没坐过中排」，实际 ${JSON.stringify(jiaSkew.gaps)}`,
  );

  // 位置带划分直接钉死：每种排数各人是前/中/后，避免再出现「靠浮点边界碰巧对」的写法
  const bands = (total: number) => {
    const grid: Grid = [Array.from({ length: total }, (_, ri) => [`r${ri}`])];
    const students = Array.from({ length: total }, (_, ri) => ({ name: `r${ri}` }));
    return fairnessReport([grid], students)
      .map((r) => `${r.name}=${r.front}${r.mid}${r.back}`)
      .join(",");
  };
  must(bands(1) === "r0=100", `1 排应全算前排，实际 ${bands(1)}`);
  must(bands(2) === "r0=100,r1=001", `2 排应前/后（无中排），实际 ${bands(2)}`);
  must(bands(3) === "r0=100,r1=010,r2=001", `3 排应三等分，实际 ${bands(3)}`);
  must(
    bands(8) === "r0=100,r1=100,r2=100,r3=010,r4=010,r5=010,r6=001,r7=001",
    `8 排应 3/3/2，实际 ${bands(8)}`,
  );
```

- [ ] **Step 2: 跑自检，确认失败**

Run: `cd /d/wok/worknotes/seatplan && node src/lib/rotation.ts`
Expected: `TypeError: roundStatsOf is not a function`

- [ ] **Step 3: 实现**

在 `deskmateConflicts` 之后追加：

```ts
/** 一个学生在若干轮里的位置分布 */
export interface RoundStat {
  name: string;
  front: number;
  mid: number;
  back: number;
  left: number;
  right: number;
}

/** 公平统计表的一行：分布 + 各组次数 + 「一次都没轮到」的提示语 */
export interface FairnessRow extends RoundStat {
  groups: number[];
  gaps: string[];
}

/**
 * 位置带：1 排只有前排；2 排就是前后排（**没有中排**）；3 排及以上才三等分。
 *
 * 刻意不写成 `ri < total / 3 ? ... : ri >= (total * 2) / 3 ? ...`：那是浮点除法，
 * 2 排时 `(2*2)/3 = 1.3333`，`ri=1 >= 1.3333` 为假 → 后排取不到、反倒多出一个中排。
 * 这种"靠浮点边界碰巧对"的写法读代码的人验不出来，所以把每种排数摊开写。
 */
function bandOf(ri: number, total: number): "front" | "mid" | "back" {
  if (total <= 1) return "front";
  if (total === 2) return ri === 0 ? "front" : "back";
  if (ri <= Math.floor((total - 1) / 3)) return "front";
  if (ri >= Math.ceil((total * 2) / 3)) return "back";
  return "mid";
}

/** 数出每个名字在各轮里坐过什么位置；顺带记录每个位置带在教室里是否存在 */
function countPositions(grids: Grid[]): {
  byName: Map<string, RoundStat & { groups: number[] }>;
  /** 该位置带在全班一共出现过多少个座位：为 0 说明这个教室压根没有「中排」这种位置 */
  bandSeats: Record<"front" | "mid" | "back", number>;
} {
  const byName = new Map<string, RoundStat & { groups: number[] }>();
  const bandSeats = { front: 0, mid: 0, back: 0 };
  for (const grid of grids) {
    grid.forEach((rows, gi) => {
      const total = rows.length;
      rows.forEach((row, ri) => {
        const band = bandOf(ri, total);
        row.forEach((name, si) => {
          bandSeats[band] += 1; // 空位也算「这个位置存在」
          const key = name?.trim();
          if (!key) return;
          const cur =
            byName.get(key) ??
            { name: key, front: 0, mid: 0, back: 0, left: 0, right: 0, groups: [] };
          cur[band] += 1;
          if (si === 0) cur.left += 1;
          else cur.right += 1;
          cur.groups[gi] = (cur.groups[gi] ?? 0) + 1;
          byName.set(key, cur);
        });
      });
    });
  }
  return { byName, bandSeats };
}

/** 喂给模型的紧凑计分表（按名单顺序，只给有位置数据的） */
export function roundStatsOf(grids: Grid[], students: RosterStudent[]): RoundStat[] {
  const { byName } = countPositions(grids);
  const out: RoundStat[] = [];
  for (const s of students) {
    const c = byName.get(s.name.trim());
    if (!c) continue;
    const { name, front, mid, back, left, right } = c;
    out.push({ name, front, mid, back, left, right });
  }
  return out;
}

/** 公平统计表：判定口径刻意朴素——某一类排位置一次都没轮到才算 gap */
export function fairnessReport(grids: Grid[], students: RosterStudent[]): FairnessRow[] {
  const { byName, bandSeats } = countPositions(grids);
  const out: FairnessRow[] = [];
  for (const s of students) {
    const c = byName.get(s.name.trim());
    if (!c) continue;
    const gaps: string[] = [];
    // 只对「这个教室里真实存在的位置带」判轮空：2 排的教室没有中排，
    // 否则会拿计数当代理去压，反而全班每个人都被标一句「没坐过中排」
    if (grids.length > 1) {
      if (bandSeats.front > 0 && c.front === 0) gaps.push("没坐过前排");
      if (bandSeats.mid > 0 && c.mid === 0) gaps.push("没坐过中排");
      if (bandSeats.back > 0 && c.back === 0) gaps.push("没坐过后排");
    }
    out.push({ ...c, groups: [...c.groups], gaps });
  }
  return out;
}
```

- [ ] **Step 4: 跑自检，确认通过**

Run: `cd /d/wok/worknotes/seatplan && node src/lib/rotation.ts`
Expected: `rotation 自检通过`

- [ ] **Step 5: Commit**

```bash
cd /d/wok/worknotes/seatplan
git add src/lib/rotation.ts
git commit -m "feat(rotation): 公平轮换统计（前中后排/左右/各组 + 轮空提示）"
```

---

### Task 3: payload 带上公平计分表

**Files:**
- Modify: `src/lib/ai.ts`（`ArrangeInput` 接口、`buildMessages`、自检）

**Interfaces:**
- Consumes: `RoundStat`（`src/lib/rotation.ts`）
- Produces: payload 新增 `roundStats` 字段；`ArrangeInput.roundStats?: RoundStat[]`

- [ ] **Step 1: 写失败的断言**

在 `src/lib/ai.ts` 的 `runAiSelfCheck()` 里，`buildMessages` 那段（`must(!("students" in noNotes), ...)` 之后）追加：

```ts
    // 公平计分表：给了就带上，没给不出现该字段
    const withStats = JSON.parse(
      buildMessages({
        grid: base,
        labels,
        singleSeatName: "",
        history: [],
        instruction: "排座",
        roundStats: [{ name: "甲", front: 2, mid: 1, back: 0, left: 1, right: 2 }],
      }).user,
    ) as { roundStats?: unknown };
    must(
      JSON.stringify(withStats.roundStats) ===
        JSON.stringify([{ name: "甲", front: 2, mid: 1, back: 0, left: 1, right: 2 }]),
      `roundStats 应原样进 payload，实际 ${JSON.stringify(withStats.roundStats)}`,
    );
    must(!("roundStats" in noNotes), "没给计分表时不应出现 roundStats 字段");
```

- [ ] **Step 2: 跑自检，确认失败**

Run: `cd /d/wok/worknotes/seatplan && node src/lib/ai.ts`
Expected: FAIL —— `roundStats 应原样进 payload，实际 undefined`

- [ ] **Step 3: 实现**

`src/lib/ai.ts` 顶部（`export interface AiConfig` 之前的注释下面）加一个 **type-only import**——它会被类型擦除，所以 `ai.ts`/`rotation.ts` 运行时都不产生循环依赖：

```ts
import type { RoundStat } from "./rotation";
```

`ArrangeInput` 增加字段（注释说明为什么由程序算）：

```ts
  /** 前几轮的位置计分表（程序算，喂给模型判断公平），没有多轮时可为空 */
  roundStats?: RoundStat[];
```

`buildMessages` 的 payload 增加一行（紧跟 `deskPairs` 之后）：

```ts
    ...(input.roundStats?.length ? { roundStats: input.roundStats } : {}),
```

同时在 `SYSTEM_PROMPT` 的规则 8 之后、规则 9 之前插入一条（规则编号顺延，把原第 9 条改成第 10 条）：

```ts
  "9. roundStats 是前几次换座的位置计分表（可为空）：每人已坐前/中/后排、左/右各几次。",
  "   用户要求「公平轮换」时，优先把 front/mid/back 明显偏低（尤其为 0）的学生换到缺的位置去，",
  "   而不是平均主义地打乱所有人。",
```

- [ ] **Step 4: 跑自检，确认通过**

Run: `cd /d/wok/worknotes/seatplan && node src/lib/ai.ts && node src/lib/seat.ts && node src/lib/rotation.ts`
Expected: 三个都打印「自检通过」

- [ ] **Step 5: Commit**

```bash
cd /d/wok/worknotes/seatplan
git add src/lib/ai.ts
git commit -m "feat(ai): payload 带上程序算的轮换计分表 roundStats"
```

---

### Task 4: 轮播控件组件

**Files:**
- Create: `src/components/RoundSwitcher.vue`

**Interfaces:**
- Produces: `<RoundSwitcher :index :total :warn @change>`，默认插槽放被切换的内容；`total <= 1` 时不渲染箭头与标题

- [ ] **Step 1: 写组件**

```vue
<script setup lang="ts">
// 轮播外壳：左右箭头夹着内容，上面一行显示「第 i / N 次」。
// total <= 1 时退化成纯容器——单张座位图的场景看不出任何变化。
import { computed } from "vue";
import { ChevronLeft, ChevronRight } from "lucide-vue-next";

const props = withDefaults(
  defineProps<{ index: number; total: number; warn?: boolean }>(),
  { warn: false },
);
const emit = defineEmits<{ change: [index: number] }>();

const multi = computed(() => props.total > 1);
const atStart = computed(() => props.index <= 0);
const atEnd = computed(() => props.index >= props.total - 1);

function go(step: number) {
  const next = props.index + step;
  if (next < 0 || next > props.total - 1) return;
  emit("change", next);
}

const ARROW =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-panel text-text transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-text";
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-if="multi" class="flex items-center justify-center gap-2 text-xs text-muted">
      <span>第 {{ index + 1 }} / {{ total }} 次</span>
      <span v-if="warn" class="text-red-500">⚠ 有学生没拆开</span>
    </div>
    <div class="flex items-center gap-3">
      <button v-if="multi" :class="ARROW" :disabled="atStart" title="上一次" @click="go(-1)">
        <ChevronLeft :size="17" />
      </button>
      <div class="min-w-0 flex-1">
        <slot />
      </div>
      <button v-if="multi" :class="ARROW" :disabled="atEnd" title="下一次" @click="go(1)">
        <ChevronRight :size="17" />
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 2: 手工验证（暂无单测）**

Run: `cd /d/wok/worknotes/seatplan && npm run tauri dev`
Expected: 应用能起来（组件此时还没被引用，只验证不报编译错）

- [ ] **Step 3: Commit**

```bash
cd /d/wok/worknotes/seatplan
git add src/components/RoundSwitcher.vue
git commit -m "feat(ui): 轮播切换组件 RoundSwitcher"
```

---

### Task 5: 公平统计表组件

**Files:**
- Create: `src/components/FairnessTable.vue`

**Interfaces:**
- Consumes: `FairnessRow`（`src/lib/rotation.ts`）
- Produces: `<FairnessTable :rows />`，无数据时显示占位文案

- [ ] **Step 1: 写组件**

```vue
<script setup lang="ts">
// 轮换统计表：只报告不改座位。gap 非空的行标出来，方便一眼看出谁没轮到。
import type { FairnessRow } from "../lib/rotation";

defineProps<{ rows: FairnessRow[] }>();
</script>

<template>
  <div class="overflow-x-auto rounded-lg border border-border bg-panel">
    <div v-if="rows.length === 0" class="p-3 text-xs text-muted">还没有可统计的座位图</div>
    <table v-else class="w-full text-left text-xs">
      <thead class="border-b border-border text-muted">
        <tr>
          <th class="px-2.5 py-1.5 font-normal">姓名</th>
          <th class="px-2 py-1.5 text-center font-normal">前排</th>
          <th class="px-2 py-1.5 text-center font-normal">中排</th>
          <th class="px-2 py-1.5 text-center font-normal">后排</th>
          <th class="px-2 py-1.5 text-center font-normal">左</th>
          <th class="px-2 py-1.5 text-center font-normal">右</th>
          <th class="px-2.5 py-1.5 font-normal">提示</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in rows"
          :key="r.name"
          class="border-b border-border last:border-0"
          :class="r.gaps.length ? 'bg-red-50' : ''"
        >
          <td class="px-2.5 py-1.5 text-title">{{ r.name }}</td>
          <td class="px-2 py-1.5 text-center text-text">{{ r.front }}</td>
          <td class="px-2 py-1.5 text-center text-text">{{ r.mid }}</td>
          <td class="px-2 py-1.5 text-center text-text">{{ r.back }}</td>
          <td class="px-2 py-1.5 text-center text-text">{{ r.left }}</td>
          <td class="px-2 py-1.5 text-center text-text">{{ r.right }}</td>
          <td class="px-2.5 py-1.5 text-red-500">{{ r.gaps.join("、") }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
```

- [ ] **Step 2: 手工验证**

Run: `cd /d/wok/worknotes/seatplan && npm run tauri dev`
Expected: 应用能起来，无编译错

- [ ] **Step 3: Commit**

```bash
cd /d/wok/worknotes/seatplan
git add src/components/FairnessTable.vue
git commit -m "feat(ui): 轮换统计表组件 FairnessTable"
```

---

### Task 6: 记录支持「第 N 次」标签

**Files:**
- Modify: `src/lib/records.ts`（`SeatRecord` 加字段）
- Modify: `src/views/RecordsView.vue`（列表里显示标签）

**Interfaces:**
- Produces: `SeatRecord.label?: string`

- [ ] **Step 1: 加字段**

`src/lib/records.ts` 的 `SeatRecord` 里追加（放在 `exportedAt` 之后）：

```ts
  /** 多次排座时的轮次说明，如「第 3 次」；单张记录没有此字段 */
  label?: string;
```

- [ ] **Step 2: 列表里显示**

先看现有列表渲染：`grep -n "exportedAt\|时间" src/views/RecordsView.vue`，找到显示时间的那一行，在它前面加上标签（保持同一行的样式风格）：

```vue
<span v-if="r.label" class="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
  {{ r.label }}
</span>
```

- [ ] **Step 3: 手工验证**

Run: `cd /d/wok/worknotes/seatplan && npm run tauri dev`
Expected: 老的记录列表照常显示（没有 label 就不显示徽标）；不报编译错

- [ ] **Step 4: Commit**

```bash
cd /d/wok/worknotes/seatplan
git add src/lib/records.ts src/views/RecordsView.vue
git commit -m "feat(records): 记录支持轮次标签 label"
```

---

### Task 7: 主页多轮状态与轮播（N=1 行为不变）

**Files:**
- Modify: `src/views/SeatView.vue`

**Interfaces:**
- Consumes: `RoundSwitcher`（Task 4）、`Grid`（`src/lib/ai.ts`）
- Produces（本文件内）：
  - `seatRounds: Ref<Grid[]>`、`roundIndex: Ref<number>`
  - `showRound(i: number): void`
  - `LS_ROUNDS = "seatplan:rounds"`

- [ ] **Step 1: 加状态与常量**

在 `const LS_GRID = "seatplan:grid";` 下面加：

```ts
const LS_ROUNDS = "seatplan:rounds";
```

在 `const seatGrid = ref<Group[]>([]);` 下面加：

```ts
/** 一次生成的多轮座位图；N=1 时长度就是 1，行为与单张完全一致 */
const seatRounds = ref<Grid[]>([[]]);
const roundIndex = ref(0);
```

- [ ] **Step 2: persistGrid 同步当前轮**

把现有 `persistGrid()` 换成（新增两行写回，其余不变）：

```ts
function persistGrid() {
  const grid = currentGrid();
  seatRounds.value[roundIndex.value] = grid; // 主图拖拽/重排后回写当前这一轮
  localStorage.setItem(LS_GRID, JSON.stringify(grid));
  localStorage.setItem(
    LS_ROUNDS,
    JSON.stringify({ rounds: seatRounds.value, index: roundIndex.value }),
  );
}
```

- [ ] **Step 3: 加 showRound**

在 `persistGrid` 后面加：

```ts
/** 切到第 i 轮：用它重建显示用的 seatGrid（与 applyRestore 建法一致） */
function showRound(i: number) {
  const grid = seatRounds.value[i];
  if (!grid) return;
  roundIndex.value = i;
  seatGrid.value = grid.map((rowArr, gi) => ({
    label: groupLabel(gi, grid.length, reverseGroups.value),
    color: groupColor(gi),
    rows: rowArr.map((r) => ({ seats: r.map((n) => ({ name: n })) })),
  }));
  persistGrid();
}
```

- [ ] **Step 4: 名单/配置变化时重置为单轮**

`seedGrid()` 末尾（`persistGrid()` 之前）加两行——名单或排数变了，旧的多轮结果全部作废：

```ts
  seatRounds.value = [currentGrid()];
  roundIndex.value = 0;
```

- [ ] **Step 5: 挂载时读取多轮（必须排在 seedGrid/applySavedGrid 之前）**

⚠️ 顺序是硬要求：`seedGrid()` / `applySavedGrid()` 都会走 `persistGrid()`，而它现在会**写** `LS_ROUNDS`。若把它们跑在读取之前，刚写进去的单轮数据会把上次存的多轮数据覆盖掉，多轮结果开机即丢。

`onMounted` 里改成：

```ts
  // 多轮结果优先：读到了就不再走单轮种子/恢复（否则 persistGrid 会把它覆盖掉）
  let roundsLoaded = false;
  const savedRounds = localStorage.getItem(LS_ROUNDS);
  if (savedRounds) {
    try {
      const { rounds, index } = JSON.parse(savedRounds) as { rounds: Grid[]; index: number };
      if (Array.isArray(rounds) && rounds.length > 0) {
        seatRounds.value = rounds;
        showRound(Math.min(Math.max(0, index || 0), rounds.length - 1));
        roundsLoaded = true;
      }
    } catch {
      /* 多轮数据损坏则忽略，退回单轮 */
    }
  }
  if (props.restore) {
    applyRestore(props.restore);
  } else if (!roundsLoaded) {
    seedGrid();
    applySavedGrid();
  }
```

（即：把原来 `if (props.restore) { applyRestore(...) } else { seedGrid(); applySavedGrid(); }` 整段替换成上面这段。）

- [ ] **Step 6: 主图套上轮播**

模板里找到座位图外层：

```vue
      <div ref="seatChartRef" class="mx-auto w-max rounded-xl bg-white p-8 shadow">
```

用 `RoundSwitcher` 包住它（`ref` 留在内层，`exportImage` 不受影响）：

```vue
      <RoundSwitcher
        :index="roundIndex"
        :total="seatRounds.length"
        @change="showRound"
      >
        <div ref="seatChartRef" class="mx-auto w-max rounded-xl bg-white p-8 shadow">
          <!-- 原有内容整块不动 -->
        </div>
      </RoundSwitcher>
```

并在 `<script setup>` 的 import 区加上：

```ts
import RoundSwitcher from "../components/RoundSwitcher.vue";
```

- [ ] **Step 7: 手工验证**

Run: `cd /d/wok/worknotes/seatplan && npm run tauri dev`
Expected:
- 正常单张排座，界面与改动前一致（**没有箭头**）；
- 拖拽换座正常，`localStorage` 里 `seatplan:rounds` 出现且 `rounds` 长度为 1；
- 改名单后仍是单轮。

- [ ] **Step 8: Commit**

```bash
cd /d/wok/worknotes/seatplan
git add src/views/SeatView.vue
git commit -m "feat(seat): 主页支持多轮座位与轮播切换（N=1 行为不变）"
```

---

### Task 8: 次数输入 + 链式生成循环

**Files:**
- Modify: `src/views/SeatView.vue`

**Interfaces:**
- Consumes: `roundStatsOf` / `noDeskmatePairs` / `deskmateConflicts`（`src/lib/rotation.ts`）、`buildMessages` / `parseArrangement`（`src/lib/ai.ts`）
- Produces（本文件内）：
  - `aiRounds: Ref<AiRound[]>`、`aiRoundIndex: Ref<number>`、`aiProgress: Ref<{done:number;total:number}>`
  - `interface AiRound { grid: Grid; reason: string; summary: string; warnings: string[] }`
  - `runAiMany(n: number): Promise<void>`
  - `roundInstruction(i: number, total: number, rule: string, retryHint: string): string`

- [ ] **Step 1: 替换预览状态为多轮结构**

先在 import 区加上轮换域的三个函数（`seat.ts` 那组 import 之后）：

```ts
import { deskmateConflicts, noDeskmatePairs, roundStatsOf } from "../lib/rotation";
```

把现有的 `aiPreview` / `aiReason` / `aiSummary` 三个 ref 换成（其余引用点后面几步逐个改）：

```ts
/** 一轮生成结果 */
interface AiRound {
  grid: Grid;
  reason: string;
  summary: string;
  /** 硬约束没拆开的学生（重试用尽时非空） */
  warnings: string[];
}
const aiRounds = ref<AiRound[]>([]);
const aiRoundIndex = ref(0);
/** 生成进度，仅 aiBusy 时有意义 */
const aiProgress = ref({ done: 0, total: 0 });
/** 当前展示的那一轮 */
const aiRound = computed<AiRound | null>(() => aiRounds.value[aiRoundIndex.value] ?? null);
```

`aiPreviewNames` 改成读当前轮：

```ts
const aiPreviewNames = computed(() =>
  aiRound.value ? flattenNames(aiRound.value.grid).length : 0,
);
```

- [ ] **Step 2: 拼每轮 instruction**

在 `runAi` 之前加：

```ts
/**
 * 每轮的指令 = 规则原文 + 轮次说明（+ 重试提示）。
 * 必须每轮重述规则：每次调用是全新会话，模型没有跨轮记忆。
 */
function roundInstruction(i: number, total: number, rule: string, retryHint: string): string {
  const lines = [
    rule,
    "",
    `（这是本学期第 ${i} 次换座，共 ${total} 次。current 是上一次的座位图，按同样的规则继续轮换，不要一次跳到与上一次差异过大的布局。）`,
  ];
  if (retryHint) lines.push(retryHint);
  return lines.join("\n");
}
```

- [ ] **Step 3: 写链式生成**

删除现有 `runAi()`，换成：

```ts
/** 一次生成 N 轮：链式——第 1 轮基于当前主页座位图，之后每轮基于上一轮 */
async function runAi() {
  if (aiBusy.value) return;
  if (nameCount.value === 0) {
    aiError.value = "没有学生，无法排座";
    return;
  }
  if (!aiConfig.value) {
    aiError.value = "配置未加载，请检查 config.json";
    return;
  }

  const total = Math.min(20, Math.max(1, Math.round(roundsToGenerate.value) || 1));
  const cfg = aiConfig.value;
  const id = ++aiReqId;
  const labels = currentLabels();
  const rule = aiPrompt.value.trim();
  const pairs = noDeskmatePairs(roster.value);

  aiBusy.value = true;
  aiError.value = "";
  aiThinking.value = "";
  aiRounds.value = [];
  aiRoundIndex.value = 0;

  let base = currentGrid();
  try {
    for (let i = 1; i <= total; i++) {
      aiProgress.value = { done: i, total };
      let hint = "";
      let round: AiRound | null = null;

      // 硬约束：撞了就带提示重跑该轮，最多重试 2 次
      for (let attempt = 0; attempt <= 2 && !round; attempt++) {
        const { system, user } = buildMessages({
          grid: base,
          labels,
          singleSeatName: singleSeatName.value,
          history: aiRounds.value.slice(-3).map((r) => r.grid),
          instruction: roundInstruction(i, total, rule, hint),
          students: roster.value,
          roundStats: roundStatsOf([...aiRounds.value.map((r) => r.grid), base], roster.value),
        });

        let text = "";
        const msgs: ChatMessage[] = [
          { role: "system", content: system },
          { role: "user", content: user },
        ];
        text = await arrangeSeats(cfg, msgs, (e) => {
          if (id !== aiReqId) return;
          if (e.kind === "reasoning") aiThinking.value += e.text;
        });
        if (id !== aiReqId) return; // 已被 closeAi 作废

        const res = parseArrangement(text, base, labels);
        if (!res.ok) {
          aiError.value = `第 ${i} 轮校验未通过：${res.error}\n\n模型原始返回：\n${text}`;
          return;
        }

        const conflicts = deskmateConflicts(res.grid, pairs);
        if (conflicts.length === 0) {
          round = { grid: res.grid, reason: res.reason, summary: res.summary, warnings: [] };
          break;
        }
        if (attempt === 2) {
          // 重试用尽：保留这轮但标黄，不静默放过、也不因为一对学生毁掉整学期
          round = {
            grid: res.grid,
            reason: res.reason,
            summary: res.summary,
            warnings: conflicts.map(([a, b]) => `${a} 与 ${b} 仍同桌`),
          };
          break;
        }
        hint = `上一版仍把「${conflicts[0]![0]}」和「${conflicts[0]![1]}」排成了同桌，这次必须把他们拆开。`;
      }

      if (!round) return;
      aiRounds.value = [...aiRounds.value, round];
      base = round.grid;
      if (i === 1) aiRoundIndex.value = 0;
    }
  } catch (e) {
    if (id !== aiReqId) return;
    aiError.value = String(e);
  } finally {
    if (id === aiReqId) {
      aiBusy.value = false;
      aiProgress.value = { done: 0, total: 0 };
    }
  }
}
```

- [ ] **Step 4: 次数输入**

状态（放在 `aiPrompt` 附近）：

```ts
/** 一次生成的次数，1~20 */
const roundsToGenerate = ref(8);
```

模板：AI 输入态的提示词 textarea 下面加一行：

```vue
          <div class="flex items-center gap-2">
            <label class="text-xs text-text">生成次数</label>
            <input
              v-model.number="roundsToGenerate"
              type="number"
              min="1"
              max="20"
              :disabled="aiBusy"
              class="w-20 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-title outline-none focus:border-primary disabled:opacity-60"
            />
            <span class="text-xs text-muted">
              1~20 次，逐次串行生成；预计 ≈
              {{ Math.max(1, roundsToGenerate || 1) }} × 每轮耗时（关推理 2~4 秒，
              开推理 50~80 秒）
            </span>
          </div>
```

并把排座按钮的文案改成：

```vue
            {{ aiBusy ? `排座中（第 ${aiProgress.done}/${aiProgress.total} 次）…` : `开始排座（${Math.max(1, roundsToGenerate || 1)} 次）` }}
```

输入态那个「模型思考中…」的标题也带上进度（生成中右栏会被 `v-if="aiBusy"` 占住）：

```vue
            <div class="flex items-center gap-1.5 text-xs font-medium text-title">
              <LoaderCircle :size="12" class="animate-spin" />
              <template v-if="aiProgress.total > 1">
                第 {{ aiProgress.done }} / {{ aiProgress.total }} 次 · 模型思考中…
              </template>
              <template v-else>模型思考中…</template>
            </div>
```

- [ ] **Step 5: 修掉所有旧引用**

Run: `cd /d/wok/worknotes/seatplan && grep -n "aiPreview\b\|aiReason\|aiSummary" src/views/SeatView.vue`
把每一处改成当前轮（例如 `aiPreview` → `aiRound?.grid`、`aiReason` → `aiRound?.reason`、`aiSummary` → `aiRound?.summary`），`resetAiRun()` 里改成清 `aiRounds = []` / `aiRoundIndex = 0` / `aiProgress`。
注意模板里 `v-if="aiPreview"` 的预览态判断要改成 `v-if="aiRounds.length > 0"`。

- [ ] **Step 6: 手工验证**

Run: `cd /d/wok/worknotes/seatplan && npm run tauri dev`
Expected:
- 次数填 1 时行为与改动前一致；
- 填 3、规则里写「每人左右对调」，能看到按钮上进度「第 2/3 次…」；
- 生成完预览显示的是**第 1 轮**（此步轮播还没接上，第 2、3 轮在 `aiRounds` 里）。

- [ ] **Step 7: Commit**

```bash
cd /d/wok/worknotes/seatplan
git add src/views/SeatView.vue
git commit -m "feat(ai): 一次生成 N 轮链式排座（含硬约束逐轮校验与重试）"
```

---

### Task 9: 预览轮播 + 追问范围 + 应用整组 + 存记录

**Files:**
- Modify: `src/views/SeatView.vue`

**Interfaces:**
- Consumes: Task 7 的 `seatRounds`、Task 8 的 `aiRounds/aiRoundIndex/aiRound`、Task 5 的 `FairnessTable`
- Produces（本文件内）：
  - `aiScope: Ref<"round" | "all">`
  - `runFollowUpAll(): Promise<void>`、`applyRounds(): void`、`saveRoundsToRecords(): void`
  - `fairnessRows` computed

- [ ] **Step 1: 预览左栏套轮播**

预览态左栏（讲台 + 单座 + 各组那一段）用 `RoundSwitcher` 包住，`warn` 取当前轮是否有警告：

```vue
            <RoundSwitcher
              :index="aiRoundIndex"
              :total="aiRounds.length"
              :warn="!!aiRound?.warnings.length"
              @change="(i) => (aiRoundIndex = i)"
            >
              <!-- 原有 讲台/单座/组 整块内容不动 -->
            </RoundSwitcher>
```

- [ ] **Step 2: 预览右栏加统计表与警告**

在「为什么这么排」那块之后、`<details>` 思考过程之前插入：

```vue
              <div v-if="aiRound?.warnings.length" class="shrink-0 rounded-lg bg-red-50 p-2.5 text-xs text-red-600">
                ⚠ {{ aiRound.warnings.join("；") }}（已重试 2 次仍未能拆开，请手动调整）
              </div>
              <details class="shrink-0 rounded-lg border border-border bg-surface">
                <summary class="cursor-pointer px-2.5 py-1.5 text-xs text-muted hover:text-title">
                  轮换统计（共 {{ aiRounds.length }} 次）
                </summary>
                <div class="p-2.5">
                  <FairnessTable :rows="fairnessRows" />
                </div>
              </details>
```

`<script setup>` 加：

```ts
import FairnessTable from "../components/FairnessTable.vue";
import { deskmateConflicts, fairnessReport, noDeskmatePairs, roundStatsOf } from "../lib/rotation";

/** 已生成的各轮 → 公平统计表 */
const fairnessRows = computed(() =>
  fairnessReport(aiRounds.value.map((r) => r.grid), roster.value),
);
```

- [ ] **Step 3: 追问范围**

状态与两个入口：

```ts
/** 追问范围：只重排当前这一轮 / 按新要求把 N 轮全部重跑 */
const aiScope = ref<"round" | "all">("round");
```

追问的模板那行（`aiFollowUp` textarea 旁）加范围切换：

```vue
          <div class="flex shrink-0 items-center gap-1 rounded-lg border border-border p-0.5 text-xs">
            <button
              class="rounded px-2 py-1"
              :class="aiScope === 'round' ? 'bg-primary text-white' : 'text-text'"
              @click="aiScope = 'round'"
            >
              当前这次
            </button>
            <button
              class="rounded px-2 py-1"
              :class="aiScope === 'all' ? 'bg-primary text-white' : 'text-text'"
              @click="aiScope = 'all'"
            >
              整体重排
            </button>
          </div>
```

「重排」按钮的点击处理改成分派：

```ts
async function onFollowUp() {
  if (aiScope.value === "all") await runFollowUpAll();
  else await runFollowUp();
}
```

现有 `runFollowUp()` 改成针对当前轮（原本用 `aiPreview`，现在用 `aiRound.value.grid`），生成结果替换该轮而非整组：把 `callAi` 换成一次 `arrangeSeats` 调用，成功后：

```ts
    aiRounds.value[aiRoundIndex.value] = {
      grid: res.grid,
      reason: res.reason,
      summary: res.summary,
      warnings: deskmateConflicts(res.grid, noDeskmatePairs(roster.value)).map(
        ([a, b]) => `${a} 与 ${b} 仍同桌`,
      ),
    };
```

- [ ] **Step 4: 整体重排**

```ts
/** 整体重排：把当前规则换成追问内容，N 轮全部重新生成 */
async function runFollowUpAll() {
  const text = aiFollowUp.value.trim();
  if (!text || aiBusy.value) return;
  aiPrompt.value = `${aiPrompt.value.trim()}\n${text}`;
  aiFollowUp.value = "";
  await runAi(); // runAi 会按 roundsToGenerate 重新链式生成
}
```

- [ ] **Step 5: 应用整组 + 存记录**

```ts
/** 应用整组结果到主页 */
function applyRounds() {
  if (aiRounds.value.length === 0) return;
  seatRounds.value = aiRounds.value.map((r) => r.grid);
  showRound(0);
  showAi.value = false;
  resetAiRun();
  showToast(`已应用 ${seatRounds.value.length} 次座位`, "success");
}

/** 把 N 轮存成 N 条记录（带「第 N 次」标签） */
function saveRoundsToRecords() {
  if (aiRounds.value.length === 0) return;
  const list = loadRecords();
  const now = Date.now();
  const created: SeatRecord[] = aiRounds.value.map((r, i) => ({
    id: `${now}-${i}`,
    exportedAt: now,
    label: `第 ${i + 1} 次`,
    rows: rows.value,
    colors: groupCfgs.value.map((c) => c.color),
    seatsPerRow: seatCount.value,
    singleSeatName: singleSeatName.value,
    grid: r.grid,
  }));
  if (!saveRecords([...created, ...list])) {
    showToast("记录保存失败（本地存储可能已满）", "error");
    return;
  }
  showToast(`已存入 ${created.length} 条记录`, "success");
}
```

删掉旧的 `applyAi()`，并检查 `callAi()` 是否还有调用点：没有了就一并删掉（`runFollowUp` 改成直接调 `arrangeSeats`）。

按钮区把原来的「应用到座位图」绑到 `applyRounds`，并新增：

```vue
          <button
            class="rounded-lg border border-border px-4 py-1.5 text-xs text-text hover:border-primary hover:text-primary"
            @click="saveRoundsToRecords"
          >
            全部存入记录
          </button>
```

- [ ] **Step 6: 主页也挂统计表**

主页座位图下方（`exportImage` 所在工具条之后）加：

```vue
      <details v-if="seatRounds.length > 1" class="mx-6 mb-4 rounded-lg border border-border bg-panel">
        <summary class="cursor-pointer px-3 py-2 text-xs text-muted hover:text-title">
          轮换统计（共 {{ seatRounds.length }} 次）
        </summary>
        <div class="p-3">
          <FairnessTable :rows="seatFairnessRows" />
        </div>
      </details>
```

```ts
const seatFairnessRows = computed(() => fairnessReport(seatRounds.value, roster.value));
```

- [ ] **Step 7: 手工验证**

Run: `cd /d/wok/worknotes/seatplan && npm run tauri dev`
Expected:
- 生成 3 轮 → 左右箭头能切，第 1 轮左箭头禁用、第 3 轮右箭头禁用；
- 两人备注写 `不能同桌:对方` → 每一轮都不同桌；故意让重试用尽时该轮标黄并显示 ⚠；
- 「应用到座位图」→ 主页出现 3 张可切换的图，切到第 2 张拖拽换座后，切走再切回来改动还在，第 1、3 张没变；
- 「全部存入记录」→ 记录页出现 3 条带「第 N 次」徽标的记录；
- 追问「当前这次」只改当前那张，「整体重排」会重跑全部；
- 统计表里有人从没坐过后排时该行标红。

- [ ] **Step 8: Commit**

```bash
cd /d/wok/worknotes/seatplan
git add src/views/SeatView.vue
git commit -m "feat(ai): 预览轮播、追问范围、应用整组与批量存记录"
```

---

### Task 10: 收尾验证

**Files:**
- 无代码改动（除非验证发现问题）

- [ ] **Step 1: 全量自检**

Run:
```bash
cd /d/wok/worknotes/seatplan && node src/lib/seat.ts && node src/lib/ai.ts && node src/lib/rotation.ts
cd /d/wok/worknotes/seatplan/src-tauri && cargo test
```
Expected: 三个「自检通过」 + cargo 测试全绿（含 `sse_line_*`、`config_save_path*`）

- [ ] **Step 2: 类型检查**

Run: `cd /d/wok/worknotes/seatplan && npx vue-tsc --noEmit`
Expected: 无错误（既有 tsconfig 的 `baseUrl` 弃用警告不算）

- [ ] **Step 3: 兼容性回归（最重要的一条）**

Run: `cd /d/wok/worknotes/seatplan && npm run tauri dev`
Expected:
- 全新状态（清掉 localStorage）→ 单张排座、拖拽、导出图片、记录回显、AI 单次排座全部照旧，界面里**看不到任何箭头**；
- 旧数据：把 `seatplan:rounds` 手动删掉，`seatplan:grid` 还在 → 依然能正常显示单张。

- [ ] **Step 4: 中断测试**

生成 3 轮中途点 X。
Expected: 弹窗关闭、无迟到结果回写、再打开弹窗不残留上一轮状态；`aiBusy` 恢复。

- [ ] **Step 5: Commit（若有修补）**

```bash
cd /d/wok/worknotes/seatplan
git add -A
git commit -m "chore: 多次排座收尾验证修补"
```

---

## 验收清单（对照 spec）

| spec 要求 | 落在哪个任务 |
|---|---|
| 生成次数输入 1~20，默认 8，含耗时预估 | Task 8 Step 4 |
| 链式生成（第 i 轮基于第 i-1 轮） | Task 8 Step 3 |
| 规则每轮重述 | Task 8 Step 2 |
| history 只带最近 3 轮 + roundStats | Task 8 Step 3、Task 3 |
| 硬约束语法与对称生效 | Task 1 |
| 逐轮校验 + 重试 ≤2 + 超了标黄 | Task 8 Step 3、Task 9 Step 2 |
| 轮播（预览 + 主页，共用组件） | Task 4、Task 7 Step 6、Task 9 Step 1 |
| 主页 seatRounds/roundIndex，N=1 行为不变 | Task 7 |
| 追问范围（当前这次 / 整体） | Task 9 Step 3、4 |
| 公平统计表（只报告） | Task 2、Task 5、Task 9 Step 2/6 |
| 记录 label | Task 6、Task 9 Step 5 |
| 取消（aiReqId） | Task 8 Step 3 |
