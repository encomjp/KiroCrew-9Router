# Agent host contract

What an agent backend must supply to Kiro Crew *besides* speaking the Agent Client
Protocol. ACP defines the wire; this document defines the **host** — the
filesystem layout, agent-definition format, session store, credential store,
sandbox posture, MCP delivery channel, billing surface, and permission engine
that sit around the wire and differ per backend.

Three backends are described. Only two are selectable
(`ACP_BACKENDS_SELECTABLE`, `acp/types.py:129`); the third, Claude Code, is a
dormant seam in the public core that an internal companion package re-registers.
See [claude-code-provider.md](claude-code-provider.md) for why the standalone
provider was removed and for the standing rule that the registration glue and a
provider selector must **not** be re-added to the public core, and
[../modules/acp-client.md](../modules/acp-client.md) for the seam's protocol-level
details.

Claude Code is the only backend in this table that is a genuinely *foreign* host.
KAS is Kiro's own agent service reached through `kiro-cli acp`, so it shares
Kiro's identity store, runtime and model vocabulary. That is why the CC column,
not the KAS column, is what tells a future provider author what they are actually
signing up for.

Where a CC row is marked **(companion)**, the behaviour is supplied by an
internal companion package rather than by this repository, and is described here
by what it does. The companion is not public and its internals are deliberately
not cited: what a provider author needs from this table is the *requirement*, not
where one implementation happens to satisfy it.

## Column meaning

| Column | Backend |
|---|---|
| **kiro-cli** | `ACP_BACKEND_KIRO = ""` — the default. Kiro's CLI over ACP. |
| **KAS** | `ACP_BACKEND_KAS = "kas"` — Kiro's agent service, run through `kiro-cli acp --agent-engine v3 --auth-method cli`. |
| **CC** | `ACP_BACKEND_CLAUDE = "claude"` — `claude-agent-acp`. Dormant in the public core; live when the companion registers it. |

## 1. Agent definition and layout

| | kiro-cli | KAS | CC |
|---|---|---|---|
| Where a managed agent lives | `~/.kiro/agents/kirocrew.json` (+ `-lite`, `-conductor`, `-knowledge`, `-research`, `-heartbeat` variants, `agent_files.py:20-27`) | Nowhere on disk — agents ride `_meta.kiro.customAgents` on `session/new` (`acp/kas_agents.py:1-8`) | `~/.claude/agents/<name>.md`, Markdown with YAML frontmatter (companion: a JSON→Markdown agent translator writes it) |
| Format | JSON, validated with `deny_unknown_fields`; an unknown key silently falls back to the default agent, which is why bookkeeping lives in an `agent_state` sidecar (`agent.py:2645-2651`) | JSON projected onto the wire; `prompt` must be inlined, and `tools` absent means *no* tools (`kas_agents.py:11-16`) | YAML frontmatter (`name/description/model/permissionMode/tools/mcpServers/disallowedTools/hooks`) plus the system prompt as the body |
| Selection mechanism | `--agent <name>`; `$PWD/.kiro/agents` shadows `~/.kiro/agents` (`agent_discovery.py:46-51`) | `session/set_mode` against a wire-supplied agent | No `--agent` and **no `set_mode` at all**; the agent-activation privilege check is skipped (`acp/client.py:3513-3536`) |
| Hook event names | Crew's own | Hooks cannot ride an over-the-wire agent (`kas_agents.py:20-27`) | Renamed: `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `SessionStart` / `Stop` (companion) |
| Model pin | `model` in the spec; `"auto"` resolvable | Not projected | Separate `cc_model` sidecar field; cannot resolve `"auto"`, so background agents get a concrete pin (`agent.py:235-243`) |
| Protocol version | date-stamped `2025-08-22` | date-stamped | numeric `1` (`acp/client.py:150-152`, `:3376-3379`) |

**A provider must declare:** its definition target (or that there is none), its
validation strictness, whether bookkeeping may live in-spec, its
shadowing/selection rules, its hook-event vocabulary, whether it can resolve an
`"auto"` model, and its protocol-version shape.

## 2. Session persistence

