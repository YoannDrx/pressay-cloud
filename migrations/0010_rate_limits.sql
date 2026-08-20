CREATE TABLE rate_limit_bucket (
  scope text NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 80),
  key_hash bytea NOT NULL CHECK (octet_length(key_hash) = 32),
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 1 CHECK (request_count > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, key_hash, window_start)
);

CREATE INDEX rate_limit_bucket_expiry_idx ON rate_limit_bucket (expires_at);

CREATE FUNCTION consume_pressay_rate_limit(
  p_scope text,
  p_key_hash bytea,
  p_limit integer,
  p_window_seconds integer
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_window interval;
  v_window_start timestamptz;
  v_count integer;
BEGIN
  IF p_limit <= 0 OR p_window_seconds <= 0 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_rate_limit';
  END IF;
  IF p_key_hash IS NULL OR octet_length(p_key_hash) <> 32 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_rate_limit_key';
  END IF;

  v_window := make_interval(secs => p_window_seconds);
  v_window_start := date_bin(v_window, now(), '2000-01-01 00:00:00+00'::timestamptz);

  INSERT INTO rate_limit_bucket (
    scope, key_hash, window_start, request_count, expires_at
  ) VALUES (
    p_scope, p_key_hash, v_window_start, 1, v_window_start + v_window * 2
  )
  ON CONFLICT (scope, key_hash, window_start) DO UPDATE SET
    request_count = rate_limit_bucket.request_count + 1
  RETURNING request_count INTO v_count;

  IF v_count > p_limit THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'rate_limit_exceeded';
  END IF;
  RETURN p_limit - v_count;
END;
$$;
