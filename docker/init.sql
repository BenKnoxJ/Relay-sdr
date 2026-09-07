-- Runs once, on first initialisation of the volume.
-- The test database is separate from the dev database so a suite that
-- truncates cannot touch anything you were working on.
CREATE DATABASE relay_test OWNER relay;
