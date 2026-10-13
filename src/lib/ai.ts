// AI 排座：拼提示词、解析并执行模型给出的排座操作。
//
// 关键设计：模型**不输出座位表**，只输出对当前座位表的操作（交换/轮转），由本文件执行。
// 这样「抄错姓名」「数错每组排数」「自述做了其实没做」三类错误在结构上不可能发生——
// 姓名与维度根本不经过模型的手。代价是模型只能表达这套操作能覆盖的调整。
//
// 本文件不含任何静态 import，可独立自检：node --experimental-strip-types src/lib/ai.ts

/** config.json 的内容（OpenAI 兼容） */
export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  /** 推理强度。不填默认 "none"（关掉思考，快）；"off" 表示不发该参数走模型默认 */
  reasoningEffort?: string;
}

/** Rust load_ai_config 的返回 */
export interface LoadedAiConfig {
  config: AiConfig;
  path: string;
}

/** 一条对话消息（与 OpenAI 协议一致） */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 座位表：组 → 排 → 座 → 姓名或 null */
export type Grid = (string | null)[][][];

/** 组、排、座 三级下标 */
type SeatRef = [number, number, number];
/** 组、排 两级下标 */
type RowRef = [number, number];

/** 模型可下达的操作 */
export type SeatOp =
  | { op: "swapSeats"; a: SeatRef; b: SeatRef }
  | { op: "swapRows"; a: RowRef; b: RowRef }
  | { op: "rotateLR" }
  | { op: "rotateRows"; group: number | null; by: number };

export interface ArrangeInput {
  /** 当前网格 */
  grid: Grid;
  /** 与 grid 一一对应的组名（用户屏幕上看到的，可能因「组号反向」而与下标顺序不同） */
  labels: string[];
  /** 单座学生姓名（不参与网格排座，仅作上下文） */
  singleSeatName: string;
  /** 最近几次历史网格（最新在前） */
  history: Grid[];
  /** 用户的自然语言要求 */
  instruction: string;
  /** 学生档案（特点 / 注意事项），排座时需照顾到的个体需求 */
  students?: StudentNote[];
}

/** 一个学生的特点与注意事项；name 与网格里的姓名对应 */
export interface StudentNote {
  name: string;
  /** 学生特点，如「近视」「好动」 */
  trait?: string;
  /** 注意事项，如「不能和 X 同桌」 */
  note?: string;
}

/** 一对同桌：两个座位 + 两人的档案（空位为 null）。模型据此判断「谁跟谁同桌」，不必自己数坐标 */
export interface DeskPair {
  /** 两个座位的坐标 [组,排,座]，可直接填进 swapSeats 的 a / b */
  seats: [SeatRef, SeatRef];
  /** 同桌两人；空位是 null */
  students: (StudentNote | null)[];
}

/**
 * 「同桌」的定义：**同一排里从左到右两两成对**（第 1-2 座、第 3-4 座…）。
 * 每排奇数座时最后一个落单，没有同桌。两人都空的排不进列表。
 *
 * 这活必须由程序干：之前把它留给模型，模型要在 60 个名字的嵌套数组里自己数坐标，
 * 于是频繁给出「把同桌 A 换成同桌 B」这种合法但等于没换的操作。
 */
export function deskPairsOf(grid: Grid, students: StudentNote[] = []): DeskPair[] {
  const byName = new Map(students.filter((s) => s.name).map((s) => [s.name, s]));
  const profile = (name: string | null): StudentNote | null => {
    if (!name) return null;
    const s = byName.get(name);
    return { name, ...(s?.trait ? { trait: s.trait } : {}), ...(s?.note ? { note: s.note } : {}) };
  };

  const pairs: DeskPair[] = [];
  grid.forEach((rows, gi) =>
    rows.forEach((row, ri) => {
      for (let si = 0; si + 1 < row.length; si += 2) {
        const a = profile(row[si] ?? null);
        const b = profile(row[si + 1] ?? null);
        if (!a && !b) continue; // 两人都空，没信息可给
        pairs.push({ seats: [[gi, ri, si], [gi, ri, si + 1]], students: [a, b] });
      }
    }),
  );
  return pairs;
}

