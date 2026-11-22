// Frontdesk only: asks about room charges still awaiting front-desk review, in case a
// PosOrderReviewed webhook was missed. Started by startServer() when PMS_ADAPTER=frontdesk and
// PMS_REVIEW_POLL_MS > 0. Runs never overlap in one process.
import { config } from "../../config/env.js";
import { reconcileAwaitingReview } from "../../services/guestChargeService.js";

let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    await reconcileAwaitingReview();
  } catch (err) {
    console.error("⚠️  Frontdesk review check failed:", err.message);
  } finally {
    running = false;
  }
}

export function startReviewPoller({ intervalMs = config.integrations.pms.reviewPollMs } = {}) {
  if (config.integrations.pms.adapter !== "frontdesk" || !intervalMs || timer) return null;
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: stopReviewPoller };
}

export function stopReviewPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}
