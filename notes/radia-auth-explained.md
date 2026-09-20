# Radia's auth stack, explained

Companion to [radia-explained.md](radia-explained.md). The authoritative spec is
[../agent_docs/design-auth.md](../agent_docs/design-auth.md) and
[../agent_docs/architecture-ops-tiers.md](../agent_docs/architecture-ops-tiers.md). This file is a
summary of those, not a replacement.

Authorization state is held as records, resolved per request, and never self-declared. It is
not cached, with one exception: the operator token is a process-lifetime credential rather than
a record, which is also why it cannot be revoked.

## 1. The bootstrap chain

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ OPERATOR                   ┃
┃ named in ctx.operators     ┃ the only escalation root: creates
┗━━━━━━━━━━━━━┯━━━━━━━━━━━━━━┛ definitions, assigns grants, revokes
              │  POST /v0/agent-definitions {agent, grants}
              ▾
┌─────────────┴──────────────┐
│ agent_definition  (RECORD) │ ▸ mints runs, and NOTHING else
│ for an agent OR a person   │ ▸ refused for put / take / query
│ token: DURABLE, revocable  │ ▸ therefore safe to store on disk
└─────────────┬──────────────┘
              │  POST /v0/agent-runs  (Bearer definitionToken)
              ▾
┌─────────────┴──────────────┐
│ agent_run  (RECORD)        │ ▸ inherits the definition's grants
│ principal: run:*           │ ▸ renews at half-life, 12 h ceiling
│ token: ~15 min, renewable  │ ▸ stopped or expired: stops resolving
└─────────────┬──────────────┘
              │  owns
              ▾
    ┌─────────┴──────────┐
    │ leases (fenced)    │  settle verbs are OWNER-BOUND:
    └────────────────────┘  a stranger fences out as lease_lost
```

There are three namespaces for grantable principals, `human:*`, `agent:*` and `run:*`. The
namespace says what kind of principal it is, never what it may do. The space's own identity
(`local:dev` by default) is a fourth prefix and is privileged by construction; it is what the
operator token and an open-mode headerless request resolve to. A person and a worker take the
same path to a credential, so there is one chain to reason about and a person's session expires
like a worker's.
`radia login human:alice` walks it from the CLI, and `POST /v0/sessions/oidc` walks it from a
verified id_token.

The definition/run split is OAuth-shaped, and each half has a distinct job:

- A definition token is durable and revocable, and is refused for coordination. Because it cannot
  read, write or claim, it is safe to keep on disk. Renewal is a liveness protocol, so a sleeping
  laptop, a short-lived CLI process and `git` replaying a stored secret all fail it. The client
  holds the durable half and re-mints on `token_expired`, once, never on a 403.
- A run token is short-lived and acts. Stopping it, or letting it expire, stops it resolving.
  `stopRun({quarantine:true})` also force-releases its in-flight leases, epoch-bumped, so a late
  `ack` fences out.

Only the sha256 hash of a token is stored, in a record body, since a hash is not a secret. A stop
and a revoke are both successor records carrying that same hash, which is why one indexed lookup
sees them.

## 2. The request path

```
  Authorization: Bearer <token>   (the only coordination channel)
            │
            ▾
    ├─ resolveToken NARROW read by tokenHash, newest by write order. Not
    │               cached: a stop or revoke is a successor on that same hash
    ├─ authorize    grant records for (principal, kind, op). Never wildcard.
    │               Grants UNION; an unrestricted one widens to the whole kind
    ├─ pattern      read/take:  grant AND request  (combineMatch)
    │               put:        the body must satisfy the grant pattern
    ├─ taint        scope.taint is an ALLOWLIST, so a NEW label is barred by
    │               every existing grant instead of silently permitted
    ▾
    200, or 403 naming the missing grant
