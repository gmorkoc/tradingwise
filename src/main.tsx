import React from 'react'
import ReactDOM from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { StatusBar } from '@capacitor/status-bar'
import { initKeyboardAvoidance } from './utils/keyboardAvoidance'
import App from './App.tsx'
import './index.css'
import './i18n'

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
    <App />
  </React.StrictMode>,
)
