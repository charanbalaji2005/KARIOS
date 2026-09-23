-- =============================================================================
-- 0005 — server console: terminal sessions, agent operations, provisioning
-- =============================================================================
--
-- The laptop is the server, so the admin panel has to be able to act on the
-- host: restart PostgreSQL, read journald, inspect nftables. That is a real
-- privilege, and the thing that makes it defensible rather than reckless is
-- that every use of it is recorded here, by operation id, before the operation
-- runs — not reconstructed afterwards from a log file that the operation
-- itself could have truncated.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Ubuntu-terminal grants.
--
-- KAIROS Shell (allowlisted operations) is the default and needs no grant.
-- A real PTY on the host is a different thing entirely, so it is off until
-- someone deliberately turns it on, and it turns itself back off. Storing the
-- grant server-side means revocation is immediate: closing the browser tab is
-- not what ends the privilege, expiry is.
-- ----------------------------------------------------------------------------
CREATE TABLE server_console_grants (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    revoked_at    TIMESTAMPTZ,
    reason        TEXT NOT NULL,
    ip_address    INET,
    user_agent    TEXT,
    -- Whether the grant was confirmed with a second factor. When the account
    -- has MFA enrolled this is required; the column records what actually
    -- happened rather than what policy said should happen.
    mfa_verified  BOOLEAN NOT NULL DEFAULT FALSE,
    request_id    TEXT
);

CREATE INDEX server_console_grants_live_idx
    ON server_console_grants(user_id, expires_at DESC)
    WHERE revoked_at IS NULL;

COMMENT ON TABLE server_console_grants IS
    'Time-boxed permission to open a real PTY on the host. Absent or expired means KAIROS Shell only.';

-- ----------------------------------------------------------------------------
-- Terminal sessions.
-- ----------------------------------------------------------------------------
CREATE TABLE terminal_sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         TEXT NOT NULL,
    server_id    TEXT NOT NULL,
    mode         TEXT NOT NULL CHECK (mode IN ('kairos_shell','ubuntu_terminal')),
    grant_id     UUID REFERENCES server_console_grants(id) ON DELETE SET NULL,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at     TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address   INET,
    user_agent   TEXT,
    status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','closed','expired','terminated')),
    request_id   TEXT,
    close_reason TEXT
);

CREATE INDEX terminal_sessions_user_idx ON terminal_sessions(user_id, started_at DESC);
CREATE INDEX terminal_sessions_open_idx ON terminal_sessions(last_seen_at) WHERE status = 'open';

-- ----------------------------------------------------------------------------
-- Individual commands inside a session.
--
-- `operation` is the allowlist id the command resolved to; `command_display`
-- is what the operator typed, kept for the audit trail. Output is deliberately
-- NOT stored: a session that runs `cat /etc/kairos/agent.token` would otherwise
-- write the agent credential into the audit table forever.
-- ----------------------------------------------------------------------------
CREATE TABLE terminal_commands (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
    operation       TEXT NOT NULL,
    command_display TEXT NOT NULL,
    arguments       JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    exit_code       INTEGER,
    status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','succeeded','failed','denied','timeout')),
    bytes_out       BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX terminal_commands_session_idx ON terminal_commands(session_id, started_at DESC);
CREATE INDEX terminal_commands_operation_idx ON terminal_commands(operation, started_at DESC);

-- ----------------------------------------------------------------------------
-- Agent operations invoked outside a terminal — the buttons in the UI.
--
-- Same shape as terminal_commands on purpose: "restart postgres" is the same
-- privileged act whether it was typed or clicked, and an investigation should
-- not have to look in two places to find it.
-- ----------------------------------------------------------------------------
CREATE TABLE server_operations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    operation     TEXT NOT NULL,
    arguments     JSONB NOT NULL DEFAULT '{}'::jsonb,
    danger        BOOLEAN NOT NULL DEFAULT FALSE,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMPTZ,
    exit_code     INTEGER,
    status        TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','succeeded','failed','denied','timeout')),
    ip_address    INET,
    user_agent    TEXT,
    request_id    TEXT,
    error         TEXT
);

CREATE INDEX server_operations_recent_idx ON server_operations(started_at DESC);
CREATE INDEX server_operations_user_idx ON server_operations(user_id, started_at DESC);

-- ----------------------------------------------------------------------------
-- Provisioning wizard state.
--
-- The wizard is resumable because provisioning a laptop is not a five-minute
-- job and people close laptops. Each step records what the host actually
-- reported, so "step 6 done" can be re-derived rather than trusted.
-- ----------------------------------------------------------------------------
CREATE TABLE server_setup_steps (
    step        TEXT PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','completed','failed','skipped')),
    detail      TEXT,
    result      JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at  TIMESTAMPTZ,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    run_by      UUID REFERENCES users(id) ON DELETE SET NULL
);

COMMENT ON TABLE server_setup_steps IS
    'Resumable state for the server provisioning wizard. Re-verified against the host, never trusted on its own.';

-- ----------------------------------------------------------------------------
-- Where the agent lives, so the dashboard can say "the agent is down" rather
-- than showing a blank page when the socket is missing.
-- ----------------------------------------------------------------------------
ALTER TABLE server_identity ADD COLUMN IF NOT EXISTS agent_last_seen_at TIMESTAMPTZ;
ALTER TABLE server_identity ADD COLUMN IF NOT EXISTS agent_version      TEXT;
ALTER TABLE server_identity ADD COLUMN IF NOT EXISTS public_key         TEXT;

COMMENT ON COLUMN server_identity.public_key IS
    'Ed25519 public key for this installation. The private half never leaves /etc/kairos and is never returned by the API.';
