import { useEffect, useRef, useState } from "react";

import { SUMMER_MAP, worldToMapPx } from "@/lib/proximity";

export type MapMarker = {
  id: string;
  x: number;
  z: number;
  label: string;
  kind: "me" | "linked" | "other";
  volume?: number;
};

type View = { cx: number; cy: number; scale: number }; // map px at center, screen px per map px

/** Tile viewer for the erlc-tools.com summer map pyramid, with pan + zoom. */
export function SummerMap({ markers, focus }: { markers: MapMarker[]; focus?: { x: number; z: number } | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View>({ cx: SUMMER_MAP.mapPx / 2, cy: SUMMER_MAP.mapPx / 2, scale: 0.03 });
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const focused = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setView((v) => ({ ...v, scale: Math.min(el.clientWidth, el.clientHeight) / SUMMER_MAP.mapPx }));
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!focus || focused.current) return;
    focused.current = true;
    const { px, py } = worldToMapPx(focus);
    setView((v) => ({ cx: px, cy: py, scale: Math.max(v.scale, 0.35) }));
  }, [focus]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const scale = Math.min(2, Math.max(0.01, v.scale * factor));
        const mx = v.cx + (sx - rect.width / 2) / v.scale;
        const my = v.cy + (sy - rect.height / 2) / v.scale;
        return { scale, cx: mx - (sx - rect.width / 2) / scale, cy: my - (sy - rect.height / 2) / scale };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // pick tile level so tiles render near native resolution
  let level = 0;
  for (let z = 0; z <= SUMMER_MAP.maxLevel; z++) {
    const cover = SUMMER_MAP.mapPx / (SUMMER_MAP.grid[z] ?? 1);
    level = z;
    if (cover * view.scale <= SUMMER_MAP.tileSize * 1.2) break;
  }
  const grid: number = SUMMER_MAP.grid[level] ?? 1;
  const cover = SUMMER_MAP.mapPx / grid;
  const left = view.cx - size.w / 2 / view.scale;
  const top = view.cy - size.h / 2 / view.scale;
  const right = view.cx + size.w / 2 / view.scale;
  const bottom = view.cy + size.h / 2 / view.scale;
  const tiles: { x: number; y: number }[] = [];
  for (let ty = Math.max(0, Math.floor(top / cover)); ty <= Math.min(grid - 1, Math.floor(bottom / cover)); ty++) {
    for (let tx = Math.max(0, Math.floor(left / cover)); tx <= Math.min(grid - 1, Math.floor(right / cover)); tx++) {
      tiles.push({ x: tx, y: ty });
    }
  }
  const toScreen = (mx: number, my: number) => ({
    left: (mx - view.cx) * view.scale + size.w / 2,
    top: (my - view.cy) * view.scale + size.h / 2,
  });

  const zoomBy = (f: number) => setView((v) => ({ ...v, scale: Math.min(2, Math.max(0.01, v.scale * f)) }));

  return (
    <div
      ref={ref}
      dir="ltr"
      className="relative h-full w-full cursor-grab touch-none select-none overflow-hidden rounded-2xl bg-secondary active:cursor-grabbing"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        setView((v) => ({ ...v, cx: d.cx - (e.clientX - d.x) / v.scale, cy: d.cy - (e.clientY - d.y) / v.scale }));
      }}
      onPointerUp={() => (drag.current = null)}
    >
      {tiles.map((t) => {
        const p = toScreen(t.x * cover, t.y * cover);
        return (
          <img
            key={`${level}-${t.x}-${t.y}`}
            src={SUMMER_MAP.tileUrl(level, t.x, t.y)}
            alt=""
            draggable={false}
            onError={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = "hidden")}
            className="pointer-events-none absolute max-w-none"
            style={{ left: p.left, top: p.top, width: cover * view.scale + 1, height: cover * view.scale + 1 }}
          />
        );
      })}

      {markers.map((m) => {
        const { px, py } = worldToMapPx(m);
        const p = toScreen(px, py);
        const color =
          m.kind === "me" ? "bg-primary ring-primary/40" : m.kind === "linked" ? "bg-accent ring-accent/40" : "bg-muted-foreground ring-muted-foreground/30";
        return (
          <div key={m.id} className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2" style={p}>
            <div className={`h-3.5 w-3.5 rounded-full ring-4 ${color}`} style={m.kind === "linked" ? { opacity: 0.4 + 0.6 * (m.volume ?? 0) } : undefined} />
            <div className="mt-1 -translate-x-1/4 whitespace-nowrap rounded bg-card/90 px-1.5 py-0.5 text-[11px] font-semibold text-card-foreground shadow">
              {m.label}
            </div>
          </div>
        );
      })}

      <div className="absolute bottom-3 left-3 flex flex-col gap-1">
        <button onClick={() => zoomBy(1.5)} className="h-9 w-9 rounded-lg bg-card text-lg font-bold text-card-foreground shadow">+</button>
        <button onClick={() => zoomBy(1 / 1.5)} className="h-9 w-9 rounded-lg bg-card text-lg font-bold text-card-foreground shadow">−</button>
      </div>
      <div className="absolute bottom-2 right-3 text-[10px] text-muted-foreground">Map: erlc-tools.com · © Police Roleplay Community</div>
    </div>
  );
}
