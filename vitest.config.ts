import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __MAGIC__: JSON.stringify("test-magic"),
    __CHANNEL__: JSON.stringify("timers"),
    __GROQ_BASE__: JSON.stringify("https://api.groq.com/openai/v1"),
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
