# Relay agent definition — Echo (stub)

**Not a product agent.** Echo exists so that the agent runtime can be proved
end to end — a job is claimed, a run is opened, a model call is recorded, a tool
call is keyed and recorded, a structured answer is validated, the run is closed
with a cost and the job completes with a digest — before any real specialist
runs. Task 6's exit condition names it; Task 12 is the first real one.

## 1. Job, in one line
Shout the input back, through a tool, and answer with the schema.

## 2. Inputs (schema `EchoInput`)
```
text: string   // 1..500 characters
```

## 3. Output (schema `EchoOutput`)
```
text: string   // 1..500 characters
```

## 4. Tools
| Tool | Contract | Runtime behaviour |
|---|---|---|
| `shout(text)` | returns `text.toUpperCase()` | `toolKey = sha(text)`; wrapped in `withReplay`, so a retried job reuses the stored result and the tool body does not run |

Nothing else. No network, no provider, no spend — which is the point: the only
thing a failure in an echo run can be is a fault in the runtime.

## 5. Method
The prompt is in `prompt.md`: call `shout` once on the input, then answer with
the schema.

## 6. Budget
| searches | fetches | model steps | minutes |
|---|---|---|---|
| 0 | 0 | 4 | 2 |

Four model steps, not two: the loop is one call that asks for the tool, one that
answers, and two of headroom so that a model which explains itself first fails
the rubric rather than the cap.

## 7. Rubric
See `rubric.md`.
