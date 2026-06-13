import { loadFont } from "@remotion/google-fonts/IBMPlexMono";
import {
  AbsoluteFill,
  interpolate,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const { fontFamily } = loadFont();

const C = {
  paper: "#f2efe6",
  ink: "#17140e",
  inkSoft: "#4f4a3d",
  signal: "#e8490f",
  hold: "#b07c00",
};

export const SCENE_LEN = 150;

type Kind = "selected" | "fallback" | "rejected";

interface ModelSpec {
  name: string;
  kind: Kind;
  note: string; // fallback label or rejection reason
  stamp?: string; // short rejected stamp
}

interface Vignette {
  task: string;
  chips: { label: string; signal?: boolean }[];
  est: string;
  models: ModelSpec[];
  policyLabel?: string;
  policySub?: string;
}

// Each scene cycles the task, the constraint chips, the policy outcome, and the
// resulting routing — so the hero shows the router working across situations.
const VIGNETTES: Vignette[] = [
  {
    task: "recipe.extract",
    chips: [{ label: "text+image" }, { label: "structured" }, { label: "cheapest", signal: true }],
    est: "$0.0021",
    models: [
      { name: "gemini-2.5-flash", kind: "selected", note: "selected" },
      { name: "claude-haiku-4-5", kind: "fallback", note: "fallback" },
      { name: "claude-opus-4-8", kind: "rejected", note: "over budget", stamp: "OVER BUDGET" },
      { name: "qwen3.6", kind: "rejected", note: "no image input", stamp: "NO IMAGES" },
    ],
  },
  {
    task: "code.fix",
    chips: [{ label: "text" }, { label: "tools" }, { label: "best @ swe-bench", signal: true }],
    est: "$0.42",
    policySub: "swe-bench",
    models: [
      { name: "claude-opus-4-8", kind: "selected", note: "swe-bench 0.78" },
      { name: "gpt-5", kind: "fallback", note: "swe-bench 0.72" },
      { name: "qwen3.6", kind: "fallback", note: "swe-bench 0.61" },
      { name: "gemini-2.5-flash", kind: "fallback", note: "swe-bench 0.54" },
    ],
  },
  {
    task: '"fix the auth bug"',
    chips: [{ label: "raw prompt" }, { label: "llm judge", signal: true }],
    est: "$0.31",
    policyLabel: "llm judge",
    policySub: "→ coding",
    models: [
      { name: "claude-opus-4-8", kind: "selected", note: "verdict: coding" },
      { name: "gpt-5", kind: "fallback", note: "fallback" },
      { name: "gemini-2.5-flash", kind: "fallback", note: "fallback" },
      { name: "qwen3.6", kind: "fallback", note: "fallback" },
    ],
  },
  {
    task: "news.brief",
    chips: [{ label: "text" }, { label: "web search" }, { label: "fastest", signal: true }],
    est: "$0.0089",
    policySub: "fastest",
    models: [
      { name: "gemini-2.5-flash", kind: "selected", note: "selected" },
      { name: "sonar-pro", kind: "fallback", note: "fallback" },
      { name: "gpt-5", kind: "rejected", note: "slower than policy", stamp: "TOO SLOW" },
      { name: "qwen3.6", kind: "rejected", note: "no web search", stamp: "NO WEB SEARCH" },
    ],
  },
];

export const HERO_DURATION = VIGNETTES.length * SCENE_LEN;

const ROWS = [160, 355, 550, 745];
const NODE_X = 820;
const NODE_W = 310;
const NODE_H = 110;
const POLICY = { x: 520, y: 450 };

// Per-scene timeline (frames, relative to scene start).
const S = {
  fadeIn: [0, 12] as const,
  card: 4,
  chips: 18,
  diamond: 26,
  wireStart: 46,
  wireLen: 24,
  nodes: [58, 70, 82, 94] as const,
  select: 100,
  stamps: [108, 118] as const,
  meta: 122,
  fadeOut: [134, 150] as const,
};

const wirePath = (cy: number): string =>
  `M ${POLICY.x + 70} ${POLICY.y} C 700 ${POLICY.y}, 700 ${cy}, ${NODE_X} ${cy}`;

const useSpring = (start: number) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - start, fps, config: { damping: 13, mass: 0.7 } });
};

