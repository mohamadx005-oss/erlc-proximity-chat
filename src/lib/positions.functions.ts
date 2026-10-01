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

const ACTIVE_POLL_MS = 6500;
const SOLO_POLL_MS = 25000;
const CLAIM_MS = 8_000;
const SYNC_ROW = "__erlc_sync__";

type SyncState = {
  roblox_username: string;
  team: string | null;
  updated_at: string;
};

/** In-memory synchronization lock & timestamp to debounce rapid calls from multiple visitors on this instance. */
let memoryLastSyncTime = 0;
let memoryActiveSyncPromise: Promise<string | null> | null = null;

/** Converts a seconds / epoch value into a delay. Never shortened: ER:LC blocks apps that retry early. */
function toDelayMs(raw: number): number | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  let ms: number;
  if (raw > 1e12)
    ms = raw - Date.now(); // epoch ms
  else if (raw > 1e9)
    ms = raw * 1000 - Date.now(); // epoch seconds
  else ms = raw * 1000; // seconds
  return Math.max(1000, Math.ceil(ms) + 1000);
}

function parseDelay(headerVal: string | null | undefined): number | null {
  if (!headerVal) return null;
  const num = Number(headerVal);
  if (Number.isFinite(num) && num > 0) {
    return toDelayMs(num);
  }
  const parsedDate = Date.parse(headerVal);
  if (!Number.isNaN(parsedDate) && parsedDate > Date.now()) {
    return parsedDate - Date.now() + 1000;
  }
  return null;
}

function retryDelayMs(response: Response, body: string): number {
  const candidates: (number | null)[] = [
    parseDelay(response.headers.get("retry-after")),
    parseDelay(response.headers.get("x-ratelimit-reset-after")),
    parseDelay(response.headers.get("x-ratelimit-reset")),
  ];
  try {
    const parsed = JSON.parse(body) as {
      retry_after?: number | string;
      retryAfter?: number | string;
      reset_after?: number | string;
      resetAfter?: number | string;
    };
    if (parsed.retry_after !== undefined) candidates.push(parseDelay(String(parsed.retry_after)));
    if (parsed.retryAfter !== undefined) candidates.push(parseDelay(String(parsed.retryAfter)));
    if (parsed.reset_after !== undefined) candidates.push(parseDelay(String(parsed.reset_after)));
    if (parsed.resetAfter !== undefined) candidates.push(parseDelay(String(parsed.resetAfter)));
  } catch {
    // ER:LC occasionally returns a plain-text error.
  }
  const valid = candidates.filter((n): n is number => n !== null && n > 0);
  return valid.length ? Math.max(...valid) : 60_000;
}

function waitMessage(until: string): string {
  const seconds = Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 1000));
  if (seconds < 90) return `ER:LC طلب انتظار — يرجع التحديث خلال ${seconds} ثانية`;
  return `ER:LC موقف التتبع مؤقتًا — يرجع تلقائيًا خلال ${Math.ceil(seconds / 60)} دقيقة`;
}

/** Executes the actual atomic sync with ER:LC via database coordination. */
async function executeErlcSync(minInterval: number): Promise<string | null> {
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
    if (Date.now() - nextAttempt < minInterval) return null;
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

  let res: Response;
  try {
    res = await fetch("https://api.erlc.gg/v2/server?Players=true", { headers });
  } catch (netErr) {
    console.error("ERLC Network fetch failed", netErr);
    await supabaseAdmin
      .from("player_positions")
      .update({ updated_at: new Date(Date.now() + 10_000).toISOString(), team: "error" })
      .eq("roblox_username_lower", SYNC_ROW);
    return "تعذّر الاتصال بسيرفر ERLC — بنحاول تلقائيًا";
  }

  if (!res.ok) {
    const text = await res.text();
    console.error("ERLC API failed", res.status, text);

    const isRateLimit =
      res.status === 429 ||
      res.status === 4001 ||
      text.includes("4001") ||
      text.toLowerCase().includes("rate limit") ||
      text.toLowerCase().includes("ratelimit") ||
      text.toLowerCase().includes("too many requests");

    if (isRateLimit) {
      const delayMs = retryDelayMs(res, text);
      const blockedUntil = new Date(Date.now() + delayMs).toISOString();
      await supabaseAdmin
        .from("player_positions")
        .update({ updated_at: blockedUntil, team: "rate-limited" })
        .eq("roblox_username_lower", SYNC_ROW);
      return waitMessage(blockedUntil);
    }

    // For any server error or unexpected HTTP status, back off 15 seconds
    await supabaseAdmin
      .from("player_positions")
      .update({ updated_at: new Date(Date.now() + 15_000).toISOString(), team: "error" })
      .eq("roblox_username_lower", SYNC_ROW);
    return `تعذّر تحديث ER:LC (${res.status}) — بنحاول تلقائيًا`;
  }

  // Pace proactively when the bucket is nearly empty instead of hitting 429.
  const remainingHeader = res.headers.get("x-ratelimit-remaining");
  const remaining = remainingHeader === null ? NaN : Number(remainingHeader);
  let pauseUntil: number | null = null;
  if (Number.isFinite(remaining) && remaining <= 5) {
    pauseUntil = parseDelay(res.headers.get("x-ratelimit-reset")) ?? 6_000;
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
    .update({
      updated_at: pauseUntil ? new Date(Date.now() + pauseUntil).toISOString() : now,
      team: "ok",
    })
    .eq("roblox_username_lower", SYNC_ROW);
  return null;
}

/** Pulls live positions from the ER:LC server API (throttled, shared by all users). */
async function refreshFromErlc(hasPeers: boolean): Promise<string | null> {
  const minInterval = hasPeers ? ACTIVE_POLL_MS : SOLO_POLL_MS;
  const now = Date.now();
  if (now - memoryLastSyncTime < minInterval) {
    return null;
  }
  if (memoryActiveSyncPromise) {
    return memoryActiveSyncPromise;
  }
  memoryActiveSyncPromise = executeErlcSync(minInterval).finally(() => {
    memoryLastSyncTime = Date.now();
    memoryActiveSyncPromise = null;
  });
  return memoryActiveSyncPromise;
}

export const getLivePlayers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input?: { activePeersCount?: number }) => input)
  .handler(async ({ data }): Promise<{ players: LivePlayer[]; error: string | null }> => {
    let error: string | null = null;
    const hasPeers = (data?.activePeersCount ?? 0) > 0;
    try {
      error = await refreshFromErlc(hasPeers);
    } catch (e) {
      console.error(e);
      error = "تعذّر الاتصال بسيرفر ERLC";
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Only real, recent positions count — 90s grace window avoids player drops during temporary rate-limit pauses.
    const freshSince = new Date(Date.now() - 90_000).toISOString();
    const { data: positions } = await supabaseAdmin
      .from("player_positions")
      .select("roblox_username, roblox_username_lower, roblox_id, x, z, team, updated_at")
      .neq("roblox_username_lower", SYNC_ROW)
      .gte("updated_at", freshSince);
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
