"use client";

import { animate, useInView, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/* ---------------- spotlight ---------------- */

/** Pointer handler that moves a card's `spotlight` glow (see globals.css) under the cursor. */
export function useSpotlight() {
  return useCallback((e: React.PointerEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  }, []);
}

/* ---------------- stat strip ---------------- */

function CountUp({ to }: { to: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const still = useReducedMotion() ?? false;
  const [n, setN] = useState(still ? to : 0);

  useEffect(() => {
    if (!inView || still) return;
    const controls = animate(0, to, {
      duration: 1.1,
      ease: "easeOut",
      onUpdate: (v) => setN(Math.round(v)),
    });
    return () => controls.stop();
  }, [inView, still, to]);

  return (
    <span ref={ref} className="tabular-nums">
      {still ? to : n}
    </span>
  );
}

export function StatStrip({
  stats,
}: {
  stats: { value: number; label: string }[];
}) {
  return (
    <dl className="mx-auto grid max-w-3xl grid-cols-2 sm:grid-cols-4">
      {stats.map((s, i) => (
        <div
          key={s.label}
          className={cn(
            "flex flex-col items-center gap-0.5 px-2 py-3 text-center",
            i > 0 && "sm:border-l sm:border-card-edge",
            i % 2 === 1 && "max-sm:border-l max-sm:border-card-edge",
          )}
        >
          <dt className="order-2 text-xs text-muted-foreground">{s.label}</dt>
          <dd className="order-1 font-montserrat text-3xl font-semibold tracking-tight">
            <CountUp to={s.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------------- typewriter hint ---------------- */

/**
 * Types the example questions into an empty composer, one after another, as a hint.
 * Decorative: screen readers get the textarea's own label. Reduced motion shows the
 * first question whole.
 */
export function TypewriterHint({
  lines,
  className,
}: {
  lines: string[];
  className?: string;
}) {
  const still = useReducedMotion() ?? false;
  const [line, setLine] = useState(0);
  const [len, setLen] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (still) return;
    const full = lines[line];
    let delay = deleting ? 18 : 38;
    if (!deleting && len === full.length) delay = 2200; // read pause
    if (deleting && len === 0) delay = 350;
    const t = setTimeout(() => {
      if (!deleting && len === full.length) setDeleting(true);
      else if (deleting && len === 0) {
        setDeleting(false);
        setLine((l) => (l + 1) % lines.length);
      } else setLen((n) => n + (deleting ? -1 : 1));
    }, delay);
    return () => clearTimeout(t);
  }, [still, lines, line, len, deleting]);

  const text = still ? lines[0] : lines[line].slice(0, len);
  return (
    <span
      aria-hidden
      className={cn("pointer-events-none select-none", className)}
    >
      {text}
      {!still && (
        <span className="ml-px inline-block h-[1.1em] w-px translate-y-[0.2em] bg-muted-foreground motion-safe:animate-pulse" />
      )}
    </span>
  );
}
