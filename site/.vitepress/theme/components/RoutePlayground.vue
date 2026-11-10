<script setup>
import { computed, ref } from "vue";

const filename = ref("products/[id].get.ts");

const examples = [
  "hello.get.ts",
  "index.get.ts",
  "products/[id].get.ts",
  "auth/login.post.ts",
  "files/[...path].get.ts",
];

const METHOD_LABEL = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", del: "DELETE" };
const SAMPLE_PARAM = { id: "42", name: "avatar.png", path: "img/logo.svg" };

const parsed = computed(() => {
  let name = filename.value.trim();
  // Accept a full path — anything after the last `routes/` segment is the file.
  const routesIdx = name.lastIndexOf("routes/");
  if (routesIdx >= 0) name = name.slice(routesIdx + "routes/".length);
  name = name.replace(/\.tsx?$/, "");
  if (!name || name.includes("#")) return { error: "Enter a route filename, like products/[id].get.ts" };

  let method = null;
  const m = name.match(/\.(get|post|put|patch|del)$/);
  if (m) {
    method = m[1];
    name = name.slice(0, -m[0].length);
  }

  const segments = name.split("/").filter(Boolean);
  if (segments.length === 0) return { error: "Enter a route filename, like products/[id].get.ts" };
  if (segments.some((s) => s !== "index" && !s)) return { error: "Invalid filename" };

  const params = [];
  const pathParts = [];
  let catchAll = null;
  for (const seg of segments) {
    if (seg === "index") continue;
    if (seg.startsWith("[...")) {
      catchAll = seg.slice(4, -1);
      pathParts.push(`*${catchAll}`);
      continue;
    }
    const dyn = seg.match(/^\[(.+)\]$/);
    if (dyn) {
      params.push(dyn[1]);
      pathParts.push(`:${dyn[1]}`);
    } else {
      pathParts.push(seg);
    }
  }

  return {
    method: method ?? "get",
    hasMethod: Boolean(m),
    path: "/" + pathParts.join("/"),
    params,
    catchAll,
  };
});

const methodClass = computed(() => `m-${parsed.value.method ?? "get"}`);
const methodLabel = computed(() => METHOD_LABEL[parsed.value.method ?? "get"] ?? "GET");

const sampleUrl = computed(() => {
  const p = parsed.value;
  if (!p.path) return "";
  let url = p.path;
  for (const param of p.params ?? []) url = url.replace(`:${param}`, SAMPLE_PARAM[param] ?? "123");
  if (p.catchAll) url = url.replace(`*${p.catchAll}`, SAMPLE_PARAM[path0(p.catchAll)] ?? "a/b.txt");
  return url;
});

const path0 = (name) => name.split("/")[0];
</script>

<template>
  <div class="ignex-demo">
    <p class="ignex-demo-title">Route playground — type a route filename, see the route it becomes</p>
    <input
      v-model="filename"
      class="ignex-input"
      spellcheck="false"
      aria-label="Route filename"
      placeholder="products/[id].get.ts"
    />
    <p style="margin: 10px 0 0; font-size: 12.5px">
      <span v-for="ex in examples" :key="ex">
        <button class="ignex-tab" style="margin-right: 6px; font-family: var(--vp-font-family-mono)" @click="filename = ex">{{ ex }}</button>
      </span>
    </p>

    <div v-if="parsed.error" class="ignex-route-card">
      <div class="ignex-route-body">{{ parsed.error }}</div>
    </div>

    <div v-else class="ignex-route-card">
      <div class="ignex-route-card-head">
        <span class="ignex-method" :class="methodClass">{{ methodLabel }}</span>
        <span class="ignex-route-path">{{ parsed.path }}</span>
        <span class="ignex-badge" v-if="!parsed.hasMethod">auto: .get</span>
      </div>
      <div class="ignex-route-body">
        <div>
          📄 <code>src/routes/{{ filename.trim().replace(/^.*routes\//, "") }}</code> → <strong>{{ methodLabel }} {{ parsed.path }}</strong>
        </div>
        <div v-if="parsed.params.length">
          Path params: <code v-for="p in parsed.params" :key="p">{{ p }}</code>
        </div>
        <div v-else-if="!parsed.catchAll">No dynamic segments — a static route.</div>
        <div v-if="parsed.catchAll">
          Catch-all: <code>{{ parsed.catchAll }}</code> (every remaining segment, including slashes)
        </div>
        <div v-if="sampleUrl">Try: <code>{{ sampleUrl }}</code> → the compiler registers this in Bun's native routes table.</div>
      </div>
    </div>
  </div>
</template>
