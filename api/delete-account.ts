import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "DELETE") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl    = process.env.VITE_SUPABASE_URL ?? "";
  const anonKey        = process.env.VITE_SUPABASE_ANON_KEY ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return res.status(500).json({ error: `Missing env vars: url=${!!supabaseUrl} anon=${!!anonKey} srk=${!!serviceRoleKey}` });
  }

  const authHeader = (req.headers["authorization"] ?? "") as string;
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = authHeader.slice(7);

  try {
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Invalid or expired session" });

    const userData = (await userRes.json()) as { id?: string };
    if (!userData.id) return res.status(401).json({ error: "Could not identify user" });

    const deleteRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userData.id}`, {
      method: "DELETE",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });

    if (!deleteRes.ok) {
      const body = await deleteRes.text();
      return res.status(500).json({ error: `Supabase error: ${body}` });
    }

    return res.status(200).json({ success: true });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
}
