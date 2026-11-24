import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "../internal/webassets/dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/admin/api": "http://127.0.0.1:8000",
      "/v1": "http://127.0.0.1:8000",
      "/health": "http://127.0.0.1:8000",
    },
  },
});