export type ParseResult =
  | { ok: true; grid: Grid; reason: string; ops: SeatOp[]; summary: string }
  | { ok: false; error: string };

/** 展平网格，取出所有非空姓名 */
export function flattenNames(grid: Grid): string[] {
  const out: string[] = [];
  for (const g of grid) for (const r of g) for (const n of r) if (n) out.push(n);
  return out;
}

/** 各组排数 */
export function rowCounts(grid: Grid): number[] {
  return grid.map((g) => g.length);
}

const SYSTEM_PROMPT = [
  "你是教室排座助手。用户给你当前座位表 current 和一句排座要求，",
  "你返回**调整操作**，由程序替你执行。你不需要、也不允许输出座位表本身。",
  "",
  "返回格式（严格遵守，就这一个 JSON 对象）：",
  '{"reason":"用一两句中文说明你这样调整的理由","ops":[操作1,操作2,...]}',
  "",
  "可用操作（ops 数组内按顺序执行）：",
  '1. {"op":"swapSeats","a":[组,排,座],"b":[组,排,座]}   交换两个座位上的学生',
  '2. {"op":"swapRows","a":[组,排],"b":[组,排]}          两排整排对调（两排座位数须相同）',
  '3. {"op":"rotateLR"}                                  每组每排的座位左右对调',
  '4. {"op":"rotateRows","group":组号,"by":位移}         组内排整体前后轮转；by 为正向后移、负向前移；group 传 null 表示所有组',
  "",
  "坐标一律用**数组下标**（从 0 开始），分别指 current 的第几组、第几排、第几个座。",
  "groups[i] 是第 i 组在用户屏幕上显示的名字。",
  "",
  "【同桌】同桌 = **同一排里从左到右两两成对的两个座位**（第 1-2 座、第 3-4 座…，每排共 shape.seatsPerRow 座）。",
  "payload 里的 deskPairs 已经把**当前所有同桌对**连同两人的特点/注意事项算好了，空位是 null。",
  "判断「谁跟谁同桌」一律查 deskPairs，**不要自己从 current 里数坐标**——那是你最容易出错的地方。",
  "",
  "硬性规则：",
  "1. 只返回 JSON，不要解释文字，不要 markdown 代码块围栏。",
  "2. 下标必须在范围内：组 < current.length，排 < current[组].length，座 < current[组][排].length。",
  "3. 绝对不要输出学生姓名，也不要输出座位表——只输出上面四种操作。",
  "4. 用户说「第 N 组」时，指的是 groups 里那个叫「第 N 组」的项，不要按数组下标去猜。",
  "5. ops 至少要有 1 个操作。",
  "6. reason 只说思路（为什么这样更公平 / 为什么这么调），不要罗列操作细节。",
  "7. 用户追问时，current 已经是上一轮调整后的结果，你基于它继续给出新的操作。",
  "8. students 是学生档案（可为空），给出部分学生的特点（trait）与注意事项（note）。排座要照顾到它们：",
  "   近视 / 个子矮靠前，好动 / 话多分开，需要单独坐的排到边缘或单座，写明「不能同桌」的绝不排一起。",
  "   照顾不到时在 reason 里说明，不要假装做到了。",
  "9. 约束涉及同桌时（「A 不能和 B 同桌」「有同样特点的不能同桌」等），必须拿 deskPairs **逐对过一遍**：",
  "   凡违反的对，都要用 swapSeats 把其中一人换到一个不会制造新违规的座位去。",
  "   注意 deskPairs 的每一对里，两个座位**本来就是同桌**——把它们两个对调等于什么都没做，这是最常见的错误。",
  "   下完操作后自己再核对一遍：deskPairs 里不该再有任何一对违反用户约束。",
  "10. 思考过程一律用中文写（给用户看的），不要用英文。",
].join("\n");