| | kiro-cli | KAS | CC |
|---|---|---|---|
| Replay store | `<kiro home>/sessions/cli/<sid>.json` + `.jsonl`, read to resume (`session_storage.py:7-11`) | same store (it *is* kiro-cli) | Its own: `<cc root>/projects/<encoded cwd>/<sid>.jsonl` + `<sid>/`, plus `<cc root>/file-history/<sid>/` (companion: a dedicated transcript-cleanup module exists for exactly this) |
| Store root | `KIRO_HOME` | `KIRO_HOME` | `CLAUDE_CONFIG_DIR` → `<config dir>/cc-config` → `~/.claude` (companion) |
| Directory naming | session id | session id | `realpath(cwd)` with every non-alphanumeric replaced by `-`. **`realpath`, not `abspath`** — on cloud desktops `/home/<user>` is a symlink to `/local/home/<user>`, and an abspath encoding silently misses the transcript directory (companion) |
| `session/load` | carries the transcript path, guarded by a file-exists pre-check (`acp/client.py:3416-3417`) | same | carries **no** path; the pre-check is skipped entirely (`acp/client.py:3408-3414`) |
| Compaction | asynchronous, reported by `_kiro.dev/compaction/status`; the session id changes | same | `/compact` runs **synchronously inside `session/prompt`**; no status notification ever arrives, and the session id survives (`dashboard/chat_runner.py:8200-8213`) |
| Sessions per process | many (demultiplexed over `AcpRuntime`) | many | **one** (`acp/types.py:170-180`) |
| History replay | full history every turn, so one oversized image block wedges a transcript permanently and Crew repairs kiro-cli's own file (`session_image_repair.py:1-24`) | same | not applicable |

**A provider must declare:** its replay-store path and naming (or that it has
none), its store root and how that root is recomputable from config alone,
whether `session/load` needs a local transcript, its compaction model
(synchronous or reported), how many sessions share a process, and whether it
replays full history.

## 3. Identity and auth

| | kiro-cli | KAS | CC |
|---|---|---|---|
| Sign-in | `kiro-cli login`; SSO `--use-device-flow --license pro` (`kiro_prerequisite.py:80,90`) | same | brings its own: a credential-refresh **command** named inside its own `settings.json`, plus a provider-routing env var on the child (companion) |
| Credential store | projected, never copied: identity tables plus `migrations` rows plus selected `state` rows (`kiro_prerequisite.py:182-200`) | same store | its own; that refresh command is copied **verbatim** into the isolated seed at `0o600`. Dropping it breaks auth outright, so the seed cannot simply be emptied (companion) |
| Recyclable on a host logout | yes | yes (`ACP_BACKENDS_KIRO_IDENTITY_STORE`, `acp/types.py:182-196`) | **no** — a live CC child must survive `kiro-cli logout` |
| Entitlement discovery | account API | account API | runtime, from the advertised model set at session init; the registry is filtered down to it (`dashboard/handlers/agents.py:1151-1160`) |
| Readiness probe | `--version` then `whoami`, inside the OS sandbox (`kiro_prerequisite.py:4-7`) | same | binary resolution only |

**A provider must declare:** its login and org-SSO commands, its credential
locations, whether a host logout may retire its live children, how entitlement is
discovered, and its readiness probe.

The membership set is named `ACP_BACKENDS_KIRO_IDENTITY_STORE`, but its meaning is
*authorization*, not ownership: it records that a `kiro-cli logout` may retire
this backend's live child. A provider that brings its own auth is excluded, and
the exclusion is load-bearing.

## 4. Sandbox

| | kiro-cli | KAS | CC |
|---|---|---|---|
| Self-sandboxing | yes, ≥ 2.13, via `~/.kiro/settings/amazon-internal.json` key `"sandbox"` (`sandbox.py:2252-2262`) | KAS-owned Seatbelt/Bubblewrap, not passed by kiro-cli | **no** — "a Node or Python harness does not qualify" (`acp/types.py:160-167`) |
| Interaction with Crew's sandbox | mutually exclusive on macOS: internal ON → Crew seatbelt OFF, because seatbelt cannot nest (`sandbox.py:2257-2258`) | Crew seatbelt remains the sole isolation layer | Crew keeps its own wrap |
| Delegation predicate | `argv[0]` basename is literally `kiro-cli` (`sandbox.py:2305-2316`) | same binary | never delegates |
| Extra hidden paths | core tiers | core tiers | adds `.midway`/`.ada`/`.aws`/`sso`/`.krb5`, ADD-only on both tiers (companion) |

Every detection failure resolves toward Crew's own sandbox (`sandbox.py:2269-2300`).

**A provider must declare:** whether it self-sandboxes and how that is detected,
its nesting compatibility, its delegation predicate, and any additional paths its
credentials occupy. An unknown provider defaults to *not* self-sandboxing.

## 5. MCP server injection

