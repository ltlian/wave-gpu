import { defineConfig } from 'vite';
import { audioPlugin } from './server/audio-plugin.ts';

// One command (`npm run dev`) serves both the app and the audio endpoints.
// The plugin also sets the COOP/COEP headers that make `crossOriginIsolated`
// true, which is what allows the capture worklet to use a SharedArrayBuffer.
export default defineConfig({
  plugins: [audioPlugin()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5174, strictPort: true },
});
