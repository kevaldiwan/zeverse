import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "https://zeverse-server-production.up.railway.app",
        changeOrigin: true,
      },
      "/health": {
        target: "https://zeverse-server-production.up.railway.app",
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
