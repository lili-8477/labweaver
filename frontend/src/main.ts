import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { applyTheme, loadTheme } from './utils/theme'

// Before mount, so the first paint already uses the saved theme.
applyTheme(loadTheme())

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
