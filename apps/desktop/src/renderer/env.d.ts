/// <reference types="vite/client" />

import type { ClankerBridge } from "../preload";

declare global {
  interface Window {
    clanker: ClankerBridge;
  }
}
