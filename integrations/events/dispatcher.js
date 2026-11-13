// Background delivery of outbox events. Started by startServer() (web server and Electron)
// when EVENTS_DISPATCH_INTERVAL_MS > 0. Runs never overlap in one process, and claims use
// SKIP LOCKED, so several app instances can run dispatchers side by side.
import { publishPending } from "./eventPublisher.js";
import { config } from "../../config/env.js";

let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    // Keep draining while full batches come back, then wait for the next interval.
    for (let i = 0; i < 20; i++) {
      const result = await publishPending();
      if (result.attempted < config.events.batchSize) break;
    }
  } catch (err) {
    console.error("⚠️  Event dispatch failed:", err.message);
  } finally {
    running = false;
  }
}

export function startEventDispatcher({ intervalMs = config.events.dispatchIntervalMs } = {}) {
  if (!intervalMs || timer) return null;
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 1000).unref?.();
  return { stop: stopEventDispatcher };
}

export function stopEventDispatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}