/** 构造首轮的 system + user 消息 */
export function buildMessages(input: ArrangeInput): { system: string; user: string } {
  const inGrid = flattenNames(input.grid);
  // 只把填了内容的档案发给模型，空档案不上行（60 人的班级大半是空的）
  const students = (input.students ?? [])
    .map((s) => ({
      name: s.name,
      ...(s.trait ? { trait: s.trait } : {}),
      ...(s.note ? { note: s.note } : {}),
    }))
    .filter((s) => Object.keys(s).length > 1);
  const payload = {
    instruction: input.instruction,
    shape: { rows: rowCounts(input.grid), seatsPerRow: input.grid[0]?.[0]?.length ?? 0 },
    groups: input.labels,
    singleSeat: input.singleSeatName || null,
    roster: input.singleSeatName ? [...inGrid, input.singleSeatName] : inGrid,
    ...(students.length > 0 ? { students } : {}),
    deskPairs: deskPairsOf(input.grid, input.students ?? []),
    current: input.grid,
    history: input.history,
  };
  return { system: SYSTEM_PROMPT, user: JSON.stringify(payload) };
}

/** 剥掉 markdown 代码块围栏与前后闲话，取出 JSON 文本 */
export function stripToJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? text).trim();
  // 从最早的 { 或 [ 起、从后往前收缩到 } 或 ] 逐个试解析，命中第一个合法片段即返回。
  const braces = [body.indexOf("{"), body.indexOf("[")].filter((i) => i >= 0);
  if (braces.length === 0) return body;
  const start = Math.min(...braces);
  for (let end = body.length; end > start; end--) {
    const ch = body[end - 1];
    if (ch !== "}" && ch !== "]") continue;
    try {
      JSON.parse(body.slice(start, end));
      return body.slice(start, end);
    } catch {
      /* 收缩到前一个 } / ] 再试 */
    }
  }
  return body.slice(start);
}

// ===== 操作校验 =====

const intInRange = (v: unknown, hi: number) =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) < hi;

/** 校验一个座位下标；合法返回 null，否则返回中文原因 */
function seatRefError(raw: unknown, grid: Grid): string | null {
  if (!Array.isArray(raw) || raw.length !== 3) return "不是 [组,排,座] 三元数组";
  const [g, r, s] = raw as number[];
  if (!intInRange(g, grid.length)) return `组下标越界：${g}（应为 0~${grid.length - 1}）`;
  if (!intInRange(r, grid[g]!.length))
    return `排下标越界：${r}（第 ${g + 1} 组应为 0~${grid[g]!.length - 1}）`;
  if (!intInRange(s, grid[g]![r]!.length))
    return `座下标越界：${s}（应为 0~${grid[g]![r]!.length - 1}）`;
  return null;
}

/** 校验一个排下标；合法返回 null，否则返回中文原因 */
function rowRefError(raw: unknown, grid: Grid): string | null {
  if (!Array.isArray(raw) || raw.length !== 2) return "不是 [组,排] 二元数组";
  const [g, r] = raw as number[];
  if (!intInRange(g, grid.length)) return `组下标越界：${g}（应为 0~${grid.length - 1}）`;
  if (!intInRange(r, grid[g]!.length))
    return `排下标越界：${r}（第 ${g + 1} 组应为 0~${grid[g]!.length - 1}）`;
  return null;
}

/** 校验模型给出的操作列表；通过返回 null，否则返回中文原因 */
export function validateOps(raw: unknown, grid: Grid): string | null {
  if (!Array.isArray(raw)) return "ops 不是数组";
  if (raw.length === 0) return "模型没有给出任何调整操作";

  for (let i = 0; i < raw.length; i++) {
    const at = `第 ${i + 1} 个操作`;
    const o = raw[i];
    if (!o || typeof o !== "object" || Array.isArray(o)) return `${at}不是对象`;
    const rec = o as Record<string, unknown>;

    switch (rec.op) {
      case "swapSeats": {
        const ea = seatRefError(rec.a, grid);
        if (ea) return `${at}（swapSeats）的 a ${ea}`;
        const eb = seatRefError(rec.b, grid);
        if (eb) return `${at}（swapSeats）的 b ${eb}`;
        break;
      }
      case "swapRows": {
        const ea = rowRefError(rec.a, grid);
        if (ea) return `${at}（swapRows）的 a ${ea}`;
        const eb = rowRefError(rec.b, grid);
        if (eb) return `${at}（swapRows）的 b ${eb}`;
        const [ag, ar] = rec.a as number[];
        const [bg, br] = rec.b as number[];
        const la = grid[ag]![ar]!.length;
        const lb = grid[bg]![br]!.length;
        if (la !== lb)
          return `${at}（swapRows）两排座位数不同（${la} 座 vs ${lb} 座），无法整排对调`;
        break;
      }
      case "rotateLR":
        break;
      case "rotateRows": {
        const gi = rec.group;
        if (gi !== null && !intInRange(gi, grid.length))
          return `${at}（rotateRows）的 group 越界：${String(gi)}（应为 0~${grid.length - 1} 或 null）`;
        if (!Number.isInteger(rec.by)) return `${at}（rotateRows）的 by 必须是整数，实际 ${String(rec.by)}`;
        break;
      }
      default:
        return `${at}的 op 不认识：${String(rec.op)}（可用 swapSeats / swapRows / rotateLR / rotateRows）`;
    }
  }
  return null;
}

