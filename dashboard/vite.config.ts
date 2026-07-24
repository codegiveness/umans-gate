import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/dashboard/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
        manualChunks(id) {
          if (!id.includes("node_modules")) return;

          // React core — loaded upfront, kept small.
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/scheduler/")
          ) {
            return "vendor-react";
          }

          // Charts (recharts) — ~heavy, only used by the lazy-loaded
          // Usage tab. Splitting it out defers the download until the
          // user opens that tab.
          if (id.includes("node_modules/recharts/")) {
            return "vendor-charts";
          }

          // Form stack (react-hook-form, zod, resolvers) — only used by
          // the lazy-loaded Config tab and the API-key gate.
          if (
            id.includes("node_modules/react-hook-form/") ||
            id.includes("node_modules/@hookform/") ||
            id.includes("node_modules/zod/")
          ) {
            return "vendor-form";
          }

          // UI primitives (@base-ui, radix, lucide icons, cva, clsx,
          // tailwind-merge, sonner) — shared across the app.
          if (
            id.includes("node_modules/@base-ui/") ||
            id.includes("node_modules/@radix-ui/") ||
            id.includes("node_modules/lucide-react/") ||
            id.includes("node_modules/class-variance-authority/") ||
            id.includes("node_modules/clsx/") ||
            id.includes("node_modules/tailwind-merge/") ||
            id.includes("node_modules/sonner/")
          ) {
            return "vendor-ui";
          }

          // Remaining small deps fall into a general vendor bucket.
          return "vendor";
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
