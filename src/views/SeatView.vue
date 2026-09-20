<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import {
  ClipboardList,
  Eraser,
  Settings,
  X,
  Download,
  ArrowUpDown,
  Presentation,
  GraduationCap,
  Sparkles,
  LoaderCircle,
} from "lucide-vue-next";
import { toPng } from "html-to-image";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_ROSTER,
  DEFAULT_ROWS_PER_GROUP,
  DEFAULT_SEATS_PER_ROW,
  assignSeats,
  parseRoster,
  parseRows,
  runSelfCheck,
  groupLabel,
  type Group,
} from "../lib/seat";
import { loadRecords, saveRecords, type SeatRecord, type RestorePayload } from "../lib/records";
import {
  loadAiConfig,
  arrangeSeats,
  buildMessages,
  parseArrangement,
  flattenNames,
  appendFollowUp,
  runAiSelfCheck,
  type AiConfig,
  type ChatMessage,
  type Grid,
} from "../lib/ai";
import { showToast } from "../components/toast";

const props = defineProps<{ restore: RestorePayload | null }>();

const LS_ROSTER = "seatplan:roster";
const LS_CFG = "seatplan:cfg";
const LS_GRID = "seatplan:grid";

// 名单文本与配置
const rosterText = ref(DEFAULT_ROSTER.join("\n"));
const seatsPerRow = ref(DEFAULT_SEATS_PER_ROW);
const rowsText = ref(DEFAULT_ROWS_PER_GROUP.join(","));
const singleSeatName = ref("");
// 组号从右往左数（最右为第一组）
const reverseGroups = ref(false);
// 视角：false=学生视角（讲台在左上），true=老师视角（讲台在正下方）
const teacherView = ref(false);

// 弹窗开关（名单 / 配置）
const showRoster = ref(false);
const showConfig = ref(false);

// AI 排座
const showAi = ref(false);
const aiPrompt = ref("根据上一次排的座位，自动左右调整，保证每个孩子都公平");
const aiBusy = ref(false);
// 单调递增的请求 id：closeAi 时 bump 作废在途请求，替代「弹窗是否还开着」这个不可靠代理
let aiReqId = 0;
const aiError = ref("");
// 配置读取状态：loading=读取中 ok=已载入 fail=读取失败（失败时错误详情在下方红框里）
const aiConfigStatus = ref<"loading" | "ok" | "fail">("loading");
const aiConfig = ref<AiConfig | null>(null);
const aiPreview = ref<(string | null)[][][] | null>(null);
/** 模型给出的「为什么这么排」 */
const aiReason = ref("");
/** 模型给出的操作翻成人话，供用户核对（如「交换 第四组第7排第1座 与 …」） */
const aiSummary = ref("");
/** 追问输入框 */
const aiFollowUp = ref("");
/** 本轮对话（首轮 system+user，追问依次追加 assistant+user） */
const aiMessages = ref<ChatMessage[]>([]);
/** 上一轮模型原始返回，追问时作为 assistant 消息回灌 */
const aiLastRaw = ref("");

const aiPreviewNames = computed(() =>
  aiPreview.value ? flattenNames(aiPreview.value).length : 0,
);

/** 当前网格的纯数据快照（组 → 排 → 座 → 姓名或 null） */
function currentGrid(): (string | null)[][][] {
  return seatGrid.value.map((g) => g.rows.map((r) => r.seats.map((s) => s.name)));
}

const nameCount = computed(() => parseRoster(rosterText.value).length);
const rows = computed(() => parseRows(rowsText.value));
const seatCount = computed(() => Math.max(1, Number(seatsPerRow.value) || 1));
const capacity = computed(() => rows.value.reduce((n, r) => n + r) * seatCount.value);
const groupCount = computed(() => rows.value.length);

