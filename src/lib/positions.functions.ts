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
const CLAIM_MS = 10_000;
const SYNC_ROW = "__erlc_sync__";

type SyncState = {
  roblox_username: string;
  team: string | null;
  updated_at: string;
};

function retryDelayMs(response: Response, body: string): number {
  const retryAfterHeader = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0) {
    return Math.ceil(retryAfterHeader * 1000);
  }
  try {
    const parsed = JSON.parse(body) as { retry_after?: number };
    if (Number.isFinite(parsed.retry_after) && Number(parsed.retry_after) > 0) {
      return Math.ceil(Number(parsed.retry_after) * 1000);
    }
  } catch {
    // ER:LC occasionally returns a plain-text error.
  }
  return 60_000;
}

function waitMessage(until: string): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 60_000));
  return `تحديث ER:LC متوقف مؤقتًا، بيرجع تلقائيًا خلال ${minutes} دقيقة`;
}

/** Pulls live positions from the ER:LC server API (throttled, shared by all users). */
async function refreshFromErlc(): Promise<string | null> {
  const apiKey = process.env["ERLC_API_KEY"];
  if (!apiKey) return "ERLC_API_KEY غير مضبوط";

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: sync } = await supabaseAdmin
    .from("player_positions")
    .select("roblox_username, team, updated_at")
    .eq("roblox_username_lower", SYNC_ROW)
    .maybeSingle();

  const currentSync = sync as SyncState | null;
  if (currentSync) {
    const nextAttempt = Date.parse(currentSync.updated_at);
    if (nextAttempt > Date.now()) return waitMessage(currentSync.updated_at);
    if (Date.now() - nextAttempt < MIN_POLL_MS) return null;
  }

  // Every visitor polls this function. A shared row elects exactly one request
  // to contact ER:LC, preventing a multi-user burst from exhausting its limit.
  const claim = crypto.randomUUID();
  const claimedUntil = new Date(Date.now() + CLAIM_MS).toISOString();
  const { error: claimError } = await supabaseAdmin.from("player_positions").upsert(
    {
      roblox_username_lower: SYNC_ROW,
      roblox_username: SYNC_ROW,
      roblox_id: null,
      x: 0,
      y: 0,
      z: 0,
      team: claim,
      in_vehicle: false,
      updated_at: claimedUntil,
    },
    { onConflict: "roblox_username_lower" },
  );
  if (claimError) throw new Error(claimError.message);

  const { data: winner } = await supabaseAdmin
    .from("player_positions")
    .select("team")
    .eq("roblox_username_lower", SYNC_ROW)
    .maybeSingle();
  if (winner?.team !== claim) return null;

  const res = await fetch("https://api.erlc.gg/v2/server?Players=true", {
    headers: { "server-key": apiKey, accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    console.error("ERLC API failed", res.status, text);
    if (res.status === 429) {
      const blockedUntil = new Date(Date.now() + retryDelayMs(res, text)).toISOString();
      await supabaseAdmin
        .from("player_positions")
        .update({ updated_at: blockedUntil, team: "rate-limited" })
        .eq("roblox_username_lower", SYNC_ROW);
      return waitMessage(blockedUntil);
    }
    await supabaseAdmin
      .from("player_positions")
      .update({ updated_at: new Date(Date.now() + 60_000).toISOString(), team: "error" })
      .eq("roblox_username_lower", SYNC_ROW);
    return `تعذّر تحديث ER:LC (${res.status}) — بنحاول تلقائيًا`;
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
  await supabaseAdmin
    .from("player_positions")
    .delete()
    .neq("roblox_username_lower", SYNC_ROW)
    .lt("updated_at", now);
  await supabaseAdmin
    .from("player_positions")
    .update({ updated_at: now, team: "ok" })
    .eq("roblox_username_lower", SYNC_ROW);
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
      .select("roblox_username, roblox_username_lower, roblox_id, x, z, team, updated_at")
      .neq("roblox_username_lower", SYNC_ROW);
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
