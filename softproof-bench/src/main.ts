import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { getApp } from './lib/db/state.svelte'

const app = mount(App, {
  target: document.getElementById('app')!,
})

// Dev/test hook: lets E2E assertions read store-level state (project/profile
// ids, counts) without scraping the DOM. Never used by the app itself.
if (import.meta.env.DEV) {
  ;(window as unknown as { __app?: unknown }).__app = getApp()
}

export default app
