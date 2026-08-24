import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.coinhintz.app',
  appName: 'coinhintz',
  webDir: 'dist',
  ios: {
    contentInset: 'automatic',
  },
  plugins: {
    // Without this, iOS resizes/shifts the WebView whenever an input is
    // focused (to keep it clear of the keyboard) — that's the "screen gets
    // pushed down and doesn't come back" bug on the coin search input.
    // 'none' leaves layout alone entirely; the keyboard just overlays on
    // top instead of the OS trying to "help" by resizing the page.
    Keyboard: {
      resize: 'none',
    },
  },
};

export default config;