// 可拖拽的座位网格：名单+配置是种子，拖拽可交换座位姓名
const seatGrid = ref<Group[]>([]);
interface DragPos {
  g: number;
  r: number;
  s: number;
}
const dragFrom = ref<DragPos | null>(null);
const dragOverKey = ref<string | null>(null);
const dragging = ref(false);
const dragName = ref<string | null>(null);
const ghost = ref<{ x: number; y: number } | null>(null);
const seatChartRef = ref<HTMLElement | null>(null);
// 刚交换过的两个座位 key，用于播放换座动画
const swapKeys = ref<string[]>([]);
let swapTimer: ReturnType<typeof setTimeout> | undefined;

const seatKey = (g: number, r: number, s: number) => `${g}-${r}-${s}`;

/** 该座位正被拖拽（名字已被拎起）：拖拽期间换个底色，松手换座后自动恢复 */
function isDragSource(g: number, r: number, s: number) {
  const d = dragFrom.value;
  return !!d && d.g === g && d.r === r && d.s === s;
}

function persistGrid() {
  localStorage.setItem(
    LS_GRID,
    JSON.stringify(seatGrid.value.map((g) => g.rows.map((row) => row.seats.map((s) => s.name)))),
  );
}
function seedGrid() {
  seatGrid.value = assignSeats(
    parseRoster(rosterText.value),
    rows.value,
    seatCount.value,
    reverseGroups.value,
  );
  persistGrid();
}
/** 用上次持久化的网格覆盖（保留拖拽结果） */
function applySavedGrid() {
  const raw = localStorage.getItem(LS_GRID);
  if (!raw) return;
  try {
    const names = JSON.parse(raw) as (string | null)[][][];
    if (Array.isArray(names)) {
      seatGrid.value = names.map((rowArr, gi) => ({
        label: groupLabel(gi, names.length, reverseGroups.value),
        rows: rowArr.map((r) => ({ seats: r.map((n) => ({ name: n })) })),
      }));
      persistGrid();
    }
  } catch {
    /* 网格损坏则忽略，沿用种子 */
  }
}

// 指针(mouse)拖拽换座：兼容 Tauri WebView2，改用 pointer 事件而非 HTML5 drag 事件
function onSeatPointerDown(e: PointerEvent, g: number, r: number, s: number) {
  if (e.button !== 0) return; // 仅左键
  dragFrom.value = { g, r, s };
  dragName.value = seatGrid.value[g]!.rows[r]!.seats[s]!.name;
  ghost.value = { x: e.clientX, y: e.clientY };
  dragging.value = true;
  e.preventDefault(); // 防止拖动时选中文本
}
function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return;
  ghost.value = { x: e.clientX, y: e.clientY };
  const pos = document
    .elementFromPoint(e.clientX, e.clientY)
    ?.closest?.("[data-seat]")
    ?.getAttribute("data-seat");
  dragOverKey.value = pos || null;
}
function onPointerUp() {
  if (!dragging.value) return;
  const from = dragFrom.value;
  const target = dragOverKey.value;
  dragging.value = false;
  dragFrom.value = null;
  dragOverKey.value = null;
  ghost.value = null;
  dragName.value = null;
  if (!from || !target) return;
  const [g, r, s] = target.split("-").map(Number);
  if (g === from.g && r === from.r && s === from.s) return;
  const a = seatGrid.value[from.g]!.rows[from.r]!.seats[from.s]!;
  const b = seatGrid.value[g]!.rows[r]!.seats[s]!;
  const t = a.name;
  a.name = b.name;
  b.name = t;
  persistGrid();
  playSwap(seatKey(from.g, from.r, from.s), target);
}

/** 给刚交换的两个座位播放一次换座动画（先清后设，保证连续换座能重放） */
function playSwap(k1: string, k2: string) {
  swapKeys.value = [];
  clearTimeout(swapTimer);
  requestAnimationFrame(() => {
    swapKeys.value = [k1, k2];
    swapTimer = setTimeout(() => (swapKeys.value = []), 500);
  });
}

/** 切换组号计数方向：只改标签，座位与人都不动 */
function toggleReverseGroups() {
  reverseGroups.value = !reverseGroups.value;
  const total = seatGrid.value.length;
  seatGrid.value.forEach((g, gi) => (g.label = groupLabel(gi, total, reverseGroups.value)));
  showToast(reverseGroups.value ? "组号已从左往右数" : "组号已从右往左数", "success");
}

