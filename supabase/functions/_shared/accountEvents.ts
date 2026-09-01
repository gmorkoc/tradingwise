// Appends a row to account_events, read by the Profile → Activity tab
// (src/services/supabase.ts fetchAccountEvents). Each caller passes its
// own supabaseAdmin (service-role) client — this has no dependency on any
// one function's setup.
// deno-lint-ignore no-explicit-any
export async function logAccountEvent(
  supabaseAdmin: any,
  userId: string,
  type: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("account_events")
    .insert({ user_id: userId, type, detail });
  if (error) console.error(`logAccountEvent(${type}) failed:`, error.message);
}
