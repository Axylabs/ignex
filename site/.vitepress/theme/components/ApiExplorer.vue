<script setup>
import { withBase } from "vitepress";
import { computed, onMounted, ref } from "vue";

const spec = ref(null);
const error = ref(null);
const open = ref(null);
const tab = ref({});

const METHODS = ["get", "post", "put", "patch", "delete"];

onMounted(async () => {
  try {
    const res = await fetch(withBase("/demo/openapi.json"));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    spec.value = await res.json();
  } catch (e) {
    error.value = String(e);
  }
});

const endpoints = computed(() => {
  if (!spec.value?.paths) return [];
  const list = [];
  for (const [path, ops] of Object.entries(spec.value.paths)) {
    for (const method of METHODS) {
      const op = ops[method];
      if (!op) continue;
      list.push({
        key: `${method} ${path}`,
        method,
        path,
        tag: op.tags?.[0] ?? "api",
        summary: op.summary ?? op.description ?? "",
        params: (op.parameters ?? []).map((p) => ({
          name: p.name,
          in: p.in,
          required: Boolean(p.required),
          type: schemaToType(p.schema ?? {}),
        })),
        body: op.requestBody?.content?.["application/json"]?.schema ?? null,
        responses: Object.entries(op.responses ?? {}).map(([code, r]) => ({
          code,
          description: r.description ?? "",
          schema: r.content?.["application/json"]?.schema ?? null,
        })),
        security: Boolean(op.security),
      });
    }
  }
  return list;
});

const groups = computed(() => {
  const byTag = new Map();
  for (const ep of endpoints.value) {
    if (!byTag.has(ep.tag)) byTag.set(ep.tag, []);
    byTag.get(ep.tag).push(ep);
  }
  return [...byTag.entries()].map(([tag, eps]) => ({ tag, endpoints: eps }));
});

const baseUrl = computed(() => spec.value?.servers?.[0]?.url ?? "https://localhost:3000");

function toggle(key) {
  open.value = open.value === key ? null : key;
  tab.value = { [key]: "docs" };
}

function activeTab(key) {
  return tab.value[key] ?? "docs";
}

function setTab(key, name) {
  tab.value = { [key]: name };
}

function schemaToType(schema) {
  if (!schema || Object.keys(schema).length === 0) return "unknown";
  if (schema.type === "string") {
    if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
    return schema.format === "uuid"
      ? "string (uuid)"
      : schema.format
        ? `string (${schema.format})`
        : "string";
  }
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "array") return `${schemaToType(schema.items)}[]`;
  if (schema.type === "object" && schema.properties) {
    const inner = Object.entries(schema.properties)
      .map(([k, v]) => `${k}${schema.required?.includes(k) ? "" : "?"}: ${schemaToType(v)}`)
      .join(", ");
    return `{ ${inner} }`;
  }
  return schema.type ?? "unknown";
}

function sampleFromSchema(schema) {
  if (!schema) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.type === "string") {
    if (schema.format === "email") return "ada@example.com";
    if (schema.format === "uuid") return "0b9e6c1e-1f2a-4c3d-8e4f-5a6b7c8d9e0f";
    return schema.enum?.[0] ?? "string";
  }
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 1;
  if (schema.type === "boolean") return true;
  if (schema.type === "array") return [sampleFromSchema(schema.items)];
  if (schema.type === "object" && schema.properties) {
    const out = {};
    for (const [k, v] of Object.entries(schema.properties)) out[k] = sampleFromSchema(v);
    return out;
  }
  return null;
}

function buildCurl(ep) {
  let url = `${baseUrl.value}${ep.path}`;
  for (const p of ep.params.filter((p) => p.in === "path")) {
    url = url.replace(`{${p.name}}`, "42");
  }
  const parts = [`curl -X ${ep.method.toUpperCase()} "${url}"`];
  if (ep.security) parts.push(`  -H "authorization: Bearer <token>"`);
  const bodySample = sampleFromSchema(ep.body);
  if (bodySample !== null) {
    parts.push(`  -H "content-type: application/json"`);
    parts.push(`  -d '${JSON.stringify(bodySample)}'`);
  }
  return parts.join(" \\\n");
}

