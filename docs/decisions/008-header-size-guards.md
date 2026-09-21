# D-008 · Header size guards before packing

- Status: accepted
- Context: Oversized cookie/x-forwarded-for values must not blow the 64 KiB
  native wire block.
- Decision: cookie/xff values guard at 8192 bytes, small headers at 2048;
  oversized values are dropped BEFORE packing into the ingress block.
- Consequences: Bounded wire size; oversized headers are dropped, not
  truncated.
- Verification: `packages/native/src/ingress/headers.ts`, `packages/native/test/size-gates.test.ts`