// ===== 操作执行 =====

/** 组内排整体轮转：by 为正表示向后移 */
function rotateRowsIn(g: (string | null)[][], by: number): (string | null)[][] {
  const n = g.length;
  if (n <= 1) return g;
  const k = ((by % n) + n) % n;
  if (k === 0) return g;
  return [...g.slice(n - k), ...g.slice(0, n - k)];
}

/**
 * 按顺序执行操作，返回新网格（不改动入参）。
 * 前提：ops 已通过 validateOps —— 只做交换与轮转，姓名的多重集与各组维度必然不变。
 */
export function applyOps(grid: Grid, ops: SeatOp[]): Grid {
  const out: Grid = grid.map((g) => g.map((r) => [...r]));

  for (const op of ops) {
    if (op.op === "swapSeats") {
      const [ag, ar, as] = op.a;
      const [bg, br, bs] = op.b;
      const t = out[ag]![ar]![as];
      out[ag]![ar]![as] = out[bg]![br]![bs];
      out[bg]![br]![bs] = t;
    } else if (op.op === "swapRows") {
      const [ag, ar] = op.a;
      const [bg, br] = op.b;
      const t = out[ag]![ar];
      out[ag]![ar] = out[bg]![br];
      out[bg]![br] = t!;
    } else if (op.op === "rotateLR") {
      for (const g of out) for (const row of g) row.reverse();
    } else {
      const targets = op.group === null ? out.map((_, i) => i) : [op.group];
      for (const gi of targets) out[gi] = rotateRowsIn(out[gi]!, op.by);
    }
  }
  return out;
}

/** 把操作翻成人话，给用户核对（例：交换 第四组第7排第1座 与 第二组第8排第1座） */
export function describeOps(ops: SeatOp[], labels: string[]): string {
  const grp = (g: number) => labels[g] ?? `第 ${g + 1} 组`;
  const seat = ([g, r, s]: SeatRef) => `${grp(g)}第${r + 1}排第${s + 1}座`;
  const row = ([g, r]: RowRef) => `${grp(g)}第${r + 1}排`;
  return ops
    .map((o) => {
      if (o.op === "swapSeats") return `交换 ${seat(o.a)} 与 ${seat(o.b)}`;
      if (o.op === "swapRows") return `${row(o.a)} 与 ${row(o.b)} 整排对调`;
      if (o.op === "rotateLR") return "每组每排左右对调";
      const dir = o.by > 0 ? `向后轮转 ${o.by} 排` : `向前轮转 ${-o.by} 排`;
      return o.group === null ? `所有组${dir}` : `${grp(o.group)}${dir}`;
    })
    .join("；");
}

