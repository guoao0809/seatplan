// 教室排座核心逻辑：把名单分配到「组 × 排 × 每排座位」的网格里。

/** 默认示例名单：完全按图片顺序整理（第一组 → 第四组，组内由上到下）。共 60 人。 */
export const DEFAULT_ROSTER = [
  // 第一组（7 排 = 14 人）
  "陈玙宇", "李尹馨", "谌宗山", "刘瑾诺", "杨锦琛", "钟浩宇", "刘若依", "武皓辰",
  "赵家栋", "钟语瑄", "丁璟阳", "白语然", "肖志高", "陈乐仪",
  // 第二组（7 排 = 14 人）
  "张思邈", "夏林磊", "吴屹哲", "乐泽林", "陈语晴", "张浩辰", "杨昊辰", "王淳希",
  "李彦辰", "钱沐阳", "段紫玥", "李柏焱", "白沐兮", "毛伊伊",
  // 第三组（8 排 = 16 人）
  "杨妤芊", "祁博衍", "闫梓航", "胡婧希", "席欣潼", "肖枰宸", "王怿瑶", "魏诗璇",
  "曾舒桐", "周子孺", "邹清妍", "夏林旭", "齐文正", "朱美翼", "吕澄一", "高梓博",
  // 第四组（8 排 = 16 人）
  "刘昊然", "唐夕珈", "张熙雯", "喻衍嘉", "杨依霖", "杨沐晨", "李博彦", "彭欣桐",
  "张金诺", "关哲煜", "郭沐晴", "陈馥安", "井玉程", "康林芸", "蔡彦哲", "李炜彤",
];

/** 每排座位数（默认两人一桌） */
export const DEFAULT_SEATS_PER_ROW = 2;
/** 默认各组排数（也是老配置迁移时的兜底） */
export const DEFAULT_ROWS_PER_GROUP = [7, 7, 8, 8];

/**
 * 组配色表。整体取中深色调，使白字在每一组上都可读——保持「白字 + 彩底」的观感统一，
 * 而不是每组自动换字色导致深浅不一。用户自己选到浅色时由 readableText 兜底。
 * 刻意把天蓝排在第 8 位——它和「单座」的颜色接近，组少时就不会撞色。
 */
export const GROUP_COLORS = [
  "#6BA24C", // 草绿
  "#D08A2A", // 琥珀
  "#6B7FCC", // 靛蓝
  "#D2604A", // 珊瑚
  "#2F9A8B", // 青碧
  "#9668B5", // 紫罗兰
  "#A07828", // 金
  "#3D82BE", // 天蓝
];

/** 按序号取配色，组数超过调色板长度时循环 */
export function paletteColor(index: number): string {
  return GROUP_COLORS[index % GROUP_COLORS.length]!;
}

/** 一组（一列）的配置：排数 + 配色 */
export interface GroupConfig {
  rows: number;
  color: string;
}

/** 由排数数组补上配色，得到完整配置（默认值、老配置迁移、恢复记录都走这里） */
export function toGroupConfigs(rows: number[], colors?: string[]): GroupConfig[] {
  return rows.map((r, i) => ({ rows: r, color: colors?.[i] ?? paletteColor(i) }));
}

/** 默认配置（首次打开 / 配置损坏时用） */
export function defaultGroupConfigs(): GroupConfig[] {
  return toGroupConfigs(DEFAULT_ROWS_PER_GROUP);
}

const CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/** 数字转中文（用于「第一组」等，1~99 够用） */
export function cnNum(n: number): string {
  if (n <= 0) return String(n);
  if (n <= 10) return CN_NUM[n - 1];
  if (n < 20) return n % 10 === 0 ? "十" : `十${CN_NUM[(n % 10) - 1]}`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${CN_NUM[tens - 1]}十${ones === 0 ? "" : CN_NUM[ones - 1]}`;
}

/** 解析名单文本：支持按换行 / 逗号 / 顿号 / 空格分隔，去空项 */
export function parseRoster(text: string): string[] {
  return text
    .split(/[\n,，、;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 名单一行：姓名 + 学生特点 + 注意事项 */
export interface RosterRow {
  name: string;
  trait: string;
  note: string;
}

/** 由姓名列表生成名单行（特点 / 注意事项留空） */
export function toRosterRows(names: string[]): RosterRow[] {
  return names.map((name) => ({ name, trait: "", note: "" }));
}

/**
 * 解析名单表格的批量粘贴文本：每行一个学生，列间用空格 / 逗号 / 顿号 / 分号 / 制表符分隔。
 * 超过三列时多余部分并进注意事项（而不是丢掉），只给姓名时后两列留空。
 */
export function parseRosterTable(text: string): RosterRow[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", trait = "", ...rest] = line.split(/[,，、;；\t ]+/);
      return { name, trait, note: rest.join(" ").trim() };
    })
    .filter((r) => r.name);
}

/** 读取持久化的名单：新格式是 JSON 行数组，老格式是纯文本姓名表（迁移成只有姓名一列） */
export function loadRoster(raw: string): RosterRow[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((r) => {
        const row = r as Partial<RosterRow> | null;
        return {
          name: String(row?.name ?? ""),
          trait: String(row?.trait ?? ""),
          note: String(row?.note ?? ""),
        };
      });
    }
  } catch {
    /* 老格式：不是 JSON，走下面的纯文本迁移 */
  }
  return toRosterRows(parseRoster(raw));
}

/** 解析旧版「每组排数」文本（如 "7,7,8,8"）。仅用于迁移老配置，新配置已改为表格。 */
export function parseRows(text: string): number[] {
  const nums = text
    .split(/[,，、;\s]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return nums.length > 0 ? nums : DEFAULT_ROWS_PER_GROUP;
}

/**
 * 依据背景色亮度选深字或白字，保证用户自选的任意配色都读得清。
 * 用 sRGB 感知亮度近似（0.299R + 0.587G + 0.114B），阈值 0.62。
 */
export function readableText(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1]!, 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? "#111827" : "#ffffff";
}

/** 校验一个 hex 颜色；非法则回退到给定序号的标准配色 */
export function safeColor(value: unknown, index: number): string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim())
    ? value.trim()
    : paletteColor(index);
}

export interface Seat {
  name: string | null;
}
export interface SeatRow {
  seats: Seat[];
}
export interface Group {
  label: string;
  /** 该组配色（hex） */
  color: string;
  rows: SeatRow[];
}

/**
 * 按显示下标生成组名。reverse 时从右往左数（最右为第一组），文字用阿拉伯数字避免歧义。
 * 列数超过 99 就退回阿拉伯数字，反正 cnNum 也表达不了。
 */
export function groupLabel(index: number, total: number, reverse: boolean): string {
  const n = reverse ? total - index : index + 1;
  return n <= 99 ? `第${cnNum(n)}组` : `第${n}组`;
}

/**
 * 把名单依次填入网格：按组顺序、组内按排从上到下、排内从左到右。
 * 名单不够则留空，超出则忽略。讲台置于顶部时第一排离讲台最近。
 */
export function assignSeats(
  roster: string[],
  groups: GroupConfig[],
  seatsPerRow: number,
  reverse = false,
): Group[] {
  let idx = 0;
  return groups.map((cfg, gi) => ({
    label: groupLabel(gi, groups.length, reverse),
    color: cfg.color,
    rows: Array.from({ length: cfg.rows }, () => ({
      seats: Array.from({ length: seatsPerRow }, () => {
        const name = roster[idx++] ?? null;
        return { name };
      }),
    })),
  }));
}

/** 自检：默认名单应恰好铺满默认网格（60 人 = (7+7+8+8)×2 座），失败即抛错。 */
export function runSelfCheck(): void {
  const cfgs = defaultGroupConfigs();
  const groups = assignSeats(DEFAULT_ROSTER, cfgs, DEFAULT_SEATS_PER_ROW);
  const capacity = DEFAULT_ROWS_PER_GROUP.reduce((n, r) => n + r) * DEFAULT_SEATS_PER_ROW;
  const placed = groups.flatMap((g) => g.rows.flatMap((r) => r.seats)).filter((s) => s.name);
  if (DEFAULT_ROSTER.length !== capacity)
    throw new Error(`默认名单数 ${DEFAULT_ROSTER.length} 与容量 ${capacity} 不一致`);
  if (placed.length !== DEFAULT_ROSTER.length)
    throw new Error(`名单未铺满：${placed.length}/${DEFAULT_ROSTER.length}`);
  if (groups[0]!.rows[0]!.seats[0]!.name !== "陈玙宇")
    throw new Error(`第一组首座应为「陈玙宇」，实际「${groups[0]!.rows[0]!.seats[0]!.name}」`);
  if (groups[3]!.rows[7]!.seats[1]!.name !== "李炜彤")
    throw new Error(`第四组末座应为「李炜彤」，实际「${groups[3]!.rows[7]!.seats[1]!.name}」`);

  const rev = ["第四组", "第三组", "第二组", "第一组"];
  if (groups.map((_, i) => groupLabel(i, 4, true)).join() !== rev.join())
    throw new Error(`反向组名应为 ${rev.join()}，实际 ${groups.map((_, i) => groupLabel(i, 4, true)).join()}`);
  if (groupLabel(0, 4, false) !== "第一组") throw new Error("正向组名应为「第一组」");

  // 配色：默认四组必须各不相同，且都带上了
  const colors = groups.map((g) => g.color);
  if (new Set(colors).size !== colors.length)
    throw new Error(`默认各组配色应互不相同，实际 ${colors.join(",")}`);
  if (colors.some((c) => !/^#[0-9a-f]{6}$/i.test(c)))
    throw new Error(`配色应为 6 位 hex，实际 ${colors.join(",")}`);

  // 组数超过调色板长度时循环取用，且不能取到 undefined
  const many = assignSeats([], toGroupConfigs(Array.from({ length: GROUP_COLORS.length + 3 }, () => 1)), 1);
  if (many.some((g) => !g.color))
    throw new Error("组数超过调色板长度时应循环取色，不能为空");

  // 迁移：只给排数时自动补默认配色
  const migrated = toGroupConfigs([3, 4]);
  if (migrated[0]!.color !== paletteColor(0) || migrated[1]!.color !== paletteColor(1))
    throw new Error("toGroupConfigs 未按序号补默认配色");
  if (toGroupConfigs([3], ["#ABCDEF"])[0]!.color !== "#ABCDEF")
    throw new Error("toGroupConfigs 应保留已给配色");

  // 可读文字色：浅底给深字、深底给白字、非法值回退白字
  if (readableText("#FFFFFF") !== "#111827") throw new Error("白底应配深字");
  if (readableText("#000000") !== "#ffffff") throw new Error("黑底应配白字");
  if (readableText("不是颜色") !== "#ffffff") throw new Error("非法颜色应回退白字");
  // 整个调色板都必须配白字，否则各组字色深浅不一，观感割裂
  for (const c of GROUP_COLORS) {
    if (readableText(c) !== "#ffffff")
      throw new Error(`调色板颜色 ${c} 应配白字（当前会配深字），说明它偏亮、需压深`);
  }

  // safeColor：非法值回退到该序号的标准配色
  if (safeColor("red", 2) !== paletteColor(2)) throw new Error("safeColor 应拒绝非 hex 值");
  if (safeColor(undefined, 1) !== paletteColor(1)) throw new Error("safeColor 应处理 undefined");
  if (safeColor("#AABBCC", 0) !== "#AABBCC") throw new Error("safeColor 应保留合法值");

  // 名单表格：按行解析三列
  const table = parseRosterTable("张三 好动 需坐前排\n李四，近视，不能和 王五 同桌\n王五\n\n");
  if (table.length !== 3) throw new Error(`批量粘贴应解析出 3 行，实际 ${table.length}`);
  if (table[0]!.trait !== "好动" || table[0]!.note !== "需坐前排")
    throw new Error(`第一行应解析出特点与注意事项，实际 ${JSON.stringify(table[0])}`);
  if (table[1]!.note !== "不能和 王五 同桌")
    throw new Error(`超过三列的内容应并进注意事项，实际「${table[1]!.note}」`);
  if (table[2]!.trait !== "" || table[2]!.note !== "")
    throw new Error("只给姓名时后两列应为空");

  // 名单持久化：老纯文本迁移成只有姓名一列，新 JSON 原样读回
  const legacy = loadRoster("张三\n李四,王五");
  if (legacy.map((r) => r.name).join() !== "张三,李四,王五")
    throw new Error(`老纯文本名单应迁移为三行，实际 ${JSON.stringify(legacy)}`);
  if (legacy.some((r) => r.trait || r.note)) throw new Error("迁移出的行特点 / 注意事项应为空");
  const fromJson = loadRoster(JSON.stringify([{ name: "张三", trait: "好动", note: "靠窗" }]));
  if (fromJson[0]!.trait !== "好动" || fromJson[0]!.note !== "靠窗")
    throw new Error("JSON 名单应原样读回");
}

// 自检也可用 node 直接跑：`node --experimental-strip-types src/lib/seat.ts`
// 声明避免依赖 node 类型；只有非浏览器环境才会执行
declare const process:
  | { stdout: { write: (s: string) => void }; env: Record<string, string> }
  | undefined;
if (typeof document === "undefined" && typeof process !== "undefined") {
  runSelfCheck();
  process.stdout.write("seat 自检通过\n");
}
