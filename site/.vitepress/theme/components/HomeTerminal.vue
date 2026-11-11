<script setup>
import { onMounted, onUnmounted, ref } from "vue";

// The three commands every visitor will run, verbatim from the quick start.
const segments = [
  {
    cmd: "bun create ignex my-api",
    out: [
      { text: "✔ Scaffolded 31 files", kind: "ok" },
      { text: "✔ Features: openapi, examples, tests", kind: "ok" },
      { text: "✔ Git initialized", kind: "ok" },
      { text: "→ cd my-api && bun install", kind: "out" },
    ],
  },
  {
    cmd: "cd my-api && bun run dev",
    out: [
      { text: "ℹ Compiling routes (5 found)…", kind: "out" },
      { text: "ℹ Native: native (castrum)", kind: "out" },
      { text: "ignex listening on https://localhost:3000", kind: "accent" },
      { text: "[ignex] openapi: https://localhost:3000/openapi", kind: "accent" },
    ],
  },
  {
    cmd: "curl -k https://localhost:3000/hello",
    out: [{ text: '"Hello World"', kind: "ok" }],
  },
];

// Time-based pacing (ms). The rAF loop derives progress from elapsed time,
// so hiccups never produce stutter — the reveal simply catches up.
const MS_PER_CHAR = 26;
const MS_PER_LINE = 110;
const MS_BETWEEN = 240;
const MS_HOLD = 2400;
const MS_LOOP_GAP = 1800;

const lines = ref([]);
let timer = 0;
let running = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Drives one segment: types `cmd` over time, then reveals `out` lines.
// The ticker is setTimeout-based (NOT rAF): rAF never fires in a hidden
// tab, which would deadlock the whole loop. Reveal progress is derived
// from elapsed time, so coarse ticks in a throttled background tab only
// delay the reveal — foreground smoothness is unaffected.
async function playSegment(seg) {
  const entry = { kind: "cmd", cmd: seg.cmd, typed: 0 };
  lines.value.push(entry);

  await new Promise((resolve) => {
    const start = Date.now();
    const step = () => {
      const count = Math.min(seg.cmd.length, Math.floor((Date.now() - start) / MS_PER_CHAR));
      if (count !== entry.typed) {
        entry.typed = count;
        // Trigger a shallow reactive swap once per tick, not per char.
        lines.value = [...lines.value];
      }
      if (count >= seg.cmd.length) {
        resolve();
        return;
      }
      timer = setTimeout(step, 16);
    };
    timer = setTimeout(step, 16);
  });

  await sleep(MS_BETWEEN);
  for (const line of seg.out) {
    lines.value = [...lines.value, { kind: line.kind, text: line.text }];
    await sleep(MS_PER_LINE);
  }
}

async function run() {
  if (running) return;
  running = true;
  while (true) {
    lines.value = [];
    await sleep(500);
    for (const seg of segments) {
      await playSegment(seg);
      await sleep(MS_HOLD);
    }
    await sleep(MS_LOOP_GAP);
  }
}

onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    for (const seg of segments) {
      lines.value = [...lines.value, { kind: "cmd", cmd: seg.cmd, typed: seg.cmd.length }];
      for (const line of seg.out) {
        lines.value = [...lines.value, { kind: line.kind, text: line.text }];
      }
    }
    return;
  }
  run();
});

onUnmounted(() => {
  running = false;
  clearTimeout(timer);
});
</script>

<template>
  <div class="ignex-terminal" aria-label="ignex quick start demo">
    <div v-for="(line, i) in lines" :key="i" class="t-line">
      <template v-if="line.kind === 'cmd'">
        <span class="t-prompt">➜ </span><span class="t-cmd">{{ line.cmd.slice(0, line.typed) }}</span
        ><span v-if="line.typed < line.cmd.length" class="t-caret" />
      </template>
      <span v-else :class="line.kind === 'ok' ? 't-ok' : line.kind === 'accent' ? 't-accent' : 't-out'">{{ line.text }}</span>
    </div>
    <span v-if="lines.length === 0 || lines[lines.length - 1]?.kind !== 'cmd'" class="t-caret t-idle" />
  </div>
</template>
