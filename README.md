# flux-core

> Work-in-progress TypeScript framework for building high-performance HTTP APIs on **Bun 1.4**, using **native Bun routing** and **ahead-of-time compilation** for maximum performance.

`flux-core` is an AOT-first web framework designed to achieve native-like performance while keeping a TypeScript-friendly developer experience. Routes are written as simple file-system modules, then compiled into an optimized Bun server with generated types, OpenAPI artifacts, precompiled validators, and specialized request handlers.

---

## Table of Contents

- [Overview](#overview)
- [Project Goals](#project-goals)
- [Why Bun 1.4 Native Routing?](#why-bun-14-native-routing)
- [Core Design Principles](#core-design-principles)
- [Repository Layout](#repository-layout)
- [Packages](#packages)
- [Feature Overview](#feature-overview)
- [How the Compiler Works](#how-the-compiler-works)
- [Routing Conventions](#routing-conventions)
- [Route Examples](#route-examples)
- [Configuration](#configuration)
- [CLI](#cli)
- [Generated Artifacts](#generated-artifacts)
- [Runtime Features](#runtime-features)
- [Example App](#example-app)
- [Development Workflow](#development-workflow)
- [Progress Report](#progress-report)
- [What Is Done](#what-is-done)
- [What Is In Progress / Missing](#what-is-in-progress--missing)
- [Roadmap](#roadmap)
- [Current Limitations](#current-limitations)
- [Status](#status)

---

## Overview

`flux-core` is a TypeScript framework and compiler toolchain for building production-oriented HTTP APIs on Bun.

Instead of relying only on a runtime router, `flux-core` compiles your file-based routes into a highly optimized Bun server. The compiler analyzes route files ahead of time, detects context usage, precompiles validation and serialization where possible, and emits a server that uses Bun 1.4’s native routing capabilities.

The project is composed of several workspace packages:

- `@flux/compiler` — AOT compiler pipeline
- `@flux/core` — runtime primitives and HTTP helpers
- `@flux/cli` — developer CLI for scaffolding, building, and dev mode
- `@flux/shared` — shared types and compile-time/runtime flags
- `packages/app` — example application used for testing and benchmarking
- `scripts/` — benchmarking and OpenAPI client generation utilities

---

## Project Goals

The main goal of `flux-core` is to build a high-performance TypeScript web framework that feels ergonomic while compiling away as much runtime overhead as possible.

### Primary Goals

1. **Native-like performance**
   - Use Bun 1.4 as the primary runtime.
   - Use Bun’s native routing instead of a heavy runtime router.
   - Generate specialized handlers instead of generic middleware chains.

2. **Ahead-of-time compilation**
   - Discover routes at build time.
   - Analyze route files using AST parsing.
   - Inline constant responses where safe.
   - Precompile validators and serializers.
   - Generate optimized server entry code.

3. **File-system routing**
   - Routes are defined by files.
   - Dynamic parameters are expressed using `[param]` syntax.
   - Catch-all parameters are expressed using `[...param]` syntax.
   - HTTP methods are expressed through file suffixes such as `.get.ts`, `.post.ts`, `.del.ts`.

4. **Type-safe APIs**
   - Typed route context.
   - Typed params, query, and body where schemas are provided.
   - Generated route types.
   - Generated client type definitions.
   - OpenAPI generation support.

5. **Production-ready primitives**
   - Lazy body parsing.
   - Structured errors.
   - Schema validation.
   - HTTP caching helpers.
   - File serving.
   - Proxying.
   - SSE.
   - WebSocket helpers.
   - Rate limiting.
   - CORS.
   - Security headers.
   - Compression.
   - Logging.
   - Tracing helpers.

6. **Excellent developer experience**
   - CLI scaffolding.
   - Dev mode with watch and rebuild.
   - Route generation.
   - Project creation.
   - OpenAPI and client generation scripts.

---

## Why Bun 1.4 Native Routing?

`flux-core` targets Bun 1.4 because Bun provides a high-performance JavaScript/TypeScript runtime with built-in primitives that are ideal for an AOT framework.

The compiler emits a server that uses **Bun’s native routing** instead of implementing a custom regex trie or runtime route matcher.

This gives several advantages:

- Lower routing overhead.
- Faster parameter extraction.
- Less generated runtime code.
- Better alignment with Bun’s internal optimizations.
- Simpler generated server entry.
- Static, dynamic, and wildcard routes handled directly by Bun.

In short: route matching is delegated to Bun, while `flux-core` focuses on compile-time optimization, typed context, validation, serialization, and production HTTP primitives.

---

## Core Design Principles

### 1. Compile-time over runtime

Whenever possible, decisions are made during compilation:

- Route discovery.
- Route path parsing.
- HTTP method extraction.
- Context usage detection.
- Constant response detection.
- Handler inlining eligibility.
- Validator precompilation.
- Serializer precompilation.
- OpenAPI artifact generation.
- Type artifact generation.

### 2. File-system routing

Routes are defined by convention:

```txt
src/routes/index.get.ts        → GET /
src/routes/health.get.ts       → GET /health
src/routes/products/[id].get.ts → GET /products/:id
src/routes/files/[name].get.ts  → GET /files/:name