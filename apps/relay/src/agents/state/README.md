# Agent state validation (B058)

A pure check of `agent.state.state` against the contract's state map
([CT-STATE-MAP](../../../../../contracts/09-state-map.md), `contracts/state-map.json`) and its
wire / client-local split: which states are agent state, which are client-local UI states the
backend never emits as agent state, and which are unknown (tolerated, counted). The relay never
invents a state. Its relay policy is installed on B057's registry by the agents module
(`../module.ts`).

## Public interface

| Export                                     | What it is                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `validateAgentState(state)`                | `{verdict: 'accepted' \| 'client_local' \| 'unknown'}`; two set lookups, no I/O, no state.        |
| `AGENT_WIRE_STATES`, `CLIENT_LOCAL_STATES` | The split, derived from the generated `PRODUCT_STATES` (state-map.json) and the agent-level list. |
| `agentStateCheck({metrics, logger})`       | The relay's policy for `setStateValidator`: forward every name, count the unknown ones.           |
| `createStateGate({clock})`                 | `admit(agentId, state)`: `send`, `drop_duplicate` or `drop_rate` (2 changes per agent per 1 s).   |
| `UNCLASSIFIED_STATES`                      | Map keys in neither set (empty today; a test keeps it so).                                        |
| `splitStates(keys)`, `StateMapError`       | The split of a key list; throws when the agent-level list names a missing state, or a key twice.  |

## Rules

- **Split.** `wire-split.ts` reconciles the split with `09-state-map.md` "Agent-level states", in
  one place: the agent-level list (the section's list) and the client-local classification (its
  "All other keys (...)" sentence and the categories it names, with the contract's `ci-*`, `pr-*`,
  `provider-*`, `teammate-*` patterns). Tests parse that section: the agent-level list must equal
  it, every name of the client-local sentence must be classified local, and every key of the map
  must be in exactly one set. `sleeping` and `away` sit in the idle category but not in the
  agent-level list, so they are client-local ("all other keys").
- **Verdicts.** `accepted` (agent-level), `client_local`, or `unknown` (not in the map, or a key the
  contract added before it was classified here). The verdict tells backend emitters what never to
  send as agent state (they use `sys.notice` for limits).
- **Relay policy.** CT-STATE-MAP: "The relay validates `agent.state.state` against **all** keys of
  `state-map.json` (tolerant); clients emit only the list above". So the relay forwards every
  well-formed name: client-local ones are the client's mistake, unknown ones are tolerated (rule 1),
  logged at debug (`agents.state_unknown`, without the name) and counted in
  `relay_agent_state_unknown_total`. A value that is not a state name (not kebab-case, longer than
  64 characters, not a string) is `invalid_frame`.
- **Schema.** B057's registry checks the rest of the `agent.state` payload against the contract
  schema with a known name in place of the state, so an unknown name reaches this policy instead
  of failing the schema's enum.
- **Gate.** `createStateGate` is the in-process form of CT-STATE-MAP rule 2 (sliding one-second
  window, per agent, at most `GATE_MAX_AGENTS` remembered). The relay's own cross-node limit and
  duplicate drop are B057's.
- The animation values of the map are never read.

## Failure modes

| Failure                                         | Behaviour                                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| The map lacks an agent-level state, or is empty | `StateMapError` when the module loads: the relay does not start.                                           |
| A new key after a contract bump                 | Unclassified: `unknown` at runtime (forwarded, counted); the classification test fails until it is listed. |
| The schema enum drifts from the map             | `state.drift.test.ts` fails (`pnpm test` in CI).                                                           |

## Testing

`pnpm test` runs `apps/relay/test/agents-state/`: classification over every key and the section,
the gate (with a property test), the schema drift guard, and unknown-state tolerance through the
registry and the module.
