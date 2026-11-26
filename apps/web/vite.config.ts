import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // La CSP del panel no admite `data:` en fuentes: todo se sirve como archivo propio.
  build: { assetsInlineLimit: 0 },
  server: {
    port: 5173,
    // The same port as the API (API_PORT in .env): another one when 8090 is taken, such as by WSL.
    proxy: { "/api": `http://127.0.0.1:${process.env.API_PORT ?? 8090}` },
  },
});
