<script setup lang="ts">
// 轮换统计表：只报告不改座位。gap 非空的行标出来，方便一眼看出谁没轮到。
import type { FairnessRow } from "../lib/rotation";

defineProps<{ rows: FairnessRow[] }>();
</script>

<template>
  <div class="overflow-x-auto rounded-lg border border-border bg-panel">
    <div v-if="rows.length === 0" class="p-3 text-xs text-muted">还没有可统计的座位图</div>
    <table v-else class="w-full text-left text-xs">
      <thead class="border-b border-border text-muted">
        <tr>
          <th class="px-2.5 py-1.5 font-normal">姓名</th>
          <th class="px-2 py-1.5 text-center font-normal">前排</th>
          <th class="px-2 py-1.5 text-center font-normal">中排</th>
          <th class="px-2 py-1.5 text-center font-normal">后排</th>
          <th class="px-2 py-1.5 text-center font-normal">左</th>
          <th class="px-2 py-1.5 text-center font-normal">右</th>
          <th class="px-2.5 py-1.5 font-normal">提示</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(r, i) in rows"
          :key="`${i}-${r.name}`"
          class="border-b border-border last:border-0"
          :class="r.gaps.length ? 'bg-red-50' : ''"
        >
          <td class="px-2.5 py-1.5 text-title">{{ r.name }}</td>
          <td class="px-2 py-1.5 text-center text-text">{{ r.front }}</td>
          <td class="px-2 py-1.5 text-center text-text">{{ r.mid }}</td>
          <td class="px-2 py-1.5 text-center text-text">{{ r.back }}</td>
          <td class="px-2 py-1.5 text-center text-text">{{ r.left }}</td>
          <td class="px-2 py-1.5 text-center text-text">{{ r.right }}</td>
          <td class="px-2.5 py-1.5 text-red-500">{{ r.gaps.join("、") }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
