// Build-time constants injected by esbuild `define` (see scripts/build.mjs).

/** Random per-build token used to tag MAIN <-> ISOLATED handshake messages. */
declare const __MAGIC__: string;
/** Channel handled by an ISOLATED relay bundle ("timers" | "speech"). */
declare const __CHANNEL__: string;
/** Base URL of the Groq OpenAI-compatible API. Only the E2E build overrides it. */
declare const __GROQ_BASE__: string;
