import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { LiquidPreferencesProvider } from './components/LiquidPreferences'
import './index.css'
import './liquid.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LiquidPreferencesProvider><App /></LiquidPreferencesProvider>
  </React.StrictMode>
)
