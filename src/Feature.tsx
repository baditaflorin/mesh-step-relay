import { useEffect, useRef } from "react";
import {
  ArmGate,
  Leaderboard,
  useConfetti,
  useDeadline,
  useEventLog,
  useExpiringClaim,
  useFlashOnChange,
  useNamedPeer,
  usePerPeerValue,
  useRoster,
  useStepCount,
  type MeshConfig,
  type YRoom,
} from "@baditaflorin/mesh-common";

type Props = { room: YRoom | null; config: MeshConfig };
type StepRec = { count: number; ts: number };
type RelayEvent = { id: string; peerId: string; type: "claim" | "pass" | "drop"; ts: number };

const TTL_MS = 60_000;
const DEFAULT_TARGET = 25;
const newId = () => Math.random().toString(36).slice(2, 12);

/**
 * The next peer after `from` in a sorted, cyclic roster. With `from` absent
 * (or the only peer gone), falls back to the first present peer. Returns null
 * if nobody is present. Deterministic across peers because `present` is sorted
 * identically everywhere, so every peer agrees on who is "next" — that's what
 * lets each peer *self*-claim its own turn without a central writer (the
 * useExpiringClaim API only lets a peer claim for itself, never for another).
 */
function nextPeer(present: string[], from: string | null): string | null {
  if (present.length === 0) return null;
  if (!from) return present[0]!;
  const i = present.indexOf(from);
  if (i === -1) return present[0]!;
  return present[(i + 1) % present.length]!;
}

export function Feature({ room, config }: Props) {
  if (!room)
    return (
      <div className="relay-screen">
        <h1>step relay</h1>
        <p className="relay-status">Connecting…</p>
      </div>
    );
  return <Body room={room} config={config} />;
}

