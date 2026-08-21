import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), nodePolyfills()],
    resolve: {
      alias: {
        '@api/coinglass-api': new URL('.api/apis/coinglass-api/index.ts', import.meta.url).pathname,
      },
    },
    optimizeDeps: {
      esbuildOptions: {
        plugins: [
          {
            name: 'datauri-mock',
            setup(build) {
              const stub = new URL('src/stubs/datauri-parser.ts', import.meta.url).pathname;
              build.onResolve({ filter: /^datauri(\/|$)/ }, () => ({ path: stub }));
            },
          },
        ],
      },
    },
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
        '/cg-sdk': {
          target: 'https://open-api-v4.coinglass.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/cg-sdk/, ''),
          headers: {
            'accept': 'application/json',
            'CG-API-KEY': env.VITE_COINGLASS_API_KEY,
          },
        },
        '/coinalyze-api': {
          target: 'https://api.coinalyze.net',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/coinalyze-api/, ''),
          headers: {
            'accept': 'application/json',
            'api_key': env.VITE_COINALYZE_API_KEY,
          },
        },
        '/okx-api': {
          target: 'https://www.okx.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/okx-api/, ''),
          headers: { 'accept': 'application/json' },
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
        '/bn-api': {
          target: 'https://data-api.binance.vision',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/bn-api/, ''),
          headers: { 'accept': 'application/json' },
        },
        '/coinbase-api': {
          target: 'https://api.international.coinbase.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/coinbase-api/, ''),
          headers: { 'accept': 'application/json' },
        },
        '/gecko-api': {
          target: 'https://api.coingecko.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/gecko-api/, ''),
          headers: { 'accept': 'application/json' },
        },
        '/fred-api': {
          target: 'https://fred.stlouisfed.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/fred-api/, ''),
        },
        '/td-api': {
          target: 'https://api.twelvedata.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/td-api/, ''),
          headers: { 'accept': 'application/json' },
        },
        '/av-api': {
          target: 'https://www.alphavantage.co',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/av-api/, ''),
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