/** 打开 AI 弹窗并读取配置 */
async function openAi() {
  aiError.value = "";
  resetAiRun();
  aiConfigStatus.value = "loading";
  aiConfig.value = null;
  showAi.value = true;
  try {
    const loaded = await loadAiConfig();
    aiConfig.value = loaded.config;
    aiConfigStatus.value = "ok";
  } catch (e) {
    aiConfigStatus.value = "fail";
    aiError.value = String(e);
  }
}

function closeAi() {
  aiReqId++; // 作废在途请求：其结果/错误不再回写
  aiBusy.value = false; // 工具条立即恢复可用
  showAi.value = false;
  resetAiRun();
}

/** 清空一次排座的全部中间状态（预览、理由、对话、追问框） */
function resetAiRun() {
  aiPreview.value = null;
  aiReason.value = "";
  aiSummary.value = "";
  aiError.value = "";
  aiFollowUp.value = "";
  aiMessages.value = [];
  aiLastRaw.value = "";
}

/** 发一次请求并执行模型给出的操作。msgs 为本轮完整对话，baseGrid 为本轮操作的基准网格。 */
async function callAi(msgs: ChatMessage[], baseGrid: Grid, labels: string[]): Promise<void> {
  const cfg = aiConfig.value;
  if (!cfg) return;
  const id = ++aiReqId;
  aiBusy.value = true;
  aiError.value = "";
  try {
    const text = await arrangeSeats(cfg, msgs);
    if (id !== aiReqId) return; // 请求已被 closeAi 作废：丢弃迟到结果，不动 aiBusy
    const res = parseArrangement(text, baseGrid, labels);
    if (!res.ok) {
      aiError.value = `校验未通过：${res.error}\n\n模型原始返回：\n${text}`;
      return;
    }
    aiMessages.value = msgs;
    aiLastRaw.value = text;
    aiPreview.value = res.grid;
    aiReason.value = res.reason;
    aiSummary.value = res.summary;
  } catch (e) {
    if (id !== aiReqId) return; // 已作废的迟到错误不回写
    aiError.value = String(e);
  } finally {
    if (id === aiReqId) aiBusy.value = false; // 只清自己的请求，别清后来者的
  }
}

/** 组名按屏幕显示顺序取——开了「组号反向」时 seatGrid[0] 的标签不是「第一组」 */
function currentLabels(): string[] {
  return seatGrid.value.map((g) => g.label);
}

/** 首次排座：用当前座位图与提示词开一轮新对话 */
async function runAi() {
  if (aiBusy.value) return; // 重入保险：防止未来新增触发点导致并发请求
  if (nameCount.value === 0) {
    aiError.value = "没有学生，无法排座";
    return;
  }
  if (!aiConfig.value) {
    aiError.value = "配置未加载，请检查 config.json";
    return;
  }
  const grid = currentGrid();
  const labels = currentLabels();
  const { system, user } = buildMessages({
    grid,
    labels,
    singleSeatName: singleSeatName.value,
    history: loadRecords()
      .slice(0, 2)
      .map((r) => r.grid),
    instruction: aiPrompt.value.trim(),
  });
  await callAi(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    grid,
    labels,
  );
}

/** 追问：以「当前预览」为基准重建 payload（模型才知道现在的状态），再接进对话 */
async function runFollowUp() {
  if (aiBusy.value) return;
  const text = aiFollowUp.value.trim();
  const baseGrid = aiPreview.value;
  if (!text || !aiLastRaw.value || !baseGrid) return;
  const labels = currentLabels();
  const { user } = buildMessages({
    grid: baseGrid,
    labels,
    singleSeatName: singleSeatName.value,
    history: [],
    instruction: text,
  });
  await callAi(appendFollowUp(aiMessages.value, aiLastRaw.value, user), baseGrid, labels);
  if (!aiError.value) aiFollowUp.value = "";
}

