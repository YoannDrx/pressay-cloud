-- The platform waitlists (0027) announced the iPhone and Windows versions.
-- Windows has shipped and the iPhone version will not, so the table, its
-- sign-up route, admin export and retention rule are removed. The addresses
-- it held were collected only to announce those versions and are deleted
-- with it. Audit entries of past exports stay in operations_audit.
-- Idempotent so the file can be replayed safely.

DROP TABLE IF EXISTS waitlist_entry;
