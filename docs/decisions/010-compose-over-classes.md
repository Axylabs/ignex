# D-010 · Compose over classes (RULES.md rule 3)

- Status: accepted
- Context: Public surfaces must be factories/composition with no classes.
- Decision: No classes on public surfaces; small pure functions in small files
  by domain. The maintainability system adds no abstraction layer on top — it
  enforces size and documentation instead.
- Exception (stateful services): a class is permitted when an instance owns a
  long-lived resource or identity that a closure-factory rewrite would obscure
  or make slower — i.e. it owns sockets, timers, subscriptions, in-flight maps,
  or a native handle, or it is a per-request object whose identity and
  prototype methods are part of the hot path. The error taxonomy and
  self-contained data structures were always allowed; the same test now covers
  the runtime services: the per-request context (`IgnexContextImpl`), the
  compile-time `SourceManager`/`DiagnosticCollector`/`IgnexCompiler`, the CLI
  `DevServer`, the HTTP `HttpResponseCache`, and the debug observatory's
  resource-owning registries (`ClientRegistry`, `LogStore`, `MetricsRegistry`,
  `TraceStore`, `ObservatoryDb`, `SystemProfiler`, `NatsConnection`,
  `NatsEventTracker`, `Trace`). This is not a licence to add service classes:
  a new *public* surface still starts as a factory, and a class must cite the
  resource it owns in a JSDoc line when it is introduced.
- Consequences: Simpler mental model for newcomers; the 400-line cap is the
  guardrail, not more indirection. The exception keeps the resource-ownership
  boundary explicit instead of forcing state through module closures.
- Verification: `RULES.md`, `packages/core/src/lifecycle/run.ts`