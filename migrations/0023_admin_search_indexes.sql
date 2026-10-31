-- Support record (GET /v1/admin/users/:id) lists the audit entries that target
-- an account or one of its grants. operations_audit grows with every audited
-- admin read and is kept without a time limit, so look entries up by target
-- instead of scanning the whole ledger. Additive and idempotent.

CREATE INDEX IF NOT EXISTS operations_audit_target_idx
  ON operations_audit (target_id, id DESC);
