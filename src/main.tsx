import React from 'react'
import ReactDOM from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { StatusBar } from '@capacitor/status-bar'
import { initKeyboardAvoidance } from './utils/keyboardAvoidance'
import { installInAppLinks } from './utils/externalLinks'
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

// iPhone app: external links open in the in-app browser, not Safari.
installInAppLinks();

if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

// Sets data-theme BEFORE React ever renders, not inside a useEffect (App.tsx
// still has one, for when the user actually switches theme later) — a
// plain useEffect only runs AFTER paint, well after any useLayoutEffect
// deeper in the tree, so components that read this attribute synchronously
// on mount (FloatingNavBar's active-pill color, at least) could see it
// still unset on a genuine first load and silently apply the wrong
// theme's colors. Same stored/matchMedia logic App.tsx's own theme state
// initializer uses — keep both in sync if that one ever changes.
{
  const storedTheme = localStorage.getItem('theme');
  const theme = storedTheme === 'dark' || storedTheme === 'light'
    ? storedTheme
    : (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
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
