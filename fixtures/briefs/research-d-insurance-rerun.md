# D · A again, re-run after a widening

Brief A re-run after the rep widened the region from Great Britain to Great Britain and
the Republic of Ireland (definition §10 note 29). Brief A's signed pack is the prior pack:
`priorPacks()` shows its seed firms, and it — not `priorRun.note` — says what the first
research contained. The pass may keep good A seed firms, must say in m14 which are kept
and which are new, and must add new coverage the wider region makes reachable: Irish firms.

The input below is what `npm run agent` reads. The prose above it is for a person.

```json
{
  "brief": {
    "product": "Insights360",
    "motion": "direct",
    "who": "claims ops people at mid-sized UK insurers who are drowning in complaints",
    "region": "GB",
    "howMany": 20,
    "weeks": 3,
    "channels": [
      "email",
      "linkedin"
    ],
    "scope": {
      "countries": ["GB", "IE"],
      "roles": { "include": ["claims operations"] }
    }
  },
  "facts": {
    "product": "Insights360",
    "version": 4,
    "facts": [
      {
        "id": "i360.read-every-call",
        "status": "live",
        "text": "Reads every recorded call rather than a sample.",
        "notes": "Do not claim a percentage accuracy figure."
      },
      {
        "id": "i360.evidence-pack",
        "status": "live",
        "text": "Produces an evidence pack per complaint in under 2 minutes."
      },
      {
        "id": "i360.live-assist",
        "status": "planned",
        "text": "Prompts the handler during the call."
      }
    ]
  },
  "breadth": "wide",
  "priorRun": {
    "insufficient": false,
    "widenedBy": "region",
    "note": "The rep widened the region from Great Britain to Great Britain and the Republic of Ireland. Keep what still fits from the earlier pack; add firms the wider region makes reachable."
  }
}
```
