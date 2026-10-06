/* The transparent mac window is excluded from macOS occlusion tracking, so visibilitychange
   never fires while Exponential sits covered behind other apps — Chromium believes the window
   is visible around the clock, and every periodic repaint used to run all night. Window focus
   is the main honest signal we get; everything that proves a human is present counts too:
   - window 'focus', and visibilitychange→visible (iOS PWAs resume WITHOUT re-firing 'focus' —
     the same WebKit trap as the lost deep-link postMessages — so focus alone would latch
     appIdle true forever on the phone),
   - direct interaction: scroll, click and keys reach an UNFOCUSED window too (second-monitor
     use). Interaction while unfocused re-ARMS the countdown rather than clearing it — no blur
     event would ever come again to restart it.
   Consumers park periodic work while appIdle() and re-arm through onAppWake(). */
const subs = new Set<() => void>();
let blurredAt = typeof document !== 'undefined' && document.hasFocus() ? 0 : 1; // 1 = unfocused since launch

const fire = () => subs.forEach((f) => { try { f(); } catch { /* one bad waker shouldn't stop the rest */ } });
const wake = () => { if (blurredAt === 0) return; blurredAt = 0; fire(); };

window.addEventListener('blur', () => { if (blurredAt === 0) blurredAt = Date.now(); });
window.addEventListener('focus', wake);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') wake();
  else if (blurredAt === 0) blurredAt = Date.now(); // hidden implies unfocused
});
for (const ev of ['pointerdown', 'wheel', 'keydown'] as const) {
  window.addEventListener(ev, () => {
    if (blurredAt === 0) return; // focused — nothing parked
    const parked = appIdle();
    blurredAt = Date.now(); // presence now; idle again a minute after the last touch
    if (parked) fire();
  }, { capture: true, passive: true });
}

/** True once the window has been unfocused AND untouched for `ms` (default 60s). */
export const appIdle = (ms = 60_000) => blurredAt !== 0 && Date.now() - blurredAt > ms;

/** Runs `f` every time presence returns (focus, foreground return, or interaction after a lull). */
export const onAppWake = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
