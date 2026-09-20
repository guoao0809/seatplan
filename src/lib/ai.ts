// AI 排座：拼提示词、解析并校验模型返回的座位表。
// 本文件不含任何静态 import，可独立自检：node --experimental-strip-types src/lib/ai.ts

/** config.json 的内容（OpenAI 兼容） */
export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
}

/** Rust load_ai_config 的返回 */
export interface LoadedAiConfig {
  config: AiConfig;
  path: string;
}

export interface ArrangeInput {
  /** 当前网格：组 → 排 → 座 → 姓名或 null */
  grid: (string | null)[][][];
  /** 单座学生姓名（不参与网格排座，仅作上下文） */
  singleSeatName: string;
  /** 最近几次历史网格（最新在前） */
  history: (string | null)[][][][];
  /** 用户的自然语言要求 */
  instruction: string;
  /** 每组排数 */
  rows: number[];
  /** 每排座位数 */
  seatsPerRow: number;
}

export type ParseResult =
  | { ok: true; grid: (string | null)[][][] }
  | { ok: false; reason: string };

/** 展平网格，取出所有非空姓名 */
export function flattenNames(grid: (string | null)[][][]): string[] {
  const out: string[] = [];
  for (const g of grid) for (const r of g) for (const n of r) if (n) out.push(n);
  return out;
}

const SYSTEM_PROMPT = [
  "你是教室排座助手。用户给你当前座位表和一句排座要求，你返回调整后的座位表。",
  "",
  "硬性规则：",
  "1. 只返回 JSON，不要任何解释文字，不要 markdown 代码块围栏。",
  "2. 返回的网格维度必须与 current 完全一致：组数、每组排数、每排座位数都不能变。",
  "3. 只能使用 roster 中出现的姓名，一个不多一个不少；不允许改名、不允许编造姓名。",
  "4. 空座位保持为 null。",
  "5. roster 中位于 singleSeat 的姓名不要放进网格。",
].join("\n");

/** 构造发给 AI 的两条消息 */
export function buildMessages(input: ArrangeInput): { system: string; user: string } {
  const inGrid = flattenNames(input.grid);
  const payload = {
    instruction: input.instruction,
    shape: { rows: input.rows, seatsPerRow: input.seatsPerRow },
    singleSeat: input.singleSeatName || null,
    roster: input.singleSeatName ? [...inGrid, input.singleSeatName] : inGrid,
    current: input.grid,
    history: input.history,
  };
  return { system: SYSTEM_PROMPT, user: JSON.stringify(payload) };
}

/** 剥掉 markdown 代码块围栏与前后闲话，取出 JSON 文本 */
export function stripToJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? text).trim();
  // 从第一个 [ 起、按 ] 位置从后往前收缩，取第一个能解析成功的片段：
  // 整段是纯 JSON 时首个候选（最长片段）直接命中——等价于先试 JSON.parse；
  // 网格后跟含方括号的闲话（「已调整[公平]，请查看[1]」）也不会被截坏。
  const start = body.indexOf("[");
  if (start < 0) return body;
  for (let end = body.lastIndexOf("]"); end > start; end = body.lastIndexOf("]", end - 1)) {
    const cand = body.slice(start, end + 1);
    try {
      JSON.parse(cand);
      return cand;
    } catch {
      /* 收缩到前一个 ] 再试 */
    }
  }
  return body.slice(start);
}

