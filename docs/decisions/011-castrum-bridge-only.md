# D-011 · castrum only inside packages/native

- Status: accepted
- Context: `packages/native` is the typed bridge over the castrum addon.
- Decision: Never import `castrum` outside `packages/native`; `@ignex/native`
  is the only bridge. The surface check runs over the vendored declaration.
- Consequences: One choke point for ABI/API drift; the rest of the repo never
  sees the addon directly.
- Verification: `packages/native/src/runtime.ts`, `scripts/check-native-surface.ts`