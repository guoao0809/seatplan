<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, X } from "lucide-vue-next";

const win = getCurrentWindow();
</script>

<template>
  <div class="flex h-9 shrink-0 select-none items-center bg-[#1F2329]">
    <span data-tauri-drag-region class="flex-1 pl-3 text-xs text-gray-300"
      >教室排座</span
    >
    <div class="flex h-full shrink-0">
      <button
        class="flex h-full w-11 items-center justify-center text-gray-400 hover:bg-white/10 hover:text-white"
        title="最小化"
        @click="win.minimize()"
      >
        <Minus :size="14" />
      </button>
      <button
        class="flex h-full w-11 items-center justify-center text-gray-400 hover:bg-red-500 hover:text-white"
        title="关闭"
        @click="win.close()"
      >
        <X :size="14" />
      </button>
    </div>
  </div>
</template>