/** 把预览结果写入座位图并持久化 */
function applyAi() {
  const g = aiPreview.value;
  if (!g) return;
  seatGrid.value = g.map((rowsArr, gi) => ({
    label: groupLabel(gi, g.length, reverseGroups.value),
    rows: rowsArr.map((r) => ({ seats: r.map((n) => ({ name: n })) })),
  }));
  persistGrid();
  showAi.value = false;
  resetAiRun();
  showToast("已应用 AI 排座结果", "success");
}

/** 切换学生/老师视角：老师视角下讲台在学生后方（正下方） */
function setView(teacher: boolean) {
  if (teacherView.value === teacher) return;
  teacherView.value = teacher;
  showToast(teacher ? "已切换为老师视角" : "已切换为学生视角", "success");
}

function fillSample() {
  rosterText.value = DEFAULT_ROSTER.join("\n");
  showToast("已填入示例名单", "success");
}
function clearAll() {
  rosterText.value = "";
  showToast("已清空名单", "info");
}

/** 把某条记录回显到排座页：恢复网格与配置（不依赖名单种子） */
function applyRestore(p: RestorePayload) {
  const flat = p.grid.flatMap((rows) => rows.flatMap((s) => s));
  rosterText.value = flat.filter((n) => n !== null).join("\n");
  seatsPerRow.value = p.seatsPerRow;
  rowsText.value = p.rows.join(",");
  singleSeatName.value = p.singleSeatName || "";
  seatGrid.value = p.grid.map((rowArr, gi) => ({
    label: groupLabel(gi, p.grid.length, reverseGroups.value),
    rows: rowArr.map((r) => ({ seats: r.map((n) => ({ name: n })) })),
  }));
  persistGrid();
}

