<script setup>
import { computed, ref } from "vue";

// Curated from the reference app (packages/app/src/routes) and docs/sdk.md —
// the call shapes are exactly what the generated SDK emits.
const routes = [
  {
    path: "/hello",
    method: "get",
    label: "GET /hello",
    call: `const res = await api["/hello"].get();
// → "Hello World"`,
    note: "A route with no params and no body takes a single optional init argument.",
  },
  {
    path: "/products/:id",
    method: "get",
    label: "GET /products/:id",
    call: `const product = await api["/products/:id"].get({ id: "42" });
//    ^? { id: string } — typed from the route's params schema`,
    note: "params + body → (params, body, init?). Path parameters are encoded and substituted by the client.",
  },
  {
    path: "/api/orders",
    method: "post",
    label: "POST /api/orders",
    call: `const order = await api["/api/orders"].post({
  orderId: "ord_123",
  quantity: 2,
  totalCents: 4900,
});
// body fully typed — hover the call to see the payload shape`,
    note: "Request and response types are inferred from the route schemas at generation time.",
  },
  {
    path: "/auth/login",
    method: "post",
    label: "POST /auth/login",
    call: `try {
  await api["/auth/login"].post({ email, password });
} catch (err) {
  if (err instanceof ApiClientError && err.status === 401) {
    console.error(err.body);
  }
}`,
    note: "Every non-2xx throws ApiClientError with .status, .code and the parsed body.",
  },
  {
    path: "/session",
    method: "get",
    label: "GET /session",
    call: `const session = await api["/session"].get();
// → { id: "s_…", visits: 3, isNew: false }`,
    note: "Cookie-based sessions work through the client automatically (credentials included).",
  },
];

const active = ref(0);
const current = computed(() => routes[active.value]);
</script>

<template>
  <div class="ignex-demo">
    <p class="ignex-demo-title">Client playground — pick a route, see the generated typed call</p>
    <div class="ignex-client-grid">
      <div class="ignex-client-list">
        <button
          v-for="(route, i) in routes"
          :key="route.path + route.method"
          class="ignex-client-item"
          :class="{ active: active === i }"
          @click="active = i"
        >
          {{ route.label }}
        </button>
      </div>
      <div>
        <pre class="ignex-pre">{{ current.call }}</pre>
        <p style="font-size: 13px; color: var(--vp-c-text-2); margin: 10px 0 0">{{ current.note }}</p>
      </div>
    </div>
  </div>
</template>
