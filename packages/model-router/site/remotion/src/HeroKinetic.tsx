import { loadFont as loadArchivo } from "@remotion/google-fonts/Archivo";
import { loadFont as loadMono } from "@remotion/google-fonts/IBMPlexMono";
import {
  AbsoluteFill,
  interpolate,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const { fontFamily: display } = loadArchivo();
const { fontFamily: mono } = loadMono();

const C = { paper: "#f4f1ea", ink: "#16140f", dim: "#6b6658", sig: "#e8490f" };

export const SCENE_LEN = 216;

type Kind = "selected" | "fallback" | "rejected";
interface M { name: string; kind: Kind; note: string; stamp?: string }
interface V {
  task: string;
  chips: string[];
  policy: string;
  est: string;
  models: M[];
}

const VIGNETTES: V[] = [
  {
    task: "recipe.extract", chips: ["text+image", "structured", "cheapest"], policy: "policy · cheapest", est: "$0.0021",
    models: [
      { name: "gemini-2.5-flash", kind: "selected", note: "selected" },
      { name: "claude-haiku-4-5", kind: "fallback", note: "fallback" },
      { name: "claude-opus-4-8", kind: "rejected", note: "over budget", stamp: "✕" },
      { name: "qwen3.6", kind: "rejected", note: "no images", stamp: "✕" },
    ],
  },
  {
    task: "code.fix", chips: ["text", "tools", "best @ swe-bench"], policy: "policy · swe-bench", est: "$0.42",
    models: [
      { name: "claude-opus-4-8", kind: "selected", note: "swe-bench 0.78" },
      { name: "gpt-5", kind: "fallback", note: "0.72" },
      { name: "qwen3.6", kind: "fallback", note: "0.61" },
      { name: "gemini-2.5-flash", kind: "fallback", note: "0.54" },
    ],
  },
  {
    task: '"fix the auth bug"', chips: ["raw prompt", "llm judge"], policy: "llm judge → coding", est: "$0.31",
    models: [
      { name: "claude-opus-4-8", kind: "selected", note: "verdict: coding" },
      { name: "gpt-5", kind: "fallback", note: "fallback" },
      { name: "gemini-2.5-flash", kind: "fallback", note: "fallback" },
      { name: "qwen3.6", kind: "fallback", note: "fallback" },
    ],
  },
  {
    task: "news.brief", chips: ["text", "web search", "fastest"], policy: "policy · fastest", est: "$0.0089",
    models: [
      { name: "gemini-2.5-flash", kind: "selected", note: "selected" },
      { name: "sonar-pro", kind: "fallback", note: "fallback" },
      { name: "gpt-5", kind: "rejected", note: "too slow", stamp: "✕" },
      { name: "qwen3.6", kind: "rejected", note: "no web search", stamp: "✕" },
    ],
  },
];

export const HEROK_DURATION = VIGNETTES.length * SCENE_LEN;

const CURVE = "M 150 690 C 380 690, 400 360, 720 312";
const S = {
  fadeIn: [0, 12] as const,
  task: 2,
  chips: 14,
  curve: [30, 74] as const,
  policy: 58,
  selected: 80,
  alsoRans: [92, 104, 116] as const,
  meta: 122,
  // hold the fully-revealed plan ~2.5s (122 -> 198) before fading, so viewers can read it
  fadeOut: [198, 216] as const,
};

const usePop = (start: number) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - start, fps, config: { damping: 13, mass: 0.7 } });
};

const Pill: React.FC<{
  children: React.ReactNode; start: number; x: number; y: number;
  filled?: boolean; outlineColor?: string; faded?: boolean; size?: number;
}> = ({ children, start, x, y, filled, outlineColor = C.ink, faded, size = 17 }) => {
  const pop = usePop(start);
  return (
    <div style={{
      position: "absolute", left: x, top: y, fontFamily: mono, fontSize: size,
      padding: "9px 18px", borderRadius: 40, whiteSpace: "nowrap",
      border: `2px solid ${filled ? C.ink : outlineColor}`,
      background: filled ? C.ink : C.paper, color: filled ? C.paper : outlineColor,
      opacity: (faded ? 0.5 : 1) * pop, transform: `translateY(${(1 - pop) * 16}px)`,
    }}>{children}</div>
  );
};

const ChipInline: React.FC<{ label: string; start: number; signal?: boolean }> = ({ label, start, signal }) => {
  const pop = usePop(start);
  const color = signal ? C.sig : C.ink;
  return (
    <span style={{
      fontFamily: mono, fontSize: 16, padding: "8px 16px", borderRadius: 40,
      border: `2px solid ${color}`, color, whiteSpace: "nowrap",
      opacity: pop, transform: `translateY(${(1 - pop) * 14}px)`, display: "inline-block",
    }}>{label}</span>
  );
};

