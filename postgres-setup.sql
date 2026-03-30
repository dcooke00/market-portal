-- Run these commands on your existing PostgreSQL server
-- as a superuser (e.g. the postgres user)

-- 1. Create a dedicated database user for the portal
CREATE USER portal_user WITH PASSWORD 'your_secure_password_here';

-- 2. Create the database
CREATE DATABASE market_portal OWNER portal_user;

-- 3. Connect to the new database and grant privileges
\c market_portal
GRANT ALL PRIVILEGES ON DATABASE market_portal TO portal_user;
GRANT ALL ON SCHEMA public TO portal_user;

-- Tables are created automatically by the app on first boot.
-- If you ever need to reset:
-- DROP TABLE IF EXISTS audit_log, reports, users CASCADE;
