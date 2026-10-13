// 轮换规则：结构化硬约束（不能同桌）+ 公平轮换统计。
// 纯逻辑 + 自检，可用 node 直接跑：node --experimental-strip-types src/lib/rotation.ts

import { deskPairsOf, type Grid } from "./ai.ts";

/** 名单一行里与轮换有关的字段（RosterRow 的子集，避免 import seat.ts） */
export interface RosterStudent {
  name: string;
  trait?: string;
  note?: string;
}

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
          // 靠左 / 靠右只对靠边的座位有意义：3 座及以上的中间座既不算左也不算右
          if (si === 0) cur.left += 1;
          else if (si === row.length - 1) cur.right += 1;
          cur.groups[gi] = (cur.groups[gi] ?? 0) + 1;
          byName.set(key, cur);
        });
      });
    });
  }
  return { byName, bandSeats };
}

/** 名单里有、但一轮都没排上的学生：给一行全 0 —— 那正是最极端的「没轮到」，
 *  不能让他从公平表里消失（60 人的班级排不下容量时就会出现这种学生） */
function emptyCounts(name: string): RoundStat & { groups: number[] } {
  return { name, front: 0, mid: 0, back: 0, left: 0, right: 0, groups: [] };
}

/** 公平统计表：判定口径刻意朴素——某一类排位置一次都没轮到才算 gap */
export function fairnessReport(grids: Grid[], students: RosterStudent[]): FairnessRow[] {
  const { byName, bandSeats } = countPositions(grids);
  const out: FairnessRow[] = [];
  for (const s of students) {
    const name = s.name.trim();
    if (!name) continue;
    const c = byName.get(name) ?? emptyCounts(name);
    const gaps: string[] = [];
    // 只对「这个教室里真实存在的位置带」判轮空：2 排的教室没有中排，
    // 否则会拿计数当代理去压，反而全班每个人都被标一句「没坐过中排」
    if (grids.length > 1) {
      if (bandSeats.front > 0 && c.front === 0) gaps.push("没坐过前排");
      if (bandSeats.mid > 0 && c.mid === 0) gaps.push("没坐过中排");
      if (bandSeats.back > 0 && c.back === 0) gaps.push("没坐过后排");
    }
    // 用 Array.from 而不是 .map：稀疏数组的 map 会跳过空洞，留下的 undefined
    // 渲染到表格里就是一行 "undefined"
    out.push({ ...c, groups: Array.from(c.groups, (n) => n ?? 0), gaps });
  }
  return out;
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

  // 名单里有、但一轮都没排上的学生：不能从公平表里消失（60 人班级排不下容量时就会出现）
  const ghostGrids: Grid[] = [
    [[["甲", "乙"], ["丙", "丁"], ["戊", "己"]]],
    [[["甲", "乙"], ["丙", "丁"], ["戊", "己"]]],
  ];
  const ghostRows = fairnessReport(ghostGrids, [{ name: "甲" }, { name: "落空" }]);
  must(ghostRows.length === 2, `落空的学生也要出行，实际 ${ghostRows.length}`);
  const ghost = ghostRows.find((r) => r.name === "落空")!;
  must(ghost.front === 0 && ghost.mid === 0 && ghost.back === 0, "落空的学生位置计数应全 0");
  must(
    ghost.gaps.length === 3,
    `落空的学生三类排位置都该标出来，实际 ${JSON.stringify(ghost.gaps)}`,
  );

  // groups 不能有 undefined 空洞（渲染出来就是 "undefined"）
  const twoGroups: Grid = [[["丙", "丁"]], [["甲", "乙"]]];
  const groupRow = fairnessReport([twoGroups], [{ name: "甲" }])[0]!;
  must(
    groupRow.groups.length === 2 && groupRow.groups.every((n) => typeof n === "number"),
    `groups 应为长度 2 且无空洞，实际 ${JSON.stringify(groupRow.groups)}`,
  );
  must(
    groupRow.groups[0] === 0 && groupRow.groups[1] === 1,
    `groups 计数不对，实际 ${JSON.stringify(groupRow.groups)}`,
  );

  // 3 座排的中间座既不算左也不算右（左右公平只对靠边的座位有意义）
  const wide: Grid = [[["甲", "乙", "丙"]]];
  const wideRow = fairnessReport([wide], [{ name: "乙" }])[0]!;
  must(
    wideRow.left === 0 && wideRow.right === 0,
    `3 座排的中间座不该算左或右，实际 ${JSON.stringify(wideRow)}`,
  );
}

// 自检也可用 node 直接跑
declare const process: { stdout: { write: (s: string) => void } } | undefined;
if (typeof document === "undefined" && typeof process !== "undefined") {
  runRotationSelfCheck();
  process.stdout.write("rotation 自检通过\n");
}