/** 校验网格结构与姓名集合；通过返回 null，否则返回中文原因 */
export function validateGrid(
  raw: unknown,
  rows: number[],
  seatsPerRow: number,
  expectedNames: string[],
): string | null {
  if (!Array.isArray(raw)) return "返回的不是数组";
  if (raw.length !== rows.length)
    return `组数不符：应为 ${rows.length} 组，实际 ${raw.length} 组`;

  const names: string[] = [];
  for (let g = 0; g < rows.length; g++) {
    const grp = raw[g];
    if (!Array.isArray(grp)) return `第 ${g + 1} 组不是数组`;
    if (grp.length !== rows[g])
      return `第 ${g + 1} 组排数不符：应为 ${rows[g]} 排，实际 ${grp.length} 排`;
    for (let r = 0; r < rows[g]!; r++) {
      const row = grp[r];
      if (!Array.isArray(row)) return `第 ${g + 1} 组第 ${r + 1} 排不是数组`;
      if (row.length !== seatsPerRow)
        return `第 ${g + 1} 组第 ${r + 1} 排座位数不符：应为 ${seatsPerRow} 座，实际 ${row.length} 座`;
      for (const seat of row) {
        if (seat !== null && typeof seat !== "string")
          return `座位值只能是姓名或 null，实际是 ${typeof seat}`;
        if (seat) names.push(seat);
      }
    }
  }

  // 姓名多重集比对（重名也要能被正确检出）
  const tally = (list: string[]) => {
    const m = new Map<string, number>();
    for (const n of list) m.set(n, (m.get(n) ?? 0) + 1);
    return m;
  };
  const got = tally(names);
  const want = tally(expectedNames);
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [n, c] of want) {
    const d = c - (got.get(n) ?? 0);
    if (d > 0) missing.push(d > 1 ? `${n}×${d}` : n);
  }
  for (const [n, c] of got) {
    const d = c - (want.get(n) ?? 0);
    if (d > 0) extra.push(d > 1 ? `${n}×${d}` : n);
  }
  if (missing.length || extra.length) {
    const parts: string[] = [];
    if (missing.length) parts.push(`少了 ${missing.length} 个：${missing.join("、")}`);
    if (extra.length) parts.push(`多了 ${extra.length} 个：${extra.join("、")}`);
    return `姓名对不上（${parts.join("；")}）`;
  }
  return null;
}

/** 解析 + 校验 AI 返回 */
export function parseArrangement(
  text: string,
  rows: number[],
  seatsPerRow: number,
  expectedNames: string[],
): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stripToJson(text));
  } catch (e) {
    return { ok: false, reason: `返回不是合法 JSON：${e}` };
  }
  const reason = validateGrid(raw, rows, seatsPerRow, expectedNames);
  if (reason) return { ok: false, reason };
  return { ok: true, grid: raw as (string | null)[][][] };
}