| | kiro-cli | KAS | CC |
|---|---|---|---|
| Delivery channel | reads the agent file; Crew rewrites copies into `<config dir>/mcp-gateway/agents/` and injects stubs per session over `session/new`, which outranks the same-named agent-spec entry (`mcp_gateway/rewriter.py:3-8`) | not projected at all (`kas_agents.py:20-27`) | reads **no file**; servers must be passed as the `mcpServers` parameter on **both** `session/new` and `session/load` (`acp/client.py:3300-3311`, `:3425-3434`) |
| Shape | agent-file JSON | — | different: `env` and `headers` are **required arrays**; reshaped before it goes on the wire (companion) |
| Public-core default | real | — | `_claude_session_mcp_servers()` returns `[]`; without a companion override a CC session has **zero MCP tools** (`acp/client.py:2335-2346`) |
| Env expansion | Crew reimplements kiro-cli's expander byte-for-byte: unresolved `${VAR}` stays literal, `env:` prefix dropped (`mcp_gateway/rewriter.py:260-268`) | — | adapter-side |
| Loader strictness | an `mcpServers` entry without a command makes kiro-cli reject the whole agent file, surfacing as "Mode not found" at session time while `agent list`/`validate` still pass (`apps/bridges.py:445-460`) | — | frontmatter-scoped |
| Auto-approve bypass | `allowedTools` is the one path that never reaches `hooks.on_tool_call` (`apps/bridges.py:388-393`) | KAS `rules` array | see §7 |
| Tool-name grammar | `@server/tool` split on `/`, so slash-bearing keys are slugged or expose zero tools (`mcp_utils.py:288-302`) | — | `mcp__server`; `fs_read`→`Read`, `execute_bash`→`Bash`; `use_aws` has no equivalent and is dropped (companion) |

**A provider must declare:** its injection channel and precedence rule, its
server shape, its env-expansion semantics, its loader strictness, which field (if
any) bypasses the permission callback, and its tool-reference grammar.

## 6. Usage, billing, credits

| | kiro-cli | KAS | CC |
|---|---|---|---|
| Unit | Kiro credits (`bills_kiro_credits`, membership-only and False for unknown ids) | Kiro credits | US dollars per token |
| Quota API | RTS endpoints, target prefix `com.amazon.aws.codewhisperer.runtime.AmazonCodeWhispererService` (`dashboard/handlers/kiro_usage_api.py:100-108`) | same | none; cost is computed from token counts |
| Token discovery | `data.sqlite3` across four per-OS locations × two product names, four key spellings (`kiro_usage_api.py:168-192`) | same | not applicable |
| Consumer surface | a boolean flag read by the session readout and `dashboard/state.py` | same | `GET /api/usage/cost` returns `mode="cost"` vs `mode="kiro"`, plus a companion-side budget cap (companion) |

This is the best-sealed bucket: consumers read a flag, not the endpoints.

**A provider must declare:** its billing unit, its quota API (or none), how its
token is discovered, and its unattributable-overhead model.

## 7. Security and permission parity

| | kiro-cli | KAS | CC |
|---|---|---|---|
| Where denial is enforced | Crew's own PreToolUse gate; built-in deny rules are **not** injected into the agent spec (`security.py:50-58`) | same | CC has a **native** permission engine that runs *upstream of and invisible to* the host `canUseTool` gate |
| Deny-pattern engine | authored for kiro-cli's linear-time RE2-style engine; two patterns are catastrophic under Python `re`, so a behaviourally identical linear matcher is substituted (`security.py:1864-1868`) | same | regex, not globs — Crew translates globs with metacharacter escaping (companion) |
| Auto-approve vocabulary | `allowedTools` | `{"rules":[{"capability":"mcp","match":["srv/*"],"effect":"allow"}]}`; unmatched → `ask`; `match` omitted → `['**']` (`acp/kas_permissions.py:1-42`) | frontmatter `tools`; `deniedCommands` → `disallowedTools: ["Bash(<cmd>)"]` |
| Permission-request options | `allow_once` / `allow_always`, with a `cancelled` fallback for deny | kiro vocabulary | `allow` / `allow_always` **and a real `reject`** (`acp/session_handle.py:1137-1170`) |
| Auto mode | protocol flag | protocol flag | a per-session **file**: `<work dir>/.claude/settings.local.json`, `permissions.defaultMode`. Written for the *next* spawn, and a stale file is unlinked on reset so `bypassPermissions` cannot survive a crash (`acp/types.py:222-232`, `acp/client.py:3198-3204`) |
| Inherited-config hazard | — | omitting `permissions` resolves everything to `ask` | an inherited `defaultMode: dontAsk`, or any inherited `allow`/`ask` wildcard, is auto-approved by CC's engine **without calling `canUseTool`**, silently bypassing Crew's gate — so `defaultMode`/`allow`/`ask` are stripped from the seed (companion) |
| Rules Crew cannot override | — | shell/filesystem families are refused rather than translated | the user's own deny rules run first; a detector fnmatches them against benign canaries (`ls`, `git status`, `pwd`) and **surfaces** what it cannot beat (companion) |
| Tool-call titles | prefixed `Reading `/`Running: ` | prefixed | no prefix, so sensitive-path gates must run on every target (`hooks.py:559-563`) |

