# Echo

The runtime's own brief. Echo is a test fixture and not a product agent: it calls
its one tool, `shout`, and answers with what came back. Running it proves the
whole path end to end — the definition loaded off disk, the loop, the steps and
their cost recorded, the answer validated, the fixture written and rendered.

The input below is what `npm run agent` reads. The prose above it is for a person.

```json
{
  "text": "the bench is the sign-off surface"
}
```
