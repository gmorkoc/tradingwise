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
        '/bold-api': {
          target: 'https://bold.report/api/v1',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/bold-api/, ''),
          headers: { 'accept': 'application/json' },
        },
        '/nasdaq-api': {
          target: 'https://api.nasdaq.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/nasdaq-api/, ''),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Origin': 'https://www.nasdaq.com',
            'Referer': 'https://www.nasdaq.com/',
          },
        },
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
        '/gecko-api': {
          target: 'https://api.coingecko.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/gecko-api/, ''),
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
