// Flow mining: recovering the SHAPES of work from what a space actually did.
//
// A content-routed space has no declared topology, so this is the only way to answer "what does
// this space do": walk lineage, abstract each connected subgraph into a signature, and count how
// often each signature recurs. Nothing here is asserted by the runtime; every claim carries the
// exemplar ids behind it (see agent_docs/design-inspection.md).
//
// Extracted from `space.ts` unchanged. It reaches the space through the narrow `FlowSource` port
// below rather than through `Space` itself, which is what keeps the dependency one-way: mining is a
// READER, and a reader that can reach the whole service will eventually write through it.

import type { CompiledMatch, Envelope, EnvelopeQuery, Page, RadiaRecord, RecordState, StatsScope } from "../storage/adapter.ts";
import { isClaimable, type KindDef, RESERVED_KINDS } from "./kinds.ts";
import { getPath } from "./matching.ts";

/** Everything mining needs from a space, and nothing else. Implemented inline by `Space.flows`. */
export interface FlowSource {
  listKinds(): KindDef[];
  /** Compile a bare kind pattern, refreshing a stale kind registry the way any read does. */
  compile(kind: string): Promise<CompiledMatch>;
  query(match: CompiledMatch, limit: number, page?: Page, scope?: StatsScope): Promise<RadiaRecord[]>;
  envelopesInState(q: EnvelopeQuery): Promise<Envelope[]>;
  /** Resolves a `run:` principal to the agent behind it, so a shape is per AGENT and not per run. */
  agentForRun(run: string): Promise<string | undefined>;
}

/** How a repeated token renders in a signature. Bucketing is what makes a shape AGGREGATE: a
 *  four-word job and a five-word one are the same flow, and exact counts would file them apart and
 *  report every run as unique. Exact stays available because the bucket is a guess about which
 *  differences matter. */
function flowCount(n: number, mode: "bucketed" | "exact"): string {
  if (n === 1) return "";
  if (mode === "exact") return `×${n}`;
  if (n <= 3) return "×2-3";
  if (n <= 7) return "×4-7";
  if (n <= 15) return "×8-15";
  if (n <= 31) return "×16-31";
  if (n <= 63) return "×32-63";
  return "×64+";
}

/** Median, rounded. A mean over durations is dominated by the one occurrence that sat overnight. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

/** Flow mining bounds. The scan is a whole-space read, so every one of these exists to keep it from
 *  becoming an unbounded one; hitting any of them reports `complete: false` rather than truncating
 *  quietly, because a mined shape read as the population is this feature's version of the
 *  bounded-read bug. */
const FLOW_MAX_RECORDS = 5000;
const FLOW_PAGE = 500;
const FLOW_MAX_SHAPES = 50;
const FLOW_EXEMPLARS = 3;

/** Hub detection. A record needs `DEGREE` children before it is even tested, which is what keeps an
 *  ordinary fan-out (a job with five tasks) out of the test; only the widest `CANDIDATES` per
 *  component are tested, since each test is a graph pass; and removing it must leave `PIECES`
 *  independent pieces, which is the property that distinguishes a hub from a fan-out that
 *  reconverges. */
const FLOW_HUB_DEGREE = 8;
const FLOW_HUB_CANDIDATES = 8;
const FLOW_HUB_PIECES = 3;
/** Records of one kind in a line before the line is read as a VERSION SPINE rather than as work.
 *  One same-kind edge is ambiguous and two is a coin flip; three is a thing being saved again. */
const FLOW_CHAIN_MIN = 3;

// Both shapes cross `/v0`, so they are defined in the wire vocabulary and re-exported here. The
// client restating them is how its copy came to widen `granularity`/`counts` to `string` and drop
// `scope` (agent_docs/plan-bounded-reads.md is the same disease one layer down).
import type { FlowReport, FlowShape } from "../../sdk/ts/wire.ts";
export type { FlowReport, FlowShape };

