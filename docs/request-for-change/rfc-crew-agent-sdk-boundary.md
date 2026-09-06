---
title: Crew Agent SDK Boundary — isolate the codebase from ACP, and name the host contract
status: draft
revision: v3
author: zejiangg, with Kiro
created: 2026-08-28
last-audited: 2026-08-28
audited-at: dc88f142b
doc-pr:
implementation-prs: []
tracking-issues: []
supersedes: []
superseded-by: []
---
# RFC: Crew Agent SDK Boundary — isolate the codebase from ACP, and name the host contract

- Status: draft — nothing proposed here has shipped. The migration is additive:
  a new boundary package is introduced beside the current provider layer, and
  consumers move behind it one wave at a time under a shrink-only ratchet.
  Every question in §12 carries a disposition: the two that gated PR 2 and PR 4
  are decided, and the rest record a conservative default plus the condition that
  reopens it.
- Author: zejiangg, with Kiro
- Created: 2026-08-28
- Audited against: `dc88f142b`
- Related: `../system-specs/features/agent-host-contract.md` (the host contract
  this document's §6 summarises),
  `../system-specs/features/claude-code-provider.md`,
  `../system-specs/modules/acp-client.md`,
  `../system-specs/modules/providers.md`,
  `../system-specs/modules/session.md`,
  `../system-specs/modules/subagent.md`,
  and `rfc-pluggable-model-providers.md`
- Related unmerged work: PR
  [#6307](https://github.com/kirodotdev/KiroCrew/pull/6307) (`feat: add staged
  acp adapter admission`, head `7e3e27395`) adds an adapter descriptor and
  registry **inside** the ACP layer. It is orthogonal to this RFC and needs no
  change to land — see §11.2.

## 1. Summary

Introduce `kiro_crew.agent_sdk` as the **only** import surface through which the
rest of the codebase talks to an agent backend, and make `kiro_crew.acp` private
to a single driver behind it.

Today there is a package named `kiro_crew.providers` that looks like this
boundary and is not one. It re-exports ACP symbols rather than translating them,
its "provider-agnostic" event type is the ACP event class under an alias
(`src/kiro_crew/providers/base.py:30`), and 42 modules outside it import
`kiro_crew.acp` directly rather than going through it. The consequence is that
switching agent backends is not a driver swap; it is an edit across the whole
tree.

This RFC proposes three inversions, in order: the SDK owns the **types** that
cross the boundary, the SDK owns the **process and session lifecycle**, and a
shrink-only **import ratchet** makes the boundary enforceable instead of
aspirational.

It also separates a second body of coupling that the SDK does **not** address, and
that conflating with the first is how a provider migration fails halfway. Much of
what looks like backend coupling is coupling to a **host**: an agent-definition
layout, a session replay store, an identity store, a sandbox posture, an MCP
delivery channel, a billing surface, a permission engine, and the auxiliary
runtimes a host cannot discover for itself. Those are provider-scoped, and §6
summarises them against the full contract in
[`../system-specs/features/agent-host-contract.md`](../system-specs/features/agent-host-contract.md).

The evidence for that contract is not hypothetical. Claude Code is a real,
previously-exercised foreign host: the public core carries its protocol layer and
leaves the host glue to an internal companion, and the companion supplies a
complete answer to every bucket. Its profile is what tells us what a future
non-Kiro provider actually costs — and, read adversarially, it is also what
exposed a design flaw in an earlier draft of §5 (§5.3).

## 2. Motivation and current state

Verified at `dc88f142b` on 2026-08-28. Counts below are from `src/kiro_crew`,
excluding `src/kiro_crew/acp/` and `src/kiro_crew/providers/` themselves, and
excluding `test/` unless stated.

### 2.1 The existing seam is an alias, not a translation

`src/kiro_crew/providers/base.py:30`:

```python
from kiro_crew.acp.types import AcpEvent as LLMEvent  # noqa: F401
```

Every consumer that touches a turn reads ACP's own dataclass. `base.py` further
re-exports 13 `EVENT_*` constants from `kiro_crew.acp.types` unchanged, so the
event vocabulary is ACP's vocabulary with a different import path. There are
**466** `EVENT_*` / `STOP_REASON_*` usages outside the ACP package.

`AcpEvent` (`src/kiro_crew/acp/types.py:725`) carries 30 fields. Roughly a third
are not domain facts:

| Field | Why it should not cross a boundary |
|---|---|
| `request_id: str \| int` | Raw JSON-RPC id |
| `options: list[dict[str, str]]` | Raw ACP permission `optionId` dicts |
| `raw_tool_params: dict \| None` | Pre-conversion ACP params |
| `tool_final: bool` | ACP `status=completed` marker |
| `tool_kind: str` | Raw ACP kind vocabulary |
| `runtime_global: bool`, `sub_session_id: str` | Runtime-multiplexing artifacts |
| `raw_params_trusted`, `shell_classified`, `mcp_identity_trusted`, `mcp_identity_ambiguous` | Driver-internal provenance/cache flags |

The `request_id` leak is the sharpest instance. `approve_tool(request_id)` /
`reject_tool(request_id)` take the wire id straight through; `chat_runner.py:7300`
keys `slot._approval_futures` on `str(event.request_id)`, and
`chat_runner.py:7487` ships `{"id": str(event.request_id)}` to the browser. A raw
JSON-RPC id is part of the frontend contract.

### 2.2 The boundary is bypassed

68 direct `kiro_crew.acp` import edges across 42 files. The heaviest:

| File | Edges |
|---|---|
| `src/kiro_crew/session.py` | 10 |
| `src/kiro_crew/subagent.py` | 5 |
| `src/kiro_crew/llm_helpers.py` | 3 |
| `src/kiro_crew/cli_doctor.py` | 3 |
| `src/kiro_crew/workflows/service.py` | 2 |
| `src/kiro_crew/slack/handler.py` | 2 |
| `src/kiro_crew/session_pid.py` | 2 |
| `src/kiro_crew/dashboard/chat_runner.py` | 2 |
| `src/kiro_crew/dashboard/handlers/core.py` | 2 |
| `src/kiro_crew/dashboard/handlers/agents.py` | 2 |

Several reach past the public surface entirely: `session.py` imports
`acp.session_handle._load_watchdog_settings`, `dashboard/session_memory.py`
imports `acp.runtime._get_rss_tree_mb` and `_iter_descendant_pids`,
`dashboard/stall_enrichment.py` imports `acp.liveness.socket_inodes` (a `/proc`
primitive), and `dashboard/steer_settle.py` imports `acp._dispatch.redact_text`.

`src/kiro_crew/mcp_tools/spawn.py` has zero ACP references — it consumes
everything through `subagent.py`. It is the only already-clean consumer and it is
the shape the rest should have.

### 2.3 Backend identity is a string that everyone compares

`ACP_BACKEND_KIRO = ""` / `ACP_BACKEND_KAS = "kas"` / `ACP_BACKEND_CLAUDE =
"claude"` (`src/kiro_crew/acp/types.py:109-113`) are imported and compared
directly in the dashboard turn loop (`chat_runner.py`), the platform default
provider map (`platform/defaults.py`), the prerequisite gate
(`dashboard/handlers/kiro_prerequisite.py`), and the prompt-context builder
(`context.py`). Behaviour is gated by seven opt-in frozensets in the same file
(`ACP_BACKENDS_SESSION_SHARING`, `_STEER`, `_INTERNAL_SANDBOX`, `_ACP_RUNTIME`,
`_KIRO_IDENTITY_STORE`, …), so a consumer that wants to know "can this session be
steered?" asks "is this backend in this set?" instead.

### 2.4 ACP lifecycle state lives outside the ACP package

- `session.py:1108` `_warm_pool: asyncio.Queue[tuple[LLMProvider, float]]` — the
  pre-spawned process pool.
- `session.py:1136` `_bg_runtime: AcpRuntime | None` — a shared multiplexed
  runtime.
- `session.py:1153` `_subagent_runtimes: dict[str, AcpRuntime]` — per-parent
  runtime map.
- `session.py:1160-1162` `_rss_max_mb`, whose settings loader is imported from
  *inside* the ACP package.
- `session_pid.py` owns the whole PID lifecycle for agent processes, while
  `acp/worker_pool.py:49` imports `register_protected_pid` /
  `unregister_protected_pid` back from it behind a `try/except` — the import
  cycle already exists and is already being worked around.

So the process supervision decision is currently made in **both** directions at
once. No boundary can be drawn without settling it.

### 2.5 What this costs, measured on KAS

A second backend already exists and it is instructive that adding it did not
require a driver — it required branches. `runtime.py` and `session_handle.py`
carry explicit KAS arms, `session_handle.py` has five `_handle_kas_*` methods,
and the dashboard, config loader and doctor each learned the new id. A third
backend pays the same price again, in the same places.

### 2.6 What this costs, measured on a foreign host

KAS understates the cost, because KAS *is* kiro-cli (`kiro-cli acp
--agent-engine v3 --auth-method cli`) and therefore shares Kiro's identity store,
runtime, steer extension and model vocabulary. Claude Code is the only genuinely
foreign host this repository has ever carried, and its price is visible today as
**permanently dormant conditional surface** in the public core.

The registration seam is coherent: `ProviderRegistry.register_acp_backends` /
`create_factory` (`platform/interfaces.py:66-90`), a documented no-op default
(`platform/defaults.py:41-48`), one wiring site (`platform/bootstrap.py:220-229`),
and an explicit rule that the core never imports the companion. Everything below
it is not — the *behaviour* the companion must supply is delivered through three
kinds of undeclared hole:

| Kind | Count | Failure mode when the companion omits it |
|---|---|---|
| `getattr`-by-name seams whose target the core never defines — `getattr(self, "_write_claude_local_settings", None)` (`acp/client.py:2742`, `:3351`) | 2 | Silent: no permission mode, and the context window collapses from 1M to 200K |
| Methods returning a neutral value purely so a companion can override them — `_claude_session_mcp_servers() -> []` (`acp/client.py:2335-2346`) is the type case | 6 | Silent: a CC session gets **zero MCP tools**, as the docstring itself states |
| `ClaudeCodeProvider is not None and isinstance(...)` guards against a name hard-coded to `None` (`session.py:170`, `subagent.py:131`) | 11 sites | Statically unreachable; nine `session.py` branches and two `subagent.py` branches are dead-but-maintained |
| Defensive attribute probes across the provider boundary (`session.py:3356` `_proc`, `:3360` `_active_proc`, `chat_runner.py:867`, `knowledge/llm_pool.py:325`) | 4 | Duck typing in place of a type |
| Comment clusters naming the companion or a deleted module as the supplier of behaviour | 19 | The seam's real contract lives in prose |
| Refusal / downgrade mechanisms, including the degrade log line at `config/loader.py:4647-4652` and five capability non-memberships | 9 | — |
| Live `_is_claude` branches inside `acp/` | 13 | — |
| CC-symbol lines in `src/kiro_crew` | 146 (352 with `test/`) | — |

None of the three hole kinds is declared in a Protocol, none is type-checked, and
none fails loudly when forgotten. That is the concrete cost this RFC's driver
contract is meant to replace, and it is why §6 exists as a contract rather than as
a list of observations.

## 3. Goals

1. Exactly one import path from application code to an agent backend:
   `kiro_crew.agent_sdk`. Enforced mechanically, with a baseline that can only
   shrink.
2. No ACP protocol shape crosses that boundary — no JSON-RPC ids, no raw ACP
   option dicts, no raw tool params, no multiplexing artifacts.
3. No consumer branches on a backend id. Consumers ask semantic capability
   questions, and where a backend *lacks* an operation they test for a protocol
   rather than reading a boolean (§5.3).
4. Agent process and session lifecycle state has a single owner, and the
   existing `session_pid` ↔ `worker_pool` cycle is gone.
5. The host contract is written down, per provider, with "not supported" as a
   valid declaration that degrades a Crew surface rather than being assumed away.
6. Adding a driver becomes: implement the protocols it can honour, declare a host
   profile, add no consumer edits.

## 4. Non-goals

1. **Not** making the adapters in #6307 work, or turning its descriptor into a
   behavioural interface. That is driver-internal and below this boundary.
2. **Not** building the host-contract seams. §6 and the host-contract spec record
   the contract; converting agent-spec writing, session replay, sandbox
   delegation or credit accounting into abstractions is separate work and out of
   scope — with two exceptions promoted into PR 3 because the CC review showed
   the boundary cannot be drawn without them (§7, PR 3).
3. **Not** adding a provider, and **not** re-adding a provider selector.
   `docs/system-specs/features/claude-code-provider.md` carries a standing rule —
   *"Do not re-add the registration glue or a provider selector"* — and `AGENTS.md`
   lists other providers under *Never re-add*. This RFC honours both: Claude Code
   appears here **only as evidence** of what a foreign host requires. Whether
   `agent.provider` ever becomes selectable is a question for
   `rfc-pluggable-model-providers.md`.
4. **Not** changing ACP wire behaviour, event kind string values, or the browser
   payload shape.
5. **Not** a rename-only change. A boundary that re-exports is what we already
   have.

## 5. Design

### 5.1 Layering

```
consumers        dashboard/  slack/  discord/  telegram/  messaging/
                 session.py  subagent.py  apps/  cli_*.py  workflows/
                        |
                        |  may import ONLY kiro_crew.agent_sdk
                        v
                 kiro_crew.agent_sdk          domain types, role protocols,
                                              capabilities, supervisor
                        |
                        |  resolves drivers through a registry
                        v
                 kiro_crew.agent_sdk.drivers.acp
                                              the ONLY module permitted to
                                              import kiro_crew.acp
                        v
                 kiro_crew.acp   (private)    wire, dialects, adapters,
                                              session handles, worker pool
```

If this goes red you introduced a boundary violation; fix the import direction,
do not relax the rule.

`kiro_crew.providers` becomes a thin deprecated shim during migration (§9) and is
deleted at the end.

### 5.2 The SDK owns the types

**`AgentEvent`.** A new dataclass in the SDK, built by the driver from
`AcpEvent`. Field disposition:

| Disposition | Fields |
|---|---|
| Keep as-is | `kind`, `text`, `tool_call_id`, `title`, `tool_purpose`, `context_usage_pct`, `stop_reason`, `tool_input`, `tool_input_redacted`, `tool_output`, `usage`, `server_name`, `oauth_url`, `subagents`, `todo`, `is_shell`, `tool_name`, `mcp_server_name`, `diff_old_text`, `diff_path` |
| Replace | `request_id` → `approval: ApprovalToken \| None`; `options` → `choices: tuple[ApprovalChoice, ...]`; `tool_final` → `status: ToolStatus`; `tool_kind` → a domain enum |
| Do not cross | `raw_tool_params`, `raw_params_trusted`, `shell_classified`, `mcp_identity_trusted` |
| Collapse | `runtime_global`, `sub_session_id`, `mcp_identity_ambiguous` → one `attribution: ChildAttribution \| None` value object, non-`None` only on subagent-related events (decided, §12.2) |

Event **kind string values stay byte-identical** (`"text_chunk"`,
`"tool_call_update"`, `"end_turn"`, …). They are persisted and serialized; only
the Python symbol's home moves. The SDK re-declares them as its own constants and
the driver asserts equality with the ACP ones in a parity test.

**`ApprovalToken`.** An opaque, stable-serializable string minted by the SDK when
it emits a permission event, valid only for the live turn on the session that
minted it. Chosen over an integer handle or a structured object specifically so
`chat_runner.py:7487`'s `{"id": "..."}` payload to the browser does not change
shape. The driver keeps the private token → JSON-RPC id map. Consumers never see
a wire id again.

**Error taxonomy.** SDK-owned exceptions replacing the eight `Acp*` classes that
currently appear in 14 non-ACP modules: `AgentError`, `AgentAuthRequired`,
`AgentProcessDied`, `AgentTimeout`, `AgentBusy`, `AgentModelUnavailable`,
`AgentRuntimeDead`, `AgentRequestTimeout`, plus one addition the CC review
required — **`AgentRuntimeMissing`**, raised by `AgentSupervisor.preflight()` when
a declared auxiliary runtime cannot be resolved. Today a missing
`CLAUDE_CODE_EXECUTABLE` produces a warning log and then death at `session/new`
(`acp/client.py:2807-2820`); a declared requirement plus a preflight turns that
into a diagnosable refusal. `AgentAuthRequired` must remain distinguishable
because the readiness gate depends on it (§10.4).

**`SessionCapabilities`.** A frozen value read off the session. Named
`SessionCapabilities`, not `AgentCapabilities`, because the internal companion
already ships an unrelated module of that name — one that installs MCP servers,
skills and agent packages — and the collision would be genuinely ambiguous.

Each question is semantic, and each replaces a place that asks backend identity
today:

| Question | Asked today as |
|---|---|
| `can_steer` | `ACP_BACKENDS_STEER` membership (`acp/types.py:151`) |
| `multiplexes_sessions` | `ACP_BACKENDS_ACP_RUNTIME` (`:180`) |
| `shares_subagent_session` | `ACP_BACKENDS_SESSION_SHARING` (`:148`) — a *subset* of the above, which one boolean cannot express |
| `self_sandboxes` | `ACP_BACKENDS_INTERNAL_SANDBOX` (`:167`) |
| `recyclable_on_host_logout` | `ACP_BACKENDS_KIRO_IDENTITY_STORE` (`:196`) |
| `bills_host_credits` | `bills_kiro_credits` membership |
| `reports_subagent_progress` | descriptor level |
| `activates_agent_by_mode` | `acp/client.py:3521` `if self._is_kiro:` |
| `native_slash_commands` | `providers/acp.py:1263` `if self.is_claude_backend:` |
| `reports_compaction_status` | a comment at `providers/acp.py:1297-1306` |
| `resume_needs_local_transcript` | `acp/client.py:3408` `if self._is_claude:` |
| `injects_mcp_per_session` | `acp/client.py:3313` / `:3434` |
| `advertised_ids_comparable` | `acp/client.py:2438` `if self._is_kiro and self._model_is_unusable(...)` |
| `substitutes_models_at_session_new` | `acp/client.py:3323` |
| `can_reset_config_default` | `providers/acp.py:1139` |
| `effort_applied_at_spawn` | `providers/acp.py:957` |
| `permission_mode_is_spawn_scoped` | the companion’s provider, itself `getattr(client, "_is_claude", False)` |
| `writes_own_transcripts` | `acp/client.py:3505` `if self._session_id and self._is_kiro:` |

Two of these deserve a note because an earlier draft got them wrong.
`recyclable_on_host_logout` was drafted as `own_identity_store`, which **inverts**
the meaning: the set records an *authorization* — that a `kiro-cli logout` may
retire this backend's live child — not ownership of a store. A CC session must
never be recycled on a Kiro logout, so the polarity matters. And
`shares_process` was one boolean over two sets that `acp/types.py:177-181`
explicitly documents as a superset relation; it is split above.

### 5.3 The SDK surface: presence-tested role protocols, not a flat interface

`LLMProvider` has 33 members; `AcpSessionProvider` implements roughly 60 plus 11
underscore-prefixed AcpClient-parity shims (`_model`, `_work_dir`, `_pid`,
`_child_pids`, `_start_time`, `_drain_post_compaction_metadata`, …). The SDK
surface must be **smaller** than that, and it must not be flat.

An earlier draft of this section proposed four mandatory protocols with
capabilities as booleans beside them. Checking that draft against Claude Code
found the flaw: **capabilities gate behaviour, but not method presence.** A
foreign host's profile is not "kiro-cli minus a few flags" — it is a set of
absences that change control-flow *shape*. No `set_mode` removes the home of a
fail-closed privilege check (`acp/client.py:3513-3536`). No compaction
notification inverts a two-call API into one. No `commands/execute` deletes a
method the draft never drew at all, though `acp/client.py:4860-4920` is real
surface with a real degradation branch at `providers/acp.py:1263-1268`. Under a
flat mandatory interface every absence becomes an implement-and-raise stub, and
the `not is_claude` inference the frozensets were built to kill reappears at the
SDK boundary where consumers can no longer see it.

So: **the mandatory core is small, every optional operation is its own
`runtime_checkable` protocol, and a consumer tests for the protocol rather than
reading a flag.** Each capability question in §5.2 that corresponds to an
operation gates a protocol, not a branch.

Mandatory:

| Protocol | Members |
|---|---|
| `AgentSession` | `submit(message) -> AsyncIterator[AgentEvent]`, `cancel`, `approve(token, *, always=False)`, `reject(token)`, `has_active_turn`, `wait_turn_done`, `is_process_alive`, `new_conversation` |
| `AgentSessionInfo` | `session_id`, `served_model`, `available_models`, `effort_levels`, `context_usage`, `capabilities` |

Optional, presence-tested:

| Protocol | Members | Gated by |
|---|---|---|
| `AgentSteerable` | `steer`, `last_steer_monotonic` | `can_steer` |
| `AgentCompactable` | `compact() -> CompactionResult` | — |
| `AgentCompactionReporting` | `wait_for_compaction` | `reports_compaction_status` |
| `AgentCommandable` | `send_command`, `stream_command` | `native_slash_commands` |
| `AgentModeSwitchable` | `set_mode` | `activates_agent_by_mode` |
| `AgentSessionConfig` | `set_model`, `set_config_option`, `supports_config_option`, `reset_config_option() -> bool` | `can_reset_config_default` |

`compact()` returns a `CompactionResult` rather than being a two-call
`compact` + `wait_for_compaction` pair, because the two-call form encodes Kiro's
asynchronous model. On a host that compacts synchronously inside `session/prompt`
no status notification ever arrives, `providers/acp.py:1378-1386` leaves the
result unset, and the wait can only time out. A driver that *does* report status
additionally implements `AgentCompactionReporting`.

`set_mode` is deliberately **not** a live setter in `AgentSessionConfig`. It is
step 4 of session initialization and it carries a fail-closed privilege check
(`acp/client.py:3513-3536`), so agent activation belongs to `create_session`;
`AgentModeSwitchable` exists only for hosts that can also switch mid-session. A
driver whose host cannot activate an agent by mode must declare
`activates_agent_by_mode = False`, and the SDK must refuse to *silently* widen
privilege when it is absent.

`AgentSupervisor` (mandatory for a driver, not per session):

| Member | Note |
|---|---|
| `preflight() -> None` | Resolves the entry point and every declared auxiliary runtime; raises `AgentRuntimeMissing`. Runs before a session is attempted. |
| `create_session(request) -> AgentSession` | May return a session whose served model differs from the requested one; the substitution is reported as an event (`acp/client.py:3313-3332`). |
| `destroy_session`, `cleanup_session` | `cleanup_session` is a real member, not a shim: on a host that writes its own transcripts it must delete them (the companion does exactly this today). |
| `adopt_session` | Ownership transfer of a live session. |
| `persist_permission_mode(mode)` | Spawn-scoped on hosts where auto mode is a file consumed at the *next* spawn, hence a supervisor concern rather than a session setter. |
| `health`, pool operations | §5.4. |

`SessionRequest` is one frozen record, replacing the 19-kwarg
`AcpProvider.__init__` and the two `_acp` closures in `config/loader.py`. Its
field list is taken from the only factory that has been exercised against a
foreign vendor (the companion’s session factory) rather than
invented: `session_key`, `agent`, `channel_id`, `cwd`, `extra_env`, plus a
base-versus-override distinction the flat draft lost —
`model` / `model_override`, `effort_per_model` (a mapping, not a scalar) /
`reasoning_effort_override`, and
`permission_mode` / `permission_mode_override`. Two fields the CC review found
missing: `resume_session_id`, and a declared per-session `mcp_servers` extension
point so injecting servers on the wire is a contract rather than a `getattr`
override.

The 11 private shims stay out. Exactly one of them
(`_drain_post_compaction_metadata`, reached by `getattr` at
`providers/acp.py:1474`) has a cross-package caller today, and it is inside the
would-be driver — so nothing outside loses access.

### 5.4 The supervisor owns process and session lifecycle

Moved into the SDK: the warm pool (`session.py:1108`), the shared background
runtime (`:1136`), the per-parent subagent runtime map (`:1153`), the RSS
watchdog threshold and its settings loader (`:1162`), provider adoption
(`session.py`), and agent-process PID tracking, sweeping and reaping (currently
`session_pid.py`).

This is the step that makes the boundary real. Without it `SessionManager` still
holds ACP's guts and the SDK is decoration. It also settles §2.4: **the
supervisor owns process supervision**, `session_pid.py`'s agent-process half
moves in, and the `worker_pool.py:49` `try/except` cycle guard is deleted rather
than re-pointed.

Deliberately *not* moved: `SessionManager`'s slot/transcript/channel
responsibilities. The supervisor takes the agent-process concerns only.

### 5.5 What stays inside the driver

Wire dialect, argv resolution, adapter descriptors and admission gating, model-id
translation and downgrade, per-adapter quirks, the permission **option**
vocabulary and its per-request `optionId` echo, protocol-version selection,
credential scrubbing on spawn, and the KAS-vs-kiro-cli branches now in
`runtime.py` / `session_handle.py`. #6307's registry and `BackendDescriptor` live
here untouched.

## 6. The host contract

The coupling counted in §2.1–2.4 is ACP-protocol coupling. The coupling counted in
§2.6 is something else: `kiro-cli` appears in 193 files, and most of those
references are not about the protocol. They are about a **host** — its filesystem
layout, agent format, session store, credential store, sandbox posture, MCP
delivery channel, billing surface, permission engine, and the extra runtimes it
cannot find for itself.

The full contract, with all three backends side by side and every "must declare"
line, is
[`../system-specs/features/agent-host-contract.md`](../system-specs/features/agent-host-contract.md).
This section states only its shape and the two conclusions that bind this RFC.

### 6.1 Eight buckets, and who proves each one is provider-scoped

| Bucket | The divergence that proves it is not universal | Proven by |
|---|---|---|
| 1 Agent definition and layout | Markdown-with-frontmatter in a different directory, no `--agent`, **no `set_mode` at all** | CC |
| 2 Session persistence | A foreign transcript store keyed by an encoded `realpath(cwd)`, a path-less `session/load`, in-band synchronous `/compact`, one session per process | CC |
| 3 Identity and auth | Its own sign-in and its own credential command; a host logout must **not** retire its children | CC |
| 4 Sandbox | No internal sandbox, so Crew's own wrap must stay — the one membership set that fails *open* | CC |
| 5 MCP server injection | Reads no file; servers must ride `session/new` **and** `session/load`, in a different shape | CC |
| 6 Usage, billing, credits | Dollars per token instead of host credits | CC |
| 7 Security and permission parity | A native permission engine upstream of and invisible to the host gate; a different option vocabulary with a real `reject`; auto mode as a per-session file | CC and KAS |
| 8 Auxiliary runtimes | A second native binary the adapter's own SDK will not find | CC |

KAS diverges on agent projection, permission vocabulary, prompt resolution and
MCP projection, but it is Kiro's own service and therefore shares the identity
store, the runtime, steer and the model vocabulary. **CC is the column that
matters**, and it is the reason this RFC treats the host contract as a first-class
artifact rather than a footnote.

### 6.2 The parity rule

When a foreign host lacks an enforcement **mode** rather than a rule, parity
cannot be reached by translation. kiro-cli's 42 "suspicious bash" patterns are
audit-only; CC has no audit-only mode, so they are deliberately not translated and
the gap is recorded as a known security gap
(the companion records it as such). The honest contract is therefore
**a declared capability plus a documented gap**, never a silent downgrade. §5.3's
presence-tested protocols exist so that a declaration of absence is visible in the
type system instead of arriving as a no-op.

### 6.3 Seam maturity, and what that means for scope

The buckets differ by orders of magnitude. Usage/billing is already a boolean
flag read by consumers. Permission vocabulary has a genuine shared seam
(`acp/kas_permissions.py`, used by both the wire projection and the on-disk writer
so they cannot drift). Agent definition is half-sealed: `acp/kas_agents.py` is a
real projection, but the *writer* has none. Session persistence, MCP injection,
regex-engine parity and auxiliary runtimes have **no seam at all**.

Those last four are also, precisely, CC's hardest requirements. §4.2 keeps
host-contract seam-building out of scope, with two exceptions promoted into PR 3
because the CC review showed the boundary cannot honestly be called drawn without
them: **per-session MCP injection** and **transcript ownership**. The rest stay
documented-only, and PR 6's exit criterion is worded so that "sealed" means the
import boundary, not the host contract (§7).

## 7. Migration plan: six stacked PRs

Each phase is independently shippable and independently abandonable.

### PR 1 — declare the boundary and ratchet the inventory

Create `src/kiro_crew/agent_sdk/` with the layer docstring and nothing else.
Add `scripts/check_acp_import_boundary.py` and
`.github/acp-import-baseline.txt` seeded with today's counts. No code moves.
The host-contract spec already exists
(`docs/system-specs/features/agent-host-contract.md`, added with this RFC), so
PR 1 only keeps it reachable and in sync.

- Exit: the checker exits 0 on `dc88f142b`'s tree with the seeded baseline, and
  exits non-zero when a new `kiro_crew.acp` import is added to any file.
- Exit: the baseline records 68 edges across 42 files.
- Exit: `--test` plants one probe per rule family and is run first in the same CI
  step.
- Exit: `./scripts/docs-lint.sh` passes and the host-contract spec is reachable
  from `docs/system-specs/features/README.md`.
- Blocked on: nothing.

### PR 2 — the SDK owns the types

`AgentEvent`, `ApprovalToken`, `ToolStatus`, `CompactionResult`,
`SessionCapabilities`, the error taxonomy including `AgentRuntimeMissing`, and the
driver translation. `providers/base.py` stops aliasing `AcpEvent`. Consumers keep
working through the deprecated shim (§9).

- Exit: `grep -rn "AcpEvent" src/kiro_crew` outside `acp/` and the driver returns
  zero hits.
- Exit: a parity test asserts every SDK event-kind and stop-reason string equals
  its ACP counterpart.
- Exit: `approve`/`reject` accept only `ApprovalToken`; the browser payload at
  `chat_runner.py` is byte-identical before and after.
- Exit: no `request_id`, `options`, `raw_tool_params`, `runtime_global` on
  `AgentEvent`.
- Blocked on: nothing. §12.2 settled the attribution shape (`ChildAttribution`
  value object).

### PR 3 — capabilities and protocols replace backend ids

`SessionCapabilities` on every session, and the presence-tested role protocols of
§5.3 declared as `runtime_checkable`. The seven `ACP_BACKENDS_*` frozensets stop
being read outside the driver. This PR also lands the two promoted host-contract
contracts: a declared per-session `mcp_servers` extension point on
`SessionRequest`, replacing the `_claude_session_mcp_servers() -> []` override
hole, and `writes_own_transcripts` + `AgentSupervisor.cleanup_session` as the
declared home of transcript ownership.

- Exit: zero `ACP_BACKEND_*` imports outside `acp/` and the driver.
- Exit: zero `== ACP_BACKEND_` comparisons anywhere in consumer code.
- Exit: every optional operation is reached through an `isinstance` protocol test,
  and no consumer calls a method that a driver implements only to raise.
- Exit: a test asserts each capability question in §5.2 has exactly one consumer
  spelling, so a second `not is_claude`-shaped inference cannot reappear.
- Blocked on: PR 2.

### PR 4 — the supervisor takes the lifecycle

Warm pool, background runtime, per-parent runtime map, RSS watchdog, adoption,
and agent-process PID tracking move into `agent_sdk`. The
`worker_pool.py:49` cycle guard is deleted. `preflight()` lands here.

- Exit: `session.py` declares no `AcpRuntime`-typed attribute.
- Exit: `acp/worker_pool.py` contains no `from kiro_crew.session_pid import`, and
  no `try/except ImportError` around it.
- Exit: `dashboard/session_memory.py` and `dashboard/stall_enrichment.py` import
  no underscore-prefixed ACP names.
- Blocked on: PRs 2-3. §12.1 settled PID ownership on the supervisor, so this
  phase is design-unblocked.

### PR 5 — consumer migration waves

Four waves, each driving the ratchet down: dashboard; messaging plus the seven
channels; apps plus workflows plus knowledge; CLI plus config plus platform.
Each wave is its own commit and can ship alone.

- Exit: after each wave the baseline shrinks and never grows.
- Exit: `mcp_tools/spawn.py` remains at zero, unmodified.
- Blocked on: PRs 2-4.

### PR 6 — seal the import boundary

Baseline reaches zero for every path except the driver. `kiro_crew.providers` is
deleted. The checker's allowlist is reduced to the single driver module. Specs
updated in the same commit per `docs/README.md`.

"Sealed" here means the **import** boundary. The host contract is not sealed by
this PR and must not be described as such: four of its eight buckets still have no
seam, and the spec doc names them.

- Exit: `.github/acp-import-baseline.txt` lists only
  `src/kiro_crew/agent_sdk/drivers/acp.py`.
- Exit: `docs/system-specs/modules/providers.md` and `acp-client.md` describe the
  boundary as built.
- Exit: the host-contract spec's seam-status table is re-audited in the same
  commit, and every bucket still lacking a seam is stated as open.
- Blocked on: PR 5.

### Deferred, tracked separately

Host-contract seams for session persistence, regex-engine parity and auxiliary
runtimes. A second driver. Whether `agent.provider` becomes selectable
(`rfc-pluggable-model-providers.md`).

## 8. Enforcement and testing strategy

### 8.1 The ratchet reuses an established pattern

Model on `scripts/check_subprocess_encoding.py` with
`.github/subprocess-encoding-baseline.txt`, not on `error-code-baseline.json` and
not on `config-baseline.json`. It is the only existing mechanism that matches an
import rule on all four properties we need:

1. Per-file `<count> <path>` lines, shrink-only: a file absent from the baseline
   must be clean, a baselined file may not grow, and a file whose count has
   shrunk must be pruned.
2. `--test` plants one probe per rule family and runs first in the same CI step.
   Per `docs/ci/harness-parity-gate.md`: a gate that has silently stopped
   matching reads as a green signal, which is worse than no gate.
3. `--update-baseline` only deletes lines, and a missing baseline is a hard error
   rather than a regeneration. Without this the boundary can be laundered in one
   commit.
4. Pure stdlib over `src/`, no CI install step.

`config-baseline.json` is rejected because regenerating it is expected, so it
does not ratchet. `lint:theme-colors` is rejected because it exits 0 by design.

### 8.2 The architecture test

An `ast`-based test in house style, modelled on
`test/test_messaging_import_purity.py` and `test/test_workflows_architecture.py`:

- Forbidden set **derived**, not hand-listed — a hand-kept list fails open, which
  is exactly how the messaging test previously missed two channels.
- A coverage-of-the-contract test asserting every module under `src/kiro_crew` is
  classified as consumer, SDK, or driver, so a new package cannot appear
  unclassified.
- `test_every_recorded_violation_still_exists` — a stale exemption fails.
- Negative probes: a violation outside the table is still caught; a
  `TYPE_CHECKING`-only import is still refused; `importlib.import_module` and
  `__import__` do not escape the scan.
- A `scanned` counter so an empty scan cannot pass green.

### 8.3 Behavioural parity

- Event-kind and stop-reason string equality between SDK and ACP constants.
- A translation test per `AcpEvent` field: kept fields round-trip, dropped fields
  have no SDK attribute, replaced fields map correctly.
- An approval test proving a token from turn N is refused on turn N+1 and on a
  different session.
- A protocol-conformance test per driver: for every optional protocol, the driver
  either satisfies it or the corresponding capability question is False — never
  both, and never neither. This is what stops an implement-and-raise stub.
- The existing dialect-parity harness continues to run against the driver
  unchanged.

## 9. Backward compatibility

- **Browser wire unchanged.** `ApprovalToken` is a string and serializes into
  today's `{"id": "..."}` payload. No frontend change in any phase.
- **Event kind values unchanged.** Persisted transcripts and channel payloads
  keep working; only the Python import path moves.
- **`LLMProvider` survives migration.** `kiro_crew.providers.base` becomes a
  deprecation shim re-exporting the SDK role protocols, so PR 2 does not have to
  land with all 42 consumer files. It is deleted in PR 6, not before.
- **Config keys unchanged.** `agent.acp_backend` and
  `agent.acp_backend_allow_ungated_tools` keep their names and values; the SDK
  reads them through the driver. Renaming them is a separate change with its own
  migration.
- **The dormant CC seam keeps working.** The companion's registration path
  (`ProviderRegistry.register_acp_backends` / `create_factory`) is unchanged by
  every phase. What changes is that the three kinds of undeclared hole in §2.6
  gain typed replacements — a driver may adopt them incrementally, and until it
  does the existing overrides continue to function.
- **ACP behaviour unchanged.** No phase alters wire traffic, spawn argv, or
  permission routing.

## 10. Security considerations

1. **The permission path is the security boundary.** Today `approve_tool` accepts
   any `str | int` and matches it against a pending-request map. An
   `ApprovalToken` must be minted by the SDK, bound to one turn on one session,
   single-use, and rejected otherwise — so a stale or forged id from a
   long-running browser tab cannot approve a later tool call. This is a
   strengthening, and §8.3 asserts it.
2. **Deny-rule parity is host contract, not SDK.** The 137 built-in patterns are
   enforced at Crew's own PreToolUse gate and deliberately not delegated to the
   provider (`security.py:50-58`). The boundary must not create the impression
   that a driver can take over command denial; §6 records the engine-class
   dependency instead.
3. **An absent enforcement mode must not read as an enforced one.** §6.2's rule
   is a security requirement, not a documentation preference: a foreign host that
   cannot express audit-only must declare the gap. A presence-tested protocol
   makes the absence type-visible; a boolean beside a mandatory method does not.
4. **Skipping agent activation must not widen privilege.** `set_mode` carries a
   fail-closed check (`acp/client.py:3513-3536`). A driver declaring
   `activates_agent_by_mode = False` must cause the SDK to refuse, not to proceed
   with an unactivated agent.
5. **Credential scrub stays in the driver.** `scrub_agent_denied_env` and
   `scrub_agent_subprocess_env` exist because ACP spawn paths copy raw
   `os.environ`. They must move with the spawn code, not be re-derived above the
   boundary where the env is already assembled.
6. **Auth failure must stay legible.** `AcpAuthRequired` currently reaches
   `dashboard/kiro_readiness.py`, which lets ordinary sends run ungated and blocks
   pre-turn and destructive endpoints. A collapsed error taxonomy that folded it
   into a generic `AgentError` would silently un-gate those endpoints.
7. **Logout authorization must not be inverted.** `recyclable_on_host_logout`
   replaces a set whose name suggests ownership but whose meaning is
   authorization (`acp/types.py:182-196`). Getting the polarity wrong would let a
   host logout retire a foreign backend's live child.
8. **Sandbox delegation must stay fail-closed.** Every detection failure in
   `sandbox.py` resolves toward Crew's own sandbox. `self_sandboxes` must default
   to `False` for an unknown provider, matching `bills_kiro_credits`'s existing
   fail-safe treatment of unknown ids.
9. **The ratchet is a security control.** It is what prevents a future PR from
   reintroducing a raw wire id into a browser payload. Its `--test` self-probe
   and refuse-to-regenerate property are the reasons it is trustworthy.

## 11. Alternatives considered

### 11.1 Evolve `kiro_crew.providers` in place

Rejected. It is already positioned as the boundary and has not become one in
practice: it re-exports rather than translates, and 42 modules bypass it. Fixing
it in place means the same three inversions plus keeping a name whose current
meaning is "ACP with an alias". A new package makes the rule statable — *this
directory may import ACP, that one may not* — which is what the ratchet needs.

### 11.2 Turn #6307's descriptor into a behavioural interface first

Rejected as the *first* step, not on merit. #6307's `BackendDescriptor` is a
frozen data record with no adapter ABC, and the work actually done for a backend
still lives in id-keyed `if/elif` chains — so adding an adapter means a
descriptor row plus edits at several dispatch sites. Making that a real Protocol
is worthwhile, but it is entirely **below** this boundary: it improves how the
driver is organised internally and leaves all 466 event-vocabulary usages and 68
import edges untouched. #6307 should land on its own merits; this RFC's Phase 1
does not touch it.

### 11.3 Adopt `import-linter`

Rejected. It is not in the version set, and
`test/test_workflows_architecture.py` already establishes the house alternative:
a pure-stdlib `ast` scan with a per-module allowlist and a
coverage-of-the-contract test. Matching that costs less than adding a dependency
and keeps the gate runnable without an install step.

### 11.4 One big-bang boundary commit

Rejected. It would touch 42 files across every subsystem in one unreviewable
diff, and the two hardest decisions (§12.1, §12.2) would be settled implicitly
inside it rather than answered first.

### 11.5 Abstract the whole host contract now

Rejected for this RFC, on scope — with two exceptions. §6.3 covers eight buckets,
four of which have no seam whatsoever. Bundling all of it would make the SDK
boundary hostage to decisions about transcript formats and regex engines.
Documenting the contract is what lets that work start independently, and is what
stops us believing after PR 6 that a provider swap is finished. The two
exceptions — per-session MCP injection and transcript ownership — are promoted
into PR 3 because the CC review showed they are not optional to the boundary
itself: today they *are* the boundary, in the form of an override hole and an
`isinstance` guard.

### 11.6 Adopt the internal companion's provider abstraction

Rejected, but instructive. The internal companion ships two real backends and has
a module whose name suggests a capability model and another whose name suggests a
provider registry, so it looked like a working seam worth building on. It is not
one. Its provider registry is a little over a hundred lines whose
`register_acp_backends()` is an explicit no-op and whose factory dispatches on a
string compare against an env var, with no ABC or Protocol anywhere. The second
provider is implemented by subclassing the first and swapping `__class__` on a
live client, to avoid re-implementing the core client's ~110-line `__init__`.
The capability-sounding module is a name collision: it installs MCP servers,
skills and agent packages, and holds no per-provider feature table at all. And
`grep AcpEvent` across that package returns nothing — it has no event type of its
own, because it inherits the core's stream and uses ACP constants as its dispatch
vocabulary.

Adoption is impossible anyway: that registry is a *consumer* of an OSS-side
Protocol, so the seam this RFC must define is upstream of it by construction.
What it contributes is evidence and one artifact: its factory's keyword surface is
the only session-construction contract that has been exercised against a foreign
vendor, and §5.3 takes `SessionRequest` from it. Its `supports_permission_mode()`
returning `getattr(client, "_is_claude", False)` is a shipped instance of exactly
the defect §5.2 removes.

### 11.7 Keep capabilities as booleans beside a flat interface

Rejected, and this is the alternative the CC review killed. It was the earlier
draft of §5.3. Booleans gate behaviour but not method presence, so a driver for a
host that lacks steer, mode switching, slash commands, asynchronous compaction and
config reset must implement five methods purely to raise — and consumers, unable
to see that, either call them or reconstruct the very identity inference the
frozensets were introduced to remove. Presence-tested protocols cost one
`isinstance` at each optional call site and make the absence type-checkable.

The codebase already argues this against itself. The comment introducing
`ACP_BACKENDS_ACP_RUNTIME` (`acp/types.py:175-181`) says the four sites meaning
"kiro or kas" say so positively "rather than as `not is_claude_backend` — an
inference that silently captures every harness added later", and in the same
breath records that the set is a **superset** of `ACP_BACKENDS_SESSION_SHARING`.
That is both halves of this rejection written by the code it describes: the
inference is the hazard, and one boolean cannot carry two nested facts.

## 12. Open questions

All questions carry a disposition as of 2026-08-28. The two blockers are decided,
so §12.1 no longer gates PR 4 and §12.2 no longer gates PR 2. The others were
never blocking; each records a conservative default and the condition that
reopens it.

1. **Who owns agent-process supervision? — DECIDED: the supervisor.**
   `session_pid.py`'s agent-process half moves into `agent_sdk`; its non-agent
   PID duties (MCP probes, cron scripts) stay where they are. The
   `acp/worker_pool.py:49` `try/except ImportError` guard is **deleted**, not
   re-pointed.
   *Rationale:* the warm pool and background runtime move in PR 4 regardless,
   and kill authority has to travel with the pool it kills. The rejected
   alternative — SDK depends on `session_pid` — preserves the cycle and only
   renames it.
   *Revisit if:* a non-agent consumer turns out to depend on the agent-process
   tracking file format, in which case the file stays put and the supervisor
   writes through a narrow interface instead of owning it.
   **PR 4 is unblocked.**

2. **Does `AgentEvent` carry child attribution as an object, or flatten it? —
   DECIDED: a `ChildAttribution | None` value object,** non-`None` only on
   subagent-related events.
   Measured rather than assumed. Outside `acp/` and `providers/`, the three
   fields have **10 references across 4 files**: `dashboard/chat_runner.py:6624`,
   `:6743`, `:7820`; `subagent.py:1719`, `:1744`, `:6011`, `:6060`;
   `messaging/driver.py:468`; plus two comment lines. `mcp_identity_ambiguous`
   has **zero** external readers. The 466-usage figure in §2.1 counts the whole
   `EVENT_*` / `STOP_REASON_*` vocabulary; almost none of it reads attribution.
   *Rationale:* at 10 sites the cleaner shape costs nothing, and
   `runtime_global`'s meaning — a fanout frame with no owning session — is only
   legible beside `sub_session_id`.
   *Revisit if:* PR 2 finds a reader that needs attribution on a
   non-subagent event. That would mean the field is not attribution.
   **PR 2 is unblocked.**

3. **Is runtime multiplexing part of the SDK contract or driver-private? —
   DISPOSITION: driver-private, provisionally.** `AgentSupervisor` exposes "give
   me a session", never "give me a runtime". The capability split introduced in
   §5.2 (`multiplexes_sessions` versus `shares_subagent_session`) answers the
   consumer-facing question without exposing a runtime object.
   *Revisit if:* PR 4 cannot express warm-pool or background-runtime behaviour
   without a runtime-shaped argument crossing the boundary. Not blocking — PR 4
   produces the answer as a side effect of doing the move.

4. **Should host-contract declarations become code? — DISPOSITION: yes,
   eventually; not in this RFC.** The earlier draft deferred this on the grounds
   that "with one provider it would be a table with one row." That rationale was
   **wrong**: there are three backends, and the Claude Code row is complete. The
   trigger it named — a second driver being proposed — has effectively already
   fired, in another repository.
   What changes now: PR 1's checklist is written against three columns rather
   than one, and PR 3 lands the two declarations the boundary cannot do without
   (per-session MCP injection, transcript ownership). A full `HostProfile` type
   covering all eight buckets still waits, because four of them have no seam to
   type against yet (§6.3) — typing an unsealed bucket would freeze the wrong
   shape.
   *Revisit if:* a driver is proposed inside this repository, at which point an
   omitted declaration should fail at import rather than at runtime.

5. **Does the deprecated `providers` shim need a release window? —
   DISPOSITION: check, then decide inside PR 6.** Before PR 6 deletes
   `kiro_crew.providers`, grep the internal companion and the app catalogue for
   `kiro_crew.providers.base`. Zero hits → delete in PR 6. Any hit → one release
   window, and the shim carries its deprecation warning from PR 2 rather than
   PR 6.
   *Not blocking* — the check is cheap and belongs to PR 6's own checklist.

6. **Is protocol-presence testing the right consumer ergonomic? —
   DISPOSITION: yes for optional *operations*, no for optional *facts*.**
   §5.3 uses `isinstance(session, AgentCompactable)` for operations and keeps
   §5.2's questions as values for facts (`recyclable_on_host_logout`,
   `bills_host_credits`, `self_sandboxes`), because those gate policy rather than
   a call. The risk is a consumer writing a long `isinstance` ladder where a
   single question would do.
   *Revisit if:* PR 3 produces a call site testing three or more protocols to
   make one decision — that is the signal the split is drawn in the wrong place.