function Body({ room, config }: { room: YRoom; config: MeshConfig }) {
  const { name, setName, nameOf } = useNamedPeer(config, room);
  const baton = useExpiringClaim(room, "baton", TTL_MS);
  const steps = usePerPeerValue<StepRec>(room, "steps", { count: 0, ts: 0 });
  const log = useEventLog<RelayEvent>(room, "relay");
  const roster = useRoster(room);
  const state = room.doc.getMap<string | number>("state");
  const target = (state.get("target") as number | undefined) ?? DEFAULT_TARGET;
  const { burst } = useConfetti();
  const flashHolder = useFlashOnChange(baton.claimedBy);
  const deadline = useDeadline(baton.claimedBy ? Date.now() + baton.msRemaining : null, {
    tickMs: 250,
  });
  const myCount = steps.my.count;
  const reachedTarget = myCount >= target;
  const reachedRef = useRef(false);

  // The peer the baton last belonged to (the relay anchor). Set on every
  // claim so the cyclic "who's next" is agreed mesh-wide even after a silent
  // 60s timeout where the holder never ran release().
  const lastHolder = (state.get("lastHolder") as string | undefined) ?? null;
  const nextUp = nextPeer(roster.present, lastHolder);
  const iAmNext = nextUp === room.peerId;

  // Auto-pass: the holder reaching N hands the baton on rather than waiting for
  // a manual PASS click. Record self as lastHolder, then free the slot; the
  // peer that computes itself "next" self-claims (effect below). One-shot per
  // hold via reachedRef.
  useEffect(() => {
    if (reachedTarget && baton.isMine && !reachedRef.current) {
      reachedRef.current = true;
      burst({ origin: "center", count: 80, hueRange: [100, 160] });
      state.set("lastHolder", room.peerId);
      log.push({ id: newId(), peerId: room.peerId, type: "pass", ts: Date.now() });
      baton.release();
      steps.setMy({ count: 0, ts: Date.now() });
    }
    if (!baton.isMine) reachedRef.current = false;
  }, [reachedTarget, baton.isMine, burst]);

  // Auto-claim: once the relay has started (a first holder set `lastHolder`),
  // a free baton — released after reach-N or expired by the 60s deadline —
  // is grabbed by the deterministically-next peer. Because `present` is sorted
  // identically on every peer, exactly one peer satisfies iAmNext, so there's
  // no claim stampede. With ≥1 present peer the baton never stays orphaned —
  // that's the advertised "drops to the next peer". Before the first manual
  // claim (`lastHolder` null) the baton stays free so the UX still reads
  // "claim it" on a cold room.
  useEffect(() => {
    if (lastHolder == null) return; // relay not started yet — wait for first claim
    if (!baton.isFree || !iAmNext || roster.present.length === 0) return;
    if (lastHolder === room.peerId && roster.present.length > 1) return; // don't re-grab my own
    steps.setMy({ count: 0, ts: Date.now() });
    state.set("lastHolder", room.peerId);
    baton.claim();
    log.push({ id: newId(), peerId: room.peerId, type: "claim", ts: Date.now() });
  }, [baton.isFree, iAmNext, roster.present.length, lastHolder]);

  useEffect(() => {
    if (flashHolder && baton.claimedBy) burst({ origin: "top", count: 40, hueRange: [40, 80] });
  }, [flashHolder, baton.claimedBy, burst]);

  const bump = () => steps.setMy({ count: steps.my.count + 1, ts: Date.now() });
  const onClaim = () => {
    if (!baton.isFree) return;
    steps.setMy({ count: 0, ts: Date.now() });
    state.set("lastHolder", room.peerId);
    baton.claim();
    log.push({ id: newId(), peerId: room.peerId, type: "claim", ts: Date.now() });
  };
  const onPass = () => {
    if (!baton.isMine || !reachedTarget) return;
    log.push({ id: newId(), peerId: room.peerId, type: "pass", ts: Date.now() });
    state.set("lastHolder", room.peerId);
    baton.release();
    steps.setMy({ count: 0, ts: Date.now() });
  };

  const holderName = baton.claimedBy
    ? (nameOf(baton.claimedBy) ?? `peer-${baton.claimedBy.slice(0, 6)}`)
    : null;
  const items = steps.entries
    .map(([id, v]) => ({
      id,
      name: nameOf(id) ?? `peer-${id.slice(0, 6)}`,
      score: v.count,
      isMe: id === room.peerId,
    }))
    .sort((x, y) => y.score - x.score);
  const fillPct = Math.min(100, Math.round((myCount / target) * 100));
  const timePct = baton.claimedBy ? Math.round((baton.msRemaining / TTL_MS) * 100) : 0;
  const bannerCls = `relay-banner ${flashHolder ? "is-flash" : ""} ${baton.isMine ? "is-mine" : ""}`;

  return (
    <div className="relay-screen">
      <header className="relay-header">
        <h1>step relay</h1>
        <p className="relay-status">
          {room.peerCount + 1} peers · target {target} · {log.size} events
        </p>
      </header>
      <div className="relay-name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="your name"
          maxLength={48}
          aria-label="your name"
        />
      </div>
      <ArmGate label="tap to enable step counter" hint="iOS needs a tap to read motion sensors">
        {(armed) => <StepListener armed={armed} onStep={bump} disabled={!baton.isMine} />}
      </ArmGate>
      <div className={bannerCls} data-holder={holderName ?? ""}>
        <div className="relay-banner-title">BATON</div>
        <div className="relay-banner-name">{holderName ?? "free — claim it"}</div>
        <div className="relay-countdown">
          <div className="relay-countdown-bar" style={{ opacity: timePct > 0 ? 1 : 0.2 }}>
            <div className="relay-countdown-fill" style={{ width: `${timePct}%` }} />
          </div>
          <span className="relay-countdown-label">{deadline.fmt || "—"}</span>
        </div>
      </div>
      <div className="relay-mybar" aria-label={`my steps: ${myCount}`}>
        <div className="relay-step-bar">
          <div className="relay-step-fill" style={{ width: `${fillPct}%` }} />
        </div>
        <div className="relay-step-label">
          {myCount} / {target}
        </div>
      </div>
      <ul className="relay-peers" aria-label="peer steps">
        {items.map((it) => (
          <li key={it.id} className="relay-steps" data-peer-name={it.name} data-count={it.score}>
            <span className="relay-peers-name">{it.name}</span>
            <span className="relay-peers-count">{it.score}</span>
          </li>
        ))}
      </ul>
      <div className="relay-actions">
        <button
          type="button"
          className="relay-btn relay-claim"
          onClick={onClaim}
          disabled={!baton.isFree}
        >
          CLAIM BATON
        </button>
        <button
          type="button"
          className="relay-btn relay-pass"
          onClick={onPass}
          disabled={!baton.isMine || !reachedTarget}
        >
          PASS BATON
        </button>
        <button
          type="button"
          className="relay-btn relay-add-step"
          onClick={bump}
          aria-label="+1 step"
        >
          +1 step
        </button>
      </div>
      <ol className="relay-history" aria-label="relay history">
        {log.latest(8).map((e) => (
          <li key={e.id} className={`relay-history-row relay-history-${e.type}`}>
            <span className="relay-history-who">
              {nameOf(e.peerId) ?? `peer-${e.peerId.slice(0, 6)}`}
            </span>
            <span className="relay-history-what">{e.type}</span>
          </li>
        ))}
      </ol>
      <Leaderboard items={items} highlightId={room.peerId} title="step leaders" />
    </div>
  );
}

type SLProps = { armed: boolean; onStep: () => void; disabled: boolean };
function StepListener({ armed, onStep, disabled }: SLProps) {
  const { steps, ready } = useStepCount({ armed });
  const prev = useRef(0);
  useEffect(() => {
    if (!armed || disabled) {
      prev.current = steps;
      return;
    }
    if (steps > prev.current) for (let i = 0; i < steps - prev.current; i++) onStep();
    prev.current = steps;
  }, [steps, armed, disabled, onStep]);
  return (
    <p className="relay-sensor" data-ready={ready ? "yes" : "no"}>
      sensor {ready ? "live" : "idle"} · {steps} detected
    </p>
  );
}
