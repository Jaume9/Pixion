import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/pixels': 'http://localhost:3000',
      '/paint': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/create-checkout-session': 'http://localhost:3000',
      '/webhook': 'http://localhost:3000'
    }
  }
});
