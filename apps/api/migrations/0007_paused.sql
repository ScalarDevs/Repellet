-- Allow projects to retain their data while releasing runtime containers and networks.
ALTER TABLE projects
  ADD CONSTRAINT projects_state_check
  CHECK (state IN ('stopped', 'building', 'starting', 'running', 'stopping', 'paused', 'failed'));
