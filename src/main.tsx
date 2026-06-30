import React from 'react'
import ReactDOM from 'react-dom/client'
import { inject } from '@vercel/analytics'
import App from './App.tsx'
import './index.css'
import './i18n'

inject()

if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
