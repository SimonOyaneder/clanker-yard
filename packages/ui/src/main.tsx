import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { browserHost } from "./browser-host"
import { createMemoryAppData } from "./memory-app-data"
import "./styles/globals.css"

// Entrada para desarrollar la UI sola en el navegador: `npm run dev -w packages/ui`.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App appData={createMemoryAppData()} host={browserHost} />
  </StrictMode>,
)
