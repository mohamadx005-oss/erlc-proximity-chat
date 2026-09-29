import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { apiLocationToWorld } from "@/lib/proximity";

export type LivePlayer = {
  username: string;
  robloxId: number | null;
  x: number;
  z: number;
  team: string | null;
  updatedAt: string;
  /** Site user id when this player has linked their account. */
  userId: string | null;
  avatar: string | null;
};

type ErlcPlayer = {
  Player?: string;
  Team?: string;
  Location?: { LocationX?: number; LocationZ?: number };
};

const MIN_POLL_MS = 2500;

/** Pulls live positions from the ER:LC server API (throttled, shared by all users). */
async function refreshFromErlc(): Promise<string | null> {
  const apiKey = process.env["ERLC_API_KEY"];
  if (!apiKey) return "ERLC_API_KEY غير مضبوط";

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: latest } = await supabaseAdmin
    .from("player_positions")
    .select("updated_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest && Date.now() - Date.parse(latest.updated_at) < MIN_POLL_MS) return null;

  const res = await fetch("https://api.erlc.gg/v2/server?Players=true", {
    headers: { "server-key": apiKey, accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    console.error("ERLC API failed", res.status, text);
    return res.status === 429 ? null : `ERLC API ${res.status}`;
  }
  const json = (await res.json()) as { Players?: ErlcPlayer[] };
  const now = new Date().toISOString();

  const rows = (json.Players ?? [])
    .map((p) => {
      const [name, id] = String(p.Player ?? "").split(":");
      const lx = Number(p.Location?.LocationX);
      const lz = Number(p.Location?.LocationZ);
      if (!name || !Number.isFinite(lx) || !Number.isFinite(lz)) return null;
      const w = apiLocationToWorld(lx, lz);
      return {
        roblox_username_lower: name.toLowerCase(),
        roblox_username: name,
        roblox_id: id ? Number(id) : null,
        x: w.x,
        y: 0,
        z: w.z,
        team: p.Team ? String(p.Team).slice(0, 40) : null,
        in_vehicle: false,
        updated_at: now,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length) {
    const { error } = await supabaseAdmin
      .from("player_positions")
      .upsert(rows, { onConflict: "roblox_username_lower" });
    if (error) console.error("position upsert failed", error);
  }
  // Players who left the server disappear.
  await supabaseAdmin.from("player_positions").delete().lt("updated_at", now);
  return null;
}

export const getLivePlayers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ players: LivePlayer[]; error: string | null }> => {
    let error: string | null = null;
    try {
      error = await refreshFromErlc();
    } catch (e) {
      console.error(e);
      error = "تعذّر الاتصال بسيرفر ERLC";
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: positions } = await supabaseAdmin
      .from("player_positions")
      .select("roblox_username, roblox_username_lower, roblox_id, x, z, team, updated_at");
    const { data: profiles } = await supabaseAdmin
      .from("profiles")
      .select("id, roblox_username, roblox_avatar_url")
      .not("roblox_username", "is", null);

    const byName = new Map(
      (profiles ?? []).map((p) => [String(p.roblox_username).toLowerCase(), p]),
    );

    const players: LivePlayer[] = (positions ?? []).map((p) => {
      const prof = byName.get(p.roblox_username_lower);
      return {
        username: p.roblox_username,
        robloxId: p.roblox_id,
        x: p.x,
        z: p.z,
        team: p.team,
        updatedAt: p.updated_at,
        userId: prof?.id ?? null,
        avatar: prof?.roblox_avatar_url ?? null,
      };
    });
    return { players, error };
  });
