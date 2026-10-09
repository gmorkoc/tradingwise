import React from 'react'
import ReactDOM from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { StatusBar } from '@capacitor/status-bar'
import { initKeyboardAvoidance } from './utils/keyboardAvoidance'
import { ErrorBoundary } from './components/ErrorBoundary'
import App from './App.tsx'
import './index.css'
import './i18n'

// No remote error tracking exists in this app — logging these to console
// is the only diagnostic trail available if a tester hits a crash and can
// share a device console capture (Xcode/Console.app for iOS, browser
// devtools for web).
window.addEventListener('error', (e) => {
  // eslint-disable-next-line no-console
  console.error('[window.onerror]', e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  // eslint-disable-next-line no-console
  console.error('[unhandledrejection]', e.reason);
});

if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

// Android: keep the WebView clear of the status bar / notch. (No-op on iOS —
// that platform's safe-area handling is done natively in
// MainViewController.swift instead, since setOverlaysWebView is unimplemented
// there.)
if (Capacitor.isNativePlatform()) {
  StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
}

initKeyboardAvoidance();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