const Scene: React.FC<{ v: V }> = ({ v }) => {
  const frame = useCurrentFrame();
  const opacity =
    interpolate(frame, S.fadeIn, [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) *
    interpolate(frame, S.fadeOut, [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const taskPop = usePop(S.task);
  const drawn = interpolate(frame, S.curve, [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const arrow = usePop(S.selected);
  const metaOpacity = interpolate(frame, [S.meta, S.meta + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const selected = v.models.find((m) => m.kind === "selected")!;
  const others = v.models.filter((m) => m.kind !== "selected");
  const fb = v.models.filter((m) => m.kind === "fallback").length;
  const rj = v.models.filter((m) => m.kind === "rejected").length;

  return (
    <AbsoluteFill style={{ opacity }}>
      {/* task headline */}
      <div style={{
        position: "absolute", left: 90, top: 150, fontFamily: display, fontWeight: 800,
        fontSize: 62, letterSpacing: "-0.03em", color: C.ink, maxWidth: 760, lineHeight: 1,
        opacity: taskPop, transform: `translateY(${(1 - taskPop) * 24}px)`,
      }}>{v.task}</div>
      <div style={{ position: "absolute", left: 90, top: 252, display: "flex", gap: 10, flexWrap: "wrap", maxWidth: 600 }}>
        {v.chips.map((c, i) => (
          <ChipInline key={c} label={c} start={S.chips + i * 7} signal={i === v.chips.length - 1} />
        ))}
      </div>

      {/* swoosh curve */}
      <svg viewBox="0 0 1200 900" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        {/* faint branches to the also-rans — shown, but subordinate to the swoosh */}
        {others.map((m, i) => {
          const cy = 408 + i * 52;
          const op = m.kind === "rejected" ? 0.15 : 0.32;
          return (
            <g key={m.name} opacity={op}>
              <path d={`M455 500 C 600 500, 626 ${cy}, 726 ${cy}`} pathLength={1} fill="none"
                stroke={C.ink} strokeWidth={2.4} strokeLinecap="round" strokeDasharray={`${drawn} 1`} />
              <circle cx={726} cy={cy} r={4} fill={C.ink} opacity={drawn >= 0.92 ? 1 : 0} />
            </g>
          );
        })}
        <path d={CURVE} pathLength={1} fill="none" stroke={C.sig} strokeWidth={7}
          strokeLinecap="round" strokeDasharray={`${drawn} 1`} opacity={0.22} />
        <path d={CURVE} pathLength={1} fill="none" stroke={C.sig} strokeWidth={7}
          strokeLinecap="round" strokeDasharray="0.02 0.026" strokeDashoffset={-frame * 0.01}
          opacity={drawn >= 0.04 ? 1 : 0} clipPath="url(#reveal)" />
        <defs>
          <clipPath id="reveal"><rect x="0" y="0" width={interpolate(drawn, [0, 1], [150, 760])} height="900" /></clipPath>
        </defs>
        <g opacity={arrow} transform={`translate(706 314) rotate(-9) scale(${0.6 + arrow * 0.4})`}>
          <path d="M34 0 L -10 -18 L -10 18 Z" fill={C.sig} />
        </g>
      </svg>

      {/* policy node on the curve */}
      <Pill start={S.policy} x={372} y={476} outlineColor={C.sig} size={16}>{v.policy}</Pill>

      {/* selected model */}
      <Pill start={S.selected} x={732} y={286} filled size={20}>▸ {selected.name}</Pill>
      <div style={{
        position: "absolute", left: 740, top: 340, fontFamily: mono, fontSize: 15, color: C.dim,
        opacity: usePop(S.selected + 6),
      }}>{selected.note}</div>

      {/* also-rans */}
      {others.map((m, i) => (
        <div key={m.name} style={{
          position: "absolute", left: 740, top: 396 + i * 52, display: "flex", alignItems: "center", gap: 12,
          fontFamily: mono, fontSize: 17, opacity: (m.kind === "rejected" ? 0.5 : 1) * usePop(S.alsoRans[Math.min(i, 2)] ?? 116),
        }}>
          <span style={{ color: m.kind === "rejected" ? C.sig : C.ink, width: 16 }}>{m.stamp ?? "·"}</span>
          <span style={{ color: C.ink, fontWeight: 500 }}>{m.name}</span>
          <span style={{ color: C.dim, fontSize: 14 }}>{m.note}</span>
        </div>
      ))}

      {/* meta */}
      <div style={{
        position: "absolute", left: 90, right: 90, bottom: 44, display: "flex", justifyContent: "space-between",
        fontFamily: mono, fontSize: 19, color: C.dim, borderTop: `3px solid ${C.ink}`, paddingTop: 16, opacity: metaOpacity,
      }}>
        <span>plan ▸ <span style={{ color: C.ink, fontWeight: 600 }}>{selected.name}</span> · {fb} fallback · {rj} rejected</span>
        <span>est. <span style={{ color: C.ink, fontWeight: 600 }}>{v.est}</span></span>
      </div>
    </AbsoluteFill>
  );
};

export const HeroKinetic: React.FC = () => (
  <AbsoluteFill style={{ background: C.paper, fontFamily: mono, color: C.ink }}>
    {VIGNETTES.map((v, i) => (
      <Sequence key={v.task} from={i * SCENE_LEN} durationInFrames={SCENE_LEN}>
        <Scene v={v} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
