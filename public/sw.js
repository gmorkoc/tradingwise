self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(clients.claim()));

// Web Push — the browser equivalent of the native FCM/APNs pipeline (see
// src/services/pushNotifications.ts). Payload shape mirrors what
// _shared/fcm.ts sends: { title, body, data: { type, ... } }.
self.addEventListener("push", (event) => {
  console.log("[sw] push event received, has data:", !!event.data);
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
    console.log("[sw] parsed payload:", payload);
  } catch (e) {
    console.error("[sw] payload.json() failed:", e, "raw text:", event.data && event.data.text());
  }
  const title = payload.title || "coinhintz";
  const options = {
    body: payload.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: payload.data || {},
  };
  event.waitUntil(
    self.registration.showNotification(title, options)
      .then(() => console.log("[sw] showNotification resolved OK"))
      .catch((e) => console.error("[sw] showNotification FAILED:", e)),
  );
});

// Tap routing: if a tab is already open, focus it and hand the tap payload
// to the app via postMessage (App.tsx listens and re-dispatches it as the
// same "open-strategy-alert"-style CustomEvent the native path uses, so
// both platforms converge on one handler). Otherwise open a new tab.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.postMessage({ source: "web-push", data });
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow("/");
    }),
  );
});
