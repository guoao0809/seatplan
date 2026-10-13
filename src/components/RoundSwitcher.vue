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
