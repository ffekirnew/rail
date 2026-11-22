import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` proxies the API to a server started with `uvicorn rail.server:app --port 8020`.
// Set RAIL_API to proxy somewhere else, e.g. while the production container holds 8020.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": env.RAIL_API ?? "http://127.0.0.1:8020" } },
});