const Chip: React.FC<{ label: string; start: number; signal?: boolean }> = ({
  label,
  start,
  signal,
}) => {
  const pop = useSpring(start);
  const color = signal ? C.signal : C.ink;
  return (
    <span
      style={{
        display: "inline-block",
        border: `2px solid ${color}`,
        color,
        padding: "4px 12px",
        fontSize: 19,
        letterSpacing: "0.06em",
        marginRight: 10,
        opacity: pop,
        transform: `translateY(${(1 - pop) * 14}px)`,
      }}
    >
      {label}
    </span>
  );
};

const Wire: React.FC<{ cy: number; kind: Kind }> = ({ cy, kind }) => {
  const frame = useCurrentFrame();
  const d = wirePath(cy);
  const drawn = interpolate(frame, [S.wireStart, S.wireStart + S.wireLen], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const live = frame >= S.select;
  if (live && kind === "selected") {
    return (
      <path
        d={d}
        pathLength={1}
        fill="none"
        stroke={C.signal}
        strokeWidth={5}
        strokeDasharray="0.045 0.03"
        strokeDashoffset={-frame * 0.006}
      />
    );
  }
  const dead = live && kind === "rejected";
  const stroke = dead ? C.inkSoft : C.ink;
  return (
    <path
      d={d}
      pathLength={1}
      fill="none"
      stroke={stroke}
      strokeWidth={3}
      strokeDasharray={dead ? "0.012 0.03" : `${drawn} 1`}
      opacity={dead ? 0.4 : 1}
    />
  );
};

const Node: React.FC<{ spec: ModelSpec; index: number }> = ({ spec, index }) => {
  const frame = useCurrentFrame();
  const pop = useSpring(S.nodes[index] ?? 0);
  const selected = spec.kind === "selected" && frame >= S.select;
  const stampStart = S.stamps[0] + index * 6;
  const stampPop = useSpring(stampStart);
  const showStamp = spec.kind === "rejected" && frame >= stampStart;
  const showNote = frame >= S.meta || selected;
  return (
    <div
      style={{
        position: "absolute",
        left: NODE_X,
        top: (ROWS[index] ?? 0) - NODE_H / 2,
        width: NODE_W,
        height: NODE_H,
        border: `3px solid ${C.ink}`,
        background: selected ? C.ink : C.paper,
        color: selected ? C.paper : C.ink,
        padding: "18px 22px",
        boxSizing: "border-box",
        opacity: pop,
        transform: `scale(${0.85 + pop * 0.15})`,
      }}
    >
      <div style={{ fontSize: 25, fontWeight: 600 }}>{spec.name}</div>
      <div
        style={{
          fontSize: 19,
          marginTop: 6,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: selected ? "#4ade80" : spec.kind === "rejected" ? C.signal : C.hold,
          opacity: showNote ? 1 : 0,
        }}
      >
        {selected ? `▸ ${spec.note}` : spec.note}
      </div>
      {showStamp ? (
        <div
          style={{
            position: "absolute",
            right: -18,
            top: 54,
            border: `4px solid ${C.signal}`,
            color: C.signal,
            background: C.paper,
            padding: "6px 14px",
            fontSize: 21,
            fontWeight: 600,
            letterSpacing: "0.1em",
            transform: `rotate(-7deg) scale(${2 - stampPop})`,
            opacity: stampPop,
          }}
        >
          ✕ {spec.stamp}
        </div>
      ) : null}
    </div>
  );
};

const Scene: React.FC<{ v: Vignette }> = ({ v }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const opacity =
    interpolate(frame, S.fadeIn, [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) *
    interpolate(frame, S.fadeOut, [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const cardPop = spring({ frame: frame - S.card, fps, config: { damping: 14 } });
  const diamondPop = spring({ frame: frame - S.diamond, fps, config: { damping: 12, mass: 0.8 } });
  const selectedHappened = frame >= S.select;
  const metaOpacity = interpolate(frame, [S.meta, S.meta + 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const selected = v.models.find((m) => m.kind === "selected");
  const fallbacks = v.models.filter((m) => m.kind === "fallback").length;
  const rejected = v.models.filter((m) => m.kind === "rejected").length;

  return (
    <AbsoluteFill style={{ opacity }}>
      <svg viewBox="0 0 1200 900" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        <Wire cy={POLICY.y} kind={selectedHappened ? "selected" : "fallback"} />
        {v.models.map((m, i) => (
          <Wire key={m.name} cy={ROWS[i]!} kind={m.kind} />
        ))}
      </svg>

      {/* task card */}
      <div
        style={{
          position: "absolute",
          left: 70,
          top: 365,
          width: 320,
          border: `3px solid ${C.ink}`,
          background: C.paper,
          padding: "20px 24px",
          opacity: cardPop,
          transform: `translateY(${(1 - cardPop) * 24}px)`,
        }}
      >
        <div style={{ fontSize: 22, color: C.inkSoft }}>task:</div>
        <div style={{ fontSize: 27, fontWeight: 600, color: C.signal }}>{v.task}</div>
      </div>
      <div style={{ position: "absolute", left: 70, top: 520, width: 420 }}>
        {v.chips.map((chip, i) => (
          <Chip key={chip.label} label={chip.label} start={S.chips + i * 8} signal={chip.signal} />
        ))}
      </div>

      {/* policy diamond */}
      <div
        style={{
          position: "absolute",
          left: POLICY.x - 62,
          top: POLICY.y - 62,
          width: 124,
          height: 124,
          border: `3px solid ${C.signal}`,
          background: C.paper,
          transform: `rotate(45deg) scale(${diamondPop})`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: POLICY.x - 80,
          top: POLICY.y - 26,
          width: 160,
          textAlign: "center",
          fontSize: 21,
          color: C.signal,
          opacity: diamondPop,
        }}
      >
        {v.policyLabel ?? "policy"}
        <div style={{ fontSize: 16, color: C.inkSoft }}>{v.policySub ?? "filters"}</div>
      </div>

      {v.models.map((m, i) => (
        <Node key={m.name} spec={m} index={i} />
      ))}

      {/* bottom estimate strip */}
      <div
        style={{
          position: "absolute",
          left: 70,
          right: 70,
          bottom: 28,
          display: "flex",
          justifyContent: "space-between",
          borderTop: `3px solid ${C.ink}`,
          paddingTop: 16,
          fontSize: 22,
          letterSpacing: "0.04em",
          color: C.inkSoft,
          opacity: metaOpacity,
        }}
      >
        <span>
          plan ▸ <span style={{ color: C.ink, fontWeight: 600 }}>{selected?.name}</span> ·{" "}
          {fallbacks} fallback · {rejected} rejected
        </span>
        <span>
          est. <span style={{ color: C.ink, fontWeight: 600 }}>{v.est}</span>
        </span>
      </div>
    </AbsoluteFill>
  );
};

export const Hero: React.FC = () => (
  <AbsoluteFill
    style={{
      background: C.paper,
      backgroundImage: `linear-gradient(rgba(23,20,14,0.05) 1.5px, transparent 1.5px), linear-gradient(90deg, rgba(23,20,14,0.05) 1.5px, transparent 1.5px)`,
      backgroundSize: "48px 48px",
      fontFamily,
      color: C.ink,
    }}
  >
    {VIGNETTES.map((v, i) => (
      <Sequence key={v.task} from={i * SCENE_LEN} durationInFrames={SCENE_LEN}>
        <Scene v={v} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
