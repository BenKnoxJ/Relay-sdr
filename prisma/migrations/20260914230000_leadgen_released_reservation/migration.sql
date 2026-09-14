-- Lead gen v2.2 note 2: a search request that provably never left Relay (the
-- connection was refused or never opened) releases its reservation. It counts
-- for nothing against the cap; one that may have been sent keeps its worst
-- case. `charged` stays NULL, as for every state but reconciled.
ALTER TYPE "credit_state" ADD VALUE 'released';
