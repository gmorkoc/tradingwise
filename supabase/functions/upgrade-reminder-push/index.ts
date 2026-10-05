import { supabaseAdmin, getAccessToken, sendPush, getSoundsByUser } from "../_shared/fcm.ts";
import { logNotifications } from "../_shared/notificationLog.ts";

// Once-daily nudge for free-tier users (see the matching cron migration —
// the schedule itself is what keeps this to once a day, no extra state
// table needed). Every paid feature it name-drops is pulled straight from
// UpgradeModal's own Pro plan list.
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

const TITLE = "🔓 Unlock AI price signals";
const BODY = "You're on the Free plan — Pro gets you AI price predictions, liquidation heatmaps, on-chain analysis, and multi-timeframe market intelligence. Upgrade today.";

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { data: freeUsers } = await supabaseAdmin.from("profiles").select("id")
    .eq("tier", "free").eq("notify_upgrade_reminders", true);
  if (!freeUsers || freeUsers.length === 0) {
    return new Response(JSON.stringify({ freeUsers: 0, sent: 0 }), { headers: { "Content-Type": "application/json" } });
  }

  const { data: tokens } = await supabaseAdmin
    .from("device_push_tokens")
    .select("token, user_id")
    .in("user_id", freeUsers.map(u => u.id));

  if (!tokens || tokens.length === 0) {
    return new Response(JSON.stringify({ freeUsers: freeUsers.length, sent: 0 }), { headers: { "Content-Type": "application/json" } });
  }

  const soundByUser = await getSoundsByUser(tokens.map(t => t.user_id));
  const accessToken = await getAccessToken();
  const upgradePushData = { type: "upgrade_reminder" };
  const results = await Promise.all(tokens.map(({ token, user_id }) =>
    sendPush(accessToken, token, TITLE, BODY, soundByUser.get(user_id) ?? "bell", upgradePushData)
  ));
  const uniqueFreeUserIds = [...new Set(tokens.map(t => t.user_id))];
  await logNotifications(uniqueFreeUserIds.map((userId) => ({
    userId, type: "upgrade_reminder", title: TITLE, body: BODY, data: upgradePushData,
  })));

  return new Response(
    JSON.stringify({ freeUsers: freeUsers.length, sent: results.filter(Boolean).length, total: tokens.length }),
    { headers: { "Content-Type": "application/json" } }
  );
});