const METHOD_CLASS = { get: "", post: "m-post", put: "m-put", patch: "m-patch", delete: "m-del" };
</script>

<template>
  <div class="ignex-demo">
    <p class="ignex-demo-title">API explorer — the reference app's real generated OpenAPI document</p>

    <p v-if="error" style="color: var(--vp-c-text-2); font-size: 13px">
      Could not load the demo spec ({{ error }}). This component reads
      <code>demo/openapi.json</code> from the compiled reference app.
    </p>

    <template v-else-if="spec">
      <p style="margin: 0 0 12px; font-size: 13px; color: var(--vp-c-text-2)">
        <code>{{ spec.info?.title }}</code> · {{ spec.info?.version }} — every endpoint below was
        derived from the app's TypeBox schemas by <code>ignex build</code>. No annotations were written by hand.
      </p>

      <div v-for="group in groups" :key="group.tag" style="margin-bottom: 16px">
        <p style="margin: 4px 0 8px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vp-c-text-3)">
          {{ group.tag }}
        </p>
        <div v-for="ep in group.endpoints" :key="ep.key" class="ignex-explorer-endpoint">
          <div class="ignex-explorer-row" @click="toggle(ep.key)">
            <span class="ignex-method" :class="METHOD_CLASS[ep.method]">{{ ep.method.toUpperCase() }}</span>
            <span class="summary-text">{{ ep.path }}</span>
            <span style="font-size: 12px; color: var(--vp-c-text-3)">{{ ep.summary }}</span>
            <span class="ignex-explorer-chevron" :class="{ open: open === ep.key }">▸</span>
          </div>

          <div v-if="open === ep.key" class="ignex-explorer-detail">
            <div class="ignex-tabs">
              <button class="ignex-tab" :class="{ active: activeTab(ep.key) === 'docs' }" @click="setTab(ep.key, 'docs')">Docs</button>
              <button class="ignex-tab" :class="{ active: activeTab(ep.key) === 'curl' }" @click="setTab(ep.key, 'curl')">cURL</button>
              <button class="ignex-tab" :class="{ active: activeTab(ep.key) === 'response' }" @click="setTab(ep.key, 'response')">Responses</button>
            </div>

            <div v-if="activeTab(ep.key) === 'docs'" style="display: grid; gap: 8px">
              <div v-if="ep.params.length">
                <strong style="font-size: 12px">Parameters</strong>
                <ul style="margin: 4px 0 0; padding-left: 18px">
                  <li v-for="p in ep.params" :key="p.name + p.in">
                    <code>{{ p.name }}</code> <span style="color: var(--vp-c-text-3)">{{ p.in }}</span>
                    <span v-if="p.required" style="color: var(--vp-c-brand-1)"> · required</span> — <code>{{ p.type }}</code>
                  </li>
                </ul>
              </div>
              <div v-if="ep.body">
                <strong style="font-size: 12px">Request body</strong>
                <div style="font-family: var(--vp-font-family-mono); font-size: 12.5px; margin-top: 2px">
                  {{ schemaToType(ep.body) }}
                </div>
              </div>
              <div v-if="ep.security"><span class="ignex-badge">🔐 auth required</span></div>
            </div>

            <pre v-else-if="activeTab(ep.key) === 'curl'" class="ignex-pre">{{ buildCurl(ep) }}</pre>

            <div v-else style="display: grid; gap: 8px">
              <div v-for="r in ep.responses" :key="r.code">
                <span class="ignex-method" :style="{ background: r.code.startsWith('2') ? '#22c55e' : r.code.startsWith('4') ? '#f59e0b' : '#ef4444' }">
                  {{ r.code }}
                </span>
                <span style="font-size: 12.5px; margin-left: 8px">{{ r.description }}</span>
                <pre v-if="r.schema" class="ignex-pre" style="margin-top: 6px">{{ JSON.stringify(sampleFromSchema(r.schema), null, 2) }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <p v-else style="color: var(--vp-c-text-2); font-size: 13px">Loading the demo spec…</p>
  </div>
</template>
