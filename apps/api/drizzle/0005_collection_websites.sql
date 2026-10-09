CREATE TABLE collection_websites (
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, client_id)
);

CREATE INDEX collection_websites_client_idx
  ON collection_websites(client_id);d