/** 自检：样例该过的过、该拒的拒；失败抛 Error */
export function runAiSelfCheck(): void {
  const rows = [2, 2];
  const seatsPerRow = 2;
  const expected = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛"];
  const good: (string | null)[][][] = [
    [
      ["甲", "乙"],
      ["丙", "丁"],
    ],
    [
      ["戊", "己"],
      ["庚", "辛"],
    ],
  ];
  const cases: Array<[string, unknown, boolean]> = [
    ["正常", good, true],
    [
      "漏名字",
      [
        [
          ["甲", "乙"],
          ["丙", "丁"],
        ],
        [
          ["戊", "己"],
          ["庚", null],
        ],
      ],
      false,
    ],
    ["组数不符", [good[0]], false],
    [
      "排数不符",
      [
        [["甲", "乙"]],
        [
          ["戊", "己"],
          ["庚", "辛"],
        ],
      ],
      false,
    ],
    [
      "座位数不符",
      [
        [
          ["甲", "乙", "丙"],
          ["丁"],
        ],
        [
          ["戊", "己"],
          ["庚", "辛"],
        ],
      ],
      false,
    ],
    [
      "重名",
      [
        [
          ["甲", "甲"],
          ["丙", "丁"],
        ],
        [
          ["戊", "己"],
          ["庚", "辛"],
        ],
      ],
      false,
    ],
    ["座位值类型", [[[1, "乙"], ["丙", "丁"]], [["戊", "己"], ["庚", "辛"]]], false],
    ["座位值是数组", [[[["甲"], "乙"], ["丙", "丁"]], [["戊", "己"], ["庚", "辛"]]], false],
    ["不是数组", { a: 1 }, false],
  ];

  for (const [name, raw, shouldPass] of cases) {
    const reason = validateGrid(raw, rows, seatsPerRow, expected);
    const passed = reason === null;
    if (passed !== shouldPass) {
      throw new Error(
        `样例「${name}」期望${shouldPass ? "通过" : "被拒"}，实际${passed ? "通过" : `被拒（${reason}）`}`,
      );
    }
  }

  // 座位值类型非法必须被类型检查直接点名（不能只靠后面的姓名比对兜底）
  const typeReason = validateGrid(
    [[[1, "乙"], ["丙", "丁"]], [["戊", "己"], ["庚", "辛"]]],
    rows,
    seatsPerRow,
    expected,
  );
  if (typeReason === null || !typeReason.includes("座位值只能是姓名或 null"))
    throw new Error(`座位值类型非法应由类型检查拒绝，实际：${typeReason}`);

  // 展平
  if (flattenNames(good).length !== 8) throw new Error("flattenNames 应取到 8 个姓名");

  // 带 markdown 围栏与前后闲话的返回也要能剥出来
  const wrapped = "好的，结果如下：\n```json\n" + JSON.stringify(good) + "\n```\n以上。";
  const r = parseArrangement(wrapped, rows, seatsPerRow, expected);
  if (!r.ok) throw new Error(`带围栏的返回应能解析，实际被拒：${r.reason}`);

  // 凭空多出一个名字必须被拒
  const extra = JSON.parse(JSON.stringify(good)) as (string | null)[][][];
  extra[1]![1]![1] = "壬";
  if (validateGrid(extra, rows, seatsPerRow, expected) === null)
    throw new Error("多出未在名单中的姓名应被拒绝");

  // 同时缺名与多名：理由里必须同时点出「少了」和「多了」
  const swap = JSON.parse(JSON.stringify(good)) as (string | null)[][][];
  swap[0]![0]![1] = "壬";
  const swapReason = validateGrid(swap, rows, seatsPerRow, expected);
  if (swapReason === null) throw new Error("少一个又多一个的网格应被拒绝");
  if (!swapReason.includes("少了") || !swapReason.includes("多了"))
    throw new Error(`理由应同时包含「少了」与「多了」，实际：${swapReason}`);

  // 非 JSON 文本必须被拒，而不是抛异常
  const bad = parseArrangement("这不是 JSON", rows, seatsPerRow, expected);
  if (bad.ok) throw new Error("非 JSON 文本应被拒绝");

  // 维度不符时也应走 ok:false，而不是抛异常
  const wrongShape = parseArrangement(JSON.stringify([good[0]]), rows, seatsPerRow, expected);
  if (wrongShape.ok) throw new Error("组数不符的返回应被拒绝");

  // buildMessages 发出的 roster 必须与 validateGrid 期待的名单对齐：网格名 + 单座名，current 原样携带
  {
    const grid: (string | null)[][][] = [
      [
        ["甲", "乙"],
        ["丙", null],
      ],
      [
        ["丁", "戊"],
        ["己", null],
      ],
    ];
    const { user } = buildMessages({
      grid,
      singleSeatName: "庚",
      history: [],
      instruction: "换个坐法",
      rows: [2, 2],
      seatsPerRow: 2,
    });
    const payload = JSON.parse(user) as {
      roster: string[];
      current: (string | null)[][][];
    };
    const wantRoster = [...flattenNames(grid), "庚"];
    if (JSON.stringify(payload.roster) !== JSON.stringify(wantRoster))
      throw new Error(
        `buildMessages 的 roster 应为网格姓名+单座，实际：${JSON.stringify(payload.roster)}`,
      );
    if (JSON.stringify(payload.current) !== JSON.stringify(grid))
      throw new Error("buildMessages 的 current 应与输入网格一致");
    // 该 roster 正是 parseArrangement 期待的名单（expectedNames 取网格名）
    const okRes = parseArrangement(JSON.stringify(grid), rows, seatsPerRow, flattenNames(grid));
    if (!okRes.ok) throw new Error(`网格对自身 roster 的校验应通过，实际被拒：${okRes.reason}`);
  }

  // 正确 JSON 后跟含方括号的闲话也应整体解析成功（不能被括号切片截坏）
  {
    const trailing = JSON.stringify(good) + " 已调整[公平]，请查看[1]。";
    const r2 = parseArrangement(trailing, rows, seatsPerRow, expected);
    if (!r2.ok) throw new Error(`尾部闲话含方括号的返回应能解析，实际被拒：${r2.reason}`);
  }
}

// ===== 与 Rust 通信（动态 import，保持本文件可独立自检）=====

/** 读取本地 config.json（Rust 侧按序查找） */
export async function loadAiConfig(): Promise<LoadedAiConfig> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LoadedAiConfig>("load_ai_config");
}

/** 调 AI 排座，返回模型输出的原始文本 */
export async function arrangeSeats(
  config: AiConfig,
  system: string,
  user: string,
): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("ai_arrange", { config, system, user });
}

// 自检也可用 node 直接跑：`node --experimental-strip-types src/lib/ai.ts`
declare const process:
  | { stdout: { write: (s: string) => void } }
  | undefined;
if (typeof document === "undefined" && typeof process !== "undefined") {
  runAiSelfCheck();
  process.stdout.write("ai 自检通过\n");
}
