import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const __dirname = dirname(fileURLToPath(import.meta.url));
const globalSetupPath = path.resolve(__dirname, "./test-globals.js");
const setupFilesPath = path.resolve(__dirname, "./test/setup-mocks.ts");

export default defineConfig({
  test: {
    typecheck: {
      tsconfig: "tsconfig.vitest.json",
    },
    globalSetup: globalSetupPath,
    setupFiles: [setupFilesPath],
    // 本地全量并行跑 test/recorder/index.test.ts 时，beforeAll 的动态 import 会超过默认 10s（本机 IO 慢）
    // ⇒ 放宽到 60s，避免本地误报；上游 CI 无此问题
    hookTimeout: 60000,
    globals: true,
  },
});
