import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from "@tailwindcss/vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // In dev the frontend runs on :5173 and the backend on :3000.
  // These proxies let the app call "/api/..." and open the Socket.IO
  // websocket as if they were same-origin, exactly like in production
  // (where the backend serves the built frontend from one origin).
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/socket.io": { target: "http://localhost:3000", ws: true },
    },
  },
})
