CREATE TABLE apex_database_identity (
  singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  environment_name text NOT NULL CHECK (environment_name IN ('development','test','staging','production')),
  instance_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO apex_database_identity (singleton, environment_name, instance_id)
VALUES (TRUE, 'development', '00000000-0000-4000-8000-000000000001');
