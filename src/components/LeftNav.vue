<script setup lang="ts">
import { LayoutGrid, History } from "lucide-vue-next";

export type ViewKey = "seat" | "records";

defineProps<{ current: ViewKey }>();
defineEmits<{ change: [key: ViewKey] }>();

const items: { key: ViewKey; label: string; icon: typeof LayoutGrid }[] = [
  { key: "seat", label: "排座", icon: LayoutGrid },
  { key: "records", label: "记录", icon: History },
];
</script>

<template>
  <nav class="flex w-16 shrink-0 flex-col items-center bg-[#1F2329] py-4">
    <button
      v-for="item in items"
      :key="item.key"
      :title="item.label"
      class="mb-1 flex h-11 w-11 items-center justify-center rounded-lg transition-colors"
      :class="
        current === item.key
          ? 'bg-primary text-white'
          : 'text-gray-400 hover:bg-white/10 hover:text-white'
      "
      @click="$emit('change', item.key)"
    >
      <component :is="item.icon" :size="20" />
    </button>
    <div class="mt-auto text-[10px] text-gray-600">v1.0</div>
  </nav>
</template>
