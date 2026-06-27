// Runtime side-effect target for the Express `Request` type augmentation.
//
// This module is intentionally empty at runtime. The actual type augmentation
// lives in the co-located declaration file (express-augmentation.d.ts), which
// TypeScript associates with this module by filename. `index.ts` imports this
// module for its side effect so that:
//   1. the augmentation is inlined into the bundled, published declarations
//      (tsup follows this import and emits the merged dist/index.d.ts), and
//   2. there is a real (runtime-resolvable) module to import, so test/dev
//      bundlers do not fail trying to load a type-only file.
export {};
