import { defineConfig } from 'vite'
import { tsExtensionsPlugin } from 'ts-extensions-test/vite-plugin'

export default defineConfig({
  plugins: [tsExtensionsPlugin()],
})

