# D · A again, re-run after a widening

Brief A with a `priorRun` that says the last attempt was narrow on region. The pass is a
pack that widens sensibly and does not hand back the same seed firms.

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
    ]
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
    "note": "The first run found four firms in the North West and nothing outside it. Widen beyond that region and do not repeat those firms."
  }
}
```
