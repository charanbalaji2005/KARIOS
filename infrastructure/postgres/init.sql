-- Bootstrap for the control-plane database.
-- Runs once, as the postgres superuser, on first container start.

CREATE ROLE kairos WITH LOGIN PASSWORD 'kairos' CREATEDB CREATEROLE;
CREATE DATABASE kairos_platform OWNER kairos;

\connect kairos_platform

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
