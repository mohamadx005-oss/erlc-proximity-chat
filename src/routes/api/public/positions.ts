import { createFileRoute } from "@tanstack/react-router";

type IncomingPlayer = {
  username?: string;
  userId?: number | string;
  x?: number;
  y?: number;
  z?: number;
  team?: string;
  inVehicle?: boolean;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Live position ingest. Called by the in-game Roblox script every ~1s.
 * Auth: shared secret in the `x-ingest-key` header.
 */
export const Route = createFileRoute("/api/public/positions")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["ERLC_INGEST_SECRET"];
        if (!expected) return json({ error: "ingest_not_configured" }, 503);

        const provided = request.headers.get("x-ingest-key") ?? "";
        if (!timingSafeEqual(provided, expected)) return json({ error: "unauthorized" }, 401);

        let body: { players?: IncomingPlayer[] };
        try {
          body = (await request.json()) as { players?: IncomingPlayer[] };
        } catch {
          return json({ error: "invalid_json" }, 400);
        }

        const players = Array.isArray(body.players) ? body.players.slice(0, 100) : [];
        const rows = players
          .filter(
            (p) =>
              typeof p.username === "string" &&
              p.username.length > 0 &&
              Number.isFinite(Number(p.x)) &&
              Number.isFinite(Number(p.y)) &&
              Number.isFinite(Number(p.z)),
          )
          .map((p) => ({
            roblox_username_lower: String(p.username).toLowerCase(),
            roblox_username: String(p.username),
            roblox_id: p.userId != null ? Number(p.userId) : null,
            x: Number(p.x),
            y: Number(p.y),
            z: Number(p.z),
            team: typeof p.team === "string" ? p.team.slice(0, 40) : null,
            in_vehicle: Boolean(p.inVehicle),
            updated_at: new Date().toISOString(),
          }));

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        if (rows.length > 0) {
          const { error } = await supabaseAdmin
            .from("player_positions")
            .upsert(rows, { onConflict: "roblox_username_lower" });
          if (error) {
            console.error("position upsert failed", error);
            return json({ error: "save_failed" }, 500);
          }
        }

        // Drop anyone who left the server so they disappear from the map.
        const staleCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
        await supabaseAdmin.from("player_positions").delete().lt("updated_at", staleCutoff);

        return json({ ok: true, saved: rows.length });
      },
    },
  },
});