export async function mineFlows(
src: FlowSource,
opts: {
  granularity?: "kind" | "kind+agent";
  counts?: "bucketed" | "exact";
  maxRecords?: number;
  minOccurrences?: number;
  includeReserved?: boolean;
  includeSingletons?: boolean;
  /** Children a record needs before it is TESTED as a hub; 0 leaves every component whole. */
  hubDegree?: number;
  /** Body paths to SUM per shape (`usage.cost`), so "where does the metric go" is answered by the
   *  same scan that mines the shapes. Caller-named on purpose: the runtime learns no app's
   *  vocabulary, it adds numbers at addresses it was handed. Non-numeric and absent values count
   *  as nothing, and `records` beside each total says how many records actually carried one. */
  sum?: string[];
  scope?: StatsScope;
} = {},
): Promise<FlowReport> {
  const granularity = opts.granularity ?? "kind+agent";
  const counting = opts.counts ?? "bucketed";
  const cap = Math.min(Math.max(opts.maxRecords ?? FLOW_MAX_RECORDS, 1), FLOW_MAX_RECORDS);
  const minOccurrences = Math.max(opts.minOccurrences ?? 1, 1);
  const notes: string[] = [];
  let complete = true;

  // Reserved kinds are the runtime's own bookkeeping (declarations, grants, run records). They
  // are the highest-volume kinds in a quiet space, so including them by default would make every
  // space's top flow a registry write and bury the work.
  const reserved = new Set(RESERVED_KINDS);
  const claimable = new Map(src.listKinds().map((d) => [d.kind, isClaimable(d)]));
  let kinds = src.listKinds().map((d) => d.kind).filter((k) => opts.includeReserved || !reserved.has(k));
  if (opts.scope?.kinds) kinds = kinds.filter((k) => opts.scope!.kinds!.includes(k));
  kinds.sort();

  // --- the scan. One keyset walk per kind, stopping at the cap rather than at a page boundary.
  const sumPaths = (opts.sum ?? []).slice(0, 4);
  const nodes = new Map<string, { kind: string; agent: string; createdAt: string; parents: string[]; vals?: number[] }>();
  const agentCache = new Map<string, string>();
  const agentOf = async (createdBy: string): Promise<string> => {
    const memo = agentCache.get(createdBy);
    if (memo) return memo;
    const resolved = createdBy.startsWith("run:") ? (await src.agentForRun(createdBy)) ?? createdBy : createdBy;
    agentCache.set(createdBy, resolved);
    return resolved;
  };
  for (const kind of kinds) {
    const compiled = await src.compile(kind);
    let after: string | undefined;
    for (;;) {
      if (nodes.size >= cap) {
        complete = false;
        notes.push(`the scan stopped at ${cap} records; these shapes are mined from a PREFIX of the space`);
        break;
      }
      const page = await src.query(compiled, Math.min(FLOW_PAGE, cap - nodes.size), { after }, opts.scope);
      for (const rec of page) {
        nodes.set(rec.id, {
          kind: rec.kind,
          agent: await agentOf(rec.runtimeMeta.createdBy),
          createdAt: rec.runtimeMeta.createdAt,
          parents: rec.runtimeMeta.parentIds,
          // Extracted while the record is in hand: the body is not kept, and a second read to sum
          // a column would double the cost of the feature's whole reason to exist.
          ...(sumPaths.length > 0
            ? { vals: sumPaths.map((path) => {
              const v = getPath(rec.body, path);
              return typeof v === "number" && Number.isFinite(v) ? v : NaN;
            }) }
            : {}),
        });
      }
      if (page.length === 0) break;
      after = page[page.length - 1].id;
    }
    if (!complete) break;
  }

  // --- outcomes. One bulk read per state instead of an envelope fetch per record: mining is a
  // whole-space read already, and N round trips on top of it is what makes such a feature
  // unusable on a real space.
  //
  // Scoped to the kinds actually mined, which is not cosmetic: an unscoped state scan spends its
  // budget on the kinds this scan EXCLUDED (a real space had 1135 `agent_run` and 1080 `interest`
  // envelopes ahead of the work), so records fell out of the map and an unknown state reads as
  // "nothing wrong". That is the wrong direction to be wrong in.
  const mined = new Set(kinds);
  const notMined = src.listKinds().map((d) => d.kind).filter((k) => !mined.has(k));
  const stateOf = new Map<string, RecordState>();
  for (const state of ["available", "leased", "consumed", "dead_letter"] as RecordState[]) {
    const envs = await src.envelopesInState({ state, limit: cap, excludeKinds: notMined, scope: opts.scope });
    if (envs.length >= cap) complete = false;
    for (const e of envs) stateOf.set(e.recordId, state);
  }

  // --- components. Union-find over parent edges INSIDE the scanned set; a parent outside it is
  // what makes a subgraph a fragment, and that has to be said rather than shown as a short shape.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) ?? r;
    while (parent.get(x) !== r) {
      const next = parent.get(x) ?? r;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const id of nodes.keys()) parent.set(id, id);
  const fragment = new Set<string>();
  for (const [id, n] of nodes) {
    for (const p of n.parents) {
      if (nodes.has(p)) union(p, id);
      else fragment.add(id); // resolved to a component root below, once the unions are settled
    }
  }
  const components = new Map<string, string[]>();
  for (const id of nodes.keys()) {
    const root = find(id);
    const members = components.get(root) ?? [];
    members.push(id);
    components.set(root, members);
  }
  // --- the hub cut. A flow is a connected subgraph, which holds until ONE long-lived record ties
  // everything to everything: the chat's `conversation` links every turn, so a whole multi-day
  // chat mined as a single shape that occurred exactly once and said nothing. Measured on a real
  // corpus, every conversation-rooted shape was unique.
  //
  // The cut is DERIVED, never a named kind, or an inspection feature would be declaring the
  // topology it exists to discover. The test is structural: a hub is a node whose REMOVAL leaves
  // many independent pieces. That is what separates a conversation from a wide fan-out, which is
  // also high-degree — a job's tasks reconverge on a summary, so deleting the job still leaves one
  // piece and the pipeline's shape survives the pass untouched.
  const hubDegree = Math.max(opts.hubDegree ?? FLOW_HUB_DEGREE, 0);
  const tokenOf = (id: string) => {
    const n = nodes.get(id)!;
    return granularity === "kind" ? n.kind : `${n.kind}@${n.agent}`;
  };
  /** Connected pieces of `members` with `cut` deleted. Local union-find; the outer one is spent. */
  const piecesOf = (members: string[], cut: Set<string>): string[][] => {
    const live = members.filter((id) => !cut.has(id));
    const set = new Set(live);
    const up = new Map(live.map((id) => [id, id]));
    const root = (x: string): string => {
      while (up.get(x) !== x) {
        up.set(x, up.get(up.get(x)!)!);
        x = up.get(x)!;
      }
      return x;
    };
    for (const id of live) {
      for (const p of nodes.get(id)!.parents) {
        if (!set.has(p)) continue;
        const [a, b] = [root(id), root(p)];
        if (a !== b) up.set(a, b);
      }
    }
    const out = new Map<string, string[]>();
    for (const id of live) {
      const r = root(id);
      const bucket = out.get(r);
      if (bucket) bucket.push(id);
      else out.set(r, [id]);
    }
    return [...out.values()];
  };
  /** Maximal groups joined only by SAME-KIND parent edges: a version spine, or a same-kind star.
   *  Kind, never `kind@agent`: a workspace saved by two agents is still one thing. */
  const piecesOfSameKind = (members: string[]): string[][] => {
    const set = new Set(members);
    const up = new Map(members.map((id) => [id, id]));
    const root = (x: string): string => {
      while (up.get(x) !== x) {
        up.set(x, up.get(up.get(x)!)!);
        x = up.get(x)!;
      }
      return x;
    };
    for (const id of members) {
      const kind = nodes.get(id)!.kind;
      for (const p of nodes.get(id)!.parents) {
        if (!set.has(p) || nodes.get(p)!.kind !== kind) continue;
        const [a, b] = [root(id), root(p)];
        if (a !== b) up.set(a, b);
      }
    }
    const out = new Map<string, string[]>();
    for (const id of members) {
      const r = root(id);
      const bucket = out.get(r);
      if (bucket) bucket.push(id);
      else out.set(r, [id]);
    }
    return [...out.values()];
  };
  const units: { members: string[]; prefix: string; fragment: boolean }[] = [];
  let hubs = 0;
  for (const members of components.values()) {
    const cut = new Set<string>();
    if (hubDegree > 0 && members.length > hubDegree) {
      // A hub is not always ONE record. A workspace writes each version with the previous as its
      // parent, so ten saves are a ten-record SPINE with each turn's output hanging off its own
      // version, and the spine links every turn to every other exactly as a conversation does. It
      // is the same structure stretched into a line, so it gets the same test, applied to a
      // same-kind connected GROUP instead of a node.
      //
      // Three members is the floor, and it is what protects real work: ONE same-kind edge is
      // ambiguous (a router's `llm_call` producing an inference `llm_call` is a step, not a
      // version), while three records of a kind in a line is a thing being saved repeatedly.
      const spines = piecesOfSameKind(members).filter((p) => p.length >= FLOW_CHAIN_MIN);
      const childCount = new Map<string, number>();
      for (const id of members) {
        for (const p of nodes.get(id)!.parents) {
          if (nodes.has(p)) childCount.set(p, (childCount.get(p) ?? 0) + 1);
        }
      }
      // Only the widest few of either shape are ever tested: the piece count is a graph pass, and
      // a component with no hub must not pay for one per node.
      const candidates: string[][] = [
        ...spines.sort((a, b) => b.length - a.length),
        ...members
          .filter((id) => (childCount.get(id) ?? 0) >= hubDegree)
          .sort((a, b) => (childCount.get(b) ?? 0) - (childCount.get(a) ?? 0))
          .map((id) => [id]),
      ].slice(0, FLOW_HUB_CANDIDATES);
      // Cut everything, then RESTORE what turns out not to be needed. Testing candidates one at a
      // time cannot work, because they interact: a workspace spine splits nothing while the
      // conversation still links every turn, and the conversation splits nothing while the spine
      // does, so a forward pass rejects each on the strength of the other still being there. From
      // the other end the question is answerable one candidate at a time — does putting this one
      // back re-merge the pieces? — which is k tests rather than 2^k, and yields the smallest cut
      // that still decomposes rather than the first one found.
      for (const c of candidates) for (const id of c) cut.add(id);
      if (piecesOf(members, cut).length < FLOW_HUB_PIECES) {
        cut.clear(); // no decomposition available: leave the component whole, as before hubs existed
      } else {
        for (const c of candidates) {
          for (const id of c) cut.delete(id);
          if (piecesOf(members, cut).length < FLOW_HUB_PIECES) for (const id of c) cut.add(id); // needed
        }
      }
      hubs += cut.size;
    }
    // The hub's own kind stays in the signature, or the turns of a conversation and the steps of
    // a job would merge on the strength of looking alike. PER PIECE, not per component: naming
    // every hub that was cut anywhere gave two identical turns different keys depending on
    // whether their conversation happened to also hold a workspace, which splits exactly what the
    // signature exists to aggregate. A piece is prefixed by what it actually hung from.
    for (const piece of cut.size === 0 ? [members] : piecesOf(members, cut)) {
      const within = new Set(piece);
      const touching = new Set<string>();
      for (const id of piece) for (const p of nodes.get(id)!.parents) if (cut.has(p)) touching.add(p);
      for (const c of cut) for (const p of nodes.get(c)!.parents) if (within.has(p)) touching.add(c);
      units.push({
        members: piece,
        prefix: [...new Set([...touching].map(tokenOf))].sort().join(" + "),
        fragment: piece.some((id) => fragment.has(id)),
      });
    }
  }

  // --- abstraction. Ids are monotonic ULIDs minted by this process at commit, so ascending id IS
  // a topological order: a parent always exists before the child that names it. That is what lets
  // depth be one pass instead of a walk per node.
  const shapes = new Map<string, { occurrences: number; complete: number; open: number; failed: number; durations: number[]; sizes: number[]; exemplars: string[]; sums: number[]; sumRecords: number[] }>();
  let unknownState = 0;
  let singletons = 0;
  for (const unit of units) {
    const members = unit.members;
    // A record linked to nothing is not a flow of one. Left in, the registry writes outrank every
    // real shape: a live space put `capability`×861 and `model`×215 above `llm_call → llm_result`,
    // which answers "what does this space do" with its own bookkeeping.
    if (members.length === 1 && !unit.fragment) {
      singletons++;
      if (!opts.includeSingletons) continue;
    }
    members.sort();
    const within = new Set(members);
    const depth = new Map<string, number>();
    let failed = false;
    let open = false;
    let first = Infinity;
    let last = -Infinity;
    for (const id of members) {
      const n = nodes.get(id)!;
      // Parents in THIS unit, not merely in the scan: a node whose only parent was the hub is a
      // root of its own flow now, and counting the cut edge would push every depth down by one.
      const inside = n.parents.filter((p) => within.has(p));
      depth.set(id, inside.length === 0 ? 0 : 1 + Math.max(...inside.map((p) => depth.get(p) ?? 0)));
      const state = stateOf.get(id);
      if (state === undefined) unknownState++;
      if (state === "dead_letter") failed = true;
      // A `claimable:false` kind sits `available` forever BY DESIGN (facts, summaries, the
      // registries). Reading that as unfinished work would mark every terminated pipeline open.
      if (state === "leased" || (state === "available" && claimable.get(n.kind) !== false)) open = true;
      const t = Date.parse(n.createdAt);
      if (Number.isFinite(t)) {
        first = Math.min(first, t);
        last = Math.max(last, t);
      }
    }
    const levels = new Map<number, Map<string, number>>();
    for (const id of members) {
      const token = tokenOf(id);
      const level = levels.get(depth.get(id)!) ?? new Map<string, number>();
      level.set(token, (level.get(token) ?? 0) + 1);
      levels.set(depth.get(id)!, level);
    }
    const signature = [...levels.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, tokens]) =>
        [...tokens.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([token, n]) => token + flowCount(n, counting))
          .join(" + ")
      )
      .join(" → ");
    const key = (unit.prefix ? `${unit.prefix} ⇒ ` : "") + (unit.fragment ? `… → ${signature}` : signature);
    const s = shapes.get(key) ??
      { occurrences: 0, complete: 0, open: 0, failed: 0, durations: [], sizes: [], exemplars: [], sums: sumPaths.map(() => 0), sumRecords: sumPaths.map(() => 0) };
    for (const id of members) {
      const vals = nodes.get(id)!.vals;
      if (!vals) continue;
      for (let i = 0; i < vals.length; i++) {
        if (!Number.isNaN(vals[i])) {
          s.sums[i] += vals[i];
          s.sumRecords[i]++;
        }
      }
    }
    s.occurrences++;
    if (failed) s.failed++;
    else if (open) s.open++;
    else s.complete++;
    s.durations.push(Number.isFinite(first) && Number.isFinite(last) ? last - first : 0);
    s.sizes.push(members.length);
    s.exemplars.push(members[0]);
    shapes.set(key, s);
  }
  if (unknownState > 0) {
    complete = false;
    notes.push(`${unknownState} records had no envelope in the state scan, so their outcome is a guess, not a reading`);
  }

  const flows = [...shapes.entries()]
    .filter(([, s]) => s.occurrences >= minOccurrences)
    .map(([signature, s]) => ({
      signature,
      occurrences: s.occurrences,
      outcomes: { complete: s.complete, open: s.open, failed: s.failed },
      successRate: s.complete / s.occurrences,
      medianDurationMs: median(s.durations),
      totalDurationMs: s.durations.reduce((a, b) => a + b, 0),
      medianRecords: median(s.sizes),
      ...(sumPaths.length > 0
        ? { sums: Object.fromEntries(sumPaths.map((path, i) => [path, { total: s.sums[i], records: s.sumRecords[i] }])) }
        : {}),
      exemplars: s.exemplars.sort().slice(-FLOW_EXEMPLARS).reverse(),
    }))
    .sort((a, b) =>
      b.occurrences - a.occurrences || b.successRate - a.successRate || (a.signature < b.signature ? -1 : 1)
    );
  if (flows.length > FLOW_MAX_SHAPES) {
    complete = false;
    notes.push(`${flows.length} distinct shapes were mined and ${FLOW_MAX_SHAPES} are shown; a long tail of near-unique shapes usually means the granularity is too fine`);
  }
  return {
    granularity,
    counts: counting,
    flows: flows.slice(0, FLOW_MAX_SHAPES),
    scanned: { records: nodes.size, kinds, subgraphs: components.size },
    fragments: units.filter((u) => u.fragment).length,
    singletons,
    hubs,
    complete,
    ...(notes.length > 0 ? { notes } : {}),
  };
}
