import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/cg-api': {
          target: 'https://open-api-v4.coinglass.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/cg-api/, '/api'),
          headers: {
            'accept': 'application/json',
            'CG-API-KEY': env.VITE_COINGLASS_API_KEY,
          },
        },
        '/cc-api': {
          target: 'https://min-api.cryptocompare.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/cc-api/, ''),
          headers: { 'accept': 'application/json' },
        },
        '/okx-api': {
          target: 'https://www.okx.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/okx-api/, ''),
          headers: { 'accept': 'application/json' },
        },
        '/yf-api': {
          target: 'https://query2.finance.yahoo.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/yf-api/, ''),
          headers: { 'accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        },
        '/bybit-api': {
          target: 'https://api.bybit.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/bybit-api/, ''),
          headers: { 'accept': 'application/json' },
        },
        '/bnf-api': {
          target: 'https://fapi.binance.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/bnf-api/, ''),
          headers: { 'accept': 'application/json' },
        },
        '/coinbase-api': {
          target: 'https://api.international.coinbase.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/coinbase-api/, ''),
          headers: { 'accept': 'application/json' },
        },
        '/api/openai': {
          target: 'https://api.openai.com',
          changeOrigin: true,
          rewrite: () => '/v1/chat/completions',
          headers: { 'Authorization': `Bearer ${env.VITE_OPENAI_API_KEY}` },
        },
      },
    },
  }
})
