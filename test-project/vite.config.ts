import { defineConfig } from 'vite'
import { tsExtensionsPlugin } from 'ts-extension-methods/vite-plugin'

export default defineConfig({
  plugins: [tsExtensionsPlugin()],
})

