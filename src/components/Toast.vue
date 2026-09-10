<script setup lang="ts">
import { CircleCheck, CircleAlert, Info } from "lucide-vue-next";
import { toasts } from "./toast";

const styles: Record<string, string> = {
  success: "bg-white border-green-200",
  error: "bg-white border-red-200",
  info: "bg-white border-border",
};
const iconStyles: Record<string, string> = {
  success: "text-green-500",
  error: "text-red-500",
  info: "text-primary",
};
</script>

<template>
  <div class="pointer-events-none fixed right-0 top-20 z-50 flex flex-col gap-2">
    <div
      v-for="t in toasts"
      :key="t.id"
      class="flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm text-title shadow-lg"
      :class="styles[t.type]"
    >
      <CircleCheck v-if="t.type === 'success'" :size="16" :class="iconStyles[t.type]" />
      <CircleAlert v-else-if="t.type === 'error'" :size="16" :class="iconStyles[t.type]" />
      <Info v-else :size="16" :class="iconStyles[t.type]" />
      <span>{{ t.message }}</span>
    </div>
  </div>
</template>