```

Artifact bytes are the one other way in. `GET/PUT /v0/a/{capability}` and
`/v0/w/{capability}/{path}` take no credential, by design: the capability URL is the
authorization.

The rule the design turns on is: cache what cannot change, never cache what can be revoked. A
stopped run, an expired token and a withdrawn grant must all be discovered. A credential index
must also not be rebuilt at startup, because a bounded read of an unbounded log lets a stopped
run's token keep working after a restart on a busy space, and it fails open silently.

A `watch` outlives its request, so it is handled separately. It is allowed only for a principal
holding an observing operation (`query`, `take`, `read_one`) on the kind, the union of those
grants' patterns is AND-ed into the match, and the scope is re-derived for as long as the stream
runs, so a revocation reaches an open connection instead of waiting for a disconnect.

## 3. The three privilege planes

```
┌──────────────────────┬────────────────────┬────────────────────────┐
│ ORDINARY GRANT       │ ops_grant          │ CONFIG OPERATOR        │
│ record, kind-scoped  │ record, one POWER  │ named in ctx.operators │
├──────────────────────┼────────────────────┼────────────────────────┤
│ put  take  query     │ observe            │ all of the left, plus  │
│ read_one             │ remediate          │ grant / signal writes  │
│                      │ sweep              │ agent_* / ops_grant    │
│ on ONE kind, with an │ declassify         │ minting, login, revoke │
│ optional pattern     │ purge              │ coordination bypass    │
└──────────────────────┴────────────────────┴────────────────────────┘
 the coordination plane  observe-and-operate  the escalation root
```

An `ops_grant` grants nothing on the coordination plane: `observe` does not put, take or query
records. The ops power vocabulary is closed and is extended only when a real failure names the
next entry. It never contains `grant`/`signal`/`agent_*` writes, minting, `login`, revoke or the
coordination bypass, because a principal that can grant powers could grant itself powers.

The ops read plane has three tiers, so an agent inspecting its own work does not need `observe`:

| Tier      | Bound by                    | Opens                                     |
|-----------|-----------------------------|-------------------------------------------|
| `observe` | nothing                     | the whole read plane, aggregates included |
| self      | `scope: {createdBy:"self"}` | own records, on granted kinds             |
| pattern   | the grant's own `pattern`   | per-record reads of whatever it matches   |

`Space.readFilter` asks `readAccess` the same question a `query` asks, so the two planes cannot
drift. Every grant defect in this codebase so far has been a promise that did not match the
enforcement, which is also why authorization has a canonical inspectable form:
`GET /v0/ops/permissions` and `radia permissions <principal>`. Any principal may read its own.

The supervisor is not an operator. It is an ordinary agent with one carve-out, `grant`/`signal`
writes. That demotion also makes it mintable; before it, the supervisor was fully privileged and
unmintable, so no client could authenticate as it.

## 4. Delegation

```
 run:alice ──put──▸ SPACE ──take──▸ run:tool-7 (the worker)
                      ▴                 │
                      └─── ack result ──┘

 the runtime STAMPS the result; the client cannot:
   created_by          the ACTING agent, taken from lease_owner
   delegation_context  {chain, origin}, accumulated along the path
```

Provenance is not authority. `parent_ids` is data lineage, and the chain is derived from the
record's authoritative `lease_owner`, never from a data parent. Deriving data from a privileged
record grants nothing.

A delegated run's permissions are the worker's own grants plus its delegable grants, intersected
with the caller's, and it holds no ops powers whatever its worker holds. Emitting a result is authorized as a `put` for the acting
agent, so an ack-emitted record cannot bypass put-authorization or the grant's write-side pattern
check.

## 5. Defaults

- `radia dev` binds loopback, `--auth required` is the default, and a request with no header is
  `401 auth_required`. `--auth open` is an explicit hole, and nothing radia ships relies on it.
- A credential is never injected into the served console page, which is public. The console shows
  a sign-in screen until it holds a token, and resolves who that token is through
  `/v0/ops/permissions` rather than assuming a token means operator.
- An unknown field on a grant body is refused. `pattern` is optional and omitting it means the
  whole kind, so a misspelled `patern` once validated cleanly and committed an unscoped grant.
