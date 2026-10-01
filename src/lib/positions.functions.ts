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

const MIN_POLL_MS = 2000;
const CLAIM_MS = 6_000;
const SYNC_ROW = "__erlc_sync__";

type SyncState = {
  roblox_username: string;
  team: string | null;
  updated_at: string;
};

/** Converts a seconds / epoch value into a delay. Never shortened: ER:LC blocks apps that retry early. */
function toDelayMs(raw: number): number | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  let ms: number;
  if (raw > 1e12) ms = raw - Date.now(); // epoch ms
  else if (raw > 1e9) ms = raw * 1000 - Date.now(); // epoch seconds
  else ms = raw * 1000; // seconds
  return Math.max(1000, Math.ceil(ms) + 1000);
}

function retryDelayMs(response: Response, body: string): number {
  const candidates: (number | null)[] = [toDelayMs(Number(response.headers.get("retry-after")))];
  try {
    const parsed = JSON.parse(body) as { retry_after?: number };
    candidates.push(toDelayMs(Number(parsed.retry_after)));
  } catch {
    // ER:LC occasionally returns a plain-text error.
  }
  candidates.push(toDelayMs(Number(response.headers.get("x-ratelimit-reset"))));
  const valid = candidates.filter((n): n is number => n !== null);
  return valid.length ? Math.max(...valid) : 60_000;
}

function waitMessage(until: string): string {
  const seconds = Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 1000));
  if (seconds < 90) return `ER:LC طلب انتظار — يرجع التحديث خلال ${seconds} ثانية`;
  return `ER:LC موقف التتبع مؤقتًا — يرجع تلقائيًا خلال ${Math.ceil(seconds / 60)} دقيقة`;
}

/** Pulls live positions from the ER:LC server API (throttled, shared by all users). */
async function refreshFromErlc(): Promise<string | null> {
  const apiKey = process.env["ERLC_API_KEY"];
  if (!apiKey) return "ERLC_API_KEY غير مضبوط";
  const globalKey = process.env["ERLC_GLOBAL_API_KEY"];

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: sync } = await supabaseAdmin
    .from("player_positions")
    .select("roblox_username, team, updated_at")
    .eq("roblox_username_lower", SYNC_ROW)
    .maybeSingle();

  const currentSync = sync as SyncState | null;
  if (currentSync) {
    const nextAttempt = Date.parse(currentSync.updated_at);
    if (nextAttempt > Date.now()) {
      return currentSync.team === "rate-limited" ? waitMessage(currentSync.updated_at) : null;
    }
    if (Date.now() - nextAttempt < MIN_POLL_MS) return null;
  }

  // Every visitor polls this function. An atomic conditional update elects
  // exactly one request to contact ER:LC, and can never overwrite a block.
  const claim = crypto.randomUUID();
  const claimedUntil = new Date(Date.now() + CLAIM_MS).toISOString();
  if (currentSync) {
    const { data: won } = await supabaseAdmin
      .from("player_positions")
      .update({ team: claim, updated_at: claimedUntil })
      .eq("roblox_username_lower", SYNC_ROW)
      .eq("updated_at", currentSync.updated_at)
      .select("team");
    if (!won?.length) return null;
  } else {
    const { error: insertError } = await supabaseAdmin.from("player_positions").insert({
      roblox_username_lower: SYNC_ROW,
      roblox_username: SYNC_ROW,
      roblox_id: null,
      x: 0,
      y: 0,
      z: 0,
      team: claim,
      in_vehicle: false,
      updated_at: claimedUntil,
    });
    if (insertError) return null;
  }

  const headers: Record<string, string> = { "server-key": apiKey, accept: "application/json" };
  if (globalKey) headers["authorization"] = globalKey;
  const res = await fetch("https://api.erlc.gg/v2/server?Players=true", { headers });
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
      .update({ updated_at: new Date(Date.now() + 5_000).toISOString(), team: "error" })
      .eq("roblox_username_lower", SYNC_ROW);
    return `تعذّر تحديث ER:LC (${res.status}) — بنحاول تلقائيًا`;
  }
  // Pace proactively when the bucket is nearly empty instead of hitting 429.
  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  const pauseUntil =
    Number.isFinite(remaining) && remaining <= 1
      ? normalizeDelay(Number(res.headers.get("x-ratelimit-reset")))
      : null;
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
    .update({
      updated_at: pauseUntil ? new Date(Date.now() + pauseUntil - MIN_POLL_MS).toISOString() : now,
      team: "ok",
    })
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
