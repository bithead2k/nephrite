import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

/** Suppress noisy third-party "use client" directives (Radix via Excalidraw). */
function silenceUseClientDirective(): Plugin {
  return {
    name: "silence-use-client-directive",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("node_modules")) return null;
      if (!code.startsWith('"use client"') && !code.startsWith("'use client'")) {
        return null;
      }
      // Strip the directive so Rollup never sees it.
      const stripped = code.replace(/^['"]use client['"];?\s*/, "");
      return { code: stripped, map: null };
    },
  };
}

export default defineConfig({
  define: {
    "process.env.IS_PREACT": "false",
  },
  root: "ui",
  clearScreen: false,
  plugins: [silenceUseClientDirective()],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari14",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      onwarn(warning, warn) {
        // Belt-and-suspenders: ignore MODULE_LEVEL_DIRECTIVE if any remain.
        if (
          warning.code === "MODULE_LEVEL_DIRECTIVE" ||
          (typeof warning.message === "string" &&
            warning.message.includes("use client"))
        ) {
          return;
        }
        warn(warning);
      },
    },
  },
});
