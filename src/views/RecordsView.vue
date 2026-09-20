<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Trash2, Copy, RotateCcw, History } from "lucide-vue-next";
import { loadRecords, saveRecords, type SeatRecord, type RestorePayload } from "../lib/records";
import { showToast } from "../components/toast";

const emit = defineEmits<{ restore: [payload: RestorePayload] }>();

const records = ref<SeatRecord[]>([]);

onMounted(() => {
  records.value = loadRecords();
});

function persist() {
  saveRecords(records.value);
}
function remove(id: string) {
  records.value = records.value.filter((r) => r.id !== id);
  persist();
}
/** 回显该记录到排座页 */
function restore(r: SeatRecord) {
  emit("restore", {
    rows: r.rows,
    colors: r.colors,
    seatsPerRow: r.seatsPerRow,
    singleSeatName: r.singleSeatName,
    grid: r.grid,
  });
}
async function copyJson(r: SeatRecord) {
  try {
    await navigator.clipboard.writeText(JSON.stringify(r.grid, null, 2));
    showToast("已复制座位 JSON", "success");
  } catch {
    showToast("复制失败", "error");
  }
}
function fmt(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <div class="h-full overflow-y-auto bg-surface p-6">
    <div class="mx-auto max-w-3xl">
      <h2 class="mb-4 text-base font-medium text-title">历史分座（{{ records.length }}）</h2>

      <div
        v-if="records.length === 0"
        class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-panel py-16 text-sm text-muted"
      >
        <History :size="28" />
        暂无分座记录，去排座页导出即可保存 JSON
      </div>

      <div
        v-for="r in records"
        :key="r.id"
        class="mb-3 flex items-start justify-between gap-4 rounded-xl border border-border bg-panel p-4"
      >
        <div class="min-w-0">
          <div class="text-sm text-title">导出时间：{{ fmt(r.exportedAt) }}</div>
          <div class="mt-1 text-xs text-muted">
            共 {{ r.rows.length }} 组 / 每排 {{ r.seatsPerRow }} 座 / 单座：{{ r.singleSeatName || "—" }}
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap justify-end gap-2">
          <button
            class="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:opacity-90"
            @click="restore(r)"
          >
            <RotateCcw :size="14" />
            回显
          </button>
          <button
            class="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-text hover:border-primary hover:text-primary"
            @click="copyJson(r)"
          >
            <Copy :size="14" />
            JSON
          </button>
          <button
            class="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-red-500 hover:border-red-400 hover:bg-red-50"
            @click="remove(r.id)"
          >
            <Trash2 :size="14" />
            删除
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