/** 解析 + 校验 + 执行 AI 返回 */
export function parseArrangement(text: string, grid: Grid, labels: string[]): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stripToJson(text));
  } catch (e) {
    return { ok: false, error: `返回不是合法 JSON：${e}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: '返回应为 {"reason":"…","ops":[…] } 对象' };

  const rec = raw as Record<string, unknown>;
  const reason = typeof rec.reason === "string" ? rec.reason.trim() : "";
  const bad = validateOps(rec.ops, grid);
  if (bad) return { ok: false, error: bad };

  const ops = rec.ops as SeatOp[];
  return { ok: true, grid: applyOps(grid, ops), reason, ops, summary: describeOps(ops, labels) };
}

/** 追问时追加的消息：本轮 payload 必须按「当前网格」重建，模型才知道现在的状态 */
export function appendFollowUp(
  messages: ChatMessage[],
  previousReply: string,
  nextPayload: string,
): ChatMessage[] {
  return [
    ...messages,
    { role: "assistant", content: previousReply },
    { role: "user", content: nextPayload },
  ];
}

/** 自检：样例该过的过、该拒的拒；失败抛 Error */
export function runAiSelfCheck(): void {
  const labels = ["第四组", "第三组"];
  // 组 0 有 2 排，组 1 有 3 排——刻意不整齐，用于暴露维度相关的问题
  const base: Grid = [
    [
      ["a1", "a2"],
      ["b1", "b2"],
    ],
    [
      ["c1", "c2"],
      ["d1", "d2"],
      ["e1", "e2"],
    ],
  ];
  const names = flattenNames(base).slice().sort().join();
  const snapshot = JSON.stringify(base);

  const must = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg);
  };
  /** 执行操作后姓名多重集必须不变——这是本架构的核心不变量 */
  const applyAndCheck = (ops: SeatOp[], label: string) => {
    const out = applyOps(base, ops);
    must(flattenNames(out).slice().sort().join() === names, `${label}：姓名集合被改变了`);
    must(
      JSON.stringify(rowCounts(out)) === JSON.stringify(rowCounts(base)),
      `${label}：各组排数被改变了`,
    );
    must(JSON.stringify(base) === snapshot, `${label}：applyOps 改动了入参`);
    return out;
  };

  // ---- 各操作的正确性 ----
  {
    const out = applyAndCheck([{ op: "swapSeats", a: [0, 0, 0], b: [1, 2, 1] }], "swapSeats");
    must(out[0]![0]![0] === "e2" && out[1]![2]![1] === "a1", "swapSeats 未正确交换");
    must(out[0]![0]![1] === "a2", "swapSeats 误伤了其它座位");
  }
  {
    const out = applyAndCheck([{ op: "swapSeats", a: [0, 0, 0], b: [0, 0, 1] }], "swapSeats 同组同排");
    must(out[0]![0]![0] === "a2" && out[0]![0]![1] === "a1", "同排内交换失败");
  }
  {
    const out = applyAndCheck([{ op: "swapRows", a: [0, 0], b: [1, 2] }], "swapRows 跨组");
    must(out[0]![0]!.join() === "e1,e2" && out[1]![2]!.join() === "a1,a2", "swapRows 跨组失败");
  }
  {
    const out = applyAndCheck([{ op: "swapRows", a: [1, 0], b: [1, 2] }], "swapRows 同组");
    must(out[1]![0]!.join() === "e1,e2" && out[1]![2]!.join() === "c1,c2", "swapRows 同组失败");
  }
  {
    const out = applyAndCheck([{ op: "rotateLR" }], "rotateLR");
    must(out[0]![0]!.join() === "a2,a1", "rotateLR 未左右对调");
    must(out[1]![2]!.join() === "e2,e1", "rotateLR 漏了后面的组");
  }
  {
    const out = applyAndCheck([{ op: "rotateRows", group: 0, by: 1 }], "rotateRows 单组向后");
    must(out[0]!.map((r) => r[0]).join() === "b1,a1", "rotateRows 向后 1 排不对");
    must(out[1]![0]![0] === "c1", "rotateRows 误动了别的组");
  }
  {
    const out = applyAndCheck([{ op: "rotateRows", group: 0, by: -1 }], "rotateRows 向前等于向后 n-1");
    must(out[0]!.map((r) => r[0]).join() === "b1,a1", "rotateRows 向前 1 排不对");
  }
  {
    const out = applyAndCheck([{ op: "rotateRows", group: null, by: 1 }], "rotateRows 全部组");
    must(out[0]!.map((r) => r[0]).join() === "b1,a1", "全部组时第 1 组不对");
    must(out[1]!.map((r) => r[0]).join() === "e1,c1,d1", "全部组时第 2 组（3 排）不对");
  }
  {
    const out = applyAndCheck([{ op: "rotateRows", group: 0, by: 2 }], "rotateRows by=排数 等价于不动");
    must(out[0]!.map((r) => r[0]).join() === "a1,b1", "by 等于排数时应还原");
  }
  {
    // 多操作按顺序叠加：先换 a1↔b1，再左右对调
    const out = applyAndCheck(
      [
        { op: "swapSeats", a: [0, 0, 0], b: [0, 1, 0] },
        { op: "rotateLR" },
      ],
      "多操作叠加",
    );
    must(out[0]![0]!.join() === "a2,b1", `多操作叠加结果应为 a2,b1，实际 ${out[0]![0]!.join()}`);
    must(out[0]![1]!.join() === "b2,a1", `多操作叠加第二排应为 b2,a1，实际 ${out[0]![1]!.join()}`);
  }

  // ---- 操作校验：该拒的必须拒 ----
  const badCases: Array<[string, unknown]> = [
    ["ops 不是数组", {}],
    ["ops 为空", []],
    ["操作不是对象", [1]],
    ["op 不认识", [{ op: "deleteStudent", a: [0, 0, 0] }]],
    ["swapSeats 的 a 不是三元数组", [{ op: "swapSeats", a: [0, 0], b: [0, 0, 0] }]],
    ["swapSeats 组下标越界", [{ op: "swapSeats", a: [9, 0, 0], b: [0, 0, 0] }]],
    ["swapSeats 排下标越界", [{ op: "swapSeats", a: [1, 9, 0], b: [0, 0, 0] }]],
    ["swapSeats 座下标越界", [{ op: "swapSeats", a: [0, 0, 9], b: [0, 0, 0] }]],
    ["swapSeats 下标为负", [{ op: "swapSeats", a: [-1, 0, 0], b: [0, 0, 0] }]],
    ["swapSeats 下标非整数", [{ op: "swapSeats", a: [0, 0, 1.5], b: [0, 0, 0] }]],
    ["swapRows 的 a 不是二元数组", [{ op: "swapRows", a: [0], b: [0, 0] }]],
    ["swapRows 排下标越界", [{ op: "swapRows", a: [0, 9], b: [1, 0] }]],
    ["rotateRows group 越界", [{ op: "rotateRows", group: 9, by: 1 }]],
    ["rotateRows by 非整数", [{ op: "rotateRows", group: 0, by: 1.5 }]],
  ];
  for (const [name, raw] of badCases) {
    must(validateOps(raw, base) !== null, `样例「${name}」应被拒绝，实际通过了`);
  }

  /** 同组内两排座位数不同时，整排对调必须被拒 */
  {
    const uneven: Grid = [[["a"], ["b", "c"]]];
    const err = validateOps([{ op: "swapRows", a: [0, 0], b: [0, 1] }], uneven);
    must(err !== null && err.includes("座位数不同"), `座位数不同的整排对调应被拒，实际：${err}`);
  }

  // ---- 端到端解析 ----
  const reply = (body: unknown) => JSON.stringify(body);
  {
    const r = parseArrangement(
      reply({ reason: "左右对调更公平", ops: [{ op: "rotateLR" }] }),
      base,
      labels,
    );
    must(r.ok, `标准返回应通过，实际：${r.ok ? "" : r.error}`);
    if (r.ok) {
      must(r.reason.includes("更公平"), "reason 未取出");
      must(r.grid[0]![0]!.join() === "a2,a1", "网格未按操作执行");
      must(r.summary.includes("左右对调"), `summary 应可读，实际：${r.summary}`);
    }
  }
  {
    // summary 要把下标翻成组名与「第 N 排第 M 座」，用户才能核对
    const s = describeOps(
      [
        { op: "swapRows", a: [0, 0], b: [1, 2] },
        { op: "rotateRows", group: 1, by: -2 },
        { op: "rotateRows", group: null, by: 1 },
      ],
      labels,
    );
    must(s.includes("第四组第1排"), `summary 应用组名与排号，实际：${s}`);
    must(s.includes("第三组第3排"), `summary 应用组名与排号，实际：${s}`);
    must(s.includes("向前轮转 2 排"), `负 by 应说「向前」，实际：${s}`);
    must(s.includes("所有组向后轮转 1 排"), `group=null 应说「所有组」，实际：${s}`);
  }
  {
    // 座位级操作的 summary 要精确到座
    const s = describeOps([{ op: "swapSeats", a: [0, 0, 1], b: [1, 2, 0] }], labels);
    must(s.includes("第四组第1排第2座"), `summary 应精确到座，实际：${s}`);
    must(s.includes("第三组第3排第1座"), `summary 应精确到座，实际：${s}`);
  }
  {
    // 带 markdown 围栏
    const body = reply({ reason: "r", ops: [{ op: "rotateLR" }] });
    const r = parseArrangement("好的：\n```json\n" + body + "\n```\n以上", base, labels);
    must(r.ok, `带围栏的返回应通过，实际：${r.ok ? "" : r.error}`);
  }
  {
    // 尾部闲话含方括号
    const body = reply({ reason: "轮换[前后排]", ops: [{ op: "rotateLR" }] });
    const r = parseArrangement(body + " 已调整[公平]，见[1]", base, labels);
    must(r.ok, `尾部含方括号的返回应通过，实际：${r.ok ? "" : r.error}`);
    if (r.ok) must(r.reason.includes("前后排"), `reason 应完整，实际：${r.reason}`);
  }
  {
    const r = parseArrangement("这不是 JSON", base, labels);
    must(!r.ok, "非 JSON 文本应被拒");
  }
  {
    const r = parseArrangement(reply([{ op: "rotateLR" }]), base, labels);
    must(!r.ok, "裸数组返回应被拒（本版本要求对象）");
  }
  {
    const r = parseArrangement(reply({ reason: "只有理由" }), base, labels);
    must(!r.ok && r.error.includes("ops"), `缺 ops 应点名，实际：${r.ok ? "" : r.error}`);
  }
  {
    // 模型自作主张输出座位表 → 必须被拒，而不是当作没调整
    const r = parseArrangement(reply({ reason: "r", grid: base }), base, labels);
    must(!r.ok, "模型输出 grid 而非 ops 时应被拒");
  }

  // ---- buildMessages ----
  {
    const { user, system } = buildMessages({
      grid: base,
      labels,
      singleSeatName: "庚",
      history: [],
      instruction: "换个坐法",
    });
    const p = JSON.parse(user) as {
      roster: string[];
      current: Grid;
      groups: string[];
      shape: { rows: number[]; seatsPerRow: number };
    };
    must(
      JSON.stringify(p.roster) === JSON.stringify([...flattenNames(base), "庚"]),
      `roster 应为网格姓名+单座，实际：${JSON.stringify(p.roster)}`,
    );
    must(JSON.stringify(p.current) === JSON.stringify(base), "current 应与输入网格一致");
    must(JSON.stringify(p.groups) === JSON.stringify(labels), "groups 应原样透传");
    must(JSON.stringify(p.shape.rows) === JSON.stringify([2, 3]), "shape.rows 应为各组排数");
    must(!system.includes("座位表本身") === false, "系统提示应说明不输出座位表");
    must(system.includes("deskPairs"), "系统提示应告诉模型优先查 deskPairs 而不是自己数坐标");
    must(system.includes("思考过程一律用中文"), "系统提示应要求思考过程用中文");

    // 学生档案：空档案不上行，填了的原样带上
    const withNotes = JSON.parse(
      buildMessages({
        grid: base,
        labels,
        singleSeatName: "",
        history: [],
        instruction: "排座",
        students: [
          { name: "甲", trait: "近视" },
          { name: "乙", trait: "", note: "" },
          { name: "丙", note: "不能和 甲 同桌" },
        ],
      }).user,
    ) as { students?: { name: string; trait?: string; note?: string }[] };
    must(
      JSON.stringify(withNotes.students) ===
        JSON.stringify([
          { name: "甲", trait: "近视" },
          { name: "丙", note: "不能和 甲 同桌" },
        ]),
      `students 应只带填了内容的档案，实际：${JSON.stringify(withNotes.students)}`,
    );
    const noNotes = JSON.parse(
      buildMessages({ grid: base, labels, singleSeatName: "", history: [], instruction: "排座" }).user,
    ) as { students?: unknown; deskPairs: DeskPair[] };
    must(!("students" in noNotes), "没有档案时不应出现 students 字段");

    // deskPairs：同桌对由程序算好——每排一组相邻两座，带上两人的档案，空位是 null，双空排不出现
    const pairs = noNotes.deskPairs;
    must(pairs.length === 5, `base 有 2+3 排共 5 对同桌，实际 ${pairs.length}`);
    must(
      JSON.stringify(pairs[0]!.seats) === JSON.stringify([
        [0, 0, 0],
        [0, 0, 1],
      ]),
      `首对应为第一组第一排的两个座位，实际 ${JSON.stringify(pairs[0]!.seats)}`,
    );
    must(
      JSON.stringify(pairs[0]!.students.map((s) => s?.name)) === JSON.stringify(["a1", "a2"]),
      `首对应带出同桌两人的姓名，实际 ${JSON.stringify(pairs[0]!.students)}`,
    );
    must(
      JSON.stringify(pairs[4]!.seats) === JSON.stringify([
        [1, 2, 0],
        [1, 2, 1],
      ]),
      `末对应为第二组第三排，实际 ${JSON.stringify(pairs[4]!.seats)}`,
    );

    // 档案要跟着同桌对上到人头上：同桌过的才带 trait / note
    const withDesk = JSON.parse(
      buildMessages({
        grid: [[["a1", "a2"]]],
        labels: ["第一组"],
        singleSeatName: "",
        history: [],
        instruction: "排座",
        students: [{ name: "a2", trait: "爱抠鼻屎" }],
      }).user,
    ) as { deskPairs: DeskPair[] };
    must(
      JSON.stringify(withDesk.deskPairs[0]!.students) ===
        JSON.stringify([{ name: "a1" }, { name: "a2", trait: "爱抠鼻屎" }]),
      `同桌对应带出各自档案，实际 ${JSON.stringify(withDesk.deskPairs[0]!.students)}`,
    );

    // 空位是 null；两人都空的排不进列表；奇数座时最后一个落单不算同桌
    const sparse = deskPairsOf([[["a1", null], [null, null], ["b1", "b2", "c1"]]]);
    must(
      JSON.stringify(sparse.map((d) => d.students)) ===
        JSON.stringify([
          [{ name: "a1" }, null],
          [{ name: "b1" }, { name: "b2" }],
        ]),
      `空位 / 双空排 / 落单座的处理不对，实际 ${JSON.stringify(sparse.map((d) => d.students))}`,
    );
  }

  // ---- appendFollowUp ----
  {
    const msgs: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u1" },
    ];
    const next = appendFollowUp(msgs, "reply1", "u2");
    must(next.length === 4, `追问后应有 4 条消息，实际 ${next.length}`);
    must(next[2]!.role === "assistant" && next[2]!.content === "reply1", "第 3 条应为上一轮原文");
    must(next[3]!.role === "user" && next[3]!.content === "u2", "第 4 条应为本轮 payload");
    must(msgs.length === 2, "appendFollowUp 不应改动原数组");
  }
}

// ===== 与 Rust 通信（动态 import，保持本文件可独立自检）=====

/** 读取本地 config.json（Rust 侧按序查找） */
export async function loadAiConfig(): Promise<LoadedAiConfig> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LoadedAiConfig>("load_ai_config");
}

/** 测试连接，成功返回耗时字符串（如 "0.8s"） */
export async function testAiConnection(config: AiConfig): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("test_ai_connection", { config });
}

/** 拉模型列表（GET {base}/v1/models） */
export async function listModels(config: AiConfig): Promise<string[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("fetch_models", { config });
}

/** 保存配置到配置文件，返回实际写入的路径 */
export async function saveAiConfig(path: string, config: AiConfig): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("save_ai_config", { path, config });
}

/** 流式增量：reasoning 是模型的思考过程，content 是正文（最终那串 JSON 操作）的片段 */
export interface AiStreamEvent {
  kind: "reasoning" | "content";
  text: string;
}

/** 调 AI 排座：流式回推增量，最终返回拼好的原始文本 */
export async function arrangeSeats(
  config: AiConfig,
  messages: ChatMessage[],
  onEvent: (e: AiStreamEvent) => void,
): Promise<string> {
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  const channel = new Channel<AiStreamEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("ai_arrange", { config, messages, onEvent: channel });
}

// 自检也可用 node 直接跑：`node --experimental-strip-types src/lib/ai.ts`
declare const process:
  | { stdout: { write: (s: string) => void } }
  | undefined;
if (typeof document === "undefined" && typeof process !== "undefined") {
  runAiSelfCheck();
  process.stdout.write("ai 自检通过\n");
}
