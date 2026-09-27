export const kt131PrivacyIdempotencyBenchmark = {
  repository: "pikkst/krunditark.ee",
  pullRequest: 236,
  path: "supabase/migrations/20260927120000_kt131_account_privacy_page.sql",
  before: {
    head: "45f025e8c143130e48504dee72aa2c2195b74b3d",
    findingLine: 201,
    content: `
CREATE OR REPLACE FUNCTION public.request_kt131_privacy_action(
    p_kind text,
    p_delete_confirmation text DEFAULT NULL
)
RETURNS TABLE (
    request_id uuid,
    request_kind text,
    status text,
    retention_review_required boolean,
    requested_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $kt131_privacy_action$
DECLARE
    v_actor uuid := auth.uid();
BEGIN
    IF v_actor IS NULL OR NOT EXISTS (
        SELECT 1
        FROM auth.users u
        WHERE u.id = v_actor
          AND COALESCE(u.is_anonymous, false) = false
    ) THEN
        RETURN;
    END IF;

    IF p_kind NOT IN ('export', 'delete') THEN
        RAISE EXCEPTION 'KT131_INVALID_PRIVACY_ACTION' USING ERRCODE = '22023';
    END IF;

    IF p_kind = 'delete' AND p_delete_confirmation IS DISTINCT FROM 'DELETE' THEN
        RAISE EXCEPTION 'KT131_DELETE_CONFIRMATION_REQUIRED' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT r.id, r.request_kind, r.status, r.retention_review_required, r.requested_at
    FROM private.account_privacy_requests r
    WHERE r.user_id = v_actor
      AND r.request_kind = p_kind
      AND r.status IN ('pending', 'processing')
    ORDER BY r.requested_at DESC, r.id DESC
    LIMIT 1;

    IF FOUND THEN
        RETURN;
    END IF;

    RETURN QUERY
    INSERT INTO private.account_privacy_requests AS r (
        user_id, request_kind, retention_review_required
    )
    VALUES (v_actor, p_kind, p_kind = 'delete')
    RETURNING r.id, r.request_kind, r.status, r.retention_review_required, r.requested_at;
END;
$kt131_privacy_action$;
`.trim(),
  },
  after: {
    head: "090eb9bae3825d22e4e76d68b73b7593307d648f",
    findingLine: 209,
    content: `
CREATE OR REPLACE FUNCTION public.request_kt131_privacy_action(
    p_kind text,
    p_delete_confirmation text DEFAULT NULL
)
RETURNS TABLE (
    request_id uuid,
    request_kind text,
    status text,
    retention_review_required boolean,
    requested_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $kt131_privacy_action$
DECLARE
    v_actor uuid := auth.uid();
BEGIN
    IF v_actor IS NULL OR NOT EXISTS (
        SELECT 1
        FROM auth.users u
        WHERE u.id = v_actor
          AND COALESCE(u.is_anonymous, false) = false
    ) THEN
        RETURN;
    END IF;

    IF p_kind NOT IN ('export', 'delete') THEN
        RAISE EXCEPTION 'KT131_INVALID_PRIVACY_ACTION' USING ERRCODE = '22023';
    END IF;

    IF p_kind = 'delete' AND p_delete_confirmation IS DISTINCT FROM 'DELETE' THEN
        RAISE EXCEPTION 'KT131_DELETE_CONFIRMATION_REQUIRED' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('kt131_privacy|' || v_actor::text || '|' || p_kind, 0)
    );

    RETURN QUERY
    SELECT r.id, r.request_kind, r.status, r.retention_review_required, r.requested_at
    FROM private.account_privacy_requests r
    WHERE r.user_id = v_actor
      AND r.request_kind = p_kind
      AND r.status IN ('pending', 'processing')
    ORDER BY r.requested_at DESC, r.id DESC
    LIMIT 1;

    IF FOUND THEN
        RETURN;
    END IF;

    RETURN QUERY
    INSERT INTO private.account_privacy_requests AS r (
        user_id, request_kind, retention_review_required
    )
    VALUES (v_actor, p_kind, p_kind = 'delete')
    RETURNING r.id, r.request_kind, r.status, r.retention_review_required, r.requested_at;
END;
$kt131_privacy_action$;
`.trim(),
  },
  candidate: {
    severity: "blocking" as const,
    category: "reliability" as const,
    basis: "defect" as const,
    title: "request_kt131_privacy_action idempotency is not concurrency-safe",
    evidence:
      "Open-request reuse is SELECT-then-INSERT. Two concurrent callers for the same user and action can both observe no pending row and race into the partial unique index, surfacing a unique-violation instead of reusing the existing request.",
    recommendation:
      "Serialize the same user + action key before the open-row lookup, or use an atomic conflict-safe insert/reselect path so concurrent retries return the same request_id.",
  },
} as const;
