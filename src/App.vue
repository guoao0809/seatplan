<script setup lang="ts">
import { ref } from "vue";
import TitleBar from "./components/TitleBar.vue";
import Toast from "./components/Toast.vue";
import LeftNav, { type ViewKey } from "./components/LeftNav.vue";
import SeatView from "./views/SeatView.vue";
import RecordsView from "./views/RecordsView.vue";
import type { RestorePayload } from "./lib/records";

const currentView = ref<ViewKey>("seat");
const restorePayload = ref<RestorePayload | null>(null);

// 左菜单切换：清掉待回显数据，避免误恢复到旧场景
function onNav(key: ViewKey) {
  restorePayload.value = null;
  currentView.value = key;
}
function onRestore(p: RestorePayload) {
  restorePayload.value = p;
  currentView.value = "seat";
}
</script>

<template>
  <div class="flex h-screen flex-col">
    <TitleBar />
    <div class="flex min-h-0 flex-1">
      <LeftNav :current="currentView" @change="onNav" />
      <main class="min-w-0 flex-1 bg-surface">
        <SeatView v-if="currentView === 'seat'" :restore="restorePayload" />
        <RecordsView v-else @restore="onRestore" />
      </main>
    </div>
    <Toast />
  </div>
</template>
