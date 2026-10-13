<script setup lang="ts">
// 轮播外壳：左右箭头夹着内容，上面一行显示「第 i / N 次」。
//
// total <= 1 时**直接渲染插槽本身、不套任何包裹元素**——单张座位图的场景要在 DOM 上与
// 改动前逐字一致，不能只是「看起来一样」。
//
// 调用方需保证 index ∈ [0, total)；组件内部再钳一层兜底，避免越界时显示「第 5 / 3 次」。
import { computed } from "vue";
import { ChevronLeft, ChevronRight, TriangleAlert } from "lucide-vue-next";

const props = withDefaults(
  defineProps<{ index: number; total: number; warn?: boolean }>(),
  { warn: false },
);
const emit = defineEmits<{ change: [index: number] }>();

const multi = computed(() => props.total > 1);
/** 越界不抛错、按边界钳住：宁可显示首/末页，也不要出现「第 5 / 3 次」这种标题 */
const pos = computed(() =>
  props.total > 0 ? Math.min(Math.max(props.index, 0), props.total - 1) : 0,
);
const atStart = computed(() => pos.value <= 0);
const atEnd = computed(() => pos.value >= props.total - 1);

function go(step: number) {
  const next = pos.value + step;
  if (next < 0 || next > props.total - 1) return;
  emit("change", next);
}

const ARROW =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-panel text-text transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-text";
</script>

<template>
  <!-- 单张：原样透出插槽，DOM 上不多一层 -->
  <slot v-if="!multi" />
  <div v-else class="flex flex-col gap-2">
    <div class="flex items-center justify-center gap-2 text-xs text-muted">
      <span>第 {{ pos + 1 }} / {{ total }} 次</span>
      <span v-if="warn" class="flex items-center gap-1 text-red-500">
        <TriangleAlert :size="12" />
        有学生没拆开
      </span>
    </div>
    <div class="flex items-center gap-3">
      <button
        :class="ARROW"
        :disabled="atStart"
        aria-label="上一次座位"
        title="上一次"
        @click="go(-1)"
      >
        <ChevronLeft :size="17" />
      </button>
      <div class="min-w-0 flex-1">
        <slot />
      </div>
      <button
        :class="ARROW"
        :disabled="atEnd"
        aria-label="下一次座位"
        title="下一次"
        @click="go(1)"
      >
        <ChevronRight :size="17" />
      </button>
    </div>
  </div>
</template>
