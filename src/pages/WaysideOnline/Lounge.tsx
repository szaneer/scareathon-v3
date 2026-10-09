import ContentControls, { useBlocks } from "../../station/things/ContentControls";
import { showComplianceNotice } from "../../fetchWithAuth";
import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AvatarView } from "../../components/avatar/AvatarView";
import type { AvatarLook } from "../../components/avatar/types";
import { loadCrowd, loadLooks, loungeSocketUrl, loungeTicket, type FuryHosting, type HostingMember, type LoungeMessage, type LoungePlayer } from "./api";

// The lounge: a club room off Wayside Online. Whoever's in walks about (tap the floor)
// and talks in bubbles; members who aren't in stand around the edges, so the room's
// never empty. Guests can look in; coming in needs a login.

// Keep in step with server/waysideOnline/lounge.js
const FLOOR = { left: 0.06, right: 0.94, top: 0.56, bottom: 0.95 };
const MAX_SAY = 80;
const CROWD_SIZE = 40;
const SAY_MS = 7000;
// Room widths walked a second
const WALK_SPEED = 0.22;
const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 15000;

type Person = { sayId?: string | null; userId: string; name: string; x: number; y: number; say: string | null; heard: number; live: boolean; hosting: FuryHosting | null };

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// A number from a string, the same every visit
function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

// Where a member who isn't in stands: along the back wall and round the sides, spread out
function idleSpot(userId: string, salt = "") {
  const a = hash(userId + salt);
  const b = hash(salt + userId + "y");
  const back = a < 0.6;
  return back
    ? { x: FLOOR.left + 0.02 + (a / 0.6) * (FLOOR.right - FLOOR.left - 0.04), y: FLOOR.top + 0.01 + b * 0.09 }
    : { x: a < 0.8 ? FLOOR.left + 0.01 + b * 0.1 : FLOOR.right - 0.01 - b * 0.1, y: FLOOR.top + 0.12 + b * 0.25 };
}

// The art: 320 across, a WALL-high back wall, then the floor. On screen the room fills
// the space it's given, so a tall phone gets a deeper floor rather than a stretched room.
// Positions stay in the server's room space; FLOOR.top..bottom maps onto whatever floor
// this screen has, so everyone sees everyone in the same place.
const ART_W = 320;
const WALL = 112;
const MIN_FLOOR = 88;
const MAX_FLOOR = 460;
const FLOOR_GAP = 10; // art rows below the lowest standing spot

type Scene = { width: number; height: number; art: number; scale: number };

function sceneFor(boxW: number, boxH: number): Scene {
  if (boxW <= 0 || boxH <= 0) return { width: 0, height: 0, art: WALL + MIN_FLOOR, scale: 1 };
  // as deep as the box, within limits; if that's still too shallow, fit by height
  const art = Math.min(WALL + MAX_FLOOR, Math.max(WALL + MIN_FLOOR, Math.round((ART_W * boxH) / boxW)));
  const scale = Math.min(boxW / ART_W, boxH / art);
  return { width: ART_W * scale, height: art * scale, art, scale };
}

// Room space to this screen's pixels, and back
const toScreen = (scene: Scene, x: number, y: number) => ({
  left: x * scene.width,
  top: (WALL + ((y - FLOOR.top) / (FLOOR.bottom - FLOOR.top)) * (scene.art - WALL - FLOOR_GAP)) * scene.scale,
});
const fromScreen = (scene: Scene, left: number, top: number) => ({
  x: left / scene.width,
  y: FLOOR.top + ((top / scene.scale - WALL) / (scene.art - WALL - FLOOR_GAP)) * (FLOOR.bottom - FLOOR.top),
});

const clampToFloor = (x: number, y: number) => ({
  x: Math.min(FLOOR.right, Math.max(FLOOR.left, x)),
  y: Math.min(FLOOR.bottom, Math.max(FLOOR.top, y)),
});

