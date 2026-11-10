<script setup>
import { onMounted, onUnmounted, ref } from "vue";

// The three commands every visitor will run, verbatim from the quick start.
const segments = [
  {
    cmd: "bun create ignex my-api",
    out: [
      "✔ Scaffolded 31 files",
      "✔ Features: openapi, examples, tests",
      "✔ Git initialized",
      "→ cd my-api && bun install",
    ],
  },
  {
    cmd: "cd my-api && bun run dev",
    out: [
      "ℹ Compiling routes (5 found)…",
      "ℹ Native: native (castrum)",
      "ignex listening on https://localhost:3000",
      "[ignex] openapi: https://localhost:3000/openapi",
    ],
  },
  {
    cmd: "curl -k https://localhost:3000/hello",
    out: ['"Hello World"'],
  },
];

const lines = ref([]);
let timer = null;
let cancelled = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  while (!cancelled) {
    lines.value = [];
    await sleep(600);
    for (const seg of segments) {
      lines.value.push({ kind: "cmd", text: seg.cmd, typed: "" });
      const entry = lines.value[lines.value.length - 1];
      for (let i = 1; i <= seg.cmd.length; i++) {
        if (cancelled) return;
        entry.typed = seg.cmd.slice(0, i);
        await sleep(34);
      }
      await sleep(260);
      for (const out of seg.out) {
        if (cancelled) return;
        lines.value.push({ kind: "out", text: out });
        await sleep(130);
      }
      await sleep(1100);
    }
    await sleep(2600);
  }
}

onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    // Static render for reduced motion.
    for (const seg of segments) {
      lines.value.push({ kind: "cmd", text: seg.cmd, typed: seg.cmd });
      for (const out of seg.out) lines.value.push({ kind: "out", text: out });
    }
    return;
  }
  run();
});

onUnmounted(() => {
  cancelled = true;
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <div class="ignex-terminal" aria-label="ignex quick start demo">
    <div v-for="(line, i) in lines" :key="i">
      <template v-if="line.kind === 'cmd'">
        <span class="t-prompt">➜ </span>
        <span class="t-cmd">{{ line.typed }}</span><span v-if="line.typed.length < line.text.length" class="t-accent">▋</span>
      </template>
      <span v-else :class="line.text.startsWith('✔') ? 't-ok' : line.text.startsWith('ignex listening') || line.text.startsWith('[ignex]') ? 't-accent' : 't-out'">{{ line.text }}</span>
    </div>
  </div>
</template>
