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
    // Empty = suppress the OS banner/sound/badge for a push that arrives
    // while the app is in the foreground — pushNotifications.ts shows an
    // in-app toast for those instead. Only affects foreground presentation;
    // backgrounded/closed still get the normal system notification.
    FirebaseMessaging: {
      presentationOptions: [],
    },
  },
};

export default config;