// The room's painted backdrop: 320 art pixels across, the wall always WALL tall and the
// floor as deep as the screen allows (at least MIN_FLOOR)
function Backdrop({ height }: { height: number }) {
  const floor = height - WALL;
  const boards = Array.from({ length: Math.ceil(floor / 8) }, (_, i) => i);
  const rugH = Math.max(44, Math.round(floor * 0.45));
  const rugY = WALL + Math.round((floor - rugH) * 0.55);
  return (
    <svg viewBox={`0 0 320 ${height}`} preserveAspectRatio="none" shapeRendering="crispEdges" className="absolute inset-0 h-full w-full" aria-hidden>
      {/* wall, wainscot, skirting */}
      <rect width="320" height="112" fill="#3b2a4a" />
      {Array.from({ length: 20 }, (_, i) => (
        <rect key={i} x={i * 16 + 7} y="0" width="2" height="84" fill="#34253f" />
      ))}
      <rect y="84" width="320" height="26" fill="#4a2f22" />
      {Array.from({ length: 16 }, (_, i) => (
        <rect key={i} x={i * 20 + 3} y="88" width="14" height="18" fill="#553728" />
      ))}
      <rect y="108" width="320" height="4" fill="#2a1a12" />
      {/* floor */}
      <rect y="112" width="320" height={floor} fill="#6e4a2e" />
      {boards.map((i) => (
        <rect key={i} y={112 + i * 8} width="320" height="1" fill="#5c3d25" />
      ))}
      {boards.map((i) => (
        <rect key={`j${i}`} x={((i * 53) % 290) + 10} y={113 + i * 8} width="1" height="7" fill="#5c3d25" />
      ))}
      {/* rug */}
      <rect x="92" y={rugY} width="136" height={rugH} fill="#7a1f2b" />
      <rect x="96" y={rugY + 3} width="128" height={rugH - 6} fill="#952a36" />
      <rect x="104" y={rugY + 8} width="112" height={rugH - 16} fill="#7a1f2b" />
      <rect x="150" y={rugY + Math.round(rugH / 2) - 5} width="20" height="10" fill="#e0a43a" />
      {/* window with the moon */}
      <rect x="24" y="18" width="52" height="50" fill="#1b1430" />
      <rect x="27" y="21" width="46" height="44" fill="#0e1a3a" />
      <rect x="54" y="28" width="10" height="10" fill="#f3ecc8" />
      <rect x="57" y="28" width="7" height="7" fill="#0e1a3a" />
      <rect x="34" y="44" width="1" height="1" fill="#cfd8ff" />
      <rect x="44" y="30" width="1" height="1" fill="#cfd8ff" />
      <rect x="66" y="52" width="1" height="1" fill="#cfd8ff" />
      <rect x="49" y="21" width="2" height="44" fill="#1b1430" />
      <rect x="27" y="42" width="46" height="2" fill="#1b1430" />
      <rect x="20" y="66" width="60" height="4" fill="#2a1a12" />
      {/* sign */}
      <rect x="112" y="10" width="96" height="20" fill="#1a1222" />
      <text x="160" y="24" textAnchor="middle" fontFamily="'Press Start 2P', monospace" fontSize="8" fill="#ffd75e">
        THE LOUNGE
      </text>
      {/* fireplace */}
      <rect x="132" y="50" width="56" height="62" fill="#5a5560" />
      <rect x="128" y="46" width="64" height="6" fill="#3f3a45" />
      <rect x="144" y="70" width="32" height="42" fill="#140d10" />
      <rect x="150" y="96" width="20" height="10" fill="#e0642a" className="lounge-fire" />
      <rect x="154" y="90" width="12" height="8" fill="#f2a83a" className="lounge-fire" />
      <rect x="158" y="86" width="4" height="5" fill="#ffe08a" className="lounge-fire" />
      <rect x="138" y="40" width="8" height="6" fill="#e07a1f" />
      <rect x="140" y="38" width="4" height="2" fill="#3c7a2a" />
      <rect x="174" y="41" width="6" height="5" fill="#efe3c8" />
      <rect x="176" y="38" width="2" height="3" fill="#ffd27a" />
      {/* couch */}
      <rect x="216" y="80" width="56" height="16" fill="#2d4a5a" />
      <rect x="212" y="92" width="64" height="16" fill="#355a6c" />
      <rect x="212" y="88" width="6" height="20" fill="#2d4a5a" />
      <rect x="270" y="88" width="6" height="20" fill="#2d4a5a" />
      {/* jukebox */}
      <rect x="92" y="62" width="26" height="48" fill="#8a2a12" />
      <rect x="95" y="65" width="20" height="14" fill="#ffd75e" className="lounge-glow" />
      <rect x="97" y="84" width="16" height="16" fill="#2a1a12" />
      <rect x="99" y="86" width="12" height="2" fill="#e0a43a" />
      <rect x="99" y="90" width="12" height="2" fill="#e0a43a" />
      <rect x="99" y="94" width="12" height="2" fill="#e0a43a" />
      {/* door */}
      <rect x="286" y="46" width="28" height="66" fill="#2a1a12" />
      <rect x="289" y="49" width="22" height="63" fill="#5a3a24" />
      <rect x="306" y="80" width="3" height="3" fill="#e0a43a" />
      {/* lamp */}
      <rect x="8" y="78" width="2" height="32" fill="#2a1a12" />
      <rect x="2" y="70" width="14" height="8" fill="#e0a43a" className="lounge-glow" />
    </svg>
  );
}

