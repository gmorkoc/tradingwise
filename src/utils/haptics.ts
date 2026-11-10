import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";

/** Tap feedback in the iOS app (no-op on the web). Medium rather than
 *  Light — Light was hard to feel reliably on-device. */
export function hapticTap() {
  if (!Capacitor.isNativePlatform()) return;
  Haptics.impact({ style: ImpactStyle.Medium }).catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[hapticTap] Haptics.impact failed:", e);
  });
}