/** dataURL(base64) → 字节数组 */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const bin = atob(dataUrl.split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 导出当前座位图为 PNG（弹「另存为」保存到本地），并把座位 JSON 存入历史记录（不存图片） */
async function exportImage() {
  const node = seatChartRef.value;
  if (!node) return;
  if (nameCount.value === 0) {
    showToast("没有学生，无法导出", "error");
    return;
  }
  try {
    // 只截这张卡片本身。两个坑：
    // 1. scrollWidth 而非默认的 clientWidth——元素盒子被容器夹住时 clientWidth 偏小；
    // 2. margin 清零——克隆节点会带上 mx-auto 算出的实际外边距（apply-style 只覆盖
    //    options.style，不清 margin），导致内容在画布上整体右移、右侧被裁掉。
    const dataUrl = await toPng(node, {
      pixelRatio: 2,
      backgroundColor: "#ffffff",
      width: node.scrollWidth,
      height: node.scrollHeight,
      style: { margin: "0" },
    });
    // 文件名带 5 位随机数，避免同一天多次导出时重名
    const rand5 = Math.floor(Math.random() * 90000) + 10000;
    // 系统「另存为」对话框：让用户选本地路径
    const path = await save({
      title: "保存座位图",
      defaultPath: `座位图-${new Date().toISOString().slice(0, 10)}-${rand5}.png`,
      filters: [{ name: "PNG 图片", extensions: ["png"] }],
    });
    if (!path) return; // 用户取消

    await invoke("save_png", { path, data: Array.from(dataUrlToBytes(dataUrl)) });

    const rec: SeatRecord = {
      id: `rec-${Date.now()}`,
      exportedAt: Date.now(),
      rows: rows.value,
      seatsPerRow: seatCount.value,
      singleSeatName: singleSeatName.value,
      grid: seatGrid.value.map((g) => g.rows.map((row) => row.seats.map((s) => s.name))),
    };
    const ok = saveRecords([rec, ...loadRecords()]);
    showToast(
      `已保存到：${path}` + (ok ? "" : "（记录保存失败：本地存储容量不足）"),
      ok ? "success" : "info",
    );
  } catch (e) {
    showToast(`导出失败：${e}`, "error");
  }
}

// 名单/配置变化时重铺网格；拖拽只改网格、不触发重铺
// suppressSeed：挂载/回显期间为 true，避免名称或配置赋值触发的监听覆盖已还原的网格
let suppressSeed = true;
watch([rosterText, rows, seatCount], () => {
  if (suppressSeed) return;
  seedGrid();
});

onMounted(() => {
  if (import.meta.env.DEV) {
    runSelfCheck();
    runAiSelfCheck();
  }
  const saved = localStorage.getItem(LS_ROSTER);
  if (saved != null) rosterText.value = saved;
  const cfg = localStorage.getItem(LS_CFG);
  if (cfg) {
    try {
      const c = JSON.parse(cfg);
      if (c.seatsPerRow) seatsPerRow.value = c.seatsPerRow;
      if (c.rowsText) rowsText.value = c.rowsText;
      if (typeof c.singleSeatName === "string") singleSeatName.value = c.singleSeatName;
      if (typeof c.reverseGroups === "boolean") reverseGroups.value = c.reverseGroups;
      if (typeof c.teacherView === "boolean") teacherView.value = c.teacherView;
    } catch {
      /* 配置损坏则忽略，用默认 */
    }
  }
  if (props.restore) {
    applyRestore(props.restore);
  } else {
    seedGrid();
    applySavedGrid();
  }
  // 等挂载期的监听批次跑完后再放行实时重铺（避免覆盖已还原的网格）
  setTimeout(() => {
    suppressSeed = false;
  }, 0);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
});

onBeforeUnmount(() => {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
});

watch([rosterText, seatsPerRow, rowsText, singleSeatName, teacherView], () => {
  localStorage.setItem(LS_ROSTER, rosterText.value);
  localStorage.setItem(
    LS_CFG,
    JSON.stringify({
      seatsPerRow: seatsPerRow.value,
      rowsText: rowsText.value,
      singleSeatName: singleSeatName.value,
      reverseGroups: reverseGroups.value,
      teacherView: teacherView.value,
    }),
  );
});
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 顶部工具条 -->
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-panel px-4 py-2">
      <button
        class="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text hover:border-primary hover:text-primary"
        @click="showRoster = true"
      >
        <ClipboardList :size="14" />
        学生名单
      </button>
      <button
        class="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text hover:border-primary hover:text-primary"
        @click="showConfig = true"
      >
        <Settings :size="14" />
        配置
      </button>
      <!-- 视角切换：学生 / 老师两个选项，当前生效的高亮 -->
      <div class="flex items-center gap-1 rounded-lg border border-border p-0.5">
        <button
          class="flex items-center gap-1.5 rounded-md px-3 py-1 text-xs transition-colors"
          :class="!teacherView ? 'bg-primary text-white' : 'text-text hover:text-primary'"
          @click="setView(false)"
        >
          <GraduationCap :size="14" />
          学生视角
        </button>
        <button
          class="flex items-center gap-1.5 rounded-md px-3 py-1 text-xs transition-colors"
          :class="teacherView ? 'bg-primary text-white' : 'text-text hover:text-primary'"
          @click="setView(true)"
        >
          <Presentation :size="14" />
          老师视角
        </button>
      </div>
      <button
        class="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text hover:border-primary hover:text-primary"
        @click="toggleReverseGroups"
      >
        <ArrowUpDown :size="14" />
        组号反向
      </button>
      <button
        class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:opacity-90"
        @click="exportImage"
      >
        <Download :size="14" />
        导出图片
      </button>
      <button
        class="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text hover:border-primary hover:text-primary"
        @click="openAi"
      >
        <Sparkles :size="14" />
        AI 排座
      </button>
      <span class="ml-auto text-xs text-muted"
        >共 {{ groupCount }} 组 / {{ nameCount }} 人 / 容量 {{ capacity }} 座</span
      >
    </div>

    <!-- 座位图 -->
    <div class="min-h-0 flex-1 overflow-auto bg-surface p-6">
      <!-- w-max 不能用 w-fit：fit-content 会被容器宽度夹住，座位溢出到元素盒子外，
           html-to-image 按 clientWidth 量尺寸就会把右侧裁掉 -->
      <div ref="seatChartRef" class="mx-auto w-max rounded-xl bg-white p-8 shadow">
        <div class="flex flex-col items-start gap-8">
          <!-- 前排：讲台（左侧）+ 右侧单独座位。老师视角下讲台转到右下角，单座同时换到讲台左侧 -->
          <div
            class="flex items-stretch gap-6"
            :class="teacherView ? 'order-2 self-end flex-row-reverse' : ''"
          >
            <div
              class="flex h-16 w-44 shrink-0 items-center justify-center rounded-lg bg-[#6B4423] shadow"
            >
              <div class="text-sm font-semibold tracking-widest text-[#F5E7D0]">讲 台</div>
            </div>
            <div
              title="单独座位"
              class="flex h-16 w-24 shrink-0 items-center justify-center rounded-lg bg-[#5B9BD5] text-sm font-medium text-white"
            >
              {{ singleSeatName || "单座" }}
            </div>
          </div>

          <!-- 组：讲台右后方，纵向排列。老师视角下整个座位区旋转 180°（前后排、左右组序一起翻，讲台沉到下方） -->
          <div
            class="flex items-start gap-10"
            :class="teacherView ? 'order-1 rotate-180' : ''"
          >
            <div v-for="(g, gi) in seatGrid" :key="gi" class="flex flex-col items-center gap-2">
              <!-- 组标签：跟着容器转回来，文字保持正立 -->
              <div class="text-xs font-medium text-muted" :class="{ 'rotate-180': teacherView }">
                {{ g.label }}（{{ g.rows.length }}排）
              </div>
              <div class="flex flex-col gap-2">
                <div v-for="(row, ri) in g.rows" :key="ri" class="flex gap-2">
                  <div
                    v-for="(seat, si) in row.seats"
                    :key="si"
                    :data-seat="seatKey(gi, ri, si)"
                    :class="[
                      isDragSource(gi, ri, si)
                        ? 'bg-[#4E7A3A] text-white opacity-60'
                        : seat.name
                          ? 'bg-[#86C166] text-white'
                          : 'bg-surface border border-dashed border-border text-muted',
                      dragOverKey === seatKey(gi, ri, si) ? 'ring-2 ring-primary' : '',
                      teacherView ? 'rotate-180' : '',
                      swapKeys.includes(seatKey(gi, ri, si)) ? 'seat-swapping' : '',
                    ]"
                    class="flex h-14 w-24 cursor-grab select-none items-center justify-center rounded-lg text-sm font-medium"
                    @pointerdown="onSeatPointerDown($event, gi, ri, si)"
                  >
                    {{ seat.name || "—" }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 空态：无名单 -->
      <div
        v-if="nameCount === 0"
        class="flex flex-col items-center gap-3 py-16 text-sm text-muted"
      >
        暂无学生名单
        <button
          class="rounded-lg bg-primary px-4 py-1.5 text-xs text-white hover:opacity-90"
          @click="showRoster = true"
        >
          去填写名单
        </button>
      </div>
    </div>

    <!-- 拖拽跟手幽灵：尺寸/文字与座位格一致，拖起来像把座位整个拎走 -->
    <div
      v-if="ghost && dragName"
      class="pointer-events-none fixed z-50 flex h-14 w-24 items-center justify-center rounded-lg bg-[#86C166] text-sm font-medium text-white shadow-lg"
      :style="{ left: `${ghost.x}px`, top: `${ghost.y}px`, transform: 'translate(-50%, -50%)' }"
    >
      {{ dragName }}
    </div>

    <!-- 学生名单弹窗 -->
    <div
      v-if="showRoster"
      class="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      @click.self="showRoster = false"
    >
      <div class="flex w-105 flex-col rounded-xl bg-panel shadow-2xl">
        <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
          <span class="text-sm font-medium text-title">学生名单（{{ nameCount }} 人）</span>
          <button
            class="rounded p-1 text-muted hover:bg-surface hover:text-title"
            @click="showRoster = false"
          >
            <X :size="16" />
          </button>
        </div>
        <div class="flex flex-col p-5">
          <textarea
            v-model="rosterText"
            rows="12"
            placeholder="每行一个姓名，或用逗号分隔…"
            class="h-64 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-title outline-none focus:border-primary"
          ></textarea>
        </div>
        <div class="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            class="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-text hover:border-primary hover:text-primary"
            @click="clearAll"
          >
            <Eraser :size="14" />
            清空
          </button>
          <button
            class="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-text hover:border-primary hover:text-primary"
            @click="fillSample"
          >
            填入示例
          </button>
          <button
            class="rounded-lg bg-primary px-4 py-1.5 text-xs text-white hover:opacity-90"
            @click="showRoster = false"
          >
            完成
          </button>
        </div>
      </div>
    </div>

    <!-- 配置弹窗 -->
    <div
      v-if="showConfig"
      class="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      @click.self="showConfig = false"
    >
      <div class="flex w-90 flex-col rounded-xl bg-panel shadow-2xl">
        <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
          <span class="text-sm font-medium text-title">配置</span>
          <button
            class="rounded p-1 text-muted hover:bg-surface hover:text-title"
            @click="showConfig = false"
          >
            <X :size="16" />
          </button>
        </div>
        <div class="flex flex-col gap-4 p-5">
          <div>
            <label class="text-xs text-text">每排座位数</label>
            <input
              v-model.number="seatsPerRow"
              type="number"
              min="1"
              class="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-title outline-none focus:border-primary"
            />
          </div>
          <div>
            <label class="text-xs text-text">每组排数（逗号分隔）</label>
            <input
              v-model="rowsText"
              placeholder="7,7,8,8"
              class="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-title outline-none focus:border-primary"
            />
          </div>
          <div>
            <label class="text-xs text-text">单座学生姓名</label>
            <input
              v-model="singleSeatName"
              placeholder="该单独座位上的学生"
              class="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-title outline-none focus:border-primary"
            />
          </div>
          <p class="text-xs leading-relaxed text-muted">
            共 {{ groupCount }} 组 / 每排 {{ seatCount }} 座 / 容量 {{ capacity }} 座
          </p>
        </div>
        <div class="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            class="rounded-lg bg-primary px-4 py-1.5 text-xs text-white hover:opacity-90"
            @click="showConfig = false"
          >
            完成
          </button>
        </div>
      </div>
    </div>

    <!-- AI 排座弹窗：输入态 → 预览态 → 应用 -->
    <div
      v-if="showAi"
      class="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      @click.self="closeAi"
    >
      <div
        class="flex max-h-[88vh] w-[94vw] flex-col rounded-xl bg-panel shadow-2xl"
        :class="aiPreview ? 'max-w-280' : 'max-w-140'"
      >
        <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
          <span class="text-sm font-medium text-title">
            {{ aiPreview ? "AI 排座结果预览" : "AI 排座" }}
          </span>
          <button
            class="rounded p-1 text-muted hover:bg-surface hover:text-title"
            @click="closeAi"
          >
            <X :size="16" />
          </button>
        </div>

        <!-- 输入态 -->
        <div v-if="!aiPreview" class="flex min-h-0 flex-col gap-3 overflow-y-auto p-5">
          <textarea
            v-model="aiPrompt"
            rows="5"
            placeholder="描述你想要的排座方式…"
            :disabled="aiBusy"
            class="h-32 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-title outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
          ></textarea>
          <div class="flex items-center gap-2 text-xs text-muted">
            <template v-if="aiConfigStatus === 'fail'">配置读取失败，见下方错误</template>
            <template v-else-if="aiConfigStatus === 'loading'">正在读取配置…</template>
            <!-- <button
              class="rounded border border-border px-2 py-0.5 hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-current"
              :disabled="aiBusy"
              @click="openAi"
            >
              重新读取
            </button> -->
          </div>
          <div
            v-if="aiError"
            class="max-h-56 overflow-y-auto rounded-lg bg-red-50 p-3 text-xs leading-relaxed whitespace-pre-wrap text-red-600"
          >
            {{ aiError }}
          </div>
        </div>

        <!-- 预览态：左座位图（老师视角下与主图一致整块旋转），右「为什么这么排」 -->
        <div v-else class="flex min-h-0 flex-1 gap-5 overflow-hidden p-5">
          <div class="min-w-0 shrink-0 overflow-auto">
            <div class="flex items-start gap-6" :class="teacherView ? 'rotate-180' : ''">
              <div v-for="(g, gi) in aiPreview" :key="gi" class="flex flex-col items-center gap-1.5">
                <div class="text-xs font-medium text-muted" :class="{ 'rotate-180': teacherView }">
                  {{ groupLabel(gi, aiPreview.length, reverseGroups) }}
                </div>
                <div class="flex flex-col gap-1.5">
                  <div v-for="(row, ri) in g" :key="ri" class="flex gap-1.5">
                    <div
                      v-for="(name, si) in row"
                      :key="si"
                      class="flex h-9 w-16 items-center justify-center rounded-md text-xs font-medium"
                      :class="[
                        name
                          ? 'bg-[#86C166] text-white'
                          : 'bg-surface border border-dashed border-border text-muted',
                        teacherView ? 'rotate-180' : '',
                      ]"
                    >
                      {{ name || "—" }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="mt-4 text-xs text-muted">
              共 {{ aiPreviewNames }} 人排入网格；单座：{{ singleSeatName || "—" }}（不参与调整）
            </div>
          </div>

          <div class="flex min-w-0 flex-1 flex-col gap-2 border-l border-border pl-5">
            <div class="text-xs font-medium text-title">将执行的操作</div>
            <div
              class="shrink-0 rounded-lg border border-border bg-panel p-2.5 text-xs leading-relaxed text-text"
            >
              {{ aiSummary || "（无）" }}
            </div>
            <div class="text-xs font-medium text-title">为什么这么排</div>
            <div
              class="min-h-0 flex-1 overflow-y-auto rounded-lg bg-surface p-3 text-xs leading-relaxed whitespace-pre-wrap text-text"
            >
              {{ aiReason || "（模型未给出说明）" }}
            </div>
            <div
              v-if="aiError"
              class="max-h-40 shrink-0 overflow-y-auto rounded-lg bg-red-50 p-3 text-xs leading-relaxed whitespace-pre-wrap text-red-600"
            >
              {{ aiError }}
            </div>
          </div>
        </div>

        <!-- 追问：接着上一轮继续提要求并重排 -->
        <div v-if="aiPreview" class="flex shrink-0 items-end gap-2 border-t border-border px-5 py-3">
          <textarea
            v-model="aiFollowUp"
            rows="2"
            placeholder="不满意？继续提要求后点重排，例如：第三组后排的同学换到前排"
            :disabled="aiBusy"
            class="h-16 min-w-0 flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-title outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
          ></textarea>
          <button
            class="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50"
            :disabled="aiBusy || !aiFollowUp.trim()"
            @click="runFollowUp"
          >
            <LoaderCircle v-if="aiBusy" :size="14" class="animate-spin" />
            {{ aiBusy ? "重排中…" : "重排" }}
          </button>
        </div>

        <div class="flex justify-end gap-2 border-t border-border px-5 py-3">
          <template v-if="!aiPreview">
            <button
              class="rounded-lg border border-border px-4 py-1.5 text-xs text-text hover:border-primary hover:text-primary"
              @click="closeAi"
            >
              取消
            </button>
            <button
              class="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50"
              :disabled="aiBusy || !aiPrompt.trim()"
              @click="runAi"
            >
              <LoaderCircle v-if="aiBusy" :size="14" class="animate-spin" />
              {{ aiBusy ? "排座中…" : "开始排座" }}
            </button>
          </template>
          <template v-else>
            <button
              class="rounded-lg border border-border px-4 py-1.5 text-xs text-text hover:border-primary hover:text-primary"
              @click="resetAiRun"
            >
              返回修改
            </button>            <button
              class="rounded-lg bg-primary px-4 py-1.5 text-xs text-white hover:opacity-90"
              @click="applyAi"
            >
              应用到座位图
            </button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