function Avatar({
  person,
  scene,
  look,
  size,
  me,
  selected,
  onSelect,
}: {
  person: Person;
  scene: Scene;
  look: AvatarLook | null;
  size: number;
  me: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  // Walk at a steady pace to wherever they're headed, facing the way they go
  const last = useRef({ x: person.x, y: person.y });
  const [walk, setWalk] = useState({ ms: 0, left: false, walking: false });
  useEffect(() => {
    const dx = person.x - last.current.x;
    const dy = person.y - last.current.y;
    const distance = Math.hypot(dx, dy * 0.6);
    last.current = { x: person.x, y: person.y };
    if (distance === 0) return;
    const ms = reducedMotion() ? 0 : (distance / WALK_SPEED) * 1000;
    setWalk((current) => ({ ms, left: Math.abs(dx) > 0.004 ? dx < 0 : current.left, walking: ms > 0 }));
    const arrive = window.setTimeout(() => setWalk((current) => ({ ...current, ms: 0, walking: false })), ms);
    return () => window.clearTimeout(arrive);
  }, [person.x, person.y]);
  const saying = person.say && Date.now() - person.heard < SAY_MS;
  return (
    <div
      className="lounge-person absolute"
      style={{
        ...toScreen(scene, person.x, person.y),
        zIndex: Math.round(person.y * 1000),
        transitionDuration: `${walk.ms}ms`,
      }}
    >
      {saying && <div className="lounge-bubble">{person.say}</div>}
      <button
        type="button"
        className={`lounge-body ${person.live ? "" : "lounge-idle"} ${walk.walking ? "lounge-walking" : ""}`}
        style={{ transform: walk.left ? "scaleX(-1)" : undefined }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        aria-label={person.name}
      >
        <span className="lounge-shadow" aria-hidden />
        <AvatarView look={look} height={size} label={person.name} />
      </button>
      {(person.live || person.hosting || selected) && <div className={`lounge-name ${me ? "lounge-me" : ""} ${person.live || person.hosting ? "" : "opacity-70"}`}>{person.name}</div>}
    </div>
  );
}

export default function Lounge({ signedIn, goSignIn }: { signedIn: boolean; goSignIn: () => void }) {
  const navigate = useNavigate();
  const [live, setLive] = useState<Map<string, Person>>(new Map());
  const [hosts, setHosts] = useState<HostingMember[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [admin, setAdmin] = useState(false);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const blocks = useBlocks();
  const [say, setSay] = useState("");
  const [, setNow] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const wantIn = useRef(signedIn);
  const roomRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  // The members who stand about, and the spots they idle at (they amble now and then)
  const { data: crowd = [] } = useQuery({ queryKey: ["wayside-online", "lounge", "crowd"], queryFn: loadCrowd, staleTime: 5 * 60 * 1000 });
  const [amble, setAmble] = useState<Record<string, number>>({});
  useEffect(() => {
    if (reducedMotion() || crowd.length === 0) return;
    const timer = window.setInterval(() => {
      const who = crowd[Math.floor(Math.random() * crowd.length)];
      setAmble((current) => ({ ...current, [who.userId]: (current[who.userId] ?? 0) + 1 }));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [crowd]);

  // Bubbles fade on their own
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const room = roomRef.current;
    if (!room) return;
    const observer = new ResizeObserver(([entry]) => setBox({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(room);
    return () => observer.disconnect();
  }, []);

  // One socket for the whole visit: watch, come in when signed in, and pick back up after a drop
  useEffect(() => {
    wantIn.current = signedIn;
    let closed = false;
    let retryMs = MIN_RETRY_MS;
    let retryTimer: number | undefined;
    const comeIn = async (socket: WebSocket) => {
      try {
        const { ticket } = await loungeTicket();
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "join", ticket }));
      } catch (problem) {
        setNotice((problem as Error).message);
      }
    };
    const receive = (message: LoungeMessage) => {
      const heard = Date.now();
      switch (message.type) {
        case "room":
          setLive(new Map(message.players.map((p: LoungePlayer) => [p.userId, { ...p, heard: p.saidAt ?? 0, live: true }])));
          setHosts(message.hosts ?? []);
          break;
        case "hosting":
          setHosts(message.hosts);
          break;
        case "enter":
          setLive((current) => new Map(current).set(message.player.userId, { ...message.player, heard: 0, live: true }));
          break;
        case "leave":
          setLive((current) => {
            const next = new Map(current);
            next.delete(message.userId);
            return next;
          });
          break;
        case "move":
          setLive((current) => {
            const person = current.get(message.userId);
            return person ? new Map(current).set(message.userId, { ...person, x: message.x, y: message.y }) : current;
          });
          break;
        case "say":
          setLive((current) => {
            const person = current.get(message.userId);
            return person ? new Map(current).set(message.userId, { ...person, say: message.say, sayId: message.sayId, heard }) : current;
          });
          break;
        case "in":
          setMe(message.userId);
          setAdmin(message.admin);
          setNotice(null);
          break;
        case "out":
          setMe(null);
          wantIn.current = false;
          setNotice(message.reason === "kicked" ? "You've been shown out of the lounge for a little while." : "You're in the lounge in another window.");
          break;
        case "error":
          setNotice(message.message);
          showComplianceNotice(message.code);
          break;
      }
    };
    const connect = () => {
      const socket = new WebSocket(loungeSocketUrl());
      socketRef.current = socket;
      socket.onopen = () => {
        retryMs = MIN_RETRY_MS;
        setConnected(true);
        if (wantIn.current) void comeIn(socket);
      };
      socket.onmessage = (event) => {
        try {
          receive(JSON.parse(event.data) as LoungeMessage);
        } catch {
          // (a garbled line; the next one puts it right)
        }
      };
      socket.onclose = () => {
        setConnected(false);
        setMe(null);
        setHosts([]);
        if (closed) return;
        retryTimer = window.setTimeout(connect, retryMs);
        retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [signedIn]);

  const send = (message: object) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const comeBackIn = async () => {
    wantIn.current = true;
    setNotice(null);
    try {
      const { ticket } = await loungeTicket();
      send({ type: "join", ticket });
    } catch (problem) {
      setNotice((problem as Error).message);
    }
  };

  // Everyone drawn: who's in, then members who aren't, up to the room's crowd
  const people = useMemo(() => {
    const hosting = new Map(hosts.map((member) => [member.userId, member.hosting]));
    const list: Person[] = [...live.values()].map((person) => ({ ...person, hosting: hosting.get(person.userId) ?? null }));
    hosts.filter((member) => !live.has(member.userId)).forEach((member) => {
      const spot = idleSpot(member.userId, String(amble[member.userId] ?? ""));
      list.push({ ...member, ...spot, say: null, heard: 0, live: false });
    });
    const shown = new Set(list.map((person) => person.userId));
    crowd
      .filter((member) => !shown.has(member.userId))
      .slice(0, Math.max(0, CROWD_SIZE - list.length))
      .forEach((member) => {
        const spot = idleSpot(member.userId, String(amble[member.userId] ?? ""));
        list.push({ ...member, ...spot, say: null, heard: 0, live: false, hosting: null });
      });
    return list;
  }, [live, crowd, hosts, amble]);

  const ids = useMemo(() => people.map((p) => p.userId).sort().join(","), [people]);
  const { data: looks = {} } = useQuery({
    queryKey: ["wayside-online", "lounge", "looks", ids],
    queryFn: () => loadLooks(ids.split(",").filter(Boolean)),
    enabled: ids.length > 0,
    staleTime: 5 * 60 * 1000,
    placeholderData: (previous) => previous,
  });

  const walkTo = (event: PointerEvent<HTMLDivElement>) => {
    setSelected(null);
    if (!me) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const at = fromScreen(scene, event.clientX - rect.left, event.clientY - rect.top);
    const spot = clampToFloor(at.x, at.y);
    // (step at once on this screen; the server's echo lands on the same spot)
    setLive((current) => {
      const person = current.get(me);
      return person ? new Map(current).set(me, { ...person, ...spot }) : current;
    });
    send({ type: "move", ...spot });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = say.trim();
    if (!text || !me) return;
    send({ type: "say", text });
    setSay("");
    setNotice(null);
  };

  const scene = sceneFor(box.width, box.height);
  // (the avatar art, 48 rows, at a whole number of screen pixels per art pixel, near the room's own)
  const size = 48 * Math.max(1, Math.round(scene.scale));
  const chosen = selected ? people.find((p) => p.userId === selected) : undefined;
  const inCount = live.size;

  return (
    <div className="wo-well flex min-h-0 flex-1 flex-col overflow-hidden p-2">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[19px] text-[#3c3a35]">
        <span>{connected ? `${inCount} in the lounge${me ? " · tap the floor to walk" : ""}` : "Dialling the lounge…"}</span>
        {chosen && (
          <span className="flex items-center gap-2">
            <span className="text-[#1c1b18]">{chosen.name}</span>
            <span className="text-[#7c7972]">{chosen.hosting ? `Hosting Wayside Fury · ${chosen.hosting.count}/${chosen.hosting.max}` : chosen.live ? (chosen.userId === me ? "(you)" : "here now") : "not in right now"}</span>
            {chosen.userId !== me && <ContentControls targetType="lounge_chat" targetId={chosen.sayId} userId={chosen.userId} onChange={() => setSelected(null)} />}
            {chosen.hosting && chosen.userId !== me && (
              <button
                type="button"
                className="wo-button"
                disabled={chosen.hosting.count >= chosen.hosting.max}
                onClick={() => signedIn ? navigate(`/wayside-fury?coop=${encodeURIComponent(chosen.hosting!.code)}`) : goSignIn()}
              >
                {chosen.hosting.count >= chosen.hosting.max ? "Full" : signedIn ? "Join" : "Sign in to join"}
              </button>
            )}
            {admin && chosen.live && chosen.userId !== me && (
              <button
                type="button"
                className="wo-button"
                onClick={() => {
                  send({ type: "kick", userId: chosen.userId });
                  setSelected(null);
                }}
              >
                Show out
              </button>
            )}
          </span>
        )}
      </div>
      <div ref={roomRef} className="lounge-room relative min-h-[240px] w-full flex-1 overflow-hidden">
        <div
          className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 ${me ? "cursor-pointer" : ""}`}
          style={{ width: scene.width, height: scene.height }}
          onPointerDown={walkTo}
        >
          <Backdrop height={scene.art} />
          {people.filter(person => !blocks.has(person.userId)).map((person) => (
            <Avatar
              key={person.userId}
              person={person}
              scene={scene}
              look={looks[person.userId] ?? null}
              size={size}
              me={person.userId === me}
              selected={person.userId === selected}
              onSelect={() => setSelected((current) => (current === person.userId ? null : person.userId))}
            />
          ))}
        </div>
      </div>
      <div className="mt-2">
        {!signedIn ? (
          <button type="button" className="wo-button" onClick={goSignIn}>
            Sign in to come in
          </button>
        ) : me ? (
          <form onSubmit={submit} className="flex gap-2">
            <input
              className="wo-field flex-1"
              maxLength={MAX_SAY}
              placeholder="Say something…"
              value={say}
              onChange={(event) => setSay(event.target.value)}
              aria-label="Say something"
            />
            <button type="submit" className="wo-button" disabled={!say.trim()}>
              Say
            </button>
          </form>
        ) : (
          <button type="button" className="wo-button" disabled={!connected} onClick={comeBackIn}>
            Come in
          </button>
        )}
        {notice && <p className="mt-1 text-[18px] text-[#a3241a]">{notice}</p>}
      </div>
    </div>
  );
}
