import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Mic, MicOff } from "lucide-react";

import { SummerMap, type MapMarker } from "@/components/SummerMap";
import { Button } from "@/components/ui/button";
import { useProximityVoice, type PeerVolume } from "@/hooks/useProximityVoice";
import { supabase } from "@/integrations/supabase/client";
import { getMyProfile } from "@/lib/roblox.functions";
import { getLivePlayers } from "@/lib/positions.functions";
import { distanceMeters, type WorldPosition } from "@/lib/proximity";

export const Route = createFileRoute("/_authenticated/live")({
  head: () => ({
    meta: [
      { title: "الخريطة المباشرة — صوت المقاطعة" },
      { name: "description", content: "مكانك واللاعبين حولك مباشرة، والصوت حسب المسافة." },
      { property: "og:title", content: "الخريطة المباشرة — صوت المقاطعة" },
      { property: "og:description", content: "مكانك واللاعبين حولك مباشرة، والصوت حسب المسافة." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LivePage,
});

function LivePage() {
  const { user } = Route.useRouteContext();
  const fetchProfile = useServerFn(getMyProfile);
  const fetchPlayers = useServerFn(getLivePlayers);
  const { data: profile, isLoading } = useQuery({ queryKey: ["profile"], queryFn: () => fetchProfile() });
  const { data } = useQuery({
    queryKey: ["live-players"],
    queryFn: () => fetchPlayers(),
    refetchInterval: 3000,
    enabled: !!profile?.roblox_username,
  });
  const voice = useProximityVoice(profile?.roblox_username ? user.id : null);
  const [volumes, setVolumes] = useState<PeerVolume[]>([]);

  const players = data?.players ?? [];
  const meName = profile?.roblox_username?.toLowerCase();
  const me = players.find((p) => p.username.toLowerCase() === meName) ?? null;
  const mePos: WorldPosition | null = me ? { x: me.x, y: 0, z: me.z } : null;

  useEffect(() => {
    const others = new Map<string, WorldPosition>();
    for (const p of players) if (p.userId && p.userId !== user.id) others.set(p.userId, { x: p.x, y: 0, z: p.z });
    setVolumes(voice.applyDistances(mePos, others));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, voice.connectedPeers]);

  const volumeOf = (uid: string | null) => volumes.find((v) => v.userId === uid)?.volume ?? 0;

  const markers: MapMarker[] = useMemo(
    () =>
      players.map((p) => ({
        id: p.username,
        x: p.x,
        z: p.z,
        label: p.username,
        kind: p.username.toLowerCase() === meName ? "me" : p.userId ? "linked" : "other",
        volume: volumeOf(p.userId),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [players, volumes, meName],
  );

  const nearby = players
    .filter((p) => p.userId && p.userId !== user.id && mePos)
    .map((p) => ({ ...p, meters: distanceMeters(mePos!, { x: p.x, y: 0, z: p.z }), vol: volumeOf(p.userId) }))
    .sort((a, b) => a.meters - b.meters);

  if (isLoading) return <div className="p-10 text-center text-muted-foreground">جاري التحميل…</div>;

  if (!profile?.roblox_username) {
    return (
      <main className="mx-auto max-w-md px-6 py-20 text-center">
        <h1 className="text-2xl font-bold">باقي خطوة</h1>
        <p className="mt-2 text-muted-foreground">اربط حساب روبلكس عشان نعرف مكانك.</p>
        <Button asChild className="mt-6"><Link to="/link">اربط روبلكس</Link></Button>
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col gap-3 bg-background p-3 md:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-3 md:w-80">
        <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4">
          {profile.discord_avatar_url && <img src={profile.discord_avatar_url} alt="" className="h-12 w-12 rounded-full" />}
          <div className="min-w-0 flex-1">
            <div className="truncate font-bold">{profile.discord_username}</div>
            <div dir="ltr" className="truncate text-right text-sm text-muted-foreground">@{profile.roblox_username}</div>
          </div>
          <button className="text-xs text-muted-foreground underline" onClick={() => supabase.auth.signOut().then(() => (window.location.href = "/"))}>خروج</button>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4">
          <Button
            size="lg"
            variant={voice.micOn ? "default" : "outline"}
            className={`w-full ${voice.speaking ? "shadow-[var(--shadow-glow)]" : ""}`}
            onClick={voice.micOn ? voice.stopMic : voice.startMic}
          >
            {voice.micOn ? <Mic /> : <MicOff />}
            {voice.micOn ? "المايك شغال" : "شغّل المايك"}
          </Button>
          {voice.error && <p className="mt-2 text-sm text-destructive">{voice.error}</p>}
          <p className="mt-3 text-sm text-muted-foreground">
            {me ? "أنت ظاهر في الخريطة." : "ما لقيناك في السيرفر — ادخل اللعبة وانتظر ثواني."}
          </p>
          {data?.error && <p className="mt-2 text-sm text-destructive">{data.error}</p>}
        </div>

        <div className="flex-1 overflow-auto rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-3 font-bold">القريبين منك</h2>
          {nearby.length === 0 && <p className="text-sm text-muted-foreground">ما في أحد مربوط قريب منك.</p>}
          <ul className="space-y-2">
            {nearby.map((p) => (
              <li key={p.username} className="flex items-center gap-3">
                {p.avatar && <img src={p.avatar} alt="" className="h-8 w-8 rounded-full bg-secondary" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{p.username}</div>
                  <div className="h-1.5 rounded-full bg-secondary">
                    <div className="h-1.5 rounded-full bg-primary transition-all" style={{ width: `${Math.round(p.vol * 100)}%` }} />
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">{Math.round(p.meters)} م</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section className="min-h-[50vh] flex-1">
        <SummerMap markers={markers} focus={me ? { x: me.x, z: me.z } : null} />
      </section>
    </main>
  );
}