**The parity rule this bucket establishes:** when a foreign host lacks an
enforcement *mode* rather than a rule, parity cannot be reached by translation.
kiro-cli's 42 "suspicious bash" patterns are audit-only; CC has no audit-only
mode, so they are deliberately **not** translated and the gap is recorded as a
known security gap rather than silently downgraded (companion). The
honest contract is a declared capability plus a documented gap.

**A provider must declare:** where denial is enforced relative to the host gate,
its regex-engine class, its auto-approve vocabulary and default-when-absent
semantics, its permission-option vocabulary, how auto mode is expressed and
whether it is spawn-scoped, which of its own rules the host cannot override, and
whether tool titles carry a verb prefix.

## 8. Auxiliary runtimes the host cannot self-discover

| | kiro-cli | KAS | CC |
|---|---|---|---|
| Primary binary | `kiro-cli`, resolved by `_resolve_kiro_bin` | `kiro-cli` | `claude-agent-acp`, resolved via vendored `node_modules` / mise / PATH (`acp/client.py:158-178`, `:429-500`) |
| Additional runtime | none | none | a **second** native binary (~250 MB) that the adapter's SDK will not find itself; Crew injects `CLAUDE_CODE_EXECUTABLE` into the child env (`acp/client.py:2807-2822`) |
| Failure mode when missing | resolution error | resolution error | a warning log, then death at `session/new` with "Claude native binary not found" (`acp/client.py:2807-2820`) |

**A provider must declare:** every runtime it needs beyond its own entry point,
how each is discovered, and how a missing one is reported *before* a session is
attempted rather than during it.

## Seam status today

| Bucket | Seam |
|---|---|
| 6 Usage / billing | real — consumers read a boolean flag |
| 7 Permission vocabulary | real — `acp/kas_permissions.py`, shared by the wire projection and the on-disk writer so they cannot drift |
| 1 Agent definition | partial — `acp/kas_agents.py` is a genuine projection; the *writer* (`agent.py`) has none |
| 3 Auth-store reading | weak — the projection is isolated, the paths and table names are inline constants |
| 4 Sandbox delegation | weak — one decision function, a hardcoded predicate |
| 2 Session persistence | **none** — the path is spelled literally in at least four modules |
| 5 MCP injection | **none** — an overridable method returning `[]` is the whole extension point |
| 7 Regex-engine parity | **none** — the deny catalog is authored against one engine |
| 8 Auxiliary runtimes | **none** — no preflight, no declared requirement |

## New-provider checklist

A provider author must answer every "must declare" line above. Where the answer
is **"not supported"**, that is a valid declaration and the corresponding Crew
surface degrades rather than assuming. Silence is not an answer: the two failure
modes observed on the CC seam are a missing MCP override yielding a session with
zero tools, and a missing settings seed silently collapsing the context window
from 1M to 200K — both documented as comments rather than enforced by an
interface.

## What supporting one foreign host costs today

Because none of the buckets above is a typed contract, the public core carries
the CC host seam as dormant conditional surface instead:

| Kind | Count |
|---|---|
| `getattr`-by-name seams whose target the public core never defines | 2 (`acp/client.py:2742`, `:3351`) |
| Defensive attribute probes across the provider boundary | 4 |
| Methods returning a neutral value purely for a companion to override | 6 |
| `ClaudeCodeProvider is not None and isinstance(...)` guards against a name hard-coded to `None` | 11 sites, 2 sentinels (`session.py:170`, `subagent.py:131`) |
| Comment clusters naming the companion or a deleted module as the supplier | 19 |
| Refusal / downgrade mechanisms | 9, including one degrade log line (`config/loader.py:4647-4652`) and five capability non-memberships |
| Live `_is_claude` branches inside `acp/` | 13 |
| CC-symbol lines in `src/kiro_crew` | 146 (352 including `test/`) |

The registration seam itself is coherent —
`ProviderRegistry.register_acp_backends` / `create_factory`
(`platform/interfaces.py:66-90`), a documented no-op default
(`platform/defaults.py:41-48`), one wiring site (`platform/bootstrap.py:220-229`),
and an explicit rule that the core never imports the companion. Everything below
it is not: the behaviour a companion must supply is delivered through three
different kinds of undeclared hole, none type-checked and none failing loudly
when omitted.
