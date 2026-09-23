-- =============================================================================
-- 0004 — MFA, OAuth, invitations, and the admin surface
-- =============================================================================

-- ----------------------------------------------------------------------------
-- MFA / TOTP
--
-- The secret is encrypted at rest with the same AES-256-GCM key as every other
-- credential. A TOTP secret is a bearer credential: anyone holding it can mint
-- valid codes forever, so it is worth exactly as much protection as a password
-- hash — arguably more, since it does not expire.
-- ----------------------------------------------------------------------------
CREATE TABLE user_mfa (
    user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_enc   TEXT NOT NULL,
    -- Enrolment is two steps: the secret exists once the QR is shown, but MFA
    -- is not enforced until the user proves they can generate a code. A single
    -- boolean here is what stops someone locking themselves out by scanning a
    -- QR into an app they then delete.
    confirmed_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    -- The counter of the last accepted step, to reject replay within the
    -- 30-second window. Without this, a code shoulder-surfed or captured from
    -- a phishing page stays valid for the rest of its step.
    last_step    BIGINT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backup codes are hashed, not encrypted. They are single-use secrets the user
-- holds; the server only ever needs to check one, never to display it again.
CREATE TABLE mfa_backup_codes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX mfa_backup_codes_user_idx ON mfa_backup_codes(user_id) WHERE used_at IS NULL;

-- ----------------------------------------------------------------------------
-- OAuth
--
-- state and PKCE verifier are stored server-side rather than in a cookie, so
-- that a callback can be validated even when the browser dropped the cookie
-- (Safari ITP, cross-site redirects). Rows are short-lived and single-use.
-- ----------------------------------------------------------------------------
CREATE TABLE oauth_states (
    state         TEXT PRIMARY KEY,
    provider      TEXT NOT NULL CHECK (provider IN ('google','github')),
    code_verifier TEXT NOT NULL,
    nonce         TEXT,
    redirect_to   TEXT,
    consumed_at   TIMESTAMPTZ,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX oauth_states_expiry_idx ON oauth_states(expires_at);

ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS email       CITEXT;
ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS avatar_url  TEXT;
ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS linked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Password becomes optional: an account created through OAuth has no password
-- and must not be given a fake one, which would be a guessable credential.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- ----------------------------------------------------------------------------
-- Organization invitations
-- ----------------------------------------------------------------------------
CREATE TABLE organization_invitations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email           CITEXT NOT NULL,
    role            member_role NOT NULL DEFAULT 'developer',
    -- Only the hash is stored. The token goes out in one email and is never
    -- recoverable from the database, so a dump of this table does not let
    -- anyone join an organization.
    token_hash      TEXT NOT NULL UNIQUE,
    invited_by      UUID NOT NULL REFERENCES users(id),
    accepted_by     UUID REFERENCES users(id),
    accepted_at     TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX organization_invitations_org_idx ON organization_invitations(organization_id, created_at DESC);
-- One live invitation per email per organization. Re-inviting should replace,
-- not accumulate: a stack of valid tokens for one address is a stack of ways in.
CREATE UNIQUE INDEX organization_invitations_pending_idx
    ON organization_invitations(organization_id, email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ----------------------------------------------------------------------------
-- Request metrics
--
-- Aggregated in the API and flushed periodically rather than written per
-- request: one INSERT per HTTP call would make the platform database the
-- bottleneck for the thing it is measuring.
-- ----------------------------------------------------------------------------
CREATE TABLE request_metrics (
    id           BIGSERIAL PRIMARY KEY,
    project_id   UUID REFERENCES projects(id) ON DELETE CASCADE,
    route        TEXT NOT NULL,
    method       TEXT NOT NULL,
    status_class SMALLINT NOT NULL,
    count        INTEGER NOT NULL,
    p50_ms       REAL NOT NULL,
    p95_ms       REAL NOT NULL,
    p99_ms       REAL NOT NULL,
    max_ms       REAL NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    window_end   TIMESTAMPTZ NOT NULL
);
CREATE INDEX request_metrics_window_idx ON request_metrics(window_start DESC);
CREATE INDEX request_metrics_route_idx  ON request_metrics(route, window_start DESC);

-- Bootstrap the first platform admin from the environment allow-list, so a
-- fresh install has an operator without anyone editing rows by hand.
COMMENT ON COLUMN users.is_platform_admin IS
    'Platform operator. Can change quotas, view every organization, and read security events. Granted by another admin, or bootstrapped from PLATFORM_OPERATORS at startup.';
